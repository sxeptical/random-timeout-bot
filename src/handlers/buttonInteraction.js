import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";
import { logger } from "../utils/logger.js";
import {
  SPIN_ADMIN_ROLE_NAME,
  TWO_WEEKS_MS,
  DOUBLE_OR_NOTHING_DELAY_MS,
} from "../utils/constants.js";
import { safeInteractionUpdate } from "../utils/helpers.js";
import { getDataSafe } from "../../utils.js";
import { explodedCounts, saveLeaderboardDebounced } from "../data/leaderboard.js";
import {
  activeSpinSessions,
} from "../data/spin.js";
import {
  scheduledEvents,
  scheduleEvent,
  cancelScheduledEvent,
} from "../data/scheduled.js";
import { buildLeaderboardEmbed } from "../commands/leaderboard.js";
import {
  blackjackGames,
  calculateHand,
  formatHand,
  handleDealerTurn,
} from "../games/blackjack.js";

export async function handleButtonInteraction(interaction) {
  if (!interaction.isButton()) return;

  // Handle leaderboard pagination buttons
  if (
    interaction.customId.startsWith("lb_prev_") ||
    interaction.customId.startsWith("lb_next_")
  ) {
    await handleLeaderboardPagination(interaction);
    return;
  }

  // Handle blackjack buttons
  if (
    interaction.customId.startsWith("bj_hit_") ||
    interaction.customId.startsWith("bj_stand_")
  ) {
    await handleBlackjackButton(interaction);
    return;
  }

  // Handle spin buttons
  if (
    interaction.customId.startsWith("spin_double_") ||
    interaction.customId.startsWith("spin_keep_")
  ) {
    await handleSpinButton(interaction);
    return;
  }
}

async function handleLeaderboardPagination(interaction) {
  try {
    const parts = interaction.customId.split("_");
    const direction = parts[1]; // "prev" or "next"
    const guildId = parts[2];
    const currentPage = parseInt(parts[3]);
    const lbType = parts[4] || "xp"; // Get type from button, default to xp

    const newPage = direction === "next" ? currentPage + 1 : currentPage - 1;

    const result = await buildLeaderboardEmbed(
      interaction.guild,
      guildId,
      newPage,
      lbType,
      interaction.user.id,
    );

    if (result.empty) {
      // Should not happen on pagination, but handle gracefully
      await interaction.update({
        content: "No data available.",
        embeds: [],
        components: [],
      });
      return;
    }

    await interaction.update({
      embeds: [result.embed],
      components: [result.row],
    });
  } catch (err) {
    logger.error("Error handling leaderboard pagination:", err);
  }
}

