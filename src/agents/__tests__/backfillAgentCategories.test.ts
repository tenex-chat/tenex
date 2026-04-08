import { afterEach, describe, expect, mock, test } from "bun:test";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

let categorizeResult: "principal" | "orchestrator" | "worker" | "reviewer" | "domain-expert" | "generalist" | undefined = "worker";
let updateCalls: Array<{ pubkey: string; category: string }> = [];
let initializeCalls = 0;

mock.module("@/agents/categorizeAgent", () => ({
    categorizeAgent: async () => categorizeResult,
}));

const { backfillAgentCategories } = await import("../backfillAgentCategories");

afterEach(() => {
    categorizeResult = "worker";
    updateCalls = [];
    initializeCalls = 0;
    mock.restore();
});

describe("backfillAgentCategories", () => {
    test("categorizes uncategorized agents and persists inferred category", async () => {
        const signer = NDKPrivateKeySigner.generate();
        const pubkey = signer.pubkey;

        const storage = {
            initialize: async () => {
                initializeCalls++;
            },
            getCanonicalActiveAgents: async () => [
                {
                    nsec: signer.nsec,
                    slug: "uncategorized-agent",
                    name: "Uncategorized Agent",
                    role: "assistant",
                },
                {
                    nsec: NDKPrivateKeySigner.generate().nsec,
                    slug: "already-categorized",
                    name: "Already Categorized",
                    role: "assistant",
                    category: "worker",
                },
            ],
            updateInferredCategory: async (incomingPubkey: string, category: string) => {
                updateCalls.push({ pubkey: incomingPubkey, category });
                return true;
            },
        };

        const result = await backfillAgentCategories(storage, { dryRun: false });

        expect(initializeCalls).toBe(1);
        expect(result.processed).toBe(1);
        expect(result.categorized).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.failed).toBe(0);
        expect(updateCalls).toEqual([{ pubkey, category: "worker" }]);
    });

    test("does not persist during dry run", async () => {
        const signer = NDKPrivateKeySigner.generate();

        const storage = {
            initialize: async () => {
                initializeCalls++;
            },
            getCanonicalActiveAgents: async () => [
                {
                    nsec: signer.nsec,
                    slug: "dry-run-agent",
                    name: "Dry Run Agent",
                    role: "assistant",
                },
            ],
            updateInferredCategory: async () => {
                updateCalls.push({ pubkey: "unexpected", category: "unexpected" });
                return true;
            },
        };

        const result = await backfillAgentCategories(storage, { dryRun: true });

        expect(initializeCalls).toBe(1);
        expect(result.processed).toBe(1);
        expect(result.categorized).toBe(1);
        expect(result.skipped).toBe(0);
        expect(result.failed).toBe(0);
        expect(updateCalls).toHaveLength(0);
    });

    test("counts failed categorizations", async () => {
        categorizeResult = undefined;

        const storage = {
            initialize: async () => {
                initializeCalls++;
            },
            getCanonicalActiveAgents: async () => [
                {
                    nsec: NDKPrivateKeySigner.generate().nsec,
                    slug: "failing-agent",
                    name: "Failing Agent",
                    role: "assistant",
                },
            ],
            updateInferredCategory: async () => true,
        };

        const result = await backfillAgentCategories(storage, { dryRun: false });

        expect(initializeCalls).toBe(1);
        expect(result.processed).toBe(1);
        expect(result.categorized).toBe(0);
        expect(result.skipped).toBe(0);
        expect(result.failed).toBe(1);
        expect(updateCalls).toHaveLength(0);
    });
});
