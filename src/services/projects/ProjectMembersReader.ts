import * as fs from "node:fs/promises";
import { join } from "node:path";
import { getTenexBasePath } from "@/constants";
import { fileExists } from "@/lib/fs";
import { logger } from "@/utils/logger";
import { readPersistedProjectEvent } from "./projectEventStore";

/**
 * Canonical reader for project membership.
 *
 * The project's kind:31933 Nostr event is persisted to disk at
 *   ~/.tenex/projects/<dTag>/event.json
 * as raw NDKEvent JSON (see `projectEventStore`). The agent pubkeys belonging
 * to a project are the values of the `p` tags on that event.
 *
 * This module is the single source of truth for:
 *   - which agent pubkeys belong to a project (`readProjectAgentPubkeys`)
 *   - which projects exist on disk (`listProjectDTagsOnDisk`)
 *
 * The Rust whitelist daemon owns the file watcher; the TypeScript side only reads.
 */

interface RawProjectEvent {
    tags?: unknown[];
}

function projectsBasePath(): string {
    return join(getTenexBasePath(), "projects");
}

/**
 * Read the agent pubkeys (p-tag values) for a project from its on-disk event.json.
 *
 * Returns an empty array if the project directory or event.json file does not exist,
 * or if the file is malformed.
 */
export async function readProjectAgentPubkeys(dTag: string): Promise<string[]> {
    let parsed: RawProjectEvent | null;
    try {
        parsed = (await readPersistedProjectEvent(dTag)) as RawProjectEvent | null;
    } catch (error) {
        logger.warn("Failed to read project event.json", {
            dTag,
            error: error instanceof Error ? error.message : String(error),
        });
        return [];
    }

    if (!parsed) {
        return [];
    }

    const tags = Array.isArray(parsed.tags) ? parsed.tags : [];
    const pubkeys: string[] = [];
    const seen = new Set<string>();
    for (const tag of tags) {
        if (!Array.isArray(tag)) continue;
        if (tag[0] !== "p") continue;
        const value = tag[1];
        if (typeof value !== "string" || value.length === 0) continue;
        if (seen.has(value)) continue;
        seen.add(value);
        pubkeys.push(value);
    }
    return pubkeys;
}

/**
 * List every project dTag that has an event.json on disk.
 */
export async function listProjectDTagsOnDisk(): Promise<string[]> {
    const base = projectsBasePath();

    let entries: import("node:fs").Dirent[];
    try {
        entries = await fs.readdir(base, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        throw error;
    }

    const dTags: string[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const eventPath = join(base, entry.name, "event.json");
        if (await fileExists(eventPath)) {
            dTags.push(entry.name);
        }
    }
    return dTags;
}

/**
 * Reverse lookup: return every dTag whose event.json contains the given pubkey as a p-tag.
 */
export async function listProjectsForAgent(pubkey: string): Promise<string[]> {
    const dTags = await listProjectDTagsOnDisk();
    const matches: string[] = [];
    for (const dTag of dTags) {
        const pubkeys = await readProjectAgentPubkeys(dTag);
        if (pubkeys.includes(pubkey)) {
            matches.push(dTag);
        }
    }
    return matches;
}

/**
 * Collect every agent pubkey across every project on disk.
 */
export async function collectAllProjectAgentPubkeys(): Promise<Set<string>> {
    const dTags = await listProjectDTagsOnDisk();
    const all = new Set<string>();
    for (const dTag of dTags) {
        const pubkeys = await readProjectAgentPubkeys(dTag);
        for (const pubkey of pubkeys) {
            all.add(pubkey);
        }
    }
    return all;
}
