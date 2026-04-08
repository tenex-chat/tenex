import { afterEach, describe, expect, mock, test } from "bun:test";

let selectedConfigName: string | undefined;
let generatedText = "worker";
let loadedLlms: {
    categorization?: string;
    summarization?: string;
    default?: string;
} = {
    categorization: "categorization-model",
    summarization: "summarization-model",
    default: "default-model",
};

mock.module("@/services/ConfigService", () => ({
    config: {
        loadConfig: async () => ({ llms: loadedLlms }),
        getLLMConfig: (configName?: string) => {
            selectedConfigName = configName;
            return {
                provider: "mock",
                model: configName || "default-model",
            };
        },
    },
}));

mock.module("@/llm", () => ({
    llmServiceFactory: {
        createService: () => ({
            generateText: async () => ({ text: generatedText }),
        }),
    },
}));

const { categorizeAgent, parseCategory } = await import("../categorizeAgent");

afterEach(() => {
    selectedConfigName = undefined;
    generatedText = "worker";
    loadedLlms = {
        categorization: "categorization-model",
        summarization: "summarization-model",
        default: "default-model",
    };
});

describe("categorizeAgent", () => {
    test("parses direct category output", async () => {
        generatedText = "  WORKER\n";

        const category = await categorizeAgent({ name: "test-agent" });

        expect(category).toBe("worker");
        expect(selectedConfigName).toBe("categorization-model");
    });

    test("falls back to summarization then default config names", async () => {
        loadedLlms = {
            summarization: "summarization-model",
            default: "default-model",
        };

        const category = await categorizeAgent({
            name: "test-agent",
            role: "worker",
            description: "Implements tasks directly",
        });

        expect(category).toBe("worker");
        expect(selectedConfigName).toBe("summarization-model");
    });

    test("extracts category from a verbose response", async () => {
        generatedText = "The right category here is domain-expert because of the domain expertise.";

        const category = await categorizeAgent({ name: "expert-agent" });

        expect(category).toBe("domain-expert");
    });

    test("returns undefined for unparseable output", async () => {
        generatedText = "I do not know.";

        const category = await categorizeAgent({ name: "confused-agent" });

        expect(category).toBeUndefined();
    });
});

describe("parseCategory", () => {
    test("accepts all canonical categories and normalizes case", () => {
        expect(parseCategory("Principal")).toBe("principal");
        expect(parseCategory("orchestrator")).toBe("orchestrator");
        expect(parseCategory("worker")).toBe("worker");
        expect(parseCategory("reviewer")).toBe("reviewer");
        expect(parseCategory("domain-expert")).toBe("domain-expert");
        expect(parseCategory("generalist")).toBe("generalist");
    });

    test("extracts a valid category from surrounding text", () => {
        expect(parseCategory("This agent should be a worker." )).toBe("worker");
        expect(parseCategory("orchestrator (routes work)")).toBe("orchestrator");
    });
});
