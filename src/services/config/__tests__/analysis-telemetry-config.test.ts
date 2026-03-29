import { describe, expect, it } from "bun:test";
import { TenexConfigSchema } from "../types";

describe("Analysis telemetry config schema", () => {
    it("accepts the analysis telemetry block", () => {
        const result = TenexConfigSchema.safeParse({
            telemetry: {
                enabled: true,
                serviceName: "tenex-daemon",
                endpoint: "http://localhost:4318/v1/traces",
                analysis: {
                    enabled: true,
                    dbPath: "~/.tenex/data/trace-analysis.db",
                    retentionDays: 14,
                    largeMessageThresholdTokens: 2000,
                    storeMessagePreviews: true,
                    maxPreviewChars: 256,
                    storeFullMessageText: false,
                },
            },
        });

        expect(result.success).toBe(true);
    });

    it("rejects invalid analysis telemetry values", () => {
        const result = TenexConfigSchema.safeParse({
            telemetry: {
                analysis: {
                    retentionDays: 0,
                    largeMessageThresholdTokens: -1,
                    maxPreviewChars: 0,
                },
            },
        });

        expect(result.success).toBe(false);
    });
});
