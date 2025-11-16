import { beforeEach, describe, expect, it } from "bun:test";
import type { LanguageModelV1StreamPart } from "ai";
import { throttlingMiddleware } from "../middleware/throttlingMiddleware";

describe("Throttling Middleware", () => {
    it("should pass through chunks and maintain text assembly", async () => {
        const middleware = throttlingMiddleware({ flushInterval: 100 });

        // Create a mock doStream that returns a stream with text chunks
        const mockDoStream = async () => {
            const chunks: LanguageModelV1StreamPart[] = [
                { type: "stream-start", warnings: [] } as any,
                { type: "text-delta", delta: "Hello", id: "1" } as any,
                { type: "text-delta", delta: " ", id: "1" } as any,
                { type: "text-delta", delta: "World", id: "1" } as any,
                { type: "finish", finishReason: "stop", usage: {} } as any,
            ];

            const stream = new ReadableStream({
                async start(controller) {
                    for (const chunk of chunks) {
                        controller.enqueue(chunk);
                        // Small delay between chunks to simulate real streaming
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                    controller.close();
                },
            });

            return { stream, request: {}, response: {} };
        };

        // Wrap the stream using the middleware
        const wrapped = await middleware.wrapStream?.({ doStream: mockDoStream });

        // Collect all chunks from the wrapped stream
        const collectedChunks: any[] = [];
        const reader = wrapped.stream.getReader();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            collectedChunks.push(value);
        }

        // Should have start, buffered text-delta(s), and finish
        const textChunks = collectedChunks.filter((c) => c.type === "text-delta");
        const allText = textChunks.map((c) => c.delta).join("");

        expect(allText).toBe("Hello World");
        expect(collectedChunks.some((c) => c.type === "stream-start")).toBe(true);
        expect(collectedChunks.some((c) => c.type === "finish")).toBe(true);
    });

    it("should flush immediately when newline is received", async () => {
        const middleware = throttlingMiddleware({ flushInterval: 500, chunking: "line" });

        // Create a mock stream where newlines come quickly
        const mockDoStream = async () => {
            const chunks: LanguageModelV1StreamPart[] = [
                { type: "stream-start", warnings: [] } as any,
                { type: "text-delta", delta: "First line", id: "1" } as any,
                { type: "text-delta", delta: " of text\n", id: "1" } as any, // Newline triggers immediate flush
                { type: "text-delta", delta: "Second", id: "1" } as any,
                { type: "text-delta", delta: " line\n", id: "1" } as any, // Another newline triggers flush
                { type: "text-delta", delta: "Partial", id: "1" } as any, // No newline, waits for timer
                { type: "finish", finishReason: "stop", usage: {} } as any,
            ];

            const stream = new ReadableStream({
                async start(controller) {
                    for (const chunk of chunks) {
                        controller.enqueue(chunk);
                        // Small delay to show immediate flushing
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                    controller.close();
                },
            });

            return { stream, request: {}, response: {} };
        };

        // Wrap the stream
        const wrapped = await middleware.wrapStream?.({ doStream: mockDoStream });

        // Collect chunks
        const collectedChunks: any[] = [];
        const reader = wrapped.stream.getReader();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            collectedChunks.push(value);
        }

        const textChunks = collectedChunks.filter((c) => c.type === "text-delta");

        // Should get immediate flushes on newlines
        expect(textChunks[0].delta).toBe("First line of text\n");
        expect(textChunks[1].delta).toBe("Second line\n");
        expect(textChunks[2].delta).toBe("Partial"); // Flushed at end

        // Total time should be much less than 500ms since we flush on newlines
        expect(textChunks.length).toBe(3);
    });

    it("should respect line boundaries when chunking", async () => {
        const middleware = throttlingMiddleware({ flushInterval: 100, chunking: "line" });

        // Create a mock stream with text that spans multiple lines
        const mockDoStream = async () => {
            const chunks: LanguageModelV1StreamPart[] = [
                { type: "stream-start", warnings: [] } as any,
                { type: "text-delta", delta: "First line", id: "1" } as any,
                { type: "text-delta", delta: " of text\n", id: "1" } as any,
                { type: "text-delta", delta: "Second line", id: "1" } as any,
                { type: "text-delta", delta: " is here", id: "1" } as any,
                // Wait long enough for flush
                { type: "text-delta", delta: "\nThird", id: "1" } as any,
                { type: "text-delta", delta: " line\n", id: "1" } as any,
                { type: "finish", finishReason: "stop", usage: {} } as any,
            ];

            const stream = new ReadableStream({
                async start(controller) {
                    controller.enqueue(chunks[0]); // stream-start
                    controller.enqueue(chunks[1]); // "First line"
                    controller.enqueue(chunks[2]); // " of text\n"

                    // Wait for flush timer
                    await new Promise((resolve) => setTimeout(resolve, 150));

                    controller.enqueue(chunks[3]); // "Second line"
                    controller.enqueue(chunks[4]); // " is here"
                    controller.enqueue(chunks[5]); // "\nThird"

                    // Wait for another flush
                    await new Promise((resolve) => setTimeout(resolve, 150));

                    controller.enqueue(chunks[6]); // " line\n"
                    controller.enqueue(chunks[7]); // finish
                    controller.close();
                },
            });

            return { stream, request: {}, response: {} };
        };

        // Wrap the stream
        const wrapped = await middleware.wrapStream?.({ doStream: mockDoStream });

        // Collect chunks
        const collectedChunks: any[] = [];
        const reader = wrapped.stream.getReader();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            collectedChunks.push(value);
        }

        const textChunks = collectedChunks.filter((c) => c.type === "text-delta");

        // First flush should only include the complete first line
        expect(textChunks[0].delta).toBe("First line of text\n");

        // Check subsequent chunks
        if (textChunks.length === 2) {
            // If we got 2 chunks, second should have both lines
            expect(textChunks[1].delta).toBe("Second line is here\nThird line\n");
        } else if (textChunks.length === 3) {
            // If we got 3 chunks, they might be split differently
            expect(textChunks[1].delta).toBe("Second line is here\n");
            expect(textChunks[2].delta).toBe("Third line\n");
        }

        // All text should be present
        const allText = textChunks.map((c) => c.delta).join("");
        expect(allText).toBe("First line of text\nSecond line is here\nThird line\n");
    });

    it("should flush on timeout when no newline received", async () => {
        const middleware = throttlingMiddleware({ flushInterval: 100, chunking: "line" });

        // Create a mock stream with text that doesn't have newlines
        const mockDoStream = async () => {
            const chunks: LanguageModelV1StreamPart[] = [
                { type: "stream-start", warnings: [] } as any,
                { type: "text-delta", delta: "This", id: "1" } as any,
                { type: "text-delta", delta: " is", id: "1" } as any,
                { type: "text-delta", delta: " a", id: "1" } as any,
                { type: "text-delta", delta: " long", id: "1" } as any,
                { type: "text-delta", delta: " text", id: "1" } as any,
                { type: "text-delta", delta: " without", id: "1" } as any,
                { type: "text-delta", delta: " newlines", id: "1" } as any,
                { type: "finish", finishReason: "stop", usage: {} } as any,
            ];

            const stream = new ReadableStream({
                async start(controller) {
                    // Send chunks rapidly
                    for (let i = 0; i < chunks.length - 1; i++) {
                        controller.enqueue(chunks[i]);
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }

                    // Wait long enough for timer flush
                    await new Promise((resolve) => setTimeout(resolve, 150));

                    // Send finish
                    controller.enqueue(chunks[chunks.length - 1]);
                    controller.close();
                },
            });

            return { stream, request: {}, response: {} };
        };

        // Wrap the stream
        const wrapped = await middleware.wrapStream?.({ doStream: mockDoStream });

        // Collect chunks
        const collectedChunks: any[] = [];
        const reader = wrapped.stream.getReader();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            collectedChunks.push(value);
        }

        const textChunks = collectedChunks.filter((c) => c.type === "text-delta");

        // Should flush on timer since no newlines
        expect(textChunks.length).toBe(1);
        expect(textChunks[0].delta).toBe("This is a long text without newlines");
    });

    it("should throttle multiple rapid chunks", async () => {
        const middleware = throttlingMiddleware({ flushInterval: 200 });

        // Create a mock doStream that returns rapid chunks
        const mockDoStream = async () => {
            const textParts = [
                "T",
                "h",
                "i",
                "s",
                " ",
                "i",
                "s",
                " ",
                "a",
                " ",
                "t",
                "e",
                "s",
                "t",
            ];

            const stream = new ReadableStream({
                async start(controller) {
                    controller.enqueue({ type: "stream-start", warnings: [] });

                    // Send all chunks rapidly
                    for (const text of textParts) {
                        controller.enqueue({ type: "text-delta", delta: text, id: "1" });
                    }

                    controller.enqueue({ type: "finish", finishReason: "stop", usage: {} });
                    controller.close();
                },
            });

            return { stream, request: {}, response: {} };
        };

        // Wrap the stream using the middleware
        const wrapped = await middleware.wrapStream?.({ doStream: mockDoStream });

        // Collect all chunks from the wrapped stream
        const collectedChunks: any[] = [];
        const reader = wrapped.stream.getReader();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            collectedChunks.push(value);
        }

        // Should have buffered the rapid chunks into fewer flushes
        const textChunks = collectedChunks.filter((c) => c.type === "text-delta");
        const allText = textChunks.map((c) => c.delta).join("");

        expect(allText).toBe("This is a test");
        // Since chunks arrive rapidly and we have 200ms flush interval,
        // we should get fewer text chunks than the original 14
        expect(textChunks.length).toBeLessThanOrEqual(3);
    });
});
