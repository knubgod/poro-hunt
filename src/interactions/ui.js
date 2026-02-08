/**
 * ui.js
 * Ephemeral menu UI (one /poro menu).
 *
 * Menu actions:
 * - Feed hungry poro (shows hunger list + dropdown feed + claim free food)
 * - Home
 * - Collection
 * - Inventory
 * - Titles
 * - Arm Net
 * - Shop
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
} = require("discord.js");

const db = require("../db");
const { getUser, armNet, buyNet, buyFoodBag, claimFreeFood, canClaimFreeFood, msUntilFreeFood, NET_COST, FOOD_BAG_COST, FOOD_BAG_USES } = require("../game/items");
const { TITLES, getUnlockedTitle } = require("../game/titles");
const { updateCatchHungerIfNeeded, feedCatch } = require("../game/hunger");
const { loadPoros } = require("../game/poroCatalog");
const { applyCatchSuccess } = require("../game/rewards");

function pad(str, width) {
  const s = String(str ?? "");
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

function formatMs(ms) {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function rowMenu() {
  // EXACT buttons requested
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ui_feed").setLabel("Feed Hungry Poro").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ui_home").setLabel("Home").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ui_collection").setLabel("Collection").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ui_inventory").setLabel("Inventory").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ui_titles").setLabel("Titles").setStyle(ButtonStyle.Secondary),
  );
}

function rowActions() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ui_net_arm").setLabel("Arm Net").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ui_shop").setLabel("Shop").setStyle(ButtonStyle.Primary),
  );
}

async function buildMainMenuMessage(guildId, userId, username = "User") {
  const user = getUser(guildId, userId);
  const poros = loadPoros();

  const unique = db.prepare(`
    SELECT COUNT(DISTINCT poro_id) AS c
    FROM user_poros
    WHERE guild_id = ? AND user_id = ?
  `).get(guildId, userId)?.c || 0;

  const total = poros.length;
  const title = user.title || getUnlockedTitle(user.level);

  const embed = new EmbedBuilder()
    .setTitle(`🐾 ${username}'s Poro Hunt Menu`)
    .setDescription(
      `🎖️ **${title}**\n` +
      `Level **${user.level}** | XP **${user.xp}**\n` +
      `🪙 Gold: **${user.gold || 0}g**\n` +
      `📘 Dex: **${unique}/${total}**\n\n` +
      `Use the buttons below.`
    );

  return { embeds: [embed], components: [rowMenu(), rowActions()] };
}

function buildInventoryView(guildId, userId, footerText) {
  const user = getUser(guildId, userId);

  const embed = new EmbedBuilder()
    .setTitle("🎒 Inventory")
    .setDescription(
      `🪙 Gold: **${user.gold || 0}g**\n` +
      `🪤 Nets: **${user.nets || 0}** (armed: **${user.nets_armed || 0}**)\n` +
      `🍖 Food uses: **${user.food || 0}**\n` +
      `🍓 Berries: **${user.berries || 0}** (used via spawn Toss Berry button)`
    );

  if (footerText) embed.setFooter({ text: footerText });

  return { embeds: [embed], components: [rowMenu(), rowActions()] };
}

function buildTitlesView(guildId, userId) {
  const user = getUser(guildId, userId);
  const lines = TITLES.map(t => `${user.level >= t.level ? "✅" : "🔒"} Lv ${t.level}: ${t.title}`).join("\n");

  const embed = new EmbedBuilder()
    .setTitle("🎖️ Titles")
    .setDescription(`Your level: **${user.level}**\n\n${lines}`);

  return { embeds: [embed], components: [rowMenu(), rowActions()] };
}

function buildCollectionView(guildId, userId, footerText) {
  const rows = db.prepare(`
    SELECT id, poro_id, size, weight, throw_distance, fluffiness, hunger, nickname, caught_ts
    FROM user_catches
    WHERE guild_id = ? AND user_id = ?
    ORDER BY caught_ts DESC
    LIMIT 25
  `).all(guildId, userId);

  const poros = loadPoros();
  const poroMap = new Map(poros.map(p => [p.id, p]));

  for (const r of rows) {
    const updated = updateCatchHungerIfNeeded(r.id);
    if (updated !== null) r.hunger = updated;
  }

  const header =
    `${pad("ID", 4)} ${pad("Species", 18)} ${pad("Sz", 2)} ${pad("Wt", 3)} ${pad("Thr", 3)} ${pad("Flf", 3)} ${pad("Hng", 3)} ${pad("!", 1)} ${pad("Name", 12)}`;

  const lines = rows.map(r => {
    const species = poroMap.get(r.poro_id)?.name || r.poro_id;
    const warn = r.hunger >= 8 ? "⚠" : " ";
    return (
      `${pad(r.id, 4)} ${pad(species, 18)} ${pad(r.size, 2)} ${pad(r.weight, 3)} ` +
      `${pad(r.throw_distance, 3)} ${pad(r.fluffiness, 3)} ${pad(r.hunger, 3)} ${pad(warn, 1)} ${pad(r.nickname || "-", 12)}`
    );
  });

  const embed = new EmbedBuilder()
    .setTitle("📦 Collection (latest 25)")
    .setDescription(
      rows.length
        ? "```text\n" + header + "\n" + lines.join("\n") + "\n```" + `\n⚠ = hungry (8–10). Feed from **Feed Hungry Poro**.`
        : "You haven’t caught any poros yet."
    );

  if (footerText) embed.setFooter({ text: footerText });

  return { embeds: [embed], components: [rowMenu(), rowActions()] };
}

function buildFeedView(guildId, userId, footerText) {
  const user = getUser(guildId, userId);

  // Show 15 most hungry
  const rows = db.prepare(`
    SELECT id, poro_id, hunger, nickname, caught_ts
    FROM user_catches
    WHERE guild_id = ? AND user_id = ?
    ORDER BY hunger DESC, caught_ts DESC
    LIMIT 15
  `).all(guildId, userId);

  const poros = loadPoros();
  const poroMap = new Map(poros.map(p => [p.id, p]));

  for (const r of rows) {
    const updated = updateCatchHungerIfNeeded(r.id);
    if (updated !== null) r.hunger = updated;
  }

  const topLines = rows.length
    ? rows.slice(0, 5).map(r => {
        const species = poroMap.get(r.poro_id)?.name || r.poro_id;
        const nick = r.nickname ? ` “${r.nickname}”` : "";
        const warn = r.hunger >= 8 ? " ⚠" : "";
        return `• **#${r.id}** ${species}${nick}: **${r.hunger}/10**${warn}`;
      }).join("\n")
    : "No caught poros yet.";

  const canFree = canClaimFreeFood(user);
  const freeText = canFree ? "✅ Free food bag available now." : `⏳ Free food bag in ${formatMs(msUntilFreeFood(user))}.`;

  const embed = new EmbedBuilder()
    .setTitle("🍽️ Feed Hungry Poro")
    .setDescription(
      `${topLines}\n\n` +
      `Food uses: **${user.food || 0}**\n` +
      `${freeText}\n\n` +
      `Hunger has **no penalties** — this is just a care indicator.`
    );

  if (footerText) embed.setFooter({ text: footerText });

  const components = [rowMenu(), rowActions()];

  // Claim free food button (enabled/disabled)
  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("ui_claim_free_food")
        .setLabel("Claim Free Food (+3)")
        .setStyle(ButtonStyle.Success)
        .setDisabled(!canFree)
    )
  );

  // Dropdown of hungry poros (hunger > 0)
  const feedable = rows
    .filter(r => r.hunger > 0)
    .slice(0, 25)
    .map(r => {
      const species = poroMap.get(r.poro_id)?.name || r.poro_id;
      const nick = r.nickname ? `“${r.nickname}”` : "no name";
      return {
        label: `#${r.id} ${species} (${nick})`,
        description: `Hunger ${r.hunger}/10`,
        value: String(r.id),
      };
    });

  if (feedable.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("ui_feed_select")
      .setPlaceholder("Select a poro to feed (uses 1 food)…")
      .addOptions(feedable);

    components.push(new ActionRowBuilder().addComponents(menu));
  }

  return { embeds: [embed], components };
}

function buildShopView(guildId, userId, footerText) {
  const user = getUser(guildId, userId);

  const embed = new EmbedBuilder()
    .setTitle("🏪 Shop")
    .setDescription(
      `🪙 Gold: **${user.gold || 0}g**\n\n` +
      `🪤 Net — **${NET_COST}g** (arm it later from menu)\n` +
      `🍖 Food Bag — **${FOOD_BAG_COST}g** (+${FOOD_BAG_USES} uses)\n\n` +
      `Free food bag (+3 uses) is available every 12 hours from **Feed Hungry Poro**.`
    );

  if (footerText) embed.setFooter({ text: footerText });

  const components = [
    rowMenu(),
    rowActions(),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ui_buy_net").setLabel(`Buy Net (${NET_COST}g)`).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ui_buy_food").setLabel(`Buy Food Bag (${FOOD_BAG_COST}g)`).setStyle(ButtonStyle.Success),
    ),
  ];

  return { embeds: [embed], components };
}

/**
 * Handle UI interactions
 */
