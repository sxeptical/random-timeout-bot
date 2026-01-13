console.log("Starting bot...");
import "dotenv/config";
import { getLevelFromXp, getXpForLevel, getDataSafe } from "./utils.js";
console.log("dotenv loaded");
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  Collection,
  REST,
  Routes,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
console.log("discord.js imported");
import fs from "fs";
import path from "path";

const TOKEN = process.env.DISCORD_TOKEN;
console.log("TOKEN exists:", !!TOKEN);
if (!TOKEN) throw new Error("DISCORD_TOKEN missing in .env");

const WATCH_CHANNELS = process.env.CHANNEL_ALLOW
  ? process.env.CHANNEL_ALLOW.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : null;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 10000);
const CHANCE = Number(process.env.CHANCE ?? 0.05);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 30000);
const ROLL_COOLDOWN_MS = 3600000; // 1 hour cooldown for /roll command
const MAX_ROLL_CHARGES = 3; // Maximum stacked roll charges
const ROLL_BANNED_ROLE = "1444727845065588837"; // Role banned from /roll with tripled explosion chance

// Parse high chance roles (format: RoleNameOrID:0.5,AnotherRoleOrID:0.75)
// Supports both role names and role IDs
const HIGH_CHANCE_ROLES = new Map();
if (process.env.HIGH_CHANCE_ROLES) {
  process.env.HIGH_CHANCE_ROLES.split(",").forEach((pair) => {
    const [roleIdentifier, chance] = pair.split(":").map((s) => s.trim());
    if (roleIdentifier && chance) {
      HIGH_CHANCE_ROLES.set(roleIdentifier, Number(chance));
    }
  });
}

// Create client with message content intent
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

// per-user cooldown maps
const cooldowns = new Map();
// rollCooldowns now stores { lastRoll: timestamp, charges: number }
const rollCooldowns = new Map();

// Global toggle for /roll cooldown
let rollCooldownEnabled = true;

// Explosion leaderboard (in-memory), scoped per guild: Map<guildId, Map<userId, count>>
const explodedCounts = new Map();

// ---- Persistence: JSON file storage ----
const DATA_DIR = path.join(process.cwd(), "data");
const LB_FILE = path.join(DATA_DIR, "leaderboard.json");
const SAVE_DEBOUNCE_MS = 2000; // debounce writes
let _saveTimer = null;
let _spinSaveTimer = null;

// Spin Wheel Constants
const SPIN_FILE = path.join(DATA_DIR, "spin.json");
const SPIN_ADMIN_ROLE_NAME = "Spin Winner"; // Role name for spin winners
const MAX_SPINS_PER_MONTH = 5; // Max 5 people can spin per month
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

// Spin data: Map<guildId, { month: "YYYY-MM", users: [{ id, timestamp, result }] }>
const spinData = new Map();

// Active spin sessions (for double-or-nothing): Map<`${guildId}-${userId}`, { expires, stage }>
const activeSpinSessions = new Map();

// Blackjack game sessions: Map<`${guildId}-${userId}`, { bet, playerHand, dealerHand, deck, status }>
const blackjackGames = new Map();

// Blackjack helper functions
const CARD_SUITS = ["♠", "♥", "♦", "♣"];
const CARD_VALUES = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
];

function createDeck() {
  const deck = [];
  for (const suit of CARD_SUITS) {
    for (const value of CARD_VALUES) {
      deck.push({ suit, value });
    }
  }
  // Shuffle the deck
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function getCardValue(card) {
  if (["J", "Q", "K"].includes(card.value)) return 10;
  if (card.value === "A") return 11;
  return parseInt(card.value);
}

function calculateHand(hand) {
  let total = 0;
  let aces = 0;
  for (const card of hand) {
    total += getCardValue(card);
    if (card.value === "A") aces++;
  }
  // Adjust for aces if busting
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function formatCard(card) {
  const redSuits = ["♥", "♦"];
  return `${card.value}${card.suit}`;
}

function formatHand(hand, hideSecond = false) {
  if (hideSecond && hand.length >= 2) {
    return `${formatCard(hand[0])} | ??`;
  }
  return hand.map(formatCard).join(" | ");
}

// Helper function to safely update an interaction, handling expired tokens
async function safeInteractionUpdate(interaction, options) {
  try {
    await interaction.update(options);
    return true;
  } catch (err) {
    // Error code 10062 = Unknown interaction (token expired)
    if (err.code === 10062) {
      console.log(
        "Interaction token expired, attempting to edit message directly"
      );
      try {
        // Try to edit the message directly instead
        await interaction.message.edit(options);
        return true;
      } catch (editErr) {
        console.error("Failed to edit message directly:", editErr.message);
        return false;
      }
    }
    throw err; // Re-throw other errors
  }
}

async function handleDealerTurn(
  interaction,
  game,
  guildMap,
  userId,
  guildId,
  sessionKey
) {
  // Dealer draws until 17 or higher
  while (calculateHand(game.dealerHand) < 17) {
    game.dealerHand.push(game.deck.pop());
  }

  const playerTotal = calculateHand(game.playerHand);
  const dealerTotal = calculateHand(game.dealerHand);
  // Update user's explosions

  const userData = getDataSafe(guildMap, userId);
  const userExplosions = userData.explosions;

  blackjackGames.delete(sessionKey);

  let resultTitle, resultDesc, resultColor, resultText;

  if (dealerTotal > 21) {
    // Dealer busted - player wins
    const winnings = game.bet;
    userData.explosions = userExplosions + winnings;
    guildMap.set(userId, userData);
    resultTitle = "🃏 Blackjack - YOU WIN!";
    resultDesc = "Dealer busted!";
    resultText = `You won **${winnings}** explosions!`;
    resultColor = 0x00ff00;
  } else if (playerTotal > dealerTotal) {
    // Player wins
    const winnings = game.bet;
    userData.explosions = userExplosions + winnings;
    guildMap.set(userId, userData);
    resultTitle = "🃏 Blackjack - YOU WIN!";
    resultDesc = "You beat the dealer!";
    resultText = `You won **${winnings}** explosions!`;
    resultColor = 0x00ff00;
  } else if (dealerTotal > playerTotal) {
    // Dealer wins
    const newTotal = Math.max(0, userExplosions - game.bet);
    userData.explosions = newTotal;
    guildMap.set(userId, userData);
    resultTitle = "🃏 Blackjack - YOU LOSE!";
    resultDesc = "Dealer wins!";
    resultText = `You lost **${game.bet}** explosions!`;
    resultColor = 0xff0000;
  } else {
    // Push - tie
    resultTitle = "🃏 Blackjack - PUSH!";
    resultDesc = "It's a tie!";
    resultText = `Bet returned: **${game.bet}** explosions`;
    resultColor = 0xffff00;
  }

  if (!explodedCounts.has(guildId)) explodedCounts.set(guildId, guildMap);
  saveLeaderboardDebounced();

  const embed = new EmbedBuilder()
    .setTitle(resultTitle)
    .setDescription(resultDesc)
    .addFields(
      {
        name: "Your Hand",
        value: `${formatHand(game.playerHand)} (${playerTotal})`,
        inline: true,
      },
      {
        name: "Dealer's Hand",
        value: `${formatHand(game.dealerHand)} (${dealerTotal})`,
        inline: true,
      },
      { name: "Result", value: resultText, inline: false }
    )
    .setColor(resultColor);

  await safeInteractionUpdate(interaction, { embeds: [embed], components: [] });
}

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    /* ignore */
  }
}

