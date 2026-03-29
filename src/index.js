import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
} from "discord.js";

// Import modules
import { logger } from "./src/utils/logger.js";
import { commands } from "./src/commands/index.js";
import {
  loadLeaderboard,
  saveLeaderboard,
  loadSpinData,
  saveSpinData,
  loadScheduledEvents,
  saveScheduledEvents,
  setClient,
  restoreScheduledEvents,
} from "./src/data/index.js";
import {
  handleMessageCreate,
  handleButtonInteraction,
  handleSlashCommand,
  handleAutocomplete,
} from "./src/handlers/index.js";
import {
  TIMEOUT_MS,
  CHANCE,
  COOLDOWN_MS,
} from "./src/utils/constants.js";

// Validate required environment variables
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) throw new Error("DISCORD_TOKEN missing in .env");

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

// Initialize data on startup
(async () => {
  await loadLeaderboard();
  await loadSpinData();
  await loadScheduledEvents();
})();

// Set client reference for scheduled events module
setClient(client);

// Handle graceful shutdown
async function shutdown() {
  logger.info("Shutting down...");
  await saveLeaderboard();
  await saveSpinData();
  await saveScheduledEvents();
  process.exit();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Bot ready event
client.once(Events.ClientReady, async () => {
  logger.info(`Bot is online and ready!`);
  logger.info(`Logged in as ${client.user.tag}`);
  logger.info(`Watching ${client.guilds.cache.size} server(s)`);
  logger.info(`Timeout chance: ${(CHANCE * 100).toFixed(0)}%`);
  logger.info(`Timeout duration: ${TIMEOUT_MS / 1000}s`);
  logger.info(`Cooldown: ${COOLDOWN_MS / 1000}s`);

  // Restore scheduled events from disk
  restoreScheduledEvents();

  // Register slash commands
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  try {
    logger.info("Registering slash commands...");
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });
    logger.info("Slash commands registered!");
  } catch (error) {
    logger.error("Error registering commands:", error);
  }
});

// Message handler (random timeouts)
client.on(Events.MessageCreate, handleMessageCreate);

// Interaction handler (slash commands and buttons)
client.on(Events.InteractionCreate, async (interaction) => {
  // Handle autocomplete
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction);
    return;
  }

  // Handle slash commands
  if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction);
    return;
  }

  // Handle button interactions
  if (interaction.isButton()) {
    await handleButtonInteraction(interaction);
    return;
  }
});

// Login to Discord
client.login(TOKEN);
