/**
 * db.js
 * Schema + migrations
 */

const Database = require("better-sqlite3");
const db = new Database("poro.sqlite");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,

    xp INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 1,
    poros_caught INTEGER NOT NULL DEFAULT 0,
    last_catch_ts INTEGER NOT NULL DEFAULT 0,

    title TEXT,

    gold INTEGER NOT NULL DEFAULT 0,

    berries INTEGER NOT NULL DEFAULT 0,
    nets INTEGER NOT NULL DEFAULT 0,
    food INTEGER NOT NULL DEFAULT 0,

    nets_armed INTEGER NOT NULL DEFAULT 0,
    last_free_food_ts INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS config (
    guild_id TEXT PRIMARY KEY,
    game_channel_id TEXT,
    showcase_channel_id TEXT,
    last_weekly_showcase_ts INTEGER
  );

  CREATE TABLE IF NOT EXISTS spawns (
    guild_id TEXT PRIMARY KEY,
    message_id TEXT,
    channel_id TEXT,
    spawn_ts INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,

    poro_id TEXT,
    spawn_size INTEGER,
    spawn_weight INTEGER,
    spawn_throw_distance INTEGER,
    spawn_fluffiness INTEGER,
    spawn_hunger INTEGER
  );

  CREATE TABLE IF NOT EXISTS spawn_attempts (
    guild_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    attempt_ts INTEGER NOT NULL,
    PRIMARY KEY (guild_id, message_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS user_poros (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    poro_id TEXT NOT NULL,
    caught_count INTEGER NOT NULL DEFAULT 0,
    first_caught_ts INTEGER NOT NULL,
    last_catch_ts INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id, poro_id)
  );

  CREATE TABLE IF NOT EXISTS user_catches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    poro_id TEXT NOT NULL,
    caught_ts INTEGER NOT NULL,

    size INTEGER NOT NULL,
    weight INTEGER NOT NULL,
    throw_distance INTEGER NOT NULL,
    fluffiness INTEGER NOT NULL,
    hunger INTEGER NOT NULL,

    nickname TEXT,
    hunger_updated_ts INTEGER
  );

  CREATE TABLE IF NOT EXISTS net_stash (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    poro_id TEXT NOT NULL,
    caught_ts INTEGER NOT NULL,

    size INTEGER NOT NULL,
    weight INTEGER NOT NULL,
    throw_distance INTEGER NOT NULL,
    fluffiness INTEGER NOT NULL,
    hunger INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS spawn_berry (
    guild_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    used_ts INTEGER NOT NULL,
    PRIMARY KEY (guild_id, message_id, user_id)
  );
`);

function tryAddColumn(sql) {
  try { db.prepare(sql).run(); } catch {}
}

// migrations (safe if columns already exist)
tryAddColumn("ALTER TABLE users ADD COLUMN title TEXT");
tryAddColumn("ALTER TABLE users ADD COLUMN gold INTEGER NOT NULL DEFAULT 0");
tryAddColumn("ALTER TABLE users ADD COLUMN berries INTEGER NOT NULL DEFAULT 0");
tryAddColumn("ALTER TABLE users ADD COLUMN nets INTEGER NOT NULL DEFAULT 0");
tryAddColumn("ALTER TABLE users ADD COLUMN food INTEGER NOT NULL DEFAULT 0");
tryAddColumn("ALTER TABLE users ADD COLUMN nets_armed INTEGER NOT NULL DEFAULT 0");
tryAddColumn("ALTER TABLE users ADD COLUMN last_free_food_ts INTEGER NOT NULL DEFAULT 0");
tryAddColumn("ALTER TABLE user_catches ADD COLUMN hunger_updated_ts INTEGER");

module.exports = db;