/**
 * spawnManager.js
 * - Spawns a public poro in the configured channel
 * - Stores spawn info + rolled stats in DB
 * - Runs silent offline nets on spawn
 * - Auto-despawns: edits message to "ran away" + disables buttons
 *
 * IMPORTANT:
 * - The public spawn message is NEVER ephemeral.
 * - Catch results are handled elsewhere (buttons.js) and are ephemeral.
 */

const db = require("../db");
const { pickRandomPoro } = require("./poroCatalog");
const { getUser, consumeArmedNet } = require("./items");
const { rollCatch } = require("./poroLogic");

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require("discord.js");

/** ---------------------------
 * DB helpers
 * --------------------------- */

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
  // Use this for admin clearspawn to fix a stuck DB flag
  clearActiveSpawn(guildId);
  return true;
}

function setActiveSpawn(guildId, channelId, messageId, poroId, stats) {
  db.prepare(`
    INSERT INTO spawns (
      guild_id, channel_id, message_id, spawn_ts, active,
      poro_id,
      spawn_size, spawn_weight, spawn_throw_distance, spawn_fluffiness, spawn_hunger
    )
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
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
      spawn_hunger = excluded.spawn_hunger
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

/** ---------------------------
 * Stat rolling
 * --------------------------- */

function randInt(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

function rollSpawnStats(poro) {
  // King Poro (or any "fixedStats") stays fixed
  if (poro.fixedStats) return { ...poro.fixedStats };

  // Others roll within configured ranges
  const r = poro.statRanges;
  return {
    size: randInt(r.size.min, r.size.max),
    weight: randInt(r.weight.min, r.weight.max),
    throwDistance: randInt(r.throwDistance.min, r.throwDistance.max),
    fluffiness: randInt(r.fluffiness.min, r.fluffiness.max),
    hunger: randInt(r.hunger.min, r.hunger.max),
  };
}

/** ---------------------------
 * Offline nets
 * ---------------------------
 * When a spawn happens, users with nets_armed get silent attempts.
 * Successes go into net_stash to claim later from the UI.
 */

function processNetsForSpawn(guildId, poro, stats) {
  const netUsers = db.prepare(`
    SELECT user_id, nets_armed
    FROM users
    WHERE guild_id = ? AND nets_armed > 0
  `).all(guildId);

  for (const u of netUsers) {
    const charges = u.nets_armed || 0;
    if (charges <= 0) continue;

    for (let i = 0; i < charges; i++) {
      const user = getUser(guildId, u.user_id);

      // Slightly weaker than manual catching
      const netChance = Math.min(0.60, poro.baseCatch * 0.75 + user.level * 0.002);

      // The net attempt "triggers" and consumes an armed charge regardless
      consumeArmedNet(guildId, u.user_id);

      const success = rollCatch(netChance);
      if (!success) continue;

      // Store the rolled spawn stats into net stash
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

      // Only one net success per spawn per user (prevents net spam)
      break;
    }
  }
}

/** ---------------------------
 * Spawn entry point
 * --------------------------- */

async function trySpawnPoro(client, guildId) {
  const config = getGuildConfig(guildId);
  if (!config || !config.game_channel_id) return { ok: false, reason: "no_channel" };

  // If a spawn is already active, skip
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

  // TWO BUTTONS on the spawn
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("poro_catch").setLabel("Catch!").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("poro_toss_berry").setLabel("Toss Berry").setStyle(ButtonStyle.Success)
  );

  const message = await channel.send({ embeds: [embed], components: [row] });

  // Persist active spawn into DB
  setActiveSpawn(guildId, channel.id, message.id, poro.id, stats);

  // Run silent offline nets
  processNetsForSpawn(guildId, poro, stats);

  // DESPAWN timer: edits message, disables buttons, clears DB active flag
  setTimeout(async () => {
    const active = getActiveSpawn(guildId);

    // If caught already, or replaced by a new spawn, do nothing
    if (!active || active.message_id !== message.id) return;

    clearActiveSpawn(guildId);

    const ranEmbed = EmbedBuilder.from(embed)
      .setTitle("💨 The poro ran away!")
      .setDescription("No one caught it in time. A new poro will appear later.")
      .setTimestamp();

    const ranRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("poro_gone")
        .setLabel("Poro ran away")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId("poro_gone2")
        .setLabel("No berries now")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );

    await message.edit({ embeds: [ranEmbed], components: [ranRow] }).catch(() => {});
  }, 2 * 60 * 1000);

  return { ok: true, poro, stats };
}

module.exports = {
  trySpawnPoro,
  getActiveSpawn,
  clearActiveSpawn,
  forceClearSpawn,
};