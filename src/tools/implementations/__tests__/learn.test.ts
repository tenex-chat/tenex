import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKSigner } from "@nostr-dev-kit/ndk";
import type { ToolContext } from "../../types";
import { lessonLearnTool } from "../learn";

// Mock dependencies
mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(),
        warn: mock(),
        error: mock(),
    },
}));

mock.module("@/nostr", () => ({
    getNDK: mock(),
}));

mock.module("@/services/ProjectContext", () => ({
    getProjectContext: mock(),
}));

mock.module("@/events/NDKAgentLesson", () => {
    const mockPublish = mock();
    const mockSign = mock();
    const mockTag = mock();

    return {
        NDKAgentLesson: mock((_ndk: NDK) => ({
            title: undefined,
            lesson: undefined,
            agent: undefined,
            tags: [],
            id: "mock-lesson-id",
            tag: mockTag,
            sign: mockSign,
            publish: mockPublish,
        })),
    };
});

import { getNDK } from "@/nostr";
import { getProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";

type MockLesson = {
    title: string | undefined;
    lesson: string | undefined;
    agent: string | undefined;
    tags: string[][];
    id: string;
    tag: ReturnType<typeof mock>;
    sign: ReturnType<typeof mock>;
    publish: ReturnType<typeof mock>;
};

describe("Learn Tool", () => {
    let mockContext: ToolContext;
    let mockAgent: AgentInstance;
    let mockConversation: ConversationStore;
    let mockNDK: NDK;
    let mockLesson: MockLesson;

    beforeEach(() => {
        // Reset all mocks
        (logger.info as ReturnType<typeof mock>).mockReset();
        (logger.warn as ReturnType<typeof mock>).mockReset();
        (logger.error as ReturnType<typeof mock>).mockReset();
        (getNDK as ReturnType<typeof mock>).mockReset();
        (getProjectContext as ReturnType<typeof mock>).mockReset();

        // Setup mock agent
        mockAgent = {
            name: "dev-senior",
            pubkey: "mock-agent-pubkey",
            eventId: "mock-agent-event-id",
            signer: {
                pubkey: () => "mock-signer-pubkey",
                sign: mock(),
            } as unknown as NDKSigner,
        } as Agent;

        // Setup mock conversation
        mockConversation = {
            id: "mock-conversation-id",
        } as unknown as ConversationStore;

        // Setup mock context
        mockContext = {
            agent: mockAgent,
            phase: "reflection",
            conversationId: "mock-conversation-id",
            conversation: mockConversation,
        } as ToolContext;

        // Setup NDK mock
        mockNDK = {
            fetchEvent: mock().mockResolvedValue({
                id: "mock-agent-event-id",
                pubkey: "mock-agent-pubkey",
            }),
        } as unknown as NDK;

        (getNDK as ReturnType<typeof mock>).mockReturnValue(mockNDK);

        // Setup project context mock
        (getProjectContext as ReturnType<typeof mock>).mockReturnValue({
            project: { id: "mock-project-id" },
        });

        // Setup NDKAgentLesson mock
        mockLesson = {
            title: undefined,
            lesson: undefined,
            agent: undefined,
            tags: [],
            id: "mock-lesson-id",
            tag: mock(),
            sign: mock().mockResolvedValue(undefined),
            publish: mock().mockResolvedValue(undefined),
            encode: mock().mockReturnValue("mock-encoded-event"),
        };

        (NDKAgentLesson as any).mockImplementation(() => mockLesson);
    });

    describe("Parameter Validation", () => {
        it("should validate required fields", () => {
            const validation = lessonLearnTool.parameters.validate({});
            expect(validation.ok).toBe(false);
            if (!validation.ok) {
                expect(validation.error.kind).toBe("validation");
            }
        });

        it("should require title field", () => {
            const validation = lessonLearnTool.parameters.validate({
                lesson: "Test lesson content",
            });
            expect(validation.ok).toBe(false);
            if (!validation.ok) {
                expect(validation.error.kind).toBe("validation");
                expect(validation.error.field).toBe("title");
                expect(validation.error.message).toContain("Required");
            }
        });

        it("should require lesson field", () => {
            const validation = lessonLearnTool.parameters.validate({
                title: "Test Title",
            });
            expect(validation.ok).toBe(false);
            if (!validation.ok) {
                expect(validation.error.kind).toBe("validation");
                expect(validation.error.field).toBe("lesson");
                expect(validation.error.message).toContain("Required");
            }
        });

        it("should accept valid parameters", async () => {
            const params = {
                title: "Async TypeScript Best Practices",
                lesson: "Always use async/await instead of callbacks for better error handling",
            };

            const validation = lessonLearnTool.parameters.validate(params);
            expect(validation.ok).toBe(true);

            if (validation.ok) {
                const result = await lessonLearnTool.execute(validation.value, mockContext);
                expect(result.ok).toBe(true);
                if (result.ok) {
                    expect(result.value).toMatchObject({
                        message: expect.stringContaining("Lesson recorded"),
                        eventId: expect.any(String),
                        title: params.title,
                    });
                }
            }
        });
    });

    describe("Execution Logic", () => {
        it("should handle missing agent signer", async () => {
            const params = {
                title: "Test",
                lesson: "Test lesson",
            };

            const validation = lessonLearnTool.parameters.validate(params);
            expect(validation.ok).toBe(true);

            if (validation.ok) {
                mockContext.agent.signer = undefined as any;
                const result = await lessonLearnTool.execute(validation.value, mockContext);

                expect(result.ok).toBe(false);
                if (!result.ok) {
                    expect(result.error.kind).toBe("execution");
                    expect(result.error.message).toContain("Agent signer not available");
                }
                expect(logger.error).toHaveBeenCalled();
            }
        });

        it("should handle missing NDK instance", async () => {
            const params = {
                title: "Test",
                lesson: "Test lesson",
            };

            const validation = lessonLearnTool.parameters.validate(params);
            expect(validation.ok).toBe(true);

            if (validation.ok) {
                (getNDK as any).mockReturnValue(null);
                const result = await lessonLearnTool.execute(validation.value, mockContext);

                expect(result.ok).toBe(false);
                if (!result.ok) {
                    expect(result.error.kind).toBe("execution");
                    expect(result.error.message).toContain("NDK instance not available");
                }
                expect(logger.error).toHaveBeenCalled();
            }
        });

        it("should handle event publishing failures", async () => {
            const params = {
                title: "Test",
                lesson: "Test lesson",
            };

            const validation = lessonLearnTool.parameters.validate(params);
            expect(validation.ok).toBe(true);

            if (validation.ok) {
                mockLesson.publish.mockRejectedValue(new Error("Network error"));
                const result = await lessonLearnTool.execute(validation.value, mockContext);

                expect(result.ok).toBe(false);
                if (!result.ok) {
                    expect(result.error.kind).toBe("execution");
                    expect(result.error.message).toContain("Network error");
                }
                expect(logger.error).toHaveBeenCalled();
            }
        });

        it("should successfully create and publish lesson", async () => {
            const params = {
                title: "Performance Optimization",
                lesson: "Use React.memo for expensive component renders",
            };

            const validation = lessonLearnTool.parameters.validate(params);
            expect(validation.ok).toBe(true);

            if (validation.ok) {
                const result = await lessonLearnTool.execute(validation.value, mockContext);

                expect(result.ok).toBe(true);
                if (result.ok) {
                    expect(result.value.message).toContain("Lesson recorded");
                    expect(result.value.title).toBe(params.title);
                    expect(mockLesson.sign).toHaveBeenCalledWith(mockAgent.signer);
                    expect(mockLesson.publish).toHaveBeenCalled();
                }
            }
        });
    });

    describe("Event Creation", () => {
        it("should create lesson event with correct structure", async () => {
            const params = {
                title: "Test Title",
                lesson: "Test lesson content",
            };

            const validation = lessonLearnTool.parameters.validate(params);
            if (validation.ok) {
                await lessonLearnTool.execute(validation.value, mockContext);

                expect(NDKAgentLesson).toHaveBeenCalledWith(mockNDK);
                expect(mockLesson.title).toBe(params.title);
                expect(mockLesson.lesson).toBe(params.lesson);
            }
        });

        it("should add project tag", async () => {
            const params = {
                title: "Test",
                lesson: "Test lesson",
            };

            const validation = lessonLearnTool.parameters.validate(params);
            if (validation.ok) {
                await lessonLearnTool.execute(validation.value, mockContext);

                expect(mockLesson.tag).toHaveBeenCalledWith({ id: "mock-project-id" });
            }
        });

        it("should add agent reference when eventId is available", async () => {
            const params = {
                title: "Test",
                lesson: "Test lesson",
            };

            const validation = lessonLearnTool.parameters.validate(params);
            if (validation.ok) {
                await lessonLearnTool.execute(validation.value, mockContext);

                expect(mockNDK.fetchEvent).toHaveBeenCalledWith("mock-agent-event-id");
                expect(mockLesson.agent).toEqual({
                    id: "mock-agent-event-id",
                    pubkey: "mock-agent-pubkey",
                });
            }
        });

        it("should handle missing agent eventId", async () => {
            const params = {
                title: "Test",
                lesson: "Test lesson",
            };

            mockContext.agent.eventId = undefined;

            const validation = lessonLearnTool.parameters.validate(params);
            if (validation.ok) {
                await lessonLearnTool.execute(validation.value, mockContext);

                expect(mockNDK.fetchEvent).not.toHaveBeenCalled();
                expect(mockLesson.agent).toBeUndefined();
            }
        });

        it("should warn when agent event cannot be fetched", async () => {
            const params = {
                title: "Test",
                lesson: "Test lesson",
            };

            mockNDK.fetchEvent.mockResolvedValue(null);

            const validation = lessonLearnTool.parameters.validate(params);
            if (validation.ok) {
                await lessonLearnTool.execute(validation.value, mockContext);

                expect(logger.warn).toHaveBeenCalledWith("Could not fetch agent event for lesson", {
                    agentEventId: "mock-agent-event-id",
                });
            }
        });
    });

    describe("Logging", () => {
        it("should log lesson creation with correct details", async () => {
            const params = {
                title: "Architecture Decision",
                lesson: "Use event sourcing for audit trail requirements",
            };

            const validation = lessonLearnTool.parameters.validate(params);
            if (validation.ok) {
                await lessonLearnTool.execute(validation.value, mockContext);

                expect(logger.info).toHaveBeenCalledWith(
                    "🎓 Agent recording new lesson",
                    expect.objectContaining({
                        agent: "dev-senior",
                        agentPubkey: "mock-agent-pubkey",
                        title: params.title,
                        lessonLength: params.lesson.length,
                        phase: "reflection",
                        conversationId: "mock-conversation-id",
                    })
                );
            }
        });

        it("should log errors with full context", async () => {
            const params = {
                title: "Test",
                lesson: "Test lesson",
            };

            const validation = lessonLearnTool.parameters.validate(params);
            if (validation.ok) {
                const testError = new Error("Test error");
                mockLesson.publish.mockRejectedValue(testError);

                await lessonLearnTool.execute(validation.value, mockContext);

                expect(logger.error).toHaveBeenCalledWith(
                    "❌ Learn tool failed",
                    expect.objectContaining({
                        error: "Test error",
                        agent: "dev-senior",
                        agentPubkey: "mock-agent-pubkey",
                        title: params.title,
                        phase: "reflection",
                        conversationId: "mock-conversation-id",
                    })
                );
            }
        });
    });
});
