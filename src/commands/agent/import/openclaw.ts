import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { agentStorage, createStoredAgent } from "@/agents/AgentStorage";
import { getAgentHomeDirectory } from "@/lib/agent-home";
import { config as configService } from "@/services/ConfigService";
import type { LLMConfiguration } from "@/services/config/types";
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

interface CreateHomeDirOptions {
    noSync?: boolean;
}

export async function createHomeDir(
    pubkey: string,
    workspacePath: string,
    options: CreateHomeDirOptions = {},
): Promise<string> {
    const homeDir = getAgentHomeDirectory(pubkey);
    await fs.mkdir(homeDir, { recursive: true });

    if (options.noSync) {
        // Copy all workspace files into the home directory
        await fs.cp(workspacePath, homeDir, { recursive: true });

        const indexContent = `# Memory Files

This agent's memory was copied from an OpenClaw installation.

- \`MEMORY.md\` — long-term curated memory (copied from OpenClaw)
- \`memory/YYYY-MM-DD.md\` — daily session logs (copied from OpenClaw)

Source: ${workspacePath}
`;
        await fs.writeFile(path.join(homeDir, "+INDEX.md"), indexContent, "utf-8");
    } else {
        // Symlink MEMORY.md (dangling is ok — file may not exist yet)
        const memoryMdTarget = path.join(workspacePath, "MEMORY.md");
        const memoryMdLink = path.join(homeDir, "MEMORY.md");
        await fs.rm(memoryMdLink, { force: true });
        await fs.symlink(memoryMdTarget, memoryMdLink);

        // Symlink memory/ directory (dangling is ok)
        const memoryDirTarget = path.join(workspacePath, "memory");
        const memoryDirLink = path.join(homeDir, "memory");
        await fs.rm(memoryDirLink, { force: true });
        await fs.symlink(memoryDirTarget, memoryDirLink);

        const indexContent = `# Memory Files

This agent's memory is synced live from an OpenClaw installation.

- \`MEMORY.md\` — long-term curated memory (updated by OpenClaw)
- \`memory/YYYY-MM-DD.md\` — daily session logs (updated by OpenClaw)

Source: ${workspacePath}
`;
        await fs.writeFile(path.join(homeDir, "+INDEX.md"), indexContent, "utf-8");
    }

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

async function importOneAgent(
    agent: OpenClawAgent,
    llmConfigs: LLMConfiguration[],
    options: { noSync?: boolean } = {},
): Promise<void> {
    const tenexModel = convertModelFormat(agent.modelPrimary);

    console.log(chalk.blue(`\nDistilling identity for agent '${agent.id}'...`));
    const identity = await distillAgentIdentity(agent.workspaceFiles, llmConfigs);

    const slug = toSlug(identity.name) || agent.id;

    const slugTaken = await agentStorage.slugExists(slug);
    if (slugTaken) {
        throw new Error(
            `Agent '${slug}' already imported. Delete it first if you want to re-import.`
        );
    }

    const signer = NDKPrivateKeySigner.generate();
    const pubkey = signer.pubkey;

    const storedAgent = createStoredAgent({
        nsec: signer.privateKey,
        slug,
        name: identity.name,
        role: identity.role,
        description: identity.description,
        instructions: identity.instructions,
        useCriteria: identity.useCriteria,
        defaultConfig: { model: tenexModel },
    });

    await agentStorage.saveAgent(storedAgent);
    const homeDir = await createHomeDir(pubkey, agent.workspacePath, { noSync: options.noSync });

    console.log(chalk.green(`  ✓ Imported: ${identity.name} (${slug})`));
    console.log(chalk.gray(`    Keypair:   ${pubkey}`));
    console.log(chalk.gray(`    Model:     ${tenexModel}`));
    console.log(chalk.gray(`    Home dir:  ${homeDir}`));
    console.log(chalk.gray(`    Files:     ${options.noSync ? "copied" : "symlinked"} from ${agent.workspacePath}`));
}

function filterAgents(agents: OpenClawAgent[], slugs?: string): OpenClawAgent[] {
    if (!slugs) return agents;
    const allowed = slugs.split(",").map((s) => s.trim());
    return agents.filter((a) => allowed.includes(a.id));
}

export const openclawImportCommand = new Command("openclaw")
    .description("Import agents from a local OpenClaw installation")
    .option("--dry-run", "Preview what would be imported without making changes")
    .option("--json", "Output as JSON array (implies --dry-run)")
    .option("--no-sync", "Copy workspace files instead of symlinking them")
    .option("--slugs <slugs>", "Comma-separated list of agent IDs to import (default: all)")
    .action(async (options: { dryRun?: boolean; json?: boolean; noSync?: boolean; slugs?: string }) => {
        try {
            const stateDir = await detectOpenClawStateDir();
            if (!stateDir) {
                if (options.json) {
                    console.log("[]");
                    return;
                }
                console.error(chalk.red("No OpenClaw installation detected."));
                console.error(
                    chalk.gray(
                        "Checked: $OPENCLAW_STATE_DIR, ~/.openclaw, ~/.clawdbot, ~/.moldbot, ~/.moltbot"
                    )
                );
                process.exitCode = 1;
                return;
            }

            const allAgents = await readOpenClawAgents(stateDir);
            const agents = filterAgents(allAgents, options.slugs);

            if (agents.length === 0) {
                if (options.json) {
                    console.log("[]");
                } else {
                    console.log(chalk.yellow("No matching OpenClaw agents found."));
                }
                return;
            }

            await configService.loadConfig();
            const llmConfigs = configService.getAllLLMConfigs();

            if (options.dryRun || options.json) {
                const previews = [];
                for (const agent of agents) {
                    const identity = await distillAgentIdentity(agent.workspaceFiles, llmConfigs);
                    const slug = toSlug(identity.name) || agent.id;
                    previews.push({
                        id: agent.id,
                        slug,
                        model: convertModelFormat(agent.modelPrimary),
                        ...identity,
                    });
                }

                if (options.json) {
                    console.log(JSON.stringify(previews, null, 2));
                } else {
                    console.log(chalk.blue(`Would import ${previews.length} agent(s):\n`));
                    for (const p of previews) {
                        console.log(chalk.green(`  ${p.slug}`) + chalk.gray(` (${p.name})`));
                        console.log(chalk.gray(`    Role:         ${p.role}`));
                        console.log(chalk.gray(`    Model:        ${p.model}`));
                        console.log(chalk.gray(`    Description:  ${p.description}`));
                        console.log(chalk.gray(`    Instructions: ${p.instructions.slice(0, 120)}...`));
                    }
                }
                return;
            }

            if (!options.json) {
                console.log(chalk.blue(`Found OpenClaw installation at: ${stateDir}`));
                console.log(chalk.blue(`Found ${agents.length} agent(s) to import.`));
            }

            await agentStorage.initialize();

            let userMdProcessed = false;

            for (const agent of agents) {
                await importOneAgent(agent, llmConfigs, { noSync: options.noSync });

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
