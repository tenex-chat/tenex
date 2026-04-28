import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { getTenexBasePath } from "@/constants";
import type { ProjectDTag } from "@/types/project-ids";

const PROJECTS_DIR = "projects";
const EVENT_FILE = "event.json";

function projectDir(dTag: ProjectDTag | string): string {
    return join(getTenexBasePath(), PROJECTS_DIR, dTag);
}

function eventPath(dTag: ProjectDTag | string): string {
    return join(projectDir(dTag), EVENT_FILE);
}

/**
 * Persist a kind:31933 project event as raw NDKEvent JSON at
 * `<TENEX_BASE_DIR>/projects/<dTag>/event.json`.
 *
 * Atomic write (tmp + rename) so cross-process readers (e.g. the whitelist
 * daemon's fs watcher) never observe a partially-written file.
 */
export async function persistProjectEvent(dTag: ProjectDTag | string, event: NDKEvent): Promise<void> {
    const dir = projectDir(dTag);
    await fs.mkdir(dir, { recursive: true });

    const finalPath = eventPath(dTag);
    const tmpPath = `${finalPath}.tmp-${process.pid}`;
    const payload = `${JSON.stringify(event.rawEvent(), null, 2)}\n`;

    await fs.writeFile(tmpPath, payload);
    await fs.rename(tmpPath, finalPath);
}

/**
 * Remove the persisted event.json for a project. No-op if the file is absent.
 */
export async function removePersistedProjectEvent(dTag: ProjectDTag | string): Promise<void> {
    try {
        await fs.unlink(eventPath(dTag));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
}

/**
 * Read the persisted raw NDKEvent JSON for a project, or null if absent.
 * Callers parse the payload according to NIP-01 (id, kind, pubkey, created_at,
 * tags, content, sig). This is the canonical source of project membership for
 * out-of-process readers and within-process consumers that need p-tags without
 * touching Nostr.
 */
export async function readPersistedProjectEvent(
    dTag: ProjectDTag | string
): Promise<unknown | null> {
    try {
        const bytes = await fs.readFile(eventPath(dTag), "utf-8");
        return JSON.parse(bytes);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }
        throw error;
    }
}
