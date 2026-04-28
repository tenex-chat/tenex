#!/usr/bin/env bun

// TENEX single-project boot entrypoint
// This is a CLI application - NOT a library. Zero exports.

// MUST BE FIRST - Initialize OpenTelemetry before any other imports
// Read config synchronously to check telemetry setting before importing anything else
import { initializeCliTelemetry, shutdownTelemetrySafely } from "@/telemetry/cli-bootstrap";

initializeCliTelemetry("tenex-daemon");

const PROJECT_DISCOVERY_TIMEOUT_MS = 15_000;
const PROJECT_DISCOVERY_POLL_MS = 100;

async function waitForProjectDiscovery<K>(
    daemon: { getKnownProjects(): Map<K, unknown> },
    projectId: K
): Promise<void> {
    if (daemon.getKnownProjects().has(projectId)) {
        return;
    }

    const deadline = Date.now() + PROJECT_DISCOVERY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await new Promise((resolve) => {
            setTimeout(resolve, PROJECT_DISCOVERY_POLL_MS);
        });

        if (daemon.getKnownProjects().has(projectId)) {
            return;
        }
    }

    throw new Error(
        `Project ${projectId} was not discovered from Nostr within ${PROJECT_DISCOVERY_TIMEOUT_MS}ms`
    );
}

async function main(): Promise<void> {
    const [
        { Command },
        { getDaemon },
        { initNDK },
        { config },
        { logger },
        { handleCliError },
        { createProjectDTag },
        { initializeDefaultHeuristics },
    ] = await Promise.all([
        import("commander"),
        import("@/daemon"),
        import("@/nostr/ndkClient"),
        import("@/services/ConfigService"),
        import("@/utils/logger"),
        import("@/utils/cli-error"),
        import("@/types/project-ids"),
        import("@/services/heuristics/bootstrap"),
    ]);

    initializeDefaultHeuristics();

    const program = new Command();
    program
        .name("tenex-boot")
        .description("Boot a single TENEX project runtime")
        .requiredOption("--boot <project-id>", "Project d-tag to boot");
    program.exitOverride();

    try {
        try {
            await program.parseAsync(process.argv);
        } catch (error) {
            if (
                error instanceof Error &&
                "code" in error &&
                error.code === "commander.helpDisplayed"
            ) {
                await shutdownTelemetrySafely();
                process.exit(0);
            }
            handleCliError(error, "Fatal error in TENEX boot");
        }

        const { boot } = program.opts<{ boot: string }>();
        const projectId = createProjectDTag(boot);

        await config.loadConfig();
        await logger.initDaemonLogging();
        await initNDK();

        const daemon = getDaemon();
        daemon.setRuntimeBootAllowlist([projectId]);

        await daemon.start();
        await waitForProjectDiscovery(daemon, projectId);

        try {
            await daemon.startRuntime(projectId);
        } catch (error) {
            if (!daemon.getActiveRuntimes().has(projectId)) {
                throw error;
            }
        }

        daemon.markFullyInitialized();

        await new Promise(() => {
            // This promise never resolves, keeping the project runtime running.
        });
    } finally {
        await shutdownTelemetrySafely();
    }
}

main().catch((error) => {
    console.error("Fatal error during TENEX boot initialization:", error);
    process.exit(1);
});
