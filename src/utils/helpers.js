import { logger } from "./logger.js";

// Helper: is user exempt from timeout
export function isExempt(member) {
  if (!member) return true;
  // exempt bots
  if (member.user?.bot) return true;
  // exempt administrators (can't be timed out anyway)
  if (member.permissions?.has("Administrator")) return true;
  // exempt server owner
  if (member.guild.ownerId === member.id) return true;
  // exempt users who are currently timed out (immunity until untimedout)
  if (
    member.communicationDisabledUntil &&
    member.communicationDisabledUntil > new Date()
  )
    return true;
  // exempt certain roles by name - edit or expand
  const exemptRoleNames = ["Moderator", "Admin", "NoTimeout"];
  for (const r of exemptRoleNames)
    if (member.roles.cache.some((role) => role.name === r)) return true;
  return false;
}

// Helper: check if bot can timeout this member
export function canTimeout(botMember, targetMember) {
  if (!botMember || !targetMember) return false;

  // Check if bot has Moderate Members permission
  if (!botMember.permissions.has("ModerateMembers")) {
    return false;
  }

  return true;
}

// Helper function to safely update an interaction, handling expired tokens
export async function safeInteractionUpdate(interaction, options) {
  try {
    await interaction.update(options);
    return true;
  } catch (err) {
    // Error code 10062 = Unknown interaction (token expired)
    if (err.code === 10062) {
      logger.debug("Interaction token expired, attempting to edit message directly");
      try {
        // Try to edit the message directly instead
        await interaction.message.edit(options);
        return true;
      } catch (editErr) {
        logger.warn("Failed to edit message directly:", editErr.message);
        return false;
      }
    }
    throw err; // Re-throw other errors
  }
}

// Helper: Get current month string (YYYY-MM)
export function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
