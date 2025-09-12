import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { MCPManager } from "../MCPManager";
import { configService } from "@/services";
import { experimental_createMCPClient } from "ai";
import { Experimental_StdioMCPTransport } from "ai/mcp-stdio";

// Mock modules
mock.module("@/services", () => ({
  configService: {
    loadConfig: mock(),
  },
}));

mock.module("ai", () => ({
  experimental_createMCPClient: mock(),
}));

mock.module("ai/mcp-stdio", () => ({
  Experimental_StdioMCPTransport: mock(),
}));

describe("MCPManager", () => {
  let manager: MCPManager;
  let mockTransport: any;
  let mockClient: any;

  beforeEach(() => {
    // Reset singleton instance
    (MCPManager as any).instance = undefined;
    
    // Create mock transport
    mockTransport = {
      close: mock().mockResolvedValue(undefined),
    };

    // Create mock client
    mockClient = {
      tools: mock().mockResolvedValue({
        "test-tool": {
          description: "A test tool",
          parameters: {
            type: "object",
            properties: {
              input: { type: "string", description: "Test input" },
            },
            required: ["input"],
          },
          execute: mock().mockResolvedValue("Tool result"),
        },
      }),
    };

    // Setup mocks
    (Experimental_StdioMCPTransport as any).mockImplementation(() => mockTransport);
    (experimental_createMCPClient as any).mockResolvedValue(mockClient);
    
    manager = MCPManager.getInstance();
  });

  afterEach(async () => {
    if (manager) {
      await manager.shutdown();
    }
    mock.restore();
  });

  describe("getInstance", () => {
    it("should return singleton instance", () => {
      const instance1 = MCPManager.getInstance();
      const instance2 = MCPManager.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe("initialize", () => {
    it("should start MCP servers from config", async () => {
      const mockConfig = {
        mcp: {
          enabled: true,
          servers: {
            "test-server": {
              command: "node",
              args: ["test-server.js"],
              description: "Test server",
            },
          },
        },
      };

      (configService.loadConfig as any).mockResolvedValue(mockConfig);

      await manager.initialize("/test/project");

      expect(Experimental_StdioMCPTransport).toHaveBeenCalledWith({
        command: "node",
        args: ["test-server.js"],
        env: expect.any(Object),
        cwd: "/test/project",
      });

      expect(experimental_createMCPClient).toHaveBeenCalledWith({
        transport: mockTransport,
        name: "tenex-test-server",
        version: "1.0.0",
      });
    });

    it("should skip initialization if MCP is disabled", async () => {
      const mockConfig = {
        mcp: {
          enabled: false,
          servers: {},
        },
      };

      (configService.loadConfig as any).mockResolvedValue(mockConfig);

      await manager.initialize("/test/project");

      expect(Experimental_StdioMCPTransport).not.toHaveBeenCalled();
      expect(experimental_createMCPClient).not.toHaveBeenCalled();
    });
  });

  describe("getCachedTools", () => {
    beforeEach(async () => {
      const mockConfig = {
        mcp: {
          enabled: true,
          servers: {
            "test-server": {
              command: "node",
              args: ["test.js"],
            },
          },
        },
      };

      (configService.loadConfig as any).mockResolvedValue(mockConfig);
      await manager.initialize("/test/project");
    });

    it("should return namespaced tools as an object", () => {
      const tools = manager.getCachedTools();
      
      expect(tools).toBeObject();
      expect(tools["mcp__test-server__test-tool"]).toBeDefined();
      expect(tools["mcp__test-server__test-tool"].description).toBeTruthy();
      expect(tools["mcp__test-server__test-tool"].parameters).toBeDefined();
      expect(tools["mcp__test-server__test-tool"].execute).toBeFunction();
    });
  });

  describe("getToolsForAgent", () => {
    beforeEach(async () => {
      const mockConfig = {
        mcp: {
          enabled: true,
          servers: {
            "server1": {
              command: "node",
              args: ["server1.js"],
            },
          },
        },
      };

      (configService.loadConfig as any).mockResolvedValue(mockConfig);
      
      // Mock multiple tools
      mockClient.tools.mockResolvedValue({
        "tool1": {
          description: "Tool 1",
          execute: mock(),
        },
        "tool2": {
          description: "Tool 2",
          execute: mock(),
        },
      });

      await manager.initialize("/test/project");
    });

    it("should return only requested MCP tools", async () => {
      const requestedTools = ["mcp__server1__tool1"];
      const tools = await manager.getToolsForAgent(requestedTools, true);
      
      expect(Object.keys(tools)).toEqual(["mcp__server1__tool1"]);
    });

    it("should return all MCP tools when none specifically requested", async () => {
      const requestedTools: string[] = [];
      const tools = await manager.getToolsForAgent(requestedTools, true);
      
      expect(Object.keys(tools)).toContain("mcp__server1__tool1");
      expect(Object.keys(tools)).toContain("mcp__server1__tool2");
    });

    it("should return empty object when MCP is disabled for agent", async () => {
      const requestedTools = ["mcp__server1__tool1"];
      const tools = await manager.getToolsForAgent(requestedTools, false);
      
      expect(Object.keys(tools)).toHaveLength(0);
    });
  });

  describe("shutdown", () => {
    it("should close all transports", async () => {
      const mockConfig = {
        mcp: {
          enabled: true,
          servers: {
            "server1": {
              command: "node",
              args: ["server1.js"],
            },
            "server2": {
              command: "node",
              args: ["server2.js"],
            },
          },
        },
      };

      (configService.loadConfig as any).mockResolvedValue(mockConfig);
      await manager.initialize("/test/project");
      
      await manager.shutdown();
      
      expect(mockTransport.close).toHaveBeenCalledTimes(2);
      expect(manager.getRunningServers()).toEqual([]);
    });
  });
});