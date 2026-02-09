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

function ymdLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function getConfig(guildId) {
  const row = db.prepare(`SELECT * FROM config WHERE guild_id = ?`).get(guildId);
  if (row) return row;

  db.prepare(`INSERT INTO config (guild_id) VALUES (?)`).run(guildId);
  return db.prepare(`SELECT * FROM config WHERE guild_id = ?`).get(guildId);
}

/**
 * Schedules the next spawn time using:
 * - target spawns/day (default 6)
 * - remaining time today
 * - remaining spawns today
 * Random, but guaranteed.
 */
function scheduleNextSpawnTs(guildId) {
  const cfg = getConfig(guildId);
  const today = ymdLocal();

  // Reset daily counters if new day
  if (cfg.daily_spawn_date !== today) {
    db.prepare(`
      UPDATE config
      SET daily_spawn_date = ?, daily_spawn_count = 0
      WHERE guild_id = ?
    `).run(today, guildId);
  }

  const cfg2 = getConfig(guildId);
  const target = cfg2.daily_spawn_target || 6;
  const done = cfg2.daily_spawn_count || 0;

  // If we've hit today's quota, schedule just after midnight
  if (done >= target) {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 5, 0).getTime(); // 12:05am
    db.prepare(`UPDATE config SET next_spawn_ts = ? WHERE guild_id = ?`).run(midnight, guildId);
    return midnight;
  }

  const nowTs = Date.now();

  // End of day (11:59pm local)
  const now = new Date();
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0).getTime();

  const remainingSpawns = target - done;
  const remainingMs = Math.max(60_000, endOfDay - nowTs);

  // Average spacing needed to fit remaining spawns in remaining time
  const avgGap = Math.floor(remainingMs / remainingSpawns);

  // Randomize around avg gap:
  // - minimum gap 10 minutes
  // - maximum gap ~2x avg gap (capped to 6 hours so it doesn't go dead)
  const minGap = 10 * 60 * 1000;
  const maxGap = Math.min(6 * 60 * 60 * 1000, Math.max(minGap, avgGap * 2));

  const nextTs = nowTs + randInt(minGap, maxGap);

  db.prepare(`UPDATE config SET next_spawn_ts = ? WHERE guild_id = ?`).run(nextTs, guildId);
  return nextTs;
}

function shouldSpawnNow(guildId) {
  const cfg = getConfig(guildId);
  const next = cfg.next_spawn_ts || 0;
  if (next === 0) {
    scheduleNextSpawnTs(guildId);
    return false;
  }
  return Date.now() >= next;
}

function markSpawnHappened(guildId) {
  const today = ymdLocal();
  const cfg = getConfig(guildId);

  // If date changed, reset first
  if (cfg.daily_spawn_date !== today) {
    db.prepare(`
      UPDATE config
      SET daily_spawn_date = ?, daily_spawn_count = 0
      WHERE guild_id = ?
    `).run(today, guildId);
  }

  db.prepare(`
    UPDATE config
    SET daily_spawn_count = daily_spawn_count + 1
    WHERE guild_id = ?
  `).run(guildId);

  scheduleNextSpawnTs(guildId);
}

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
/**
 * Spawn scheduling (quota-per-day + random)
 * - Guarantees ~N spawns per day (default 6)
 * - Still randomized timing
 * - Persists schedule in DB so restarts don't "reset" randomness
 */

function ymdLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function getConfig(guildId) {
  let row = db.prepare(`SELECT * FROM config WHERE guild_id = ?`).get(guildId);
  if (!row) {
    db.prepare(`INSERT INTO config (guild_id) VALUES (?)`).run(guildId);
    row = db.prepare(`SELECT * FROM config WHERE guild_id = ?`).get(guildId);
  }
  return row;
}

function scheduleNextSpawnTs(guildId) {
  const today = ymdLocal();
  const cfg = getConfig(guildId);

  // Reset counter on a new day
  if (cfg.daily_spawn_date !== today) {
    db.prepare(`
      UPDATE config
      SET daily_spawn_date = ?, daily_spawn_count = 0
      WHERE guild_id = ?
    `).run(today, guildId);
  }

  const cfg2 = getConfig(guildId);
  const target = cfg2.daily_spawn_target || 6;
  const done = cfg2.daily_spawn_count || 0;

  // If we hit quota, schedule just after midnight
  if (done >= target) {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 5, 0).getTime();
    db.prepare(`UPDATE config SET next_spawn_ts = ? WHERE guild_id = ?`).run(midnight, guildId);
    return midnight;
  }

  const nowTs = Date.now();
  const now = new Date();
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0).getTime();

  const remainingSpawns = Math.max(1, target - done);
  const remainingMs = Math.max(60_000, endOfDay - nowTs);
  const avgGap = Math.floor(remainingMs / remainingSpawns);

  // Random gap centered around what's needed to fit the remaining spawns today
  const minGap = 10 * 60 * 1000; // 10 min
  const maxGap = Math.min(6 * 60 * 60 * 1000, Math.max(minGap, avgGap * 2)); // cap at 6h

  const nextTs = nowTs + randInt(minGap, maxGap);
  db.prepare(`UPDATE config SET next_spawn_ts = ? WHERE guild_id = ?`).run(nextTs, guildId);
  return nextTs;
}

function shouldSpawnNow(guildId) {
  const cfg = getConfig(guildId);
  const next = cfg.next_spawn_ts || 0;
  if (next === 0) {
    scheduleNextSpawnTs(guildId);
    return false;
  }
  return Date.now() >= next;
}

function markSpawnHappened(guildId) {
  const today = ymdLocal();
  const cfg = getConfig(guildId);

  if (cfg.daily_spawn_date !== today) {
    db.prepare(`
      UPDATE config
      SET daily_spawn_date = ?, daily_spawn_count = 0
      WHERE guild_id = ?
    `).run(today, guildId);
  }

  db.prepare(`
    UPDATE config
    SET daily_spawn_count = daily_spawn_count + 1
    WHERE guild_id = ?
  `).run(guildId);

  scheduleNextSpawnTs(guildId);
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

  for (const [guildId] of client.guilds.cache) scheduleNextSpawnTs(guildId);

 setInterval(async () => {
  for (const [guildId] of client.guilds.cache) {
    if (!shouldSpawnNow(guildId)) continue;

    const result = await trySpawnPoro(client, guildId);
    if (result.ok) {
      markSpawnHappened(guildId);
    } else {
      // If there's already an active spawn, try again later
      if (result.reason === "already_active") {
        const soon = Date.now() + 15 * 60 * 1000;
        db.prepare(`UPDATE config SET next_spawn_ts = ? WHERE guild_id = ?`).run(soon, guildId);
      }
      // If no channel set, admin needs to set it; don't keep rescheduling aggressively
    }
  }
}, 30_000);

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