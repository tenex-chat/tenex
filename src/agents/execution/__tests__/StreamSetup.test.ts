import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { config as configService } from "@/services/ConfigService";
import { SkillWhitelistService } from "@/services/skill";
import {
    createMockAgent,
    createMockConversationStore,
    createMockExecutionEnvironment,
    createMockInboundEnvelope,
} from "@/test-utils";
import { ToolExecutionTracker } from "../ToolExecutionTracker";
import type { FullRuntimeContext } from "../types";

const fetchSkillsMock = mock(async () => ({ skills: [], content: "", toolPermissions: {} }));
const listAvailableSkillsMock = mock(async () => []);
const createLLMServiceMock = mock(() => ({
    provider: "mock-provider",
    model: "mock-model",
}));
const compileMock = mock(async () => ({
    systemPrompt: "system",
    counts: { total: 0, systemPrompt: 0, conversation: 0 },
    messages: [],
}));
const prepareLLMRequestMock = mock(async () => ({
    messages: [],
    runtimeOverlays: [],
}));

mock.module("@/services/ConfigService", () => ({
    config: {
        isMetaModelConfig: mock(() => false),
        resolveMetaModel: mock(() => ({ isMetaModel: false })),
    },
}));

mock.module("@/services/LLMOperationsRegistry", () => ({
    llmOpsRegistry: {
        registerOperation: mock(() => new AbortController().signal),
        setMessageInjector: mock(() => undefined),
    },
}));

mock.module("@/services/ral", () => ({
    RALRegistry: {
        getInstance: () => ({
            getAndConsumeInjections: () => [],
            getConversationPendingDelegations: () => [],
            getConversationCompletedDelegations: () => [],
        }),
    },
}));

mock.module("@/services/skill", () => ({
    SkillService: {
        getInstance: () => ({
            fetchSkills: fetchSkillsMock,
            listAvailableSkills: listAvailableSkillsMock,
        }),
    },
    loadAllSkillTools: mock(async () => ({})),
}));

mock.module("@/tools/registry", () => ({
    getToolsObject: mock(() => ({})),
    HOME_FS_FALLBACKS: [],
}));

mock.module("../MessageCompiler", () => ({
    MessageCompiler: class {
        constructor() {}
        async compile() {
            return await compileMock();
        }
    },
}));

mock.module("../ToolSupervisionWrapper", () => ({
    wrapToolsWithSupervision: (tools: Record<string, unknown>) => tools,
}));

mock.module("../ToolOutputTruncation", () => ({
    FullResultStash: class {},
    wrapToolsWithOutputTruncation: (tools: Record<string, unknown>) => tools,
}));

mock.module("../context-management", () => ({
    createExecutionContextManagement: () => undefined,
}));

mock.module("../context-management/runtime", () => ({
    createExecutionContextManagement: () => undefined,
}));

mock.module("../prompt-history", () => ({
    buildPromptHistoryMessages: ({ compiled }: { compiled: { messages: unknown[] } }) => ({
        messages: compiled.messages,
        didMutateHistory: false,
    }),
    syncPreparedPromptHistoryMessages: mock(() => false),
}));

mock.module("../request-preparation", () => ({
    prepareLLMRequest: prepareLLMRequestMock,
}));

mock.module("@/llm/system-reminder-context", () => ({
    getSystemReminderContext: () => ({
        advance: mock(() => undefined),
        queue: mock(() => undefined),
        clear: mock(() => undefined),
    }),
}));

mock.module("@/types/project-ids", () => ({
    createProjectDTag: (value: string) => value,
}));

mock.module("@/utils/logger", () => ({
    logger: {
        warn: mock(() => undefined),
        info: mock(() => undefined),
        debug: mock(() => undefined),
    },
}));

mock.module("@opentelemetry/api", () => ({
    SpanStatusCode: {
        OK: 1,
        ERROR: 2,
    },
    trace: {
        getActiveSpan: () => undefined,
        getTracer: () => ({
            startActiveSpan: async (
                _name: string,
                callback: (span: {
                    addEvent: () => void;
                    setAttribute: () => void;
                    setAttributes: () => void;
                    setStatus: () => void;
                    recordException: () => void;
                    end: () => void;
                }) => Promise<unknown>
            ) =>
                await callback({
                    addEvent: () => undefined,
                    setAttribute: () => undefined,
                    setAttributes: () => undefined,
                    setStatus: () => undefined,
                    recordException: () => undefined,
                    end: () => undefined,
                }),
        }),
    },
}));

import { setupStreamExecution } from "../StreamSetup";

type MockedConfigService = {
    isMetaModelConfig: ReturnType<typeof mock>;
    resolveMetaModel: ReturnType<typeof mock>;
};

