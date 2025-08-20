import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NDKMCPTool } from "@/events/NDKMCPTool";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import {
  getInstalledMCPEventIds,
  installMCPServerFromEvent,
  isMCPToolInstalled,
  removeMCPServerByEventId,
} from "../mcpInstaller";

describe("mcpInstaller", () => {
  let tempDir: string;
  let projectPath: string;

  beforeEach(async () => {
    // Create a temporary directory for testing
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
    projectPath = tempDir;

    // Create .tenex directory
    await fs.mkdir(path.join(projectPath, ".tenex"), { recursive: true });

    // Create initial empty mcp.json
    const mcpConfig = {
      enabled: true,
      servers: {},
    };
    await fs.writeFile(
      path.join(projectPath, ".tenex", "mcp.json"),
      JSON.stringify(mcpConfig, null, 2)
    );
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("installMCPServerFromEvent", () => {
    it("should install MCP tool with event ID", async () => {
      // Create mock MCP tool event
      const mockEvent: Partial<NDKEvent> = {
        id: "test-event-123",
        pubkey: "test-pubkey",
        created_at: Date.now(),
        kind: 4200,
        tags: [
          ["name", "Test Tool"],
          ["slug", "test-tool"],
          ["description", "A test MCP tool"],
          ["command", "node test-server.js --arg1"],
        ],
        content: "",
        sig: "test-sig",
      };

      const mcpTool = NDKMCPTool.from(mockEvent as NDKEvent);

      // Install the tool
      await installMCPServerFromEvent(projectPath, mcpTool);

      // Verify it was installed
      const mcpConfig = JSON.parse(
        await fs.readFile(path.join(projectPath, ".tenex", "mcp.json"), "utf-8")
      );

      expect(mcpConfig.servers["test-tool"]).toBeDefined();
      expect(mcpConfig.servers["test-tool"].command).toBe("node");
      expect(mcpConfig.servers["test-tool"].args).toEqual(["test-server.js", "--arg1"]);
      expect(mcpConfig.servers["test-tool"].eventId).toBe("test-event-123");
    });

    it("should not duplicate install if event ID already exists", async () => {
      const mockEvent: Partial<NDKEvent> = {
        id: "test-event-456",
        pubkey: "test-pubkey",
        created_at: Date.now(),
        kind: 4200,
        tags: [
          ["name", "Test Tool 2"],
          ["slug", "test-tool-2"],
          ["command", "python server.py"],
        ],
        content: "",
        sig: "test-sig",
      };

      const mcpTool = NDKMCPTool.from(mockEvent as NDKEvent);

      // Install once
      await installMCPServerFromEvent(projectPath, mcpTool);

      // Try to install again
      await installMCPServerFromEvent(projectPath, mcpTool);

      // Should still only have one entry
      const mcpConfig = JSON.parse(
        await fs.readFile(path.join(projectPath, ".tenex", "mcp.json"), "utf-8")
      );

      const serverCount = Object.keys(mcpConfig.servers).length;
      expect(serverCount).toBe(1);
    });
  });

  describe("isMCPToolInstalled", () => {
    it("should return true for installed tools with event IDs", async () => {
      // Use the actual installer to add a tool with event ID
      const mockEvent: Partial<NDKEvent> = {
        id: "event-789",
        pubkey: "test-pubkey",
        created_at: Date.now(),
        kind: 4200,
        tags: [
          ["name", "Test Tool 3"],
          ["slug", "test-tool-3"],
          ["command", "node server.js"],
        ],
        content: "",
        sig: "test-sig",
      };

      const mcpTool = NDKMCPTool.from(mockEvent as NDKEvent);
      await installMCPServerFromEvent(projectPath, mcpTool);

      const isInstalled = await isMCPToolInstalled(projectPath, "event-789");
      expect(isInstalled).toBe(true);
    });

    it("should return false for non-installed event IDs", async () => {
      const isInstalled = await isMCPToolInstalled(projectPath, "non-existent");
      expect(isInstalled).toBe(false);
    });

    it("should handle tools without event IDs", async () => {
      // Add a manually installed tool without event ID
      const mcpConfig = {
        enabled: true,
        servers: {
          "manual-tool": {
            command: "bash",
            args: ["script.sh"],
            // No eventId field
          },
        },
      };
      await fs.writeFile(
        path.join(projectPath, ".tenex", "mcp.json"),
        JSON.stringify(mcpConfig, null, 2)
      );

      const isInstalled = await isMCPToolInstalled(projectPath, "some-event-id");
      expect(isInstalled).toBe(false);
    });
  });

  describe("getInstalledMCPEventIds", () => {
    it("should return only event IDs that exist", async () => {
      // Install tools using the actual installer
      const mockEvent1: Partial<NDKEvent> = {
        id: "event-abc",
        pubkey: "test-pubkey",
        created_at: Date.now(),
        kind: 4200,
        tags: [
          ["name", "Tool With ID"],
          ["slug", "tool-with-id"],
          ["command", "node server1.js"],
        ],
        content: "",
        sig: "test-sig",
      };

      const mockEvent2: Partial<NDKEvent> = {
        id: "event-def",
        pubkey: "test-pubkey",
        created_at: Date.now(),
        kind: 4200,
        tags: [
          ["name", "Another With ID"],
          ["slug", "another-with-id"],
          ["command", "deno server3.ts"],
        ],
        content: "",
        sig: "test-sig",
      };

      const mcpTool1 = NDKMCPTool.from(mockEvent1 as NDKEvent);
      const mcpTool2 = NDKMCPTool.from(mockEvent2 as NDKEvent);

      await installMCPServerFromEvent(projectPath, mcpTool1);
      await installMCPServerFromEvent(projectPath, mcpTool2);

      // Also manually add a tool without event ID using configService
      const { configService } = await import("@/services/ConfigService");
      const tenexPath = configService.getProjectPath(projectPath);
      const mcpConfig = await configService.loadTenexMCP(tenexPath);
      mcpConfig.servers["manual-tool"] = {
        command: "python",
        args: ["server2.py"],
        // No eventId
      };
      await configService.saveProjectMCP(projectPath, mcpConfig);

      const eventIds = await getInstalledMCPEventIds(projectPath);
      expect(eventIds.size).toBe(2);
      expect(eventIds.has("event-abc")).toBe(true);
      expect(eventIds.has("event-def")).toBe(true);
    });
  });

  describe("removeMCPServerByEventId", () => {
    it("should remove server with matching event ID", async () => {
      // Install tools first
      const mockEvent1: Partial<NDKEvent> = {
        id: "remove-me",
        pubkey: "test-pubkey",
        created_at: Date.now(),
        kind: 4200,
        tags: [
          ["name", "Tool To Remove"],
          ["slug", "tool-to-remove"],
          ["command", "node server.js"],
        ],
        content: "",
        sig: "test-sig",
      };

      const mockEvent2: Partial<NDKEvent> = {
        id: "keep-me",
        pubkey: "test-pubkey",
        created_at: Date.now(),
        kind: 4200,
        tags: [
          ["name", "Tool To Keep"],
          ["slug", "tool-to-keep"],
          ["command", "python other.py"],
        ],
        content: "",
        sig: "test-sig",
      };

      const mcpTool1 = NDKMCPTool.from(mockEvent1 as NDKEvent);
      const mcpTool2 = NDKMCPTool.from(mockEvent2 as NDKEvent);

      await installMCPServerFromEvent(projectPath, mcpTool1);
      await installMCPServerFromEvent(projectPath, mcpTool2);

      // Now remove one
      await removeMCPServerByEventId(projectPath, "remove-me");

      // Check the result using configService
      const { configService } = await import("@/services/ConfigService");
      const tenexPath = configService.getProjectPath(projectPath);
      const updatedConfig = await configService.loadTenexMCP(tenexPath);

      expect(updatedConfig.servers["tool-to-remove"]).toBeUndefined();
      expect(updatedConfig.servers["tool-to-keep"]).toBeDefined();
    });

    it("should handle non-existent event IDs gracefully", async () => {
      await removeMCPServerByEventId(projectPath, "non-existent");
      // Should not throw
    });
  });
});
