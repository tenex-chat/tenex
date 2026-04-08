import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { SkillWhitelistService } from "@/services/skill";

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

mock.module("@/services/projects", () => ({
    getProjectContext: mock(() => ({
        project: {
            dTag: "project-1",
            tagValue: mock((name: string) => (name === "d" ? "project-1" : undefined)),
        },
        projectOwnerPubkey: "f".repeat(64),
        mcpManager: undefined,
        agents: new Map(),
    })),
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
    trace: {
        getActiveSpan: () => undefined,
    },
}));

import { setupStreamExecution } from "../StreamSetup";

describe("StreamSetup", () => {
    const whitelistService = SkillWhitelistService.getInstance();

    beforeEach(() => {
        whitelistService.setInstalledSkills([]);
        fetchSkillsMock.mockClear();
        listAvailableSkillsMock.mockClear();
        createLLMServiceMock.mockClear();
        compileMock.mockClear();
        prepareLLMRequestMock.mockClear();
    });

    afterEach(() => {
        whitelistService.setInstalledSkills([]);
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

        const context = {
            agent: {
                pubkey: "agent-pubkey",
                slug: "agent-slug",
                alwaysSkills: [],
                blockedSkills: ["a".repeat(64)],
                mcpAccess: [],
                tools: [],
                llmConfig: "test-model",
                createLLMService: createLLMServiceMock,
            },
            triggeringEnvelope: {
                metadata: {
                    skillEventIds: ["local-skill"],
                },
                principal: {
                    id: "user",
                    linkedPubkey: "user",
                    kind: "human",
                },
            },
            conversationStore: {
                id: "conversation-1",
                getId: mock(() => "conversation-1"),
                ensureRalActive: mock(() => undefined),
                getSelfAppliedSkillIds: mock(() => []),
                getContextManagementReminderState: mock(() => null),
                save: mock(async () => undefined),
            },
            conversationId: "conversation-1",
            projectBasePath: "/tmp/project",
            workingDirectory: "/tmp/project",
            currentBranch: "main",
            getConversation() {
                return this.conversationStore;
            },
        } as any;

        const toolTracker = {
            setFullResultStash: mock(() => undefined),
        } as any;

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
});
