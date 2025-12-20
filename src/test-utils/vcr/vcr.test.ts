import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rm, readFile } from "fs/promises";
import { join } from "path";
import type { LanguageModelV2, LanguageModelV2CallOptions } from "@ai-sdk/provider";
import { createVCR } from "./vcr";
import { hashRequest, explainHash } from "./hash";
import { loadCassette } from "./cassette";

const TEST_CASSETTE_DIR = join(
    import.meta.dir,
    "__test-cassettes__"
);

// Mock language model for testing
function createMockModel(): LanguageModelV2 {
    let callCount = 0;

    return {
        specificationVersion: "v2" as const,
        provider: "test-provider",
        modelId: "test-model",
        supportedUrls: {},

        async doGenerate(options: LanguageModelV2CallOptions) {
            callCount++;

            // Extract text from the last message
            const lastMessage = options.prompt[options.prompt.length - 1];
            let userText = "";
            if (lastMessage && Array.isArray(lastMessage.content)) {
                const textPart = lastMessage.content.find(
                    (part) => part.type === "text"
                );
                if (textPart && "text" in textPart) {
                    userText = textPart.text;
                }
            }

            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Mock response ${callCount} to: ${userText}`,
                    },
                ],
                finishReason: "stop" as const,
                usage: {
                    inputTokens: 10,
                    outputTokens: 20,
                    totalTokens: 30,
                },
                warnings: [],
            };
        },

        async doStream() {
            throw new Error("Streaming not implemented in mock");
        },
    };
}

describe("VCR", () => {
    const cassettePath = join(TEST_CASSETTE_DIR, "test.json");

    beforeEach(async () => {
        // Clean up test cassettes
        await rm(TEST_CASSETTE_DIR, { recursive: true, force: true });
    });

    afterEach(async () => {
        await rm(TEST_CASSETTE_DIR, { recursive: true, force: true });
    });

    describe("record mode", () => {
        test("records interactions to cassette", async () => {
            const vcr = createVCR({
                cassettePath,
                mode: "record",
            });

            await vcr.initialize();

            const mockModel = createMockModel();
            const wrappedModel = vcr.wrap(mockModel);

            const request: LanguageModelV2CallOptions = {
                prompt: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "Hello, world!" }],
                    },
                ],
            };

            const result = await wrappedModel.doGenerate(request);

            expect(result.content).toHaveLength(1);
            expect(result.content[0]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Mock response"),
            });

            // Save and verify cassette
            await vcr.save();

            const cassette = await loadCassette(cassettePath, "test");
            expect(cassette.interactions).toHaveLength(1);
            expect(cassette.interactions[0].hash).toBe(hashRequest(request));
        });

        test("auto-saves when configured", async () => {
            const vcr = createVCR({
                cassettePath,
                mode: "record",
                autoSave: true,
            });

            await vcr.initialize();

            const mockModel = createMockModel();
            const wrappedModel = vcr.wrap(mockModel);

            await wrappedModel.doGenerate({
                prompt: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "Test message" }],
                    },
                ],
            });

            // Should be saved automatically
            const cassette = await loadCassette(cassettePath, "test");
            expect(cassette.interactions).toHaveLength(1);
        });

        test("saves cassette on dispose", async () => {
            const vcr = createVCR({
                cassettePath,
                mode: "record",
            });

            await vcr.initialize();

            const mockModel = createMockModel();
            const wrappedModel = vcr.wrap(mockModel);

            await wrappedModel.doGenerate({
                prompt: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "Test" }],
                    },
                ],
            });

            await vcr.dispose();

            const cassette = await loadCassette(cassettePath, "test");
            expect(cassette.interactions).toHaveLength(1);
        });

        test("replaces duplicate interactions", async () => {
            const vcr = createVCR({
                cassettePath,
                mode: "record",
            });

            await vcr.initialize();

            const mockModel = createMockModel();
            const wrappedModel = vcr.wrap(mockModel);

            const request: LanguageModelV2CallOptions = {
                prompt: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "Same message" }],
                    },
                ],
            };

            // Make the same request twice
            await wrappedModel.doGenerate(request);
            await wrappedModel.doGenerate(request);

            await vcr.save();

            const cassette = await loadCassette(cassettePath, "test");
            // Should only have one interaction (duplicate replaced)
            expect(cassette.interactions).toHaveLength(1);
        });
    });

    describe("playback mode", () => {
        test("plays back recorded interactions", async () => {
            // First, record an interaction
            const recordVCR = createVCR({
                cassettePath,
                mode: "record",
            });

            await recordVCR.initialize();
            const mockModel = createMockModel();
            const recordedModel = recordVCR.wrap(mockModel);

            const request: LanguageModelV2CallOptions = {
                prompt: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "Recorded message" }],
                    },
                ],
            };

            const recordedResult = await recordedModel.doGenerate(request);
            await recordVCR.save();

            // Now play back
            const playbackVCR = createVCR({
                cassettePath,
                mode: "playback",
            });

            await playbackVCR.initialize();

            // Create a different mock that would return different results
            const playbackModel = createMockModel();
            const playbackWrappedModel = playbackVCR.wrap(playbackModel);

            const playbackResult =
                await playbackWrappedModel.doGenerate(request);

            // Should return the same result as recorded, not from the new mock
            expect(playbackResult.content).toEqual(recordedResult.content);
            expect(playbackResult.usage).toEqual(recordedResult.usage);
        });

        test("throws error in strict mode when interaction not found", async () => {
            const vcr = createVCR({
                cassettePath,
                mode: "playback",
                strictMatching: true,
            });

            await vcr.initialize();

            const mockModel = createMockModel();
            const wrappedModel = vcr.wrap(mockModel);

            const request: LanguageModelV2CallOptions = {
                prompt: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "Not recorded" }],
                    },
                ],
            };

            await expect(wrappedModel.doGenerate(request)).rejects.toThrow(
                /No recorded interaction found/
            );
        });

        test("falls back to real model when interaction not found in non-strict mode", async () => {
            const vcr = createVCR({
                cassettePath,
                mode: "playback",
                strictMatching: false,
            });

            await vcr.initialize();

            const mockModel = createMockModel();
            const wrappedModel = vcr.wrap(mockModel);

            const request: LanguageModelV2CallOptions = {
                prompt: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "Not recorded" }],
                    },
                ],
            };

            const result = await wrappedModel.doGenerate(request);

            // Should get result from real mock model
            expect(result.content[0]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Mock response"),
            });
        });
    });

    describe("passthrough mode", () => {
        test("passes through to real model without recording", async () => {
            const vcr = createVCR({
                cassettePath,
                mode: "passthrough",
            });

            await vcr.initialize();

            const mockModel = createMockModel();
            const wrappedModel = vcr.wrap(mockModel);

            await wrappedModel.doGenerate({
                prompt: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "Passthrough" }],
                    },
                ],
            });

            await vcr.dispose();

            // Cassette should be empty
            const cassette = vcr.getCassette();
            expect(cassette?.interactions).toHaveLength(0);
        });
    });

    describe("hash functions", () => {
        test("hashRequest generates consistent hashes", () => {
            const request: LanguageModelV2CallOptions = {
                prompt: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "Test" }],
                    },
                ],
            };

            const hash1 = hashRequest(request);
            const hash2 = hashRequest(request);

            expect(hash1).toBe(hash2);
            expect(hash1).toHaveLength(16);
        });

        test("hashRequest generates different hashes for different prompts", () => {
            const request1: LanguageModelV2CallOptions = {
                prompt: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "Test 1" }],
                    },
                ],
            };

            const request2: LanguageModelV2CallOptions = {
                prompt: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "Test 2" }],
                    },
                ],
            };

            const hash1 = hashRequest(request1);
            const hash2 = hashRequest(request2);

            expect(hash1).not.toBe(hash2);
        });

        test("hashRequest ignores non-prompt parameters", () => {
            const request1: LanguageModelV2CallOptions = {
                prompt: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "Test" }],
                    },
                ],
                temperature: 0.5,
            };

            const request2: LanguageModelV2CallOptions = {
                prompt: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "Test" }],
                    },
                ],
                temperature: 0.9,
            };

            const hash1 = hashRequest(request1);
            const hash2 = hashRequest(request2);

            // Should be the same because prompt is the same
            expect(hash1).toBe(hash2);
        });

        test("explainHash returns human-readable description", () => {
            const request: LanguageModelV2CallOptions = {
                prompt: [
                    {
                        role: "system",
                        content: [{ type: "text", text: "You are helpful" }],
                    },
                    {
                        role: "user",
                        content: [{ type: "text", text: "Hello world" }],
                    },
                ],
            };

            const explanation = explainHash(request);

            expect(explanation).toContain("1 system");
            expect(explanation).toContain("1 user");
            expect(explanation).toContain("Hello world");
        });

        test("explainHash includes tool information", () => {
            const request: LanguageModelV2CallOptions = {
                prompt: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "Use tools" }],
                    },
                ],
                tools: [
                    {
                        type: "function",
                        name: "test_tool",
                        parameters: {},
                    },
                ],
            };

            const explanation = explainHash(request);

            expect(explanation).toContain("tools: test_tool");
        });
    });

    describe("initialization", () => {
        test("throws error if wrap called before initialize", () => {
            const vcr = createVCR({
                cassettePath,
                mode: "record",
            });

            const mockModel = createMockModel();

            expect(() => vcr.wrap(mockModel)).toThrow(
                /must be initialized/
            );
        });

        test("can be initialized multiple times safely", async () => {
            const vcr = createVCR({
                cassettePath,
                mode: "record",
            });

            await vcr.initialize();
            await vcr.initialize(); // Should not throw

            const mockModel = createMockModel();
            const wrappedModel = vcr.wrap(mockModel);

            await wrappedModel.doGenerate({
                prompt: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "Test" }],
                    },
                ],
            });

            await vcr.save();

            const cassette = await loadCassette(cassettePath, "test");
            expect(cassette.interactions).toHaveLength(1);
        });
    });
});
