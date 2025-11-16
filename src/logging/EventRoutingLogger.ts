import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { NDKEvent, NDKFilter } from "@nostr-dev-kit/ndk";

type RoutingDecision = "routed" | "dropped" | "project_event";
type RoutingMethod = "a_tag" | "p_tag_agent" | "none";
type RuntimeAction = "existing" | "started" | "none";

interface EventRoutingLogEntry {
    timestamp: string;
    eventId: string;
    kind: number;
    author: string;
    tags: string[][];
    routingDecision: RoutingDecision;
    targetProjectId: string | null;
    routingMethod: RoutingMethod;
    matchedTags: string[];
    runtimeAction: RuntimeAction;
    reason: string | null;
    contentPreview?: string;
}

interface SubscriptionFilterLogEntry {
    timestamp: string;
    type: "subscription_filter_update";
    filters: NDKFilter[];
    filterCount: number;
    whitelistedAuthors: number;
    trackedProjects: number;
    trackedAgents: number;
}

/**
 * Logger for event routing decisions in the daemon.
 * Creates JSONL files with complete audit trail of all routing decisions.
 */
export class EventRoutingLogger {
    private logDir: string | null = null;

    /**
     * Initialize the logger with the daemon directory
     */
    initialize(daemonDir: string): void {
        this.logDir = join(daemonDir, "logs", "routing");
    }

    /**
     * Check if the logger has been initialized
     */
    isInitialized(): boolean {
        return this.logDir !== null;
    }

    private async ensureLogDirectory(): Promise<void> {
        if (!this.logDir) {
            throw new Error("[EventRoutingLogger] Not initialized. Call initialize() first.");
        }
        try {
            await fs.mkdir(this.logDir, { recursive: true });
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code !== "EEXIST") {
                throw error;
            }
        }
    }

    private getLogFileName(): string {
        const now = new Date();
        const date = now.toISOString().split("T")[0];
        const hours = now.getHours();
        const minutes = now.getMinutes();
        // Round down to nearest 5-minute increment
        const roundedMinutes = Math.floor(minutes / 5) * 5;
        const timeStr = `${hours.toString().padStart(2, "0")}:${roundedMinutes.toString().padStart(2, "0")}`;
        return `${date}_${timeStr}.jsonl`;
    }

    private getLogFilePath(filename: string): string {
        if (!this.logDir) {
            throw new Error("[EventRoutingLogger] Not initialized. Call initialize() first.");
        }
        return join(this.logDir, filename);
    }

    /**
     * Log an event routing decision
     */
    async logRoutingDecision(params: {
        event: NDKEvent;
        routingDecision: RoutingDecision;
        targetProjectId: string | null;
        routingMethod: RoutingMethod;
        matchedTags?: string[];
        runtimeAction?: RuntimeAction;
        reason?: string;
    }): Promise<void> {
        if (!this.isInitialized()) {
            console.warn("[EventRoutingLogger] Not initialized. Skipping log.");
            return;
        }

        await this.ensureLogDirectory();

        const logEntry: EventRoutingLogEntry = {
            timestamp: new Date().toISOString(),
            eventId: params.event.id,
            kind: params.event.kind || 0,
            author: params.event.pubkey,
            tags: params.event.tags,
            routingDecision: params.routingDecision,
            targetProjectId: params.targetProjectId,
            routingMethod: params.routingMethod,
            matchedTags: params.matchedTags || [],
            runtimeAction: params.runtimeAction || "none",
            reason: params.reason || null,
            contentPreview: params.event.content?.slice(0, 100) || undefined,
        };

        const filename = this.getLogFileName();
        const filepath = this.getLogFilePath(filename);

        try {
            // Append to JSONL file (one JSON object per line)
            await fs.appendFile(filepath, JSON.stringify(logEntry) + "\n", "utf-8");
        } catch (error) {
            console.error("[EventRoutingLogger] Failed to write log:", error);
        }
    }

    /**
     * Log subscription filter updates
     */
    async logSubscriptionFilters(params: {
        filters: NDKFilter[];
        whitelistedAuthors: number;
        trackedProjects: number;
        trackedAgents: number;
    }): Promise<void> {
        if (!this.isInitialized()) {
            console.warn("[EventRoutingLogger] Not initialized. Skipping filter log.");
            return;
        }

        await this.ensureLogDirectory();

        const logEntry: SubscriptionFilterLogEntry = {
            timestamp: new Date().toISOString(),
            type: "subscription_filter_update",
            filters: params.filters,
            filterCount: params.filters.length,
            whitelistedAuthors: params.whitelistedAuthors,
            trackedProjects: params.trackedProjects,
            trackedAgents: params.trackedAgents,
        };

        const filename = this.getLogFileName();
        const filepath = this.getLogFilePath(filename);

        try {
            // Append to JSONL file (one JSON object per line)
            await fs.appendFile(filepath, JSON.stringify(logEntry) + "\n", "utf-8");
        } catch (error) {
            console.error("[EventRoutingLogger] Failed to write filter log:", error);
        }
    }

    /**
     * Get recent log files
     */
    async getRecentLogs(limit = 10): Promise<string[]> {
        if (!this.logDir) {
            console.warn("[EventRoutingLogger] Not initialized. Cannot get recent logs.");
            return [];
        }
        try {
            await this.ensureLogDirectory();
            const files = await fs.readdir(this.logDir);
            const jsonlFiles = files
                .filter((f) => f.endsWith(".jsonl"))
                .sort()
                .reverse()
                .slice(0, limit);
            return jsonlFiles.map((f) => this.getLogFilePath(f));
        } catch (error) {
            console.error("[EventRoutingLogger] Failed to list logs:", error);
            return [];
        }
    }

    /**
     * Read a specific log file (JSONL format)
     */
    async readLog(filename: string): Promise<EventRoutingLogEntry[] | null> {
        try {
            const filepath = this.getLogFilePath(filename);
            const content = await fs.readFile(filepath, "utf-8");
            const lines = content.split("\n").filter((line) => line.trim());
            return lines.map((line) => JSON.parse(line));
        } catch (error) {
            console.error(`[EventRoutingLogger] Failed to read log ${filename}:`, error);
            return null;
        }
    }
}
