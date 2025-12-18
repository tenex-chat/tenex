import { Command } from "commander";
import { createListCommand } from "./list";
import { createExtractCommand } from "./extract";
import { createCleanCommand } from "./clean";

/**
 * Creates the VCR command with subcommands
 */
export function createVCRCommand(): Command {
    const cmd = new Command("vcr")
        .description("Manage VCR recordings for LLM testing");

    cmd.addCommand(createListCommand());
    cmd.addCommand(createExtractCommand());
    cmd.addCommand(createCleanCommand());

    return cmd;
}
