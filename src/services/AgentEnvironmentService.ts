import * as path from "node:path";
import type { AgentStorage } from "@/agents/AgentStorage";
import { agentStorage } from "@/agents/AgentStorage";
import { ensureAgentHomeEnvFile, getAgentHomeEnvPath } from "@/lib/agent-home-env";
import { fileExists, readFile } from "@/lib/fs";
import { DotenvParseError, parseDotenv } from "@/lib/parse-dotenv";
import { config } from "@/services/ConfigService";

export interface ResolveShellEnvironmentParams {
    agentPubkey: string;
    projectDTag?: string | null;
    projectPath?: string | null;
    agentNsec?: string;
    baseEnv?: NodeJS.ProcessEnv;
}

export interface EnsureAgentHomeEnvParams {
    agentPubkey: string;
    agentNsec?: string;
}

export class AgentEnvironmentFileError extends Error {
    readonly filePath: string;
    readonly line: number;

    constructor(filePath: string, line: number, reason: string) {
        super(`Invalid .env file at ${filePath}:${line}: ${reason}`);
        this.name = "AgentEnvironmentFileError";
        this.filePath = filePath;
        this.line = line;
    }
}

export class AgentEnvironmentService {
    constructor(
        private readonly agentLoader: Pick<AgentStorage, "loadAgent"> = agentStorage
    ) {}

    getGlobalEnvPath(): string {
        return path.join(config.getGlobalPath(), ".env");
    }

    getProjectEnvPath(projectDTag: string): string {
        return path.join(config.getConfigPath("projects"), projectDTag, ".env");
    }

    getProjectRepoEnvPath(projectPath: string): string {
        return path.join(projectPath, ".env");
    }

    getAgentEnvPath(agentPubkey: string): string {
        return getAgentHomeEnvPath(agentPubkey);
    }

    async ensureAgentHomeEnv(
        params: EnsureAgentHomeEnvParams
    ): Promise<{ path: string; created: boolean }> {
        const agentNsec = await this.resolveAgentNsec(params);
        return ensureAgentHomeEnvFile(params.agentPubkey, agentNsec);
    }

    async resolveShellEnvironment(
        params: ResolveShellEnvironmentParams
    ): Promise<NodeJS.ProcessEnv> {
        const baseEnv = params.baseEnv ?? process.env;
        const mergedEnv: NodeJS.ProcessEnv = {};

        for (const [key, value] of Object.entries(baseEnv)) {
            if (value !== undefined) {
                mergedEnv[key] = value;
            }
        }

        // Capture original HOME before any .env merges - this MUST be preserved
        const originalHome = baseEnv.HOME;

        const globalEnvPath = this.getGlobalEnvPath();
        const projectRepoEnvPath = params.projectPath
            ? this.getProjectRepoEnvPath(params.projectPath)
            : null;
        const projectEnvPath = params.projectDTag
            ? this.getProjectEnvPath(params.projectDTag)
            : null;

        await this.ensureAgentHomeEnv(params);
        const agentEnvPath = this.getAgentEnvPath(params.agentPubkey);

        // Merge order (lowest to highest priority):
        // global < project-repo < project-metadata < agent
        Object.assign(mergedEnv, await this.readEnvFile(globalEnvPath));
        if (projectRepoEnvPath) {
            Object.assign(mergedEnv, await this.readEnvFile(projectRepoEnvPath));
        }
        if (projectEnvPath) {
            Object.assign(mergedEnv, await this.readEnvFile(projectEnvPath));
        }
        Object.assign(mergedEnv, await this.readEnvFile(agentEnvPath));

        // PIN: HOME must never be overridden by .env files
        // Tools like `gh auth` rely on the real user home for credentials (~/.config/gh/)
        if (originalHome !== undefined) {
            mergedEnv.HOME = originalHome;
        }

        // Provide agent home as a separate variable (TENEX_AGENT_HOME)
        mergedEnv.TENEX_AGENT_HOME = path.dirname(agentEnvPath);

        return mergedEnv;
    }

    private async resolveAgentNsec(params: EnsureAgentHomeEnvParams): Promise<string> {
        if (params.agentNsec?.trim()) {
            return params.agentNsec.trim();
        }

        const agent = await this.agentLoader.loadAgent(params.agentPubkey);
        if (!agent?.nsec?.trim()) {
            throw new Error(
                `Could not resolve nsec for agent ${params.agentPubkey.slice(0, 8)}`
            );
        }

        return agent.nsec.trim();
    }

    private async readEnvFile(filePath: string): Promise<Record<string, string>> {
        if (!(await fileExists(filePath))) {
            return {};
        }

        const content = await readFile(filePath, "utf-8");

        try {
            return parseDotenv(content);
        } catch (error) {
            if (error instanceof DotenvParseError) {
                throw new AgentEnvironmentFileError(filePath, error.line, error.reason);
            }
            throw error;
        }
    }
}

export const agentEnvironmentService = new AgentEnvironmentService();
