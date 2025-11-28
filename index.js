// index.js
console.log('Starting bot...');
import 'dotenv/config';
console.log('dotenv loaded');
import { Client, GatewayIntentBits, Partials, Events, Collection } from 'discord.js';
console.log('discord.js imported');

const TOKEN = process.env.DISCORD_TOKEN;
console.log('TOKEN exists:', !!TOKEN);
if (!TOKEN) throw new Error('DISCORD_TOKEN missing in .env');

const WATCH_CHANNELS = process.env.CHANNEL_ALLOW ? process.env.CHANNEL_ALLOW.split(',').map(s => s.trim()).filter(Boolean) : null;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 10000);
const CHANCE = Number(process.env.CHANCE ?? 0.05);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 30000);

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

// per-user cooldown map
const cooldowns = new Map();

client.once(Events.ClientReady, () => {
  console.log(`\n✅ Bot is online and ready!`);
  console.log(`🤖 Logged in as ${client.user.tag}`);
  console.log(`📊 Watching ${client.guilds.cache.size} server(s)`);
  console.log(`🎲 Timeout chance: ${(CHANCE * 100).toFixed(0)}%`);
  console.log(`⏱️  Timeout duration: ${TIMEOUT_MS / 1000}s`);
  console.log(`⏳ Cooldown: ${COOLDOWN_MS / 1000}s\n`);
});

// helper: is user exempt
function isExempt(member) {
  if (!member) return true;
  // exempt bots
  if (member.user?.bot) return true;
  // exempt server owner
//   if (member.guild.ownerId === member.id) return true;
  // exempt administrators
//   if (member.permissions?.has('Administrator')) return true;
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
      await member.timeout(TIMEOUT_MS, 'Random fun timeout');
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

// /roll command - randomly timeout someone
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!message.content.toLowerCase().startsWith('/roll')) return;

    const botMember = message.guild.members.me;
    
    // Check if bot has permissions
    if (!botMember.permissions.has('ModerateMembers')) {
      await message.reply('I need the "Moderate Members" permission to use this command!');
      return;
    }

    // Get all non-bot members who aren't exempt
    const eligibleMembers = message.guild.members.cache.filter(member => {
      if (member.user.bot) return false;
      if (isExempt(member)) return false;
      if (!canTimeout(botMember, member)) return false;
      return true;
    });

    if (eligibleMembers.size === 0) {
      await message.reply('🎲 No eligible members to timeout!');
      return;
    }

    // Pick a random member
    const randomMember = eligibleMembers.random();
    const diceRoll = Math.floor(Math.random() * 6) + 1; // Roll 1-6
    
    await message.channel.send(`🎲 ${message.author} rolled the dice... 🎲`);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Suspense!
    
    await message.channel.send(`🎲 The dice shows **${diceRoll}**!`);
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Apply timeout
    const durSeconds = Math.round(TIMEOUT_MS / 1000);
    try {
      await randomMember.timeout(TIMEOUT_MS, `Randomly chosen by /roll command`);
      await message.channel.send(`💥 ${randomMember} got exploded randomly! Too bad.`);
      console.log(`[ROLL] ${message.author.tag} rolled and timed out ${randomMember.user.tag} for ${durSeconds}s`);
    } catch (err) {
      console.error('Failed to timeout member from /roll:', err.message);
      await message.reply(`Failed to timeout ${randomMember}.`);
    }
  } catch (err) {
    console.error('Error in /roll command:', err);
  }
});

client.login(TOKEN);
