import { describe, expect, it, mock } from "bun:test";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { createStoredAgent, deriveAgentPubkeyFromNsec, type StoredAgent } from "@/agents/AgentStorage";

let categorizeResult: string | undefined = "worker";

const categorizeAgentMock = mock(async () => categorizeResult);

mock.module("@/agents/categorizeAgent", () => ({
    categorizeAgent: categorizeAgentMock,
}));

const backfillModulePromise = import("../backfillAgentCategories");

function createAgent(params: {
    slug: string;
    name: string;
    role: string;
    category?: StoredAgent["category"];
    inferredCategory?: StoredAgent["inferredCategory"];
}): StoredAgent {
    const signer = NDKPrivateKeySigner.generate();
    const agent = createStoredAgent({
        nsec: signer.nsec,
        slug: params.slug,
        name: params.name,
        role: params.role,
        category: params.category,
    });

    if (params.inferredCategory) {
        agent.inferredCategory = params.inferredCategory;
    }

    return agent;
}

describe("backfillAgentCategories", () => {
    it("categorizes uncategorized agents and skips agents that already have a category", async () => {
        const { backfillAgentCategories } = await backfillModulePromise;
        const uncategorized = createAgent({
            slug: "needs-category",
            name: "Needs Category",
            role: "assistant",
        });
        const categorized = createAgent({
            slug: "already-categorized",
            name: "Already Categorized",
            role: "assistant",
            category: "generalist",
        });

        const updateInferredCategoryCalls: Array<{ pubkey: string; category: string }> = [];
        const storage = {
            initialize: async () => {},
            getCanonicalActiveAgents: async () => [uncategorized, categorized],
            updateInferredCategory: async (pubkey: string, category: string) => {
                updateInferredCategoryCalls.push({ pubkey, category });
                return true;
            },
        };

        categorizeResult = "orchestrator";
        const result = await backfillAgentCategories(storage);

        expect(result).toEqual({
            processed: 1,
            categorized: 1,
            skipped: 1,
            failed: 0,
        });
        expect(updateInferredCategoryCalls).toHaveLength(1);
        expect(updateInferredCategoryCalls[0]?.pubkey).toBe(deriveAgentPubkeyFromNsec(uncategorized.nsec));
        expect(updateInferredCategoryCalls[0]?.category).toBe("orchestrator");
    });

    it("supports dry runs without persisting changes", async () => {
        const { backfillAgentCategories } = await backfillModulePromise;
        const uncategorized = createAgent({
            slug: "dry-run-target",
            name: "Dry Run Target",
            role: "assistant",
        });

        const updateInferredCategory = mock(async () => true);
        const storage = {
            initialize: async () => {},
            getCanonicalActiveAgents: async () => [uncategorized],
            updateInferredCategory,
        };

        categorizeResult = "reviewer";
        const result = await backfillAgentCategories(storage, { dryRun: true });

        expect(result).toEqual({
            processed: 1,
            categorized: 1,
            skipped: 0,
            failed: 0,
        });
        expect(updateInferredCategory).not.toHaveBeenCalled();
    });
});
