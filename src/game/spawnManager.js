/**
 * spawnManager.js
 * - Spawns a public poro in the configured channel
 * - Stores spawn info + rolled stats in DB
 * - Offline nets are 100% capture rate (silent net_stash)
 * - Spawn persists until first interaction
 * - After first interaction, it can flee after a short window
 */

const db = require("../db");
const { pickRandomPoro } = require("./poroCatalog");
const { getUser, consumeArmedNet } = require("./items");

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require("discord.js");

const FLEE_AFTER_FIRST_INTERACTION_MS = 5 * 60 * 1000; // 5 minutes

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

/**
 * Offline nets: 100% capture rate
 * - For each user with nets_armed > 0, consume 1 armed net and store the catch in net_stash.
 * - One net success per spawn per user (keeps it sane).
 */
function processNetsForSpawn(guildId, poro, stats) {
  const netUsers = db.prepare(`
    SELECT user_id, nets_armed
    FROM users
    WHERE guild_id = ? AND nets_armed > 0
  `).all(guildId);

  for (const u of netUsers) {
    const armed = u.nets_armed || 0;
    if (armed <= 0) continue;

    // Consume exactly one armed net and guarantee a catch
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
      `Rarity: **${poro.rarity.replace("_", " ")}**\n\n` +
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

  // silent offline nets
  processNetsForSpawn(guildId, poro, stats);

  return { ok: true, poro, stats };
}

/**
 * Called from buttons when a user clicks Catch or Toss Berry:
 * - marks first interaction (only once)
 * - schedules a flee timer if desired
 */
async function onSpawnInteracted(client, guildId) {
  const spawn = getActiveSpawn(guildId);
  if (!spawn) return;

  const first = getFirstInteractionTs(guildId);
  if (first !== 0) return; // already engaged

  markFirstInteraction(guildId);

  // Schedule flee after engagement window
  setTimeout(async () => {
    const active = getActiveSpawn(guildId);
    if (!active) return;

    // Only flee if still same spawn and still active
    if (active.message_id !== spawn.message_id) return;

    clearActiveSpawn(guildId);

    const channel = await client.channels.fetch(active.channel_id).catch(() => null);
    if (!channel) return;

    const msg = await channel.messages.fetch(active.message_id).catch(() => null);
    if (!msg) return;

    const ranEmbed = new EmbedBuilder()
      .setTitle("💨 The poro ran away!")
      .setDescription("Someone spooked it, and it escaped. A new poro will appear later.")
      .setTimestamp();

    const ranRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("poro_gone").setLabel("Poro ran away").setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId("poro_gone2").setLabel("Spawn ended").setStyle(ButtonStyle.Secondary).setDisabled(true)
    );

    await msg.edit({ embeds: [ranEmbed], components: [ranRow] }).catch(() => {});
  }, FLEE_AFTER_FIRST_INTERACTION_MS);
}

module.exports = {
  trySpawnPoro,
  getActiveSpawn,
  clearActiveSpawn,
  forceClearSpawn,
  onSpawnInteracted,
};