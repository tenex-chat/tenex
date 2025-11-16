import { Command } from "commander";
import { agentListCommand } from "./list";
import { agentRemoveCommand } from "./remove";

export const agentCommand = new Command("agent")
    .description("Agent management commands")
    .addCommand(agentListCommand)
    .addCommand(agentRemoveCommand);
