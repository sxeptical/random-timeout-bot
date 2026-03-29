import { EmbedBuilder } from "discord.js";
import { getDataSafe } from "../../utils.js";
import { safeInteractionUpdate } from "../utils/helpers.js";
import { explodedCounts, saveLeaderboardDebounced } from "../data/leaderboard.js";

// Blackjack game sessions: Map<`${guildId}-${userId}`, { bet, playerHand, dealerHand, deck, status }>
export const blackjackGames = new Map();

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

export function createDeck() {
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

export function getCardValue(card) {
  if (["J", "Q", "K"].includes(card.value)) return 10;
  if (card.value === "A") return 11;
  return parseInt(card.value);
}

export function calculateHand(hand) {
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

export function formatCard(card) {
  return `${card.value}${card.suit}`;
}

export function formatHand(hand, hideSecond = false) {
  if (hideSecond && hand.length >= 2) {
    return `${formatCard(hand[0])} | ??`;
  }
  return hand.map(formatCard).join(" | ");
}

export async function handleDealerTurn(
  interaction,
  game,
  guildMap,
  userId,
  guildId,
  sessionKey,
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
      { name: "Result", value: resultText, inline: false },
    )
    .setColor(resultColor);

  await safeInteractionUpdate(interaction, { embeds: [embed], components: [] });
}
