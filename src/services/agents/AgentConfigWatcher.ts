import * as fs from "node:fs";
import { logger } from "@/utils/logger";

export type AgentFileChangeCallback = (pubkey: string) => Promise<void>;

// Regex to match valid agent config filenames: 64 hex chars + .json
const AGENT_FILE_PATTERN = /^[0-9a-f]{64}\.json$/;

const DEBOUNCE_MS = 150;

/**
 * Watches the agents directory for filesystem changes and triggers a callback
 * when a relevant agent config file is modified.
 *
 * Relevant means: the file matches the pubkey pattern AND passes the isRelevantAgent predicate.
 * Debounces per-pubkey (150ms) to handle editors that fire multiple events per save.
 * Guards against concurrent in-flight reloads for the same pubkey.
 */
export class AgentConfigWatcher {
    private readonly agentsDir: string;
    private readonly isRelevantAgent: (pubkey: string) => boolean;
    private readonly onChange: AgentFileChangeCallback;

    private watcher: fs.FSWatcher | null = null;
    private isRunning = false;

    // Per-pubkey debounce timers
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    // Per-pubkey in-flight reload promises
    private inFlight = new Map<string, Promise<void>>();

    constructor(
        agentsDir: string,
        isRelevantAgent: (pubkey: string) => boolean,
        onChange: AgentFileChangeCallback
    ) {
        this.agentsDir = agentsDir;
        this.isRelevantAgent = isRelevantAgent;
        this.onChange = onChange;
    }

    start(): void {
        if (this.isRunning) {
            logger.warn("[AgentConfigWatcher] Already running", { agentsDir: this.agentsDir });
            return;
        }

        this.watcher = fs.watch(this.agentsDir, (eventType, filename) => {
            this.handleFsEvent(eventType, filename);
        });

        this.watcher.on("error", (err) => {
            logger.warn("[AgentConfigWatcher] Watcher error", {
                agentsDir: this.agentsDir,
                error: err instanceof Error ? err.message : String(err),
            });
        });

        this.isRunning = true;
        logger.info("[AgentConfigWatcher] Started watching agents directory", {
            agentsDir: this.agentsDir,
        });
    }

    stop(): void {
        if (!this.isRunning) {
            return;
        }

        // Clear all pending debounce timers
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();

        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }

        this.isRunning = false;
        logger.info("[AgentConfigWatcher] Stopped watching agents directory", {
            agentsDir: this.agentsDir,
        });
    }

    private handleFsEvent(eventType: string, filename: string | null): void {
        if (!this.isRunning) {
            return;
        }

        if (!filename) {
            logger.debug("[AgentConfigWatcher] Received event with null filename, ignoring");
            return;
        }

        if (eventType !== "change" && eventType !== "rename") {
            logger.warn("[AgentConfigWatcher] Unexpected event type", { eventType, filename });
            return;
        }

        if (!AGENT_FILE_PATTERN.test(filename)) {
            logger.debug("[AgentConfigWatcher] Ignoring non-agent file", { filename });
            return;
        }

        const pubkey = filename.slice(0, -5); // strip ".json"

        if (!this.isRelevantAgent(pubkey)) {
            logger.debug("[AgentConfigWatcher] Ignoring agent not in this project", { pubkey: pubkey.slice(0, 8) });
            return;
        }

        // Debounce: reset timer for this pubkey
        const existingTimer = this.debounceTimers.get(pubkey);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
            this.debounceTimers.delete(pubkey);
            this.doReload(pubkey);
        }, DEBOUNCE_MS);

        this.debounceTimers.set(pubkey, timer);
    }

    private async doReload(pubkey: string): Promise<void> {
        // Chain after any in-flight reload for this pubkey
        const existing = this.inFlight.get(pubkey);
        const reloadTask = (async () => {
            if (existing) await existing.catch(() => {});
            await this.onChange(pubkey);
        })();

        this.inFlight.set(pubkey, reloadTask);
        try {
            logger.info("[AgentConfigWatcher] Reloading agent config", { pubkey: pubkey.slice(0, 8) });
            await reloadTask;
        } catch (err) {
            logger.error("[AgentConfigWatcher] Agent config reload failed", {
                pubkey: pubkey.slice(0, 8),
                error: err instanceof Error ? err.message : String(err),
            });
        } finally {
            if (this.inFlight.get(pubkey) === reloadTask) {
                this.inFlight.delete(pubkey);
            }
        }
    }
}
