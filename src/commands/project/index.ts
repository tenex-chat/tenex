import { projectInitCommand } from "@/commands/project/init";
import { projectRunCommand } from "@/commands/project/run";
import { Command } from "commander";

export const projectCommand = new Command("project")
    .description("Project management commands")
    .addCommand(projectInitCommand)
    .addCommand(projectRunCommand);
