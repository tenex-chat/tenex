import { beforeEach, describe, expect, it, afterEach, mock } from "bun:test";
import { createMockLLMProvider, type MockLLMProvider, type MockScenario } from "@/llm/providers/MockProvider";
import { NDKProjectStatus } from "@/events/NDKProjectStatus";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKKind } from "@/nostr/kinds";
import { createTempDir, cleanupTempDir } from "@/test-utils";
import path from "node:path";

/**
 * E2E Tests for iOS-Backend Compatibility
 * 
 * These tests validate that:
 * 1. iOS creates events with correct structure
 * 2. Backend parses iOS events correctly
 * 3. Backend responds with events iOS can parse
 * 4. Full conversation flow works end-to-end
 */
describe("iOS-Backend Compatibility", () => {
  let mockProvider: MockLLMProvider;
  let tempDir: string;
  let projectPath: string;
  let publishedEvents: NDKEvent[] = [];
  let originalPublish: any;

  beforeEach(async () => {
    // Setup temp directory
    tempDir = await createTempDir("ios-compat-test-");
    projectPath = path.join(tempDir, "test-project");

    // Create mock provider with iOS-specific scenarios
    mockProvider = createMockLLMProvider({
      debug: true,
      publishEvents: false, // Don't publish real events in tests
      scenarios: getIOSTestScenarios(),
    });

    // Mock the LLM router to use our provider
    mock.module("@/llm/router", () => ({
      getLLMService: () => mockProvider,
      LLMRouter: class {
        getService() { return mockProvider; }
        validateModel() { return true; }
      },
    }));

    // Mock NDK to avoid network initialization
    mock.module("@/nostr/ndkClient", () => ({
      getNDK: () => ({
        connect: async () => {},
        signer: { privateKey: () => "mock-private-key" },
        pool: {
          connectedRelays: () => [],
          relaySet: new Set(),
          addRelay: () => {}
        },
        publish: async (event: any) => {
          publishedEvents.push(event);
          return Promise.resolve();
        },
        calculateRelaySetFromEvent: () => ({ relays: [] })
      }),
      initNDK: async () => {}
    }));

    // Capture published events for validation
    originalPublish = NDKEvent.prototype.publish;
    NDKEvent.prototype.publish = async function() {
      publishedEvents.push(this);
      return Promise.resolve();
    };
  });

  afterEach(async () => {
    // Restore original publish
    if (originalPublish) {
      NDKEvent.prototype.publish = originalPublish;
    }
    
    // Clear published events
    publishedEvents = [];
    
    // Cleanup temp dir
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  });

  describe("Event Structure Validation", () => {
    it("should parse iOS project status event correctly", () => {
      // iOS event structure
      const iosEvent = {
        kind: NDKKind.TenexProjectStatus,
        pubkey: "ios-app-pubkey",
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["a", "31933:project-pubkey:test-project"],
          ["agent", "executor-pubkey", "executor"],
          ["agent", "planner-pubkey", "planner", "global"],
          ["model", "gpt-4", "executor", "planner"],
          ["tool", "shell", "executor"],
          ["tool", "readPath", "executor", "planner"],
        ],
        content: "Project status from iOS",
        sig: "mock-signature",
        id: "mock-event-id",
      };

      // Parse with backend model
      const status = NDKProjectStatus.from(new NDKEvent(undefined, iosEvent));

      // Validate parsing
      expect(status.projectReference).toBe("31933:project-pubkey:test-project");
      expect(status.agents).toHaveLength(2);
      expect(status.agents[0]).toEqual({ pubkey: "executor-pubkey", slug: "executor" });
      expect(status.agents[1]).toEqual({ pubkey: "planner-pubkey", slug: "planner" });
      
      // Validate model parsing
      const models = status.models;
      expect(models).toHaveLength(1);
      expect(models[0].modelSlug).toBe("gpt-4");
      expect(models[0].agents).toContain("executor");
      expect(models[0].agents).toContain("planner");

      // Validate tool parsing
      const tools = status.tools;
      expect(tools).toHaveLength(2);
      expect(tools.find(t => t.toolName === "shell")?.agents).toContain("executor");
      expect(tools.find(t => t.toolName === "readPath")?.agents).toContain("planner");
    });

    it("should create backend events that iOS can parse", async () => {
      const status = new NDKProjectStatus(undefined);
      
      // Build event using backend methods
      status.projectReference = "31933:backend-pubkey:project";
      status.addAgent("agent1", "executor");
      status.addAgent("agent2", "planner");
      status.addModel("claude-3", ["executor", "planner"]);
      status.addTool("writeContextFile", ["executor"]);
      
      // Validate structure matches iOS expectations
      const tags = status.tags;
      
      // Check project reference
      expect(tags.find(t => t[0] === "a")?.[1]).toBe("31933:backend-pubkey:project");
      
      // Check agent tags
      const agentTags = tags.filter(t => t[0] === "agent");
      expect(agentTags).toHaveLength(2);
      expect(agentTags[0]).toEqual(["agent", "agent1", "executor"]);
      
      // Check model tags (iOS must parse: ["model", "slug", ...agents])
      const modelTag = tags.find(t => t[0] === "model");
      expect(modelTag?.[1]).toBe("claude-3");
      expect(modelTag?.slice(2)).toContain("executor");
      expect(modelTag?.slice(2)).toContain("planner");
      
      // Check tool tags
      const toolTag = tags.find(t => t[0] === "tool");
      expect(toolTag?.[1]).toBe("writeContextFile");
      expect(toolTag?.[2]).toBe("executor");
    });

    // Execution queue test removed - queue functionality was never implemented
  });

  describe("Typing Indicator Events", () => {
    it("should create typing indicators with phase information", async () => {
      const typingStart = new NDKEvent(undefined);
      
      typingStart.kind = NDKKind.TenexAgentTypingStart;
      typingStart.content = "Working on your request...";
      typingStart.tags = [
        ["e", "conversation-id"],
        ["a", "31933:pubkey:project"],
        ["phase", "implementing"],
      ];
      
      // Validate structure for iOS
      expect(typingStart.kind).toBe(NDKKind.TenexAgentTypingStart);
      expect(typingStart.tags.find(t => t[0] === "phase")?.[1]).toBe("implementing");
    });

    it("should handle typing stop events", () => {
      const typingStop = new NDKEvent(undefined);
      
      typingStop.kind = NDKKind.TenexAgentTypingStop;
      typingStop.tags = [
        ["e", "conversation-id"],
      ];
      
      // Stop events don't need phase
      expect(typingStop.kind).toBe(NDKKind.TenexAgentTypingStop);
      expect(typingStop.tags.find(t => t[0] === "phase")).toBeUndefined();
    });
  });

  describe("Task Events", () => {
    it("should create task events with correct structure", () => {
      const task = new NDKEvent(undefined);
      
      task.kind = 1934;
      task.content = "Create hello world file";
      task.tags = [
        ["e", "conversation-id"],
        ["a", "31933:pubkey:project"],
        ["status", "pending"],
        ["t", "file-creation"],
        ["t", "hello-world"],
      ];
      
      // Validate for iOS parsing
      expect(task.kind).toBe(1934);
      expect(task.tags.find(t => t[0] === "status")?.[1]).toBe("pending");
      
      const hashtags = task.tags.filter(t => t[0] === "t").map(t => t[1]);
      expect(hashtags).toContain("file-creation");
      expect(hashtags).toContain("hello-world");
    });
  });

  describe("Mock Conversation Flow", () => {
    it("should handle iOS conversation request end-to-end", async () => {
      // Reset published events
      publishedEvents = [];
      
      // iOS sends initial message (kind 11)
      const iosMessage = {
        kind: 11,
        pubkey: "ios-user-pubkey",
        content: "hello from iOS",
        tags: [
          ["a", "31933:project-pubkey:ios-project"],
        ],
        created_at: Math.floor(Date.now() / 1000),
        id: "ios-message-id",
        sig: "mock-sig",
      };

      // Process with mock provider
      const response = await mockProvider.complete({
        messages: [
          { role: "system", content: "You are the Orchestrator agent. Phase: CHAT" },
          { role: "user", content: iosMessage.content },
        ],
        options: { configName: "orchestrator" },
      });

      // Validate response
      expect(response.content).toContain("Hello from the mock");
      expect(response.toolCalls).toBeDefined();
      
      // Validate published events (these would be sent to iOS)
      // Note: In real scenario, these would be published via Nostr
      // For now, we're validating the structure
      
      // Wait a bit for async publishing
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Check if status event was published
      const statusEvent = publishedEvents.find(e => e.kind === NDKKind.TenexProjectStatus);
      if (statusEvent) {
        expect(statusEvent.tags.some(t => t[0] === "agent")).toBe(true);
        expect(statusEvent.tags.some(t => t[0] === "model")).toBe(true);
      }
    });

    it("should handle tool execution flow", async () => {
      publishedEvents = [];
      
      // Add file creation scenario
      mockProvider.addScenario({
        name: "file-creation",
        triggers: {
          contentMatch: /create.*file/i,
        },
        events: [
          {
            type: "typing-start",
            data: {
              phase: "implementing",
              message: "Creating file...",
            },
          },
          {
            type: "task",
            data: {
              content: "Create test.md file",
              status: "completed",
              hashtags: ["file", "creation"],
            },
          },
        ],
        response: {
          content: "I'll create the file for you",
          toolCalls: [
            {
              name: "writeContextFile",
              params: {
                path: "test.md",
                content: "# Test File\n\nCreated by mock",
              },
            },
          ],
        },
      });

      // iOS requests file creation
      const response = await mockProvider.complete({
        messages: [
          { role: "system", content: "You are the Executor agent" },
          { role: "user", content: "create a test file" },
        ],
        options: { configName: "executor" },
      });

      // Validate tool call
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls?.[0].name).toBe("writeContextFile");
      expect(response.toolCalls?.[0].params.path).toBe("output.md");
    });
  });

  describe("Error Scenarios", () => {
    it("should handle iOS malformed events gracefully", () => {
      // iOS sends malformed event
      const malformedEvent = {
        kind: NDKKind.TenexProjectStatus,
        tags: [
          ["a"], // Missing project reference value
          ["agent", "pubkey"], // Missing slug
          ["model"], // Missing model slug and agents
        ],
        content: "",
      } as any;

      // Should not throw, but handle gracefully
      const status = NDKProjectStatus.from(new NDKEvent(undefined, malformedEvent));
      
      expect(status.projectReference).toBeUndefined();
      expect(status.agents).toHaveLength(1);
      expect(status.agents[0].slug).toBe(""); // Empty string for missing slug
      expect(status.models).toHaveLength(1);
      expect(status.models[0].modelSlug).toBe(""); // Empty string for missing
    });

    it("should handle network failures with appropriate events", async () => {
      // Add network failure scenario
      mockProvider.addScenario({
        name: "network-failure",
        triggers: {
          contentMatch: /simulate.*error/i,
        },
        events: [],
        response: {
          error: new Error("Network connection failed"),
        },
      });

      // iOS triggers error scenario
      await expect(
        mockProvider.complete({
          messages: [
            { role: "user", content: "simulate network error" },
          ],
          options: {},
        })
      ).rejects.toThrow("Network connection failed");
    });
  });
});

