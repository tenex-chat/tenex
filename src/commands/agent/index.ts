import { Command } from "commander";
import { importCommand } from "./import/index";

export const agentCommand = new Command("agent")
    .description("Agent management commands")
    .addCommand(importCommand);
