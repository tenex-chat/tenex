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
    mcpManager: undefined,
}));
const registerOperationMock = mock(() => new AbortController().signal);
const getToolsObjectMock = mock(() => ({}));
const createExecutionContextManagementMock = mock(() => ({
    optionalTools: {},
    scratchpadAvailable: true,
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
const compileMock = mock(async () => ({
    systemPrompt: "SYSTEM_PROMPT",
    counts: {
        total: 0,
        systemPrompt: 0,
        conversation: 0,
    },
}));
const systemReminderContext = {
    advance: mock(() => undefined),
    clear: mock(() => undefined),
    queue: mock(() => undefined),
};

const messageCompilerModulePath = new URL("../MessageCompiler.ts", import.meta.url).pathname;
const contextManagementModulePath = new URL("../context-management.ts", import.meta.url).pathname;
const promptHistoryModulePath = new URL("../prompt-history.ts", import.meta.url).pathname;
const requestPreparationModulePath = new URL("../request-preparation.ts", import.meta.url).pathname;
const supervisionWrapperModulePath = new URL("../ToolSupervisionWrapper.ts", import.meta.url).pathname;
const outputTruncationModulePath = new URL("../ToolOutputTruncation.ts", import.meta.url).pathname;

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

mock.module("@/services/LLMOperationsRegistry", () => ({
    llmOpsRegistry: {
        registerOperation: registerOperationMock,
    },
}));

mock.module("@/services/ConfigService", () => ({
    config: {
        isMetaModelConfig: () => false,
    },
}));

mock.module("@/tools/registry", () => ({
    getToolsObject: getToolsObjectMock,
    HOME_FS_FALLBACKS: [],
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

mock.module("@/llm/system-reminder-context", () => ({
    getSystemReminderContext: () => systemReminderContext,
}));

mock.module(messageCompilerModulePath, () => ({
    MessageCompiler: class {
        constructor(_conversationStore: unknown) {}

        async compile(input: unknown) {
            return compileMock(input as never);
        }
    },
}));

mock.module(contextManagementModulePath, () => ({
    createExecutionContextManagement: createExecutionContextManagementMock,
}));

mock.module(promptHistoryModulePath, () => ({
    buildPromptHistoryMessages: buildPromptHistoryMessagesMock,
}));

mock.module(requestPreparationModulePath, () => ({
    prepareLLMRequest: prepareLLMRequestMock,
}));

mock.module(supervisionWrapperModulePath, () => ({
    wrapToolsWithSupervision: (tools: Record<string, unknown>) => tools,
}));

mock.module(outputTruncationModulePath, () => ({
    FullResultStash: class {
        clear() {}
        consume() { return undefined; }
        stash() {}
    },
    wrapToolsWithOutputTruncation: (tools: Record<string, unknown>) => tools,
}));

let setupStreamExecution: typeof import("../StreamSetup").setupStreamExecution;
let conversationStore: ReturnType<typeof createConversationStoreStub>;

describe("StreamSetup blocked skills", () => {
    const whitelistService = SkillWhitelistService.getInstance();
    let warnSpy: ReturnType<typeof spyOn>;

    beforeAll(async () => {
        ({ setupStreamExecution } = await import("../StreamSetup"));
    });

    beforeEach(() => {
        conversationStore = createConversationStoreStub();
        whitelistService.setInstalledSkills([]);
        listAvailableSkillsMock.mockClear();
        fetchSkillsMock.mockClear();
        loadAllSkillToolsMock.mockClear();
        getProjectContextMock.mockClear();
        registerOperationMock.mockClear();
        getToolsObjectMock.mockClear();
        createExecutionContextManagementMock.mockClear();
        buildPromptHistoryMessagesMock.mockClear();
        prepareLLMRequestMock.mockClear();
        compileMock.mockClear();
        systemReminderContext.advance.mockClear();
        systemReminderContext.clear.mockClear();
        systemReminderContext.queue.mockClear();
        warnSpy = spyOn(logger, "warn");
        spyOn(whitelistService, "getWhitelistedSkills").mockReturnValue([]);
    });

    afterEach(() => {
        warnSpy?.mockRestore();
        mock.restore();
    });

    it("filters blocked delegation skills before fetchSkills", async () => {
        const context = createRuntimeContext({
            blockedSkills: ["blocked-skill"],
            triggeringSkillEventIds: ["blocked-skill", "allowed-skill"],
        });

        await setupStreamExecution(context, createToolTrackerStub(), 1, createInjectionProcessorStub());

        expect(fetchSkillsMock).toHaveBeenCalledWith(["allowed-skill"], expect.any(Object));
        expect(warnSpy).toHaveBeenCalledWith(
            "[StreamSetup] Blocked skills filtered from request",
            expect.objectContaining({
                agent: "test-agent",
                blockedSkills: ["blocked-skill"],
            })
        );
    });

    it("filters blocked self-applied skills before fetchSkills", async () => {
        const context = createRuntimeContext({
            blockedSkills: ["blocked-skill"],
            selfAppliedSkillIds: ["blocked-skill", "allowed-skill"],
        });

        await setupStreamExecution(context, createToolTrackerStub(), 1, createInjectionProcessorStub());

        expect(fetchSkillsMock).toHaveBeenCalledWith(["allowed-skill"], expect.any(Object));
    });

    it("filters blocked local ids even when delegation passes an event id alias", async () => {
        spyOn(whitelistService, "getWhitelistedSkills").mockReturnValue([
            {
                eventId: "a".repeat(64),
                identifier: "local-skill",
                shortId: "local-short",
                kind: 4202 as never,
                name: "Local Skill",
                description: "Local skill",
                whitelistedBy: ["pubkey"],
            } as never,
        ]);

        const context = createRuntimeContext({
            blockedSkills: ["local-skill"],
            triggeringSkillEventIds: ["a".repeat(64)],
        });

        await setupStreamExecution(context, createToolTrackerStub(), 1, createInjectionProcessorStub());

        expect(fetchSkillsMock).not.toHaveBeenCalled();
    });

    it("allows non-blocked skills through", async () => {
        const context = createRuntimeContext({
            blockedSkills: ["blocked-skill"],
            triggeringSkillEventIds: ["allowed-skill"],
        });

        await setupStreamExecution(context, createToolTrackerStub(), 1, createInjectionProcessorStub());

        expect(fetchSkillsMock).toHaveBeenCalledWith(["allowed-skill"], expect.any(Object));
        expect(warnSpy).not.toHaveBeenCalled();
    });
});

function createConversationStoreStub() {
    const store = {
        ensureRalActive: mock(() => undefined),
        getSelfAppliedSkillIds: mock(() => [] as string[]),
        getMetaModelVariantOverride: mock(() => undefined as string | undefined),
        getContextManagementReminderState: mock(() => undefined),
        save: mock(async () => undefined),
        addMessage: mock(() => undefined),
        relocateToEnd: mock(() => false),
    };

    return store;
}

function createToolTrackerStub() {
    return {
        setFullResultStash: mock(() => undefined),
    };
}

function createInjectionProcessorStub() {
    return {
        warmSenderPubkeys: mock(() => undefined),
    };
}

function createRuntimeContext(overrides: {
    blockedSkills?: string[];
    triggeringSkillEventIds?: string[];
    selfAppliedSkillIds?: string[];
}) {
    const llmService = {
        provider: "mock-provider",
        model: "mock-model",
        updateUsageFromSteps: mock(() => undefined),
        createLanguageModelFromRegistry: mock(() => ({} as never)),
    };

    const agent = {
        name: "TestAgent",
        slug: "test-agent",
        pubkey: "agent-pubkey",
        tools: [],
        llmConfig: "mock-config",
        alwaysSkills: [],
        blockedSkills: overrides.blockedSkills,
        mcpAccess: [],
        createLLMService: mock(() => llmService),
    };

    conversationStore.getSelfAppliedSkillIds.mockReturnValue(overrides.selfAppliedSkillIds ?? []);

    return {
        agent,
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
                skillEventIds: overrides.triggeringSkillEventIds ?? [],
            },
        },
        conversationStore,
        getConversation: () => conversationStore as never,
        cachedSystemPrompt: undefined,
    } as never;
}