function createTestContext(
    overrides: {
        blockedSkills?: string[];
        llmConfig?: string;
        skillEventIds?: string[];
        variantOverride?: string;
        conversationStoreOverrides?: Record<string, unknown>;
    } = {}
): FullRuntimeContext {
    const conversationStore = Object.assign(
        createMockConversationStore({ id: "conversation-1" }),
        {
            id: "conversation-1",
            getId: mock(() => "conversation-1"),
            ensureRalActive: mock(() => undefined),
            getSelfAppliedSkillIds: mock(() => []),
            getContextManagementReminderState: mock(() => null),
            getMetaModelVariantOverride: mock(() => undefined),
            setMetaModelVariantOverride: mock(() => undefined),
            clearMetaModelVariantOverride: mock(() => undefined),
            getFirstUserMessage: mock(() => undefined),
            isAgentPromptHistoryCacheAnchored: mock(() => false),
            save: mock(async () => undefined),
        },
        overrides.conversationStoreOverrides ?? {}
    );

    const agent = createMockAgent({
        pubkey: "agent-pubkey",
        slug: "agent-slug",
        llmConfig: overrides.llmConfig ?? "test-model",
        alwaysSkills: [],
        blockedSkills: overrides.blockedSkills ?? [],
        mcpAccess: [],
        tools: [],
        createLLMService: createLLMServiceMock,
    });

    const triggeringEnvelope = createMockInboundEnvelope({
        metadata: {
            skillEventIds: overrides.skillEventIds ?? [],
            variantOverride: overrides.variantOverride,
        },
        principal: {
            id: "user",
            linkedPubkey: "user",
            kind: "human",
            transport: "nostr",
        },
    });

    return {
        ...createMockExecutionEnvironment({
            agent,
            conversationId: "conversation-1",
            triggeringEnvelope,
            conversationStore,
            getConversation: () => conversationStore,
            projectBasePath: "/tmp/project",
            workingDirectory: "/tmp/project",
            currentBranch: "main",
        }),
        agent,
        conversationStore,
        triggeringEnvelope,
        getConversation: () => conversationStore,
    };
}

describe("StreamSetup", () => {
    const whitelistService = SkillWhitelistService.getInstance();
    const mockedConfigService = configService as unknown as MockedConfigService;

    beforeEach(() => {
        whitelistService.setInstalledSkills([]);
        fetchSkillsMock.mockClear();
        listAvailableSkillsMock.mockClear();
        createLLMServiceMock.mockClear();
        compileMock.mockClear();
        prepareLLMRequestMock.mockClear();
        mockedConfigService.isMetaModelConfig.mockReset();
        mockedConfigService.isMetaModelConfig.mockReturnValue(false);
        mockedConfigService.resolveMetaModel.mockReset();
        mockedConfigService.resolveMetaModel.mockReturnValue({ isMetaModel: false });
    });

    afterEach(() => {
        whitelistService.setInstalledSkills([]);
    });

    afterAll(() => {
        mock.restore();
    });

    it("filters blocked skills before fetchSkills is called", async () => {
        listAvailableSkillsMock.mockResolvedValue([
            {
                identifier: "local-skill",
                eventId: "a".repeat(64),
                content: "",
                installedFiles: [],
            },
        ]);

        const context = createTestContext({
            blockedSkills: ["a".repeat(64)],
            skillEventIds: ["local-skill"],
        });
        const toolTracker = new ToolExecutionTracker();

        const result = await setupStreamExecution(
            context,
            toolTracker,
            1,
            { warmSenderPubkeys: mock(() => undefined) }
        );

        expect(fetchSkillsMock).not.toHaveBeenCalled();
        expect(result.request.runtimeOverlays).toEqual([]);
        expect(result.llmService.provider).toBe("mock-provider");
        expect(result.skillToolPermissions).toEqual({});
    });

    it("applies delegation variant overrides before meta-model resolution", async () => {
        mockedConfigService.isMetaModelConfig.mockReturnValue(true);
        mockedConfigService.resolveMetaModel.mockReturnValue({
            isMetaModel: true,
            configName: "deep-model",
            metaModelSystemPrompt: "meta-system",
            variantSystemPrompt: "variant-system",
        });

        const setMetaModelVariantOverride = mock(() => undefined);
        const clearMetaModelVariantOverride = mock(() => undefined);
        const getMetaModelVariantOverride = mock(() => undefined);

        const context = createTestContext({
            llmConfig: "meta-config",
            variantOverride: "deep",
            conversationStoreOverrides: {
                getMetaModelVariantOverride,
                setMetaModelVariantOverride,
                clearMetaModelVariantOverride,
            },
        });
        const toolTracker = new ToolExecutionTracker();

        await setupStreamExecution(
            context,
            toolTracker,
            1,
            { warmSenderPubkeys: mock(() => undefined) }
        );

        expect(setMetaModelVariantOverride).toHaveBeenCalledWith("agent-pubkey", "deep");
        expect(mockedConfigService.resolveMetaModel).toHaveBeenCalledWith(
            "meta-config",
            undefined,
            "deep"
        );
        expect(clearMetaModelVariantOverride).not.toHaveBeenCalled();
    });
});