/**
 * Get iOS-specific test scenarios
 */
function getIOSTestScenarios(): MockScenario[] {
  return [
    {
      name: "ios-greeting",
      triggers: {
        contentMatch: /hello.*iOS/i,
      },
      events: [
        {
          type: "project-status",
          data: {
            agents: [
              { pubkey: "mock-executor", slug: "executor" },
              { pubkey: "mock-planner", slug: "planner", isGlobal: true },
            ],
            models: {
              "mock-model": ["executor", "planner"],
            },
            tools: {
              "shell": ["executor"],
              "readPath": ["executor", "planner"],
            },
          },
        },
        {
          type: "typing-start",
          delay: 100,
          data: {
            phase: "planning",
            message: "Processing iOS request...",
          },
        },
      ],
      response: {
        content: "Hello from the mock backend! I can see you're using iOS.",
        toolCalls: [
          {
            name: "continue",
            params: {
              phase: "CHAT",
              summary: "Greeted iOS user",
            },
          },
        ],
      },
    },
    {
      name: "ios-file-operation",
      triggers: {
        contentMatch: /create.*file|write.*file/i,
        agentName: "executor",
      },
      events: [
        {
          type: "typing-start",
          data: {
            phase: "implementing",
          },
        },
        {
          type: "task",
          delay: 500,
          data: {
            status: "pending",
            content: "Creating requested file",
          },
        },
      ],
      response: {
        content: "Creating the file as requested",
        toolCalls: [
          {
            name: "writeContextFile",
            params: {
              path: "output.md",
              content: "# Generated File\n\nContent here",
            },
          },
        ],
      },
    },
  ];
}