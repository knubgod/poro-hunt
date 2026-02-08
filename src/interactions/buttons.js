/**
 * buttons.js
 * Handles:
 * - admin_reset_confirm / admin_reset_cancel
 * - poro_toss_berry (per-spawn boost)
 * - poro_catch (attempt catch)
 */

const db = require("../db");
const { getActiveSpawn, clearActiveSpawn } = require("../game/spawnManager");
const { getPoroById } = require("../game/poroCatalog");
const { rollCatch, getXpReward } = require("../game/poroLogic");
const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { getUser } = require("../game/items");
const { applyCatchSuccess } = require("../game/rewards");

const TOSS_BERRY_BONUS = 0.15;

function hasAttempted(guildId, messageId, userId) {
  return db.prepare(`
    SELECT 1 FROM spawn_attempts
    WHERE guild_id = ? AND message_id = ? AND user_id = ?
  `).get(guildId, messageId, userId);
}

function recordAttempt(guildId, messageId, userId) {
  db.prepare(`
    INSERT INTO spawn_attempts (guild_id, message_id, user_id, attempt_ts)
    VALUES (?, ?, ?, ?)
  `).run(guildId, messageId, userId, Date.now());
}

function hasTossedBerry(guildId, messageId, userId) {
  return db.prepare(`
    SELECT 1 FROM spawn_berry
    WHERE guild_id = ? AND message_id = ? AND user_id = ?
  `).get(guildId, messageId, userId);
}

function recordBerryToss(guildId, messageId, userId) {
  db.prepare(`
    INSERT INTO spawn_berry (guild_id, message_id, user_id, used_ts)
    VALUES (?, ?, ?, ?)
  `).run(guildId, messageId, userId, Date.now());
}

function consumeBerryToss(guildId, messageId, userId) {
  db.prepare(`
    DELETE FROM spawn_berry
    WHERE guild_id = ? AND message_id = ? AND user_id = ?
  `).run(guildId, messageId, userId);
}