async function handleBlackjackButton(interaction) {
  try {
    const parts = interaction.customId.split("_");
    const action = parts[1]; // "hit" or "stand"
    const guildId = parts[2];
    const targetUserId = parts[3];
    const sessionKey = `${guildId}-${targetUserId}`;

    // Only the original user can click the button
    if (interaction.user.id !== targetUserId) {
      await interaction.reply({
        content: "❌ This isn't your game!",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const game = blackjackGames.get(sessionKey);
    if (!game) {
      await interaction.reply({
        content: "❌ This game has expired! Start a new one with /blackjack",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildMap = explodedCounts.get(guildId) ?? new Map();
    let userData = getDataSafe(guildMap, targetUserId);
    const userExplosions = userData.explosions;

    if (action === "hit") {
      // Draw a card
      game.playerHand.push(game.deck.pop());
      const playerTotal = calculateHand(game.playerHand);

      if (playerTotal > 21) {
        // Player busted!
        blackjackGames.delete(sessionKey);
        userData.explosions = Math.max(0, userExplosions - game.bet);
        guildMap.set(targetUserId, userData);
        if (!explodedCounts.has(guildId)) explodedCounts.set(guildId, guildMap);
        saveLeaderboardDebounced();

        const embed = new EmbedBuilder()
          .setTitle("🃏 Blackjack - BUST!")
          .setDescription(`You went over 21!`)
          .addFields(
            {
              name: "Your Hand",
              value: `${formatHand(game.playerHand)} (${playerTotal})`,
              inline: true,
            },
            {
              name: "Dealer's Hand",
              value: `${formatHand(game.dealerHand)} (${calculateHand(game.dealerHand)})`,
              inline: true,
            },
            {
              name: "Result",
              value: `You lost **${game.bet}** explosions!`,
              inline: false,
            },
          )
          .setColor(0xff0000);

        await safeInteractionUpdate(interaction, {
          embeds: [embed],
          components: [],
        });
      } else if (playerTotal === 21) {
        // Player has 21, auto-stand
        await handleDealerTurn(
          interaction,
          game,
          guildMap,
          targetUserId,
          guildId,
          sessionKey,
        );
      } else {
        // Continue playing
        const embed = new EmbedBuilder()
          .setTitle("🃏 Blackjack")
          .setDescription(`Bet: **${game.bet}** explosions`)
          .addFields(
            {
              name: "Your Hand",
              value: `${formatHand(game.playerHand)} (${playerTotal})`,
              inline: true,
            },
            {
              name: "Dealer's Hand",
              value: `${formatHand(game.dealerHand, true)}`,
              inline: true,
            },
          )
          .setColor(0x2b2d31)
          .setFooter({
            text: "Hit to draw another card, Stand to end your turn",
          });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`bj_hit_${guildId}_${targetUserId}`)
            .setLabel("Hit")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`bj_stand_${guildId}_${targetUserId}`)
            .setLabel("Stand")
            .setStyle(ButtonStyle.Secondary),
        );

        await safeInteractionUpdate(interaction, {
          embeds: [embed],
          components: [row],
        });
      }
    } else if (action === "stand") {
      await handleDealerTurn(
        interaction,
        game,
        guildMap,
        targetUserId,
        guildId,
        sessionKey,
      );
    }
  } catch (err) {
    // Don't log "Unknown interaction" errors as they're expected when tokens expire
    if (err.code !== 10062) {
      logger.error("Error handling blackjack buttons:", err);
    } else {
      logger.debug(
        `Blackjack interaction expired for user ${interaction.user?.tag || "unknown"}`,
      );
    }
  }
}

async function handleSpinButton(interaction) {
  const parts = interaction.customId.split("_");
  const action = parts[1]; // "double" or "keep"
  const guildId = parts[2];
  const targetUserId = parts[3];

  // Only the original user can click the button
  if (interaction.user.id !== targetUserId) {
    await interaction.reply({
      content: "❌ This isn't your spin!",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sessionKey = `${guildId}-${targetUserId}`;
  const session = activeSpinSessions.get(sessionKey);

  if (!session || session.stage !== 1) {
    await interaction.reply({
      content: "❌ This spin session has expired!",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Mark session as used
  activeSpinSessions.delete(sessionKey);

  if (action === "keep") {
    // User chose to keep 1 week admin
    await interaction.update({
      content: `🎉 **WINNER!** 🎉\n\n${interaction.user} chose to keep their **1 week of Admin**! Smart choice! 🧠`,
      components: [],
    });
    logger.debug(`[SPIN] ${interaction.user.tag} chose to keep 1 week admin`);
  } else if (action === "double") {
    // User chose double or nothing - 50/50 again!
    await interaction.update({
      content: `🎲 **DOUBLE OR NOTHING!** 🎲\n\n${interaction.user} is gambling it all...`,
      components: [],
    });

    await new Promise((resolve) =>
      setTimeout(resolve, DOUBLE_OR_NOTHING_DELAY_MS),
    );

    const doubleWon = Math.random() < 0.5;

    if (doubleWon) {
      // Won double - extend to 2 weeks admin
      try {
        // Find the spin role
        const spinRole = interaction.guild.roles.cache.find(
          (r) => r.name === SPIN_ADMIN_ROLE_NAME,
        );

        if (spinRole) {
          // Cancel any existing 1-week scheduled removal for this user/role
          const existingEvent = scheduledEvents.find(
            (e) =>
              e.type === "remove_role" &&
              e.guildId === guildId &&
              e.userId === targetUserId &&
              e.roleId === spinRole.id,
          );
          if (existingEvent) {
            cancelScheduledEvent(existingEvent.id);
          }

          // Schedule 2-week removal instead
          scheduleEvent({
            type: "remove_role",
            guildId: guildId,
            userId: targetUserId,
            roleId: spinRole.id,
            executeAt: Date.now() + TWO_WEEKS_MS,
            reason: "Spin wheel admin period expired (2 weeks)",
          });
        }

        await interaction.editReply({
          content: `🎉🎉 **JACKPOT!** 🎉🎉\n\n${interaction.user} went double or nothing and **WON**! They now have **2 WEEKS of Admin**! 🏆`,
        });
        logger.debug(
          `[SPIN] ${interaction.user.tag} WON double or nothing - 2 weeks admin`,
        );
      } catch (err) {
        logger.error("[SPIN] Error extending admin:", err);
      }
    } else {
      // Lost double - remove admin and apply 2 week timeout
      try {
        const spinRole = interaction.guild.roles.cache.find(
          (r) => r.name === SPIN_ADMIN_ROLE_NAME,
        );

        if (spinRole) {
          // Cancel any existing scheduled removal since we're removing the role now
          const existingEvent = scheduledEvents.find(
            (e) =>
              e.type === "remove_role" &&
              e.guildId === guildId &&
              e.userId === targetUserId &&
              e.roleId === spinRole.id,
          );
          if (existingEvent) {
            cancelScheduledEvent(existingEvent.id);
          }

          if (interaction.member.roles.cache.has(spinRole.id)) {
            await interaction.member.roles.remove(
              spinRole,
              "Lost double or nothing",
            );
          }
        }

        await interaction.member.timeout(
          TWO_WEEKS_MS,
          "Lost double or nothing - 2 week timeout",
        );

        await interaction.editReply({
          content: `💀💀 **BUSTED!** 💀💀\n\n${interaction.user} went double or nothing and **LOST EVERYTHING**! Enjoy your **2 WEEKS TIMEOUT**! 😈😈`,
        });
        logger.debug(
          `[SPIN] ${interaction.user.tag} LOST double or nothing - 2 weeks timeout`,
        );
      } catch (err) {
        logger.error("[SPIN] Error applying double loss:", err);
        await interaction.editReply({
          content: `💀 You lost double or nothing! But I couldn't timeout you (you might be immune).`,
        });
      }
    }
  }
}
