/**
 * spawnManager.js
 *
 * Core responsibilities
 * - Post public spawn messages (Catch + Toss Berry)
 * - Persist the current active spawn (per guild)
 * - Prevent stuck spawns (15-min hard TTL)
 * - Optional: shorten lifetime after first interaction (5-min engaged flee)
 * - Offline nets: guaranteed catches into net_stash (does NOT claim public spawn)
 *
 * Quiet Hours
 * - Random spawns are suppressed between 00:00 and 06:00 local server time.
 * - If a spawn attempt happens during quiet hours, it is postponed.
 */

const db = require("../db");
const { pickRandomPoro } = require("./poroCatalog");
const { consumeArmedNet } = require("./items");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");

// -------------------- Tunables --------------------
const SPAWN_TTL_MS = 15 * 60 * 1000; // hard expiry after posting
const FLEE_AFTER_FIRST_INTERACTION_MS = 5 * 60 * 1000; // optional shorter timer once engaged

// Quiet hours (local server time). Spawns won't POST during this window.
const QUIET_START_HOUR = 0; // 00:00
const QUIET_END_HOUR = 6;   // 06:00

// Jitter (prevents "everything spawns at exactly 6:00am")
const QUIET_JITTER_MINUTES_MAX = 30;

// -------------------- DB helpers --------------------

function getGuildConfig(guildId) {
  return db.prepare(`SELECT game_channel_id FROM config WHERE guild_id = ?`).get(guildId);
}

function getActiveSpawn(guildId) {
  return db.prepare(`SELECT * FROM spawns WHERE guild_id = ? AND active = 1`).get(guildId);
}

function clearActiveSpawn(guildId) {
  db.prepare(`UPDATE spawns SET active = 0 WHERE guild_id = ?`).run(guildId);
}

function forceClearSpawn(guildId) {
  clearActiveSpawn(guildId);
  return true;
}

/**
 * Upserts the single "active spawn" row per guild.
 * Requires a UNIQUE constraint on spawns.guild_id.
 */
function setActiveSpawn(guildId, channelId, messageId, poroId, stats) {
  db.prepare(`
    INSERT INTO spawns (
      guild_id, channel_id, message_id, spawn_ts, active,
      poro_id,
      spawn_size, spawn_weight, spawn_throw_distance, spawn_fluffiness, spawn_hunger,
      first_interaction_ts
    )
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(guild_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      message_id = excluded.message_id,
      spawn_ts = excluded.spawn_ts,
      active = 1,
      poro_id = excluded.poro_id,
      spawn_size = excluded.spawn_size,
      spawn_weight = excluded.spawn_weight,
      spawn_throw_distance = excluded.spawn_throw_distance,
      spawn_fluffiness = excluded.spawn_fluffiness,
      spawn_hunger = excluded.spawn_hunger,
      first_interaction_ts = 0
  `).run(
    guildId,
    channelId,
    messageId,
    Date.now(),
    poroId,
    stats.size,
    stats.weight,
    stats.throwDistance,
    stats.fluffiness,
    stats.hunger
  );
}

function markFirstInteraction(guildId) {
  db.prepare(`
    UPDATE spawns
    SET first_interaction_ts = ?
    WHERE guild_id = ? AND active = 1 AND first_interaction_ts = 0
  `).run(Date.now(), guildId);
}

function getFirstInteractionTs(guildId) {
  return db.prepare(`
    SELECT first_interaction_ts
    FROM spawns
    WHERE guild_id = ? AND active = 1
  `).get(guildId)?.first_interaction_ts || 0;
}

// -------------------- Quiet hours helpers --------------------

function isQuietTime(ts = Date.now()) {
  const d = new Date(ts);
  const h = d.getHours();
  return h >= QUIET_START_HOUR && h < QUIET_END_HOUR;
}

/**
 * Returns a timestamp representing "today at QUIET_END_HOUR with jitter",
 * OR "tomorrow at QUIET_END_HOUR with jitter" if we're already past the end hour.
 */
function nextAllowedSpawnTs(nowTs = Date.now()) {
  const d = new Date(nowTs);
  const hour = d.getHours();

  // If it's before end hour, bump to today at end hour. If it's after, bump to tomorrow.
  const bumpDay = hour >= QUIET_END_HOUR ? 1 : 0;

  const target = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + bumpDay,
    QUIET_END_HOUR,
    0,
    0,
    0
  );

  const jitterMin = Math.floor(Math.random() * (QUIET_JITTER_MINUTES_MAX + 1));
  target.setMinutes(jitterMin);

  return target.getTime();
}

// -------------------- Stat rolling --------------------

