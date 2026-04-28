import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { initializeTelemetry, shutdownTelemetry } from "@/telemetry/setup";

interface TelemetryConfig {
    enabled: boolean;
    serviceName: string;
    endpoint: string;
}

function getBasePath(): string {
    return process.env.TENEX_BASE_DIR || join(homedir(), ".tenex");
}

function getTelemetryConfig(defaultServiceName: string): TelemetryConfig {
    const configPath = join(getBasePath(), "config.json");
    const defaults: TelemetryConfig = {
        enabled: true,
        serviceName: defaultServiceName,
        endpoint: "http://localhost:4318/v1/traces",
    };

    if (!existsSync(configPath)) {
        return defaults;
    }

    try {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        return {
            enabled: config.telemetry?.enabled !== false,
            serviceName: config.telemetry?.serviceName || defaults.serviceName,
            endpoint: config.telemetry?.endpoint || defaults.endpoint,
        };
    } catch (error) {
        console.warn(`[TENEX] Warning: Failed to parse config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
        return defaults;
    }
}

export function initializeCliTelemetry(defaultServiceName = "tenex-daemon"): void {
    const telemetryConfig = getTelemetryConfig(defaultServiceName);
    initializeTelemetry(
        telemetryConfig.enabled,
        telemetryConfig.serviceName,
        telemetryConfig.endpoint
    );
}

export async function shutdownTelemetrySafely(timeoutMs = 1000): Promise<void> {
    await Promise.race([
        shutdownTelemetry().catch(() => undefined),
        new Promise<void>((resolve) => {
            setTimeout(resolve, timeoutMs);
        }),
    ]);
}
