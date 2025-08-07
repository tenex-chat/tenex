#!/usr/bin/env bun

import { logger } from "@/utils/logger";
// CLI entry point for TENEX
import { Command } from "commander";
import { agentCommand } from "./commands/agent/index";
import { daemonCommand } from "./commands/daemon";
import { runDebugSystemPrompt } from "./commands/debug/index";
import { inventoryCommand } from "./commands/inventory/index";
import { mcpCommand } from "./commands/mcp/index";
import { projectCommand } from "./commands/project/index";
import { setupCommand } from "./commands/setup/index";
import { initNDK } from "./nostr/ndkClient";
import { PHASES } from "./conversations/phases";

const program = new Command();

program.name("tenex").description("TENEX Command Line Interface").version("0.1.0");

// Add main commands
program.addCommand(agentCommand);
program.addCommand(daemonCommand);
program.addCommand(projectCommand);
program.addCommand(setupCommand);
program.addCommand(inventoryCommand);
program.addCommand(mcpCommand);

// Add debug command
const debug = program.command("debug").description("Debug commands");
debug
    .command("system-prompt")
    .description("Show the system prompt for an agent")
    .option("--agent <name>", "Agent name", "default")
    .option(
        "--phase <phase>",
        `Phase to show prompt for (${Object.values(PHASES).join(', ')})`,
        PHASES.CHAT
    )
    .action((options) => runDebugSystemPrompt(options));
debug
    .command("chat [agent]")
    .description("Start an interactive debug chat session with an agent")
    .option("-s, --system-prompt", "Show the agent's system prompt on first request")
    .option("-m, --message <message>", "Initial message to send")
    .option(
        "-l, --llm [config]",
        "LLM configuration to use (shows available configs if no value provided)"
    )
    .action((agent, options) => {
        import("./commands/debug/chat").then(({ runDebugChat }) => runDebugChat(agent, options));
    });
debug
    .command("conversation <nevent>")
    .description("Fetch and display a Nostr conversation thread")
    .action((nevent) => {
        import("./commands/debug/conversation").then(({ runDebugConversation }) =>
            runDebugConversation(nevent)
        );
    });
debug
    .command("tool")
    .argument("claude_code", "Tool name (only claude_code is supported)")
    .argument("<prompt>", "Prompt to send to Claude Code")
    .description("Debug a tool execution (currently only claude_code)")
    .option("-t, --timeout <ms>", "Timeout in milliseconds", parseInt)
    .action((tool, prompt, options) => {
        if (tool !== "claude_code") {
            console.error("Error: Only 'claude_code' tool is supported for debugging");
            process.exit(1);
        }
        import("./commands/debug/claudeCode").then(({ runDebugClaudeCode }) =>
            runDebugClaudeCode(prompt, options)
        );
    });

debug
    .command("timeline [conversationId]")
    .description("Display a timeline of all events in a conversation")
    .action((conversationId) => {
        import("./commands/debug/timeline").then(({ timeline }) => {
            timeline.handler({ conversationId, _: [], $0: "" });
        });
    });

// Initialize NDK before parsing commands
export async function main(): Promise<void> {
    await initNDK();
    program.parse(process.argv);
}

// Only run if called directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((error) => {
        logger.error("Fatal error in TENEX CLI", error);
        process.exit(1);
    });
}
