// index.js
console.log('Starting bot...');
import 'dotenv/config';
console.log('dotenv loaded');
import { Client, GatewayIntentBits, Partials, Events, Collection, REST, Routes, MessageFlags } from 'discord.js';
console.log('discord.js imported');
import fs from 'fs';
import path from 'path';

const TOKEN = process.env.DISCORD_TOKEN;
console.log('TOKEN exists:', !!TOKEN);
if (!TOKEN) throw new Error('DISCORD_TOKEN missing in .env');

const WATCH_CHANNELS = process.env.CHANNEL_ALLOW ? process.env.CHANNEL_ALLOW.split(',').map(s => s.trim()).filter(Boolean) : null;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 10000);
const CHANCE = Number(process.env.CHANCE ?? 0.05);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 30000);
const ROLL_COOLDOWN_MS = 3600000; // 1 hour cooldown for /roll command
const MAX_ROLL_CHARGES = 3; // Maximum stacked roll charges

// Parse high chance roles (format: RoleNameOrID:0.5,AnotherRoleOrID:0.75)
// Supports both role names and role IDs
const HIGH_CHANCE_ROLES = new Map();
if (process.env.HIGH_CHANCE_ROLES) {
  process.env.HIGH_CHANCE_ROLES.split(',').forEach(pair => {
    const [roleIdentifier, chance] = pair.split(':').map(s => s.trim());
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
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
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
const DATA_DIR = path.join(process.cwd(), 'data');
const LB_FILE = path.join(DATA_DIR, 'leaderboard.json');
const SAVE_DEBOUNCE_MS = 2000; // debounce writes
let _saveTimer = null;

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore */ }
}

function loadLeaderboard() {
  try {
    ensureDataDir();
    if (!fs.existsSync(LB_FILE)) return;
    const raw = fs.readFileSync(LB_FILE, 'utf8');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    for (const [guildId, guildObj] of Object.entries(parsed)) {
      const gmap = new Map(Object.entries(guildObj).map(([k, v]) => [k, Number(v)]));
      explodedCounts.set(guildId, gmap);
    }
    console.log('✅ Loaded leaderboard from', LB_FILE);
  } catch (e) {
    console.error('Failed to load leaderboard:', e);
  }
}

function saveLeaderboard() {
  try {
    ensureDataDir();
    const obj = {};
    for (const [guildId, gmap] of explodedCounts.entries()) {
      obj[guildId] = Object.fromEntries(gmap);
    }
    const tmp = LB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, LB_FILE);
  } catch (e) {
    console.error('Failed to save leaderboard:', e);
  }
}

function saveLeaderboardDebounced() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    saveLeaderboard();
    _saveTimer = null;
  }, SAVE_DEBOUNCE_MS);
}

// load on startup
loadLeaderboard();

// save on graceful shutdown
process.on('SIGINT', () => { saveLeaderboard(); process.exit(); });
process.on('SIGTERM', () => { saveLeaderboard(); process.exit(); });
process.on('exit', () => { saveLeaderboard(); });

function recordExplosion(member) {
  try {
    const userId = member?.id ?? member?.user?.id;
    const guildId = member?.guild?.id ?? 'global';
    if (!userId) return;
    if (!explodedCounts.has(guildId)) explodedCounts.set(guildId, new Map());
    const guildMap = explodedCounts.get(guildId);
    guildMap.set(userId, (guildMap.get(userId) ?? 0) + 1);
    // persist to disk (debounced)
    try { saveLeaderboardDebounced(); } catch (e) { console.error('Save debounce failed:', e); }
  } catch (e) {
    console.error('Failed to record explosion:', e);
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
    name: 'roll',
    description: 'Roll the dice and randomly timeout someone!',
  },
    {
      name: 'rollcd',
      description: 'Enable or disable the /roll command cooldown (admin/owner only)',
    options: [
      {
        name: 'enabled',
        description: 'Enable cooldown? (true/false)',
        type: 5, // BOOLEAN
        required: true,
      },
    ],
  },
    {
      name: 'lb',
      description: 'Show the leaderboard of who got exploded the most',
      options: [
        {
          name: 'count',
          description: 'Number of top users to show (default 10)',
          type: 4, // INTEGER
          required: false,
        },
      ],
    },
    {
      name: 'exp',
      description: 'Manage explosion counts (Admin only)',
      options: [
        {
          name: 'add',
          description: 'Add explosions to a user',
          type: 1, // SUB_COMMAND
          options: [
            {
              name: 'user',
              description: 'The user to update',
              type: 6, // USER
              required: true,
            },
            {
              name: 'amount',
              description: 'Amount to add',
              type: 4, // INTEGER
              required: true,
            },
          ],
        },
        {
          name: 'remove',
          description: 'Remove explosions from a user',
          type: 1, // SUB_COMMAND
          options: [
            {
              name: 'user',
              description: 'The user to update',
              type: 6, // USER
              required: true,
            },
            {
              name: 'amount',
              description: 'Amount to remove',
              type: 4, // INTEGER
              required: true,
            },
          ],
        },
        {
          name: 'set',
          description: 'Set a user\'s explosion count directly',
          type: 1, // SUB_COMMAND
          options: [
            {
              name: 'user',
              description: 'The user to update',
              type: 6, // USER
              required: true,
            },
            {
              name: 'amount',
              description: 'The exact amount to set',
              type: 4, // INTEGER
              required: true,
            },
          ],
        },
      ],
    },
];
  
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands },
    );
    console.log('✅ Slash commands registered!');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
});

