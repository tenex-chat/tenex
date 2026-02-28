import type { CompleteEvent, ContentEvent, StreamErrorEvent } from "@/llm/types";
import { config as configService } from "@/services/ConfigService";
import type { TenexLLMs } from "@/services/config/types";
import { llmServiceFactory } from "../LLMServiceFactory";

type TenexLLMsWithProviders = TenexLLMs & {
    providers: Record<string, { apiKey: string | string[] }>;
};

export type TestResult = { success: true } | { success: false; error: string };

function silenceConsole(): () => void {
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    const origInfo = console.info;
    const noop = () => {};
    console.log = noop;
    console.warn = noop;
    console.error = noop;
    console.info = noop;
    return () => {
        console.log = origLog;
        console.warn = origWarn;
        console.error = origError;
        console.info = origInfo;
    };
}

export class ConfigurationTester {
    /**
     * Run a silent test against a configuration. Returns pass/fail result.
     * All console output is suppressed during the test.
     */
    static async runTest(llmsConfig: TenexLLMsWithProviders, configName: string): Promise<TestResult> {
        if (!llmsConfig.configurations[configName]) {
            return { success: false, error: "configuration not found" };
        }

        const restoreConsole = silenceConsole();

        try {
            await configService.loadConfig();
            const llmConfig = configService.getLLMConfig(configName);

            await llmServiceFactory.initializeProviders(llmsConfig.providers);
            const service = llmServiceFactory.createService(llmConfig);

            service.on("content", (_event: ContentEvent) => {});

            const completePromise = new Promise<CompleteEvent>((resolve) => {
                service.once("complete", resolve);
            });
            const errorPromise = new Promise<never>((_resolve, reject) => {
                service.once("stream-error", (event: StreamErrorEvent) => {
                    reject(event.error);
                });
            });

            await Promise.all([
                service.stream(
                    [{ role: "user", content: "Say 'Hello, TENEX!' in exactly those words." }],
                    {}
                ),
                Promise.race([completePromise, errorPromise]),
            ]);

            return { success: true };
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            let hint = errorMessage;
            if (errorMessage?.includes("401") || errorMessage?.includes("Unauthorized")) {
                hint = "invalid or expired API key";
            } else if (errorMessage?.includes("404")) {
                hint = "model not available";
            } else if (errorMessage?.includes("rate limit")) {
                hint = "rate limited";
            }
            return { success: false, error: hint };
        } finally {
            // Delay restore so async logger stragglers are swallowed
            await new Promise((resolve) => setTimeout(resolve, 200));
            restoreConsole();
        }
    }
}
