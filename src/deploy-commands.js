/**
 * deploy-commands.js
 * Registers slash commands (GLOBAL).
 *
 * Run this whenever you change command definitions.
 * NOTE: Global command updates can take a few minutes (sometimes longer) to appear.
 */

require("dotenv").config();

const { REST, Routes } = require("discord.js");

// Load commands AFTER dotenv so env vars exist
const poroCommand = require("./commands/poro");

// Convert command builders to raw JSON payload for Discord API
const commands = [poroCommand.data.toJSON()];

// Create REST client using your bot token
const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    const clientId = process.env.CLIENT_ID;
    if (!clientId) {
      throw new Error("Missing CLIENT_ID in .env");
    }
    if (!process.env.DISCORD_TOKEN) {
      throw new Error("Missing DISCORD_TOKEN in .env");
    }

    console.log("Registering GLOBAL slash commands...");

    // GLOBAL deploy (no guild ID)
    await rest.put(Routes.applicationCommands(clientId), { body: commands });

    console.log("✅ Global slash commands registered.");
  } catch (err) {
    console.error("❌ Failed to register commands:");
    console.error(err);
    process.exitCode = 1;
  }
})();