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
    },
}));

describe("contextManagementCommand", () => {
    beforeEach(() => {
        promptQueue.length = 0;
        promptMock.mockClear();
        getGlobalPathMock.mockClear();
        loadTenexConfigMock.mockClear();
        saveTenexConfigMock.mockClear();
        loadTenexConfigMock.mockResolvedValue({
            contextManagement: {},
        });
    });

    it("saves Anthropic prompt-caching knobs from the config TUI", async () => {
        const logSpy = spyOn(console, "log").mockImplementation(() => {});
        promptQueue.push(
            { action: "configure" },
            {
                enabled: true,
                tokenBudget: "32000",
                forceScratchpadThresholdPercent: "75",
                utilizationWarningThresholdPercent: "65",
                compactionThresholdPercent: "92",
            },
            {
                ttl: "5m",
                serverToolEditingEnabled: false,
                triggerToolUses: "40",
                keepToolUses: "12",
                clearAtLeastInputTokens: "8000",
                clearToolInputs: false,
                excludeTools: "delegate, shell",
            },
            {
                anthropicPromptCaching: true,
                reminders: true,
                scratchpad: true,
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
                    forceScratchpadThresholdPercent: 75,
                    utilizationWarningThresholdPercent: 65,
                    compactionThresholdPercent: 92,
                    anthropicPromptCaching: {
                        ttl: "5m",
                        serverToolEditing: {
                            enabled: false,
                            triggerToolUses: 40,
                            keepToolUses: 12,
                            clearAtLeastInputTokens: 8000,
                            clearToolInputs: false,
                            excludeTools: ["delegate", "shell"],
                        },
                    },
                    strategies: expect.objectContaining({
                        anthropicPromptCaching: true,
                        reminders: true,
                        scratchpad: true,
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
