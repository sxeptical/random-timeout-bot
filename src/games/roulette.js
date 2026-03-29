// Roulette game constants and helpers

export const ROULETTE_RED = [
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
];

export const ROULETTE_BLACK = [
  2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35,
];

export function getRouletteColor(number) {
  if (ROULETTE_RED.includes(number)) {
    return { color: "red", emoji: "🔴" };
  } else if (ROULETTE_BLACK.includes(number)) {
    return { color: "black", emoji: "⚫" };
  }
  return { color: "green", emoji: "🟢" };
}

export function checkRouletteBet(bettingSpace, number, color) {
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
      } else {
        // Invalid betting space
        return { valid: false };
      }
      break;
  }

  return { valid: true, won, multiplier };
}
