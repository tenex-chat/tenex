import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { FullRuntimeContext } from "../types";
import { RALRegistry } from "@/services/ral";
import { projectContextStore } from "@/services/projects/ProjectContextStore";
import * as systemReminderContextModule from "@/llm/system-reminder-context";
import * as toolsRegistryModule from "@/tools/registry";

const checkPreToolMock = mock(async () => ({ hasViolation: false }));
const markHeuristicEnforcedMock = mock(() => undefined);
const buildSystemPromptMessagesMock = mock(async () => [
    { message: { content: "system prompt" } },
]);
const getToolsObjectMock = mock(() => ({}));
const queueSystemReminderMock = mock(() => undefined);
const getRalMock = mock(() => undefined);
const executeToolMock = mock(async () => "executed");

mock.module("@/agents/supervision", () => ({
    supervisorOrchestrator: {
        checkPreTool: checkPreToolMock,
        markHeuristicEnforced: markHeuristicEnforcedMock,
    },
}));

mock.module("@/prompts/utils/systemPromptBuilder", () => ({
    buildSystemPromptMessages: buildSystemPromptMessagesMock,
}));

const testProjectContext = {
    project: {
        tagValue: () => "project-1",
    },
    agents: new Map(),
    getProjectAgentRuntimeInfo: () => [],
} as any;

mock.module("@/utils/logger", () => ({
    logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        warning: () => undefined,
        error: () => undefined,
        success: () => undefined,
        isLevelEnabled: () => false,
        initDaemonLogging: async () => undefined,
        writeToWarnLog: () => undefined,
    },
}));

let wrapToolsWithSupervision: typeof import("../ToolSupervisionWrapper").wrapToolsWithSupervision;

describe("ToolSupervisionWrapper", () => {
    beforeAll(async () => {
        ({ wrapToolsWithSupervision } = await import("../ToolSupervisionWrapper"));
    });

    beforeEach(() => {
        spyOn(toolsRegistryModule, "getToolsObject").mockReturnValue({} as any);
        spyOn(systemReminderContextModule, "getSystemReminderContext").mockReturnValue({
            advance: () => undefined,
            queue: queueSystemReminderMock,
            collect: async () => [],
            clear: () => undefined,
        } as ReturnType<typeof systemReminderContextModule.getSystemReminderContext>);
        spyOn(RALRegistry, "getInstance").mockReturnValue({
            getRAL: getRalMock,
        } as any);
        checkPreToolMock.mockReset();
        checkPreToolMock.mockResolvedValue({ hasViolation: false });
        markHeuristicEnforcedMock.mockClear();
        buildSystemPromptMessagesMock.mockClear();
        getToolsObjectMock.mockClear();
        queueSystemReminderMock.mockClear();
        getRalMock.mockClear();
        executeToolMock.mockClear();
    });

    afterEach(() => {
        mock.restore();
    });

    it("passes agent category and current todos into pre-tool supervision", async () => {
        const wrappedTools = wrapToolsWithSupervision(createTools(), createContext({
            todos: [
                {
                    id: "todo-1",
                    title: "Inspect files",
                    status: "pending",
                },
            ],
        }));

        await projectContextStore.run(testProjectContext, () =>
            wrappedTools.fs_read.execute?.(
                { path: "README.md" },
                { toolCallId: "call-1" } as never
            )
        );

        expect(checkPreToolMock).toHaveBeenCalledTimes(1);
        expect(checkPreToolMock.mock.calls[0][0]).toMatchObject({
            agentCategory: "worker",
            agentSlug: "test-worker",
            agentPubkey: "worker-pubkey",
            toolName: "fs_read",
            todos: [
                {
                    id: "todo-1",
                    title: "Inspect files",
                    status: "pending",
                },
            ],
        });
        expect(executeToolMock).toHaveBeenCalledTimes(1);
    });

    it("blocks the underlying tool and queues the correction when supervision returns a violation", async () => {
        checkPreToolMock.mockResolvedValueOnce({
            hasViolation: true,
            heuristicId: "worker-todo-before-file-or-shell",
            correctionAction: {
                type: "block-tool",
                reEngage: true,
                message: "Create a todo list first",
            },
        });

        const wrappedTools = wrapToolsWithSupervision(createTools(), createContext());

        const result = await projectContextStore.run(testProjectContext, () =>
            wrappedTools.fs_read.execute?.(
                { path: "README.md" },
                { toolCallId: "call-1" } as never
            )
        );

        expect(result).toBe("Tool execution blocked: Create a todo list first");
        expect(executeToolMock).not.toHaveBeenCalled();
        expect(markHeuristicEnforcedMock).toHaveBeenCalledWith(
            "worker-pubkey:conversation-1:7",
            "worker-todo-before-file-or-shell"
        );
        expect(queueSystemReminderMock).toHaveBeenCalledWith({
            type: "supervision-correction",
            content: "Create a todo list first",
        });
    });
});

function createTools() {
    return {
        fs_read: {
            execute: executeToolMock,
        },
    };
}

function createContext(overrides: {
    todos?: Array<{ id: string; title: string; status: "pending" | "in_progress" | "done" | "skipped" }>;
} = {}): FullRuntimeContext {
    const todos = overrides.todos ?? [];
    const conversationStore = {
        getTodos: mock(() => todos),
        buildMessagesForRal: mock(async () => []),
    };

    return {
        agent: {
            name: "Test Worker",
            slug: "test-worker",
            pubkey: "worker-pubkey",
            category: "worker",
            tools: [],
        },
        conversationId: "conversation-1",
        projectBasePath: "/tmp/project",
        workingDirectory: "/tmp/project",
        currentBranch: "main",
        triggeringEnvelope: {
            transport: "nostr",
        },
        agentPublisher: {},
        ralNumber: 7,
        projectContext: {
            project: {
                tagValue: () => "project-1",
            },
            agents: new Map(),
        },
        conversationStore,
        getConversation: () => conversationStore,
    } as unknown as FullRuntimeContext;
}
