import { LLMRouter } from "@/llm/router";
import type { CompletionRequest, ResolvedLLMConfig } from "@/llm/types";
import type { TenexLLMCredentials, TenexLLMs } from "@/services/config/types";
import { logger } from "@/utils/logger";

/**
 * LLM Configuration Tester - Tests LLM configurations
 */
export class LLMTester {
  /**
   * Test an LLM configuration
   */
  async testLLMConfig(config: ResolvedLLMConfig): Promise<boolean> {
    try {
      // Create a temporary router with just this config for testing
      const router = new LLMRouter({
        configs: { test: config },
        defaults: { agents: "test" },
      });

      const request: CompletionRequest = {
        messages: [
          {
            role: "user",
            content: "Say 'test successful' if you can read this.",
          },
        ],
        options: {
          configName: "test",
        },
      };

      const response = await router.complete(request);
      const responseText = response.content?.toLowerCase() || "";
      return responseText.includes("test") && responseText.includes("successful");
    } catch (error) {
      logger.error("LLM test failed", { error });
      return false;
    }
  }

  /**
   * Test an existing configuration by name
   */
  async testExistingConfiguration(
    configName: string,
    configurations: TenexLLMs["configurations"],
    credentials?: TenexLLMCredentials
  ): Promise<boolean> {
    const config = configurations[configName];
    if (!config) {
      logger.error(`Configuration ${configName} not found`);
      return false;
    }

    const resolvedConfig: ResolvedLLMConfig = {
      ...config,
      apiKey: credentials?.[config.provider]?.apiKey,
      baseUrl: credentials?.[config.provider]?.baseUrl,
    };

    return this.testLLMConfig(resolvedConfig);
  }
}
