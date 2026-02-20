import { describe, expect, it, mock } from "bun:test";
import { ragCollectionsFragment } from "../29-rag-collections";

// Mock the logger to avoid console output during tests
mock.module("@/utils/logger", () => ({
    logger: {
        warn: () => {},
        info: () => {},
        error: () => {},
        debug: () => {},
    },
}));

describe("rag-collections fragment", () => {
    describe("ragCollectionsFragment.template", () => {
        it("should return empty string when no collections have contributions", () => {
            const result = ragCollectionsFragment.template({
                agentPubkey: "test-pubkey",
                collections: [
                    { name: "collection1", agentDocCount: 0, totalDocCount: 100 },
                    { name: "collection2", agentDocCount: 0, totalDocCount: 50 },
                ],
            });

            expect(result).toBe("");
        });

        it("should return empty string when collections array is empty", () => {
            const result = ragCollectionsFragment.template({
                agentPubkey: "test-pubkey",
                collections: [],
            });

            expect(result).toBe("");
        });

        it("should show collections where agent has contributions", () => {
            const result = ragCollectionsFragment.template({
                agentPubkey: "test-pubkey",
                collections: [
                    { name: "architecture_decisions", agentDocCount: 47, totalDocCount: 123 },
                    { name: "user_feedback", agentDocCount: 12, totalDocCount: 89 },
                ],
            });

            expect(result).toContain("## Your RAG Collections");
            expect(result).toContain("Collections you've contributed to:");
            expect(result).toContain("`architecture_decisions` — 47 docs by you (123 total)");
            expect(result).toContain("`user_feedback` — 12 docs by you (89 total)");
        });

        it("should only include collections with agent contributions", () => {
            const result = ragCollectionsFragment.template({
                agentPubkey: "test-pubkey",
                collections: [
                    { name: "has_contributions", agentDocCount: 5, totalDocCount: 100 },
                    { name: "no_contributions", agentDocCount: 0, totalDocCount: 50 },
                    { name: "also_has_contributions", agentDocCount: 3, totalDocCount: 25 },
                ],
            });

            expect(result).toContain("`has_contributions` — 5 docs by you (100 total)");
            expect(result).toContain("`also_has_contributions` — 3 docs by you (25 total)");
            expect(result).not.toContain("no_contributions");
        });

        it("should handle single collection contribution", () => {
            const result = ragCollectionsFragment.template({
                agentPubkey: "test-pubkey",
                collections: [
                    { name: "single_collection", agentDocCount: 1, totalDocCount: 1 },
                ],
            });

            expect(result).toContain("## Your RAG Collections");
            expect(result).toContain("`single_collection` — 1 docs by you (1 total)");
        });
    });

    describe("fragment metadata", () => {
        it("should have correct id", () => {
            expect(ragCollectionsFragment.id).toBe("rag-collections");
        });

        it("should have priority 29 (after agent-directed-monitoring, before worktree-context)", () => {
            expect(ragCollectionsFragment.priority).toBe(29);
        });

        it("should have expected args documentation", () => {
            expect(ragCollectionsFragment.expectedArgs).toBe(
                "{ agentPubkey: string, collections: RAGCollectionStats[] }"
            );
        });
    });
});
