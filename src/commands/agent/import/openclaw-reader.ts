import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";

export interface OpenClawWorkspaceFiles {
    soul: string | null;
    identity: string | null;
    agents: string | null;
    user: string | null;
}

export interface OpenClawAgent {
    id: string;
    modelPrimary: string;
    workspacePath: string;
    workspaceFiles: OpenClawWorkspaceFiles;
}

async function readFileOrNull(filePath: string): Promise<string | null> {
    try {
        return await fs.readFile(filePath, "utf-8");
    } catch {
        return null;
    }
}

async function configExists(dir: string): Promise<boolean> {
    for (const name of ["openclaw.json", "clawdbot.json", "moldbot.json", "moltbot.json"]) {
        try {
            await fs.access(path.join(dir, name));
            return true;
        } catch {
            // continue
        }
    }
    return false;
}

export async function findOpenClawStateDir(candidatePaths: string[]): Promise<string | null> {
    // 1. Environment variable takes precedence
    const envDir = process.env.OPENCLAW_STATE_DIR;
    if (envDir && (await configExists(envDir))) {
        return envDir;
    }

    // 2. Check candidate paths
    for (const dir of candidatePaths) {
        if (await configExists(dir)) {
            return dir;
        }
    }

    return null;
}

export async function detectOpenClawStateDir(): Promise<string | null> {
    const home = homedir();
    return findOpenClawStateDir([
        path.join(home, ".openclaw"),
        path.join(home, ".clawdbot"),
        path.join(home, ".moldbot"),
        path.join(home, ".moltbot"),
    ]);
}

async function readConfigJson(stateDir: string): Promise<Record<string, unknown>> {
    for (const name of ["openclaw.json", "clawdbot.json", "moldbot.json", "moltbot.json"]) {
        try {
            const content = await fs.readFile(path.join(stateDir, name), "utf-8");
            return JSON.parse(content);
        } catch {
            // continue
        }
    }
    throw new Error(`No config file found in ${stateDir}`);
}

async function readWorkspaceFiles(workspacePath: string): Promise<OpenClawWorkspaceFiles> {
    const [soul, identity, agents, user] = await Promise.all([
        readFileOrNull(path.join(workspacePath, "SOUL.md")),
        readFileOrNull(path.join(workspacePath, "IDENTITY.md")),
        readFileOrNull(path.join(workspacePath, "AGENTS.md")),
        readFileOrNull(path.join(workspacePath, "USER.md")),
    ]);
    return { soul, identity, agents, user };
}

export async function readOpenClawAgents(stateDir: string): Promise<OpenClawAgent[]> {
    const config = await readConfigJson(stateDir);
    const agentsConfig = (config.agents ?? {}) as Record<string, unknown>;
    const defaults = (agentsConfig.defaults ?? {}) as Record<string, unknown>;
    const defaultModel = ((defaults.model ?? {}) as Record<string, unknown>).primary as
        | string
        | undefined;
    const defaultWorkspace =
        (defaults.workspace as string | undefined) ?? path.join(stateDir, "workspace");

    const list = agentsConfig.list as Array<Record<string, unknown>> | undefined;

    if (!list || list.length === 0) {
        // Single default "main" agent
        const workspaceFiles = await readWorkspaceFiles(defaultWorkspace);
        return [
            {
                id: "main",
                modelPrimary: defaultModel ?? "anthropic/claude-sonnet-4-6",
                workspacePath: defaultWorkspace,
                workspaceFiles,
            },
        ];
    }

    return Promise.all(
        list.map(async (entry) => {
            const id = (entry.id as string | undefined) ?? "main";
            const agentModel = ((entry.model ?? {}) as Record<string, unknown>).primary as
                | string
                | undefined;
            const workspacePath = (entry.workspace as string | undefined) ?? defaultWorkspace;
            const workspaceFiles = await readWorkspaceFiles(workspacePath);
            return {
                id,
                modelPrimary: agentModel ?? defaultModel ?? "anthropic/claude-sonnet-4-6",
                workspacePath,
                workspaceFiles,
            };
        })
    );
}

/**
 * Convert OpenClaw model format to TENEX format.
 * OpenClaw uses "provider/model", TENEX uses "provider:model".
 */
export function convertModelFormat(openClawModel: string): string {
    return openClawModel.replace("/", ":");
}
