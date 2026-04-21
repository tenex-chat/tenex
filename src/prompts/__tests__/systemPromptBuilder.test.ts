import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import { SchedulerService } from "@/services/scheduling";
import { RAGService } from "@/services/rag/RAGService";
import { projectContextStore } from "@/services/projects";
import * as transportModule from "@/services/ingress/TransportBindingStoreService";
import * as identityModule from "@/services/identity";
import * as telegramChatContextModule from "@/services/telegram/TelegramChatContextStoreService";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";

mock.module("@/utils/logger", () => ({
    logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
    },
}));

const addedFragments: Array<{ id: string; args: any }> = [];
let currentProjectContext: any;

/** Run buildSystemPromptMessages inside the current test's project context */
async function build(
    opts: Parameters<typeof buildSystemPromptMessages>[0]
): Promise<ReturnType<typeof buildSystemPromptMessages>> {
    return projectContextStore.run(currentProjectContext, () =>
        buildSystemPromptMessages(opts)
    );
}

describe("systemPromptBuilder", () => {
    let agent: AgentInstance;
    let project: NDKProject;
    let conversation: any;

    beforeEach(() => {
        spyOn(transportModule, "getTransportBindingStore").mockReturnValue({
            listBindingsForAgentProject: () => [],
        } as any);
        spyOn(identityModule, "getIdentityBindingStore").mockReturnValue({
            getBinding: () => undefined,
        } as any);
        spyOn(telegramChatContextModule, "getTelegramChatContextStore").mockReturnValue({
            getContext: () => undefined,
        } as any);
        spyOn(SchedulerService, "getInstance").mockReturnValue({
            getTasks: async () => [],
        } as any);
        spyOn(RAGService, "getInstance").mockReturnValue({
            getCachedAllCollectionStats: async () => [],
        } as any);
        spyOn(PromptBuilder.prototype, "add").mockImplementation(function (
            this: PromptBuilder,
            id: string,
            args: any
        ) {
            addedFragments.push({ id, args });
            return this;
        });
        spyOn(PromptBuilder.prototype, "build").mockResolvedValue("mock-built-prompt");
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

        await build({
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

        await build({
            agent,
            project,
            conversation,
        });

        const agentIdentityFragment = addedFragments.find(
            (fragment) => fragment.id === "agent-identity"
        );

        expect(agentIdentityFragment?.args.agent.instructions).toBe("Base instructions");
    });

    it("does not add cross-project fragments to the main prompt", async () => {
        currentProjectContext = {};

        await build({
            agent,
            project,
            conversation,
        });

        expect(addedFragments.some((fragment) => fragment.id === "meta-project-context")).toBe(false);
    });

    it("only adds no-response guidance for Telegram-triggered turns", async () => {
        currentProjectContext = {};

        await build({
            agent,
            project,
            conversation,
        });

        expect(addedFragments.some((fragment) => fragment.id === "no-response-guidance")).toBe(false);

        addedFragments.length = 0;

        await build({
            agent,
            project,
            conversation,
            triggeringEnvelope: {
                transport: "telegram",
            } as any,
        });

        expect(addedFragments.some((fragment) => fragment.id === "no-response-guidance")).toBe(true);
    });

    it("includes domain-expert-guidance fragment for domain-expert agents", async () => {
        currentProjectContext = {};

        await build({
            agent,
            project,
            conversation,
            agentCategory: "domain-expert",
        });

        expect(addedFragments.some((fragment) => fragment.id === "domain-expert-guidance")).toBe(true);
    });

    it("does not include domain-expert-guidance fragment for non-domain-expert categories", async () => {
        currentProjectContext = {};

        for (const category of ["orchestrator", "worker"] as const) {
            addedFragments.length = 0;

            await build({
                agent,
                project,
                conversation,
                agentCategory: category,
            });

            expect(addedFragments.some((fragment) => fragment.id === "domain-expert-guidance")).toBe(false);
        }
    });

    it("does not include domain-expert-guidance fragment when agentCategory is undefined", async () => {
        currentProjectContext = {};

        await build({
            agent,
            project,
            conversation,
        });

        expect(addedFragments.some((fragment) => fragment.id === "domain-expert-guidance")).toBe(false);
    });

    it("includes orchestrator-delegation-guidance fragment for orchestrator agents", async () => {
        currentProjectContext = {};

        await build({
            agent,
            project,
            conversation,
            agentCategory: "orchestrator",
        });

        expect(addedFragments.some((fragment) => fragment.id === "orchestrator-delegation-guidance")).toBe(true);
    });

    it("does not include orchestrator-delegation-guidance fragment for non-orchestrator categories", async () => {
        currentProjectContext = {};

        for (const category of ["worker", "reviewer", "domain-expert", undefined] as const) {
            addedFragments.length = 0;

            await build({
                agent,
                project,
                conversation,
                agentCategory: category,
            });

            expect(addedFragments.some((fragment) => fragment.id === "orchestrator-delegation-guidance")).toBe(false);
        }
    });

    it("does not include delegation-tips or todo-before-delegation for non-delegation-initiating agents", async () => {
        currentProjectContext = {};

        for (const category of ["worker", "domain-expert"] as const) {
            addedFragments.length = 0;

            await build({
                agent,
                project,
                conversation,
                agentCategory: category,
            });

            expect(addedFragments.some((f) => f.id === "delegation-tips")).toBe(false);
            expect(addedFragments.some((f) => f.id === "todo-before-delegation")).toBe(false);
        }
    });

    it("includes delegation-tips and todo-before-delegation for delegating agents", async () => {
        currentProjectContext = {};

        for (const category of ["orchestrator", "reviewer", undefined] as const) {
            addedFragments.length = 0;

            await build({
                agent,
                project,
                conversation,
                agentCategory: category,
            });

            expect(addedFragments.some((f) => f.id === "delegation-tips")).toBe(true);
            expect(addedFragments.some((f) => f.id === "todo-before-delegation")).toBe(true);
        }
    });
});
