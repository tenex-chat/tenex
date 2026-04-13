import { homedir } from "node:os";
import { join } from "node:path";
import { agentEnvironmentService } from "@/services/AgentEnvironmentService";
import type { ExecutionEnvironment } from "@/tools/types";

const ENV_VAR_PATTERN = /\$(\w+)|\$\{([^}]+)\}/g;

export interface ExpandedPathResult {
    expandedPath: string;
    unresolvedVars: string[];
}

export function pathNeedsExpansion(rawPath: string): boolean {
    const trimmed = rawPath.trim();
    return trimmed.startsWith("~") || /\$(\w+)|\$\{[^}]+\}/.test(trimmed);
}

export function pathNeedsEnvironmentResolution(rawPath: string): boolean {
    return /\$(\w+)|\$\{[^}]+\}/.test(rawPath);
}

export function expandPathWithEnvironment(rawPath: string, env: NodeJS.ProcessEnv): ExpandedPathResult {
    let expandedPath = rawPath.trim();

    if (expandedPath.startsWith("~")) {
        expandedPath = expandedPath === "~"
            ? homedir()
            : join(homedir(), expandedPath.slice(1));
    }

    const unresolvedVars = new Set<string>();
    expandedPath = expandedPath.replace(
        ENV_VAR_PATTERN,
        (match, simpleName: string, bracedName: string) => {
            const varName = (simpleName || bracedName).trim();
            const value = env[varName];

            if (typeof value === "string") {
                return value;
            }

            unresolvedVars.add(varName);
            return match;
        }
    );

    return {
        expandedPath,
        unresolvedVars: Array.from(unresolvedVars),
    };
}

export async function resolveToolEnvironment(context: ExecutionEnvironment): Promise<NodeJS.ProcessEnv> {
    const conversation = context.getConversation?.();
    const projectId = typeof conversation?.getProjectId === "function"
        ? conversation.getProjectId()
        : null;

    return await agentEnvironmentService.resolveShellEnvironment({
        agentPubkey: context.agent.pubkey,
        agentNsec: (context.agent.signer as { nsec?: string } | undefined)?.nsec,
        projectDTag: projectId,
        projectPath: context.projectBasePath || undefined,
        baseEnv: process.env,
    });
}

export async function expandPathFromContext(
    rawPath: string,
    context: ExecutionEnvironment,
    resolvedEnv?: NodeJS.ProcessEnv
): Promise<ExpandedPathResult> {
    const trimmed = rawPath.trim();
    if (!pathNeedsExpansion(trimmed)) {
        return {
            expandedPath: trimmed,
            unresolvedVars: [],
        };
    }

    if (!pathNeedsEnvironmentResolution(trimmed)) {
        return expandPathWithEnvironment(trimmed, process.env);
    }

    const env = resolvedEnv ?? await resolveToolEnvironment(context);
    return expandPathWithEnvironment(trimmed, env);
}

export function formatUnresolvedPathVariablesError(
    rawPath: string,
    unresolvedVars: string[],
    fieldName = "path"
): string {
    return `${fieldName} contains unresolved environment variable(s): ${unresolvedVars.map((value) => `$${value}`).join(", ")}. Raw ${fieldName}: "${rawPath}"`;
}
