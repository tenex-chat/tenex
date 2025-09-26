import { AgentRegistry } from "@/agents/AgentRegistry";
import { configService } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { fileExists, readFile, writeJsonFile, ensureDirectory } from "@/lib/fs";
import { Command } from "commander";
import inquirer from "inquirer";
import * as path from "node:path";
import * as fs from "node:fs/promises";

export const agentMakeGlobalCommand = new Command("make-global")
  .description("Move a local agent to global configuration")
  .action(async () => {
    try {
      const projectPath = process.cwd();
      const isProject = await configService.projectConfigExists(projectPath, "config.json");

      if (!isProject) {
        logger.error("Not in a TENEX project directory. Run from a project with local agents.");
        process.exit(1);
      }

      // Load project agents
      const projectRegistry = new AgentRegistry(projectPath, false);
      await projectRegistry.loadFromProject();
      const projectAgents = projectRegistry.getAllAgents();

      if (projectAgents.length === 0) {
        logger.info("No local agents found in this project.");
        process.exit(0);
      }

      // Filter out agents that override global ones (we only want truly local agents)
      const globalPath = configService.getGlobalPath().replace("/.tenex", "");
      const globalRegistry = new AgentRegistry(globalPath, true);
      await globalRegistry.loadFromProject();
      const globalAgentSlugs = new Set(globalRegistry.getAllAgents().map((a) => a.slug));

      const localOnlyAgents = projectAgents.filter(agent => !globalAgentSlugs.has(agent.slug));

      if (localOnlyAgents.length === 0) {
        logger.info("No project-specific agents found (all agents are overriding global agents).");
        process.exit(0);
      }

      // Prompt user to select an agent
      const { selectedAgent } = await inquirer.prompt([
        {
          type: "list",
          name: "selectedAgent",
          message: "Select an agent to make global:",
          choices: localOnlyAgents.map(agent => ({
            name: `${agent.slug}: ${agent.name} - ${agent.role}`,
            value: agent.slug
          }))
        }
      ]);

      // Find the selected agent
      const agentToMove = localOnlyAgents.find(a => a.slug === selectedAgent);
      if (!agentToMove) {
        logger.error("Agent not found");
        process.exit(1);
      }

      logger.info(`Moving agent "${agentToMove.slug}" to global configuration...`);

      // Load the project's agents.json to get the file reference
      const projectAgentsJsonPath = path.join(projectPath, ".tenex", "agents.json");
      const projectAgentsJson = JSON.parse(await readFile(projectAgentsJsonPath));
      const agentEntry = projectAgentsJson[agentToMove.slug];

      if (!agentEntry) {
        logger.error("Agent entry not found in agents.json");
        process.exit(1);
      }

      // Paths for source and destination
      const sourceAgentFile = path.join(projectPath, ".tenex", "agents", agentEntry.file);
      const globalTenexPath = configService.getGlobalPath();
      const globalAgentsDir = path.join(globalTenexPath, "agents");
      const destAgentFile = path.join(globalAgentsDir, agentEntry.file);
      const globalAgentsJsonPath = path.join(globalTenexPath, "agents.json");

      // Ensure global directories exist
      await ensureDirectory(globalTenexPath);
      await ensureDirectory(globalAgentsDir);

      // Check if agent already exists globally
      let globalAgentsJson: Record<string, any> = {};
      if (await fileExists(globalAgentsJsonPath)) {
        globalAgentsJson = JSON.parse(await readFile(globalAgentsJsonPath));
      }

      if (globalAgentsJson[agentToMove.slug]) {
        const { overwrite } = await inquirer.prompt([
          {
            type: "confirm",
            name: "overwrite",
            message: `Agent "${agentToMove.slug}" already exists globally. Overwrite?`,
            default: false
          }
        ]);

        if (!overwrite) {
          logger.info("Operation cancelled.");
          process.exit(0);
        }
      }

      // Copy agent file to global location
      const agentContent = await readFile(sourceAgentFile);
      await fs.writeFile(destAgentFile, agentContent);

      // Update global agents.json
      globalAgentsJson[agentToMove.slug] = agentEntry;
      await writeJsonFile(globalAgentsJsonPath, globalAgentsJson);

      // Remove from project agents.json
      delete projectAgentsJson[agentToMove.slug];
      await writeJsonFile(projectAgentsJsonPath, projectAgentsJson);

      // Delete the local agent file
      await fs.unlink(sourceAgentFile);

      logger.info(`✓ Agent "${agentToMove.slug}" has been moved to global configuration`);
      logger.info(`  Global location: ${destAgentFile}`);

      // If there's an nsec file, move it too
      const nsecFileName = agentEntry.file.replace('.json', '.nsec');
      const sourceNsecFile = path.join(projectPath, ".tenex", "agents", nsecFileName);
      const destNsecFile = path.join(globalAgentsDir, nsecFileName);

      if (await fileExists(sourceNsecFile)) {
        const nsecContent = await readFile(sourceNsecFile);
        await fs.writeFile(destNsecFile, nsecContent);
        await fs.unlink(sourceNsecFile);
        logger.info(`  ✓ Moved agent's nsec file`);
      }

      process.exit(0);
    } catch (error) {
      logger.error("Failed to make agent global:", error);
      process.exit(1);
    }
  });