import { beforeEach, describe, expect, it, mock } from "bun:test";
import { NDKMCPTool } from "@/events/NDKMCPTool";
import { getNDK } from "@/nostr";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ExecutionContext } from "../../types";
import { mcpDiscover } from "../mcp-discover";

// Mock dependencies
mock.module("@/nostr", () => ({
  getNDK: mock(),
}));

mock.module("@/utils/logger", () => ({
  logger: {
    info: mock(),
    debug: mock(),
    error: mock(),
  },
}));

describe("mcpDiscover tool", () => {
  let mockNDK: Partial<NDK>;
  let mockFetchEvents: ReturnType<typeof mock>;

  beforeEach(() => {
    mock.restore();

    mockFetchEvents = mock();
    mockNDK = {
      fetchEvents: mockFetchEvents,
      subManager: {
        seenEvents: new Map(),
      },
    };

    const mockedGetNDK = getNDK as ReturnType<typeof mock>;
    mockedGetNDK.mockReturnValue(mockNDK as NDK);
  });

  it("should discover MCP tools from the network", async () => {
    // Create mock NDKMCPTool events
    const mockEvent1 = new NDKEvent(mockNDK as NDK);
    mockEvent1.id = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    mockEvent1.kind = 4200;
    mockEvent1.pubkey = "pubkey1";
    mockEvent1.created_at = 1700000000;
    mockEvent1.tags = [
      ["name", "Git Helper"],
      ["description", "A tool for managing git repositories"],
      ["command", "mcp-server-git"],
      ["image", "docker:git-helper"],
    ];

    const mockEvent2 = new NDKEvent(mockNDK as NDK);
    mockEvent2.id = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    mockEvent2.kind = 4200;
    mockEvent2.pubkey = "pubkey2";
    mockEvent2.created_at = 1700000100;
    mockEvent2.tags = [
      ["name", "Database Manager"],
      ["description", "Tool for database operations"],
      ["command", "mcp-server-sqlite"],
    ];

    // Override the encode method to avoid accessing NDK internals
    const _originalEncode = NDKMCPTool.prototype.encode;
    NDKMCPTool.prototype.encode = function (this: NDKMCPTool) {
      return `nevent1${this.id}`;
    };

    const mockEventsSet = new Set([mockEvent1, mockEvent2]);
    mockFetchEvents.mockResolvedValue(mockEventsSet);

    const input = { value: { limit: 10 } };
    const context: ExecutionContext = {
      agentId: "test-agent",
      conversationId: "test-conv",
    };

    const result = await mcpDiscover.execute(input, context);

    if (!result.ok) {
      console.error("Test failed with error:", result.error);
    }
    expect(result.ok).toBe(true);
    expect(result.value?.toolsFound).toBe(2);
    expect(result.value?.markdown).toBeDefined();

    // Check that markdown contains the expected content
    const markdown = result.value?.markdown || "";

    // Check header
    expect(markdown).toContain("# MCP Tool Discovery Results");
    expect(markdown).toContain("Found **2** available tools:");

    // Check Database Manager (should be first due to newer timestamp)
    expect(markdown).toContain("## 1. Database Manager");
    expect(markdown).toContain("**Description:** Tool for database operations");
    expect(markdown).toContain("**Command:** `mcp-server-sqlite`");
    expect(markdown).toMatch(/\*\*Nostr ID:\*\* `note1[^`]+`/);

    // Check Git Helper (should be second)
    expect(markdown).toContain("## 2. Git Helper");
    expect(markdown).toContain("**Description:** A tool for managing git repositories");
    expect(markdown).toContain("**Command:** `mcp-server-git`");
    expect(markdown).toContain("**Image:** `docker:git-helper`");

    // Check installation instructions
    expect(markdown).toContain("## Installation Instructions");
    expect(markdown).toContain("To request installation of any of these tools:");

    // Verify the filter used
    expect(mockFetchEvents).toHaveBeenCalledWith(
      {
        kinds: [4200],
      },
      {
        closeOnEose: true,
        groupable: false,
      }
    );
  });

  it("should filter tools by search text", async () => {
    const mockEvent1 = new NDKEvent(mockNDK as NDK);
    mockEvent1.id = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    mockEvent1.kind = 4200;
    mockEvent1.pubkey = "pubkey1";
    mockEvent1.tags = [
      ["name", "Git Helper"],
      ["description", "A tool for managing git repositories"],
    ];

    const mockEvent2 = new NDKEvent(mockNDK as NDK);
    mockEvent2.id = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    mockEvent2.kind = 4200;
    mockEvent2.pubkey = "pubkey2";
    mockEvent2.tags = [
      ["name", "Database Manager"],
      ["description", "Tool for database operations"],
    ];

    NDKMCPTool.prototype.encode = mock().mockImplementation(function (this: NDKMCPTool) {
      return `nevent1${this.id}`;
    });

    const mockEventsSet = new Set([mockEvent1, mockEvent2]);
    mockFetchEvents.mockResolvedValue(mockEventsSet);

    const input = { value: { searchText: "git" } };
    const context: ExecutionContext = {
      agentId: "test-agent",
      conversationId: "test-conv",
    };

    const result = await mcpDiscover.execute(input, context);

    if (!result.ok) {
      console.error("Test failed with error:", result.error);
    }
    expect(result.ok).toBe(true);
    expect(result.value?.toolsFound).toBe(1);
    expect(result.value?.markdown).toContain("Git Helper");
    expect(result.value?.markdown).not.toContain("Database Manager");
  });

  it("should handle errors gracefully", async () => {
    mockFetchEvents.mockRejectedValue(new Error("Network error"));

    const input = { value: {} };
    const context: ExecutionContext = {
      agentId: "test-agent",
      conversationId: "test-conv",
    };

    const result = await mcpDiscover.execute(input, context);

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      kind: "execution",
      tool: "mcp_discover",
      message: "Network error",
    });
  });

  it("should limit results according to limit parameter", async () => {
    const mockEvents = [];
    for (let i = 0; i < 10; i++) {
      const event = new NDKEvent(mockNDK as NDK);
      // Generate valid hex ID
      const hexId = ("0".repeat(64) + i.toString(16)).slice(-64);
      event.id = hexId;
      event.kind = 4200;
      event.pubkey = `pubkey${i}`;
      event.tags = [["name", `Tool ${i}`]];
      mockEvents.push(event);
    }

    NDKMCPTool.prototype.encode = mock().mockImplementation(function (this: NDKMCPTool) {
      return `nevent1${this.id}`;
    });

    const mockEventsSet = new Set(mockEvents);
    mockFetchEvents.mockResolvedValue(mockEventsSet);

    const input = { value: { limit: 5 } };
    const context: ExecutionContext = {
      agentId: "test-agent",
      conversationId: "test-conv",
    };

    const result = await mcpDiscover.execute(input, context);

    if (!result.ok) {
      console.error("Test failed with error:", result.error);
    }
    expect(result.ok).toBe(true);
    expect(result.value?.toolsFound).toBe(5);
    expect(result.value?.markdown).toContain("Found **5** available tools:");
    // Check that we have exactly 5 tool sections
    const toolSections = (result.value?.markdown || "").match(/## \d+\. Tool \d+/g);
    expect(toolSections?.length).toBe(5);
  });
});
