/**
 * Utility functions for the random-timeout-bot
 */

/**
 * Get the XP required to reach a specific level.
 * Uses a simple quadratic formula: 100 * level^2
 * @param {number} level - The level to calculate XP for
 * @returns {number} The total XP required to reach that level
 */
export function getXpForLevel(level) {
    return 100 * level * level;
}

/**
 * Calculate the level from a given XP amount.
 * Inverse of getXpForLevel: level = floor(sqrt(xp / 100))
 * @param {number} xp - The XP amount
 * @returns {number} The level for that XP amount
 */
export function getLevelFromXp(xp) {
    if (xp <= 0) return 0;
    return Math.floor(Math.sqrt(xp / 100));
}

/**
 * Safely get user data from a guild map, creating default data if not exists.
 * @param {Map} guildMap - The guild's user data map
 * @param {string} userId - The user's ID
 * @returns {Object} The user's data object with explosions, xp, and level
 */
export function getDataSafe(guildMap, userId) {
    if (!guildMap.has(userId)) {
        guildMap.set(userId, { explosions: 0, xp: 0, level: 0 });
    }
    return guildMap.get(userId);
}
