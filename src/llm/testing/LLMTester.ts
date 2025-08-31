// LLM Configuration Tester - using AI SDK directly
import { getLLMServiceFromConfig } from "@/llm/service";
import type { ResolvedLLMConfig } from "@/llm/types";
import type { TenexLLMs } from "@/services/config/types";
import { logger } from "@/utils/logger";
import type { CoreMessage } from "ai";

/**
 * LLM Configuration Tester - Tests LLM configurations
 */
export class LLMTester {
  /**
   * Test an LLM configuration
   */
  async testLLMConfig(config: ResolvedLLMConfig): Promise<boolean> {
    try {
      // Use the LLM service directly for testing
      const llmService = await getLLMServiceFromConfig();
      
      const messages: CoreMessage[] = [
        { role: "user", content: "Say 'test successful' if you can read this." }
      ];

      const response = await llmService.complete(
        "test",
        messages,
        { temperature: 0.1, maxTokens: 100 }
      );
      
      const responseText = response.text?.toLowerCase() || "";
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
    credentials?: Record<string, { apiKey?: string; baseUrl?: string }>
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
