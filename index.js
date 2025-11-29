// index.js
console.log('Starting bot...');
import 'dotenv/config';
console.log('dotenv loaded');
import { Client, GatewayIntentBits, Partials, Events, Collection, REST, Routes, MessageFlags } from 'discord.js';
console.log('discord.js imported');

const TOKEN = process.env.DISCORD_TOKEN;
console.log('TOKEN exists:', !!TOKEN);
if (!TOKEN) throw new Error('DISCORD_TOKEN missing in .env');

const WATCH_CHANNELS = process.env.CHANNEL_ALLOW ? process.env.CHANNEL_ALLOW.split(',').map(s => s.trim()).filter(Boolean) : null;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 10000);
const CHANCE = Number(process.env.CHANCE ?? 0.05);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 30000);
const ROLL_COOLDOWN_MS = 3600000; // 1 hour cooldown for /roll command

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
const rollCooldowns = new Map();

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
      description: 'Roll the dice and randomly explode someone!',
    },
    {
      name: 'nuke',
      description: 'Explode everyone for 15 seconds and send a nuke image!',
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
      } else if (interaction.commandName === 'nuke') {
        try {
          const botMember = interaction.guild.members.me;
          const isOwner = interaction.guild.ownerId === interaction.user.id;
          const isAdmin = interaction.member.permissions.has('Administrator');
          if (!isOwner && !isAdmin) {
            await interaction.reply({ content: 'Only administrators or the server owner can use this command!', flags: MessageFlags.Ephemeral });
            return;
          }
          if (!botMember.permissions.has('ModerateMembers')) {
            await interaction.reply({ content: 'I need the "Moderate Members" permission to use this command!', flags: MessageFlags.Ephemeral });
            return;
          }
          await interaction.deferReply();
          await interaction.editReply('https://media.discordapp.net/attachments/1423201741931024396/1442538744941907988/image.jpg?ex=692bbb25&is=692a69a5&hm=2b4933660848107d82e2d15eb2522e12d44d30b849a339a9625b7b306202fd7f&=&format=webp');
          // Explode all eligible members for 15 seconds
          const allEligible = interaction.guild.members.cache.filter(member => {
            if (member.user.bot) return false;
            if (isExempt(member)) return false;
            if (!canTimeout(botMember, member)) return false;
            return true;
          });
          let explodeCount = 0;
          for (const [, member] of allEligible) {
            try {
              await member.timeout(15000, 'Nuke explosion!');
              explodeCount++;
            } catch (err) {
              console.error(`Failed to explode ${member.user.tag}:`, err.message);
            }
          }
          if (explodeCount > 0) {
            await interaction.followUp(`💥💥💥 **NUKE LAUNCHED!** Everyone got exploded for 15 seconds! 💥💥💥`);
          } else {
            await interaction.followUp({ content: 'No one to explode!', flags: MessageFlags.Ephemeral });
          }
        } catch (err) {
          console.error('Error in /nuke command:', err);
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
      // Defer reply as soon as possible to avoid double reply errors
      await interaction.deferReply();
      if (!isOwner) {
        const lastRoll = rollCooldowns.get(userId) ?? 0;
        const timeSinceLastRoll = Date.now() - lastRoll;
        if (timeSinceLastRoll < ROLL_COOLDOWN_MS) {
          const timeRemaining = Math.ceil((ROLL_COOLDOWN_MS - timeSinceLastRoll) / 60000); // Convert to minutes
          await interaction.editReply({ content: `⏰ You need to wait ${timeRemaining} more minute(s) before rolling again!` });
          return;
        }
      }

      // Get all non-bot members who aren't exempt
      const eligibleMembers = interaction.guild.members.cache.filter(member => {
        if (member.user.bot) return false;
        if (isExempt(member)) return false;
        if (!canTimeout(botMember, member)) return false;
        return true;
      });

      if (eligibleMembers.size === 0) {
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
            await secondMember.timeout(rollTimeoutMs, `Rolled a 6 by /roll command (victim 2)`);
            await interaction.followUp(`💥💥 DOUBLE KILL! ${firstMember} and ${secondMember} both got exploded for!`);
            console.log(`[ROLL] ${interaction.user.tag} rolled a 6 and exploded ${firstMember.user.tag} and ${secondMember.user.tag}`);
          }
        }
        // Rolls 2-5: Timeout one random person
        else {
          const eligibleArray = Array.from(eligibleMembers.values());
          const targetIndex = Math.floor(Math.random() * eligibleArray.length);
          const targetMember = eligibleArray[targetIndex];
          
          await targetMember.timeout(rollTimeoutMs, `Rolled a ${diceRoll} by /roll command`);
          await interaction.followUp(`💥 ${targetMember} got exploded!`);
          console.log(`[ROLL] ${interaction.user.tag} rolled a ${diceRoll} and exploded ${targetMember.user.tag})`);
        }
        
        // Set cooldown after successful roll
        rollCooldowns.set(userId, Date.now());
        
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
});

client.login(TOKEN);
