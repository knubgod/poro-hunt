/**
 * items.js
 * Inventory + economy helpers (current design)
 *
 * Current rules:
 * - Gold: earned per catch (handled in rewards.js)
 * - Nets cost 15g
 * - Food bag costs 5g and gives +3 food uses
 * - Free food bag every 12h gives +3 food uses
 * - Berries are only used via spawn "Toss Berry" button (no buffs stored on user)
 */

const db = require("../db");

const NET_COST = 15;
const FOOD_BAG_COST = 5;
const FOOD_BAG_USES = 3;
const FREE_FOOD_COOLDOWN_MS = 12 * 60 * 60 * 1000;

function ensureUserDefaults(guildId, userId) {
  const existing = db.prepare(`SELECT * FROM users WHERE guild_id = ? AND user_id = ?`).get(guildId, userId);
  if (existing) return existing;

  const now = Date.now();

  // Starter pack (tweak whenever):
  // - 20g so you can immediately try shop
  // - 3 food uses so feeding works from day 1
  db.prepare(`
    INSERT INTO users (
      guild_id, user_id,
      xp, level, poros_caught, last_catch_ts,
      title,
      gold,
      berries,
      nets, food,
      nets_armed,
      last_free_food_ts
    )
    VALUES (?, ?, 0, 1, 0, 0, NULL, 20, 0, 0, 3, 0, ?)
  `).run(guildId, userId, now);

  return db.prepare(`SELECT * FROM users WHERE guild_id = ? AND user_id = ?`).get(guildId, userId);
}

function getUser(guildId, userId) {
  return ensureUserDefaults(guildId, userId);
}

function updateUserFields(guildId, userId, fields) {
  const keys = Object.keys(fields);
  const setClause = keys.map(k => `${k} = ?`).join(", ");
  const values = keys.map(k => fields[k]);

  db.prepare(`
    UPDATE users
    SET ${setClause}
    WHERE guild_id = ? AND user_id = ?
  `).run(...values, guildId, userId);
}

/**
 * Arm a net:
 * - consume 1 net from inventory
 * - increment nets_armed
 */
function armNet(guildId, userId) {
  const user = getUser(guildId, userId);
  if ((user.nets || 0) <= 0) return { ok: false, reason: "no_nets" };

  updateUserFields(guildId, userId, {
    nets: user.nets - 1,
    nets_armed: (user.nets_armed || 0) + 1,
  });

  return { ok: true };
}

/**
 * Consume one armed net charge (used by spawnManager offline net processing)
 */
function consumeArmedNet(guildId, userId) {
  const user = getUser(guildId, userId);
  const armed = user.nets_armed || 0;
  if (armed <= 0) return false;

  updateUserFields(guildId, userId, { nets_armed: armed - 1 });
  return true;
}

/**
 * Shop: buy net
 */
function buyNet(guildId, userId) {
  const user = getUser(guildId, userId);
  if ((user.gold || 0) < NET_COST) return { ok: false, reason: "no_gold" };

  updateUserFields(guildId, userId, {
    gold: user.gold - NET_COST,
    nets: (user.nets || 0) + 1,
  });

  return { ok: true };
}

/**
 * Shop: buy food bag (adds +3 uses)
 */
function buyFoodBag(guildId, userId) {
  const user = getUser(guildId, userId);
  if ((user.gold || 0) < FOOD_BAG_COST) return { ok: false, reason: "no_gold" };

  updateUserFields(guildId, userId, {
    gold: user.gold - FOOD_BAG_COST,
    food: (user.food || 0) + FOOD_BAG_USES,
  });

  return { ok: true };
}

/**
 * Free food bag every 12 hours
 */
function canClaimFreeFood(user) {
  const last = user.last_free_food_ts || 0;
  return Date.now() - last >= FREE_FOOD_COOLDOWN_MS;
}

function msUntilFreeFood(user) {
  const last = user.last_free_food_ts || 0;
  const next = last + FREE_FOOD_COOLDOWN_MS;
  return Math.max(0, next - Date.now());
}

function claimFreeFood(guildId, userId) {
  const user = getUser(guildId, userId);
  if (!canClaimFreeFood(user)) {
    return { ok: false, reason: "cooldown", msLeft: msUntilFreeFood(user) };
  }

  updateUserFields(guildId, userId, {
    food: (user.food || 0) + FOOD_BAG_USES,
    last_free_food_ts: Date.now(),
  });

  return { ok: true, added: FOOD_BAG_USES };
}

module.exports = {
  NET_COST,
  FOOD_BAG_COST,
  FOOD_BAG_USES,
  FREE_FOOD_COOLDOWN_MS,
  ensureUserDefaults,
  getUser,
  updateUserFields,
  armNet,
  consumeArmedNet,
  buyNet,
  buyFoodBag,
  canClaimFreeFood,
  msUntilFreeFood,
  claimFreeFood,
};