import { Command } from "commander";
import { addCommand } from "./add";
import { listCommand } from "./list";
import { removeCommand } from "./remove";
import { serverCommand } from "./server";

export const mcpCommand = new Command("mcp")
    .description("Manage Model Context Protocol (MCP) servers")
    .addCommand(addCommand)
    .addCommand(listCommand)
    .addCommand(removeCommand)
    .addCommand(serverCommand);
