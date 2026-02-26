import { Command } from "commander";
import { openclawImportCommand } from "./openclaw";

export const importCommand = new Command("import")
    .description("Import agents from external sources")
    .addCommand(openclawImportCommand);
