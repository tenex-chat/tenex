/**
 * MCP command group
 * Provides subcommands for managing MCP servers
 */

import { Command } from "commander";
import { startServer } from "./serve";
import { handleCliError } from "@/utils/cli-error";

/**
 * Create the MCP command group with subcommands
 */
export function createMCPCommand(): Command {
    const mcpCommand = new Command("mcp")
        .description("Manage MCP (Model Context Protocol) servers");

    // Add serve subcommand - spawned internally by TENEX providers
    mcpCommand
        .command("serve")
        .description(
            "Start TENEX MCP server (internal use - spawned by Codex CLI provider)"
        )
        .action(async () => {
            try {
                await startServer();
            } catch (error) {
                handleCliError(error, "MCP server startup failed");
            }
        });

    return mcpCommand;
}