// helper: is user exempt
function isExempt(member) {
  if (!member) return true;
  // exempt bots
  if (member.user?.bot) return true;
  // exempt administrators (can't be timed out anyway)
  if (member.permissions?.has('Administrator')) return true;
  // exempt server owner
  if (member.guild.ownerId === member.id) return true;
  // exempt certain roles by name — edit or expand
  const exemptRoleNames = ['Moderator', 'Admin', 'NoTimeout'];
  for (const r of exemptRoleNames) if (member.roles.cache.some(role => role.name === r)) return true;
  return false;
}

// helper: check if bot can timeout this member
function canTimeout(botMember, targetMember) {
  if (!botMember || !targetMember) return false;
  
  // Check if bot has Moderate Members permission
  if (!botMember.permissions.has('ModerateMembers')) {
    return false;
  }
  
  // Commented out role hierarchy check - allows timing out users with higher roles
  // if (botMember.roles.highest.position <= targetMember.roles.highest.position) {
  //   return false;
  // }
  
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
    if (WATCH_CHANNELS && WATCH_CHANNELS.length && !WATCH_CHANNELS.includes(message.channel.id)) return;

    const member = message.member;
    if (!member) return;

    if (isExempt(member)) return;
    
    // Get bot member to check permissions
    const botMember = message.guild.members.me;
    
    // Debug logging
    console.log(`\n🎯 Attempting timeout for ${member.user.tag}`);
    console.log(`   Bot's highest role: ${botMember.roles.highest.name} (position: ${botMember.roles.highest.position})`);
    console.log(`   Target's highest role: ${member.roles.highest.name} (position: ${member.roles.highest.position})`);
    console.log(`   Bot has ModerateMembers: ${botMember.permissions.has('ModerateMembers')}`);
    console.log(`   Bot has Administrator: ${botMember.permissions.has('Administrator')}`);
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
    for (const [roleIdentifier, chance] of HIGH_CHANCE_ROLES) {
      // Check by both role name and role ID
      if (member.roles.cache.some(role => role.name === roleIdentifier || role.id === roleIdentifier)) {
        timeoutChance = Math.max(timeoutChance, chance); // Use highest chance if multiple roles
        console.log(`   🎲 Higher chance detected (${roleIdentifier}): ${(chance * 100).toFixed(1)}%`);
        break;
      }
    }

    // chance roll
    if (Math.random() >= timeoutChance) return;

    // apply timeout
    const durSeconds = Math.round(TIMEOUT_MS / 1000);
    try {
    // requires "Moderate Members" permission for the bot and that bot's role is above target
    await member.timeout(TIMEOUT_MS, 'Random timeout');
    // record explosion for leaderboard
    recordExplosion(member);
    cooldowns.set(member.id, Date.now());
    // reply with ephemeral-ish fun message (public)
    await message.channel.send(`${member}, Boom! `);
    console.log(`Timed out ${member.user.tag} for ${durSeconds}s in ${message.guild.name}/${message.channel.name}`);
    } catch (err) {
      console.error('Failed to timeout member:', err.message);
      // Don't send error message in channel to avoid spam
    }
  } catch (err) {
    console.error(err);
  }
});

