/**
 * Tests for DaemonRouter
 *
 * Focuses on cross-project routing behavior when agents exist in multiple projects.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { determineTargetProject } from "../DaemonRouter";
import type { NDKEvent, NDKProject } from "@nostr-dev-kit/ndk";
import type { ProjectRuntime } from "../../ProjectRuntime";
import { createProjectDTag, type ProjectDTag } from "@/types/project-ids";

// Mock logger
mock.module("@/utils/logger", () => ({
    logger: {
        debug: mock(() => {}),
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
    },
}));

describe("determineTargetProject", () => {
    // Shared test data
    const projectAPubkey = "aaaa0000000000000000000000000000000000000000000000000000000000aa";
    const projectBPubkey = "bbbb0000000000000000000000000000000000000000000000000000000000bb";
    // NIP-33 addresses (used in a-tag values from Nostr events)
    const projectAAddress = `31933:${projectAPubkey}:project-a`;
    const projectBAddress = `31933:${projectBPubkey}:project-b`;
    // D-tags (used internally as Map keys)
    const projectADTag = createProjectDTag("project-a");
    const projectBDTag = createProjectDTag("project-b");

    const agentXPubkey = "xxxx0000000000000000000000000000000000000000000000000000000000xx";
    const agentYPubkey = "yyyy0000000000000000000000000000000000000000000000000000000000yy";

    let knownProjects: Map<ProjectDTag, NDKProject>;
    let agentPubkeyToProjects: Map<string, Set<ProjectDTag>>;
    let activeRuntimes: Map<ProjectDTag, ProjectRuntime>;

    beforeEach(() => {
        // Setup known projects (keyed by d-tag)
        knownProjects = new Map([
            [projectADTag, { tagValue: () => "Project A" } as unknown as NDKProject],
            [projectBDTag, { tagValue: () => "Project B" } as unknown as NDKProject],
        ]);

        // Agent X exists in BOTH projects
        // Agent Y exists only in Project A
        agentPubkeyToProjects = new Map([
            [agentXPubkey, new Set([projectADTag, projectBDTag])],
            [agentYPubkey, new Set([projectADTag])],
        ]);

        // Both projects are running
        activeRuntimes = new Map([
            [projectADTag, createMockRuntime(projectADTag, [agentXPubkey, agentYPubkey])],
            [projectBDTag, createMockRuntime(projectBDTag, [agentXPubkey])],
        ]);
    });

    function createMockRuntime(projectId: string, agentPubkeys: string[]): ProjectRuntime {
        return {
            getContext: () => ({
                agentRegistry: {
                    getAllAgents: () => agentPubkeys.map(pk => ({ pubkey: pk, slug: `agent-${pk.slice(0, 4)}` })),
                },
            }),
        } as unknown as ProjectRuntime;
    }

    function createMockEvent(tags: string[][], pubkey = "some-pubkey"): NDKEvent {
        return {
            id: "test-event-id-1234567890abcdef1234567890abcdef1234567890abcdef",
            pubkey,
            kind: 1,
            tags,
            content: "Test content",
        } as unknown as NDKEvent;
    }

    describe("A-tag priority over P-tag", () => {
        test("should route via A-tag when present, ignoring P-tag", () => {
            // Delegation event from Agent Y in Project A to Agent X
            // Agent X exists in both projects, but A-tag should route to Project A
            const event = createMockEvent([
                ["p", agentXPubkey], // P-tag to Agent X (exists in both projects)
                ["a", projectAAddress],   // A-tag explicitly pointing to Project A
            ], agentYPubkey);

            const result = determineTargetProject(
                event,
                knownProjects,
                agentPubkeyToProjects as any,
                activeRuntimes
            );

            expect(result.projectId).toBe(projectADTag);
            expect(result.method).toBe("a_tag");
        });

        test("should NOT fall back to P-tag when A-tag matches", () => {
            // Even if P-tag would route to Project B, A-tag should win
            const event = createMockEvent([
                ["p", agentXPubkey], // P-tag to Agent X
                ["a", projectAAddress],   // A-tag to Project A
            ], agentYPubkey);

            const result = determineTargetProject(
                event,
                knownProjects,
                agentPubkeyToProjects as any,
                activeRuntimes
            );

            // Should use A-tag, not P-tag
            expect(result.method).toBe("a_tag");
            expect(result.projectId).toBe(projectADTag);
        });

        test("should route via P-tag only when no valid A-tag present", () => {
            // Event without A-tag, only P-tag to agent in single project
            activeRuntimes = new Map([
                [projectADTag, createMockRuntime(projectADTag, [agentXPubkey, agentYPubkey])],
                // Project B is NOT running
            ]);

            const event = createMockEvent([
                ["p", agentXPubkey], // P-tag to Agent X (only Project A running)
            ], agentYPubkey);

            const result = determineTargetProject(
                event,
                knownProjects,
                agentPubkeyToProjects as any,
                activeRuntimes
            );

            expect(result.projectId).toBe(projectADTag);
            expect(result.method).toBe("p_tag_agent");
        });
    });

    describe("Multi-project agent disambiguation", () => {
        test("should fail routing when agent is in multiple ACTIVE projects without A-tag", () => {
            // Event to Agent X who exists in both running projects, without A-tag
            const event = createMockEvent([
                ["p", agentXPubkey], // P-tag to Agent X (in both Project A and B)
                // No A-tag - ambiguous!
            ], "external-pubkey");

            const result = determineTargetProject(
                event,
                knownProjects,
                agentPubkeyToProjects as any,
                activeRuntimes
            );

            // Should return null because we can't determine the correct project
            expect(result.projectId).toBeNull();
            expect(result.method).toBe("none");
        });

        test("should route to single active project when agent is in multiple projects but only one is running", () => {
            // Only Project A is running
            activeRuntimes = new Map([
                [projectADTag, createMockRuntime(projectADTag, [agentXPubkey, agentYPubkey])],
                // Project B is NOT running
            ]);

            const event = createMockEvent([
                ["p", agentXPubkey], // P-tag to Agent X
                // No A-tag
            ], "external-pubkey");

            const result = determineTargetProject(
                event,
                knownProjects,
                agentPubkeyToProjects as any,
                activeRuntimes
            );

            // Should route to the only active project
            expect(result.projectId).toBe(projectADTag);
            expect(result.method).toBe("p_tag_agent");
        });
    });

    describe("A-tag with unknown project", () => {
        test("should fall back to P-tag when A-tag references unknown project", () => {
            const unknownProjectId = "31933:unknownpubkey:unknown-project";

            // Only Project A is running (for clean P-tag routing)
            activeRuntimes = new Map([
                [projectADTag, createMockRuntime(projectADTag, [agentXPubkey, agentYPubkey])],
            ]);

            const event = createMockEvent([
                ["p", agentXPubkey],      // P-tag to Agent X
                ["a", unknownProjectId],  // A-tag to unknown project
            ], "external-pubkey");

            const result = determineTargetProject(
                event,
                knownProjects,
                agentPubkeyToProjects as any,
                activeRuntimes
            );

            // Should fall back to P-tag since A-tag doesn't match known projects
            expect(result.projectId).toBe(projectADTag);
            expect(result.method).toBe("p_tag_agent");
        });
    });

    describe("Tag format handling", () => {
        test("should handle lowercase 'a' tags", () => {
            const event = createMockEvent([
                ["a", projectAAddress], // lowercase 'a'
            ]);

            const result = determineTargetProject(
                event,
                knownProjects,
                agentPubkeyToProjects as any,
                activeRuntimes
            );

            expect(result.projectId).toBe(projectADTag);
            expect(result.method).toBe("a_tag");
        });

        test("should NOT handle uppercase 'A' tags (NIP-33 uses lowercase only)", () => {
            // NIP-33 addressable events use lowercase 'a' tags only
            // Uppercase 'A' is NIP-22 (comments) which we don't support
            const event = createMockEvent([
                ["A", projectADTag], // uppercase 'A' - should NOT match
            ]);

            const result = determineTargetProject(
                event,
                knownProjects,
                agentPubkeyToProjects as any,
                activeRuntimes
            );

            // Uppercase 'A' tags should NOT be recognized as project references
            expect(result.projectId).toBe(null);
            expect(result.method).toBe("none");
        });
    });

    describe("Cross-project delegation scenario", () => {
        test("delegation from Project A should route to Project A even when target agent exists in both projects", () => {
            // This tests the core bug scenario:
            // 1. Agent Y in Project A delegates to Agent X
            // 2. Agent X exists in both Project A and Project B
            // 3. The delegation event has A-tag for Project A
            // 4. The event MUST route to Project A (not Project B)

            // Delegation event from Agent Y (Project A only) to Agent X (both projects)
            const delegationEvent = createMockEvent([
                ["p", agentXPubkey],     // Target: Agent X (exists in both A and B)
                ["a", projectAAddress],       // A-tag: Project A (caller's project)
                ["delegation", "parent-conversation-id"], // Delegation marker
            ], agentYPubkey); // Author: Agent Y (only in Project A)

            const result = determineTargetProject(
                delegationEvent,
                knownProjects,
                agentPubkeyToProjects as any,
                activeRuntimes
            );

            // CRITICAL: Must route to Project A via A-tag, NOT fall back to P-tag
            expect(result.projectId).toBe(projectADTag);
            expect(result.method).toBe("a_tag");
            expect(result.matchedTags).toContain(projectAAddress);
        });

        test("completion from delegated agent should route back to caller's project", () => {
            // When Agent X completes a delegation, the completion event should
            // route back to the project where the delegation originated

            // Completion event from Agent X back to Agent Y
            const completionEvent = createMockEvent([
                ["p", agentYPubkey],     // Target: Agent Y (only in Project A)
                ["a", projectAAddress],       // A-tag: Project A (where delegation originated)
                ["status", "completed"],
                ["e", "delegation-event-id"],
            ], agentXPubkey); // Author: Agent X (in both A and B)

            const result = determineTargetProject(
                completionEvent,
                knownProjects,
                agentPubkeyToProjects as any,
                activeRuntimes
            );

            // Must route to Project A via A-tag
            expect(result.projectId).toBe(projectADTag);
            expect(result.method).toBe("a_tag");
        });
    });
});
