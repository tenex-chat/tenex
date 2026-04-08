import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { SkillWhitelistService } from "@/services/skill";
import { logger } from "@/utils/logger";

const fetchSkillsMock = mock(async (skillIds: string[]) => ({
    skills: skillIds.map((identifier) => ({
        identifier,
        content: "",
        installedFiles: [],
    })),
    content: "",
    toolPermissions: {},
}));
const listAvailableSkillsMock = mock(async () => []);
const loadAllSkillToolsMock = mock(() => ({}));
const getProjectContextMock = mock(() => ({
    project: {
        dTag: "project-1",
        tagValue: (name: string) => (name === "d" ? "project-1" : undefined),
    },
    agents: new Map(),
}));
const buildPromptHistoryMessagesMock = mock(() => ({
    messages: [],
    didMutateHistory: false,
}));
const prepareLLMRequestMock = mock(async () => ({
    messages: [],
    runtimeOverlays: [],
    reportContextManagementUsage: undefined,
}));
const messageSyncerSpy = mock(() => undefined);
const systemReminderContext = {
    advance: mock(() => undefined),
    clear: mock(() => undefined),
    queue: mock(() => undefined),
};
const configMock = {
    isMetaModelConfig: mock(() => false),
};
const messageSyncerModulePath = new URL("../MessageSyncer.ts", import.meta.url).pathname;
const promptHistoryModulePath = new URL("../prompt-history.ts", import.meta.url).pathname;
const requestPreparationModulePath = new URL("../request-preparation.ts", import.meta.url).pathname;

mock.module("@/services/skill", () => ({
    SkillService: {
        getInstance: () => ({
            listAvailableSkills: listAvailableSkillsMock,
            fetchSkills: fetchSkillsMock,
        }),
    },
    loadAllSkillTools: loadAllSkillToolsMock,
}));

mock.module("@/services/projects", () => ({
    getProjectContext: getProjectContextMock,
}));

mock.module("@/services/ConfigService", () => ({
    config: configMock,
}));

mock.module("@/services/ral", () => ({
    RALRegistry: {
        getInstance: () => ({
            getAndConsumeInjections: () => [],
            getAndConsumeHeuristicViolations: () => [],
            getConversationPendingDelegations: () => [],
            getConversationCompletedDelegations: () => [],
        }),
    },
}));

mock.module("@/llm/system-reminder-context", () => ({
    getSystemReminderContext: () => systemReminderContext,
}));

mock.module("@/tools/registry", () => ({
    HOME_FS_FALLBACKS: [],
}));

mock.module(messageSyncerModulePath, () => ({
    MessageSyncer: class {
        constructor(_conversationStore: unknown, _agentPubkey: string, _ralNumber: number) {}

        syncFromSDK(_messages: unknown) {
            messageSyncerSpy();
        }
    },
}));

mock.module(promptHistoryModulePath, () => ({
    buildPromptHistoryMessages: buildPromptHistoryMessagesMock,
}));

mock.module(requestPreparationModulePath, () => ({
    prepareLLMRequest: prepareLLMRequestMock,
}));

let createPrepareStep: typeof import("../StreamCallbacks").createPrepareStep;
let conversationStore: ReturnType<typeof createConversationStoreStub>;

