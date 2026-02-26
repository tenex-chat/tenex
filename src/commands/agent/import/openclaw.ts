import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { agentStorage, createStoredAgent } from "@/agents/AgentStorage";
import { config as configService } from "@/services/ConfigService";
import { llmServiceFactory } from "@/llm/LLMServiceFactory";
import { detectOpenClawStateDir, readOpenClawAgents, convertModelFormat } from "./openclaw-reader";
import { distillAgentIdentity } from "./openclaw-distiller";
import type { OpenClawAgent } from "./openclaw-reader";

function toSlug(name: string): string {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

async function createHomeDir(pubkey: string, workspacePath: string): Promise<string> {
    const homeDir = configService.getConfigPath(`agents/${pubkey}`);
    await fs.mkdir(homeDir, { recursive: true });

    // Symlink MEMORY.md (dangling is ok — file may not exist yet)
    const memoryMdTarget = path.join(workspacePath, "MEMORY.md");
    const memoryMdLink = path.join(homeDir, "MEMORY.md");
    try {
        await fs.unlink(memoryMdLink);
    } catch {
        // doesn't exist yet
    }
    await fs.symlink(memoryMdTarget, memoryMdLink);

    // Symlink memory/ directory (dangling is ok)
    const memoryDirTarget = path.join(workspacePath, "memory");
    const memoryDirLink = path.join(homeDir, "memory");
    try {
        await fs.unlink(memoryDirLink);
    } catch {
        // doesn't exist yet
    }
    await fs.symlink(memoryDirTarget, memoryDirLink);

    const indexContent = `# Memory Files

This agent's memory is synced live from an OpenClaw installation.

- \`MEMORY.md\` — long-term curated memory (updated by OpenClaw)
- \`memory/YYYY-MM-DD.md\` — daily session logs (updated by OpenClaw)

Source: ${workspacePath}
`;
    await fs.writeFile(path.join(homeDir, "+INDEX.md"), indexContent, "utf-8");

    return homeDir;
}

async function appendUserMdToGlobalPrompt(userMdContent: string): Promise<void> {
    const globalPath = configService.getGlobalPath();
    const existingConfig = await configService.loadTenexConfig(globalPath);

    const userSection = `\n## About the User (imported from OpenClaw)\n\n${userMdContent.trim()}`;
    const existingContent = existingConfig.globalSystemPrompt?.content ?? "";
    const newContent = existingContent ? `${existingContent}${userSection}` : userSection.trim();

    const newConfig = {
        ...existingConfig,
        globalSystemPrompt: {
            enabled: true,
            content: newContent,
        },
    };
    await configService.saveGlobalConfig(newConfig);
}

async function importOneAgent(agent: OpenClawAgent): Promise<void> {
    const tenexModel = convertModelFormat(agent.modelPrimary);

    console.log(chalk.blue(`\nDistilling identity for agent '${agent.id}'...`));
    const identity = await distillAgentIdentity(agent.workspaceFiles, tenexModel);

    const slug = toSlug(identity.name) || agent.id;

    const existing = await agentStorage.getAgentBySlug(slug);
    if (existing) {
        throw new Error(
            `Agent '${slug}' already imported. Delete it first if you want to re-import.`
        );
    }

    const signer = NDKPrivateKeySigner.generate();
    const pubkey = signer.pubkey;

    const storedAgent = createStoredAgent({
        nsec: signer.privateKey!,
        slug,
        name: identity.name,
        role: identity.role,
        description: identity.description,
        instructions: identity.instructions,
        useCriteria: identity.useCriteria,
        defaultConfig: { model: tenexModel },
    });

    await agentStorage.saveAgent(storedAgent);
    const homeDir = await createHomeDir(pubkey, agent.workspacePath);

    console.log(chalk.green(`  ✓ Imported: ${identity.name} (${slug})`));
    console.log(chalk.gray(`    Keypair:   ${pubkey}`));
    console.log(chalk.gray(`    Model:     ${tenexModel}`));
    console.log(chalk.gray(`    Home dir:  ${homeDir}`));
    console.log(chalk.gray(`    Symlinks:  MEMORY.md, memory/`));
}

export const openclawImportCommand = new Command("openclaw")
    .description("Import agents from a local OpenClaw installation")
    .action(async () => {
        try {
            const stateDir = await detectOpenClawStateDir();
            if (!stateDir) {
                console.error(chalk.red("No OpenClaw installation detected."));
                console.error(
                    chalk.gray(
                        "Checked: $OPENCLAW_STATE_DIR, ~/.openclaw, ~/.clawdbot, ~/.moldbot, ~/.moltbot"
                    )
                );
                process.exitCode = 1;
                return;
            }

            console.log(chalk.blue(`Found OpenClaw installation at: ${stateDir}`));

            const agents = await readOpenClawAgents(stateDir);
            console.log(chalk.blue(`Found ${agents.length} agent(s) to import.`));

            await configService.loadConfig();
            const globalPath = configService.getGlobalPath();
            const providers = await configService.loadTenexProviders(globalPath);
            await llmServiceFactory.initializeProviders(providers.providers);

            await agentStorage.initialize();

            let userMdProcessed = false;

            for (const agent of agents) {
                await importOneAgent(agent);

                if (!userMdProcessed && agent.workspaceFiles.user) {
                    await appendUserMdToGlobalPrompt(agent.workspaceFiles.user);
                    console.log(chalk.green("  ✓ USER.md appended to global system prompt"));
                    userMdProcessed = true;
                }
            }

            console.log(chalk.green("\nImport complete."));
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) {
                return;
            }
            console.error(chalk.red(`Import failed: ${errorMessage}`));
            process.exitCode = 1;
        }
    });
