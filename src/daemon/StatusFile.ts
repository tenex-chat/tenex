import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface RuntimeStatusEntry {
    projectId: string;
    title: string;
    agentCount: number;
    startTime: string | null;
    lastEventTime: string | null;
    eventCount: number;
}

export interface DaemonStatusData {
    pid: number;
    startedAt: string;
    knownProjects: number;
    runtimes: RuntimeStatusEntry[];
    updatedAt: string;
}

export class StatusFile {
    private readonly filePath: string;

    constructor(daemonDir: string) {
        this.filePath = path.join(daemonDir, "status.json");
    }

    async write(data: DaemonStatusData): Promise<void> {
        await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    }

    async read(): Promise<DaemonStatusData | null> {
        try {
            const content = await fs.readFile(this.filePath, "utf-8");
            return JSON.parse(content) as DaemonStatusData;
        } catch {
            return null;
        }
    }

    async remove(): Promise<void> {
        try {
            await fs.unlink(this.filePath);
        } catch {
            // ignore — file may not exist
        }
    }
}
