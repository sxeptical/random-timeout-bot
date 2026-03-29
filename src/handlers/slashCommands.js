import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";
import { logger } from "../utils/logger.js";
import {
  TIMEOUT_MS,
  ROLL_COOLDOWN_MS,
  MAX_ROLL_CHARGES,
  ROLL_BANNED_ROLE,
  REJOIN_INVITE_URL,
  SPIN_ADMIN_ROLE_NAME,
  ONE_WEEK_MS,
  SPIN_DECISION_TIMEOUT_MS,
  BLACKJACK_GAME_TIMEOUT_MS,
} from "../utils/constants.js";
import { isExempt, canTimeout } from "../utils/helpers.js";
import { getDataSafe, getLevelFromXp } from "../../utils.js";
import {
  explodedCounts,
  saveLeaderboardDebounced,
  recordExplosion,
} from "../data/leaderboard.js";
import {
  activeSpinSessions,
  getGuildSpinData,
  saveSpinDataDebounced,
} from "../data/spin.js";
import { scheduleEvent } from "../data/scheduled.js";
import { buildLeaderboardEmbed } from "../commands/leaderboard.js";
import { getRouletteAutocompleteResponse } from "../commands/definitions.js";
import {
  blackjackGames,
  createDeck,
  calculateHand,
  formatHand,
} from "../games/blackjack.js";
import { getRouletteColor, checkRouletteBet } from "../games/roulette.js";

// Roll cooldowns: Map<userId, { lastRoll: timestamp, charges: number }>
const rollCooldowns = new Map();

// Global toggle for /roll cooldown
let rollCooldownEnabled = true;

export async function handleAutocomplete(interaction) {
  if (!interaction.isAutocomplete()) return;

  const focusedOption = interaction.options.getFocused(true);
  if (
    interaction.commandName === "roulette" &&
    focusedOption.name === "space"
  ) {
    const choices = getRouletteAutocompleteResponse(focusedOption.value);
    await interaction.respond(choices);
  }
}

export async function handleSlashCommand(interaction) {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    switch (commandName) {
      case "roll":
        await handleRoll(interaction);
        break;
      case "rollcd":
        await handleRollCd(interaction);
        break;
      case "lb":
        await handleLeaderboard(interaction);
        break;
      case "spin":
        await handleSpin(interaction);
        break;
      case "blackjack":
        await handleBlackjack(interaction);
        break;
      case "xp":
        await handleXp(interaction);
        break;
      case "roulette":
        await handleRoulette(interaction);
        break;
    }
  } catch (err) {
    logger.error(`Error in /${commandName} command:`, err);
    await sendErrorResponse(interaction);
  }
}

