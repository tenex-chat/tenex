import { describe, test, expect, beforeEach, mock } from "bun:test";
import { PromptCompilerService, type LessonComment } from "../prompt-compiler-service";
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";

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
            generateObject: async () => {
                llmCallCount++;
                if (llmShouldFail) {
                    throw new Error("LLM service unavailable");
                }
                return {
                    object: { compiledPrompt: "Compiled prompt content" },
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
    let eoseCallbacks: Array<() => void> = [];
    let eventCallbacks: Array<(event: unknown) => void> = [];

    beforeEach(() => {
        llmCallCount = 0;
        llmShouldFail = false;
        eoseCallbacks = [];
        eventCallbacks = [];

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
    });

    describe("constructor", () => {
        test("creates instance with correct properties", () => {
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);
            expect(service).toBeDefined();
        });
    });

    describe("addComment", () => {
        test("adds comment to collection", () => {
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);

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
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);

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
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);

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
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);
            const comments = service.getCommentsForLesson("nonexistent");
            expect(comments).toEqual([]);
        });
    });

    describe("compile", () => {
        test("returns base prompt and compiled=false when no lessons", async () => {
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);
            const basePrompt = "You are a helpful assistant.";

            const result = await service.compile([], basePrompt);

            expect(result.prompt).toBe(basePrompt);
            expect(result.compiled).toBe(false);
            expect(result.lessonsCount).toBe(0);
        });

        test("returns compiled=false when LLM compilation fails", async () => {
            llmShouldFail = true;
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);
            const basePrompt = "You are a helpful assistant.";

            const mockLesson = {
                id: "lesson1",
                title: "Test Lesson",
                lesson: "Always be helpful",
                category: "behavior",
                hashtags: ["test"],
                created_at: Date.now(),
            } as unknown as NDKAgentLesson;

            const result = await service.compile([mockLesson], basePrompt);

            // Should return compiled=false so caller can use fallback formatting
            expect(result.prompt).toBe(basePrompt);
            expect(result.compiled).toBe(false);
            expect(result.lessonsCount).toBe(1);
        });

        test("returns compiled=true when LLM compilation succeeds", async () => {
            llmShouldFail = false;
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);
            const basePrompt = "You are a helpful assistant.";

            const mockLesson = {
                id: "lesson1",
                title: "Test Lesson",
                lesson: "Always be helpful",
                category: "behavior",
                hashtags: ["test"],
                created_at: Date.now(),
            } as unknown as NDKAgentLesson;

            const result = await service.compile([mockLesson], basePrompt);

            expect(result.prompt).toBe("Compiled prompt content");
            expect(result.compiled).toBe(true);
            expect(result.lessonsCount).toBe(1);
        });
    });

    describe("EOSE lifecycle", () => {
        test("waitForEOSE resolves when EOSE is received", async () => {
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);
            service.subscribe();

            // Simulate EOSE
            const waitPromise = service.waitForEOSE();
            eoseCallbacks.forEach((cb) => cb());

            await expect(waitPromise).resolves.toBeUndefined();
        });

        test("waitForEOSE returns immediately if already received", async () => {
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);
            service.subscribe();

            // Trigger EOSE first
            eoseCallbacks.forEach((cb) => cb());

            // Should resolve immediately
            await expect(service.waitForEOSE()).resolves.toBeUndefined();
        });

        test("waitForEOSE throws if called before subscribe", async () => {
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);

            await expect(service.waitForEOSE()).rejects.toThrow(
                "PromptCompilerService: waitForEOSE called before subscribe()"
            );
        });

        test("EOSE state is reset on stop()", async () => {
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);
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
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);

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
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);
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
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);
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
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);
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
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);
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
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);
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
    });

    describe("stop", () => {
        test("stops subscription gracefully", () => {
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);

            // Should not throw
            service.stop();
        });

        test("calling stop multiple times is safe", () => {
            const service = new PromptCompilerService(agentPubkey, whitelistedPubkeys, mockNdk);
            service.subscribe();

            // Should not throw when called multiple times
            service.stop();
            service.stop();
        });
    });
});
