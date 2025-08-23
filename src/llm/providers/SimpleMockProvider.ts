import type {
  CompletionRequest,
  CompletionResponse,
  LLMService,
  StreamEvent,
} from "@/llm/types";
import { logger } from "@/utils/logger";

/**
 * Simplified Mock LLM Provider for iOS testing
 * 
 * This provider returns predetermined responses based on message patterns
 * while preserving all backend business logic (agent routing, event handling, etc).
 * 
 * The backend runs normally - only the LLM API calls are mocked.
 */
export class SimpleMockProvider implements LLMService {
  private responses: Map<RegExp, string>;
  private defaultResponse: string;

  constructor() {
    // Configure predetermined responses
    this.responses = new Map([
      // Basic greetings
      [/\b(hello|hi|hey)\b/i, "Hello! I'm running in test mode. I can help you test iOS functionality."],
      
      // File operations
      [/\bcreate.*file\b/i, "I'll create that file for you. Let me set up the structure and write the content."],
      [/\blist.*files?\b/i, "Here are the files in your project:\n- README.md\n- package.json\n- src/index.ts"],
      [/\bread.*file\b/i, "Reading the file content:\n```\n// Mock file content for testing\nconsole.log('Hello from mock');\n```"],
      
      // Error simulation
      [/\b(simulate|test).*error\b/i, "ERROR: This is a simulated error for testing. The system should handle this gracefully."],
      
      // Code analysis (triggers multi-agent in production)
      [/\banalyze.*code\b/i, "I'll analyze this code for you. The structure looks good, but I have a few suggestions for improvement."],
      [/\breview.*code\b/i, "Code Review Summary:\n- Clean architecture\n- Good separation of concerns\n- Consider adding more error handling"],
      
      // Long operations
      [/\b(deploy|build|compile)\b/i, "Starting build process... This will take a few moments to complete."],
      
      // Task management
      [/\b(todo|task|plan)\b/i, "I'll help you organize these tasks. Let me create a structured plan."],
      
      // Default fallback
      [/.*/, "I understand your request. Processing with mock response."],
    ]);

    this.defaultResponse = "Mock LLM response - no pattern matched your input.";
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const lastMessage = request.messages[request.messages.length - 1];
    const userContent = lastMessage.content.toLowerCase();

    // Find matching response pattern
    let response = this.defaultResponse;
    for (const [pattern, responseText] of this.responses) {
      if (pattern.test(userContent)) {
        response = responseText;
        break;
      }
    }

    logger.info("[MockLLM] Processing request", {
      userMessage: lastMessage.content.substring(0, 100),
      matchedResponse: response.substring(0, 50) + "...",
      agentName: request.options?.agentName,
    });

    // Check if this is a tool-using agent based on system prompt
    const systemMessage = request.messages.find(m => m.role === "system");
    const hasTools = systemMessage?.content.includes("You have access to the following tools");

    // Return response with optional tool calls
    const result: CompletionResponse = {
      type: "text",
      content: response,
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
      },
    };

    // Add tool calls for certain scenarios
    if (hasTools && /\bcreate.*file\b/i.test(userContent)) {
      result.toolCalls = [{
        name: "writeContextFile",
        params: {
          path: "test-file.md",
          content: "# Test File\nThis is a mock file created for testing."
        },
        result: null,
      }];
    } else if (hasTools && /\blist.*files?\b/i.test(userContent)) {
      result.toolCalls = [{
        name: "listContextPaths",
        params: {},
        result: null,
      }];
    }

    return result;
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    // Get the complete response first
    const response = await this.complete(request);
    
    // Simulate streaming by yielding words
    const words = (response.content || "").split(" ");
    for (const word of words) {
      yield { type: "content", content: `${word} ` };
      // Small delay to simulate streaming
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    // Yield tool calls if present
    if (response.toolCalls) {
      for (const toolCall of response.toolCalls) {
        yield {
          type: "tool_start",
          tool: toolCall.name,
          args: toolCall.params,
        };
      }
    }

    // Yield completion
    yield {
      type: "done",
      response,
    };
  }
}

/**
 * Factory function to create the mock provider
 */
export function createSimpleMockProvider(): SimpleMockProvider {
  logger.info("[MockLLM] Creating SimpleMockProvider for testing");
  return new SimpleMockProvider();
}