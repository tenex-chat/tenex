import os from "node:os";
import type { PromptFragment } from "../core/types";

/**
 * Process metrics fragment.
 * Provides agents with runtime metadata about the backend process:
 * PID, process uptime, CPU/memory usage, and system uptime.
 */
export const processMetricsFragment: PromptFragment<Record<string, never>> = {
    id: "process-metrics",
    priority: 4, // Alongside relay-configuration, environment metadata
    template: () => {
        const pid = process.pid;
        const uptimeSeconds = process.uptime();

        // Format process uptime: show seconds when < 60s, otherwise minutes
        const processUptimeStr =
            uptimeSeconds < 60
                ? `${Math.floor(uptimeSeconds)}s`
                : `${Math.floor(uptimeSeconds / 60)}m`;

        // CPU usage: average over process lifetime as percentage
        const cpuUsage = process.cpuUsage();
        const totalCpuMicros = cpuUsage.user + cpuUsage.system;
        const numCpus = os.cpus().length;
        const cpuPercentStr =
            uptimeSeconds > 0 && numCpus > 0
                ? `${((totalCpuMicros / (uptimeSeconds * 1_000_000) / numCpus) * 100).toFixed(1)}%`
                : "n/a";

        // Memory usage: RSS as percentage of total system memory
        const rss = process.memoryUsage().rss;
        const totalMem = os.totalmem();
        const memPercentStr =
            totalMem > 0
                ? `${((rss / totalMem) * 100).toFixed(1)}%`
                : "n/a";

        // System uptime
        const sysUptimeSeconds = os.uptime();
        const sysUptimeHours = Math.floor(sysUptimeSeconds / 3600);
        const sysUptimeMinutes = Math.floor((sysUptimeSeconds % 3600) / 60);

        const sysUptimeStr =
            sysUptimeHours > 0
                ? `${sysUptimeHours}h ${sysUptimeMinutes}m`
                : sysUptimeSeconds < 60
                  ? `${Math.floor(sysUptimeSeconds)}s`
                  : `${sysUptimeMinutes}m`;

        const lines = [
            "## Process Metrics",
            `- PID: ${pid}`,
            `- Process uptime: ${processUptimeStr}`,
            `- CPU usage: ${cpuPercentStr}`,
            `- Memory usage: ${memPercentStr} (${formatBytes(rss)} RSS)`,
            `- System uptime: ${sysUptimeStr}`,
        ];

        return lines.join("\n");
    },
};

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${Math.round(kb)}KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${Math.round(mb)}MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(1)}GB`;
}
