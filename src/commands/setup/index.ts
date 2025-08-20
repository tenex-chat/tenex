import { Command } from "commander";
import { llmCommand } from "@/commands/setup/llm";

export const setupCommand = new Command("setup")
  .description("Setup and configuration commands")
  .addCommand(llmCommand);
