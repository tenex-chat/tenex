import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { config as configService } from "@/services/ConfigService";
import {
    DEFAULT_TOOL_RESULT_DECAY_MIN_PLACEHOLDER_BATCH_SIZE,
    getContextManagementSettings,
} from "../context-management/settings";

describe("getContextManagementSettings", () => {
    let getContextManagementConfigSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        getContextManagementConfigSpy?.mockRestore();
        getContextManagementConfigSpy = spyOn(
            configService,
            "getContextManagementConfig"
        ).mockReturnValue(undefined);
    });

    test("defaults tool decay placeholder batch size to 10", () => {
        const settings = getContextManagementSettings();

        expect(settings.toolResultDecay.minPlaceholderBatchSize).toBe(
            DEFAULT_TOOL_RESULT_DECAY_MIN_PLACEHOLDER_BATCH_SIZE
        );
    });

    test("uses configured tool decay placeholder batch size", () => {
        getContextManagementConfigSpy.mockReturnValue({
            toolResultDecay: {
                minPlaceholderBatchSize: 12,
            },
        });

        const settings = getContextManagementSettings();

        expect(settings.toolResultDecay.minPlaceholderBatchSize).toBe(12);
    });
});
