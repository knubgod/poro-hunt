/**
 * titles.js
 * Title system:
 * - titles unlock at certain levels
 * - you automatically get the best title you qualify for
 */

const TITLES = [
  { level: 1, title: "Poro Curious" },
  { level: 3, title: "Snack Scout" },
  { level: 5, title: "Fluff Wrangler" },
  { level: 8, title: "Poro Handler" },
  { level: 12, title: "Freljord Friend" },
  { level: 16, title: "Whisker Watcher" },
  { level: 20, title: "Poro Warden" },
  { level: 25, title: "Legend of the Herd" },
];

function getUnlockedTitle(level) {
  // Highest title whose required level <= current level
  let best = TITLES[0].title;
  for (const t of TITLES) {
    if (level >= t.level) best = t.title;
  }
  return best;
}

module.exports = { TITLES, getUnlockedTitle };