function loadLeaderboard() {
  try {
    ensureDataDir();
    if (!fs.existsSync(LB_FILE)) return;
    const raw = fs.readFileSync(LB_FILE, "utf8");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    for (const [guildId, guildObj] of Object.entries(parsed)) {
      const gmap = new Map();
      for (const [userId, val] of Object.entries(guildObj)) {
        // Migration: If value is number, convert to object
        if (typeof val === "number") {
          gmap.set(userId, { explosions: val, xp: 0, level: 1 });
        } else {
          // Ensure structure
          gmap.set(userId, {
            explosions: val.explosions ?? 0,
            xp: val.xp ?? 0,
            level: val.level ?? 1,
          });
        }
      }
      explodedCounts.set(guildId, gmap);
    }
    console.log("✅ Loaded leaderboard from", LB_FILE);
  } catch (e) {
    console.error("Failed to load leaderboard:", e);
  }
}

function saveLeaderboard() {
  try {
    ensureDataDir();
    const obj = {};
    for (const [guildId, gmap] of explodedCounts.entries()) {
      obj[guildId] = Object.fromEntries(gmap);
    }
    const tmp = LB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj), "utf8");
    fs.renameSync(tmp, LB_FILE);
  } catch (e) {
    console.error("Failed to save leaderboard:", e);
  }
}

function saveLeaderboardDebounced() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    saveLeaderboard();
    _saveTimer = null;
  }, SAVE_DEBOUNCE_MS);
}

// ---- Spin Data Persistence ----
function loadSpinData() {
  try {
    ensureDataDir();
    if (!fs.existsSync(SPIN_FILE)) return;
    const raw = fs.readFileSync(SPIN_FILE, "utf8");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    for (const [guildId, data] of Object.entries(parsed)) {
      spinData.set(guildId, data);
    }
    console.log("✅ Loaded spin data from", SPIN_FILE);
  } catch (e) {
    console.error("Failed to load spin data:", e);
  }
}

function saveSpinData() {
  try {
    ensureDataDir();
    const obj = {};
    for (const [guildId, data] of spinData.entries()) {
      obj[guildId] = data;
    }
    const tmp = SPIN_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj), "utf8");
    fs.renameSync(tmp, SPIN_FILE);
  } catch (e) {
    console.error("Failed to save spin data:", e);
  }
}

function saveSpinDataDebounced() {
  if (_spinSaveTimer) clearTimeout(_spinSaveTimer);
  _spinSaveTimer = setTimeout(() => {
    saveSpinData();
    _spinSaveTimer = null;
  }, SAVE_DEBOUNCE_MS);
}

// Helper: Get current month string (YYYY-MM)
function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// Helper: Get or initialize guild spin data for current month
function getGuildSpinData(guildId) {
  const currentMonth = getCurrentMonth();
  let guildData = spinData.get(guildId);

  // Reset if month changed
  if (!guildData || guildData.month !== currentMonth) {
    guildData = { month: currentMonth, users: [] };
    spinData.set(guildId, guildData);
  }

  return guildData;
}

// load on startup
loadLeaderboard();
loadSpinData();

// save on graceful shutdown
process.on("SIGINT", () => {
  saveLeaderboard();
  saveSpinData();
  process.exit();
});
process.on("SIGTERM", () => {
  saveLeaderboard();
  saveSpinData();
  process.exit();
});
process.on("exit", () => {
  saveLeaderboard();
  saveSpinData();
});

// XP Helpers imported from utils.js

