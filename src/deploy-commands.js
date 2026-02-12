/**
 * deploy-commands.js
 * Registers slash commands (GLOBAL).
 * Optional: clears old GUILD commands to prevent duplicates.
 *
 * Usage:
 *  - Global only:
 *      npm run deploy
 *
 *  - Global + clear guild commands:
 *      set CLEAR_GUILDS=1 (Windows PowerShell: $env:CLEAR_GUILDS="1")
 *      and set GUILD_IDS="id1,id2,id3" in .env
 *
 * Notes:
 * - Global command updates can take a few minutes (sometimes longer) to appear.
 * - Guild command deletion is immediate and removes duplicates right away.
 */

require("dotenv").config();
const { REST, Routes } = require("discord.js");

// Load commands after dotenv
const poroCommand = require("./commands/poro");
const commands = [poroCommand.data.toJSON()];

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

if (!clientId) throw new Error("Missing CLIENT_ID in .env");
if (!token) throw new Error("Missing DISCORD_TOKEN in .env");

const rest = new REST({ version: "10" }).setToken(token);

function parseGuildIds() {
  const raw = process.env.GUILD_IDS || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function clearGuildCommands(guildId) {
  // Setting body: [] replaces the guild command list with nothing (deletes them)
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
  console.log(`🧹 Cleared guild commands for ${guildId}`);
}

(async () => {
  try {
    console.log("🌍 Registering GLOBAL slash commands...");
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("✅ Global slash commands registered.");

    const shouldClear = String(process.env.CLEAR_GUILDS || "").toLowerCase() === "1" ||
      String(process.env.CLEAR_GUILDS || "").toLowerCase() === "true";

    if (shouldClear) {
      const guildIds = parseGuildIds();
      if (!guildIds.length) {
        console.log("⚠️ CLEAR_GUILDS is enabled but GUILD_IDS is empty. Skipping guild cleanup.");
      } else {
        console.log("🧽 Clearing old GUILD commands to prevent duplicates...");
        for (const gid of guildIds) {
          await clearGuildCommands(gid);
        }
        console.log("✅ Guild command cleanup complete.");
      }
    } else {
      console.log("ℹ️ Skipping guild cleanup (set CLEAR_GUILDS=1 and GUILD_IDS to remove duplicates immediately).");
    }
  } catch (err) {
    console.error("❌ Failed to register commands:");
    console.error(err);
    process.exitCode = 1;
  }
})();