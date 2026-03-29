// Time constants (replacing magic numbers)
export const ONE_MINUTE_MS = 60 * 1000;
export const FIVE_MINUTES_MS = 5 * 60 * 1000;
export const THIRTY_MINUTES_MS = 30 * 60 * 1000;
export const ONE_HOUR_MS = 60 * 60 * 1000;
export const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

// Game/feature specific timing
export const MASS_TIMEOUT_DURATION_MS = 15 * 1000; // 15 seconds for mass timeout event
export const SPIN_DECISION_TIMEOUT_MS = ONE_MINUTE_MS; // 1 minute to decide on double-or-nothing
export const BLACKJACK_GAME_TIMEOUT_MS = FIVE_MINUTES_MS; // 5 minutes before game expires
export const ANIMATION_DELAY_MS = 500; // Delay for spinning animations
export const SUSPENSE_DELAY_MS = 1000; // Delay for building suspense
export const DOUBLE_OR_NOTHING_DELAY_MS = 1500; // Delay before double-or-nothing result

// Pagination
export const LEADERBOARD_PAGE_SIZE = 10; // Number of entries per leaderboard page

// Persistence
export const SAVE_DEBOUNCE_MS = 2000; // debounce writes

// Spin Wheel Constants
export const SPIN_ADMIN_ROLE_NAME = "Spin Winner"; // Role name for spin winners
export const MAX_SPINS_PER_MONTH = 5; // Max 5 people can spin per month

// Environment-based configuration
export const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 10000);
export const CHANCE = Number(process.env.CHANCE ?? 0.05);
export const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 30000);
export const ROLL_COOLDOWN_MS = Number(process.env.ROLL_COOLDOWN_MS ?? 3600000);
export const MAX_ROLL_CHARGES = Number(process.env.MAX_ROLL_CHARGES ?? 3);
export const ROLL_BANNED_ROLE = process.env.ROLL_BANNED_ROLE ?? "";
export const REJOIN_INVITE_URL = process.env.REJOIN_INVITE_URL ?? "";

// Parse watch channels
export const WATCH_CHANNELS = process.env.CHANNEL_ALLOW
  ? process.env.CHANNEL_ALLOW.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : null;

// Parse high chance roles (format: RoleNameOrID:0.5,AnotherRoleOrID:0.75)
export const HIGH_CHANCE_ROLES = new Map();
if (process.env.HIGH_CHANCE_ROLES) {
  process.env.HIGH_CHANCE_ROLES.split(",").forEach((pair) => {
    const [roleIdentifier, chance] = pair.split(":").map((s) => s.trim());
    if (roleIdentifier && chance) {
      HIGH_CHANCE_ROLES.set(roleIdentifier, Number(chance));
    }
  });
}
