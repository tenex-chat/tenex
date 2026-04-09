import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import { config as configService } from "@/services/ConfigService";
import { RALRegistry } from "@/services/ral";
import { SkillIdentifierResolver } from "@/services/skill";
import { createSelfDelegateTool } from "@/tools/implementations/self_delegate";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";

const metaConfig = {
    provider: "meta",
    default: "fast",
    variants: {
        fast: {
            model: "fast-model",
            description: "Fast variant",
        },
        deep: {
            model: "deep-model",
            description: "Deep variant",
        },
    },
} as const;

describe("self_delegate tool", () => {
    const conversationId = "self-delegate-conversation";
    const projectId = "31933:pubkey:test-project";
    let registry: RALRegistry;

    beforeEach(() => {
        // @ts-expect-error - resetting singleton for test isolation
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();
    });

    afterEach(() => {
        mock.restore();
    });

    function createContext(overrides?: {
        llmConfig?: string;
        skillEventIds?: string[];
        todos?: unknown[];
        agentPublisher?: {
            delegate?: ReturnType<typeof mock>;
        };
    }) {
        const agentPubkey = "self-agent-pubkey";
        const ralNumber = registry.create(agentPubkey, conversationId, projectId);
        const addDelegationMarker = mock(() => undefined);
        const save = mock(async () => undefined);
        const delegate = overrides?.agentPublisher?.delegate ?? mock(async () => "delegation-event-id-1234567890");

        const context = {
            agent: {
                slug: "self-agent",
                name: "Self Agent",
                pubkey: agentPubkey,
                llmConfig: overrides?.llmConfig ?? "default",
            } as AgentInstance,
            conversationId,
            triggeringEnvelope: createMockInboundEnvelope({
                metadata: {
                    skillEventIds: overrides?.skillEventIds ?? [],
                },
            }),
            agentPublisher: {
                delegate,
            } as any,
            ralNumber,
            projectBasePath: "/tmp/project",
            workingDirectory: "/tmp/project",
            currentBranch: "main",
            getConversation: () => ({
                getRootEventId: () => conversationId,
                getAllMessages: () => [],
                getTodos: () => overrides?.todos ?? [{ id: "todo-1" }],
                addDelegationMarker,
                save,
            }),
        } as any;

        return {
            context,
            addDelegationMarker,
            save,
            delegate,
        };
    }

    it("includes the model field in the schema for meta-model agents", () => {
        spyOn(configService, "getRawLLMConfig").mockReturnValue(metaConfig as any);
        const { context } = createContext({ llmConfig: "meta-config" });

        const tool = createSelfDelegateTool(context);
        const schemaShape = (tool.inputSchema as any).shape;

        expect(schemaShape.model).toBeDefined();
    });

    it("omits the model field in the schema for non-meta agents", () => {
        spyOn(configService, "getRawLLMConfig").mockReturnValue({
            provider: "openai",
            model: "gpt-5",
        } as any);
        const { context } = createContext();

        const tool = createSelfDelegateTool(context);
        const schemaShape = (tool.inputSchema as any).shape;

        expect(schemaShape.model).toBeUndefined();
    });

    it("self-delegates to the current agent and forwards variant and skills", async () => {
        spyOn(configService, "getRawLLMConfig").mockReturnValue(metaConfig as any);
        const resolveSkillIdentifier = mock((identifier: string) =>
            identifier === "be-brief" ? "resolved-skill-id" : null
        );
        spyOn(SkillIdentifierResolver, "getInstance").mockReturnValue({
            resolveSkillIdentifier,
        } as any);

        const { context, delegate, addDelegationMarker, save } = createContext({
            llmConfig: "meta-config",
            skillEventIds: ["inherited-skill-id"],
        });
        const tool = createSelfDelegateTool(context);

        const result = await tool.execute({
            prompt: "Continue the task with fresh context",
            model: "deep",
            skills: ["be-brief"],
        });

        expect(result.success).toBe(true);
        expect(result.selectedVariant).toBe("deep");
        expect(delegate).toHaveBeenCalledTimes(1);
        expect(delegate.mock.calls[0][0]).toEqual({
            recipient: "self-agent-pubkey",
            content: "Continue the task with fresh context",
            variant: "deep",
            skills: ["inherited-skill-id", "resolved-skill-id"],
        });
        expect(addDelegationMarker).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledTimes(1);
    });

    it("returns a validation error and does not publish for an unknown variant", async () => {
        spyOn(configService, "getRawLLMConfig").mockReturnValue(metaConfig as any);
        const { context, delegate } = createContext({ llmConfig: "meta-config" });
        const tool = createSelfDelegateTool(context);

        const result = await tool.execute({
            prompt: "Retry with a better model",
            model: "unknown",
        });

        expect(result).toEqual({
            success: false,
            message: 'Unknown variant "unknown". Available variants: fast, deep',
            selectedVariant: "unknown",
        });
        expect(delegate).not.toHaveBeenCalled();
    });
});
