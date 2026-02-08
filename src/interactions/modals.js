/**
 * modals.js
 * Handles modal submissions.
 * We'll use a modal to collect a nickname after a successful catch.
 */

const db = require("../db");

async function handleModal(interaction) {
  if (!interaction.isModalSubmit()) return;

  // Custom IDs look like: "poro_name_modal:<catchId>"
  if (!interaction.customId.startsWith("poro_name_modal:")) return;

  const catchId = Number(interaction.customId.split(":")[1]);
  if (!Number.isFinite(catchId)) {
    return interaction.reply({ content: "Invalid catch ID.", ephemeral: true });
  }

  const nickname = interaction.fields.getTextInputValue("nickname").trim();

  // Basic nickname rules (adjust later if you want)
  if (nickname.length === 0) {
    return interaction.reply({ content: "Nickname can’t be empty.", ephemeral: true });
  }
  if (nickname.length > 24) {
    return interaction.reply({ content: "Nickname must be 24 characters or fewer.", ephemeral: true });
  }

  // Verify ownership: user can only rename their own catch in this guild
  const row = db.prepare(`
    SELECT id FROM user_catches
    WHERE id = ? AND guild_id = ? AND user_id = ?
  `).get(catchId, interaction.guildId, interaction.user.id);

  if (!row) {
    return interaction.reply({ content: "Could not find that catch (or it isn't yours).", ephemeral: true });
  }

  // Update nickname
  db.prepare(`
    UPDATE user_catches
    SET nickname = ?
    WHERE id = ?
  `).run(nickname, catchId);

  return interaction.reply({ content: `✅ Nickname saved: **${nickname}**`, ephemeral: true });
}

module.exports = { handleModal };