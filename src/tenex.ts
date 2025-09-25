#!/usr/bin/env bun

import { handleCliError } from "@/utils/cli-error";
// CLI entry point for TENEX
import { Command } from "commander";
import { agentCommand } from "./commands/agent/index";
import { daemonCommand } from "./commands/daemon";
import { runDebugSystemPrompt } from "./commands/debug/index";
import { mcpCommand } from "./commands/mcp/index";
import { projectCommand } from "./commands/project/index";
import { setupCommand } from "./commands/setup/index";
import { initNDK } from "./nostr/ndkClient";

const program = new Command();

program.name("tenex").description("TENEX Command Line Interface").version("0.1.0");

// Add main commands
program.addCommand(agentCommand);
program.addCommand(daemonCommand);
program.addCommand(projectCommand);
program.addCommand(setupCommand);
program.addCommand(mcpCommand);

// Add debug command
const debug = program.command("debug").description("Debug commands");
debug
  .command("system-prompt")
  .description("Show the system prompt for an agent")
  .option("--agent <name>", "Agent name", "default")
  .action((options) => runDebugSystemPrompt(options));

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
