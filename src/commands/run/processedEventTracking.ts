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

export async function loadProcessedEvents(projectPath: string): Promise<void> {
    const storePath = getStorePath(projectPath);

    try {
        // Ensure .tenex directory exists
        const tenexDir = join(storePath, "..");
        if (!existsSync(tenexDir)) {
            await mkdir(tenexDir, { recursive: true });
        }

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

export function hasProcessedEvent(eventId: string): boolean {
    return processedEventIds.has(eventId);
}

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
        const tenexDir = join(storePath, "..");
        if (!existsSync(tenexDir)) {
            await mkdir(tenexDir, { recursive: true });
        }

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

export async function flushProcessedEvents(projectPath: string): Promise<void> {
    // Cancel any pending saves and save immediately
    if (saveDebounceTimeout) {
        clearTimeout(saveDebounceTimeout);
        saveDebounceTimeout = null;
    }
    await saveProcessedEvents(projectPath);
}

export function clearProcessedEvents(): void {
    processedEventIds.clear();
    if (saveDebounceTimeout) {
        clearTimeout(saveDebounceTimeout);
        saveDebounceTimeout = null;
    }
}

export function getProcessedEventCount(): number {
    return processedEventIds.size;
}
