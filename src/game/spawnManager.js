/**
 * spawnManager.js
 *
 * Responsibilities:
 * 1) Create a public spawn message (with Catch + Toss Berry buttons)
 * 2) Store the "active spawn" record in SQLite (per guild)
 * 3) Ensure spawns never get stuck:
 *    - hard TTL expiration (15 minutes) ALWAYS
 *    - optional "engaged" flee window after first interaction (5 minutes)
 * 4) Offline nets:
 *    - 100% capture rate
 *    - silently deposits into net_stash (does NOT claim the public spawn)
 *
 * Exports used elsewhere:
 * - trySpawnPoro(client, guildId)
 * - getActiveSpawn(guildId)
 * - clearActiveSpawn(guildId)
 * - forceClearSpawn(guildId)
 * - onSpawnInteracted(client, guildId)
 */

const db = require("../db");
const { pickRandomPoro } = require("./poroCatalog");
const { consumeArmedNet } = require("./items");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require("discord.js");

// --- Tunables ---
const SPAWN_TTL_MS = 15 * 60 * 1000; // HARD expiry: 15 minutes after posting
const FLEE_AFTER_FIRST_INTERACTION_MS = 5 * 60 * 1000; // After someone clicks something, flee after 5 minutes

// --- Helpers: config + spawn state ---

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
 * Insert/replace the active spawn row for this guild.
 * NOTE: This assumes your spawns table has a UNIQUE(guild_id) or similar upsert conflict target.
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

// --- Helpers: stats rolling ---

function randInt(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

/**
 * Rolls stats for this spawn instance.
 * If the poro has fixedStats (e.g. King Poro), we respect them.
 */
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

// --- Offline nets: 100% capture into net stash ---

/**
 * If a user has an armed net:
 * - consume one armed net charge
 * - guarantee a catch into net_stash
 * This is "offline loot" and does NOT end the public spawn.
 */
function processNetsForSpawn(guildId, poro, stats) {
  const netUsers = db.prepare(`
    SELECT user_id, nets_armed
    FROM users
    WHERE guild_id = ? AND nets_armed > 0
  `).all(guildId);

  for (const u of netUsers) {
    if ((u.nets_armed || 0) <= 0) continue;

    // Consume exactly one armed net
    const consumed = consumeArmedNet(guildId, u.user_id);
    if (!consumed) continue;

    // Guaranteed net catch stored silently
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

// --- Message finalization helpers ---

/**
 * Edits a spawn message to show "ran away" and disables buttons.
 * This is called by TTL expiration and by the engaged flee timer.
 */
async function markMessageRanAway(client, guildId, channelId, messageId, reasonText) {
  // Clear the active spawn first so scheduling isn't blocked even if edit fails
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

/**
 * Hard expiry: regardless of interaction, a spawn ends after SPAWN_TTL_MS.
 * Prevents stuck spawns and keeps channels clean.
 */
function scheduleHardExpiry(client, guildId, channelId, messageId) {
  setTimeout(async () => {
    const active = getActiveSpawn(guildId);
    if (!active) return;
    if (active.message_id !== messageId) return; // a newer spawn replaced it

    await markMessageRanAway(
      client,
      guildId,
      channelId,
      messageId,
      "Time’s up — it wandered off on its own."
    );
  }, SPAWN_TTL_MS);
}

// --- Main spawn function ---

async function trySpawnPoro(client, guildId) {
  const config = getGuildConfig(guildId);
  if (!config || !config.game_channel_id) return { ok: false, reason: "no_channel" };

  const existing = getActiveSpawn(guildId);
  if (existing) return { ok: false, reason: "already_active" };

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

  // Post the spawn publicly
  const message = await channel.send({ embeds: [embed], components: [row] });

  // Mark this as the active spawn in DB
  setActiveSpawn(guildId, channel.id, message.id, poro.id, stats);

  // Resolve offline nets silently (guaranteed)
  processNetsForSpawn(guildId, poro, stats);

  // HARD expiry so spawns never get stuck
  scheduleHardExpiry(client, guildId, channel.id, message.id);

  return { ok: true, poro, stats };
}

/**
 * Called by buttons.js whenever a user interacts with a spawn.
 * We only do something the FIRST time anyone interacts:
 * - mark first_interaction_ts
 * - start a shorter "engaged flee window" (optional)
 *
 * Hard expiry still exists and will clean up even if this never runs.
 */
async function onSpawnInteracted(client, guildId) {
  const spawn = getActiveSpawn(guildId);
  if (!spawn) return;

  const first = getFirstInteractionTs(guildId);
  if (first !== 0) return; // already marked / already scheduled

  markFirstInteraction(guildId);

  // Optional: once someone engages, it will flee after a shorter window
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
};