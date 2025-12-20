#!/usr/bin/env bun

// MUST BE FIRST - Initialize OpenTelemetry before any other imports
import { initializeTelemetry } from "./telemetry/setup";
initializeTelemetry();

import { handleCliError } from "@/utils/cli-error";
// CLI entry point for TENEX
import { Command } from "commander";
import { agentCommand } from "./commands/agent/index";
import { daemonCommand } from "./commands/daemon";
import { runDebugSystemPrompt, runDebugThreadedFormatter } from "./commands/debug/index";
import { setupCommand } from "./commands/setup/index";
import { createVCRCommand } from "./commands/vcr/index";
import { initNDK } from "./nostr/ndkClient";

const program = new Command();

program.name("tenex").description("TENEX Command Line Interface").version("0.1.0");

// Add main commands
program.addCommand(agentCommand);
program.addCommand(daemonCommand);
program.addCommand(setupCommand);
program.addCommand(createVCRCommand());

// Add debug command
const debug = program.command("debug").description("Debug commands");
debug
    .command("system-prompt")
    .description("Show the system prompt for an agent")
    .requiredOption("--project <naddr>", "Project naddr (e.g., naddr1...)")
    .option("--agent <name>", "Agent name", "default")
    .action((options) => runDebugSystemPrompt(options));

debug
    .command("threaded-formatter <conversationId>")
    .description("Show the threaded conversation formatter output for a conversation")
    .requiredOption("--project <naddr>", "Project naddr (e.g., naddr1...)")
    .option(
        "--strategy <strategy>",
        "Strategy to use (threaded-with-memory, flattened-chronological)"
    )
    .option("--agent <agent>", "Agent slug to view from perspective")
    .option("--dont-trim", "Don't trim message content (default: trim to 500 chars)")
    .action((conversationId, options) =>
        runDebugThreadedFormatter({
            project: options.project,
            conversationId,
            strategy: options.strategy,
            agent: options.agent,
            dontTrim: options.dontTrim,
        })
    );

// Initialize NDK before parsing commands
export async function main(): Promise<void> {
    await initNDK();
    program.parse(process.argv);
}

// Only run if called directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((error) => {
        handleCliError(error, "Fatal error in TENEX CLI");
    });
}
