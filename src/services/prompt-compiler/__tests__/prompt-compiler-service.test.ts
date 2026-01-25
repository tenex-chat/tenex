import { describe, test, expect, beforeEach, mock } from "bun:test";
import { PromptCompilerService, type LessonComment } from "../prompt-compiler-service";
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { ProjectContext } from "@/services/projects/ProjectContext";

// Mock dependencies
mock.module("@/services/ConfigService", () => ({
    config: {
        getConfigPath: () => "/tmp/test-tenex",
        loadConfig: async () => ({ llms: { default: "test", summarization: "test" } }),
        getLLMConfig: () => ({
            provider: "mock",
            model: "mock-model",
            temperature: 0.7,
            maxTokens: 4096,
        }),
    },
}));

// Track LLM calls for testing
let llmCallCount = 0;
let llmShouldFail = false;

mock.module("@/llm", () => ({
    llmServiceFactory: {
        createService: () => ({
            generateText: async () => {
                llmCallCount++;
                if (llmShouldFail) {
                    throw new Error("LLM service unavailable");
                }
                return {
                    text: "Compiled prompt content",
                };
            },
        }),
    },
}));

mock.module("@/utils/logger", () => ({
    logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
    },
}));

describe("PromptCompilerService", () => {
    const agentPubkey = "abc123def456";
    const whitelistedPubkeys = ["user123", "user456"];
    let mockNdk: NDK;
    let mockProjectContext: ProjectContext;
    let eoseCallbacks: Array<() => void> = [];
    let eventCallbacks: Array<(event: unknown) => void> = [];
    let mockLessons: NDKAgentLesson[] = [];

    beforeEach(() => {
        llmCallCount = 0;
        llmShouldFail = false;
        eoseCallbacks = [];
        eventCallbacks = [];
        mockLessons = [];

        mockNdk = {
            subscribe: () => ({
                on: (event: string, callback: () => void) => {
                    if (event === "eose") {
                        eoseCallbacks.push(callback);
                    } else if (event === "event") {
                        eventCallbacks.push(callback as (event: unknown) => void);
                    }
                },
                stop: () => {},
            }),
        } as unknown as NDK;

        // Mock ProjectContext that returns lessons for the agent
        mockProjectContext = {
            getLessonsForAgent: (pubkey: string) => {
                if (pubkey === agentPubkey) {
                    return mockLessons;
                }
                return [];
            },
        } as unknown as ProjectContext;
    });

    describe("constructor", () => {
        test("creates instance with correct properties", () => {
            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );
            expect(service).toBeDefined();
        });
    });

    describe("addComment", () => {
        test("adds comment to collection", () => {
            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );

            const comment: LessonComment = {
                id: "comment1",
                pubkey: "user123",
                content: "This is a refinement",
                lessonEventId: "lesson1",
                createdAt: Date.now(),
            };

            service.addComment(comment);

            const comments = service.getCommentsForLesson("lesson1");
            expect(comments).toHaveLength(1);
            expect(comments[0].content).toBe("This is a refinement");
        });

        test("prevents duplicate comments", () => {
            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );

            const comment: LessonComment = {
                id: "comment1",
                pubkey: "user123",
                content: "This is a refinement",
                lessonEventId: "lesson1",
                createdAt: Date.now(),
            };

            service.addComment(comment);
            service.addComment(comment); // duplicate

            const comments = service.getCommentsForLesson("lesson1");
            expect(comments).toHaveLength(1);
        });

        test("groups comments by lesson event ID", () => {
            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );

            const comment1: LessonComment = {
                id: "c1",
                pubkey: "user123",
                content: "Comment on lesson 1",
                lessonEventId: "lesson1",
                createdAt: Date.now(),
            };

            const comment2: LessonComment = {
                id: "c2",
                pubkey: "user123",
                content: "Comment on lesson 2",
                lessonEventId: "lesson2",
                createdAt: Date.now(),
            };

            service.addComment(comment1);
            service.addComment(comment2);

            expect(service.getCommentsForLesson("lesson1")).toHaveLength(1);
            expect(service.getCommentsForLesson("lesson2")).toHaveLength(1);
            expect(service.getCommentsForLesson("lesson3")).toHaveLength(0);
        });
    });

    describe("getCommentsForLesson", () => {
        test("returns empty array for unknown lesson", () => {
            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );
            const comments = service.getCommentsForLesson("nonexistent");
            expect(comments).toEqual([]);
        });
    });

    describe("compile", () => {
        test("returns base prompt when no lessons exist", async () => {
            // mockLessons is empty by default
            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );
            const basePrompt = "You are a helpful assistant.";

            const result = await service.compile(basePrompt);

            expect(result).toBe(basePrompt);
            expect(llmCallCount).toBe(0); // No LLM call when no lessons
        });

        test("throws error when LLM compilation fails", async () => {
            llmShouldFail = true;

            // Add a lesson so compilation is attempted
            mockLessons = [
                {
                    id: "lesson1",
                    title: "Test Lesson",
                    lesson: "Always be helpful",
                    category: "behavior",
                    hashtags: ["test"],
                    created_at: Date.now(),
                } as unknown as NDKAgentLesson,
            ];

            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );
            const basePrompt = "You are a helpful assistant.";

            // Should throw since LLM fails
            await expect(service.compile(basePrompt)).rejects.toThrow("LLM service unavailable");
        });

        test("returns compiled prompt when LLM compilation succeeds", async () => {
            llmShouldFail = false;

            // Add a lesson so compilation is attempted
            mockLessons = [
                {
                    id: "lesson1",
                    title: "Test Lesson",
                    lesson: "Always be helpful",
                    category: "behavior",
                    hashtags: ["test"],
                    created_at: Date.now(),
                } as unknown as NDKAgentLesson,
            ];

            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );
            const basePrompt = "You are a helpful assistant.";

            const result = await service.compile(basePrompt);

            expect(result).toBe("Compiled prompt content");
            expect(llmCallCount).toBe(1);
        });

        test("accepts optional agentDefinitionEventId for cache hash", async () => {
            mockLessons = [
                {
                    id: "lesson1",
                    title: "Test Lesson",
                    lesson: "Always be helpful",
                    category: "behavior",
                    hashtags: ["test"],
                    created_at: Date.now(),
                } as unknown as NDKAgentLesson,
            ];

            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );
            const basePrompt = "You are a helpful assistant.";

            // Should not throw when event ID is provided
            const result = await service.compile(basePrompt, "event123");
            expect(result).toBe("Compiled prompt content");
        });

        test("accepts optional additionalSystemPrompt", async () => {
            mockLessons = [
                {
                    id: "lesson1",
                    title: "Test Lesson",
                    lesson: "Always be helpful",
                    category: "behavior",
                    hashtags: ["test"],
                    created_at: Date.now(),
                } as unknown as NDKAgentLesson,
            ];

            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );
            const basePrompt = "You are a helpful assistant.";
            const additionalPrompt = "Always respond in JSON format.";

            // Should not throw when additional prompt is provided
            const result = await service.compile(basePrompt, undefined, additionalPrompt);
            expect(result).toBe("Compiled prompt content");
        });
    });

    describe("EOSE lifecycle", () => {
        test("waitForEOSE resolves when EOSE is received", async () => {
            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );
            service.subscribe();

            // Simulate EOSE
            const waitPromise = service.waitForEOSE();
            eoseCallbacks.forEach((cb) => cb());

            await expect(waitPromise).resolves.toBeUndefined();
        });

        test("waitForEOSE returns immediately if already received", async () => {
            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );
            service.subscribe();

            // Trigger EOSE first
            eoseCallbacks.forEach((cb) => cb());

            // Should resolve immediately
            await expect(service.waitForEOSE()).resolves.toBeUndefined();
        });

        test("waitForEOSE throws if called before subscribe", async () => {
            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );

            await expect(service.waitForEOSE()).rejects.toThrow(
                "PromptCompilerService: waitForEOSE called before subscribe()"
            );
        });

        test("EOSE state is reset on stop()", async () => {
            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );
            service.subscribe();

            // Trigger EOSE
            eoseCallbacks.forEach((cb) => cb());
            await service.waitForEOSE();

            // Stop clears EOSE state
            service.stop();

            // Should throw because subscription is stopped
            await expect(service.waitForEOSE()).rejects.toThrow(
                "PromptCompilerService: waitForEOSE called before subscribe()"
            );
        });

        test("EOSE state is reset on subscribe() for fresh lifecycle", () => {
            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );

            // First subscription cycle
            service.subscribe();
            eoseCallbacks.forEach((cb) => cb());

            // Stop and clear callbacks
            service.stop();
            eoseCallbacks = [];

            // Second subscription should have fresh EOSE state
            service.subscribe();

            // New EOSE callback should be registered
            expect(eoseCallbacks.length).toBe(1);
        });
    });

    describe("comment routing", () => {
        test("routes comment event to addComment via handleCommentEvent", () => {
            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );
            service.subscribe();

            // Simulate a valid comment event
            const mockEvent = {
                id: "event123",
                pubkey: "user123", // whitelisted
                content: "This is a comment",
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ["e", "lesson456", "", "root"],
                    ["K", "4129"],
                    ["p", agentPubkey],
                ],
                tagValue: (name: string) => {
                    const tag = mockEvent.tags.find((t) => t[0] === name);
                    return tag?.[1];
                },
            };

            // Trigger the event callback
            eventCallbacks.forEach((cb) => cb(mockEvent));

            // Comment should be added
            const comments = service.getCommentsForLesson("lesson456");
            expect(comments).toHaveLength(1);
            expect(comments[0].content).toBe("This is a comment");
        });

        test("ignores comment from non-whitelisted author", () => {
            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );
            service.subscribe();

            const mockEvent = {
                id: "event123",
                pubkey: "unauthorized_user", // NOT whitelisted
                content: "This is a comment",
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ["e", "lesson456", "", "root"],
                    ["K", "4129"],
                    ["p", agentPubkey],
                ],
                tagValue: (name: string) => {
                    const tag = mockEvent.tags.find((t) => t[0] === name);
                    return tag?.[1];
                },
            };

            eventCallbacks.forEach((cb) => cb(mockEvent));

            // Comment should NOT be added
            const comments = service.getCommentsForLesson("lesson456");
            expect(comments).toHaveLength(0);
        });

        test("ignores comment without lesson reference", () => {
            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );
            service.subscribe();

            const mockEvent = {
                id: "event123",
                pubkey: "user123",
                content: "This is a comment",
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    // No 'e' tag referencing a lesson
                    ["K", "4129"],
                    ["p", agentPubkey],
                ],
                tagValue: (name: string) => {
                    const tag = mockEvent.tags.find((t) => t[0] === name);
                    return tag?.[1];
                },
            };

            eventCallbacks.forEach((cb) => cb(mockEvent));

            // No comments should be added
            expect(service.getCommentsForLesson("lesson456")).toHaveLength(0);
        });
    });

    describe("cache invalidation", () => {
        test("newer comment updates maxCreatedAt calculation", async () => {
            // This test verifies that comments with newer timestamps
            // affect the maxCreatedAt calculation used for cache freshness
            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );
            const now = Math.floor(Date.now() / 1000);

            const mockLesson = {
                id: "lesson1",
                title: "Test Lesson",
                lesson: "Always be helpful",
                category: "behavior",
                hashtags: ["test"],
                created_at: now - 100, // 100 seconds ago
            } as unknown as NDKAgentLesson;

            // Add a comment that is newer than the lesson
            service.addComment({
                id: "comment1",
                pubkey: "user123",
                content: "Refinement",
                lessonEventId: "lesson1",
                createdAt: now, // Now (newer than lesson)
            });

            // Comments should be retrievable and have correct timestamp
            const comments = service.getCommentsForLesson("lesson1");
            expect(comments).toHaveLength(1);
            expect(comments[0].createdAt).toBe(now);
            expect(comments[0].createdAt).toBeGreaterThan(mockLesson.created_at!);
        });

        test("multiple comments are tracked by createdAt for cache freshness", () => {
            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );
            const now = Math.floor(Date.now() / 1000);

            // Add older comment
            service.addComment({
                id: "comment1",
                pubkey: "user123",
                content: "Old refinement",
                lessonEventId: "lesson1",
                createdAt: now - 50,
            });

            // Add newer comment
            service.addComment({
                id: "comment2",
                pubkey: "user123",
                content: "New refinement",
                lessonEventId: "lesson1",
                createdAt: now,
            });

            const comments = service.getCommentsForLesson("lesson1");
            expect(comments).toHaveLength(2);

            // The newest comment timestamp should be used for cache invalidation
            const maxTimestamp = Math.max(...comments.map((c) => c.createdAt));
            expect(maxTimestamp).toBe(now);
        });

        test("cache invalidation when basePrompt changes", async () => {
            // Set up a lesson so compilation is attempted
            mockLessons = [
                {
                    id: "lesson1",
                    title: "Test Lesson",
                    lesson: "Always be helpful",
                    category: "behavior",
                    hashtags: ["test"],
                    created_at: Math.floor(Date.now() / 1000),
                } as unknown as NDKAgentLesson,
            ];

            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );

            // First compilation
            const result1 = await service.compile("Original base prompt");
            expect(result1).toBe("Compiled prompt content");
            expect(llmCallCount).toBe(1);

            // Second compilation with same basePrompt should use cache (hit)
            const result2 = await service.compile("Original base prompt");
            expect(result2).toBe("Compiled prompt content");
            // Cache hit - LLM should NOT be called again
            expect(llmCallCount).toBe(1);

            // Third compilation with DIFFERENT basePrompt - should recompile (cache miss)
            const result3 = await service.compile("Changed base prompt");
            expect(result3).toBe("Compiled prompt content");
            // New basePrompt means cache miss, LLM called
            expect(llmCallCount).toBe(2);
        });

        test("cache invalidation when additionalSystemPrompt changes", async () => {
            // Set up a lesson so compilation is attempted
            mockLessons = [
                {
                    id: "lesson1",
                    title: "Test Lesson",
                    lesson: "Always be helpful",
                    category: "behavior",
                    hashtags: ["test"],
                    created_at: Math.floor(Date.now() / 1000),
                } as unknown as NDKAgentLesson,
            ];

            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );

            const basePrompt = "You are a helpful assistant.";

            // First compilation without additionalSystemPrompt
            const result1 = await service.compile(basePrompt);
            expect(result1).toBe("Compiled prompt content");
            expect(llmCallCount).toBe(1);

            // Second compilation WITH additionalSystemPrompt - should recompile
            const result2 = await service.compile(basePrompt, undefined, "Extra instructions");
            expect(result2).toBe("Compiled prompt content");
            expect(llmCallCount).toBe(2);

            // Third compilation with DIFFERENT additionalSystemPrompt - should recompile
            const result3 = await service.compile(basePrompt, undefined, "Different instructions");
            expect(result3).toBe("Compiled prompt content");
            expect(llmCallCount).toBe(3);
        });

        test("cache key includes all inputs for deterministic caching", async () => {
            // This test verifies that the cache key is deterministic based on:
            // - agentDefinitionEventId
            // - basePrompt
            // - additionalSystemPrompt

            mockLessons = [
                {
                    id: "lesson1",
                    title: "Test Lesson",
                    lesson: "Always be helpful",
                    category: "behavior",
                    hashtags: ["test"],
                    created_at: Math.floor(Date.now() / 1000),
                } as unknown as NDKAgentLesson,
            ];

            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );

            const basePrompt = "You are a helpful assistant.";
            const eventId = "event123";
            const additionalPrompt = "Be concise.";

            // Compile with all three inputs - first call
            await service.compile(basePrompt, eventId, additionalPrompt);
            expect(llmCallCount).toBe(1);

            // Same inputs - cache hit, LLM should NOT be called
            await service.compile(basePrompt, eventId, additionalPrompt);
            expect(llmCallCount).toBe(1); // Still 1 - cache hit

            // Change only eventId - should invalidate cache
            await service.compile(basePrompt, "different-event", additionalPrompt);
            expect(llmCallCount).toBe(2);

            // Change only basePrompt - should invalidate cache
            await service.compile("Different prompt", eventId, additionalPrompt);
            expect(llmCallCount).toBe(3);

            // Change only additionalPrompt - should invalidate cache
            await service.compile(basePrompt, eventId, "Different additional");
            expect(llmCallCount).toBe(4);
        });
    });

    describe("stop", () => {
        test("stops subscription gracefully", () => {
            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );

            // Should not throw
            service.stop();
        });

        test("calling stop multiple times is safe", () => {
            const service = new PromptCompilerService(
                agentPubkey,
                whitelistedPubkeys,
                mockNdk,
                mockProjectContext
            );
            service.subscribe();

            // Should not throw when called multiple times
            service.stop();
            service.stop();
        });
    });
});
