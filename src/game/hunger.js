/**
 * hunger.js
 * Hunger rules:
 * - Hunger ranges 0..10
 * - It takes 12 hours to go from 0 -> 10
 * - That means +1 hunger every 72 minutes (12h / 10)
 *
 * We store hunger_updated_ts per catch so hunger increases only based on time elapsed.
 */

const db = require("../db");

const HUNGER_MAX = 10;
const FULLY_HUNGRY_MS = 12 * 60 * 60 * 1000; // 12 hours
const MS_PER_HUNGER = Math.floor(FULLY_HUNGRY_MS / HUNGER_MAX); // 72 minutes per point

/**
 * Updates hunger for a single catch row if enough time has passed.
 * Returns:
 * - new hunger (number) if updated
 * - null if no update was needed or catch not found
 */
function updateCatchHungerIfNeeded(catchId) {
  const row = db.prepare(`
    SELECT hunger, hunger_updated_ts
    FROM user_catches
    WHERE id = ?
  `).get(catchId);

  if (!row) return null;

  const now = Date.now();
  const last = row.hunger_updated_ts || now;
  const elapsed = now - last;

  // How many whole hunger "ticks" passed?
  const inc = Math.floor(elapsed / MS_PER_HUNGER);
  if (inc <= 0) return null;

  const newHunger = Math.min(HUNGER_MAX, (row.hunger || 0) + inc);

  // Advance the timestamp by the number of ticks applied (preserves remainder time)
  const newTs = last + inc * MS_PER_HUNGER;

  db.prepare(`
    UPDATE user_catches
    SET hunger = ?, hunger_updated_ts = ?
    WHERE id = ?
  `).run(newHunger, newTs, catchId);

  return newHunger;
}

/**
 * Feed a caught poro:
 * - reduces hunger by amount
 * - updates hunger_updated_ts to now (so it doesn't instantly tick back up)
 */
function feedCatch(catchId, amount) {
  const row = db.prepare(`
    SELECT hunger
    FROM user_catches
    WHERE id = ?
  `).get(catchId);

  if (!row) return { ok: false };

  const now = Date.now();
  const current = row.hunger || 0;
  const next = Math.max(0, current - Math.max(0, amount));

  db.prepare(`
    UPDATE user_catches
    SET hunger = ?, hunger_updated_ts = ?
    WHERE id = ?
  `).run(next, now, catchId);

  return { ok: true, hunger: next };
}

module.exports = {
  HUNGER_MAX,
  FULLY_HUNGRY_MS,
  MS_PER_HUNGER,
  updateCatchHungerIfNeeded,
  feedCatch,
};