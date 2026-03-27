/**
 * Tests for ConversationRegistry.resolveProjectId resolution chain
 *
 * Verifies the priority chain:
 *   1. Explicit projectId parameter
 *   2. AsyncLocalStorage context (projectContextStore)
 *   3. Single-project shortcut (unambiguous when only one project)
 *
 * Also tests that multiple initialize() calls accumulate entries.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { conversationRegistry } from "../ConversationRegistry";
// Import directly from the module file to avoid heavy barrel re-exports
// that trigger circular dependency chains through ProjectContext.
import { projectContextStore } from "@/services/projects/ProjectContextStore";
import { logger } from "@/utils/logger";

describe("ConversationRegistry.resolveProjectId", () => {
    const TEST_DIR = "/tmp/tenex-test-resolve-project-id";
    const PROJECT_A = "project-alpha";
    const PROJECT_B = "project-beta";

    beforeEach(() => {
        conversationRegistry.reset();
    });

    afterEach(() => {
        conversationRegistry.reset();
        mock.restore();
    });

    describe("Tier 1: Explicit projectId parameter", () => {
        it("should return the explicit projectId when provided", () => {
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, []);

            const result = conversationRegistry.resolveProjectId("explicit-project");
            expect(result).toBe("explicit-project");
        });

        it("should prefer explicit projectId over AsyncLocalStorage context", async () => {
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, []);

            // Even if ALS context is available, explicit param wins
            const mockProject = {
                tagValue: (tag: string) => (tag === "d" ? PROJECT_A : undefined),
            };
            const mockContext = { project: mockProject } as any;

            const result = await projectContextStore.run(mockContext, async () =>
                conversationRegistry.resolveProjectId("explicit-override")
            );

            expect(result).toBe("explicit-override");
        });
    });

    describe("Tier 2: AsyncLocalStorage context", () => {
        it("should resolve from ALS context when no explicit param given", async () => {
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, []);

            const mockProject = {
                tagValue: (tag: string) => (tag === "d" ? PROJECT_A : undefined),
            };
            const mockContext = { project: mockProject } as any;

            const result = await projectContextStore.run(mockContext, async () =>
                conversationRegistry.resolveProjectId()
            );

            expect(result).toBe(PROJECT_A);
        });

        it("should fall through when ALS context has unknown project dTag", async () => {
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, []);

            const mockProject = {
                tagValue: (tag: string) => (tag === "d" ? "unknown-project" : undefined),
            };
            const mockContext = { project: mockProject } as any;

            const result = await projectContextStore.run(mockContext, async () =>
                conversationRegistry.resolveProjectId()
            );

            // Should fall through to single-project shortcut
            expect(result).toBe(PROJECT_A);
        });

        it("should fall through when ALS context project has no dTag", async () => {
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, []);

            const mockProject = {
                tagValue: () => undefined,
            };
            const mockContext = { project: mockProject } as any;

            const result = await projectContextStore.run(mockContext, async () =>
                conversationRegistry.resolveProjectId()
            );

            // Should fall through to single-project shortcut
            expect(result).toBe(PROJECT_A);
        });
    });

    describe("Tier 3: Single-project shortcut", () => {
        it("should return the sole project when only one is initialized", () => {
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, []);

            // Outside any ALS context — should return the only initialized project
            const result = conversationRegistry.resolveProjectId();
            expect(result).toBe(PROJECT_A);
        });

        it("should return null when multiple projects are initialized without ALS context", () => {
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, []);
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_B}`, []);

            // Outside ALS context with 2 projects => no safe resolution
            const result = conversationRegistry.resolveProjectId();
            expect(result).toBeNull();
        });

        it("should not log any warnings in multi-project mode", () => {
            const warnSpy = spyOn(logger, "warn");
            warnSpy.mockClear();

            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, []);
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_B}`, []);

            conversationRegistry.resolveProjectId();

            // No legacy fallback warning should be emitted
            const fallbackCalls = warnSpy.mock.calls.filter(
                (call) =>
                    typeof call[0] === "string" && call[0].includes("legacy projectId fallback")
            );
            expect(fallbackCalls).toHaveLength(0);
        });

        it("should return null when no project has been initialized", () => {
            const result = conversationRegistry.resolveProjectId();
            expect(result).toBeNull();
        });
    });

    describe("Multiple initialize() calls accumulate entries", () => {
        it("should accumulate project configs across multiple initialize() calls", async () => {
            const agentsA = ["pubkey-a1", "pubkey-a2"];
            const agentsB = ["pubkey-b1"];

            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, agentsA);
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_B}`, agentsB);

            // Both projects should be resolvable via ALS
            const mockProjectA = {
                tagValue: (tag: string) => (tag === "d" ? PROJECT_A : undefined),
            };
            const contextA = { project: mockProjectA } as any;

            const resolvedA = await projectContextStore.run(contextA, async () =>
                conversationRegistry.resolveProjectId()
            );
            expect(resolvedA).toBe(PROJECT_A);

            const mockProjectB = {
                tagValue: (tag: string) => (tag === "d" ? PROJECT_B : undefined),
            };
            const contextB = { project: mockProjectB } as any;

            const resolvedB = await projectContextStore.run(contextB, async () =>
                conversationRegistry.resolveProjectId()
            );
            expect(resolvedB).toBe(PROJECT_B);
        });

        it("should return project-specific agent pubkeys via ALS context", async () => {
            const agentsA = ["pubkey-a1", "pubkey-a2"];
            const agentsB = ["pubkey-b1"];

            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, agentsA);
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_B}`, agentsB);

            // In project A context, should see project A agents
            const mockProjectA = {
                tagValue: (tag: string) => (tag === "d" ? PROJECT_A : undefined),
            };
            const contextA = { project: mockProjectA } as any;

            const pubkeysA = await projectContextStore.run(contextA, async () =>
                conversationRegistry.agentPubkeys
            );
            expect(pubkeysA).toEqual(new Set(agentsA));

            // In project B context, should see project B agents
            const mockProjectB = {
                tagValue: (tag: string) => (tag === "d" ? PROJECT_B : undefined),
            };
            const contextB = { project: mockProjectB } as any;

            const pubkeysB = await projectContextStore.run(contextB, async () =>
                conversationRegistry.agentPubkeys
            );
            expect(pubkeysB).toEqual(new Set(agentsB));
        });

        it("should merge all agent pubkeys into allAgentPubkeys union", () => {
            const agentsA = ["pubkey-a1", "pubkey-a2"];
            const agentsB = ["pubkey-b1", "pubkey-a1"]; // pubkey-a1 overlaps

            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, agentsA);
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_B}`, agentsB);

            // isAgentPubkey checks the union across all projects
            expect(conversationRegistry.isAgentPubkey("pubkey-a1")).toBe(true);
            expect(conversationRegistry.isAgentPubkey("pubkey-a2")).toBe(true);
            expect(conversationRegistry.isAgentPubkey("pubkey-b1")).toBe(true);
            expect(conversationRegistry.isAgentPubkey("pubkey-unknown")).toBe(false);
        });

        it("should not overwrite first project config when second is initialized", () => {
            const agentsA = ["pubkey-a1"];
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, agentsA);

            // Verify project A is registered
            expect(conversationRegistry.isAgentPubkey("pubkey-a1")).toBe(true);

            const agentsB = ["pubkey-b1"];
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_B}`, agentsB);

            // Project A's agents should still be accessible
            expect(conversationRegistry.isAgentPubkey("pubkey-a1")).toBe(true);
            expect(conversationRegistry.isAgentPubkey("pubkey-b1")).toBe(true);
        });

        it("should return null outside ALS context with multiple projects", () => {
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_A}`, []);
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_B}`, []);

            // Outside ALS context with multiple projects — no safe resolution
            const result = conversationRegistry.resolveProjectId();
            expect(result).toBeNull();
        });
    });
});