// Handle slash command interactions
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  
  if (interaction.commandName === 'roll') {
    try {
      const botMember = interaction.guild.members.me;
      
      // Check if bot has permissions
      if (!botMember.permissions.has('ModerateMembers')) {
        await interaction.reply({ content: 'I need the "Moderate Members" permission to use this command!', flags: MessageFlags.Ephemeral });
        return;
      }

      // Check cooldown for /roll command (server owner bypasses cooldown)
      const userId = interaction.user.id;
      const isOwner = interaction.guild.ownerId === userId;
      
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
            const timeForThisCharge = 3600000 + (i * 1800000); // 1hr + (i * 30min)
            cumulativeTime += timeForThisCharge;
            if (timeSinceLastRoll >= cumulativeTime) {
              chargesGained++;
            } else {
              break;
            }
          }
          
          availableCharges = Math.min(MAX_ROLL_CHARGES, userData.charges + chargesGained);
          
          // Debug log
          console.log(`[ROLL COOLDOWN] User ${userId}: charges=${userData.charges}, timeSince=${Math.floor(timeSinceLastRoll/1000)}s, gained=${chargesGained}, available=${availableCharges}`);
        } else {
          // New user starts with 1 charge
          availableCharges = 1;
          console.log(`[ROLL COOLDOWN] New user ${userId}: starting with ${availableCharges} charge`);
        }
        
        console.log(`[ROLL COOLDOWN] User ${userId} attempting roll with ${availableCharges} charges available`);
        
        if (availableCharges <= 0) {
          // Calculate time until next charge
          const timeSinceLastRoll = now - userData.lastRoll;
          
          // Find the next charge threshold
          let nextChargeThreshold = 0;
          for (let i = 0; i < MAX_ROLL_CHARGES; i++) {
            const timeForThisCharge = 3600000 + (i * 1800000); // 1hr + (i * 30min)
            nextChargeThreshold += timeForThisCharge;
            if (timeSinceLastRoll < nextChargeThreshold) {
              // This is the next charge we're waiting for
              const timeUntilNextCharge = nextChargeThreshold - timeSinceLastRoll;
              const minutesRemaining = Math.ceil(timeUntilNextCharge / 60000);
              await interaction.reply({ content: `⏰ No rolls available! Next roll in ${minutesRemaining} minute(s).`, flags: MessageFlags.Ephemeral });
              return;
            }
          }
          
          // Fallback if somehow we got here
          await interaction.reply({ content: `⏰ No rolls available!`, flags: MessageFlags.Ephemeral });
          return;
        }
        
        // Consume one charge BEFORE deferReply to prevent race condition
        rollCooldowns.set(userId, { lastRoll: now, charges: availableCharges - 1 });
      }
      
      // Defer reply after passing all checks
      await interaction.deferReply();

      // Fetch guild members to ensure cache is populated
      try {
        await interaction.guild.members.fetch();
      } catch (e) {
        console.error('Failed to fetch guild members:', e);
      }

      // Get all non-bot members who aren't exempt
      const eligibleMembers = interaction.guild.members.cache.filter(member => {
        if (member.user.bot) return false;
        if (isExempt(member)) return false;
        if (!canTimeout(botMember, member)) return false;
        // Only target online/idle/dnd members (not offline)
        // if (!member.presence || member.presence.status === 'offline') return false;
        return true;
      });

      console.log(`[ROLL DEBUG] Total cached members: ${interaction.guild.members.cache.size}, Eligible: ${eligibleMembers.size}`);

      if (eligibleMembers.size === 0) {
        // Refund charge since no one can be exploded
        if (rollCooldownEnabled && !isOwner) {
          const userData = rollCooldowns.get(userId);
          if (userData) {
            rollCooldowns.set(userId, { lastRoll: userData.lastRoll, charges: Math.min(MAX_ROLL_CHARGES, userData.charges + 1) });
          }
        }
        await interaction.editReply({ content: 'No One to explode!' });
        return;
      }

      const diceRoll = Math.floor(Math.random() * 6) + 1; // Roll 1-6
      
      await interaction.editReply(`🎲 Rolling the dice... 🎲`);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Suspense!
      
      await interaction.editReply(`🎲 The dice shows **${diceRoll}**!`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Calculate timeout duration based on roll: 1 = 10s, 2 = 20s, ... 6 = 60s
      const rollTimeoutMs = diceRoll * TIMEOUT_MS;
      const durSeconds = Math.round(rollTimeoutMs / 1000);
      
      try {
        // Roll 1: Timeout the person who used the command
        if (diceRoll === 1) {
          const commandUser = interaction.member;
            if (!isExempt(commandUser) && canTimeout(botMember, commandUser)) {
            await commandUser.timeout(rollTimeoutMs, `Rolled a 1 - exploded themselves!`);
            recordExplosion(commandUser);
            await interaction.followUp(`💥 Oops! ${commandUser} rolled a **1** and exploded themselves! 😂`);
            console.log(`[ROLL] ${interaction.user.tag} rolled a 1 and exploded themselves`);
          } else {
            await interaction.followUp(`🍀 ${commandUser} got lucky! They rolled a **1** but have immunity!`);
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
            await interaction.followUp(`💥💥 ${targetMember} got DOUBLE exploded (Not enough people for 2 timeouts)`);
            console.log(`[ROLL] ${interaction.user.tag} rolled a 6 and exploded ${targetMember.user.tag}`);
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
            
            await firstMember.timeout(rollTimeoutMs, `Rolled a 6 by /roll command (victim 1)`);
            recordExplosion(firstMember);
            await secondMember.timeout(rollTimeoutMs, `Rolled a 6 by /roll command (victim 2)`);
            recordExplosion(secondMember);
            await interaction.followUp(`💥💥 DOUBLE KILL! ${firstMember} and ${secondMember} both got exploded!`);
            console.log(`[ROLL] ${interaction.user.tag} rolled a 6 and exploded ${firstMember.user.tag} and ${secondMember.user.tag}`);
          }
        }
        // Rolls 2-5: Timeout one random person
        else {
          const eligibleArray = Array.from(eligibleMembers.values());
          const targetIndex = Math.floor(Math.random() * eligibleArray.length);
          const targetMember = eligibleArray[targetIndex];
          
          await targetMember.timeout(rollTimeoutMs, `Rolled a ${diceRoll} by /roll command`);
          recordExplosion(targetMember);
          await interaction.followUp(`💥 ${targetMember} got exploded!`);
          console.log(`[ROLL] ${interaction.user.tag} rolled a ${diceRoll} and exploded ${targetMember.user.tag})`);
        }
        
        
        // 0.0001% (1 in a million) chance to kick someone
        if (Math.random() < 0.000001) {
          const eligibleArray = Array.from(eligibleMembers.values());
          if (eligibleArray.length > 0) {
            const unluckyMember = eligibleArray[Math.floor(Math.random() * eligibleArray.length)];
            try {
              await unluckyMember.kick('ULTRA RARE EVENT: 1 in a million roll!');
              await interaction.followUp(`🌟✨💀 **ULTRA RARE EVENT!** 🌟✨💀\n${unluckyMember.user.tag} just hit the 1 IN A MILLION chance and got KICKED from the server! 😱`);
              console.log(`[ULTRA RARE] ${interaction.user.tag} triggered 1 in a million event - kicked ${unluckyMember.user.tag}`);
              
              // Try to DM them the invite after kicking
              try {
                await unluckyMember.send(`You just hit the 1 IN A MILLION chance in ${interaction.guild.name}! 😱\nHere's the invite to rejoin: https://discord.gg/P8ZQZRjw29`);
              } catch (dmErr) {
                console.log(`Couldn't DM ${unluckyMember.user.tag} - they have DMs disabled or left mutual servers`);
              }
            } catch (err) {
              console.error(`Failed to kick ${unluckyMember.user.tag}:`, err.message);
            }
          }
        }
        // 0.2% chance to send an image and timeout everyone for 15 seconds
        else if (Math.random() < 0.002) {
          await interaction.followUp('https://media.discordapp.net/attachments/1423201741931024396/1442538744941907988/image.jpg?ex=692bbb25&is=692a69a5&hm=2b4933660848107d82e2d15eb2522e12d44d30b849a339a9625b7b306202fd7f&=&format=webp');
          await interaction.followUp(`${interaction.user.tag} launched a nuke and exploded everyone!`);
          
          // Timeout all eligible members for 15 seconds
          const allEligible = interaction.guild.members.cache.filter(member => {
            if (member.user.bot) return false;
            if (isExempt(member)) return false;
            if (!canTimeout(botMember, member)) return false;
            return true;
          });               
          
          let timeoutCount = 0;
          for (const [, member] of allEligible) {
            try {
              await member.timeout(15000, 'Mass timeout event!');
              recordExplosion(member);
              timeoutCount++;
            } catch (err) {
              console.error(`Failed to timeout ${member.user.tag}:`, err.message);
            }
          }
          
          if (timeoutCount > 0) {
            await interaction.followUp(`💥💥💥 EVERYONE GOT EXPLODED!💥💥💥`);
          }
        }
      } catch (err) {
        console.error('Failed to timeout member from /roll:', err.message);
        await interaction.followUp({ content: `⚠️ Couldn't explode them`, flags: MessageFlags.Ephemeral });
      }
    } catch (err) {
      console.error('Error in /roll command:', err);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '⚠️ An error occurred!', flags: MessageFlags.Ephemeral });
        } else {
          await interaction.followUp({ content: '⚠️ An error occurred!', flags: MessageFlags.Ephemeral });
        }
      } catch (e) {
        console.error('Failed to send error message:', e);
      }
    }
  }
  else if (interaction.commandName === 'rollcd') {
    try {
      // Defer reply immediately so Discord doesn't mark the interaction as unresponded
      await interaction.deferReply();

      // Only allow server owner or admin to use
      const isOwner = interaction.guild.ownerId === interaction.user.id;
      const isAdmin = interaction.member.permissions.has('Administrator');
      if (!isOwner && !isAdmin) {
        await interaction.editReply({ content: '❌ Only administrators or the server owner can use this command!', flags: MessageFlags.Ephemeral });
        return;
      }

      const enabled = interaction.options.getBoolean('enabled');
      rollCooldownEnabled = enabled;
      console.log(`rollCooldownEnabled set to: ${enabled}`);

      await interaction.editReply({ content: `/roll cooldown is now **${enabled ? 'ENABLED' : 'DISABLED'}**.`, flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.error('Error in /rollcd command (top-level):', err);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '⚠️ An error occurred!', flags: MessageFlags.Ephemeral });
        } else {
          await interaction.followUp({ content: '⚠️ An error occurred!', flags: MessageFlags.Ephemeral });
        }
      } catch (e) {
        console.error('Failed to send error message:', e);
      }
    }
  }
  else if (interaction.commandName === 'lb') {
    try {
      await interaction.deferReply();
      const requested = interaction.options.getInteger('count') ?? 10;
      const topN = Math.max(1, Math.min(50, requested));

      // Use guild-specific leaderboard
      const guildId = interaction.guild.id;
      const guildMap = explodedCounts.get(guildId) ?? new Map();
      const entries = Array.from(guildMap.entries());
      entries.sort((a, b) => b[1] - a[1]);

      if (entries.length === 0) {
        await interaction.editReply({ content: 'No explosions recorded in this server yet.' });
        return;
      }

      const slice = entries.slice(0, topN);
      const lines = [];
      let rank = 1;
      for (const [id, cnt] of slice) {
        let display = `<@${id}>`;
        try {
          const member = await interaction.guild.members.fetch(id);
          display = member.user.tag;
        } catch (e) {
          // keep mention fallback
        }
        lines.push(`${rank}. ${display} — ${cnt} explosions`);
        rank++;
      }

      await interaction.editReply({ content: `**Explosion Leaderboard (top ${slice.length})**\n${lines.join('\n')}` });
    } catch (err) {
      console.error('Error in /lb command:', err);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '⚠️ An error occurred!', flags: MessageFlags.Ephemeral });
        } else {
          await interaction.followUp({ content: '⚠️ An error occurred!', flags: MessageFlags.Ephemeral });
        }
      } catch (e) {
        console.error('Failed to send error message for /lb:', e);
      }
    }
  }
  else if (interaction.commandName === 'exp') {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // Permission check: Admin or Owner only
      const isOwner = interaction.guild.ownerId === interaction.user.id;
      const isAdmin = interaction.member.permissions.has('Administrator');
      if (!isOwner && !isAdmin) {
        await interaction.editReply({ content: 'Only admins can use this command.' });
        return;
      }

      const subCommand = interaction.options.getSubcommand();
      const targetUser = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      const guildId = interaction.guild.id;

      if (!explodedCounts.has(guildId)) {
        explodedCounts.set(guildId, new Map());
      }
      const guildMap = explodedCounts.get(guildId);
      
      const currentCount = guildMap.get(targetUser.id) ?? 0;
      let newCount = currentCount;
      let actionText = '';

      if (subCommand === 'add') {
        newCount = currentCount + amount;
        actionText = `added ${amount} to`;
      } else if (subCommand === 'remove') {
        newCount = Math.max(0, currentCount - amount);
        actionText = `removed ${amount} from`;
      } else if (subCommand === 'set') {
        newCount = Math.max(0, amount);
        actionText = `set to ${amount} for`;
      }

      guildMap.set(targetUser.id, newCount);
      saveLeaderboardDebounced();

      await interaction.editReply({ content: `✅ Successfully ${actionText} **${targetUser.tag}**. New total: **${newCount}** explosions.` });
      console.log(`[EXP] ${interaction.user.tag} (${subCommand}) ${amount} for ${targetUser.tag}. New total: ${newCount}`);

    } catch (err) {
      console.error('Error in /exp command:', err);
      try {
           if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '⚠️ An error occurred!', flags: MessageFlags.Ephemeral });
        } else {
          await interaction.followUp({ content: '⚠️ An error occurred!', flags: MessageFlags.Ephemeral });
        }
      } catch (e) { console.error('Failed to send error for /exp:', e); }
    }
  }
});

client.login(TOKEN);