async function handleUiInteraction(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  // Buttons
  if (interaction.isButton() && interaction.customId.startsWith("ui_")) {
    const id = interaction.customId;

    if (id === "ui_home") return interaction.update(await buildMainMenuMessage(guildId, userId));
    if (id === "ui_collection") return interaction.update(buildCollectionView(guildId, userId));
    if (id === "ui_inventory") return interaction.update(buildInventoryView(guildId, userId));
    if (id === "ui_titles") return interaction.update(buildTitlesView(guildId, userId));
    if (id === "ui_feed") return interaction.update(buildFeedView(guildId, userId));
    if (id === "ui_shop") return interaction.update(buildShopView(guildId, userId));

    if (id === "ui_net_arm") {
      const res = armNet(guildId, userId);
      return interaction.update(
        buildInventoryView(guildId, userId, res.ok ? "Net armed!" : "You have no nets. Buy one in Shop.")
      );
    }

    if (id === "ui_claim_free_food") {
      const res = claimFreeFood(guildId, userId);
      if (!res.ok) {
        return interaction.update(buildFeedView(guildId, userId, "Free food not ready yet."));
      }
      return interaction.update(buildFeedView(guildId, userId, `Claimed free food bag! +${res.added} uses.`));
    }

    if (id === "ui_buy_net") {
      const res = buyNet(guildId, userId);
      return interaction.update(buildShopView(guildId, userId, res.ok ? "Bought 1 net." : "Not enough gold."));
    }

    if (id === "ui_buy_food") {
      const res = buyFoodBag(guildId, userId);
      return interaction.update(buildShopView(guildId, userId, res.ok ? `Bought food bag (+${FOOD_BAG_USES} uses).` : "Not enough gold."));
    }

    return;
  }

  // Select menu: feeding
  if (interaction.isStringSelectMenu() && interaction.customId === "ui_feed_select") {
    const catchId = Number(interaction.values[0]);
    if (!Number.isFinite(catchId)) return;

    // Ownership check
    const owned = db.prepare(`
      SELECT id FROM user_catches WHERE id = ? AND guild_id = ? AND user_id = ?
    `).get(catchId, guildId, userId);

    if (!owned) return interaction.update(buildFeedView(guildId, userId, "That catch ID isn't yours."));

    const user = getUser(guildId, userId);
    if ((user.food || 0) <= 0) return interaction.update(buildFeedView(guildId, userId, "No food uses left. Claim free food or buy a bag."));

    // Update hunger then feed
    updateCatchHungerIfNeeded(catchId);
    const amount = 3 + Math.floor(Math.random() * 4);
    const fed = feedCatch(catchId, amount);

    if (!fed.ok) return interaction.update(buildFeedView(guildId, userId, "Could not feed that poro."));

    // Consume 1 food use
    db.prepare(`UPDATE users SET food = food - 1 WHERE guild_id = ? AND user_id = ?`).run(guildId, userId);

    return interaction.update(buildFeedView(guildId, userId, `Fed #${catchId}! Hunger -${amount}. Now ${fed.hunger}/10.`));
  }
}

module.exports = { handleUiInteraction, buildMainMenuMessage };