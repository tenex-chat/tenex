import { llmCommand } from "@/commands/setup/llm";
import { embedCommand } from "@/commands/setup/embed";
import { onboardingCommand } from "@/commands/setup/onboarding";
import { Command } from "commander";

export const setupCommand = new Command("setup")
  .description("Setup and configuration commands")
  .addCommand(onboardingCommand, { isDefault: true })
  .addCommand(llmCommand)
  .addCommand(embedCommand);
