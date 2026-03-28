import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { ProjectContext } from "@/services/projects/ProjectContext";
import { config } from "@/services/ConfigService";
import { llmServiceFactory } from "@/llm";
import { PromptCompilerRegistryService } from "../PromptCompilerRegistryService";

const originalConfigMethods = {
    getConfigPath: (config as any).getConfigPath,
    loadConfig: (config as any).loadConfig,
    getLLMConfig: (config as any).getLLMConfig,
};
const originalCreateService = llmServiceFactory.createService;

describe("PromptCompilerRegistryService", () => {
    const agent: AgentInstance = {
        name: "Test Agent",
        slug: "test-agent",
        pubkey: "agent-pubkey-123",
        role: "assistant",
        instructions: "Base instructions",
        llmConfig: "test-config",
        tools: [],
        signer: {} as any,
        createMetadataStore: () => ({} as any),
        createLLMService: () => ({} as any),
        sign: async () => {},
    };

    let projectContext: ProjectContext;

    beforeEach(() => {
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
            generateText: async () => ({
                text: "Effective Agent Instructions from LLM",
            }),
        })) as any;

        projectContext = {
            getAgentByPubkey: (pubkey: string) => (pubkey === agent.pubkey ? agent : undefined),
            getLessonsForAgent: () => [],
            getCommentsForAgent: () => [],
        } as unknown as ProjectContext;
    });

    afterEach(() => {
        (config as any).getConfigPath = originalConfigMethods.getConfigPath;
        (config as any).loadConfig = originalConfigMethods.loadConfig;
        (config as any).getLLMConfig = originalConfigMethods.getLLMConfig;
        llmServiceFactory.createService = originalCreateService;
        mock.restore();
    });

    test("returns base instructions when no compiler is registered", () => {
        const registry = new PromptCompilerRegistryService("project-1", "Project 1", projectContext);

        expect(registry.getEffectiveInstructionsSync(agent.pubkey, "Base instructions")).toBe("Base instructions");
    });

    test("lazy-registers an agent when syncing inputs", async () => {
        const registry = new PromptCompilerRegistryService("project-1", "Project 1", projectContext);

        await registry.syncAgentInputs(agent.pubkey, [], []);

        expect(registry.getEffectiveInstructionsSync(agent.pubkey, "Base instructions")).toBe("Base instructions");
    });

    test("stops all managed compilers without throwing", async () => {
        const registry = new PromptCompilerRegistryService("project-1", "Project 1", projectContext);
        await registry.registerAgent(agent);

        expect(() => registry.stop()).not.toThrow();
    });
});