async function handleButton(interaction) {
  if (!interaction.isButton()) return;

  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  /**
   * ---------------------------
   * Admin reset confirm/cancel
   * ---------------------------
   */
  if (interaction.customId === "admin_reset_cancel") {
    return interaction.update({ content: "✅ Reset cancelled.", components: [] });
  }

  if (interaction.customId === "admin_reset_confirm") {
    // Wipe server game data
    db.prepare(`DELETE FROM spawn_attempts WHERE guild_id = ?`).run(guildId);
    db.prepare(`DELETE FROM spawn_berry WHERE guild_id = ?`).run(guildId);
    db.prepare(`DELETE FROM spawns WHERE guild_id = ?`).run(guildId);
    db.prepare(`DELETE FROM user_poros WHERE guild_id = ?`).run(guildId);
    db.prepare(`DELETE FROM user_catches WHERE guild_id = ?`).run(guildId);
    db.prepare(`DELETE FROM net_stash WHERE guild_id = ?`).run(guildId);
    db.prepare(`DELETE FROM users WHERE guild_id = ?`).run(guildId);

    return interaction.update({ content: "🧨 Server progress reset. Everyone starts fresh.", components: [] });
  }

  /**
   * ---------------------------
   * Toss Berry (spawn boost)
   * ---------------------------
   */
  if (interaction.customId === "poro_toss_berry") {
    const spawn = getActiveSpawn(guildId);

    // Must be the active spawn message
    if (!spawn || interaction.message.id !== spawn.message_id) {
      return interaction.reply({ content: "No active poro to feed right now.", flags: MessageFlags.Ephemeral });
    }

    const user = getUser(guildId, userId);
    if ((user.berries || 0) <= 0) {
      return interaction.reply({ content: "You don’t have any berries.", flags: MessageFlags.Ephemeral });
    }

    if (hasTossedBerry(guildId, spawn.message_id, userId)) {
      return interaction.reply({ content: "You already tossed a berry at this poro.", flags: MessageFlags.Ephemeral });
    }

    // Consume 1 berry and record per-spawn boost
    db.prepare(`UPDATE users SET berries = berries - 1 WHERE guild_id = ? AND user_id = ?`).run(guildId, userId);
    recordBerryToss(guildId, spawn.message_id, userId);

    return interaction.reply({
      content: `🍓 You tossed a berry! Your **next catch attempt on this poro** gets **+${Math.round(TOSS_BERRY_BONUS * 100)}%**.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  /**
   * ---------------------------
   * Catch attempt
   * ---------------------------
   */
  if (interaction.customId !== "poro_catch") return;

  const spawn = getActiveSpawn(guildId);
  if (!spawn) {
    return interaction.reply({ content: "Too slow — no poro is active right now.", flags: MessageFlags.Ephemeral });
  }

  // Prevent catching old messages if a new spawn happened
  if (interaction.message.id !== spawn.message_id) {
    return interaction.reply({ content: "That poro is no longer active.", flags: MessageFlags.Ephemeral });
  }

  if (hasAttempted(guildId, spawn.message_id, userId)) {
    return interaction.reply({ content: "You already tried to catch this poro!", flags: MessageFlags.Ephemeral });
  }

  recordAttempt(guildId, spawn.message_id, userId);

  const poro = getPoroById(spawn.poro_id);
  if (!poro) {
    return interaction.reply({ content: "Spawn data is missing poro type.", flags: MessageFlags.Ephemeral });
  }

  const spawnStats = {
    size: spawn.spawn_size,
    weight: spawn.spawn_weight,
    throwDistance: spawn.spawn_throw_distance,
    fluffiness: spawn.spawn_fluffiness,
    hunger: spawn.spawn_hunger,
  };

  const user = getUser(guildId, userId);

  // Base chance + small level bonus
  let chance = poro.baseCatch + (user.level * 0.005);

  // Per-spawn berry toss bonus (consumed if present)
  const tossed = !!hasTossedBerry(guildId, spawn.message_id, userId);
  if (tossed) {
    chance += TOSS_BERRY_BONUS;
    consumeBerryToss(guildId, spawn.message_id, userId);
  }

  chance = Math.min(0.85, chance);

  const success = rollCatch(chance);
  const gainedXp = getXpReward(success, poro.xpBonus);

  if (success) {
    // Stop the active spawn in DB
    clearActiveSpawn(guildId);

    // Disable the spawn message buttons publicly
    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("poro_caught")
        .setLabel("Poro caught!")
        .setStyle(ButtonStyle.Success)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId("poro_ended")
        .setLabel("Spawn ended")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );

    await interaction.message.edit({ components: [disabledRow] }).catch(() => {});

    // Apply reward (writes instance + aggregates + gold)
    const reward = applyCatchSuccess({
      guildId,
      userId,
      poroId: poro.id,
      gainedXp,
      nowTs: Date.now(),
      stats: spawnStats,
    });

    // Build naming button row BEFORE reply
    const nameRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`poro_name:${reward.catchId}`)
        .setLabel("Name it (optional)")
        .setStyle(ButtonStyle.Secondary)
    );

    return interaction.reply({
      content:
        `✅ You caught the **${poro.name}**! (+${gainedXp} XP, +${reward.goldEarned}g)\n` +
        (tossed ? `🍓 Berry helped! (+${Math.round(TOSS_BERRY_BONUS * 100)}%)\n` : "") +
        `Catch chance: **${Math.round(chance * 100)}%**\n\n` +
        `Want to nickname it?`,
      components: [nameRow],
      flags: MessageFlags.Ephemeral,
    });
  }

  // Failure path
  return interaction.reply({
    content:
      `❌ The **${poro.name}** slipped away… (+${gainedXp} XP)\n` +
      (tossed ? `🍓 Berry helped! (+${Math.round(TOSS_BERRY_BONUS * 100)}%)\n` : "") +
      `Catch chance: **${Math.round(chance * 100)}%**`,
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = { handleButton };