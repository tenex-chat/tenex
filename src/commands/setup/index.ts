import { llmCommand } from "@/commands/setup/llm";
import { Command } from "commander";

export const setupCommand = new Command("setup")
    .description("Setup and configuration commands")
    .addCommand(llmCommand);
