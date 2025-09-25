import { llmCommand } from "@/commands/setup/llm";
import { embedCommand } from "@/commands/setup/embed";
import { Command } from "commander";

export const setupCommand = new Command("setup")
  .description("Setup and configuration commands")
  .addCommand(llmCommand)
  .addCommand(embedCommand);
