import { afterEach, beforeEach, describe, expect, it, spyOn, mock } from "bun:test";
import type { ToolExecutionContext } from "@/tools/types";
import type { AgentInstance } from "@/agents/types";
import * as nostrModule from "@/nostr";
import * as skillModule from "@/services/skill";

// Track delegate calls to verify skill propagation
const delegateCallArgs: Array<{ skills?: string[] }> = [];

import { RALRegistry } from "@/services/ral";
import { createDelegateTool } from "@/tools/implementations/delegate";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";

// Mock the resolution function to return pubkeys for our test agents
import * as agentResolution from "@/services/agents";

const createTriggeringEnvelope = (skillTags: string[][] = []) =>
    createMockInboundEnvelope({
        metadata: {
            skillEventIds: skillTags
                .filter((tag) => tag[0] === "skill" && Boolean(tag[1]))
                .map((tag) => tag[1]),
        },
    });

describe("Delegate Tool - Skill Propagation", () => {
    const conversationId = "test-conversation-id";
    const projectId = "31933:pubkey:test-project";
    let registry: RALRegistry;
    let getNDKSpy: ReturnType<typeof spyOn>;
    let resolveAgentSlugSpy: ReturnType<typeof spyOn>;

    const defaultTodo = {
        id: "test-todo",
        title: "Test Todo",
        description: "Test",
        status: "pending" as const,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };

    /**
     * Create a mock context with optional skill tags on the triggering event
     */
    const createMockContext = (ralNumber: number, skillTags: string[][] = []): ToolExecutionContext => ({
        agent: {
            slug: "self-agent",
            name: "Self Agent",
            pubkey: "agent-pubkey-123",
        } as AgentInstance,
        conversationId,
        triggeringEnvelope: createTriggeringEnvelope(skillTags),
        agentPublisher: {
            delegate: async (config: any) => {
                // Track the delegate call to verify skill propagation
                delegateCallArgs.push({ skills: config.skills });
                return `mock-delegation-id-${Math.random().toString(36).substring(7)}`;
            },
            delegationMarker: async () => ({ id: "marker-id" }),
        } as any,
        ralNumber,
        projectBasePath: "/tmp/test",
        workingDirectory: "/tmp/test",
        currentBranch: "main",
        getConversation: () => ({
            getRootEventId: () => conversationId,
            getTodos: () => [defaultTodo],
            addDelegationMarker: () => {},
            save: async () => {},
        }) as any,
    });

    beforeEach(() => {
        // Reset singleton and call tracking
        // @ts-expect-error - accessing private static for testing
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();
        delegateCallArgs.length = 0;
        getNDKSpy = spyOn(nostrModule, "getNDK").mockReturnValue({
            fetchEvent: async () => null,
        } as never);
        resolveAgentSlugSpy = spyOn(agentResolution, "resolveAgentSlug").mockImplementation(
            (slug: string) => {
                const availableSlugs = ["self-agent", "other-agent", "third-agent"];
                if (slug === "self-agent") {
                    return { pubkey: "agent-pubkey-123", availableSlugs };
                }
                if (slug === "other-agent") {
                    return { pubkey: "other-pubkey-456", availableSlugs };
                }
                if (slug === "third-agent") {
                    return { pubkey: "third-pubkey-789", availableSlugs };
                }
                return { pubkey: null, availableSlugs };
            }
        );
    });

    afterEach(() => {
        delegateCallArgs.length = 0;
        getNDKSpy?.mockRestore();
        resolveAgentSlugSpy?.mockRestore();
        mock.restore();
    });

    describe("skill inheritance", () => {
        it("should resolve prompt-facing skill ids before delegating", async () => {
            const resolvedSkillId = "a".repeat(64);
            const skillResolverSpy = spyOn(
                skillModule.SkillIdentifierResolver,
                "getInstance"
            ).mockReturnValue({
                resolveSkillIdentifier: (identifier: string) =>
                    identifier === "be-brief" ? resolvedSkillId : null,
            } as never);

            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);
            const context = createMockContext(ralNumber, []);
            const delegateTool = createDelegateTool(context);

            const result = await delegateTool.execute({
                delegations: [
                    {
                        recipient: "other-agent",
                        prompt: "Do something",
                        skills: ["be-brief"],
                    }
                ],
            });

            expect(result.success).toBe(true);
            expect(delegateCallArgs.length).toBe(1);
            expect(delegateCallArgs[0].skills).toEqual([resolvedSkillId]);

            skillResolverSpy.mockRestore();
        });

        it("should inherit skills from triggering event and pass to delegated agent", async () => {
            const inheritedSkill1 = "inherited-skill-event-id-1";
            const inheritedSkill2 = "inherited-skill-event-id-2";

            const skillTags = [
                ["skill", inheritedSkill1],
                ["skill", inheritedSkill2],
            ];

            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);
            const context = createMockContext(ralNumber, skillTags);
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "other-agent", prompt: "Do something" }
                ],
            };

            const result = await delegateTool.execute(input);
            expect(result.success).toBe(true);

            // Verify delegate was called with inherited skills
            expect(delegateCallArgs.length).toBe(1);
            expect(delegateCallArgs[0].skills).toContain(inheritedSkill1);
            expect(delegateCallArgs[0].skills).toContain(inheritedSkill2);
        });

        it("should combine inherited skills with explicit skills", async () => {
            const inheritedSkill = "inherited-skill-id";
            const explicitSkill = "explicit-skill-id";

            const skillTags = [["skill", inheritedSkill]];

            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);
            const context = createMockContext(ralNumber, skillTags);
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    {
                        recipient: "other-agent",
                        prompt: "Do something",
                        skills: [explicitSkill],
                    }
                ],
            };

            const result = await delegateTool.execute(input);
            expect(result.success).toBe(true);

            // Verify delegate was called with BOTH inherited and explicit skills
            expect(delegateCallArgs.length).toBe(1);
            expect(delegateCallArgs[0].skills).toContain(inheritedSkill);
            expect(delegateCallArgs[0].skills).toContain(explicitSkill);
            expect(delegateCallArgs[0].skills?.length).toBe(2);
        });

        it("should deduplicate skills when explicit skill is same as inherited", async () => {
            const sameSkillId = "same-skill-id";

            const skillTags = [["skill", sameSkillId]];

            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);
            const context = createMockContext(ralNumber, skillTags);
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    {
                        recipient: "other-agent",
                        prompt: "Do something",
                        skills: [sameSkillId], // Same as inherited
                    }
                ],
            };

            const result = await delegateTool.execute(input);
            expect(result.success).toBe(true);

            // Verify skill appears only ONCE (deduplication)
            expect(delegateCallArgs.length).toBe(1);
            expect(delegateCallArgs[0].skills?.length).toBe(1);
            expect(delegateCallArgs[0].skills).toContain(sameSkillId);
        });

        it("should handle no skills gracefully", async () => {
            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);
            const context = createMockContext(ralNumber, []); // No skill tags
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "other-agent", prompt: "Do something" }
                ],
            };

            const result = await delegateTool.execute(input);
            expect(result.success).toBe(true);

            // Verify delegate was called without skills (undefined or empty)
            expect(delegateCallArgs.length).toBe(1);
            const skills = delegateCallArgs[0].skills;
            expect(skills === undefined || skills.length === 0).toBe(true);
        });
    });

    describe("multiple delegations", () => {
        it("should propagate skills to all delegated agents", async () => {
            const inheritedSkill = "inherited-skill-for-all";
            const skillTags = [["skill", inheritedSkill]];

            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);
            const context = createMockContext(ralNumber, skillTags);
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "other-agent", prompt: "Task 1" },
                    { recipient: "third-agent", prompt: "Task 2" },
                ],
            };

            const result = await delegateTool.execute(input);
            expect(result.success).toBe(true);
            expect(result.delegationConversationIds).toHaveLength(2);

            // Verify BOTH delegations received the inherited skill
            expect(delegateCallArgs.length).toBe(2);
            expect(delegateCallArgs[0].skills).toContain(inheritedSkill);
            expect(delegateCallArgs[1].skills).toContain(inheritedSkill);
        });

        it("should allow different explicit skills per delegation while still inheriting", async () => {
            const inheritedSkill = "inherited-skill";
            const explicitSkill1 = "explicit-skill-1";
            const explicitSkill2 = "explicit-skill-2";

            const skillTags = [["skill", inheritedSkill]];

            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);
            const context = createMockContext(ralNumber, skillTags);
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    { recipient: "other-agent", prompt: "Task 1", skills: [explicitSkill1] },
                    { recipient: "third-agent", prompt: "Task 2", skills: [explicitSkill2] },
                ],
            };

            const result = await delegateTool.execute(input);
            expect(result.success).toBe(true);

            // First delegation: inherited + explicit1
            expect(delegateCallArgs[0].skills).toContain(inheritedSkill);
            expect(delegateCallArgs[0].skills).toContain(explicitSkill1);
            expect(delegateCallArgs[0].skills).not.toContain(explicitSkill2);

            // Second delegation: inherited + explicit2
            expect(delegateCallArgs[1].skills).toContain(inheritedSkill);
            expect(delegateCallArgs[1].skills).toContain(explicitSkill2);
            expect(delegateCallArgs[1].skills).not.toContain(explicitSkill1);
        });
    });

    describe("explicit skills array deduplication", () => {
        it("should deduplicate duplicate explicit skills", async () => {
            const skillId = "duplicate-skill";

            const agentPubkey = "agent-pubkey-123";
            const ralNumber = registry.create(agentPubkey, conversationId, projectId);
            const context = createMockContext(ralNumber, []);
            const delegateTool = createDelegateTool(context);

            const input = {
                delegations: [
                    {
                        recipient: "other-agent",
                        prompt: "Task",
                        skills: [skillId, skillId, skillId], // Duplicates
                    }
                ],
            };

            const result = await delegateTool.execute(input);
            expect(result.success).toBe(true);

            // Verify only one skill (deduplicated)
            expect(delegateCallArgs.length).toBe(1);
            expect(delegateCallArgs[0].skills?.length).toBe(1);
            expect(delegateCallArgs[0].skills).toContain(skillId);
        });
    });
});
