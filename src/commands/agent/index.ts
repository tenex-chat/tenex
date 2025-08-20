import { Command } from "commander";
import { agentAddCommand } from "./add";
import { agentListCommand } from "./list";
import { agentRemoveCommand } from "./remove";

export const agentCommand = new Command("agent")
  .description("Agent management commands")
  .addCommand(agentAddCommand)
  .addCommand(agentListCommand)
  .addCommand(agentRemoveCommand);
