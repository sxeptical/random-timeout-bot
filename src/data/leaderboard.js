import fs from "fs";
import { readFile, writeFile, mkdir, rename } from "fs/promises";
import path from "path";
import { logger } from "../utils/logger.js";
import { SAVE_DEBOUNCE_MS } from "../utils/constants.js";
import { getDataSafe } from "../../utils.js";

const DATA_DIR = path.join(process.cwd(), "data");
const LB_FILE = path.join(DATA_DIR, "leaderboard.json");

// Explosion leaderboard (in-memory), scoped per guild: Map<guildId, Map<userId, userData>>
export const explodedCounts = new Map();

let _saveTimer = null;

async function ensureDataDir() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
  } catch (e) {
    /* ignore */
  }
}

export async function loadLeaderboard() {
  try {
    await ensureDataDir();
    if (!fs.existsSync(LB_FILE)) return;
    const raw = await readFile(LB_FILE, "utf8");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    for (const [guildId, guildObj] of Object.entries(parsed)) {
      const gmap = new Map();
      for (const [userId, val] of Object.entries(guildObj)) {
        if (val === null || val === undefined) continue;

        // Migration: If value is number, convert to object
        if (typeof val === "number") {
          gmap.set(userId, {
            explosions: isNaN(val) ? 0 : val,
            xp: 0,
            level: 1,
          });
        } else {
          // Ensure structure and sanitize matches
          gmap.set(userId, {
            explosions:
              typeof val.explosions === "number" && !isNaN(val.explosions)
                ? val.explosions
                : 0,
            xp: typeof val.xp === "number" && !isNaN(val.xp) ? val.xp : 0,
            level:
              typeof val.level === "number" && !isNaN(val.level)
                ? val.level
                : 1,
          });
        }
      }
      explodedCounts.set(guildId, gmap);
    }
    logger.info("Loaded leaderboard from", LB_FILE);
  } catch (e) {
    logger.error("Failed to load leaderboard:", e);
  }
}

export async function saveLeaderboard() {
  try {
    await ensureDataDir();
    const obj = {};
    for (const [guildId, gmap] of explodedCounts.entries()) {
      obj[guildId] = Object.fromEntries(gmap);
    }
    const tmp = LB_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(obj), "utf8");
    await rename(tmp, LB_FILE);
  } catch (e) {
    logger.error("Failed to save leaderboard:", e);
  }
}

export function saveLeaderboardDebounced() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    await saveLeaderboard();
    _saveTimer = null;
  }, SAVE_DEBOUNCE_MS);
}

export function recordExplosion(member) {
  try {
    const userId = member?.id ?? member?.user?.id;
    const guildId = member?.guild?.id ?? "global";
    if (!userId) return;
    if (!explodedCounts.has(guildId)) explodedCounts.set(guildId, new Map());
    const guildMap = explodedCounts.get(guildId);

    // Get current data (with migration fallback)
    let userData = getDataSafe(guildMap, userId);

    // Update explosions
    userData.explosions = (userData.explosions || 0) + 1;

    guildMap.set(userId, userData);

    // persist to disk (debounced)
    try {
      saveLeaderboardDebounced();
    } catch (e) {
      logger.error("Save debounce failed:", e);
    }
  } catch (e) {
    logger.error("Failed to record explosion:", e);
  }
}
