/**
 * poroLogic.js
 * Game math: leveling, rolls, and XP rewards.
 */

function xpNeededForLevel(level) {
  return 100 + (level - 1) * 50;
}

function rollCatch(chance) {
  return Math.random() < chance;
}

/**
 * Base XP:
 * - success gives decent XP
 * - failure gives small XP so play always progresses
 * Then we add poro-specific xpBonus from poros.json
 */
function getXpReward(success, xpBonus) {
  const base = success ? 25 : 5;
  return base + (xpBonus || 0);
}

module.exports = {
  xpNeededForLevel,
  rollCatch,
  getXpReward,
};