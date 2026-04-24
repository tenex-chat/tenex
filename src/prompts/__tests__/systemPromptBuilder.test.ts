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
    const buildPrompt = (overrides: Record<string, unknown> = {}) =>
        buildSystemPromptMessages({
            agent,
            project,
            conversation,
            projectContext: currentProjectContext,
            ...overrides,
        });

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

        await buildPrompt();

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

        await buildPrompt();

        const agentIdentityFragment = addedFragments.find(
            (fragment) => fragment.id === "agent-identity"
        );

        expect(agentIdentityFragment?.args.agent.instructions).toBe("Base instructions");
    });

    it("does not add cross-project fragments to the main prompt", async () => {
        currentProjectContext = {};

        await buildPrompt();

        expect(addedFragments.some((fragment) => fragment.id === "meta-project-context")).toBe(false);
    });

    it("only adds no-response guidance for Telegram-triggered turns", async () => {
        currentProjectContext = {};

        await buildPrompt();

        expect(addedFragments.some((fragment) => fragment.id === "no-response-guidance")).toBe(false);

        addedFragments.length = 0;

        await buildPrompt({
            triggeringEnvelope: {
                transport: "telegram",
            } as any,
        });

        expect(addedFragments.some((fragment) => fragment.id === "no-response-guidance")).toBe(true);
    });

    it("includes domain-expert-guidance fragment for domain-expert agents", async () => {
        currentProjectContext = {};

        await buildPrompt({
            agentCategory: "domain-expert",
        });

        expect(addedFragments.some((fragment) => fragment.id === "domain-expert-guidance")).toBe(true);
    });

    it("does not include domain-expert-guidance fragment for non-domain-expert categories", async () => {
        currentProjectContext = {};

        for (const category of ["orchestrator", "worker"] as const) {
            addedFragments.length = 0;

            await buildPrompt({
                agentCategory: category,
            });

            expect(addedFragments.some((fragment) => fragment.id === "domain-expert-guidance")).toBe(false);
        }
    });

    it("does not include domain-expert-guidance fragment when agentCategory is undefined", async () => {
        currentProjectContext = {};

        await buildPrompt();

        expect(addedFragments.some((fragment) => fragment.id === "domain-expert-guidance")).toBe(false);
    });

    it("includes orchestrator-delegation-guidance fragment for orchestrator agents", async () => {
        currentProjectContext = {};

        await buildPrompt({
            agentCategory: "orchestrator",
        });

        expect(addedFragments.some((fragment) => fragment.id === "orchestrator-delegation-guidance")).toBe(true);
    });

    it("does not include orchestrator-delegation-guidance fragment for non-orchestrator categories", async () => {
        currentProjectContext = {};

        for (const category of ["worker", "reviewer", "domain-expert", undefined] as const) {
            addedFragments.length = 0;

            await buildPrompt({
                agentCategory: category,
            });

            expect(addedFragments.some((fragment) => fragment.id === "orchestrator-delegation-guidance")).toBe(false);
        }
    });

    it("does not include delegation-tips or todo-before-delegation for domain-expert agents", async () => {
        currentProjectContext = {};

        await buildPrompt({
            agentCategory: "domain-expert",
        });

        expect(addedFragments.some((f) => f.id === "delegation-tips")).toBe(false);
        expect(addedFragments.some((f) => f.id === "todo-before-delegation")).toBe(false);
    });

    it("includes delegation-tips and todo-before-delegation for non-domain-expert agents", async () => {
        currentProjectContext = {};

        for (const category of ["worker", "orchestrator", "reviewer", undefined] as const) {
            addedFragments.length = 0;

            await buildPrompt({
                agentCategory: category,
            });

            expect(addedFragments.some((f) => f.id === "delegation-tips")).toBe(true);
            expect(addedFragments.some((f) => f.id === "todo-before-delegation")).toBe(true);
        }
    });
});