function recordExplosion(member) {
  try {
    const userId = member?.id ?? member?.user?.id;
    const guildId = member?.guild?.id ?? "global";
    if (!userId) return;
    if (!explodedCounts.has(guildId)) explodedCounts.set(guildId, new Map());
    const guildMap = explodedCounts.get(guildId);

    // Get current data (with migration fallback)
    let userData = getDataSafe(guildMap, userId);

    // Update explosions
    userData.explosions = (userData.explosions || 0) + 1;

    // XP Gain Logic
    const xpGain = Math.floor(Math.random() * 31) + 20; // 20 - 50 XP
    userData.xp = (userData.xp || 0) + xpGain;

    // Check Level Up
    const newLevel = getLevelFromXp(userData.xp);
    if (newLevel > userData.level) {
      userData.level = newLevel;
      console.log(`[LEVEL UP] User ${userId} reached Level ${newLevel}`);
    }

    guildMap.set(userId, userData);

    // persist to disk (debounced)
    try {
      saveLeaderboardDebounced();
    } catch (e) {
      console.error("Save debounce failed:", e);
    }
  } catch (e) {
    console.error("Failed to record explosion:", e);
  }
}
client.once(Events.ClientReady, async () => {
  console.log(`\n✅ Bot is online and ready!`);
  console.log(`🤖 Logged in as ${client.user.tag}`);
  console.log(`📊 Watching ${client.guilds.cache.size} server(s)`);
  console.log(`🎲 Timeout chance: ${(CHANCE * 100).toFixed(0)}%`);
  console.log(`⏱️  Timeout duration: ${TIMEOUT_MS / 1000}s`);
  console.log(`⏳ Cooldown: ${COOLDOWN_MS / 1000}s\n`);

  // Register slash commands
  const commands = [
    {
      name: "roll",
      description: "Roll the dice and randomly timeout someone!",
    },
    {
      name: "rollcd",
      description:
        "Enable or disable the /roll command cooldown (admin/owner only)",
      options: [
        {
          name: "enabled",
          description: "Enable cooldown? (true/false)",
          type: 5, // BOOLEAN
          required: true,
        },
      ],
    },
    {
      name: "lb",
      description: "Show the leaderboard of who got exploded the most",
      options: [
        {
          name: "page",
          description: "Page number to view (default 1)",
          type: 4, // INTEGER
          required: false,
        },
      ],
    },
    {
      name: "spin",
      description:
        "Spin the wheel! 50/50 chance for 1 week admin or 1 week timeout (5 spins/month)",
    },
    {
      name: "blackjack",
      description: "Play blackjack and gamble your explosion count!",
      options: [
        {
          name: "bet",
          description: "Amount to bet (number or 'all')",
          type: 3, // STRING
          required: true,
        },
      ],
    },
    {
      name: "xp",
      description: "View or change a user's xp / explosions.",
      options: [
        {
          name: "type",
          description: "What to modify (xp or explosions)",
          type: 3, // STRING
          required: true, // Changed to required
          choices: [
            { name: "XP", value: "xp" },
            { name: "Explosions", value: "explosions" },
          ],
        },
        {
          name: "username",
          description:
            "The username of the user that you'd like to view / edit.",
          type: 6, // USER
          required: false,
        },
        {
          name: "action",
          description: "add / remove / set",
          type: 3, // STRING
          required: false,
          choices: [
            { name: "add", value: "add" },
            { name: "remove", value: "remove" },
            { name: "set", value: "set" },
          ],
        },
        {
          name: "value",
          description: "Amount of explosions.",
          type: 4, // INTEGER
          required: false,
        },
      ],
    },
    {
      name: "roulette",
      description: "Play roulette with your explosions!",
      options: [
        {
          name: "bet",
          description: "Amount to bet (number or 'all')",
          type: 3, // STRING
          required: true,
        },
        {
          name: "space",
          description: "The space to bet on",
          type: 3, // STRING
          required: true,
          autocomplete: true,
        },
      ],
    },
  ];

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });
    console.log("✅ Slash commands registered!");
  } catch (error) {
    console.error("Error registering commands:", error);
  }
});

// helper: is user exempt
function isExempt(member) {
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
  // exempt certain roles by name — edit or expand
  const exemptRoleNames = ["Moderator", "Admin", "NoTimeout"];
  for (const r of exemptRoleNames)
    if (member.roles.cache.some((role) => role.name === r)) return true;
  return false;
}

// helper: check if bot can timeout this member
function canTimeout(botMember, targetMember) {
  if (!botMember || !targetMember) return false;

  // Check if bot has Moderate Members permission
  if (!botMember.permissions.has("ModerateMembers")) {
    return false;
  }

  // Check if target is server owner
  //   if (targetMember.guild.ownerId === targetMember.id) {
  //     return false;
  //   }

  return true;
}