function randInt(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

function rollSpawnStats(poro) {
  if (poro.fixedStats) return { ...poro.fixedStats };
  const r = poro.statRanges;

  return {
    size: randInt(r.size.min, r.size.max),
    weight: randInt(r.weight.min, r.weight.max),
    throwDistance: randInt(r.throwDistance.min, r.throwDistance.max),
    fluffiness: randInt(r.fluffiness.min, r.fluffiness.max),
    hunger: randInt(r.hunger.min, r.hunger.max),
  };
}

// -------------------- Offline nets (100% capture) --------------------

function processNetsForSpawn(guildId, poro, stats) {
  const netUsers = db.prepare(`
    SELECT user_id, nets_armed
    FROM users
    WHERE guild_id = ? AND nets_armed > 0
  `).all(guildId);

  for (const u of netUsers) {
    if ((u.nets_armed || 0) <= 0) continue;

    const consumed = consumeArmedNet(guildId, u.user_id);
    if (!consumed) continue;

    db.prepare(`
      INSERT INTO net_stash (
        guild_id, user_id, poro_id, caught_ts,
        size, weight, throw_distance, fluffiness, hunger
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      guildId,
      u.user_id,
      poro.id,
      Date.now(),
      stats.size,
      stats.weight,
      stats.throwDistance,
      stats.fluffiness,
      stats.hunger
    );
  }
}

// -------------------- Message finalization --------------------

async function markMessageRanAway(client, guildId, channelId, messageId, reasonText) {
  // Clear the active flag first so future spawns aren't blocked even if editing fails.
  const active = getActiveSpawn(guildId);
  if (active && active.message_id === messageId) {
    clearActiveSpawn(guildId);
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const msg = await channel.messages.fetch(messageId).catch(() => null);
  if (!msg) return;

  const ranEmbed = new EmbedBuilder()
    .setTitle("💨 The poro ran away!")
    .setDescription(reasonText || "No one caught it in time. A new poro will appear later.")
    .setTimestamp();

  const ranRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("poro_gone")
      .setLabel("Poro ran away")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId("poro_gone2")
      .setLabel("Spawn ended")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );

  await msg.edit({ embeds: [ranEmbed], components: [ranRow] }).catch(() => {});
}

function scheduleHardExpiry(client, guildId, channelId, messageId) {
  setTimeout(async () => {
    const active = getActiveSpawn(guildId);
    if (!active) return;
    if (active.message_id !== messageId) return;

    await markMessageRanAway(client, guildId, channelId, messageId, "Time’s up — it wandered off on its own.");
  }, SPAWN_TTL_MS);
}

// -------------------- Main spawn function --------------------

async function trySpawnPoro(client, guildId) {
  const config = getGuildConfig(guildId);
  if (!config || !config.game_channel_id) return { ok: false, reason: "no_channel" };

  // If there's already an active spawn, do nothing.
  const existing = getActiveSpawn(guildId);
  if (existing) return { ok: false, reason: "already_active" };

  // Quiet hours: do NOT post messages between midnight and 6am.
  // We don't schedule here (scheduler handles timing), but we prevent posting if it tries anyway.
  if (isQuietTime()) {
    return { ok: false, reason: "quiet_hours", nextOkTs: nextAllowedSpawnTs() };
  }

  const channel = await client.channels.fetch(config.game_channel_id).catch(() => null);
  if (!channel) return { ok: false, reason: "channel_missing" };

  const poro = pickRandomPoro();
  const stats = rollSpawnStats(poro);

  const embed = new EmbedBuilder()
    .setTitle(`A wild ${poro.name} appears! 🐾`)
    .setDescription(
      `Rarity: **${String(poro.rarity).replace("_", " ")}**\n\n` +
        `**Spawn Stats**\n` +
        `• Size: **${stats.size}**\n` +
        `• Weight: **${stats.weight}**\n` +
        `• Throw Distance: **${stats.throwDistance}**\n` +
        `• Fluffiness: **${stats.fluffiness}**\n` +
        `• Hunger: **${stats.hunger}**\n\n` +
        `Click **Catch!** to try your luck (results are private).\n` +
        `You can also **Toss Berry** first for a better chance.`
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("poro_catch").setLabel("Catch!").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("poro_toss_berry").setLabel("Toss Berry").setStyle(ButtonStyle.Success)
  );

  const message = await channel.send({ embeds: [embed], components: [row] });

  setActiveSpawn(guildId, channel.id, message.id, poro.id, stats);

  processNetsForSpawn(guildId, poro, stats);

  scheduleHardExpiry(client, guildId, channel.id, message.id);

  return { ok: true, poro, stats };
}

// -------------------- Interaction hook --------------------

async function onSpawnInteracted(client, guildId) {
  const spawn = getActiveSpawn(guildId);
  if (!spawn) return;

  const first = getFirstInteractionTs(guildId);
  if (first !== 0) return;

  markFirstInteraction(guildId);

  setTimeout(async () => {
    const active = getActiveSpawn(guildId);
    if (!active) return;
    if (active.message_id !== spawn.message_id) return;

    await markMessageRanAway(
      client,
      guildId,
      active.channel_id,
      active.message_id,
      "Someone spooked it during the scramble, and it escaped."
    );
  }, FLEE_AFTER_FIRST_INTERACTION_MS);
}

module.exports = {
  trySpawnPoro,
  getActiveSpawn,
  clearActiveSpawn,
  forceClearSpawn,
  onSpawnInteracted,
  // Export helpers in case you want to use them in the scheduler later
  isQuietTime,
  nextAllowedSpawnTs,
};