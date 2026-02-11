/**
 * src/index.js
 * Poro Hunt entrypoint:
 * - Loads environment variables + DB
 * - Registers slash command handlers
 * - Schedules randomized spawns per guild with a "spawns/day" target
 * - Suppresses spawns during quiet hours (00:00–06:00 local)
 * - Posts weekly showcase
 * - Routes interactions to buttons/ui/modals
 */

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

require("./db"); // ensures DB schema/init runs at startup
const db = require("./db");

const poroCommand = require("./commands/poro");
const { handleButton } = require("./interactions/buttons");
const { handleModal } = require("./interactions/modals");
const { handleUiInteraction } = require("./interactions/ui");

const { trySpawnPoro } = require("./game/spawnManager");
const { loadPoros } = require("./game/poroCatalog");

// -------------------- Tunables --------------------

const SPAWN_TICK_MS = 30_000; // how often we "check" per guild if it's time to spawn
const WEEKLY_TICK_MS = 60_000;

const QUIET_START_HOUR = 0; // 00:00
const QUIET_END_HOUR = 6; // 06:00
const QUIET_JITTER_MAX_MINUTES = 30;

// If a spawn is already active, don't hammer checks constantly
const ALREADY_ACTIVE_RETRY_MS = 15 * 60 * 1000;

// If no channel configured, back off aggressively
const NO_CHANNEL_RETRY_MS = 6 * 60 * 60 * 1000;

// -------------------- Small helpers --------------------

function ymdLocal(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function isQuiet(ts = Date.now()) {
  const h = new Date(ts).getHours();
  return h >= QUIET_START_HOUR && h < QUIET_END_HOUR;
}

/**
 * When we need to postpone because of quiet hours,
 * schedule the next check shortly after 6am, with jitter.
 */
function nextMorningTs(nowTs = Date.now()) {
  const d = new Date(nowTs);
  const h = d.getHours();

  // If it's already >= 6am, schedule tomorrow; otherwise schedule today
  const addDay = h >= QUIET_END_HOUR ? 1 : 0;

  const t = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + addDay,
    QUIET_END_HOUR,
    0,
    0,
    0
  );

  t.setMinutes(randInt(0, QUIET_JITTER_MAX_MINUTES));
  return t.getTime();
}

// -------------------- Config helpers --------------------

function getConfig(guildId) {
  let row = db.prepare(`SELECT * FROM config WHERE guild_id = ?`).get(guildId);
  if (!row) {
    db.prepare(`INSERT INTO config (guild_id) VALUES (?)`).run(guildId);
    row = db.prepare(`SELECT * FROM config WHERE guild_id = ?`).get(guildId);
  }
  return row;
}

function setNextSpawnTs(guildId, ts) {
  db.prepare(`UPDATE config SET next_spawn_ts = ? WHERE guild_id = ?`).run(ts, guildId);
  return ts;
}

// -------------------- Onboarding message --------------------

const WELCOME_MESSAGE = `🐾 **Poro Hunt is live!**

I’ve added a Discord mini-game bot called **Poro Hunt**.

From time to time, a **poro will appear** in the designated spawn channel. Anyone can try to catch it — but **only one person can successfully catch each poro per spawn**. Once a poro is caught, it’s gone!

If one person fails and another succeeds, **only the successful catcher** gets that poro added to their collection.

**How to play**
- Use **/poro menu** to open your private Poro Hunt menu (no spam).
- When a poro spawns, click **Catch** to attempt.
- You can click **Toss Berry** first to boost *your* next catch attempt on that poro.
- Catch results (success/fail, rewards, naming) are **private**, so the channel stays clean.

**Progress & rewards**
- Catches give **XP + gold**
- Leveling unlocks **titles**
- Gold is used in the **Shop** for items like **nets**
- **Nets are 100%** and can catch poros while you’re offline
- Food is used to feed your poros (hunger has **no penalties**, just flavor)

**Goal**
Collect **one of every poro** (you can still catch duplicates).
`;

// -------------------- Spawn scheduling --------------------

/**
 * scheduleNextSpawnTs(guildId)
 * - Uses daily_spawn_target (default 6) and daily_spawn_count to spread spawns across the day.
 * - Persists next_spawn_ts so restarts don't "reset" randomness.
 * - Enforces quiet hours by scheduling for the next morning if needed.
 */
