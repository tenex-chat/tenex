import { describe, expect, it, mock, beforeEach, spyOn } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";

// Mock logger
mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(() => {}),
        debug: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
    },
}));

// Mock phase-utils
mock.module("@/utils/phase-utils", () => ({
    formatConversationSnapshot: mock(async () => "Mock conversation snapshot"),
}));

import {
    checkPhaseCompletion,
    scanHistoricalPhases,
    validatePhaseSkipping,
    buildValidationPrompt,
} from "../PhaseValidator";
import type { AgentInstance } from "@/agents/types";
import type { ToolExecutionTracker } from "../../ToolExecutionTracker";
import type { ExecutionContext } from "../../types";

describe("PhaseValidator", () => {
    describe("checkPhaseCompletion", () => {
        it("should return no skipped phases when agent has no phases defined", () => {
            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
                // No phases defined
            } as AgentInstance;

            const toolTracker = {
                getAllExecutions: () => new Map(),
            } as unknown as ToolExecutionTracker;

            const context = {
                getConversation: () => null,
                triggeringEvent: { id: "trigger-id" } as NDKEvent,
            } as unknown as ExecutionContext;

            const result = checkPhaseCompletion(agent, toolTracker, context);

            expect(result.skipped).toBe(false);
            expect(result.unusedPhases).toEqual([]);
        });

        it("should detect skipped phases when no delegations executed", () => {
            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
                phases: {
                    research: { agent: "researcher" },
                    implement: { agent: "coder" },
                },
            } as unknown as AgentInstance;

            const toolTracker = {
                getAllExecutions: () => new Map(),
            } as unknown as ToolExecutionTracker;

            const context = {
                getConversation: () => ({
                    history: [],
                }),
                triggeringEvent: { id: "trigger-id" } as NDKEvent,
            } as unknown as ExecutionContext;

            const result = checkPhaseCompletion(agent, toolTracker, context);

            expect(result.skipped).toBe(true);
            expect(result.unusedPhases).toContain("research");
            expect(result.unusedPhases).toContain("implement");
        });

        it("should recognize executed phases from delegate tool calls", () => {
            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
                phases: {
                    research: { agent: "researcher" },
                    implement: { agent: "coder" },
                },
            } as unknown as AgentInstance;

            const executions = new Map([
                [
                    "exec-1",
                    {
                        toolName: "delegate",
                        input: {
                            delegations: [{ phase: "research" }],
                        },
                    },
                ],
            ]);

            const toolTracker = {
                getAllExecutions: () => executions,
            } as unknown as ToolExecutionTracker;

            const context = {
                getConversation: () => ({
                    history: [],
                }),
                triggeringEvent: { id: "trigger-id" } as NDKEvent,
            } as unknown as ExecutionContext;

            const result = checkPhaseCompletion(agent, toolTracker, context);

            expect(result.skipped).toBe(true);
            expect(result.unusedPhases).not.toContain("research");
            expect(result.unusedPhases).toContain("implement");
        });

        it("should be case-insensitive for phase matching", () => {
            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
                phases: {
                    Research: { agent: "researcher" },
                },
            } as unknown as AgentInstance;

            const executions = new Map([
                [
                    "exec-1",
                    {
                        toolName: "delegate",
                        input: {
                            delegations: [{ phase: "RESEARCH" }],
                        },
                    },
                ],
            ]);

            const toolTracker = {
                getAllExecutions: () => executions,
            } as unknown as ToolExecutionTracker;

            const context = {
                getConversation: () => ({
                    history: [],
                }),
                triggeringEvent: { id: "trigger-id" } as NDKEvent,
            } as unknown as ExecutionContext;

            const result = checkPhaseCompletion(agent, toolTracker, context);

            expect(result.skipped).toBe(false);
            expect(result.unusedPhases).toEqual([]);
        });
    });

    describe("scanHistoricalPhases", () => {
        it("should return empty set when no conversation", () => {
            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
            } as AgentInstance;

            const context = {
                getConversation: () => null,
                triggeringEvent: { id: "trigger-id" } as NDKEvent,
            } as unknown as ExecutionContext;

            const result = scanHistoricalPhases(agent, context);

            expect(result.size).toBe(0);
        });

        it("should find phases from historical delegate events", () => {
            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
            } as AgentInstance;

            const historicalEvent = {
                id: "historical-event",
                pubkey: "agent-pubkey",
                tags: [
                    ["tool", "delegate"],
                    ["phase", "research"],
                ],
            };

            const context = {
                getConversation: () => ({
                    history: [historicalEvent],
                }),
                triggeringEvent: { id: "trigger-id" } as NDKEvent,
            } as unknown as ExecutionContext;

            const result = scanHistoricalPhases(agent, context);

            expect(result.has("research")).toBe(true);
        });

        it("should stop scanning at triggering event", () => {
            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
            } as AgentInstance;

            const beforeTrigger = {
                id: "before-trigger",
                pubkey: "agent-pubkey",
                tags: [
                    ["tool", "delegate"],
                    ["phase", "phase1"],
                ],
            };

            const triggerEvent = {
                id: "trigger-id",
                pubkey: "agent-pubkey",
                tags: [],
            };

            const afterTrigger = {
                id: "after-trigger",
                pubkey: "agent-pubkey",
                tags: [
                    ["tool", "delegate"],
                    ["phase", "phase2"],
                ],
            };

            const context = {
                getConversation: () => ({
                    history: [beforeTrigger, triggerEvent, afterTrigger],
                }),
                triggeringEvent: { id: "trigger-id" } as NDKEvent,
            } as unknown as ExecutionContext;

            const result = scanHistoricalPhases(agent, context);

            expect(result.has("phase1")).toBe(true);
            expect(result.has("phase2")).toBe(false);
        });

        it("should ignore events from other agents", () => {
            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
            } as AgentInstance;

            const otherAgentEvent = {
                id: "other-agent-event",
                pubkey: "other-agent-pubkey",
                tags: [
                    ["tool", "delegate"],
                    ["phase", "research"],
                ],
            };

            const context = {
                getConversation: () => ({
                    history: [otherAgentEvent],
                }),
                triggeringEvent: { id: "trigger-id" } as NDKEvent,
            } as unknown as ExecutionContext;

            const result = scanHistoricalPhases(agent, context);

            expect(result.has("research")).toBe(false);
        });
    });

    describe("buildValidationPrompt", () => {
        it("should build system and user prompts with correct structure", () => {
            const unusedPhases = ["research", "implement"];
            const conversationSnapshot = "User: Do task\nAgent: Working on it";
            const agentResponse = "I completed the task without delegating";

            const result = buildValidationPrompt(
                unusedPhases,
                conversationSnapshot,
                agentResponse
            );

            expect(result.system).toContain("<conversation-history>");
            expect(result.system).toContain(conversationSnapshot);
            expect(result.system).toContain("<your-response>");
            expect(result.system).toContain(agentResponse);
            expect(result.system).toContain("<phases not executed>");
            expect(result.system).toContain("research, implement");

            expect(result.user).toContain("I'M DONE:");
            expect(result.user).toContain("CONTINUE:");
        });
    });

    describe("validatePhaseSkipping", () => {
        it("should return empty string when no phases are skipped", async () => {
            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
                // No phases defined
            } as AgentInstance;

            const toolTracker = {
                getAllExecutions: () => new Map(),
            } as unknown as ToolExecutionTracker;

            const context = {
                getConversation: () => null,
                triggeringEvent: { id: "trigger-id" } as NDKEvent,
            } as unknown as ExecutionContext;

            const result = await validatePhaseSkipping(
                agent,
                context,
                toolTracker,
                "Some response",
                async () => "System prompt"
            );

            expect(result).toBe("");
        });

        it("should call LLM for validation when phases are skipped", async () => {
            const mockComplete = mock(async () => ({
                text: "I'M DONE: Task didn't require phases",
            }));

            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
                phases: {
                    research: { agent: "researcher" },
                },
                createLLMService: () => ({
                    complete: mockComplete,
                }),
            } as unknown as AgentInstance;

            const toolTracker = {
                getAllExecutions: () => new Map(),
            } as unknown as ToolExecutionTracker;

            const context = {
                getConversation: () => ({
                    history: [],
                }),
                triggeringEvent: { id: "trigger-id" } as NDKEvent,
                agent,
            } as unknown as ExecutionContext;

            const result = await validatePhaseSkipping(
                agent,
                context,
                toolTracker,
                "Some response",
                async () => "System prompt"
            );

            expect(mockComplete).toHaveBeenCalled();
            // "I'M DONE" means intentional skip, so return empty
            expect(result).toBe("");
        });

        it("should return response when LLM says CONTINUE", async () => {
            const continueResponse = "CONTINUE: I should execute the research phase";
            const mockComplete = mock(async () => ({
                text: continueResponse,
            }));

            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
                phases: {
                    research: { agent: "researcher" },
                },
                createLLMService: () => ({
                    complete: mockComplete,
                }),
            } as unknown as AgentInstance;

            const toolTracker = {
                getAllExecutions: () => new Map(),
            } as unknown as ToolExecutionTracker;

            const context = {
                getConversation: () => ({
                    history: [],
                }),
                triggeringEvent: { id: "trigger-id" } as NDKEvent,
                agent,
            } as unknown as ExecutionContext;

            const result = await validatePhaseSkipping(
                agent,
                context,
                toolTracker,
                "Some response",
                async () => "System prompt"
            );

            expect(result).toBe(continueResponse);
        });

        it("should return empty string on LLM error (assume intentional)", async () => {
            const mockComplete = mock(async () => {
                throw new Error("LLM service unavailable");
            });

            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
                phases: {
                    research: { agent: "researcher" },
                },
                createLLMService: () => ({
                    complete: mockComplete,
                }),
            } as unknown as AgentInstance;

            const toolTracker = {
                getAllExecutions: () => new Map(),
            } as unknown as ToolExecutionTracker;

            const context = {
                getConversation: () => ({
                    history: [],
                }),
                triggeringEvent: { id: "trigger-id" } as NDKEvent,
                agent,
            } as unknown as ExecutionContext;

            const result = await validatePhaseSkipping(
                agent,
                context,
                toolTracker,
                "Some response",
                async () => "System prompt"
            );

            // On error, assume phases were intentionally skipped
            expect(result).toBe("");
        });
    });
});
