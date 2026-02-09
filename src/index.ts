#!/usr/bin/env bun

// TENEX CLI Entry Point
// This is a CLI application - NOT a library. Zero exports.

// MUST BE FIRST - Initialize OpenTelemetry before any other imports
// Read config synchronously to check telemetry setting before importing anything else
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { initializeTelemetry } from "@/telemetry/setup";

/**
 * Get the base TENEX directory path for early initialization.
 * Respects TENEX_BASE_DIR environment variable for running multiple isolated instances.
 * This is a minimal inline version used before other imports are available.
 */
function getBasePath(): string {
    return process.env.TENEX_BASE_DIR || join(homedir(), ".tenex");
}

interface TelemetryConfig {
    enabled: boolean;
    serviceName: string;
    endpoint: string;
}

function getTelemetryConfig(): TelemetryConfig {
    const configPath = join(getBasePath(), "config.json");
    const defaults: TelemetryConfig = {
        enabled: true,
        serviceName: "tenex-daemon",
        endpoint: "http://localhost:4318/v1/traces",
    };

    if (!existsSync(configPath)) return defaults;
    try {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        return {
            enabled: config.telemetry?.enabled !== false,
            serviceName: config.telemetry?.serviceName || defaults.serviceName,
            endpoint: config.telemetry?.endpoint || defaults.endpoint,
        };
    } catch (error) {
        // Issue #6: Make config parse errors visible to users
        console.warn(`[TENEX] Warning: Failed to parse config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
        return defaults; // default on parse error
    }
}

// Initialize telemetry before any other imports
const telemetryConfig = getTelemetryConfig();
initializeTelemetry(telemetryConfig.enabled, telemetryConfig.serviceName, telemetryConfig.endpoint);

// Main execution - all imports happen AFTER telemetry is initialized
// This ensures OpenTelemetry can properly instrument all imported modules
async function main(): Promise<void> {
    // Issue #1 & #4: Dynamic imports after telemetry initialization, using @/ aliases
    const [
        { Command },
        { getHeuristicEngine, getDefaultHeuristics },
        { agentCommand },
        { daemonCommand },
        { setupCommand },
        { handleCliError },
    ] = await Promise.all([
        import("commander"),
        import("@/services/heuristics"),
        import("@/commands/agent/index"),
        import("@/commands/daemon"),
        import("@/commands/setup/index"),
        import("@/utils/cli-error"),
    ]);

    // Initialize heuristics system with default rules
    const heuristicEngine = getHeuristicEngine({
        debug: process.env.DEBUG_HEURISTICS === "true",
    });
    for (const heuristic of getDefaultHeuristics()) {
        heuristicEngine.register(heuristic);
    }

    // CLI setup
    const program = new Command();

    // Issue #5: Use npm_package_version with fallback
    program
        .name("tenex")
        .description("TENEX Command Line Interface")
        .version(process.env.npm_package_version || "0.8.0");

    // Register subcommands
    program.addCommand(agentCommand);
    program.addCommand(daemonCommand);
    program.addCommand(setupCommand);

    // Issue #2: Enable exitOverride so errors are thrown instead of calling process.exit
    program.exitOverride();

    try {
        // Issue #2: Use parseAsync to properly catch async command errors
        await program.parseAsync(process.argv);
    } catch (error) {
        // Commander throws CommanderError for --help, --version, and actual errors
        // Check if it's a "help" or "version" exit - these are not real errors
        if (
            error instanceof Error &&
            "code" in error &&
            (error.code === "commander.helpDisplayed" || error.code === "commander.version")
        ) {
            // Normal exit for help/version - exit cleanly
            process.exit(0);
        }
        handleCliError(error, "Fatal error in TENEX CLI");
    }
}

// Execute CLI - this is an application, not a library
main().catch((error) => {
    // Fallback error handler for errors during dynamic imports
    console.error("Fatal error during TENEX CLI initialization:", error);
    process.exit(1);
});