client.on(Events.MessageCreate, async (message) => {
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
    console.log(`\n🎯 Attempting timeout for ${member.user.tag}`);
    console.log(
      `   Bot's highest role: ${botMember.roles.highest.name} (position: ${botMember.roles.highest.position})`
    );
    console.log(
      `   Target's highest role: ${member.roles.highest.name} (position: ${member.roles.highest.position})`
    );
    console.log(
      `   Bot has ModerateMembers: ${botMember.permissions.has(
        "ModerateMembers"
      )}`
    );
    console.log(
      `   Bot has Administrator: ${botMember.permissions.has("Administrator")}`
    );
    console.log(`   Target is owner: ${member.guild.ownerId === member.id}`);

    if (!canTimeout(botMember, member)) {
      console.log(`   ❌ Cannot timeout: insufficient permissions`);
      return;
    }

    // cooldown check
    const last = cooldowns.get(member.id) ?? 0;
    if (Date.now() - last < COOLDOWN_MS) return;

    // Get timeout chance (check if member has a high-chance role)
    let timeoutChance = CHANCE;

    // Triple explosion chance for banned role
    if (member.roles.cache.has(ROLL_BANNED_ROLE)) {
      timeoutChance = Math.min(1, CHANCE * 3); // Triple chance, cap at 100%
      console.log(
        `   🎯 Banned role detected: tripled chance to ${(
          timeoutChance * 100
        ).toFixed(1)}%`
      );
    }

    for (const [roleIdentifier, chance] of HIGH_CHANCE_ROLES) {
      // Check by both role name and role ID
      if (
        member.roles.cache.some(
          (role) => role.name === roleIdentifier || role.id === roleIdentifier
        )
      ) {
        timeoutChance = Math.max(timeoutChance, chance); // Use highest chance if multiple roles
        console.log(
          `   🎲 Higher chance detected (${roleIdentifier}): ${(
            chance * 100
          ).toFixed(1)}%`
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
      console.log(
        `Timed out ${member.user.tag} for ${durSeconds}s in ${message.guild.name}/${message.channel.name}`
      );
    } catch (err) {
      console.error("Failed to timeout member:", err.message);
      // Don't send error message in channel to avoid spam
    }
  } catch (err) {
    console.error(err);
  }
});

// Handle slash command interactions
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    const focusedOption = interaction.options.getFocused(true);
    if (
      interaction.commandName === "roulette" &&
      focusedOption.name === "space"
    ) {
      const choices = [
        "Red",
        "Black",
        "Even",
        "Odd",
        "1-18",
        "19-36",
        "1st 12",
        "2nd 12",
        "3rd 12",
        "0",
      ];
      // Add numbers 1-36
      for (let i = 1; i <= 36; i++) choices.push(i.toString());

      const filtered = choices.filter((choice) =>
        choice.toLowerCase().startsWith(focusedOption.value.toLowerCase())
      );

      // Limit to 25 choices
      await interaction.respond(
        filtered.slice(0, 25).map((choice) => {
          let name = choice;
          // Add odds info to name for clarity
          if (["Red", "Black", "Even", "Odd", "1-18", "19-36"].includes(choice))
            name += " (1:1)";
          else if (["1st 12", "2nd 12", "3rd 12"].includes(choice))
            name += " (2:1)";
          else name += " (35:1)"; // Numbers

          // Map display name to internal value
          let value = choice.toLowerCase();
          if (choice === "1st 12") value = "1-12";
          else if (choice === "2nd 12") value = "13-24";
          else if (choice === "3rd 12") value = "25-36";

          return { name, value };
        })
      );
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "roll") {
    try {
      const botMember = interaction.guild.members.me;

      // Check if bot has permissions
      if (!botMember.permissions.has("ModerateMembers")) {
        await interaction.reply({
          content:
            'I need the "Moderate Members" permission to use this command!',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Check cooldown for /roll command (server owner bypasses cooldown)
      const userId = interaction.user.id;
      const isOwner = interaction.guild.ownerId === userId;

      // Block banned user from using /roll
      if (interaction.member.roles.cache.has(ROLL_BANNED_ROLE)) {
        await interaction.reply({
          content: "❌ You are banned from using /roll!",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (rollCooldownEnabled && !isOwner) {
        const now = Date.now();
        const userData = rollCooldowns.get(userId);

        let availableCharges = 0;

        if (userData) {
          const timeSinceLastRoll = now - userData.lastRoll;

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
            userData.charges + chargesGained
          );

          // Debug log
          console.log(
            `[ROLL COOLDOWN] User ${userId}: charges=${
              userData.charges
            }, timeSince=${Math.floor(
              timeSinceLastRoll / 1000
            )}s, gained=${chargesGained}, available=${availableCharges}`
          );
        } else {
          // New user starts with 1 charge
          availableCharges = 1;
          console.log(
            `[ROLL COOLDOWN] New user ${userId}: starting with ${availableCharges} charge`
          );
        }

        console.log(
          `[ROLL COOLDOWN] User ${userId} attempting roll with ${availableCharges} charges available`
        );

        if (availableCharges <= 0) {
          // Calculate time until next charge
          const timeSinceLastRoll = now - userData.lastRoll;

          // Find the next charge threshold
          let nextChargeThreshold = 0;
          for (let i = 0; i < MAX_ROLL_CHARGES; i++) {
            const timeForThisCharge = 3600000 + i * 1800000; // 1hr + (i * 30min)
            nextChargeThreshold += timeForThisCharge;
            if (timeSinceLastRoll < nextChargeThreshold) {
              // This is the next charge we're waiting for
              const timeUntilNextCharge =
                nextChargeThreshold - timeSinceLastRoll;
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
        console.error("Failed to fetch guild members:", e);
      }

      // Get all non-bot members who aren't exempt
      const eligibleMembers = interaction.guild.members.cache.filter(
        (member) => {
          if (member.user.bot) return false;
          if (isExempt(member)) return false;
          if (!canTimeout(botMember, member)) return false;
          // Only target online/idle/dnd members (not offline)
          // if (!member.presence || member.presence.status === 'offline') return false;
          return true;
        }
      );

      console.log(
        `[ROLL DEBUG] Total cached members: ${interaction.guild.members.cache.size}, Eligible: ${eligibleMembers.size}`
      );

      if (eligibleMembers.size === 0) {
        // Refund charge since no one can be exploded
        if (rollCooldownEnabled && !isOwner) {
          const userData = rollCooldowns.get(userId);
          if (userData) {
            rollCooldowns.set(userId, {
              lastRoll: userData.lastRoll,
              charges: Math.min(MAX_ROLL_CHARGES, userData.charges + 1),
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
      const durSeconds = Math.round(rollTimeoutMs / 1000);

      try {
        // Roll 1: Timeout the person who used the command
        if (diceRoll === 1) {
          const commandUser = interaction.member;
          if (!isExempt(commandUser) && canTimeout(botMember, commandUser)) {
            await commandUser.timeout(
              rollTimeoutMs,
              `Rolled a 1 - exploded themselves!`
            );
            recordExplosion(commandUser);
            await interaction.followUp(
              `💥 Oops! ${commandUser} rolled a **1** and exploded themselves! 😂`
            );
            console.log(
              `[ROLL] ${interaction.user.tag} rolled a 1 and exploded themselves`
            );
          } else {
            await interaction.followUp(
              `🍀 ${commandUser} got lucky! They rolled a **1** but have immunity!`
            );
          }
        }
        // Roll 6: Timeout two people
        else if (diceRoll === 6) {
          const eligibleArray = Array.from(eligibleMembers.values());

          if (eligibleArray.length < 2) {
            // Only one person available
            const targetMember = eligibleArray[0];
            await targetMember.timeout(
              rollTimeoutMs,
              `Rolled a 6 by /roll command`
            );
            recordExplosion(targetMember);
            await interaction.followUp(
              `💥💥 ${targetMember} got DOUBLE exploded (Not enough people for 2 timeouts)`
            );
            console.log(
              `[ROLL] ${interaction.user.tag} rolled a 6 and exploded ${targetMember.user.tag}`
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
              `Rolled a 6 by /roll command (victim 1)`
            );
            recordExplosion(firstMember);
            await secondMember.timeout(
              rollTimeoutMs,
              `Rolled a 6 by /roll command (victim 2)`
            );
            recordExplosion(secondMember);
            await interaction.followUp(
              `💥💥 DOUBLE KILL! ${firstMember} and ${secondMember} both got exploded!`
            );
            console.log(
              `[ROLL] ${interaction.user.tag} rolled a 6 and exploded ${firstMember.user.tag} and ${secondMember.user.tag}`
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
            `Rolled a ${diceRoll} by /roll command`
          );
          recordExplosion(targetMember);
          await interaction.followUp(`💥 ${targetMember} got exploded!`);
          console.log(
            `[ROLL] ${interaction.user.tag} rolled a ${diceRoll} and exploded ${targetMember.user.tag})`
          );
        }

        // 0.0001% (1 in a million) chance to kick someone
        if (Math.random() < 0.000001) {
          const eligibleArray = Array.from(eligibleMembers.values());
          if (eligibleArray.length > 0) {
            const unluckyMember =
              eligibleArray[Math.floor(Math.random() * eligibleArray.length)];
            try {
              await unluckyMember.kick(
                "ULTRA RARE EVENT: 1 in a million roll!"
              );
              await interaction.followUp(
                `🌟✨💀 **ULTRA RARE EVENT!** 🌟✨💀\n${unluckyMember.user.tag} just hit the 1 IN A MILLION chance and got KICKED from the server! 😱`
              );
              console.log(
                `[ULTRA RARE] ${interaction.user.tag} triggered 1 in a million event - kicked ${unluckyMember.user.tag}`
              );

              // Try to DM them the invite after kicking
              try {
                await unluckyMember.send(
                  `You just hit the 1 IN A MILLION chance in ${interaction.guild.name}! 😱\nHere's the invite to rejoin: https://discord.gg/P8ZQZRjw29`
                );
              } catch (dmErr) {
                console.log(
                  `Couldn't DM ${unluckyMember.user.tag} - they have DMs disabled or left mutual servers`
                );
              }
            } catch (err) {
              console.error(
                `Failed to kick ${unluckyMember.user.tag}:`,
                err.message
              );
            }
          }
        }
        // 0.2% chance to send an image and timeout everyone for 15 seconds
        else if (Math.random() < 0.002) {
          await interaction.followUp(
            "https://media.discordapp.net/attachments/1423201741931024396/1442538744941907988/image.jpg?ex=692bbb25&is=692a69a5&hm=2b4933660848107d82e2d15eb2522e12d44d30b849a339a9625b7b306202fd7f&=&format=webp"
          );
          await interaction.followUp(
            `${interaction.user.tag} launched a nuke and exploded everyone!`
          );

          // Timeout all eligible members for 15 seconds
          const allEligible = interaction.guild.members.cache.filter(
            (member) => {
              if (member.user.bot) return false;
              if (isExempt(member)) return false;
              if (!canTimeout(botMember, member)) return false;
              return true;
            }
          );

          let timeoutCount = 0;
          for (const [, member] of allEligible) {
            try {
              await member.timeout(15000, "Mass timeout event!");
              recordExplosion(member);
              timeoutCount++;
            } catch (err) {
              console.error(
                `Failed to timeout ${member.user.tag}:`,
                err.message
              );
            }
          }

          if (timeoutCount > 0) {
            await interaction.followUp(`💥💥💥 EVERYONE GOT EXPLODED!💥💥💥`);
          }
        }
      } catch (err) {
        console.error("Failed to timeout member from /roll:", err.message);
        await interaction.followUp({
          content: `⚠️ Couldn't explode them`,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (err) {
      console.error("Error in /roll command:", err);
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
        console.error("Failed to send error message:", e);
      }
    }
  } else if (interaction.commandName === "rollcd") {
    try {
      // Defer reply immediately so Discord doesn't mark the interaction as unresponded
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
      console.log(`rollCooldownEnabled set to: ${enabled}`);

      await interaction.editReply({
        content: `/roll cooldown is now **${
          enabled ? "ENABLED" : "DISABLED"
        }**.`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      console.error("Error in /rollcd command (top-level):", err);
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
        console.error("Failed to send error message:", e);
      }
    }
  } else if (interaction.commandName === "lb") {
    try {
      await interaction.deferReply();
      const page = interaction.options.getInteger("page") ?? 1;
      const perPage = 10;

      // Use guild-specific leaderboard
      const guildId = interaction.guild.id;
      const guildMap = explodedCounts.get(guildId) ?? new Map();
      const entries = Array.from(guildMap.entries());
      entries.sort((a, b) => b[1].xp - a[1].xp); // Sort by XP

      if (entries.length === 0) {
        await interaction.editReply({
          content: "No explosions recorded in this server yet.",
        });
        return;
      }

      const totalPages = Math.ceil(entries.length / perPage);
      const currentPage = Math.max(1, Math.min(page, totalPages));
      const startIdx = (currentPage - 1) * perPage;
      const slice = entries.slice(startIdx, startIdx + perPage);

      // Build leaderboard lines
      const lines = [];
      for (let i = 0; i < slice.length; i++) {
        const [id, userData] = slice[i];
        const rank = startIdx + i + 1;
        let display = `User ${id.slice(-4)}`;
        try {
          const member = await interaction.guild.members.fetch(id);
          display = member.displayName;
        } catch (e) {
          // keep fallback
        }
        lines.push(
          `**${rank}.** ${display} • 💥 ${userData.explosions.toLocaleString()} (Level ${
            userData.level
          })`
        );
      }

      // Find user's rank
      const userRank = entries.findIndex(([id]) => id === interaction.user.id);
      const userRankText =
        userRank >= 0
          ? `Your rank: #${userRank + 1}`
          : "You have no explosions yet";

      // Create embed
      const embed = new EmbedBuilder()
        .setTitle("💣 Leaderboard")
        .setDescription(lines.join("\n"))
        .setColor(0x2b2d31)
        .setFooter({
          text: `Page ${currentPage}/${totalPages} • ${userRankText}`,
        });

      // Create pagination buttons
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`lb_prev_${guildId}_${currentPage}`)
          .setLabel("Previous Page")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage <= 1),
        new ButtonBuilder()
          .setCustomId(`lb_next_${guildId}_${currentPage}`)
          .setLabel("Next Page")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(currentPage >= totalPages)
      );

      await interaction.editReply({
        embeds: [embed],
        components: [row],
      });
    } catch (err) {
      console.error("Error in /lb command:", err);
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
        console.error("Failed to send error for /lb:", e);
      }
    }
  } else if (interaction.commandName === "spin") {
    // ============= /spin command =============
    try {
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
            (r) => r.name === SPIN_ADMIN_ROLE_NAME
          );

          if (!spinRole) {
            // Create the role if it doesn't exist
            spinRole = await interaction.guild.roles.create({
              name: SPIN_ADMIN_ROLE_NAME,
              permissions: ["Administrator"],
              reason: "Spin wheel winner role",
            });
            console.log(
              `[SPIN] Created "${SPIN_ADMIN_ROLE_NAME}" role in ${interaction.guild.name}`
            );
          }

          // Give the role to the winner
          await interaction.member.roles.add(
            spinRole,
            "Won the spin wheel for 1 week"
          );

          // Schedule role removal after 1 week
          setTimeout(async () => {
            try {
              const member = await interaction.guild.members.fetch(userId);
              if (member.roles.cache.has(spinRole.id)) {
                await member.roles.remove(
                  spinRole,
                  "Spin wheel admin period expired (1 week)"
                );
                console.log(
                  `[SPIN] Removed admin role from ${member.user.tag} after 1 week`
                );
              }
            } catch (e) {
              console.error("[SPIN] Failed to remove role after timeout:", e);
            }
          }, ONE_WEEK_MS);

          // Create double-or-nothing button
          const sessionKey = `${guildId}-${userId}`;
          activeSpinSessions.set(sessionKey, {
            expires: Date.now() + 60000, // 1 minute to decide
            stage: 1,
          });

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`spin_double_${guildId}_${userId}`)
              .setLabel("🎲 Double or Nothing! (2 weeks)")
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId(`spin_keep_${guildId}_${userId}`)
              .setLabel("✅ Keep 1 Week Admin")
              .setStyle(ButtonStyle.Success)
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

          console.log(`[SPIN] ${interaction.user.tag} WON - gave 1 week admin`);
        } catch (err) {
          console.error("[SPIN] Error giving admin role:", err);
          await interaction.editReply({
            content: `🎉 You won! But I couldn't give you the admin role (missing permissions?).`,
          });
        }
      } else {
        // Loser gets 1 week timeout
        try {
          await interaction.member.timeout(
            ONE_WEEK_MS,
            "Lost the spin wheel - 1 week timeout"
          );
          await interaction.editReply({
            content: `💀 **LOST!** 💀\n\n${interaction.user} spun the wheel and lost! Enjoy your **1 week timeout**! 😈`,
          });
          console.log(`[SPIN] ${interaction.user.tag} LOST - 1 week timeout`);
        } catch (err) {
          console.error("[SPIN] Error applying timeout:", err);
          await interaction.editReply({
            content: `💀 You lost! But I couldn't timeout you (you might be immune).`,
          });
        }
      }
    } catch (err) {
      console.error("Error in /spin command:", err);
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
        console.error("Failed to send error for /spin:", e);
      }
    }
  } else if (interaction.commandName === "blackjack") {
    // ============= /blackjack command =============
    try {
      const guildId = interaction.guild.id;
      const userId = interaction.user.id;
      const sessionKey = `${guildId}-${userId}`;
      const betInput = interaction.options
        .getString("bet")
        .toLowerCase()
        .trim();

      // Check if user already has an active game
      if (blackjackGames.has(sessionKey)) {
        await interaction.reply({
          content:
            "❌ You already have an active blackjack game! Finish it first.",
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
              }
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
              }
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
          }
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
          .setStyle(ButtonStyle.Secondary)
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
                }
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
      }, 300000); // 5 minutes
    } catch (err) {
      console.error("Error in /blackjack command:", err);
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
        console.error("Failed to send error for /blackjack:", e);
      }
    }
  } else if (interaction.commandName === "xp") {
    try {
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
            content: `**${
              targetUser.username
            }** has **${userData.explosions.toLocaleString()} explosions**.`,
          });
        } else {
          await interaction.reply({
            content: `**${
              targetUser.username
            }** has **${userData.xp.toLocaleString()} XP** (Level ${
              userData.level
            }).`,
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

      const valToCheck =
        type === "explosions" ? userData.explosions : userData.xp;

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
          `Successfully ${actionText} **${targetUser.username}**'s ${type}.\n\n**New ${type}:** ${newValue}`
        )
        .setColor(0x00ff00)
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error("Error in /xp:", err);
      if (!interaction.replied)
        await interaction.reply({
          content: "An error occurred.",
          flags: MessageFlags.Ephemeral,
        });
    }
  } else if (interaction.commandName === "roulette") {
    try {
      const guildId = interaction.guild.id;
      const userId = interaction.user.id;
      const betInput = interaction.options
        .getString("bet")
        .toLowerCase()
        .trim();
      const bettingSpace = interaction.options.getString("space");

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

      const ROULETTE_RED = [
        1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
      ];
      const ROULETTE_BLACK = [
        2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35,
      ];

      let color = "green";
      let colorEmoji = "🟢";
      if (ROULETTE_RED.includes(number)) {
        color = "red";
        colorEmoji = "🔴";
      } else if (ROULETTE_BLACK.includes(number)) {
        color = "black";
        colorEmoji = "⚫";
      }

      let won = false;
      let multiplier = 0;

      switch (bettingSpace) {
        case "red":
          if (color === "red") {
            won = true;
            multiplier = 1;
          }
          break;
        case "black":
          if (color === "black") {
            won = true;
            multiplier = 1;
          }
          break;
        case "even":
          if (number !== 0 && number % 2 === 0) {
            won = true;
            multiplier = 1;
          }
          break;
        case "odd":
          if (number !== 0 && number % 2 !== 0) {
            won = true;
            multiplier = 1;
          }
          break;
        case "1-18":
          if (number >= 1 && number <= 18) {
            won = true;
            multiplier = 1;
          }
          break;
        case "19-36":
          if (number >= 19 && number <= 36) {
            won = true;
            multiplier = 1;
          }
          break;
        case "1-12":
          if (number >= 1 && number <= 12) {
            won = true;
            multiplier = 2;
          }
          break;
        case "13-24":
          if (number >= 13 && number <= 24) {
            won = true;
            multiplier = 2;
          }
          break;
        case "25-36":
          if (number >= 25 && number <= 36) {
            won = true;
            multiplier = 2;
          }
          break;
        case "0":
          if (number === 0) {
            won = true;
            multiplier = 35;
          }
          break;
        default:
          const num = parseInt(bettingSpace);
          if (!isNaN(num) && num >= 1 && num <= 36) {
            if (number === num) {
              won = true;
              multiplier = 35;
            }
          }
          break;
      }

      let resultTitle, resultDesc, resultColor;

      if (won) {
        const winnings = bet * multiplier;
        // Logic: if multiplier is 1 (e.g. Red), you win 1x bet. Total added = winnings.

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
                }
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
                }
              )
              .setColor(resultColor),
          ],
        });
      }

      saveLeaderboardDebounced();
    } catch (err) {
      console.error("Error in /roulette:", err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "An error occurred.",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.followUp({
          content: "An error occurred.",
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  }
});

// Handle button interactions for spin double-or-nothing and leaderboard pagination
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  // Handle leaderboard pagination buttons
  if (
    interaction.customId.startsWith("lb_prev_") ||
    interaction.customId.startsWith("lb_next_")
  ) {
    try {
      const parts = interaction.customId.split("_");
      const direction = parts[1]; // "prev" or "next"
      const guildId = parts[2];
      const currentPage = parseInt(parts[3]);

      const newPage = direction === "next" ? currentPage + 1 : currentPage - 1;
      const perPage = 10;

      // Get leaderboard data
      const guildMap = explodedCounts.get(guildId) ?? new Map();
      const entries = Array.from(guildMap.entries());
      entries.sort((a, b) => b[1].xp - a[1].xp); // Sort by XP (Level)

      const totalPages = Math.ceil(entries.length / perPage);
      const validPage = Math.max(1, Math.min(newPage, totalPages));
      const startIdx = (validPage - 1) * perPage;
      const slice = entries.slice(startIdx, startIdx + perPage);

      // Build leaderboard lines
      const lines = [];
      for (let i = 0; i < slice.length; i++) {
        const [id, userData] = slice[i];
        const rank = startIdx + i + 1;
        let display = `User ${id.slice(-4)}`;
        try {
          const member = await interaction.guild.members.fetch(id);
          display = member.displayName;
        } catch (e) {
          // keep fallback
        }
        lines.push(
          `**${rank}.** ${display} • **Level ${
            userData.level
          }** (${userData.xp.toLocaleString()} XP) • 💥 ${userData.explosions.toLocaleString()}`
        );
      }

      // Find user's rank
      const userRank = entries.findIndex(([id]) => id === interaction.user.id);
      const userRankText =
        userRank >= 0
          ? `Your rank: #${userRank + 1}`
          : "You have no explosions yet";

      // Create embed
      const embed = new EmbedBuilder()
        .setTitle("💣 Leaderboard")
        .setDescription(lines.join("\n"))
        .setColor(0x2b2d31)
        .setFooter({
          text: `Page ${validPage}/${totalPages} • ${userRankText}`,
        });

      // Create pagination buttons
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`lb_prev_${guildId}_${validPage}`)
          .setLabel("Previous Page")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(validPage <= 1),
        new ButtonBuilder()
          .setCustomId(`lb_next_${guildId}_${validPage}`)
          .setLabel("Next Page")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(validPage >= totalPages)
      );

      await interaction.update({
        embeds: [embed],
        components: [row],
      });
    } catch (err) {
      console.error("Error handling leaderboard pagination:", err);
    }
    return;
  }

  // Handle blackjack buttons
  if (
    interaction.customId.startsWith("bj_hit_") ||
    interaction.customId.startsWith("bj_stand_")
  ) {
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
      const userExplosions = guildMap.get(targetUserId) ?? 0;

      if (action === "hit") {
        // Draw a card
        game.playerHand.push(game.deck.pop());
        const playerTotal = calculateHand(game.playerHand);

        if (playerTotal > 21) {
          // Player busted!
          blackjackGames.delete(sessionKey);
          const newTotal = Math.max(0, userExplosions - game.bet);
          guildMap.set(targetUserId, newTotal);
          if (!explodedCounts.has(guildId))
            explodedCounts.set(guildId, guildMap);
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
                value: `${formatHand(game.dealerHand)} (${calculateHand(
                  game.dealerHand
                )})`,
                inline: true,
              },
              {
                name: "Result",
                value: `You lost **${game.bet}** explosions!`,
                inline: false,
              }
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
            sessionKey
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
              }
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
              .setStyle(ButtonStyle.Secondary)
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
          sessionKey
        );
      }
    } catch (err) {
      // Don't log "Unknown interaction" errors as they're expected when tokens expire
      if (err.code !== 10062) {
        console.error("Error handling blackjack buttons:", err);
      } else {
        console.log(
          `Blackjack interaction expired for user ${
            interaction.user?.tag || "unknown"
          }`
        );
      }
    }
    return;
  }

  // Handle spin buttons
  if (
    interaction.customId.startsWith("spin_double_") ||
    interaction.customId.startsWith("spin_keep_")
  ) {
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
      console.log(`[SPIN] ${interaction.user.tag} chose to keep 1 week admin`);
    } else if (action === "double") {
      // User chose double or nothing - 50/50 again!
      await interaction.update({
        content: `🎲 **DOUBLE OR NOTHING!** 🎲\n\n${interaction.user} is gambling it all...`,
        components: [],
      });

      await new Promise((resolve) => setTimeout(resolve, 1500));

      const doubleWon = Math.random() < 0.5;

      if (doubleWon) {
        // Won double - extend to 2 weeks admin
        try {
          // Find the spin role
          const spinRole = interaction.guild.roles.cache.find(
            (r) => r.name === SPIN_ADMIN_ROLE_NAME
          );

          if (spinRole) {
            // Cancel the 1-week removal and schedule 2-week removal instead
            setTimeout(async () => {
              try {
                const member = await interaction.guild.members.fetch(
                  targetUserId
                );
                if (member.roles.cache.has(spinRole.id)) {
                  await member.roles.remove(
                    spinRole,
                    "Spin wheel admin period expired (2 weeks)"
                  );
                  console.log(
                    `[SPIN] Removed admin role from ${member.user.tag} after 2 weeks`
                  );
                }
              } catch (e) {
                console.error(
                  "[SPIN] Failed to remove role after 2-week timeout:",
                  e
                );
              }
            }, TWO_WEEKS_MS);
          }

          await interaction.editReply({
            content: `🎉🎉 **JACKPOT!** 🎉🎉\n\n${interaction.user} went double or nothing and **WON**! They now have **2 WEEKS of Admin**! 🏆`,
          });
          console.log(
            `[SPIN] ${interaction.user.tag} WON double or nothing - 2 weeks admin`
          );
        } catch (err) {
          console.error("[SPIN] Error extending admin:", err);
        }
      } else {
        // Lost double - remove admin and apply 2 week timeout
        try {
          const spinRole = interaction.guild.roles.cache.find(
            (r) => r.name === SPIN_ADMIN_ROLE_NAME
          );

          if (spinRole && interaction.member.roles.cache.has(spinRole.id)) {
            await interaction.member.roles.remove(
              spinRole,
              "Lost double or nothing"
            );
          }

          await interaction.member.timeout(
            TWO_WEEKS_MS,
            "Lost double or nothing - 2 week timeout"
          );

          await interaction.editReply({
            content: `💀💀 **BUSTED!** 💀💀\n\n${interaction.user} went double or nothing and **LOST EVERYTHING**! Enjoy your **2 WEEKS TIMEOUT**! 😈😈`,
          });
          console.log(
            `[SPIN] ${interaction.user.tag} LOST double or nothing - 2 weeks timeout`
          );
        } catch (err) {
          console.error("[SPIN] Error applying double loss:", err);
          await interaction.editReply({
            content: `💀 You lost double or nothing! But I couldn't timeout you (you might be immune).`,
          });
        }
      }
    }
  }
});

client.login(TOKEN);
