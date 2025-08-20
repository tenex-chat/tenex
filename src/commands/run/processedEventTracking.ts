import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@/utils/logger";

// State management
const processedEventIds = new Set<string>();
let saveDebounceTimeout: NodeJS.Timeout | null = null;
const SAVE_DEBOUNCE_MS = 1000; // Save at most once per second

function getStorePath(projectPath: string): string {
  return join(projectPath, ".tenex", "processed-events.json");
}

async function ensureTenexDirectory(storePath: string): Promise<void> {
  const tenexDir = join(storePath, "..");
  if (!existsSync(tenexDir)) {
    await mkdir(tenexDir, { recursive: true });
  }
}

/**
 * Load processed event IDs from disk storage
 * @param projectPath - The path to the project directory
 */
export async function loadProcessedEvents(projectPath: string): Promise<void> {
  const storePath = getStorePath(projectPath);

  try {
    // Ensure .tenex directory exists
    await ensureTenexDirectory(storePath);

    // Load existing processed event IDs if file exists
    if (existsSync(storePath)) {
      const data = await readFile(storePath, "utf-8");
      const parsed = JSON.parse(data);

      if (Array.isArray(parsed.eventIds)) {
        processedEventIds.clear();
        for (const id of parsed.eventIds) {
          processedEventIds.add(id);
        }
      } else {
        logger.warn("Invalid processed events file format, starting fresh");
      }
    } else {
      logger.info("No processed events file found, starting fresh");
    }
  } catch (error) {
    logger.error("Failed to load processed event IDs:", error);
    // Continue with empty set on error
  }
}

/**
 * Check if an event has already been processed
 * @param eventId - The ID of the event to check
 * @returns True if the event has been processed, false otherwise
 */
export function hasProcessedEvent(eventId: string): boolean {
  return processedEventIds.has(eventId);
}

/**
 * Add an event ID to the processed set and schedule a save
 * @param projectPath - The path to the project directory
 * @param eventId - The ID of the event to mark as processed
 */
export function addProcessedEvent(projectPath: string, eventId: string): void {
  processedEventIds.add(eventId);
  debouncedSave(projectPath);
}

function debouncedSave(projectPath: string): void {
  // Clear existing timeout
  if (saveDebounceTimeout) {
    clearTimeout(saveDebounceTimeout);
  }

  // Set new timeout
  saveDebounceTimeout = setTimeout(() => {
    saveProcessedEvents(projectPath).catch((error) => {
      logger.error("Failed to save processed event IDs:", error);
    });
  }, SAVE_DEBOUNCE_MS);
}

async function saveProcessedEvents(projectPath: string): Promise<void> {
  const storePath = getStorePath(projectPath);

  try {
    // Ensure directory exists before saving
    await ensureTenexDirectory(storePath);

    // Convert Set to Array for JSON serialization
    const eventIds = Array.from(processedEventIds);

    const data = {
      eventIds,
      lastUpdated: new Date().toISOString(),
      totalCount: eventIds.length,
    };

    await writeFile(storePath, JSON.stringify(data, null, 2));
    logger.debug(`Saved ${eventIds.length} processed event IDs to disk`);
  } catch (error) {
    logger.error("Failed to save processed event IDs:", error);
  }
}

/**
 * Immediately save all processed events to disk, canceling any pending saves
 * @param projectPath - The path to the project directory
 */
export async function flushProcessedEvents(projectPath: string): Promise<void> {
  // Cancel any pending saves and save immediately
  if (saveDebounceTimeout) {
    clearTimeout(saveDebounceTimeout);
    saveDebounceTimeout = null;
  }
  await saveProcessedEvents(projectPath);
}

/**
 * Clear all processed event IDs from memory and cancel any pending saves
 */
export function clearProcessedEvents(): void {
  processedEventIds.clear();
  if (saveDebounceTimeout) {
    clearTimeout(saveDebounceTimeout);
    saveDebounceTimeout = null;
  }
}

/**
 * Get the total number of processed events
 * @returns The count of processed event IDs
 */
export function getProcessedEventCount(): number {
  return processedEventIds.size;
}
