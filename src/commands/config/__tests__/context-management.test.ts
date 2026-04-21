import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { config } from "@/services/ConfigService";

const promptQueue: Array<Record<string, unknown>> = [];
const promptMock = mock(async () => {
    const next = promptQueue.shift();
    if (!next) {
        throw new Error("Unexpected prompt call");
    }
    return next;
});

const getGlobalPathMock = mock(() => "/tmp/tenex-config-test");
const loadTenexConfigMock = mock(async () => ({}));
const saveTenexConfigMock = mock(async () => undefined);
const getAnalysisTelemetryConfigMock = mock(() => ({
    enabled: false,
    dbPath: "/tmp/tenex-analysis-test.db",
    retentionDays: 14,
    largeMessageThresholdTokens: 50,
    storeMessagePreviews: true,
    maxPreviewChars: 64,
    storeFullMessageText: false,
}));
const getContextManagementConfigMock = mock(() => undefined);
const getSummarizationModelNameMock = mock(() => undefined);
const createLLMServiceMock = mock(() => ({
    createLanguageModel: () => {
        throw new Error("Unexpected createLanguageModel() call in context management config test");
    },
}));
let configSpies: Array<ReturnType<typeof spyOn>> = [];
let logSpy: ReturnType<typeof spyOn> | undefined;

mock.module("inquirer", () => ({
    default: {
        prompt: promptMock,
    },
}));

describe("contextManagementCommand", () => {
    beforeEach(() => {
        configSpies = [
            spyOn(config, "getGlobalPath").mockImplementation(getGlobalPathMock),
            spyOn(config, "loadTenexConfig").mockImplementation(loadTenexConfigMock as any),
            spyOn(config, "saveTenexConfig").mockImplementation(saveTenexConfigMock as any),
            spyOn(config, "getAnalysisTelemetryConfig").mockImplementation(
                getAnalysisTelemetryConfigMock
            ),
            spyOn(config, "getContextManagementConfig").mockImplementation(
                getContextManagementConfigMock
            ),
            spyOn(config, "getSummarizationModelName").mockImplementation(
                getSummarizationModelNameMock
            ),
            spyOn(config, "createLLMService").mockImplementation(createLLMServiceMock as any),
        ];
        promptQueue.length = 0;
        promptMock.mockClear();
        getGlobalPathMock.mockClear();
        loadTenexConfigMock.mockClear();
        saveTenexConfigMock.mockClear();
        getAnalysisTelemetryConfigMock.mockClear();
        getContextManagementConfigMock.mockClear();
        getSummarizationModelNameMock.mockClear();
        createLLMServiceMock.mockClear();
        loadTenexConfigMock.mockResolvedValue({
            contextManagement: {},
        });
    });

    afterEach(() => {
        for (const spy of configSpies) {
            spy.mockRestore();
        }
        configSpies = [];
        logSpy?.mockRestore();
        logSpy = undefined;
        promptQueue.length = 0;
    });

    it("saves context management settings from the config TUI", async () => {
        logSpy = spyOn(console, "log").mockImplementation(() => {});
        loadTenexConfigMock.mockResolvedValueOnce({
            contextManagement: {},
            contextDiscovery: {
                injectWhenEmpty: true,
                manifestTtlMs: 1234,
            },
        });
        promptQueue.push(
            { action: "configure" },
            {
                enabled: true,
                tokenBudget: "32000",
                utilizationWarningThresholdPercent: "65",
                compactionThresholdPercent: "92",
            },
            {
                minTotalSavingsTokens: "20000",
                minDepth: "20",
                minPlaceholderBatchSize: "10",
                excludeToolNames: "delegate, delegate_followup",
            },
            {
                reminders: true,
                toolResultDecay: false,
                compaction: true,
                contextUtilizationReminder: true,
                contextWindowStatus: false,
            },
            {
                enabled: true,
                trigger: "new-conversation",
                timeoutMs: "1200",
                maxQueries: "4",
                maxHints: "5",
                minScore: "0.45",
                sources: "conversations, lessons, rag",
                usePlannerModel: true,
                useRerankerModel: false,
                backgroundCompletionReminders: true,
            }
        );

        const { contextManagementCommand } = await import("../context-management");
        await contextManagementCommand.parseAsync([], { from: "user" });

        expect(saveTenexConfigMock).toHaveBeenCalledWith(
            "/tmp/tenex-config-test",
            expect.objectContaining({
                contextManagement: expect.objectContaining({
                    enabled: true,
                    tokenBudget: 32000,
                    utilizationWarningThresholdPercent: 65,
                    compactionThresholdPercent: 92,
                    toolResultDecay: expect.objectContaining({
                        minPlaceholderBatchSize: 10,
                    }),
                    strategies: expect.objectContaining({
                        reminders: true,
                        toolResultDecay: false,
                        compaction: true,
                        contextUtilizationReminder: true,
                        contextWindowStatus: false,
                    }),
                }),
                contextDiscovery: expect.objectContaining({
                    enabled: true,
                    trigger: "new-conversation",
                    timeoutMs: 1200,
                    maxQueries: 4,
                    maxHints: 5,
                    minScore: 0.45,
                    sources: ["conversations", "lessons", "rag"],
                    usePlannerModel: true,
                    useRerankerModel: false,
                    backgroundCompletionReminders: true,
                    injectWhenEmpty: true,
                    manifestTtlMs: 1234,
                }),
            })
        );
    });
});
