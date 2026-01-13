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
    if (typeof val === "number") {
        val = { explosions: val, xp: 0, level: 1 };
        guildMap.set(userId, val);
    }
    return val || { explosions: 0, xp: 0, level: 1 };
}
