# 🎲 Random Timeout Bot

A fun Discord bot that randomly times out server members with various interactive features including dice rolling mechanics and surprise mass timeout events!

[![Add to Discord](https://img.shields.io/badge/Add%20to-Discord-7289DA?style=for-the-badge&logo=discord&logoColor=white)](https://discord.com/oauth2/authorize?client_id=1443608019010322545&permissions=8&integration_type=0&scope=bot+applications.commands)


## ✨ Features

### 🎯 Random Timeout System
- Randomly times out users who send messages based on a configurable chance
- Configurable timeout duration and cooldown periods
- Role-based chance multipliers for specific roles
- Smart exemption system (bots, moderators, admins)

### 🎲 /roll Command
An interactive dice rolling slash command with escalating consequences:

- **Roll 1**: You timeout yourself! (10 seconds)
- **Roll 2-5**: Timeout a random member (20-50 seconds based on roll)
- **Roll 6**: DOUBLE KILL! Timeout TWO random members (60 seconds each)
- **0.2% Secret Chance**: Mass timeout event - everyone gets timed out for 15 seconds! 💥

Higher rolls = longer timeout durations (roll × base timeout duration)

### ⏰ Cooldown System
- Standard random timeout: 10 seconds cooldown
- /roll command: 1 hour cooldown per user

## 🚀 Setup

### Prerequisites
- Node.js (v16 or higher)
- A Discord Bot Token
- Bot permissions: `Moderate Members`, `Send Messages`, `Read Messages/View Channels`
- OAuth2 Scopes: `bot` and `applications.commands`

### Installation

1. Clone the repository:
```bash
git clone https://github.com/sxeptical/random-timeout-bot.git
cd random-timeout-bot
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory:
```env
DISCORD_TOKEN=your_bot_token_here
TIMEOUT_MS=10000
CHANCE=0.05
COOLDOWN_MS=30000
CHANNEL_ALLOW=channel_id_1,channel_id_2
HIGH_CHANCE_ROLES=RoleName:0.5,AnotherRole:0.75
```

4. Start the bot:
```bash
npm start
```

## ⚙️ Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DISCORD_TOKEN` | Your Discord bot token | Required |
| `TIMEOUT_MS` | Base timeout duration in milliseconds | 10000 (10s) |
| `CHANCE` | Base probability of random timeout (0-1) | 0.05 (5%) |
| `COOLDOWN_MS` | Cooldown between random timeouts per user | 30000 (30s) |
| `CHANNEL_ALLOW` | Comma-separated channel IDs to watch (leave empty for all) | None |
| `HIGH_CHANCE_ROLES` | Role-based timeout multipliers (format: `RoleName:0.5,RoleID:0.75`) | None |

### Exempt Roles

By default, users with these roles are exempt from timeouts:
- `Moderator`
- `Admin`
- `NoTimeout`

Edit the `exemptRoleNames` array in `index.js` to customize.

## 📝 Commands

### `/roll`
Roll the dice and randomly timeout someone (or yourself)!

**Usage:** Simply type `/roll` in any channel

**Outcomes:**
- 🎲 **1**: Timeout yourself for 10 seconds
- 🎲 **2-5**: Timeout 1 random member (20s, 30s, 40s, or 50s)
- 🎲 **6**: Timeout 2 random members for 60 seconds each
- 💥 **0.2% Surprise**: Mass timeout event!

**Cooldown:** 1 hour per user

## 🛠️ Development

Run in development mode with auto-restart:
```bash
npm run dev
```

## 📋 Requirements

- discord.js ^14.25.1
- dotenv ^17.2.3
- Node.js v16+

## 🔒 Permissions

The bot requires these Discord permissions:
- **Moderate Members** - To timeout users
- **Send Messages** - To send responses
- **Read Messages/View Channels** - To monitor messages


## 🤝 Contributing

Feel free to open issues or submit pull requests!

## ⚠️ Disclaimer

This bot is meant for fun and should be used responsibly. Make sure your server members are okay with random timeout mechanics before deploying.
