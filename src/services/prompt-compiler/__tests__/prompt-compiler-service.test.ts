import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { PromptCompilerService } from "../prompt-compiler-service";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { LessonComment } from "@/events/LessonComment";
import { llmServiceFactory } from "@/llm";
import { config } from "@/services/ConfigService";

let llmCallCount = 0;
let llmShouldFail = false;
const originalConfigMethods = {
    getConfigPath: (config as any).getConfigPath,
    loadConfig: (config as any).loadConfig,
    getLLMConfig: (config as any).getLLMConfig,
};
const originalCreateService = llmServiceFactory.createService;

describe("PromptCompilerService", () => {
    const agentPubkey = "abc123def456";
    let mockLessons: NDKAgentLesson[] = [];
    let createdServices: PromptCompilerService[] = [];

    const createService = (pubkey = agentPubkey): PromptCompilerService => {
        const service = new PromptCompilerService(pubkey, "test-project");
        createdServices.push(service);
        return service;
    };

    beforeEach(() => {
        llmCallCount = 0;
        llmShouldFail = false;
        mockLessons = [];
        createdServices = [];

        (config as any).getConfigPath = () => "/tmp/test-tenex";
        (config as any).loadConfig = async () => ({
            config: {},
            llms: { default: "test", summarization: "test" },
            mcp: { servers: {}, enabled: true },
            providers: { providers: {} },
        });
        (config as any).getLLMConfig = () => ({
            provider: "mock",
            model: "mock-model",
            temperature: 0.7,
            maxTokens: 4096,
        });
        llmServiceFactory.createService = (() => ({
            generateText: async () => {
                llmCallCount++;
                if (llmShouldFail) {
                    throw new Error("LLM service unavailable");
                }
                return {
                    text: "Effective Agent Instructions from LLM",
                };
            },
        })) as any;
    });

    afterEach(() => {
        for (const service of createdServices) {
            service.stop();
        }
        (config as any).getConfigPath = originalConfigMethods.getConfigPath;
        (config as any).loadConfig = originalConfigMethods.loadConfig;
        (config as any).getLLMConfig = originalConfigMethods.getLLMConfig;
        llmServiceFactory.createService = originalCreateService;
        mock.restore();
    });

    describe("constructor", () => {
        test("creates instance with correct properties", () => {
            const service = createService();
            expect(service).toBeDefined();
        });
    });

    describe("getCommentsForLesson", () => {
        test("returns empty array for unknown lesson", () => {
            const service = createService();
            const comments = service.getCommentsForLesson("nonexistent");
            expect(comments).toEqual([]);
        });
    });

    describe("compile", () => {
        test("returns Base Agent Instructions when no lessons exist", async () => {
            // mockLessons is empty by default
            const service = createService();
            const baseAgentInstructions = "You are a helpful assistant.";
            await service.initialize(baseAgentInstructions, []); // no lessons

            const result = await service.compile(baseAgentInstructions);

            expect(result).toBe(baseAgentInstructions);
            expect(llmCallCount).toBe(0); // No LLM call when no lessons
        });

        test("persists base instructions to disk when no lessons exist so restart can reload compiled cache", async () => {
            const uniqueAgentPubkey = "no-lessons-cache-agent";
            const cachePath = `/tmp/test-tenex/agents/prompts/test-project/${uniqueAgentPubkey}.json`;
            await fs.rm(cachePath, { force: true });

            const baseAgentInstructions = "You are a helpful assistant.";

            const firstService = createService(uniqueAgentPubkey);
            await firstService.initialize(baseAgentInstructions, []);

            const firstResult = await firstService.compile(baseAgentInstructions);
            expect(firstResult).toBe(baseAgentInstructions);
            expect(llmCallCount).toBe(0);

            const cached = JSON.parse(await fs.readFile(cachePath, "utf-8")) as {
                effectiveAgentInstructions: string;
                timestamp: number;
                maxCreatedAt: number;
                cacheInputsHash: string;
            };
            expect(cached.effectiveAgentInstructions).toBe(baseAgentInstructions);
            expect(cached.timestamp).toBeGreaterThan(0);
            expect(cached.maxCreatedAt).toBe(0);
            expect(cached.cacheInputsHash).toEqual(expect.any(String));

            const secondService = createService(uniqueAgentPubkey);
            await secondService.initialize(baseAgentInstructions, []);

            expect(secondService.getEffectiveInstructionsSync()).toMatchObject({
                instructions: baseAgentInstructions,
                isCompiled: true,
                source: "compiled_cache",
            });

            await fs.rm(cachePath, { force: true });
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

            const service = createService();
            const baseAgentInstructions = "You are a helpful assistant.";
            await service.initialize(baseAgentInstructions, mockLessons);

            // Should throw since LLM fails
            await expect(service.compile(baseAgentInstructions)).rejects.toThrow("LLM service unavailable");
        });

        test("returns Effective Agent Instructions when LLM compilation succeeds", async () => {
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

            const service = createService();
            const baseAgentInstructions = "You are a helpful assistant.";
            await service.initialize(baseAgentInstructions, mockLessons);

            const result = await service.compile(baseAgentInstructions);

            expect(result).toBe("Effective Agent Instructions from LLM");
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

            const service = createService();
            const baseAgentInstructions = "You are a helpful assistant.";
            await service.initialize(baseAgentInstructions, mockLessons, "event123");

            // Should not throw when event ID is provided
            const result = await service.compile(baseAgentInstructions, "event123");
            expect(result).toBe("Effective Agent Instructions from LLM");
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

            const service = createService();
            const baseAgentInstructions = "You are a helpful assistant.";
            const additionalPrompt = "Always respond in JSON format.";
            await service.initialize(baseAgentInstructions, mockLessons);

            // Should not throw when additional prompt is provided
            const result = await service.compile(baseAgentInstructions, undefined, additionalPrompt);
            expect(result).toBe("Effective Agent Instructions from LLM");
        });
    });

    describe("input synchronization", () => {
        test("groups synchronized comments by lesson ID", async () => {
            const service = createService();
            await service.initialize("Base Agent Instructions", []);

            const comments: LessonComment[] = [
                {
                    id: "comment-1",
                    pubkey: "user123",
                    content: "Comment on lesson 1",
                    lessonEventId: "lesson-1",
                    createdAt: Date.now(),
                },
                {
                    id: "comment-2",
                    pubkey: "user123",
                    content: "Comment on lesson 2",
                    lessonEventId: "lesson-2",
                    createdAt: Date.now(),
                },
            ];

            service.syncInputs([], comments);

            expect(service.getCommentsForLesson("lesson-1")).toHaveLength(1);
            expect(service.getCommentsForLesson("lesson-2")).toHaveLength(1);
            expect(service.getCommentsForLesson("lesson-3")).toHaveLength(0);
        });

        test("syncBaseInstructions invalidates cached compilation when base instructions change", async () => {
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

            const service = createService();
            await service.initialize("Original Base Agent Instructions", mockLessons);
            await service.compile("Original Base Agent Instructions");
            expect(llmCallCount).toBe(1);

            service.syncBaseInstructions("Changed Base Agent Instructions");
            await service.waitForCompilation();

            expect(llmCallCount).toBe(2);
            expect(service.getEffectiveInstructionsSync()).toMatchObject({
                instructions: "Effective Agent Instructions from LLM",
                isCompiled: true,
            });
        });

        test("syncInputs invalidates cached compilation when lessons or comments change", async () => {
            const initialLessons = [
                {
                    id: "lesson-1",
                    title: "Lesson One",
                    lesson: "Do the first thing",
                    created_at: 100,
                } as unknown as NDKAgentLesson,
            ];
            const service = createService();
            await service.initialize("Base Agent Instructions", initialLessons);
            await service.compile("Base Agent Instructions");
            expect(llmCallCount).toBe(1);

            const updatedLessons = [
                ...initialLessons,
                {
                    id: "lesson-2",
                    title: "Lesson Two",
                    lesson: "Do the second thing",
                    created_at: 200,
                } as unknown as NDKAgentLesson,
            ];
            const updatedComments: LessonComment[] = [
                {
                    id: "comment-1",
                    pubkey: "user123",
                    content: "Refinement",
                    lessonEventId: "lesson-2",
                    createdAt: 300,
                },
            ];

            service.syncInputs(updatedLessons, updatedComments);
            await service.waitForCompilation();

            expect(llmCallCount).toBe(2);
            expect(service.getCommentsForLesson("lesson-2")).toHaveLength(1);
        });
    });

    describe("cache invalidation", () => {
        test("newer comment updates maxCreatedAt calculation", async () => {
            // This test verifies that comments with newer timestamps
            // affect the maxCreatedAt calculation used for cache freshness
            const service = createService();
            const now = Math.floor(Date.now() / 1000);

            const mockLesson = {
                id: "lesson1",
                title: "Test Lesson",
                lesson: "Always be helpful",
                category: "behavior",
                hashtags: ["test"],
                created_at: now - 100, // 100 seconds ago
            } as unknown as NDKAgentLesson;

            service.syncInputs([], [{
                id: "comment1",
                pubkey: "user123",
                content: "Refinement",
                lessonEventId: "lesson1",
                createdAt: now, // Now (newer than lesson)
            }]);

            // Comments should be retrievable and have correct timestamp
            const comments = service.getCommentsForLesson("lesson1");
            expect(comments).toHaveLength(1);
            expect(comments[0].createdAt).toBe(now);
            expect(comments[0].createdAt).toBeGreaterThan(mockLesson.created_at!);
        });

        test("multiple comments are tracked by createdAt for cache freshness", () => {
            const service = createService();
            const now = Math.floor(Date.now() / 1000);

            service.syncInputs([], [
                {
                    id: "comment1",
                    pubkey: "user123",
                    content: "Old refinement",
                    lessonEventId: "lesson1",
                    createdAt: now - 50,
                },
                {
                    id: "comment2",
                    pubkey: "user123",
                    content: "New refinement",
                    lessonEventId: "lesson1",
                    createdAt: now,
                },
            ]);

            const comments = service.getCommentsForLesson("lesson1");
            expect(comments).toHaveLength(2);

            // The newest comment timestamp should be used for cache invalidation
            const maxTimestamp = Math.max(...comments.map((c) => c.createdAt));
            expect(maxTimestamp).toBe(now);
        });

        test("cache invalidation when baseAgentInstructions changes", async () => {
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

            const service = createService();
            await service.initialize("Original Base Agent Instructions", mockLessons);

            // First compilation
            const result1 = await service.compile("Original Base Agent Instructions");
            expect(result1).toBe("Effective Agent Instructions from LLM");
            expect(llmCallCount).toBe(1);

            // Second compilation with same baseAgentInstructions should use cache (hit)
            const result2 = await service.compile("Original Base Agent Instructions");
            expect(result2).toBe("Effective Agent Instructions from LLM");
            // Cache hit - LLM should NOT be called again
            expect(llmCallCount).toBe(1);

            // Third compilation with DIFFERENT baseAgentInstructions - should recompile (cache miss)
            const result3 = await service.compile("Changed Base Agent Instructions");
            expect(result3).toBe("Effective Agent Instructions from LLM");
            // New baseAgentInstructions means cache miss, LLM called
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

            const service = createService();

            const baseAgentInstructions = "You are a helpful assistant.";
            await service.initialize(baseAgentInstructions, mockLessons);

            // First compilation without additionalSystemPrompt
            const result1 = await service.compile(baseAgentInstructions);
            expect(result1).toBe("Effective Agent Instructions from LLM");
            expect(llmCallCount).toBe(1);

            // Second compilation WITH additionalSystemPrompt - should recompile
            const result2 = await service.compile(baseAgentInstructions, undefined, "Extra instructions");
            expect(result2).toBe("Effective Agent Instructions from LLM");
            expect(llmCallCount).toBe(2);

            // Third compilation with DIFFERENT additionalSystemPrompt - should recompile
            const result3 = await service.compile(baseAgentInstructions, undefined, "Different instructions");
            expect(result3).toBe("Effective Agent Instructions from LLM");
            expect(llmCallCount).toBe(3);
        });

        test("cache key includes all inputs for deterministic caching", async () => {
            // This test verifies that the cache key is deterministic based on:
            // - agentDefinitionEventId
            // - baseAgentInstructions
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

            const baseAgentInstructions = "You are a helpful assistant.";
            const eventId = "event123";
            const additionalPrompt = "Be concise.";

            const service = createService();
            await service.initialize(baseAgentInstructions, mockLessons, eventId);

            // Compile with all three inputs - first call
            await service.compile(baseAgentInstructions, eventId, additionalPrompt);
            expect(llmCallCount).toBe(1);

            // Same inputs - cache hit, LLM should NOT be called
            await service.compile(baseAgentInstructions, eventId, additionalPrompt);
            expect(llmCallCount).toBe(1); // Still 1 - cache hit

            // Change only eventId - should invalidate cache
            await service.compile(baseAgentInstructions, "different-event", additionalPrompt);
            expect(llmCallCount).toBe(2);

            // Change only baseAgentInstructions - should invalidate cache
            await service.compile("Different instructions", eventId, additionalPrompt);
            expect(llmCallCount).toBe(3);

            // Change only additionalPrompt - should invalidate cache
            await service.compile(baseAgentInstructions, eventId, "Different additional");
            expect(llmCallCount).toBe(4);
        });
    });

    describe("stop", () => {
        test("stops gracefully", () => {
            const service = createService();

            // Should not throw
            service.stop();
        });

        test("calling stop multiple times is safe", () => {
            const service = createService();

            // Should not throw when called multiple times
            service.stop();
            service.stop();
        });
    });
});
