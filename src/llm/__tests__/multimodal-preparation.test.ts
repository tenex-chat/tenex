import { afterEach, describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { prepareMultimodalMessagesForProvider } from "../multimodal-preparation";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("prepareMultimodalMessagesForProvider", () => {
    test("leaves non-Ollama providers unchanged", async () => {
        const messages: ModelMessage[] = [{
            role: "user",
            content: [
                { type: "text", text: "See image https://images.example/photo.jpg" },
                { type: "image", image: new URL("https://images.example/photo.jpg") },
            ],
        }];

        const prepared = await prepareMultimodalMessagesForProvider(messages, {
            provider: "openai",
            model: "gpt-5.1",
        });

        expect(prepared).toBe(messages);
    });

    test("converts Ollama vision URL images to base64 file parts", async () => {
        const imageBytes = Buffer.from("fake image bytes");
        globalThis.fetch = async () => new Response(imageBytes, {
            status: 200,
            headers: {
                "content-type": "image/jpeg",
                "content-length": String(imageBytes.byteLength),
            },
        });

        const messages: ModelMessage[] = [{
            role: "user",
            content: [
                { type: "text", text: "Describe this image https://cdn.test/photo.jpg" },
                { type: "image", image: new URL("https://cdn.test/photo.jpg") },
            ],
        }];

        const prepared = await prepareMultimodalMessagesForProvider(messages, {
            provider: "ollama",
            model: "gemini-3-flash-preview:cloud",
        });

        expect(prepared).not.toBe(messages);
        expect(Array.isArray(prepared[0]?.content)).toBe(true);
        const content = prepared[0]?.content as Array<Record<string, unknown>>;
        expect(content).toEqual([
            { type: "text", text: "Describe this image https://cdn.test/photo.jpg" },
            {
                type: "file",
                data: imageBytes.toString("base64"),
                mediaType: "image/jpeg",
                providerOptions: undefined,
            },
        ]);
    });

    test("drops Ollama URL image parts for non-vision models and keeps text context", async () => {
        let fetchCalled = false;
        globalThis.fetch = async () => {
            fetchCalled = true;
            return new Response();
        };

        const messages: ModelMessage[] = [{
            role: "user",
            content: [
                { type: "text", text: "Describe this image https://cdn.test/photo.jpg" },
                { type: "image", image: new URL("https://cdn.test/photo.jpg") },
            ],
        }];

        const prepared = await prepareMultimodalMessagesForProvider(messages, {
            provider: "ollama",
            model: "qwen3-coder-next:cloud",
        });

        expect(fetchCalled).toBe(false);
        expect(prepared).not.toBe(messages);
        expect(prepared[0]?.content).toEqual([
            { type: "text", text: "Describe this image https://cdn.test/photo.jpg" },
        ]);
    });

    test("normalizes existing Ollama base64 image file parts", async () => {
        const messages: ModelMessage[] = [{
            role: "user",
            content: [
                { type: "text", text: "Describe this image" },
                {
                    type: "file",
                    mediaType: "image/jpg",
                    data: "data:image/jpeg;base64,ZmFrZQ==",
                },
            ],
        }];

        const prepared = await prepareMultimodalMessagesForProvider(messages, {
            provider: "ollama",
            model: "llava",
        });

        expect(prepared[0]?.content).toEqual([
            { type: "text", text: "Describe this image" },
            {
                type: "file",
                data: "ZmFrZQ==",
                mediaType: "image/jpeg",
                providerOptions: undefined,
            },
        ]);
    });
});
