import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { config } from "@/services/ConfigService";
import { categorizeAgent, parseCategory } from "../categorizeAgent";

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
const mockState = {
    llmService: {
        generateText: async () => ({ text: "worker" }),
    },
};

describe("categorizeAgent", () => {
    beforeEach(() => {
        spyOn(config, "loadConfig").mockImplementation(async () => {
            loadConfigCalls++;
            return loadConfigResult as any;
        });
        spyOn(config, "createLLMService").mockImplementation((configName?: string) => {
            createLLMServiceCalls++;
            lastRequestedConfigName = configName;
            return mockState.llmService as any;
        });
    });

    it("parses categories from verbose LLM output and uses the categorization slot first", async () => {
        expect(parseCategory("The agent is a domain-expert in NDK")).toBe("domain-expert");
        expect(parseCategory("  reviewer \n")).toBe("reviewer");

        mockState.llmService = {
            generateText: async () => ({ text: "The agent is a worker" }),
        };
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
        mockState.llmService = {
            generateText: async () => ({ text: "The agent is a reviewer" }),
        };
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

        mockState.llmService = {
            generateText: async () => ({ text: "I cannot tell" }),
        };
        const undefinedCategory = await categorizeAgent({
            name: "Unknown Bot",
            role: "helper",
        });

        expect(undefinedCategory).toBeUndefined();
    });
});
