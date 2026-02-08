/**
 * rewards.js
 * Applies catch success:
 * - xp/level/title
 * - aggregate + instance rows
 * - gold reward by rarity
 *
 * Gold rules:
 * - common: 1–7
 * - rare: 8–16
 * - ultra_rare: 17–50
 */

const db = require("../db");
const { xpNeededForLevel } = require("./poroLogic");
const { getUnlockedTitle } = require("./titles");
const { loadPoros } = require("./poroCatalog");

const poros = loadPoros();
const poroMap = new Map(poros.map(p => [p.id, p]));

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function goldForRarity(rarity) {
  if (rarity === "ultra_rare") return randInt(17, 50);
  if (rarity === "rare") return randInt(8, 16);
  return randInt(1, 7);
}

function getOrCreateUser(guildId, userId) {
  const existing = db.prepare(`SELECT * FROM users WHERE guild_id = ? AND user_id = ?`).get(guildId, userId);
  if (existing) return existing;

  const now = Date.now();
  db.prepare(`
    INSERT INTO users (
      guild_id, user_id,
      xp, level, poros_caught, last_catch_ts,
      title,
      gold,
      berries, nets, food,
      berry_buff_charges, berry_buff_expires_ts,
      nets_armed,
      last_free_food_ts
    )
    VALUES (?, ?, 0, 1, 0, 0, NULL, 20, 0, 0, 3, 0, 0, 0, ?)
  `).run(guildId, userId, now);

  return db.prepare(`SELECT * FROM users WHERE guild_id = ? AND user_id = ?`).get(guildId, userId);
}

function recordCaughtPoroAggregate(guildId, userId, poroId) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO user_poros (guild_id, user_id, poro_id, caught_count, first_caught_ts, last_catch_ts)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(guild_id, user_id, poro_id) DO UPDATE SET
      caught_count = caught_count + 1,
      last_catch_ts = excluded.last_catch_ts
  `).run(guildId, userId, poroId, now, now);
}

function recordCatchInstance(guildId, userId, poroId, stats) {
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO user_catches (
      guild_id, user_id, poro_id, caught_ts,
      size, weight, throw_distance, fluffiness, hunger,
      nickname, hunger_updated_ts
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(
    guildId, userId, poroId, now,
    stats.size, stats.weight, stats.throwDistance, stats.fluffiness, stats.hunger,
    now
  );
  return Number(info.lastInsertRowid);
}

function applyCatchSuccess({ guildId, userId, poroId, gainedXp, nowTs, stats }) {
  const user = getOrCreateUser(guildId, userId);
  const poro = poroMap.get(poroId);
  const rarity = poro?.rarity || "common";
  const goldEarned = goldForRarity(rarity);

  let newXp = user.xp + gainedXp;
  let newLevel = user.level;
  let leveledUp = false;

  while (newXp >= xpNeededForLevel(newLevel)) {
    newXp -= xpNeededForLevel(newLevel);
    newLevel += 1;
    leveledUp = true;
  }

  const newTitle = getUnlockedTitle(newLevel);

  db.prepare(`
    UPDATE users
    SET xp = ?, level = ?, poros_caught = ?, last_catch_ts = ?, title = ?, gold = gold + ?
    WHERE guild_id = ? AND user_id = ?
  `).run(
    newXp,
    newLevel,
    user.poros_caught + 1,
    nowTs,
    newTitle,
    goldEarned,
    guildId,
    userId
  );

  recordCaughtPoroAggregate(guildId, userId, poroId);
  const catchId = recordCatchInstance(guildId, userId, poroId, stats);

  return { leveledUp, newLevel, newXp, newTitle, catchId, goldEarned, rarity };
}

module.exports = { applyCatchSuccess };