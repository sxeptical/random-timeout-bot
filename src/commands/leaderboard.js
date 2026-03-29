import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { LEADERBOARD_PAGE_SIZE } from "../utils/constants.js";
import { explodedCounts } from "../data/leaderboard.js";

// Helper function to build leaderboard embed and buttons (DRY)
export async function buildLeaderboardEmbed(guild, guildId, page, lbType, userId) {
  const guildMap = explodedCounts.get(guildId) ?? new Map();
  const entries = Array.from(guildMap.entries());

  // Sort based on type
  if (lbType === "explosions") {
    entries.sort((a, b) => b[1].explosions - a[1].explosions);
  } else {
    entries.sort((a, b) => b[1].xp - a[1].xp);
  }

  if (entries.length === 0) {
    return { empty: true };
  }

  const totalPages = Math.ceil(entries.length / LEADERBOARD_PAGE_SIZE);
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const startIdx = (currentPage - 1) * LEADERBOARD_PAGE_SIZE;
  const slice = entries.slice(startIdx, startIdx + LEADERBOARD_PAGE_SIZE);

  // Build leaderboard lines
  const lines = [];
  for (let i = 0; i < slice.length; i++) {
    const [id, userData] = slice[i];
    const rank = startIdx + i + 1;
    let display = `User ${id.slice(-4)}`;
    try {
      const member = await guild.members.fetch(id);
      display = member.displayName;
    } catch (e) {
      // keep fallback
    }
    if (lbType === "explosions") {
      lines.push(
        `**${rank}.** ${display} • 💥 ${userData.explosions.toLocaleString()}`,
      );
    } else {
      lines.push(
        `**${rank}.** ${display} • **Level ${userData.level}** (${userData.xp.toLocaleString()} XP)`,
      );
    }
  }

  // Find user's rank
  const userRank = entries.findIndex(([id]) => id === userId);
  const userRankText =
    userRank >= 0 ? `Your rank: #${userRank + 1}` : "You have no data yet";

  // Create embed
  const title =
    lbType === "explosions"
      ? "💥 Explosions Leaderboard"
      : "⭐ XP Leaderboard";
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines.join("\n"))
    .setColor(0x2b2d31)
    .setFooter({
      text: `Page ${currentPage}/${totalPages} • ${userRankText}`,
    });

  // Create pagination buttons (include type in customId)
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`lb_prev_${guildId}_${currentPage}_${lbType}`)
      .setLabel("Previous Page")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage <= 1),
    new ButtonBuilder()
      .setCustomId(`lb_next_${guildId}_${currentPage}_${lbType}`)
      .setLabel("Next Page")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage >= totalPages),
  );

  return { embed, row, empty: false };
}
