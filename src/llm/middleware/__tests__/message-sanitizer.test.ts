import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { LanguageModelV3Message } from "@ai-sdk/provider";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";

const testBaseDir = join(import.meta.dir, ".test-tenex-base");

mock.module("@/constants", () => ({
    getTenexBasePath: () => testBaseDir,
    TENEX_DIR: ".tenex",
    CONFIG_FILE: "config.json",
    MCP_CONFIG_FILE: "mcp.json",
    LLMS_FILE: "llms.json",
    PROVIDERS_FILE: "providers.json",
}));

mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(() => {}),
        error: mock(() => {}),
        warn: mock(() => {}),
        debug: mock(() => {}),
    },
}));

import { createMessageSanitizerMiddleware } from "../message-sanitizer";

const fakeModel: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    supportedUrls: {},
    doGenerate: async () => { throw new Error("not implemented"); },
    doStream: async () => { throw new Error("not implemented"); },
};

function makeParams(prompt: LanguageModelV3Message[]) {
    return { prompt, maxOutputTokens: 4096 };
}

describe("message-sanitizer TENEX wrapper", () => {
    beforeEach(() => {
        if (existsSync(testBaseDir)) rmSync(testBaseDir, { recursive: true });
    });

    afterEach(() => {
        if (existsSync(testBaseDir)) rmSync(testBaseDir, { recursive: true });
    });

    const middleware = createMessageSanitizerMiddleware();
    const transformParams = middleware.transformParams!;

    test("writes structured JSON to warn.log when fix is applied", async () => {
        const prompt: LanguageModelV3Message[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
            { role: "assistant", content: [{ type: "text", text: "Trailing" }] },
        ];

        await transformParams({ params: makeParams(prompt), type: "stream", model: fakeModel });

        const logPath = join(testBaseDir, "daemon", "warn.log");
        expect(existsSync(logPath)).toBe(true);

        const entry = JSON.parse(readFileSync(logPath, "utf-8").trim());
        expect(entry.fix).toBe("trailing-assistant-stripped");
        expect(entry.model).toBe("anthropic:claude-opus-4-6");
        expect(entry.callType).toBe("stream");
        expect(entry.ts).toBeDefined();
    });

    test("does not write warn.log when no fixes needed", async () => {
        const prompt: LanguageModelV3Message[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ];

        await transformParams({ params: makeParams(prompt), type: "stream", model: fakeModel });

        expect(existsSync(join(testBaseDir, "daemon", "warn.log"))).toBe(false);
    });

    test("writes multiple entries for multiple fixes", async () => {
        const prompt: LanguageModelV3Message[] = [
            { role: "user", content: [] },
            { role: "user", content: [{ type: "text", text: "Hello" }] },
            { role: "assistant", content: [{ type: "text", text: "Trailing" }] },
        ];

        await transformParams({ params: makeParams(prompt), type: "generate", model: fakeModel });

        const lines = readFileSync(join(testBaseDir, "daemon", "warn.log"), "utf-8")
            .trim()
            .split("\n");
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]).fix).toBe("empty-content-stripped");
        expect(JSON.parse(lines[1]).fix).toBe("trailing-assistant-stripped");
    });
});