async function sendErrorResponse(interaction) {
  try {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "⚠️ An error occurred!",
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.followUp({
        content: "⚠️ An error occurred!",
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (e) {
    logger.error("Failed to send error message:", e);
  }
}

async function handleRoll(interaction) {
  // XP Gain Logic: Award XP on command use
  const userId = interaction.user.id;
  const guildId = interaction.guild?.id ?? "global";
  if (!explodedCounts.has(guildId)) explodedCounts.set(guildId, new Map());
  const guildMap = explodedCounts.get(guildId);
  let userData = getDataSafe(guildMap, userId);
  const xpGain = Math.floor(Math.random() * 31) + 20; // 20 - 50 XP
  userData.xp = (userData.xp || 0) + xpGain;
  // Check Level Up
  const newLevel = getLevelFromXp(userData.xp);
  if (newLevel > userData.level) {
    userData.level = newLevel;
    logger.debug(`[LEVEL UP] User ${userId} reached Level ${newLevel}`);
  }
  guildMap.set(userId, userData);
  try {
    saveLeaderboardDebounced();
  } catch (e) {
    logger.error("Save debounce failed:", e);
  }

  const botMember = interaction.guild.members.me;

  // Check if bot has permissions
  if (!botMember.permissions.has("ModerateMembers")) {
    await interaction.reply({
      content: 'I need the "Moderate Members" permission to use this command!',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check cooldown for /roll command (server owner bypasses cooldown)
  const isOwner = interaction.guild.ownerId === userId;

  // Block banned user from using /roll
  if (ROLL_BANNED_ROLE && interaction.member.roles.cache.has(ROLL_BANNED_ROLE)) {
    await interaction.reply({
      content: "❌ You are banned from using /roll!",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (rollCooldownEnabled && !isOwner) {
    const now = Date.now();
    const userCooldownData = rollCooldowns.get(userId);

    let availableCharges = 0;

    if (userCooldownData) {
      const timeSinceLastRoll = now - userCooldownData.lastRoll;

      // Progressive charge schedule: 1hr, 1.5hr, 2hr, 2.5hr, 3hr...
      // Calculate how many charges should have accumulated
      let chargesGained = 0;
      let cumulativeTime = 0;
      for (let i = 0; i < MAX_ROLL_CHARGES; i++) {
        const timeForThisCharge = 3600000 + i * 1800000; // 1hr + (i * 30min)
        cumulativeTime += timeForThisCharge;
        if (timeSinceLastRoll >= cumulativeTime) {
          chargesGained++;
        } else {
          break;
        }
      }

      availableCharges = Math.min(
        MAX_ROLL_CHARGES,
        userCooldownData.charges + chargesGained,
      );

      logger.debug(
        `[ROLL COOLDOWN] User ${userId}: charges=${userCooldownData.charges}, timeSince=${Math.floor(timeSinceLastRoll / 1000)}s, gained=${chargesGained}, available=${availableCharges}`,
      );
    } else {
      // New user starts with 1 charge
      availableCharges = 1;
      logger.debug(
        `[ROLL COOLDOWN] New user ${userId}: starting with ${availableCharges} charge`,
      );
    }

    logger.debug(
      `[ROLL COOLDOWN] User ${userId} attempting roll with ${availableCharges} charges available`,
    );

    if (availableCharges <= 0) {
      // Calculate time until next charge
      const timeSinceLastRoll = now - userCooldownData.lastRoll;

      // Find the next charge threshold
      let nextChargeThreshold = 0;
      for (let i = 0; i < MAX_ROLL_CHARGES; i++) {
        const timeForThisCharge = 3600000 + i * 1800000; // 1hr + (i * 30min)
        nextChargeThreshold += timeForThisCharge;
        if (timeSinceLastRoll < nextChargeThreshold) {
          // This is the next charge we're waiting for
          const timeUntilNextCharge = nextChargeThreshold - timeSinceLastRoll;
          const minutesRemaining = Math.ceil(timeUntilNextCharge / 60000);
          await interaction.reply({
            content: `⏰ No rolls available! Next roll in ${minutesRemaining} minute(s).`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }

      // Fallback if somehow we got here
      await interaction.reply({
        content: `⏰ No rolls available!`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Consume one charge BEFORE deferReply to prevent race condition
    rollCooldowns.set(userId, {
      lastRoll: now,
      charges: availableCharges - 1,
    });
  }

  // Defer reply after passing all checks
  await interaction.deferReply();

  // Fetch guild members to ensure cache is populated
  try {
    await interaction.guild.members.fetch();
  } catch (e) {
    logger.error("Failed to fetch guild members:", e);
  }

  // Get all non-bot members who aren't exempt
  const eligibleMembers = interaction.guild.members.cache.filter((member) => {
    if (member.user.bot) return false;
    if (isExempt(member)) return false;
    if (!canTimeout(botMember, member)) return false;
    return true;
  });

  logger.debug(
    `[ROLL DEBUG] Total cached members: ${interaction.guild.members.cache.size}, Eligible: ${eligibleMembers.size}`,
  );

  if (eligibleMembers.size === 0) {
    // Refund charge since no one can be exploded
    if (rollCooldownEnabled && !isOwner) {
      const userCooldownData = rollCooldowns.get(userId);
      if (userCooldownData) {
        rollCooldowns.set(userId, {
          lastRoll: userCooldownData.lastRoll,
          charges: Math.min(MAX_ROLL_CHARGES, userCooldownData.charges + 1),
        });
      }
    }
    await interaction.editReply({ content: "No One to explode!" });
    return;
  }

  const diceRoll = Math.floor(Math.random() * 6) + 1; // Roll 1-6

  await interaction.editReply(`🎲 Rolling the dice... 🎲`);
  await new Promise((resolve) => setTimeout(resolve, 1000)); // Suspense!

  await interaction.editReply(`🎲 The dice shows **${diceRoll}**!`);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Calculate timeout duration based on roll: 1 = 10s, 2 = 20s, ... 6 = 60s
  const rollTimeoutMs = diceRoll * TIMEOUT_MS;

  try {
    // Roll 1: Timeout the person who used the command
    if (diceRoll === 1) {
      const commandUser = interaction.member;
      if (!isExempt(commandUser) && canTimeout(botMember, commandUser)) {
        await commandUser.timeout(
          rollTimeoutMs,
          `Rolled a 1 - exploded themselves!`,
        );
        recordExplosion(commandUser);
        await interaction.followUp(
          `💥 Oops! ${commandUser} rolled a **1** and exploded themselves! 😂`,
        );
        logger.debug(
          `[ROLL] ${interaction.user.tag} rolled a 1 and exploded themselves`,
        );
      } else {
        await interaction.followUp(
          `🍀 ${commandUser} got lucky! They rolled a **1** but have immunity!`,
        );
      }
    }
    // Roll 6: Timeout two people
    else if (diceRoll === 6) {
      const eligibleArray = Array.from(eligibleMembers.values());

      if (eligibleArray.length < 2) {
        // Only one person available
        const targetMember = eligibleArray[0];
        await targetMember.timeout(rollTimeoutMs, `Rolled a 6 by /roll command`);
        recordExplosion(targetMember);
        await interaction.followUp(
          `💥💥 ${targetMember} got DOUBLE exploded (Not enough people for 2 timeouts)`,
        );
        logger.debug(
          `[ROLL] ${interaction.user.tag} rolled a 6 and exploded ${targetMember.user.tag}`,
        );
      } else {
        // Pick two different random people
        const firstIndex = Math.floor(Math.random() * eligibleArray.length);
        const firstMember = eligibleArray[firstIndex];

        // Pick second person (different from first)
        let secondIndex;
        do {
          secondIndex = Math.floor(Math.random() * eligibleArray.length);
        } while (secondIndex === firstIndex);
        const secondMember = eligibleArray[secondIndex];

        await firstMember.timeout(
          rollTimeoutMs,
          `Rolled a 6 by /roll command (victim 1)`,
        );
        recordExplosion(firstMember);
        await secondMember.timeout(
          rollTimeoutMs,
          `Rolled a 6 by /roll command (victim 2)`,
        );
        recordExplosion(secondMember);
        await interaction.followUp(
          `💥💥 DOUBLE KILL! ${firstMember} and ${secondMember} both got exploded!`,
        );
        logger.debug(
          `[ROLL] ${interaction.user.tag} rolled a 6 and exploded ${firstMember.user.tag} and ${secondMember.user.tag}`,
        );
      }
    }
    // Rolls 2-5: Timeout one random person
    else {
      const eligibleArray = Array.from(eligibleMembers.values());
      const targetIndex = Math.floor(Math.random() * eligibleArray.length);
      const targetMember = eligibleArray[targetIndex];

      await targetMember.timeout(
        rollTimeoutMs,
        `Rolled a ${diceRoll} by /roll command`,
      );
      recordExplosion(targetMember);
      await interaction.followUp(`💥 ${targetMember} got exploded!`);
      logger.debug(
        `[ROLL] ${interaction.user.tag} rolled a ${diceRoll} and exploded ${targetMember.user.tag})`,
      );
    }

    // 0.0001% (1 in a million) chance to kick someone
    if (Math.random() < 0.000001) {
      const eligibleArray = Array.from(eligibleMembers.values());
      if (eligibleArray.length > 0) {
        const unluckyMember =
          eligibleArray[Math.floor(Math.random() * eligibleArray.length)];
        try {
          await unluckyMember.kick("ULTRA RARE EVENT: 1 in a million roll!");
          await interaction.followUp(
            `🌟✨💀 **ULTRA RARE EVENT!** 🌟✨💀\n${unluckyMember.user.tag} just hit the 1 IN A MILLION chance and got KICKED from the server! 😱`,
          );
          logger.debug(
            `[ULTRA RARE] ${interaction.user.tag} triggered 1 in a million event - kicked ${unluckyMember.user.tag}`,
          );

          // Try to DM them the invite after kicking
          if (REJOIN_INVITE_URL) {
            try {
              await unluckyMember.send(
                `You just hit the 1 IN A MILLION chance in ${interaction.guild.name}! 😱\nHere's the invite to rejoin: ${REJOIN_INVITE_URL}`,
              );
            } catch (dmErr) {
              logger.debug(
                `Couldn't DM ${unluckyMember.user.tag} - they have DMs disabled or left mutual servers`,
              );
            }
          }
        } catch (err) {
          logger.error(`Failed to kick ${unluckyMember.user.tag}:`, err.message);
        }
      }
    }
    // 0.2% chance to send an image and timeout everyone for 15 seconds
    else if (Math.random() < 0.002) {
      await interaction.followUp(
        "https://media.discordapp.net/attachments/1423201741931024396/1442538744941907988/image.jpg?ex=692bbb25&is=692a69a5&hm=2b4933660848107d82e2d15eb2522e12d44d30b849a339a9625b7b306202fd7f&=&format=webp",
      );
      await interaction.followUp(
        `${interaction.user.tag} launched a nuke and exploded everyone!`,
      );

      // Timeout all eligible members for 15 seconds
      const allEligible = interaction.guild.members.cache.filter((member) => {
        if (member.user.bot) return false;
        if (isExempt(member)) return false;
        if (!canTimeout(botMember, member)) return false;
        return true;
      });

      let timeoutCount = 0;
      for (const [, member] of allEligible) {
        try {
          await member.timeout(15000, "Mass timeout event!");
          recordExplosion(member);
          timeoutCount++;
        } catch (err) {
          logger.error(`Failed to timeout ${member.user.tag}:`, err.message);
        }
      }

      if (timeoutCount > 0) {
        await interaction.followUp(`💥💥💥 EVERYONE GOT EXPLODED!💥💥💥`);
      }
    }
  } catch (err) {
    logger.error("Failed to timeout member from /roll:", err.message);
    await interaction.followUp({
      content: `⚠️ Couldn't explode them`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleRollCd(interaction) {
  // Defer reply immediately
  await interaction.deferReply();

  // Only allow server owner or admin to use
  const isOwner = interaction.guild.ownerId === interaction.user.id;
  const isAdmin = interaction.member.permissions.has("Administrator");
  if (!isOwner && !isAdmin) {
    await interaction.editReply({
      content:
        "❌ Only administrators or the server owner can use this command!",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const enabled = interaction.options.getBoolean("enabled");
  rollCooldownEnabled = enabled;
  logger.info(`rollCooldownEnabled set to: ${enabled}`);

  await interaction.editReply({
    content: `/roll cooldown is now **${enabled ? "ENABLED" : "DISABLED"}**.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleLeaderboard(interaction) {
  await interaction.deferReply();
  const page = interaction.options.getInteger("page") ?? 1;
  const lbType = interaction.options.getString("type") ?? "xp";
  const guildId = interaction.guild.id;

  const result = await buildLeaderboardEmbed(
    interaction.guild,
    guildId,
    page,
    lbType,
    interaction.user.id,
  );

  if (result.empty) {
    await interaction.editReply({
      content: "No explosions recorded in this server yet.",
    });
    return;
  }

  await interaction.editReply({
    embeds: [result.embed],
    components: [result.row],
  });
}

async function handleSpin(interaction) {
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const guildData = getGuildSpinData(guildId);

  // Check if this user has already spun this month
  const userAlreadySpun = guildData.users.some((u) => u.id === userId);
  if (userAlreadySpun) {
    await interaction.reply({
      content: `🎰 You've already spun the wheel this month! Wait until next month to spin again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check if 5 people have already spun this month
  const MAX_SPINS_PER_MONTH = 5;
  if (guildData.users.length >= MAX_SPINS_PER_MONTH) {
    await interaction.reply({
      content: `🎰 The wheel has already been spun ${MAX_SPINS_PER_MONTH} times this month! Wait until next month.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  // Spinning animation
  const spinFrames = [
    "🎰 Spinning...",
    "🎰 Spinning..",
    "🎰 Spinning.",
    "🎰 Spinning...",
  ];
  for (let i = 0; i < 4; i++) {
    await interaction.editReply(spinFrames[i % spinFrames.length]);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // 50/50 result
  const won = Math.random() < 0.5;
  const result = won ? "admin" : "timeout";

  // Record the spin
  guildData.users.push({
    id: userId,
    timestamp: Date.now(),
    result: result,
  });
  saveSpinDataDebounced();

  if (won) {
    // Winner gets admin role!
    try {
      // Find or create the spin winner role
      let spinRole = interaction.guild.roles.cache.find(
        (r) => r.name === SPIN_ADMIN_ROLE_NAME,
      );

      if (!spinRole) {
        // Create the role if it doesn't exist
        spinRole = await interaction.guild.roles.create({
          name: SPIN_ADMIN_ROLE_NAME,
          permissions: ["Administrator"],
          reason: "Spin wheel winner role",
        });
        logger.debug(
          `[SPIN] Created "${SPIN_ADMIN_ROLE_NAME}" role in ${interaction.guild.name}`,
        );
      }

      // Give the role to the winner
      await interaction.member.roles.add(
        spinRole,
        "Won the spin wheel for 1 week",
      );

      // Schedule role removal after 1 week (persisted)
      scheduleEvent({
        type: "remove_role",
        guildId: interaction.guild.id,
        userId: userId,
        roleId: spinRole.id,
        executeAt: Date.now() + ONE_WEEK_MS,
        reason: "Spin wheel admin period expired (1 week)",
      });

      // Create double-or-nothing button
      const sessionKey = `${guildId}-${userId}`;
      activeSpinSessions.set(sessionKey, {
        expires: Date.now() + SPIN_DECISION_TIMEOUT_MS,
        stage: 1,
        roleId: spinRole.id,
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`spin_double_${guildId}_${userId}`)
          .setLabel("🎲 Double or Nothing! (2 weeks)")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`spin_keep_${guildId}_${userId}`)
          .setLabel("✅ Keep 1 Week Admin")
          .setStyle(ButtonStyle.Success),
      );

      await interaction.editReply({
        content: `🎉 **WINNER!** 🎉\n\n${interaction.user} won the spin and gets **1 week of Admin**!\n\n🎲 **Double or Nothing?** Spin again for a chance at **2 weeks Admin** - but if you lose, you get **2 weeks timeout** instead!\n\n⏰ You have 60 seconds to decide...`,
        components: [row],
      });

      // Clear the session after 60 seconds
      setTimeout(async () => {
        const session = activeSpinSessions.get(sessionKey);
        if (session && session.stage === 1) {
          activeSpinSessions.delete(sessionKey);
          try {
            await interaction.editReply({
              content: `🎉 **WINNER!** 🎉\n\n${interaction.user} won the spin and gets **1 week of Admin**! (Time expired - keeping 1 week)`,
              components: [],
            });
          } catch (e) {
            // Interaction may have expired
          }
        }
      }, 60000);

      logger.debug(`[SPIN] ${interaction.user.tag} WON - gave 1 week admin`);
    } catch (err) {
      logger.error("[SPIN] Error giving admin role:", err);
      await interaction.editReply({
        content: `🎉 You won! But I couldn't give you the admin role (missing permissions?).`,
      });
    }
  } else {
    // Loser gets 1 week timeout
    try {
      await interaction.member.timeout(
        ONE_WEEK_MS,
        "Lost the spin wheel - 1 week timeout",
      );
      await interaction.editReply({
        content: `💀 **LOST!** 💀\n\n${interaction.user} spun the wheel and lost! Enjoy your **1 week timeout**! 😈`,
      });
      logger.debug(`[SPIN] ${interaction.user.tag} LOST - 1 week timeout`);
    } catch (err) {
      logger.error("[SPIN] Error applying timeout:", err);
      await interaction.editReply({
        content: `💀 You lost! But I couldn't timeout you (you might be immune).`,
      });
    }
  }
}

async function handleBlackjack(interaction) {
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const sessionKey = `${guildId}-${userId}`;
  const betInput = interaction.options.getString("bet").toLowerCase().trim();

  // Check if user already has an active game
  if (blackjackGames.has(sessionKey)) {
    await interaction.reply({
      content: "❌ You already have an active blackjack game! Finish it first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check if user has enough explosions to bet
  const guildMap = explodedCounts.get(guildId) ?? new Map();
  const userData = getDataSafe(guildMap, userId);
  const userExplosions = userData.explosions;

  // Parse bet amount
  let bet;
  if (betInput === "all") {
    bet = userExplosions;
  } else {
    bet = parseInt(betInput);
    if (isNaN(bet) || bet < 1) {
      await interaction.reply({
        content: "❌ Invalid bet! Enter a number or 'all'.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  if (bet === 0 || userExplosions === 0) {
    await interaction.reply({
      content: "❌ You have no explosions to bet!",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (userExplosions < bet) {
    await interaction.reply({
      content: `❌ You don't have enough explosions! You have **${userExplosions}** but tried to bet **${bet}**.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  // Create deck and deal initial cards
  const deck = createDeck();
  const playerHand = [deck.pop(), deck.pop()];
  const dealerHand = [deck.pop(), deck.pop()];

  const playerTotal = calculateHand(playerHand);
  const dealerTotal = calculateHand(dealerHand);

  // Check for natural blackjack
  if (playerTotal === 21) {
    // Player has blackjack!
    const dealerHasBlackjack = dealerTotal === 21;

    if (dealerHasBlackjack) {
      // Push - return bet
      const embed = new EmbedBuilder()
        .setTitle("🃏 Blackjack - Push!")
        .setDescription(`Both have Blackjack! It's a tie.`)
        .addFields(
          {
            name: "Your Hand",
            value: `${formatHand(playerHand)} (${playerTotal})`,
            inline: true,
          },
          {
            name: "Dealer's Hand",
            value: `${formatHand(dealerHand)} (${dealerTotal})`,
            inline: true,
          },
          {
            name: "Result",
            value: `Bet returned: **${bet}** explosions`,
            inline: false,
          },
        )
        .setColor(0xffff00);

      await interaction.editReply({ embeds: [embed], components: [] });
    } else {
      // Player wins 1.5x (blackjack pays 3:2)
      const winnings = Math.floor(bet * 1.5);
      userData.explosions = (userData.explosions || 0) + winnings;
      guildMap.set(userId, userData);
      saveLeaderboardDebounced();

      const embed = new EmbedBuilder()
        .setTitle("🃏 Blackjack - BLACKJACK!")
        .setDescription(`You got a natural Blackjack!`)
        .addFields(
          {
            name: "Your Hand",
            value: `${formatHand(playerHand)} (${playerTotal})`,
            inline: true,
          },
          {
            name: "Dealer's Hand",
            value: `${formatHand(dealerHand)} (${dealerTotal})`,
            inline: true,
          },
          {
            name: "Result",
            value: `You won **${winnings}** explosions! (3:2 payout)`,
            inline: false,
          },
        )
        .setColor(0x00ff00);

      await interaction.editReply({ embeds: [embed], components: [] });
    }
    return;
  }

  // Store game state
  blackjackGames.set(sessionKey, {
    bet,
    playerHand,
    dealerHand,
    deck,
    status: "playing",
  });

  // Create game embed
  const embed = new EmbedBuilder()
    .setTitle("🃏 Blackjack")
    .setDescription(`Bet: **${bet}** explosions`)
    .addFields(
      {
        name: "Your Hand",
        value: `${formatHand(playerHand)} (${playerTotal})`,
        inline: true,
      },
      {
        name: "Dealer's Hand",
        value: `${formatHand(dealerHand, true)}`,
        inline: true,
      },
    )
    .setColor(0x2b2d31)
    .setFooter({
      text: "Hit to draw another card, Stand to end your turn",
    });

  // Create buttons
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bj_hit_${guildId}_${userId}`)
      .setLabel("Hit")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`bj_stand_${guildId}_${userId}`)
      .setLabel("Stand")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });

  // Auto-expire game after 5 minutes
  setTimeout(async () => {
    if (blackjackGames.has(sessionKey)) {
      blackjackGames.delete(sessionKey);
      // Try to notify user the game expired
      try {
        const expiredEmbed = new EmbedBuilder()
          .setTitle("🃏 Blackjack - EXPIRED")
          .setDescription(`Game timed out after 5 minutes of inactivity.`)
          .addFields(
            {
              name: "Your Hand",
              value: `${formatHand(playerHand)} (${playerTotal})`,
              inline: true,
            },
            {
              name: "Dealer's Hand",
              value: `${formatHand(dealerHand, true)}`,
              inline: true,
            },
            {
              name: "Result",
              value: `Bet returned: **${bet}** explosions (no penalty)`,
              inline: false,
            },
          )
          .setColor(0x808080);
        await interaction.editReply({
          embeds: [expiredEmbed],
          components: [],
        });
      } catch (e) {
        // Interaction may have expired, ignore
      }
    }
  }, BLACKJACK_GAME_TIMEOUT_MS);
}

async function handleXp(interaction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const username = interaction.options.getUser("username");
  const action = interaction.options.getString("action");
  const value = interaction.options.getInteger("value");
  const guildId = interaction.guild.id;

  const type = interaction.options.getString("type") || "xp";
  const targetUser = username ?? interaction.user;

  if (!explodedCounts.has(guildId)) explodedCounts.set(guildId, new Map());
  const guildMap = explodedCounts.get(guildId);
  const userData = getDataSafe(guildMap, targetUser.id);

  // Mode: View (No action provided)
  if (!action) {
    if (type === "explosions") {
      await interaction.reply({
        content: `**${targetUser.username}** has **${userData.explosions.toLocaleString()} explosions**.`,
      });
    } else {
      await interaction.reply({
        content: `**${targetUser.username}** has **${userData.xp.toLocaleString()} XP** (Level ${userData.level}).`,
      });
    }
    return;
  }

  // Mode: Edit (Action provided)
  // Permission check
  if (
    !interaction.member.permissions.has("Administrator") &&
    interaction.user.id !== interaction.guild.ownerId
  ) {
    await interaction.reply({
      content: "You do not have permission to manage stats.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const valToCheck = type === "explosions" ? userData.explosions : userData.xp;

  if (value === null) {
    await interaction.reply({
      content: "You must provide a value when performing an action.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let newValue = valToCheck;
  let actionText = "";

  if (action === "add") {
    newValue = valToCheck + value;
    actionText = "added to";
  } else if (action === "remove") {
    newValue = Math.max(0, valToCheck - value);
    actionText = "removed from";
  } else if (action === "set") {
    newValue = Math.max(0, value);
    actionText = "set for";
  }

  if (type === "explosions") {
    userData.explosions = newValue;
  } else {
    userData.xp = newValue;
    userData.level = getLevelFromXp(newValue);
  }

  guildMap.set(targetUser.id, userData);
  saveLeaderboardDebounced();

  // Create a summary embed
  const embed = new EmbedBuilder()
    .setTitle("Explosions Update")
    .setDescription(
      `Successfully ${actionText} **${targetUser.username}**'s ${type}.\n\n**New ${type}:** ${newValue}`,
    )
    .setColor(0x00ff00)
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

async function handleRoulette(interaction) {
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const betInput = interaction.options.getString("bet").toLowerCase().trim();
  const bettingSpace = interaction.options.getString("space").toLowerCase();

  if (!explodedCounts.has(guildId)) explodedCounts.set(guildId, new Map());
  const guildMap = explodedCounts.get(guildId);
  const userData = getDataSafe(guildMap, userId);
  const userExplosions = userData.explosions;

  // Parse bet amount
  let bet;
  if (betInput === "all") {
    bet = userExplosions;
  } else {
    bet = parseInt(betInput);
    if (isNaN(bet) || bet < 1) {
      await interaction.reply({
        content: "❌ Invalid bet! Enter a number or 'all'.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  if (bet === 0 || userExplosions === 0) {
    await interaction.reply({
      content: "❌ You have no explosions to bet!",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (userExplosions < bet) {
    await interaction.reply({
      content: `❌ You don't have enough explosions! You have **${userExplosions}** but tried to bet **${bet}**.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  // Spin the wheel (0-36)
  const number = Math.floor(Math.random() * 37);
  const { color, emoji: colorEmoji } = getRouletteColor(number);
  const betResult = checkRouletteBet(bettingSpace, number, color);

  if (!betResult.valid) {
    await interaction.editReply({
      content: `❌ Invalid betting space: "${bettingSpace}". Valid options: red, black, even, odd, 1-18, 19-36, 1-12, 13-24, 25-36, 0, or any number 1-36.`,
    });
    return;
  }

  let resultTitle, resultDesc, resultColor;

  if (betResult.won) {
    const winnings = bet * betResult.multiplier;
    userData.explosions = (userData.explosions || 0) + winnings;
    guildMap.set(userId, userData);

    resultTitle = "🎰 Roulette - WIN!";
    resultDesc = `The ball landed on **${number}** ${colorEmoji}!`;
    resultColor = 0x00ff00;

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(resultTitle)
          .setDescription(resultDesc)
          .addFields(
            {
              name: "Your Bet",
              value: `${bet} on ${bettingSpace}`,
              inline: true,
            },
            {
              name: "Result",
              value: `You won **${winnings}** explosions!`,
              inline: true,
            },
          )
          .setColor(resultColor),
      ],
    });
  } else {
    // Lost
    userData.explosions = Math.max(0, (userData.explosions || 0) - bet);
    guildMap.set(userId, userData);

    resultTitle = "🎰 Roulette - LOSE";
    resultDesc = `The ball landed on **${number}** ${colorEmoji}!`;
    resultColor = 0xff0000;

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(resultTitle)
          .setDescription(resultDesc)
          .addFields(
            {
              name: "Your Bet",
              value: `${bet} on ${bettingSpace}`,
              inline: true,
            },
            {
              name: "Result",
              value: `You lost **${bet}** explosions.`,
              inline: true,
            },
          )
          .setColor(resultColor),
      ],
    });
  }

  saveLeaderboardDebounced();
}
