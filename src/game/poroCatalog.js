/**
 * poroCatalog.js
 * Loads poro definitions and provides:
 * - pickRandomPoro(): weighted selection based on "weight"
 * - getPoroById(): find poro for spawns/catches/showcase
 */

const fs = require("fs");
const path = require("path");

const PORO_DATA_PATH = path.join(__dirname, "..", "data", "poros.json");

function loadPoros() {
  const raw = fs.readFileSync(PORO_DATA_PATH, "utf-8");
  const poros = JSON.parse(raw);

  if (!Array.isArray(poros) || poros.length === 0) {
    throw new Error("poros.json must be a non-empty array.");
  }

  // Minimal validation so failures are obvious early
  for (const p of poros) {
    if (!p.id || !p.name || !p.rarity) throw new Error("poro entry missing id/name/rarity");
    if (typeof p.weight !== "number") throw new Error(`poro ${p.id} missing numeric weight`);
    if (typeof p.baseCatch !== "number") throw new Error(`poro ${p.id} missing numeric baseCatch`);
  }

  return poros;
}

function weightedPick(items) {
  const total = items.reduce((sum, item) => sum + (item.weight || 0), 0);
  if (total <= 0) return items[Math.floor(Math.random() * items.length)];

  let roll = Math.random() * total;
  for (const item of items) {
    roll -= item.weight || 0;
    if (roll <= 0) return item;
  }

  return items[items.length - 1];
}

function pickRandomPoro() {
  const poros = loadPoros();
  return weightedPick(poros);
}

function getPoroById(id) {
  const poros = loadPoros();
  return poros.find((p) => p.id === id) || null;
}

module.exports = { loadPoros, pickRandomPoro, getPoroById };