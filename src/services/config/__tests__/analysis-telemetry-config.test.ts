import { describe, expect, it } from "bun:test";
import { TenexConfigSchema } from "../types";
import { ConfigService } from "../../ConfigService";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

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

    it("rejects tool decay placeholder batch sizes below 5", () => {
        const result = TenexConfigSchema.safeParse({
            contextManagement: {
                toolResultDecay: {
                    minPlaceholderBatchSize: 4,
                },
            },
        });

        expect(result.success).toBe(false);
    });

    it("defaults to storing full prompt text when analysis telemetry is enabled", async () => {
        const testDir = path.join("/tmp", `tenex-analysis-defaults-${Date.now()}`);
        const config = new ConfigService();
        const originalTenexBaseDir = process.env.TENEX_BASE_DIR;

        try {
            process.env.TENEX_BASE_DIR = testDir;
            await mkdir(testDir, { recursive: true });
            await writeFile(
                path.join(testDir, "config.json"),
                JSON.stringify({
                    telemetry: {
                        analysis: {
                            enabled: true,
                        },
                    },
                })
            );

            await config.loadConfig();

            expect(config.getAnalysisTelemetryConfig().storeFullMessageText).toBe(true);
        } finally {
            if (originalTenexBaseDir === undefined) {
                delete process.env.TENEX_BASE_DIR;
            } else {
                process.env.TENEX_BASE_DIR = originalTenexBaseDir;
            }
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it("loads tool decay placeholder batch sizes at the minimum allowed value", async () => {
        const testDir = path.join("/tmp", `tenex-config-test-${Date.now()}`);
        const config = new ConfigService();
        try {
            await mkdir(testDir, { recursive: true });
            await writeFile(
                path.join(testDir, "config.json"),
                JSON.stringify({
                    contextManagement: {
                        toolResultDecay: {
                            minPlaceholderBatchSize: 5,
                        },
                    },
                })
            );

            await expect(config.loadTenexConfig(testDir)).resolves.toEqual(
                expect.objectContaining({
                    contextManagement: expect.objectContaining({
                        toolResultDecay: expect.objectContaining({
                            minPlaceholderBatchSize: 5,
                        }),
                    }),
                })
            );
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it("fails to load config files with tool decay placeholder batch sizes below 5", async () => {
        const testDir = path.join("/tmp", `tenex-config-batch-size-${Date.now()}`);
        const config = new ConfigService();
        try {
            await mkdir(testDir, { recursive: true });
            await writeFile(
                path.join(testDir, "config.json"),
                JSON.stringify({
                    contextManagement: {
                        toolResultDecay: {
                            minPlaceholderBatchSize: 4,
                        },
                    },
                })
            );

            await expect(config.loadTenexConfig(testDir)).rejects.toThrow(
                "minPlaceholderBatchSize"
            );
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });
});
