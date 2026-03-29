import fs from "fs";
import { readFile, writeFile, mkdir, rename } from "fs/promises";
import path from "path";
import { logger } from "../utils/logger.js";
import { SAVE_DEBOUNCE_MS } from "../utils/constants.js";

const DATA_DIR = path.join(process.cwd(), "data");
const SCHEDULED_FILE = path.join(DATA_DIR, "scheduled.json");

// Scheduled events: Array<{ id, type, guildId, userId, roleId, executeAt, data }>
// Persisted to disk to survive restarts
export const scheduledEvents = [];
const _scheduledTimers = new Map(); // Map<eventId, timerId>

let _scheduledSaveTimer = null;

// Client reference - set via setClient() from main module
let _client = null;

export function setClient(client) {
  _client = client;
}

async function ensureDataDir() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
  } catch (e) {
    /* ignore */
  }
}

export async function loadScheduledEvents() {
  try {
    await ensureDataDir();
    if (!fs.existsSync(SCHEDULED_FILE)) return;
    const raw = await readFile(SCHEDULED_FILE, "utf8");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    scheduledEvents.length = 0;
    scheduledEvents.push(...parsed);
    logger.info("Loaded scheduled events from", SCHEDULED_FILE);
  } catch (e) {
    logger.error("Failed to load scheduled events:", e);
  }
}

export async function saveScheduledEvents() {
  try {
    await ensureDataDir();
    const tmp = SCHEDULED_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(scheduledEvents), "utf8");
    await rename(tmp, SCHEDULED_FILE);
  } catch (e) {
    logger.error("Failed to save scheduled events:", e);
  }
}

export function saveScheduledEventsDebounced() {
  if (_scheduledSaveTimer) clearTimeout(_scheduledSaveTimer);
  _scheduledSaveTimer = setTimeout(async () => {
    await saveScheduledEvents();
    _scheduledSaveTimer = null;
  }, SAVE_DEBOUNCE_MS);
}

// Execute a scheduled event
export async function executeScheduledEvent(event) {
  try {
    // Remove from timers
    _scheduledTimers.delete(event.id);

    // Remove from scheduled events
    const idx = scheduledEvents.findIndex((e) => e.id === event.id);
    if (idx !== -1) {
      scheduledEvents.splice(idx, 1);
      saveScheduledEventsDebounced();
    }

    // Execute based on type
    if (event.type === "remove_role") {
      if (!_client) {
        logger.warn("Client not set, cannot execute scheduled event");
        return;
      }

      const guild = _client.guilds.cache.get(event.guildId);
      if (!guild) {
        logger.warn(`Guild ${event.guildId} not found for scheduled event`);
        return;
      }

      try {
        const member = await guild.members.fetch(event.userId);
        const role = guild.roles.cache.get(event.roleId);

        if (member && role && member.roles.cache.has(event.roleId)) {
          await member.roles.remove(
            role,
            event.reason || "Scheduled role removal",
          );
          logger.info(
            `Removed role ${role.name} from ${member.user.tag} (scheduled event)`,
          );
        }
      } catch (err) {
        logger.error(`Failed to execute scheduled role removal:`, err.message);
      }
    }
  } catch (err) {
    logger.error("Error executing scheduled event:", err);
  }
}

// Schedule an event to execute at a specific time
export function scheduleEvent(event) {
  const id = `${event.type}_${event.guildId}_${event.userId}_${Date.now()}`;
  const fullEvent = { ...event, id };
  scheduledEvents.push(fullEvent);
  saveScheduledEventsDebounced();

  // Set up the timer
  const delay = fullEvent.executeAt - Date.now();
  if (delay > 0) {
    const timerId = setTimeout(() => executeScheduledEvent(fullEvent), delay);
    _scheduledTimers.set(id, timerId);
  } else {
    // Execute immediately if the time has passed
    executeScheduledEvent(fullEvent);
  }

  return id;
}

// Cancel a scheduled event
export function cancelScheduledEvent(eventId) {
  const timerId = _scheduledTimers.get(eventId);
  if (timerId) {
    clearTimeout(timerId);
    _scheduledTimers.delete(eventId);
  }

  const idx = scheduledEvents.findIndex((e) => e.id === eventId);
  if (idx !== -1) {
    scheduledEvents.splice(idx, 1);
    saveScheduledEventsDebounced();
    return true;
  }
  return false;
}

// Restore scheduled events on startup
export function restoreScheduledEvents() {
  const now = Date.now();
  const eventsToProcess = [...scheduledEvents];

  for (const event of eventsToProcess) {
    const delay = event.executeAt - now;
    if (delay > 0) {
      // Schedule for future execution
      const timerId = setTimeout(() => executeScheduledEvent(event), delay);
      _scheduledTimers.set(event.id, timerId);
      logger.debug(
        `Restored scheduled event ${event.id} for ${new Date(event.executeAt).toISOString()}`,
      );
    } else {
      // Execute immediately if past due
      logger.info(`Executing past-due scheduled event ${event.id}`);
      executeScheduledEvent(event);
    }
  }
}
