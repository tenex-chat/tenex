import { beforeEach, describe, expect, it, mock } from "bun:test";
import { NDKMCPTool } from "@/events/NDKMCPTool";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKEvent } from "@nostr-dev-kit/ndk";

// Mock data for tests
let mockEventsSet: Set<NDKEvent> = new Set();
let mockFetchEventsError: Error | null = null;

// Mock NDK before imports
mock.module("@/nostr", () => ({
    getNDK: () => ({
        fetchEvents: async () => {
            if (mockFetchEventsError) {
                throw mockFetchEventsError;
            }
            return mockEventsSet;
        },
        subManager: {
            seenEvents: new Map(),
        },
    }),
}));

mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        debug: () => {},
        error: () => {},
    },
}));

import { createMcpDiscoverTool } from "../mcp_discover";
import { createMockExecutionEnvironment } from "@/test-utils";

describe("mcpDiscover tool", () => {
    let mockNDK: Partial<NDK>;

    beforeEach(() => {
        mockEventsSet = new Set();
        mockFetchEventsError = null;

        mockNDK = {
            fetchEvents: async () => mockEventsSet,
            subManager: {
                seenEvents: new Map(),
            },
        };
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
        NDKMCPTool.prototype.encode = function (this: NDKMCPTool) {
            return `nevent1${this.id}`;
        };

        mockEventsSet = new Set([mockEvent1, mockEvent2]);

        const context = createMockExecutionEnvironment({
            conversationId: "test-conv",
        });
        const tool = createMcpDiscoverTool(context);
        const result = await tool.execute({ limit: 10 });

        expect(result.toolsFound).toBe(2);
        expect(result.markdown).toBeDefined();

        // Check that markdown contains the expected content
        const markdown = result.markdown || "";

        // Check header
        expect(markdown).toContain("# MCP Tool Discovery Results");
        expect(markdown).toContain("Found **2** available tools:");

        // Check Database Manager (should be first due to newer timestamp)
        expect(markdown).toContain("## 1. Database Manager");

        // Check Git Helper (should be second)
        expect(markdown).toContain("## 2. Git Helper");
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

        NDKMCPTool.prototype.encode = function (this: NDKMCPTool) {
            return `nevent1${this.id}`;
        };

        mockEventsSet = new Set([mockEvent1, mockEvent2]);

        const context = createMockExecutionEnvironment({
            conversationId: "test-conv",
        });
        const tool = createMcpDiscoverTool(context);
        const result = await tool.execute({ searchText: "git" });

        expect(result.toolsFound).toBe(1);
        expect(result.markdown).toContain("Git Helper");
        expect(result.markdown).not.toContain("Database Manager");
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

        NDKMCPTool.prototype.encode = function (this: NDKMCPTool) {
            return `nevent1${this.id}`;
        };

        mockEventsSet = new Set(mockEvents);

        const context = createMockExecutionEnvironment({
            conversationId: "test-conv",
        });
        const tool = createMcpDiscoverTool(context);
        const result = await tool.execute({ limit: 5 });

        expect(result.toolsFound).toBe(5);
        expect(result.markdown).toContain("Found **5** available tools:");
        // Check that we have exactly 5 tool sections
        const toolSections = (result.markdown || "").match(/## \d+\. Tool \d+/g);
        expect(toolSections?.length).toBe(5);
    });
});
