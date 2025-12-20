import { describe, test, expect, beforeEach } from "bun:test";
import { join } from "path";
import { generateText, streamText } from "ai";
import { createVCR } from "../vcr";
import type { VCR } from "../vcr";
import { loadCassette } from "../cassette";

const cassettePath = join(import.meta.dir, "shell-time.cassette.json");

describe("VCR with AI SDK", () => {
    let vcr: VCR;

    beforeEach(async () => {
        vcr = createVCR({
            cassettePath,
            mode: "playback",
            strictMatching: true,
        });
        await vcr.initialize();
    });

    test("cassette contains recorded interaction", async () => {
        const cassette = await loadCassette(cassettePath, "test");

        expect(cassette.interactions).toHaveLength(1);

        const interaction = cassette.interactions[0];

        // Verify the recorded request structure
        expect(interaction.request.prompt).toBeDefined();
        expect(interaction.request.prompt.length).toBeGreaterThan(0);

        // Find the user message in the prompt
        const userMessage = interaction.request.prompt.find(
            (m: any) => m.role === "user"
        );
        expect(userMessage).toBeDefined();

        // Verify it contains the expected content
        const userContent = userMessage?.content;
        expect(userContent).toEqual([
            { type: "text", text: "use shell to get the current time" }
        ]);
    });

    test("recorded prompt contains tool call from assistant", async () => {
        const cassette = await loadCassette(cassettePath, "test");
        const interaction = cassette.interactions[0];

        // Find assistant message with tool call
        const assistantMessage = interaction.request.prompt.find(
            (m: any) => m.role === "assistant"
        );
        expect(assistantMessage).toBeDefined();

        // Verify it has a tool call
        const toolCall = assistantMessage?.content?.find(
            (c: any) => c.type === "tool-call"
        );
        expect(toolCall).toBeDefined();
        expect(toolCall.toolName).toBe("shell");
        expect(toolCall.input).toEqual({
            command: "date",
            cwd: ".",
            timeout: 30000,
        });
    });

    test("recorded prompt contains tool result", async () => {
        const cassette = await loadCassette(cassettePath, "test");
        const interaction = cassette.interactions[0];

        // Find tool result message
        const toolMessage = interaction.request.prompt.find(
            (m: any) => m.role === "tool"
        );
        expect(toolMessage).toBeDefined();

        // Verify the tool result
        const toolResult = toolMessage?.content?.[0];
        expect(toolResult?.type).toBe("tool-result");
        expect(toolResult?.toolName).toBe("shell");
        expect(toolResult?.output?.value).toContain("Dec 20");
    });

    test("VCR replays response through generateText", async () => {
        const cassette = await loadCassette(cassettePath, "test");
        const interaction = cassette.interactions[0];

        // Create a mock model that VCR will wrap
        const mockModel = {
            specificationVersion: "v2" as const,
            provider: "test",
            modelId: "test-model",
            supportedUrls: {},
            doGenerate: async () => {
                throw new Error("Should not be called");
            },
            doStream: async () => {
                throw new Error("Should not be called");
            },
        };

        const wrappedModel = vcr.wrap(mockModel);

        // Use AI SDK's generateText with VCR-wrapped model
        const result = await generateText({
            model: wrappedModel as any,
            messages: interaction.request.prompt as any,
        });

        // Verify the response matches what was recorded
        expect(result.finishReason).toBe("stop");
        // Usage comes through in the format from the cassette
        expect(result.usage).toBeDefined();
    });

    test("VCR replays response through streamText", async () => {
        const cassette = await loadCassette(cassettePath, "test");
        const interaction = cassette.interactions[0];

        const mockModel = {
            specificationVersion: "v2" as const,
            provider: "test",
            modelId: "test-model",
            supportedUrls: {},
            doGenerate: async () => {
                throw new Error("Should not be called");
            },
            doStream: async () => {
                throw new Error("Should not be called");
            },
        };

        const wrappedModel = vcr.wrap(mockModel);

        // Use AI SDK's streamText with VCR-wrapped model
        const result = streamText({
            model: wrappedModel as any,
            messages: interaction.request.prompt as any,
        });

        // Consume the stream
        let text = "";
        for await (const chunk of result.textStream) {
            text += chunk;
        }

        // Get final result - finishReason is a promise property on StreamTextResult
        const finishReason = await result.finishReason;
        expect(finishReason).toBe("stop");
    });

    test("VCR throws for unrecorded prompts in strict mode", async () => {
        const mockModel = {
            specificationVersion: "v2" as const,
            provider: "test",
            modelId: "test-model",
            supportedUrls: {},
            doGenerate: async () => {
                throw new Error("Should not be called");
            },
            doStream: async () => {
                throw new Error("Should not be called");
            },
        };

        const wrappedModel = vcr.wrap(mockModel);

        // Try to use a prompt that wasn't recorded
        await expect(
            generateText({
                model: wrappedModel as any,
                messages: [{ role: "user", content: "unrecorded prompt" }],
            })
        ).rejects.toThrow(/No recorded interaction found/);
    });
});
