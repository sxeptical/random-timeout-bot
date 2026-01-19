/**
 * Calculates Level from XP using a quadratic curve.
 * Formula: Level = floor(0.1 * sqrt(XP)) + 1
 * @param {number} xp
 * @returns {number} level
 */
export function getLevelFromXp(xp) {
  return Math.floor(0.1 * Math.sqrt(xp)) + 1;
}

/**
 * Calculates minimum XP required to reach a specific level.
 * @param {number} level
 * @returns {number} xp
 */
export function getXpForLevel(level) {
  if (level <= 1) return 0;
  return Math.pow((level - 1) / 0.1, 2);
}

/**
 * Safely retrieves user data from the map, handling migration from legacy number format.
 * @param {Map} guildMap
 * @param {string} userId
 * @returns {object} { explosions, xp, level }
 */
export function getDataSafe(guildMap, userId) {
  let val = guildMap.get(userId);

  // Handle legacy number format (or if map somehow stores a number)
  if (typeof val === "number") {
    val = { explosions: isNaN(val) ? 0 : val, xp: 0, level: 1 };
    guildMap.set(userId, val);
  }

  // Handle null/undefined or incomplete objects
  if (!val) {
    const newUser = { explosions: 0, xp: 0, level: 1 };
    // Only set if it was explicitly requested? No, we just return default.
    // Usually usage implies we want to modify or read.
    return newUser;
  }

  // Sanitize properties to prevent NaN propagation
  if (typeof val.explosions !== "number" || isNaN(val.explosions)) {
    val.explosions = 0;
  }
  if (typeof val.xp !== "number" || isNaN(val.xp)) {
    val.xp = 0;
  }
  if (typeof val.level !== "number" || isNaN(val.level)) {
    val.level = 1;
  }

  return val;
}
