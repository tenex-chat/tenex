import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { NDKProject } from "@nostr-dev-kit/ndk";

const addedFragments: Array<{ id: string; args: any }> = [];
let currentProjectContext: any;

class MockPromptBuilder {
    add(id: string, args: any): void {
        addedFragments.push({ id, args });
    }

    async build(): Promise<string> {
        return "mock-built-prompt";
    }

    getFragmentCount(): number {
        return addedFragments.length;
    }
}

mock.module("@/prompts/core/PromptBuilder", () => ({
    PromptBuilder: MockPromptBuilder,
}));

mock.module("@/services/projects", () => ({
    getProjectContext: () => currentProjectContext,
}));

mock.module("@/services/rag/RAGService", () => ({
    RAGService: {
        getInstance: () => ({
            getCachedAllCollectionStats: async () => [],
        }),
    },
}));

mock.module("@/services/scheduling", () => ({
    SchedulerService: {
        getInstance: () => ({
            getTasks: async () => [],
        }),
    },
}));

mock.module("@/services/ingress/TransportBindingStoreService", () => ({
    getTransportBindingStore: () => ({
        listBindingsForAgentProject: () => [],
    }),
}));

mock.module("@/services/identity", () => ({
    getIdentityBindingStore: () => ({
        getBinding: () => undefined,
    }),
}));

mock.module("@/services/telegram/TelegramChatContextStoreService", () => ({
    getTelegramChatContextStore: () => ({
        getContext: () => undefined,
    }),
}));

mock.module("@/prompts/fragments/26-mcp-resources", () => ({
    fetchAgentMcpResources: async () => [],
}));

mock.module("@/utils/logger", () => ({
    logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
    },
}));

import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";

describe("systemPromptBuilder", () => {
    let agent: AgentInstance;
    let project: NDKProject;
    let conversation: any;

    beforeEach(() => {
        addedFragments.length = 0;
        currentProjectContext = {};

        agent = {
            name: "Builder Agent",
            slug: "builder-agent",
            pubkey: "agent-pubkey-123",
            role: "assistant",
            instructions: "Base instructions",
            llmConfig: "default",
            tools: [],
            signer: {} as any,
            createMetadataStore: () => ({} as any),
            createLLMService: () => ({} as any),
            sign: async () => {},
        };

        project = {
            dTag: "project-1",
            pubkey: "owner-pubkey",
            tagValue: (tag: string) => {
                if (tag === "title") return "Project One";
                if (tag === "d") return "project-1";
                return undefined;
            },
        } as unknown as NDKProject;

        conversation = {
            getId: () => "conversation-1",
            metadata: {},
        };
    });

    it("uses compiled instructions from the runtime registry", async () => {
        const getEffectiveInstructionsSync = mock(() => "Compiled instructions");
        currentProjectContext = {
            promptCompilerRegistry: {
                getEffectiveInstructionsSync,
            },
        };

        await buildSystemPromptMessages({
            agent,
            project,
            conversation,
        });

        expect(getEffectiveInstructionsSync).toHaveBeenCalledWith(
            agent.pubkey,
            "Base instructions"
        );

        const agentIdentityFragment = addedFragments.find(
            (fragment) => fragment.id === "agent-identity"
        );

        expect(agentIdentityFragment?.args.agent.instructions).toBe("Compiled instructions");
        expect(addedFragments.some((fragment) => fragment.id === "retrieved-lessons")).toBe(false);
    });

    it("falls back to base instructions when no runtime registry exists", async () => {
        currentProjectContext = {};

        await buildSystemPromptMessages({
            agent,
            project,
            conversation,
        });

        const agentIdentityFragment = addedFragments.find(
            (fragment) => fragment.id === "agent-identity"
        );

        expect(agentIdentityFragment?.args.agent.instructions).toBe("Base instructions");
    });

    it("does not add environment or cross-project fragments to the main prompt", async () => {
        currentProjectContext = {};

        await buildSystemPromptMessages({
            agent,
            project,
            conversation,
        });

        expect(addedFragments.some((fragment) => fragment.id === "environment-context")).toBe(false);
        expect(addedFragments.some((fragment) => fragment.id === "meta-project-context")).toBe(false);
    });

    it("only adds no-response guidance for Telegram-triggered turns", async () => {
        currentProjectContext = {};

        await buildSystemPromptMessages({
            agent,
            project,
            conversation,
        });

        expect(addedFragments.some((fragment) => fragment.id === "no-response-guidance")).toBe(false);

        addedFragments.length = 0;

        await buildSystemPromptMessages({
            agent,
            project,
            conversation,
            triggeringEnvelope: {
                transport: "telegram",
            } as any,
        });

        expect(addedFragments.some((fragment) => fragment.id === "no-response-guidance")).toBe(true);
    });
});
