/**
 * deploy-commands.js
 * Registers slash commands to your test server (guild).
 * Run this whenever you change command definitions.
 */

require("dotenv").config();
const { Routes } = require("discord.js");

rest.put(
  Routes.applicationCommands(CLIENT_ID),
  { body: commands }
);

const poroCommand = require("./commands/poro");

const commands = [poroCommand.data.toJSON()];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Registering slash commands...");

    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );

    console.log("✅ Slash commands registered.");
  } catch (err) {
    console.error(err);
  }
})();