import fs from "fs";
import { readFile, writeFile, mkdir, rename } from "fs/promises";
import path from "path";
import { logger } from "../utils/logger.js";
import { SAVE_DEBOUNCE_MS, MAX_SPINS_PER_MONTH } from "../utils/constants.js";
import { getCurrentMonth } from "../utils/helpers.js";

const DATA_DIR = path.join(process.cwd(), "data");
const SPIN_FILE = path.join(DATA_DIR, "spin.json");

// Spin data: Map<guildId, { month: "YYYY-MM", users: [{ id, timestamp, result }] }>
export const spinData = new Map();

// Active spin sessions (for double-or-nothing): Map<`${guildId}-${userId}`, { expires, stage, roleId }>
export const activeSpinSessions = new Map();

let _spinSaveTimer = null;

async function ensureDataDir() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
  } catch (e) {
    /* ignore */
  }
}

export async function loadSpinData() {
  try {
    await ensureDataDir();
    if (!fs.existsSync(SPIN_FILE)) return;
    const raw = await readFile(SPIN_FILE, "utf8");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    for (const [guildId, data] of Object.entries(parsed)) {
      spinData.set(guildId, data);
    }
    logger.info("Loaded spin data from", SPIN_FILE);
  } catch (e) {
    logger.error("Failed to load spin data:", e);
  }
}

export async function saveSpinData() {
  try {
    await ensureDataDir();
    const obj = {};
    for (const [guildId, data] of spinData.entries()) {
      obj[guildId] = data;
    }
    const tmp = SPIN_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(obj), "utf8");
    await rename(tmp, SPIN_FILE);
  } catch (e) {
    logger.error("Failed to save spin data:", e);
  }
}

export function saveSpinDataDebounced() {
  if (_spinSaveTimer) clearTimeout(_spinSaveTimer);
  _spinSaveTimer = setTimeout(async () => {
    await saveSpinData();
    _spinSaveTimer = null;
  }, SAVE_DEBOUNCE_MS);
}

// Helper: Get or initialize guild spin data for current month
export function getGuildSpinData(guildId) {
  const currentMonth = getCurrentMonth();
  let guildData = spinData.get(guildId);

  // Reset if month changed
  if (!guildData || guildData.month !== currentMonth) {
    guildData = { month: currentMonth, users: [] };
    spinData.set(guildId, guildData);
  }

  return guildData;
}
