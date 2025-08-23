import type {
  CompletionRequest,
  CompletionResponse,
  LLMService,
  StreamEvent,
} from "@/llm/types";
import { NDKProjectStatus } from "@/events/NDKProjectStatus";
import { getNDK } from "@/nostr/ndkClient";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { logger } from "@/utils/logger";

export interface MockScenario {
  name: string;
  description?: string;
  triggers: {
    contentMatch?: RegExp | string;
    agentName?: string;
    phase?: string;
    hasTools?: string[];
  };
  events: MockEventToPublish[];
  response: {
    content?: string;
    toolCalls?: Array<{
      name: string;
      params: Record<string, unknown>;
    }>;
    error?: Error;
    delay?: number;
  };
}

export interface MockEventToPublish {
  type: "project-status" | "typing-start" | "typing-stop" | "task" | "reply";
  delay?: number; // ms before publishing
  data: Record<string, unknown>;
}

export interface MockProviderConfig {
  scenarios: MockScenario[];
  defaultResponse?: {
    content: string;
    toolCalls?: Array<{
      name: string;
      params: Record<string, unknown>;
    }>;
  };
  publishEvents?: boolean;
  debug?: boolean;
}

/**
 * Mock LLM Provider for testing iOS-backend integration
 * 
 * This provider simulates LLM responses and publishes Nostr events
 * to test the full conversation flow without using real LLM APIs.
 */
export class MockLLMProvider implements LLMService {
  private scenarios: MockScenario[];
  private config: MockProviderConfig;
  private requestHistory: Array<{
    request: CompletionRequest;
    scenario: MockScenario | null;
    response: any;
    timestamp: Date;
  }> = [];

