/**
 * poro.js
 * Minimal commands:
 * - /poro menu (private UI)
 * - /poro showcase (public)
 * - /poro leaderboard (public)
 *
 * Admin-only:
 * - /poro admin channel
 * - /poro admin showcasechannel
 * - /poro admin spawnsperday
 * - /poro admin spawn
 * - /poro admin clearspawn
 * - /poro admin resetall (confirm button)
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const db = require("../db");
const { trySpawnPoro, forceClearSpawn } = require("../game/spawnManager");
const { loadPoros } = require("../game/poroCatalog");
const { getUser } = require("../game/items");
const { getUnlockedTitle } = require("../game/titles");

/**
 * Grab a few recent nicknames the user has used for this poro species.
 * (Purely for fun display in /poro showcase.)
 */
function getRecentNicknames(guildId, userId, poroId, limit = 3) {
  const rows = db.prepare(`
    SELECT nickname
    FROM user_catches
    WHERE guild_id = ? AND user_id = ? AND poro_id = ?
      AND nickname IS NOT NULL AND nickname != ''
    ORDER BY caught_ts DESC
    LIMIT ?
  `).all(guildId, userId, poroId, limit);

  return rows.map(r => r.nickname);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("poro")
    .setDescription("Poro Hunt minigame")

    // Player commands
    .addSubcommand(sub =>
      sub.setName("menu").setDescription("Open your Poro Hunt menu (private)")
    )
    .addSubcommand(sub =>
      sub
        .setName("showcase")
        .setDescription("Show a user's poro summary (public)")
        .addUserOption(opt => opt.setName("user").setDescription("Defaults to you"))
    )
    .addSubcommand(sub =>
      sub.setName("leaderboard").setDescription("Top poro catchers (public)")
    )

    // Admin group
    .addSubcommandGroup(group =>
      group
        .setName("admin")
        .setDescription("Admin controls")
        .addSubcommand(sub =>
          sub
            .setName("channel")
            .setDescription("Set the poro spawn channel")
            .addChannelOption(opt =>
              opt.setName("target").setDescription("Spawn channel").setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName("showcasechannel")
            .setDescription("Set the weekly showcase channel")
            .addChannelOption(opt =>
              opt.setName("target").setDescription("Weekly channel").setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName("spawnsperday")
            .setDescription("Set how many poros spawn per day in this server")
            .addIntegerOption(opt =>
              opt
                .setName("count")
                .setDescription("Recommended 4–12 (default 6)")
                .setMinValue(1)
                .setMaxValue(50)
                .setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub.setName("spawn").setDescription("Force spawn now (testing)")
        )
        .addSubcommand(sub =>
          sub.setName("clearspawn").setDescription("Clear stuck active spawn flag")
        )
        .addSubcommand(sub =>
          sub.setName("resetall").setDescription("DANGER: reset all server progress")
        )
    )

    // Keep default perms low (admins are checked in code)
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages),

  async execute(interaction) {
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();
    const group = interaction.options.getSubcommandGroup(false);

    /**
     * ---------------------------
     * /poro menu  (private UI)
     * ---------------------------
     */
    if (sub === "menu") {
      const { buildMainMenuMessage } = require("../interactions/ui");
      const payload = await buildMainMenuMessage(guildId, interaction.user.id, interaction.user.username);
      return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }

    /**
     * ---------------------------
     * /poro admin ... (admin only)
     * ---------------------------
     */
    if (group === "admin") {
      const canManage = interaction.member.permissions.has("ManageGuild");
      if (!canManage) {
        return interaction.reply({
          content: "You need **Manage Server** for admin commands.",
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "channel") {
        const channel = interaction.options.getChannel("target", true);

        db.prepare(`
          INSERT INTO config (guild_id, game_channel_id)
          VALUES (?, ?)
          ON CONFLICT(guild_id) DO UPDATE SET game_channel_id = excluded.game_channel_id
        `).run(guildId, channel.id);

        return interaction.reply({
          content: `✅ Spawns will happen in ${channel}.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "showcasechannel") {
        const channel = interaction.options.getChannel("target", true);

        db.prepare(`
          INSERT INTO config (guild_id, showcase_channel_id)
          VALUES (?, ?)
          ON CONFLICT(guild_id) DO UPDATE SET showcase_channel_id = excluded.showcase_channel_id
        `).run(guildId, channel.id);

        return interaction.reply({
          content: `✅ Weekly showcases will post in ${channel}.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "spawnsperday") {
        const count = interaction.options.getInteger("count", true);

        db.prepare(`
          INSERT INTO config (guild_id, daily_spawn_target)
          VALUES (?, ?)
          ON CONFLICT(guild_id) DO UPDATE SET daily_spawn_target = excluded.daily_spawn_target
        `).run(guildId, count);

        // Optional: also "nudge" next spawn sooner by clearing next_spawn_ts
        // (only do this if you want changes to take effect immediately)
        // db.prepare(`UPDATE config SET next_spawn_ts = 0 WHERE guild_id = ?`).run(guildId);

        return interaction.reply({
          content: `✅ Daily spawn target set to **${count}** per day for this server.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "spawn") {
        await interaction.reply({ content: "Attempting to spawn a poro…", flags: MessageFlags.Ephemeral });

        const result = await trySpawnPoro(interaction.client, guildId);
        if (!result.ok) {
          return interaction.followUp({
            content: `Spawn skipped: **${result.reason}**`,
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.followUp({
          content: `Spawned: **${result.poro.name}** (${result.poro.rarity})`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "clearspawn") {
        forceClearSpawn(guildId);
        return interaction.reply({ content: "✅ Cleared active spawn flag.", flags: MessageFlags.Ephemeral });
      }

      if (sub === "resetall") {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("admin_reset_confirm")
            .setLabel("CONFIRM RESET")
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId("admin_reset_cancel")
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Secondary)
        );

        return interaction.reply({
          content:
            `⚠️ This will wipe **ALL** Poro Hunt progress for this server:\n` +
            `- users (levels/xp/gold)\n` +
            `- collections\n` +
            `- catches\n` +
            `- net stash\n\n` +
            `Are you sure?`,
          components: [row],
          flags: MessageFlags.Ephemeral,
        });
      }

      // If we get here, it's an admin subcommand we didn't handle
      return interaction.reply({ content: "Unknown admin command.", flags: MessageFlags.Ephemeral });
    }

    /**
     * ---------------------------
     * /poro leaderboard (public)
     * ---------------------------
     */
    if (sub === "leaderboard") {
      const rows = db.prepare(`
        SELECT user_id, level, poros_caught
        FROM users
        WHERE guild_id = ?
        ORDER BY poros_caught DESC, level DESC
        LIMIT 10
      `).all(guildId);

      if (rows.length === 0) {
        return interaction.reply({ content: "No one has caught any poros yet." });
      }

      const lines = rows.map(
        (r, i) => `${i + 1}. <@${r.user_id}> — 🐾 **${r.poros_caught}** (Lv ${r.level})`
      );

      return interaction.reply({ content: `🏆 **Poro Leaderboard**\n${lines.join("\n")}` });
    }

    /**
     * ---------------------------
     * /poro showcase (public)
     * ---------------------------
     */
    if (sub === "showcase") {
      const targetUser = interaction.options.getUser("user") || interaction.user;

      // IMPORTANT:
      // user_catches is per-catch rows, so we COUNT(*) and GROUP BY poro_id to get totals.
      const rows = db.prepare(`
        SELECT poro_id, COUNT(*) AS caught_count
        FROM user_catches
        WHERE guild_id = ? AND user_id = ?
        GROUP BY poro_id
        ORDER BY caught_count DESC
      `).all(guildId, targetUser.id);

      if (rows.length === 0) {
        return interaction.reply({ content: `🐾 ${targetUser} hasn't caught any poros yet.` });
      }

      const poros = loadPoros();
      const poroMap = new Map(poros.map(p => [p.id, p]));
      const groups = { ultra_rare: [], rare: [], common: [] };

      for (const r of rows) {
        const p = poroMap.get(r.poro_id);
        if (!p) continue;

        const names = getRecentNicknames(guildId, targetUser.id, r.poro_id, 3);
        const namesText = names.length ? ` — names: ${names.map(n => `“${n}”`).join(", ")}` : "";

        groups[p.rarity] ??= [];
        groups[p.rarity].push(`- **${p.name}** ×${r.caught_count}${namesText}`);
      }

      const user = getUser(guildId, targetUser.id);
      const total = poros.length;

      const unique = db.prepare(`
        SELECT COUNT(DISTINCT poro_id) AS c
        FROM user_catches
        WHERE guild_id = ? AND user_id = ?
      `).get(guildId, targetUser.id)?.c || 0;

      const title = user.title || getUnlockedTitle(user.level);

      const sections = [];
      if (groups.ultra_rare?.length) sections.push(`👑 **Ultra Rare**\n${groups.ultra_rare.join("\n")}`);
      if (groups.rare?.length) sections.push(`✨ **Rare**\n${groups.rare.join("\n")}`);
      if (groups.common?.length) sections.push(`🐾 **Common**\n${groups.common.join("\n")}`);

      return interaction.reply({
        content:
          `🗂️ **${targetUser.username}'s Poro Showcase**\n` +
          `🎖️ ${title} | 📘 Dex: **${unique}/${total}**\n\n` +
          sections.join("\n\n"),
      });
    }

    // If we got here, it was an unhandled subcommand
    return interaction.reply({ content: "Unknown command.", flags: MessageFlags.Ephemeral });
  },
};