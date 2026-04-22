import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";

export type AgentRuntimeMode = "all_except" | "only";

export interface AgentRuntimePolicy {
    mode: AgentRuntimeMode;
    slugs: string[];
}

const DEFAULT_POLICY: AgentRuntimePolicy = {
    mode: "all_except",
    slugs: [],
};

function normalizeSlug(slug: string): string {
    return slug.trim().toLowerCase();
}

function normalizePolicy(policy: AgentRuntimePolicy | undefined): AgentRuntimePolicy | undefined {
    if (!policy) return undefined;

    return {
        mode: policy.mode,
        slugs: Array.from(
            new Set(policy.slugs.map(normalizeSlug).filter((slug) => slug.length > 0))
        ),
    };
}

export function parseAgentRuntimeSlugList(input: string | undefined): string[] {
    if (!input) return [];

    return Array.from(
        new Set(
            input
                .split(",")
                .map(normalizeSlug)
                .filter((slug) => slug.length > 0)
        )
    );
}

export class AgentRuntimePolicyService {
    private runtimeOverride?: AgentRuntimePolicy;

    setRuntimeOverride(policy: AgentRuntimePolicy | undefined): void {
        this.runtimeOverride = normalizePolicy(policy);
        if (this.runtimeOverride) {
            logger.info("[AgentRuntimePolicy] runtime override configured", this.runtimeOverride);
        }
    }

    getPolicy(): AgentRuntimePolicy {
        if (this.runtimeOverride) {
            return this.runtimeOverride;
        }

        try {
            const configured = config.getConfig().agentRuntime;
            return normalizePolicy({
                mode: configured?.mode ?? DEFAULT_POLICY.mode,
                slugs: configured?.slugs ?? DEFAULT_POLICY.slugs,
            }) ?? DEFAULT_POLICY;
        } catch {
            return DEFAULT_POLICY;
        }
    }

    shouldRunAgentSlug(slug: string): boolean {
        const policy = this.getPolicy();
        const slugSet = new Set(policy.slugs);
        const normalizedSlug = normalizeSlug(slug);

        if (policy.mode === "only") {
            return slugSet.has(normalizedSlug);
        }

        return !slugSet.has(normalizedSlug);
    }
}

export const agentRuntimePolicyService = new AgentRuntimePolicyService();
