require("dotenv").config();

const {
  Client,
  Collection,
  GatewayIntentBits,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require("discord.js");

require("./db"); // ensure DB initializes on startup

const poroCommand = require("./commands/poro");
const { handleButton } = require("./interactions/buttons");
const { handleModal } = require("./interactions/modals");
const { handleUiInteraction } = require("./interactions/ui");
const { trySpawnPoro } = require("./game/spawnManager");
const { loadPoros } = require("./game/poroCatalog");
const db = require("./db");

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.commands = new Collection();

// IMPORTANT: poroCommand must export { data, execute }
client.commands.set(poroCommand.data.name, poroCommand);

/**
 * Spawn scheduling
 * Mostly hours; back-to-back rare.
 */
const nextSpawnAt = new Map();

function randomMsBetween(minMs, maxMs) {
  return Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
}

// Adjust as you like
function rollNextSpawnDelayMs() {
  const r = Math.random();
  if (r < 0.02) return randomMsBetween(5 * 60 * 1000, 15 * 60 * 1000);
  if (r < 0.10) return randomMsBetween(15 * 60 * 1000, 30 * 60 * 1000);
  if (r < 0.40) return randomMsBetween(30 * 60 * 1000, 90 * 60 * 1000);
  if (r < 0.80) return randomMsBetween(90 * 60 * 1000, 240 * 60 * 1000);
  return randomMsBetween(240 * 60 * 1000, 480 * 60 * 1000);
}

function scheduleNextSpawn(guildId) {
  nextSpawnAt.set(guildId, Date.now() + rollNextSpawnDelayMs());
}

function buildWeeklyShowcaseText(guildId) {
  const poros = loadPoros();
  const poroMap = new Map(poros.map((p) => [p.id, p]));

  const top = db.prepare(`
    SELECT user_id, poros_caught, level
    FROM users
    WHERE guild_id = ?
    ORDER BY poros_caught DESC, level DESC
    LIMIT 5
  `).all(guildId);

  const rarityCounts = db.prepare(`
    SELECT poro_id, caught_count
    FROM user_poros
    WHERE guild_id = ?
  `).all(guildId);

  let common = 0, rare = 0, ultra = 0;
  for (const r of rarityCounts) {
    const p = poroMap.get(r.poro_id);
    if (!p) continue;
    if (p.rarity === "common") common += r.caught_count;
    else if (p.rarity === "rare") rare += r.caught_count;
    else if (p.rarity === "ultra_rare") ultra += r.caught_count;
  }

  const topLines = top.length
    ? top.map((u, i) => `${i + 1}. <@${u.user_id}> — 🐾 ${u.poros_caught} (Lv ${u.level})`).join("\n")
    : "No catches yet 👀";

  return (
    `🗓️ **Weekly Poro Showcase**\n` +
    `Totals — 🐾 Common: **${common}** | ✨ Rare: **${rare}** | 👑 Ultra: **${ultra}**\n\n` +
    `🏆 **Top Catchers**\n${topLines}\n\n` +
    `Tip: \`/poro menu\` for your private UI.`
  );
}

async function maybePostWeeklyShowcase() {
  const now = new Date();
  if (now.getDay() !== 0 || now.getHours() !== 18 || now.getMinutes() !== 0) return;

  for (const [guildId] of client.guilds.cache) {
    const cfg = db.prepare(`
      SELECT showcase_channel_id, last_weekly_showcase_ts
      FROM config
      WHERE guild_id = ?
    `).get(guildId);

    if (!cfg || !cfg.showcase_channel_id) continue;

    const last = cfg.last_weekly_showcase_ts || 0;
    if (Date.now() - last < 6 * 24 * 60 * 60 * 1000) continue;

    const channel = await client.channels.fetch(cfg.showcase_channel_id).catch(() => null);
    if (!channel) continue;

    await channel.send({ content: buildWeeklyShowcaseText(guildId) }).catch(() => {});
    db.prepare(`UPDATE config SET last_weekly_showcase_ts = ? WHERE guild_id = ?`).run(Date.now(), guildId);
  }
}

client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  for (const [guildId] of client.guilds.cache) scheduleNextSpawn(guildId);

  setInterval(async () => {
    const now = Date.now();
    for (const [guildId] of client.guilds.cache) {
      if (!nextSpawnAt.has(guildId)) scheduleNextSpawn(guildId);
      if (now < nextSpawnAt.get(guildId)) continue;

      await trySpawnPoro(client, guildId);
      scheduleNextSpawn(guildId);
    }
  }, 15_000);

  setInterval(async () => {
    await maybePostWeeklyShowcase();
  }, 60_000);
});

client.on("guildCreate", (guild) => scheduleNextSpawn(guild.id));

client.on("interactionCreate", async (interaction) => {
  try {
    // Commands
    if (interaction.isChatInputCommand()) {
      const cmd = client.commands.get(interaction.commandName);
      if (!cmd) return;
      await cmd.execute(interaction);
      return;
    }

    // UI buttons + UI select menus
    if (
      (interaction.isButton() && interaction.customId.startsWith("ui_")) ||
      (interaction.isStringSelectMenu() && interaction.customId === "ui_feed_select")
    ) {
      await handleUiInteraction(interaction);
      return;
    }

    // Naming modal launcher
    if (interaction.isButton() && interaction.customId.startsWith("poro_name:")) {
      const catchId = interaction.customId.split(":")[1];

      const modal = new ModalBuilder()
        .setCustomId(`poro_name_modal:${catchId}`)
        .setTitle("Name your Poro (optional)");

      const nicknameInput = new TextInputBuilder()
        .setCustomId("nickname")
        .setLabel("Nickname (1-24 chars)")
        .setStyle(TextInputStyle.Short)
        .setMinLength(1)
        .setMaxLength(24)
        .setPlaceholder("e.g., Sir Fluffington")
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(nicknameInput));
      await interaction.showModal(modal);
      return;
    }

    // Game/admin-confirm buttons
    if (interaction.isButton()) {
      await handleButton(interaction);
      return;
    }

    // Modals
    if (interaction.isModalSubmit()) {
      await handleModal(interaction);
      return;
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      const msg = "Something went wrong. Try again.";
      if (interaction.deferred || interaction.replied) {
        interaction.followUp({ content: msg }).catch(() => {});
      } else {
        interaction.reply({ content: msg }).catch(() => {});
      }
    }
  }
});

client.login(process.env.DISCORD_TOKEN);