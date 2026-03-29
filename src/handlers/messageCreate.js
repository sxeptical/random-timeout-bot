import { logger } from "../utils/logger.js";
import {
  WATCH_CHANNELS,
  TIMEOUT_MS,
  CHANCE,
  COOLDOWN_MS,
  ROLL_BANNED_ROLE,
  HIGH_CHANCE_ROLES,
} from "../utils/constants.js";
import { isExempt, canTimeout } from "../utils/helpers.js";
import { recordExplosion } from "../data/leaderboard.js";

// per-user cooldown map
const cooldowns = new Map();

export async function handleMessageCreate(message) {
  try {
    if (message.author.bot) return;
    if (!message.guild) return; // ignore DMs

    // watch only configured channels if set
    if (
      WATCH_CHANNELS &&
      WATCH_CHANNELS.length &&
      !WATCH_CHANNELS.includes(message.channel.id)
    )
      return;

    const member = message.member;
    if (!member) return;

    if (isExempt(member)) return;

    // Get bot member to check permissions
    const botMember = message.guild.members.me;

    // Debug logging
    logger.debug(`Attempting timeout for ${member.user.tag}`);
    logger.debug(
      `   Bot's highest role: ${botMember.roles.highest.name} (position: ${botMember.roles.highest.position})`,
    );
    logger.debug(
      `   Target's highest role: ${member.roles.highest.name} (position: ${member.roles.highest.position})`,
    );
    logger.debug(
      `   Bot has ModerateMembers: ${botMember.permissions.has("ModerateMembers")}`,
    );
    logger.debug(
      `   Bot has Administrator: ${botMember.permissions.has("Administrator")}`,
    );
    logger.debug(`Target is owner: ${member.guild.ownerId === member.id}`);

    if (!canTimeout(botMember, member)) {
      logger.debug(`Cannot timeout: insufficient permissions`);
      return;
    }

    // cooldown check
    const last = cooldowns.get(member.id) ?? 0;
    if (Date.now() - last < COOLDOWN_MS) return;

    // Get timeout chance (check if member has a high-chance role)
    let timeoutChance = CHANCE;

    // Triple explosion chance for banned role
    if (ROLL_BANNED_ROLE && member.roles.cache.has(ROLL_BANNED_ROLE)) {
      timeoutChance = Math.min(1, CHANCE * 3); // Triple chance, cap at 100%
      logger.debug(
        `   Banned role detected: tripled chance to ${(timeoutChance * 100).toFixed(1)}%`,
      );
    }

    for (const [roleIdentifier, chance] of HIGH_CHANCE_ROLES) {
      // Check by both role name and role ID
      if (
        member.roles.cache.some(
          (role) => role.name === roleIdentifier || role.id === roleIdentifier,
        )
      ) {
        timeoutChance = Math.max(timeoutChance, chance); // Use highest chance if multiple roles
        logger.debug(
          `   Higher chance detected (${roleIdentifier}): ${(chance * 100).toFixed(1)}%`,
        );
        break;
      }
    }

    // chance roll
    if (Math.random() >= timeoutChance) return;

    // apply timeout
    const durSeconds = Math.round(TIMEOUT_MS / 1000);
    try {
      // requires "Moderate Members" permission for the bot and that bot's role is above target
      await member.timeout(TIMEOUT_MS, "Random timeout");
      // record explosion for leaderboard
      recordExplosion(member);
      cooldowns.set(member.id, Date.now());
      // reply with ephemeral-ish fun message (public)
      await message.channel.send(`${member}, Boom! `);
      logger.debug(
        `Timed out ${member.user.tag} for ${durSeconds}s in ${message.guild.name}/${message.channel.name}`,
      );
    } catch (err) {
      logger.error("Failed to timeout member:", err.message);
      // Don't send error message in channel to avoid spam
    }
  } catch (err) {
    logger.error(err);
  }
}