function scheduleNextSpawnTs(guildId) {
  const today = ymdLocal();
  const cfg = getConfig(guildId);

  // Reset daily counters on a new day
  if (cfg.daily_spawn_date !== today) {
    db.prepare(`
      UPDATE config
      SET daily_spawn_date = ?, daily_spawn_count = 0
      WHERE guild_id = ?
    `).run(today, guildId);
  }

  // Re-read after possible update
  const cfg2 = getConfig(guildId);
  const target = Math.max(1, cfg2.daily_spawn_target || 6);
  const done = Math.max(0, cfg2.daily_spawn_count || 0);

  // If quota reached, schedule tomorrow morning (not midnight, due to quiet hours)
  if (done >= target) {
    return setNextSpawnTs(guildId, nextMorningTs(new Date().setDate(new Date().getDate() + 1)));
  }

  const nowTs = Date.now();

  // If it's quiet hours right now, schedule the first eligible time after quiet hours
  if (isQuiet(nowTs)) {
    return setNextSpawnTs(guildId, nextMorningTs(nowTs));
  }

  // End of day local time
  const now = new Date(nowTs);
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 30, 0).getTime();

  // Spread remaining spawns across remaining time with randomness
  const remainingSpawns = Math.max(1, target - done);
  const remainingMs = Math.max(60_000, endOfDay - nowTs);

  // Average gap needed
  const avg = Math.max(30 * 60 * 1000, Math.floor(remainingMs / remainingSpawns));

  // Random window around avg
  const minGap = 10 * 60 * 1000;
  const maxGap = Math.min(6 * 60 * 60 * 1000, Math.max(minGap, 2 * avg));

  let nextTs = nowTs + randInt(minGap, maxGap);

  // If the rolled time lands in quiet hours, bump to next morning
  if (isQuiet(nextTs)) {
    nextTs = nextMorningTs(nextTs);
  }

  return setNextSpawnTs(guildId, nextTs);
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

  // Reset day if needed
  if (cfg.daily_spawn_date !== today) {
    db.prepare(`
      UPDATE config
      SET daily_spawn_date = ?, daily_spawn_count = 0
      WHERE guild_id = ?
    `).run(today, guildId);
  }

  // Count this spawn
  db.prepare(`
    UPDATE config
    SET daily_spawn_count = daily_spawn_count + 1
    WHERE guild_id = ?
  `).run(guildId);

  // Schedule next one
  scheduleNextSpawnTs(guildId);
}

// -------------------- Weekly showcase --------------------

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

  let common = 0;
  let rare = 0;
  let ultra = 0;

  for (const r of rarityCounts) {
    const p = poroMap.get(r.poro_id);
    if (!p) continue;
    if (p.rarity === "common") common += r.caught_count;
    else if (p.rarity === "rare") rare += r.caught_count;
    else if (p.rarity === "ultra_rare") ultra += r.caught_count;
  }

  const topLines = top.length
    ? top
        .map((u, i) => `${i + 1}. <@${u.user_id}> — 🐾 ${u.poros_caught} (Lv ${u.level})`)
        .join("\n")
    : "No catches yet 👀";

  return (
    `🗓️ **Weekly Poro Showcase**\n` +
    `Totals — 🐾 Common: **${common}** | ✨ Rare: **${rare}** | 👑 Ultra: **${ultra}**\n\n` +
    `🏆 **Top Catchers**\n${topLines}\n\n` +
    `Tip: \`/poro menu\` for your private UI.`
  );
}

async function maybePostWeeklyShowcase(client) {
  const now = new Date();

  // Sunday at 18:00
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

// -------------------- Discord client --------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.commands = new Collection();
client.commands.set(poroCommand.data.name, poroCommand);

client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Ensure every guild has a schedule
  for (const [guildId] of client.guilds.cache) {
    const cfg = getConfig(guildId);
    if (!cfg.next_spawn_ts || cfg.next_spawn_ts === 0) {
      scheduleNextSpawnTs(guildId);
    }
  }

  // Spawn tick
  setInterval(async () => {
    for (const [guildId] of client.guilds.cache) {
      if (!shouldSpawnNow(guildId)) continue;

      // If it's quiet now, push the next check to the morning (prevents "spam checking" overnight)
      if (isQuiet()) {
        setNextSpawnTs(guildId, nextMorningTs());
        continue;
      }

      const result = await trySpawnPoro(client, guildId);

      if (result.ok) {
        markSpawnHappened(guildId);
        continue;
      }

      // Handle common skip reasons so scheduling doesn't get stuck
      if (result.reason === "already_active") {
        setNextSpawnTs(guildId, Date.now() + ALREADY_ACTIVE_RETRY_MS);
        continue;
      }

      if (result.reason === "no_channel" || result.reason === "channel_missing") {
        setNextSpawnTs(guildId, Date.now() + NO_CHANNEL_RETRY_MS);
        continue;
      }

      // Unknown reason: try again later
      setNextSpawnTs(guildId, Date.now() + ALREADY_ACTIVE_RETRY_MS);
    }
  }, SPAWN_TICK_MS);

  // Weekly showcase tick
  setInterval(async () => {
    await maybePostWeeklyShowcase(client);
  }, WEEKLY_TICK_MS);
});

/**
 * When the bot joins a new server:
 * - ensure config row exists
 * - schedule spawns
 * - post onboarding message (best effort)
 */
client.on("guildCreate", async (guild) => {
  try {
    getConfig(guild.id);
    scheduleNextSpawnTs(guild.id);

    // Prefer system channel if possible, otherwise pick first text channel we can speak in
    let channel = guild.systemChannel;

    if (!channel) {
      const textChannels = guild.channels.cache
        .filter((c) => c.isTextBased && c.isTextBased())
        .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));

      for (const c of textChannels.values()) {
        try {
          const me = guild.members.me;
          if (!me) continue;
          const perms = c.permissionsFor(me);
          if (perms && perms.has("SendMessages") && perms.has("ViewChannel")) {
            channel = c;
            break;
          }
        } catch (_) {}
      }
    }

    if (channel) {
      await channel.send(WELCOME_MESSAGE).catch(() => {});
    }
  } catch (err) {
    console.error("Failed to send onboarding message:", err);
  }
});

// -------------------- Interaction routing --------------------

client.on("interactionCreate", async (interaction) => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      const cmd = client.commands.get(interaction.commandName);
      if (!cmd) return;
      await cmd.execute(interaction);
      return;
    }

    // UI menu stuff (your private "sudo-UI")
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