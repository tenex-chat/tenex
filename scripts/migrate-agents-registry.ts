#!/usr/bin/env tsx

/**
 * Migration script to populate the agents registry from existing projects.
 * This is a one-time migration that scans all TENEX projects and creates
 * registry entries for their agents.
 *
 * NOTE: This script intentionally references the old agents.json format
 * as it's designed to migrate FROM the old format TO the new global storage.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { agentsRegistryService } from "@/services/AgentsRegistryService";
import { logger } from "@/utils/logger";

async function getAllProjectDirs(): Promise<string[]> {
  const tenexDir = path.join(os.homedir(), ".tenex");
  const projectDirs: string[] = [];
  
  try {
    const entries = await fs.readdir(tenexDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const projectDir = path.join(tenexDir, entry.name);
        // Check if it has an agents.json file
        const agentsFile = path.join(projectDir, "agents.json");
        try {
          await fs.access(agentsFile);
          projectDirs.push(projectDir);
        } catch {
          // Not a project directory or no agents file
        }
      }
    }
  } catch (error) {
    logger.error("Failed to scan .tenex directory", error);
  }
  
  return projectDirs;
}

async function migrateProject(projectDir: string): Promise<void> {
  const projectName = path.basename(projectDir);
  logger.info(`Migrating project: ${projectName}`);
  
  try {
    // Load project configuration to get the d-tag
    const configPath = path.join(projectDir, "tenex-project.json");
    const configContent = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(configContent);
    
    // Get the project d-tag (usually the project ID or a specific identifier)
    const projectTag = config.id || config.dTag || projectName;
    
    // Load agents from the project
    const agentRegistry = new AgentRegistry(projectDir);
    const agents = await agentRegistry.loadAllAgents();
    
    // Register each agent's pubkey in the global registry
    for (const agent of agents) {
      if (agent.pubkey) {
        logger.debug(`Adding agent ${agent.name} (${agent.pubkey.substring(0, 8)}...) to project ${projectTag}`);
        await agentsRegistryService.addAgent(projectTag, agent.pubkey);
      }
    }
    
    logger.info(`Migrated ${agents.length} agents for project ${projectName}`);
  } catch (error) {
    logger.error(`Failed to migrate project ${projectName}`, error);
  }
}

async function main() {
  logger.info("Starting agents registry migration...");
  
  // Get all project directories
  const projectDirs = await getAllProjectDirs();
  
  if (projectDirs.length === 0) {
    logger.warn("No TENEX projects found to migrate");
    return;
  }
  
  logger.info(`Found ${projectDirs.length} projects to migrate`);
  
  // Migrate each project
  for (const projectDir of projectDirs) {
    await migrateProject(projectDir);
  }
  
  logger.info("Migration completed successfully");
}

// Run the migration
main().catch((error) => {
  logger.error("Migration failed", error);
  process.exit(1);
});