  constructor(config: MockProviderConfig) {
    this.config = config;
    this.scenarios = config.scenarios || [];
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const scenario = this.findMatchingScenario(request);
    
    if (this.config.debug) {
      logger.info("MockLLMProvider: Processing request", {
        messages: request.messages.length,
        matchedScenario: scenario?.name || "default",
      });
    }

    // Publish mock events if configured
    if (this.config.publishEvents && scenario) {
      await this.publishMockEvents(scenario, request);
    }

    // Get response from scenario or default
    const response: MockScenario['response'] = scenario?.response || this.config.defaultResponse || {
      content: "Mock response: No matching scenario found",
    };

    // Record request for debugging
    this.requestHistory.push({
      request,
      scenario,
      response,
      timestamp: new Date(),
    });

    // Simulate delay if specified
    if (response.delay) {
      await new Promise((resolve) => setTimeout(resolve, response.delay));
    }

    // Handle error scenario
    if (response.error) {
      throw response.error;
    }

    // Build completion response
    const toolCalls = response.toolCalls?.map((tc) => ({
      name: tc.name,
      params: tc.params,
      result: null,
    }));

    return {
      type: "text",
      content: response.content || "",
      toolCalls,
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    } as CompletionResponse;
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const scenario = this.findMatchingScenario(request);
    const response: MockScenario['response'] = scenario?.response || this.config.defaultResponse || {
      content: "Mock stream response",
    };

    // Simulate streaming
    if (response.content) {
      const words = response.content.split(" ");
      for (const word of words) {
        yield { type: "content", content: `${word} ` };
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    // Send tool calls
    if (response.toolCalls) {
      for (const toolCall of response.toolCalls) {
        yield {
          type: "tool_start",
          tool: toolCall.name,
          args: toolCall.params,
        };
      }
    }

    yield {
      type: "done",
      response: {
        type: "text",
        content: response.content || "",
        toolCalls: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
        },
      },
    };
  }

  private findMatchingScenario(request: CompletionRequest): MockScenario | null {
    const lastMessage = request.messages[request.messages.length - 1];
    const systemMessage = request.messages.find((m) => m.role === "system");
    
    for (const scenario of this.scenarios) {
      const triggers = scenario.triggers;
      
      // Check content match
      if (triggers.contentMatch) {
        const pattern = typeof triggers.contentMatch === "string" 
          ? new RegExp(triggers.contentMatch, "i")
          : triggers.contentMatch;
        
        if (!pattern.test(lastMessage.content)) {
          continue;
        }
      }

      // Check agent name from system prompt
      if (triggers.agentName && systemMessage) {
        if (!systemMessage.content.toLowerCase().includes(triggers.agentName.toLowerCase())) {
          continue;
        }
      }

      // Check phase from system prompt
      if (triggers.phase && systemMessage) {
        const phaseRegex = new RegExp(`phase[:\\s]+${triggers.phase}`, "i");
        if (!phaseRegex.test(systemMessage.content)) {
          continue;
        }
      }

      // All conditions matched
      return scenario;
    }

    return null;
  }

  private async publishMockEvents(scenario: MockScenario, _request: CompletionRequest): Promise<void> {
    
    for (const mockEvent of scenario.events) {
      // Wait if delay specified
      if (mockEvent.delay) {
        await new Promise((resolve) => setTimeout(resolve, mockEvent.delay));
      }

      switch (mockEvent.type) {
        case "project-status":
          await this.publishProjectStatus(mockEvent.data);
          break;
        
        case "typing-start":
          await this.publishTypingIndicator(true, mockEvent.data);
          break;
        
        case "typing-stop":
          await this.publishTypingIndicator(false, mockEvent.data);
          break;
        
        case "task":
          await this.publishTask(mockEvent.data);
          break;
        
        case "reply":
          await this.publishReply(mockEvent.data);
          break;
      }
    }
  }

  private async publishProjectStatus(data: Record<string, unknown>): Promise<void> {
    const ndk = getNDK();
    const status = new NDKProjectStatus(ndk);
    
    status.projectReference = data.projectReference as string || "31933:mock-pubkey:test-project";
    status.status = data.status as string || "Mock agents online";
    
    // Add agents
    const agents = data.agents as Array<{ pubkey: string; slug: string; isGlobal?: boolean }> || [
      { pubkey: "mock-executor", slug: "executor" },
      { pubkey: "mock-planner", slug: "planner" },
    ];
    
    for (const agent of agents) {
      const tag = ["agent", agent.pubkey, agent.slug];
      if (agent.isGlobal) tag.push("global");
      status.tags.push(tag);
    }

    // Add models
    const models = data.models as Record<string, string[]> || {
      "mock-model": ["executor", "planner"],
    };
    
    for (const [modelSlug, agentSlugs] of Object.entries(models)) {
      status.addModel(modelSlug, agentSlugs);
    }

    // Add tools
    const tools = data.tools as Record<string, string[]> || {
      "shell": ["executor"],
      "readPath": ["executor", "planner"],
    };
    
    for (const [toolName, agentSlugs] of Object.entries(tools)) {
      status.addTool(toolName, agentSlugs);
    }

    await status.publish();
    
    if (this.config.debug) {
      logger.info("MockLLMProvider: Published project status", {
        agents: agents.length,
        models: Object.keys(models).length,
        tools: Object.keys(tools).length,
      });
    }
  }

  private async publishTypingIndicator(isStart: boolean, data: Record<string, unknown>): Promise<void> {
    const ndk = getNDK();
    const event = new NDKEvent(ndk);
    
    event.kind = isStart ? 24111 : 24112;
    event.content = data.message as string || "Mock agent is thinking...";
    
    event.tags = [
      ["e", data.conversationId as string || "mock-conversation-id"],
      ["a", data.projectReference as string || "31933:mock-pubkey:test-project"],
    ];
    
    if (isStart && data.phase) {
      event.tags.push(["phase", data.phase as string]);
    }
    
    await event.publish();
    
    if (this.config.debug) {
      logger.info(`MockLLMProvider: Published typing ${isStart ? "start" : "stop"}`, {
        phase: data.phase,
      });
    }
  }

  private async publishTask(data: Record<string, unknown>): Promise<void> {
    const ndk = getNDK();
    const event = new NDKEvent(ndk);
    
    event.kind = 1934; // Task kind
    event.content = data.content as string || "Mock task";
    
    event.tags = [
      ["e", data.conversationId as string || "mock-conversation-id"],
      ["a", data.projectReference as string || "31933:mock-pubkey:test-project"],
      ["status", data.status as string || "pending"],
    ];
    
    const hashtags = data.hashtags as string[] || ["mock", "test"];
    for (const tag of hashtags) {
      event.tags.push(["t", tag]);
    }
    
    await event.publish();
    
    if (this.config.debug) {
      logger.info("MockLLMProvider: Published task", {
        status: data.status,
        tags: hashtags,
      });
    }
  }

  private async publishReply(data: Record<string, unknown>): Promise<void> {
    const ndk = getNDK();
    const event = new NDKEvent(ndk);
    
    event.kind = data.kind as number || 1111; // Generic reply
    event.content = data.content as string || "Mock reply";
    
    event.tags = data.tags as string[][] || [
      ["e", "parent-event-id"],
      ["p", "parent-pubkey"],
    ];
    
    await event.publish();
    
    if (this.config.debug) {
      logger.info("MockLLMProvider: Published reply", {
        kind: event.kind,
      });
    }
  }

  // Utility methods for testing
  getRequestHistory() {
    return this.requestHistory;
  }

  clearHistory() {
    this.requestHistory = [];
  }

  addScenario(scenario: MockScenario) {
    this.scenarios.push(scenario);
  }

  removeScenario(name: string) {
    this.scenarios = this.scenarios.filter((s) => s.name !== name);
  }
}

// Factory function for easy creation
export function createMockLLMProvider(config: Partial<MockProviderConfig> = {}): MockLLMProvider {
  const defaultConfig: MockProviderConfig = {
    scenarios: [],
    publishEvents: true,
    debug: process.env.DEBUG === "true",
    defaultResponse: {
      content: "This is a mock response from the test LLM provider",
    },
  };

  return new MockLLMProvider({ ...defaultConfig, ...config });
}