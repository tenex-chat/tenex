import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

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

mock.module("inquirer", () => ({
    default: {
        prompt: promptMock,
    },
}));

mock.module("@/services/ConfigService", () => ({
    config: {
        getGlobalPath: getGlobalPathMock,
        loadTenexConfig: loadTenexConfigMock,
        saveTenexConfig: saveTenexConfigMock,
        getAnalysisTelemetryConfig: getAnalysisTelemetryConfigMock,
        getContextManagementConfig: getContextManagementConfigMock,
        getSummarizationModelName: getSummarizationModelNameMock,
        createLLMService: createLLMServiceMock,
    },
}));

describe("contextManagementCommand", () => {
    beforeEach(() => {
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

    it("saves context management settings from the config TUI", async () => {
        const logSpy = spyOn(console, "log").mockImplementation(() => {});
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
            })
        );

        logSpy.mockRestore();
    });
});
