import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as constantsModule from "@/constants";
import { llmServiceFactory } from "@/llm/LLMServiceFactory";
import * as modelsDevCacheModule from "@/llm/utils/models-dev-cache";
import { ConfigService } from "@/services/ConfigService";

const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

describe("ConfigService providers.json hot reload", () => {
    afterEach(() => {
        mock.restore();
    });

    it("reinitializes provider runtime after providers.json changes on disk", async () => {
        const testDir = await mkdtemp(path.join("/tmp", "tenex-providers-hot-reload-"));
        const configService = new ConfigService();

        try {
            spyOn(constantsModule, "getTenexBasePath").mockReturnValue(testDir);
            spyOn(modelsDevCacheModule, "ensureCacheLoaded").mockResolvedValue(undefined);

            const initializeProvidersSpy = spyOn(llmServiceFactory, "initializeProviders").mockResolvedValue();

            const initialProviders = {
                providers: {
                    openai: {
                        apiKey: "sk-initial",
                    },
                },
            };

            const updatedProviders = {
                providers: {
                    openai: {
                        apiKey: "sk-updated",
                        baseUrl: "https://example.test/v1",
                    },
                },
            };

            await mkdir(testDir, { recursive: true });
            await mkdir(path.join(testDir, "cache"), { recursive: true });
            await writeFile(
                path.join(testDir, "providers.json"),
                JSON.stringify(initialProviders, null, 2)
            );

            await configService.loadConfig();
            expect(initializeProvidersSpy).toHaveBeenCalledTimes(1);
            expect(initializeProvidersSpy).toHaveBeenLastCalledWith(initialProviders.providers);

            await writeFile(
                path.join(testDir, "providers.json"),
                JSON.stringify(updatedProviders, null, 2)
            );

            for (let attempt = 0; attempt < 20; attempt++) {
                await wait(25);
                await configService.waitForPendingProviderReload();
                if (initializeProvidersSpy.mock.calls.length >= 2) {
                    break;
                }
            }

            expect(initializeProvidersSpy).toHaveBeenCalledTimes(2);
            expect(initializeProvidersSpy).toHaveBeenLastCalledWith(updatedProviders.providers);
        } finally {
            configService.dispose();
            await rm(testDir, { recursive: true, force: true });
        }
    });
});
