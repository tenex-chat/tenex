import { embedCommand } from "@/commands/setup/embed";
import { globalSystemPromptCommand } from "@/commands/setup/global-system-prompt";
import { llmCommand } from "@/commands/setup/llm";
import { onboardingCommand } from "@/commands/setup/onboarding";
import { providersCommand } from "@/commands/setup/providers";
import { Command } from "commander";

export const setupCommand = new Command("setup")
    .description("Setup and configuration commands")
    .addCommand(onboardingCommand, { isDefault: true })
    .addCommand(providersCommand)
    .addCommand(llmCommand)
    .addCommand(embedCommand)
    .addCommand(globalSystemPromptCommand);
