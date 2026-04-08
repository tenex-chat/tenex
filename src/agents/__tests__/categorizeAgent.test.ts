import { describe, expect, it, mock } from "bun:test";
import { createSimpleMock } from "@/test-utils/mock-llm";

let loadConfigCalls = 0;
let createLLMServiceCalls = 0;
let lastRequestedConfigName: string | undefined;
let loadConfigResult: {
    llms: {
        categorization?: string;
        summarization?: string;
        default?: string;
    };
} = {
    llms: {
        categorization: "categorization-model",
        summarization: "summarization-model",
        default: "default-model",
    },
};
let llmService = createSimpleMock("worker");

const loadConfigMock = mock(async () => {
    loadConfigCalls++;
    return loadConfigResult;
});

const createLLMServiceMock = mock((configName?: string) => {
    createLLMServiceCalls++;
    lastRequestedConfigName = configName;
    return llmService;
});

mock.module("@/services/ConfigService", () => ({
    config: {
        getConfigPath: () => "/tmp/tenex-test",
        loadConfig: loadConfigMock,
        createLLMService: createLLMServiceMock,
    },
}));

const categorizeModulePromise = import("../categorizeAgent");

describe("categorizeAgent", () => {
    it("parses categories from verbose LLM output and uses the categorization slot first", async () => {
        const { categorizeAgent, parseCategory } = await categorizeModulePromise;

        expect(parseCategory("The agent is a domain-expert in NDK")).toBe("domain-expert");
        expect(parseCategory("  reviewer \n")).toBe("reviewer");

        llmService = createSimpleMock("The agent is a worker");
        loadConfigResult = {
            llms: {
                categorization: "categorization-model",
                summarization: "summarization-model",
                default: "default-model",
            },
        };
        loadConfigCalls = 0;
        createLLMServiceCalls = 0;
        lastRequestedConfigName = undefined;

        const category = await categorizeAgent({
            name: "Build Bot",
            role: "code writer",
            description: "Implements plan items",
            instructions: "Write changes and keep tests passing.",
            useCriteria: "Use when implementation work is needed.",
        });

        expect(category).toBe("worker");
        expect(loadConfigCalls).toBe(1);
        expect(createLLMServiceCalls).toBe(1);
        expect(lastRequestedConfigName).toBe("categorization-model");
    });

    it("falls back to summarization when categorization is absent and handles parse failures", async () => {
        const { categorizeAgent } = await categorizeModulePromise;

        llmService = createSimpleMock("The agent is a reviewer");
        loadConfigResult = {
            llms: {
                summarization: "summarization-model",
                default: "default-model",
            },
        };
        loadConfigCalls = 0;
        createLLMServiceCalls = 0;
        lastRequestedConfigName = undefined;

        const category = await categorizeAgent({
            name: "Review Bot",
            role: "reviewer",
            description: "Checks code quality",
        });

        expect(category).toBe("reviewer");
        expect(lastRequestedConfigName).toBe("summarization-model");

        llmService = createSimpleMock("I cannot tell");
        const undefinedCategory = await categorizeAgent({
            name: "Unknown Bot",
            role: "helper",
        });

        expect(undefinedCategory).toBeUndefined();
    });
});