describe("StreamCallbacks blocked skills", () => {
    const whitelistService = SkillWhitelistService.getInstance();
    let warnSpy: ReturnType<typeof spyOn>;

    beforeAll(async () => {
        ({ createPrepareStep } = await import("../StreamCallbacks"));
    });

    beforeEach(() => {
        conversationStore = createConversationStoreStub();
        listAvailableSkillsMock.mockClear();
        fetchSkillsMock.mockClear();
        loadAllSkillToolsMock.mockClear();
        getProjectContextMock.mockClear();
        buildPromptHistoryMessagesMock.mockClear();
        prepareLLMRequestMock.mockClear();
        messageSyncerSpy.mockClear();
        systemReminderContext.advance.mockClear();
        systemReminderContext.clear.mockClear();
        systemReminderContext.queue.mockClear();
        configMock.isMetaModelConfig.mockClear();
        warnSpy = spyOn(logger, "warn");
        spyOn(whitelistService, "getWhitelistedSkills").mockReturnValue([]);
    });

    afterEach(() => {
        warnSpy?.mockRestore();
        mock.restore();
    });

    it("filters blocked skills during rehydration and warns with the step number", async () => {
        const callback = createPrepareStep({
            context: createRuntimeContext({
                blockedSkills: ["blocked-skill"],
                delegationSkillIds: ["blocked-skill", "allowed-skill"],
            }),
            llmService: createLlmServiceStub(),
            messageCompiler: createMessageCompilerStub(),
            toolsObject: {},
            initialRequest: createInitialRequest(),
            skillToolPermissions: {},
            ralNumber: 1,
            execContext: createExecutionContextStub(),
            modelState: createModelStateStub(),
        });

        await callback({
            messages: [],
            stepNumber: 2,
            steps: [],
        });

        expect(fetchSkillsMock).toHaveBeenCalledWith(["allowed-skill"], expect.any(Object));
        expect(warnSpy).toHaveBeenCalledWith(
            "[StreamCallbacks] Blocked skills filtered during step rehydration",
            expect.objectContaining({
                agent: "test-agent",
                blockedSkills: ["blocked-skill"],
                step: 2,
            })
        );
    });

    it("passes through rehydrated skills when none are blocked", async () => {
        const callback = createPrepareStep({
            context: createRuntimeContext({
                delegationSkillIds: ["allowed-skill"],
            }),
            llmService: createLlmServiceStub(),
            messageCompiler: createMessageCompilerStub(),
            toolsObject: {},
            initialRequest: createInitialRequest(),
            skillToolPermissions: {},
            ralNumber: 1,
            execContext: createExecutionContextStub(),
            modelState: createModelStateStub(),
        });

        await callback({
            messages: [],
            stepNumber: 2,
            steps: [],
        });

        expect(fetchSkillsMock).toHaveBeenCalledWith(["allowed-skill"], expect.any(Object));
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it("blocks a local alias before skill fetch during rehydration", async () => {
        listAvailableSkillsMock.mockResolvedValue([
            {
                identifier: "local-skill",
                eventId: "blocked-event-id",
                content: "",
                installedFiles: [],
            },
        ]);

        const callback = createPrepareStep({
            context: createRuntimeContext({
                blockedSkills: ["blocked-event-id"],
                delegationSkillIds: ["local-skill"],
            }),
            llmService: createLlmServiceStub(),
            messageCompiler: createMessageCompilerStub(),
            toolsObject: {},
            initialRequest: createInitialRequest(),
            skillToolPermissions: {},
            ralNumber: 1,
            execContext: createExecutionContextStub(),
            modelState: createModelStateStub(),
        });

        await callback({
            messages: [],
            stepNumber: 2,
            steps: [],
        });

        expect(fetchSkillsMock).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
            "[StreamCallbacks] Blocked skills filtered during step rehydration",
            expect.objectContaining({
                agent: "test-agent",
                blockedSkills: ["local-skill"],
                step: 2,
            })
        );
    });
});

function createConversationStoreStub() {
    return {
        getSelfAppliedSkillIds: mock(() => [] as string[]),
        getMetaModelVariantOverride: mock(() => undefined as string | undefined),
        getContextManagementReminderState: mock(() => undefined),
        save: mock(async () => undefined),
    };
}

function createRuntimeContext(overrides: {
    blockedSkills?: string[];
    delegationSkillIds?: string[];
}) {
    const llmService = createLlmServiceStub();

    conversationStore.getSelfAppliedSkillIds.mockReturnValue([]);

    return {
        agent: {
            name: "TestAgent",
            slug: "test-agent",
            pubkey: "agent-pubkey",
            tools: [],
            llmConfig: "mock-config",
            alwaysSkills: [],
            blockedSkills: overrides.blockedSkills,
            mcpAccess: [],
            createLLMService: mock(() => llmService),
        },
        conversationId: "conversation-1",
        projectBasePath: "/tmp/project",
        workingDirectory: "/tmp/project",
        currentBranch: "main",
        triggeringEnvelope: {
            principal: {
                id: "user-principal",
                linkedPubkey: "user-pubkey",
            },
            metadata: {
                skillEventIds: overrides.delegationSkillIds ?? [],
            },
        },
        conversationStore,
        getConversation: () => conversationStore as never,
    } as never;
}

function createLlmServiceStub() {
    return {
        provider: "mock-provider",
        model: "mock-model",
        updateUsageFromSteps: mock(() => undefined),
        createLanguageModelFromRegistry: mock(() => ({} as never)),
    };
}

function createMessageCompilerStub() {
    return {
        compile: mock(async () => ({
            systemPrompt: "SYSTEM_PROMPT",
            counts: {
                total: 0,
                systemPrompt: 0,
                conversation: 0,
            },
        })),
    };
}

function createInitialRequest() {
    return {
        messages: [],
        providerOptions: {},
        experimentalContext: undefined,
        toolChoice: "auto",
        analysisRequestSeed: undefined,
        reportContextManagementUsage: undefined,
        runtimeOverlays: [],
    } as never;
}

function createExecutionContextStub() {
    return {
        accumulatedMessages: [],
        pendingContextManagementUsageReporter: undefined,
    } as never;
}

function createModelStateStub() {
    return {
        lastUsedVariant: undefined,
        currentModel: undefined,
        setVariant: mock(() => undefined),
        setModel: mock(() => undefined),
    } as never;
}
