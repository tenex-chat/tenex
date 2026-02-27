import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock logger
mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
    },
}));

// Mock ConfigService — needs to return valid paths even if tempDir isn't set yet.
// RAGCollectionRegistry constructor checks LANCEDB_DATA_DIR first, so we use that.
mock.module("@/services/ConfigService", () => ({
    config: {
        getConfigPath: () => "/tmp/unused-fallback",
    },
}));

import { RAGCollectionRegistry } from "../RAGCollectionRegistry";

describe("RAGCollectionRegistry", () => {
    let tempDir: string;
    let lanceDir: string;
    const origEnv = process.env.LANCEDB_DATA_DIR;

    beforeEach(() => {
        RAGCollectionRegistry.resetInstance();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-registry-test-"));
        lanceDir = path.join(tempDir, "lancedb");
        fs.mkdirSync(lanceDir, { recursive: true });
        // Point RAGCollectionRegistry to our temp directory via env var
        process.env.LANCEDB_DATA_DIR = lanceDir;
    });

    afterEach(() => {
        RAGCollectionRegistry.resetInstance();
        // Restore env
        if (origEnv === undefined) {
            delete process.env.LANCEDB_DATA_DIR;
        } else {
            process.env.LANCEDB_DATA_DIR = origEnv;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns singleton instance", () => {
        const a = RAGCollectionRegistry.getInstance();
        const b = RAGCollectionRegistry.getInstance();
        expect(a).toBe(b);
    });

    it("registers and retrieves collection metadata", () => {
        const registry = RAGCollectionRegistry.getInstance();

        registry.register("test_collection", {
            scope: "project",
            projectId: "project-123",
            agentPubkey: "agent-abc",
        });

        const metadata = registry.get("test_collection");
        expect(metadata).toBeDefined();
        expect(metadata!.scope).toBe("project");
        expect(metadata!.projectId).toBe("project-123");
        expect(metadata!.agentPubkey).toBe("agent-abc");
        expect(metadata!.createdAt).toBeGreaterThan(0);
    });

    it("returns undefined for unregistered collections", () => {
        const registry = RAGCollectionRegistry.getInstance();
        expect(registry.get("nonexistent")).toBeUndefined();
    });

    it("unregisters a collection", () => {
        const registry = RAGCollectionRegistry.getInstance();

        registry.register("to_remove", { scope: "global" });
        expect(registry.get("to_remove")).toBeDefined();

        registry.unregister("to_remove");
        expect(registry.get("to_remove")).toBeUndefined();
    });

    it("preserves createdAt on re-registration", () => {
        const registry = RAGCollectionRegistry.getInstance();

        registry.register("test", { scope: "global" });
        const firstCreatedAt = registry.get("test")!.createdAt;

        // Re-register with different scope
        registry.register("test", { scope: "project", projectId: "p1" });
        const metadata = registry.get("test")!;

        expect(metadata.scope).toBe("project");
        expect(metadata.projectId).toBe("p1");
        expect(metadata.createdAt).toBe(firstCreatedAt);
    });

    describe("getMatchingCollections", () => {
        it("includes all collections when none are registered (legacy behavior)", () => {
            const registry = RAGCollectionRegistry.getInstance();

            const result = registry.getMatchingCollections(
                ["legacy_a", "legacy_b", "legacy_c"],
                "project-1"
            );

            expect(result).toEqual(["legacy_a", "legacy_b", "legacy_c"]);
        });

        it("always includes global collections", () => {
            const registry = RAGCollectionRegistry.getInstance();
            registry.register("global_data", { scope: "global" });

            const result = registry.getMatchingCollections(
                ["global_data"],
                "any-project"
            );

            expect(result).toContain("global_data");
        });

        it("includes project collections when projectId matches", () => {
            const registry = RAGCollectionRegistry.getInstance();
            registry.register("project_docs", {
                scope: "project",
                projectId: "project-1",
            });
            registry.register("other_project_docs", {
                scope: "project",
                projectId: "project-2",
            });

            const result = registry.getMatchingCollections(
                ["project_docs", "other_project_docs"],
                "project-1"
            );

            expect(result).toContain("project_docs");
            expect(result).not.toContain("other_project_docs");
        });

        it("includes personal collections when agentPubkey matches", () => {
            const registry = RAGCollectionRegistry.getInstance();
            registry.register("my_notes", {
                scope: "personal",
                agentPubkey: "agent-1",
            });
            registry.register("other_notes", {
                scope: "personal",
                agentPubkey: "agent-2",
            });

            const result = registry.getMatchingCollections(
                ["my_notes", "other_notes"],
                "project-1",
                "agent-1"
            );

            expect(result).toContain("my_notes");
            expect(result).not.toContain("other_notes");
        });

        it("combines all scope types correctly", () => {
            const registry = RAGCollectionRegistry.getInstance();

            registry.register("global_knowledge", { scope: "global" });
            registry.register("project_docs", { scope: "project", projectId: "p1" });
            registry.register("other_project_docs", { scope: "project", projectId: "p2" });
            registry.register("my_scratch", { scope: "personal", agentPubkey: "agent-1" });
            registry.register("other_scratch", { scope: "personal", agentPubkey: "agent-2" });

            const result = registry.getMatchingCollections(
                ["global_knowledge", "project_docs", "other_project_docs", "my_scratch", "other_scratch", "legacy_collection"],
                "p1",
                "agent-1"
            );

            expect(result).toEqual([
                "global_knowledge",     // global → included
                "project_docs",         // project match → included
                // other_project_docs: project mismatch → excluded
                "my_scratch",           // personal match → included
                // other_scratch: personal mismatch → excluded
                "legacy_collection",    // unregistered → treated as global
            ]);
        });

        it("treats unregistered collections as global", () => {
            const registry = RAGCollectionRegistry.getInstance();

            // Register some but not all
            registry.register("registered", { scope: "project", projectId: "p2" });

            const result = registry.getMatchingCollections(
                ["registered", "unregistered"],
                "p1"
            );

            // registered is project-scoped for p2 (mismatch with p1) → excluded
            // unregistered has no metadata → treated as global → included
            expect(result).toEqual(["unregistered"]);
        });
    });

    it("persists data to disk and reloads", () => {
        const registry = RAGCollectionRegistry.getInstance();
        registry.register("persistent_coll", {
            scope: "project",
            projectId: "p1",
            agentPubkey: "agent-1",
        });

        // Reset and recreate — should reload from disk
        RAGCollectionRegistry.resetInstance();
        const newRegistry = RAGCollectionRegistry.getInstance();

        const metadata = newRegistry.get("persistent_coll");
        expect(metadata).toBeDefined();
        expect(metadata!.scope).toBe("project");
        expect(metadata!.projectId).toBe("p1");
    });
});
