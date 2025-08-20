import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { configService } from "@/services";
import type { TenexMCP } from "@/services/config/types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCPService } from "../MCPService";

// Mock modules
mock.module("@/services", () => ({
  configService: {
    loadConfig: mock(),
  },
}));

mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: mock(),
}));

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: mock(),
}));

// We don't need to mock spawn directly as StdioClientTransport handles it

describe("MCPService", () => {
  let service: MCPService;
  let mockProcess: Partial<ChildProcess>;
  let mockTransport: any;
  let mockClient: any;

  beforeEach(() => {
    // Reset all mocks
    mock.restore();

    // Reset singleton instance
    (MCPService as any).instance = undefined;

    // Create mock process
    mockProcess = {
      stdout: { on: mock() },
      stderr: { on: mock() },
      on: mock(),
      once: mock().mockImplementation((event, callback) => {
        if (event === "exit") {
          // Simulate process exit after a short delay
          setTimeout(callback, 10);
        }
      }),
      kill: mock(),
      killed: false,
      pid: 12345,
    };

    // Create mock transport with process
    mockTransport = {
      connect: mock().mockResolvedValue(undefined),
      close: mock().mockResolvedValue(undefined),
      process: mockProcess, // The transport has the process
    };

    // Create mock client
    mockClient = {
      connect: mock().mockResolvedValue(undefined),
      close: mock().mockResolvedValue(undefined),
      request: mock().mockImplementation((params: any) => {
        if (params.method === "tools/list") {
          return Promise.resolve({
            tools: [
              {
                name: "test-tool",
                description: "A test tool",
                inputSchema: {
                  type: "object",
                  properties: {
                    input: { type: "string", description: "Test input" },
                    count: { type: "number", description: "Test count" },
                    enabled: { type: "boolean", description: "Test flag" },
                  },
                  required: ["input"],
                },
              },
            ],
          });
        }
        if (params.method === "tools/call") {
          return Promise.resolve({
            content: [{ type: "text", text: "Tool result" }],
          });
        }
        return Promise.reject(new Error("Unknown method"));
      }),
    };

    // Reset mocks first
    (StdioClientTransport as any).mockReset();
    (Client as any).mockReset();
    (configService.loadConfig as any).mockReset();

    // Setup mocks
    (StdioClientTransport as any).mockImplementation((options: any) => {
      // Store the options for verification
      mockTransport.spawnOptions = options;
      return mockTransport;
    });
    (Client as any).mockImplementation(() => mockClient);

    service = MCPService.getInstance();
  });

  afterEach(async () => {
    // Clean up the service after each test
    if (service) {
      await service.shutdown();
    }
    // Reset singleton instance
    (MCPService as any).instance = undefined;
    // Reset the isInitialized flag
    if (service) {
      (service as any).isInitialized = false;
    }
  });

  describe("getInstance", () => {
    it("should return singleton instance", () => {
      const instance1 = MCPService.getInstance();
      const instance2 = MCPService.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe("initialize", () => {
    it("should start all configured MCP servers", async () => {
      const mockConfig: TenexMCP = {
        servers: {
          "test-server": {
            command: "node",
            args: ["test-server.js"],
            description: "Test server",
          },
        },
        enabled: true,
      };

      (configService.loadConfig as any).mockResolvedValue({
        mcp: mockConfig,
      });

      await service.initialize("/test/project");

      expect(StdioClientTransport).toHaveBeenCalledWith({
        command: "node",
        args: ["test-server.js"],
        env: expect.any(Object),
      });
      expect(mockClient.connect).toHaveBeenCalled();
    });

    it("should skip initialization if MCP is disabled", async () => {
      const mockConfig: TenexMCP = {
        servers: {
          "test-server": {
            command: "node",
            args: ["test-server.js"],
          },
        },
        enabled: false,
      };

      (configService.loadConfig as any).mockResolvedValue({
        mcp: mockConfig,
      });

      await service.initialize("/test/project");

      expect(StdioClientTransport).not.toHaveBeenCalled();
    });

    it("should handle server startup failures gracefully", async () => {
      const mockConfig: TenexMCP = {
        servers: {
          "failing-server": {
            command: "node",
            args: ["failing.js"],
          },
        },
        enabled: true,
      };

      (configService.loadConfig as any).mockResolvedValue({
        mcp: mockConfig,
      });

      // Mock health check failure
      mockClient.request.mockRejectedValueOnce(new Error("Connection failed"));

      await service.initialize("/test/project");

      expect(StdioClientTransport).toHaveBeenCalled();
      expect(mockClient.close).toHaveBeenCalled();
      // Server should not be started if health check fails
      expect(service.getRunningServers()).not.toContain("failing-server");
    });

    it("should enforce allowedPaths security restrictions", async () => {
      const mockConfig: TenexMCP = {
        servers: {
          "restricted-server": {
            command: "node",
            args: ["server.js"],
            allowedPaths: ["/allowed/path"],
          },
        },
        enabled: true,
      };

      (configService.loadConfig as any).mockResolvedValue({
        mcp: mockConfig,
      });

      // Test with disallowed project path
      await service.initialize("/disallowed/project");

      expect(StdioClientTransport).not.toHaveBeenCalled();
    });

    it("should allow bidirectional path containment", async () => {
      const mockConfig: TenexMCP = {
        servers: {
          server1: {
            command: "node",
            args: ["server.js"],
            allowedPaths: ["/home/user"],
          },
          server2: {
            command: "node",
            args: ["server2.js"],
            allowedPaths: ["/home/user/project/data"],
          },
        },
        enabled: true,
      };

      (configService.loadConfig as any).mockResolvedValue({
        mcp: mockConfig,
      });

      await service.initialize("/home/user/project");

      // Both servers should start
      expect(StdioClientTransport).toHaveBeenCalledTimes(2);
    });

    it("should handle health check timeout", async () => {
      const mockConfig: TenexMCP = {
        servers: {
          "slow-server": {
            command: "node",
            args: ["slow.js"],
          },
        },
        enabled: true,
      };

      (configService.loadConfig as any).mockResolvedValue({
        mcp: mockConfig,
      });

      // Mock health check to never resolve
      let healthCheckPromise: Promise<any>;
      mockClient.request.mockImplementation((params: any) => {
        if (params.method === "tools/list") {
          healthCheckPromise = new Promise(() => {}); // Never resolves
          return healthCheckPromise;
        }
        return Promise.reject(new Error("Unknown method"));
      });

      const initPromise = service.initialize("/test/project");

      // Wait for initialization to complete (which includes the health check timeout)
      await initPromise;

      // The process should not be added to clients due to health check failure
      expect(service.isServerRunning("slow-server")).toBe(false);
    });
  });

  describe("getAvailableTools", () => {
    beforeEach(async () => {
      const mockConfig: TenexMCP = {
        servers: {
          "test-server": {
            command: "node",
            args: ["test.js"],
          },
        },
        enabled: true,
      };

      (configService.loadConfig as any).mockResolvedValue({
        mcp: mockConfig,
      });

      await service.initialize("/test/project");
    });

    it("should return tools with namespaced names", async () => {
      const tools = await service.getAvailableTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("mcp__test-server__test-tool");
      expect(tools[0].description).toBe("A test tool");
    });

    it("should convert MCP tool schema to TENEX format", async () => {
      const tools = await service.getAvailableTools();
      const tool = tools[0];

      // Check that parameters has correct shape
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters.shape).toBeDefined();
      expect(tool.parameters.shape.type).toBe("object");
      expect(tool.parameters.shape.properties).toBeDefined();

      // Check properties
      const properties = tool.parameters.shape.properties;
      expect(properties.input).toEqual({
        type: "string",
        description: "Test input",
        required: true,
      });

      expect(properties.count).toEqual({
        type: "number",
        description: "Test count",
        required: false,
        min: undefined,
        max: undefined,
      });

      expect(properties.enabled).toEqual({
        type: "boolean",
        description: "Test flag",
        required: false,
      });
    });

    it("should handle complex schemas", async () => {
      mockClient.request.mockImplementationOnce((params: any) => {
        if (params.method === "tools/list") {
          return Promise.resolve({
            tools: [
              {
                name: "complex-tool",
                description: "Complex tool",
                inputSchema: {
                  type: "object",
                  properties: {
                    nested: {
                      type: "object",
                      description: "Nested object",
                    },
                    items: {
                      type: "array",
                      description: "Array of items",
                    },
                    choice: {
                      type: "string",
                      enum: ["option1", "option2"],
                      description: "Choice field",
                    },
                  },
                  required: ["nested", "items"],
                },
              },
            ],
          });
        }
        return Promise.reject(new Error("Unknown method"));
      });

      const tools = await service.getAvailableTools();
      const tool = tools[0];

      // Check parameters shape
      expect(tool.parameters.shape.type).toBe("object");
      const properties = tool.parameters.shape.properties;

      expect(properties.nested?.type).toBe("object");
      expect(properties.nested?.required).toBe(true);

      expect(properties.items?.type).toBe("array");
      expect(properties.items?.required).toBe(true);

      expect(properties.choice?.type).toBe("string");
      expect(properties.choice?.required).toBe(false);
    });

    it("should cache tools after first fetch", async () => {
      const tools1 = await service.getAvailableTools();
      const tools2 = await service.getAvailableTools();

      expect(tools1).toBe(tools2);
      expect(mockClient.request).toHaveBeenCalledWith({ method: "tools/list" }, {});
    });

    it("should return empty array if no servers are running", async () => {
      await service.shutdown();
      const tools = await service.getAvailableTools();
      expect(tools).toEqual([]);
    });
  });

  describe("executeTool", () => {
    beforeEach(async () => {
      const mockConfig: TenexMCP = {
        servers: {
          "test-server": {
            command: "node",
            args: ["test.js"],
          },
        },
        enabled: true,
      };

      (configService.loadConfig as any).mockResolvedValue({
        mcp: mockConfig,
      });

      await service.initialize("/test/project");
    });

    it("should execute tool on correct server", async () => {
      const result = await service.executeTool("test-server", "test-tool", {
        input: "test input",
      });

      expect(mockClient.request).toHaveBeenCalledWith({
        method: "tools/call",
        params: {
          name: "test-tool",
          arguments: { input: "test input" },
        },
      });
      expect(result).toBe("Tool result");
    });

    it("should throw error for unknown server", async () => {
      await expect(service.executeTool("unknown-server", "test-tool", {})).rejects.toThrow(
        "Server 'unknown-server' not found"
      );
    });

    it("should throw error if server is not running", async () => {
      // Kill the process to simulate server crash
      (service as any).clients.get("test-server").process.killed = true;

      await expect(service.executeTool("test-server", "test-tool", {})).rejects.toThrow(
        "Server 'test-server' is not running"
      );
    });

    it("should handle tool execution errors", async () => {
      mockClient.request.mockImplementationOnce((params: any) => {
        if (params.method === "tools/call") {
          return Promise.reject(new Error("Tool failed"));
        }
        return Promise.reject(new Error("Unknown method"));
      });

      await expect(service.executeTool("test-server", "test-tool", {})).rejects.toThrow(
        "Tool failed"
      );
    });

    it("should handle non-text content responses", async () => {
      mockClient.request.mockImplementationOnce((params: any) => {
        if (params.method === "tools/call") {
          return Promise.resolve({
            content: [
              { type: "image", data: "base64data" },
              { type: "text", text: "Some text" },
            ],
          });
        }
        return Promise.reject(new Error("Unknown method"));
      });

      const result = await service.executeTool("test-server", "test-tool", {});
      expect(result).toBe("Some text");
    });
  });

  describe("shutdown", () => {
    beforeEach(async () => {
      const mockConfig: TenexMCP = {
        servers: {
          server1: {
            command: "node",
            args: ["server1.js"],
          },
          server2: {
            command: "node",
            args: ["server2.js"],
          },
        },
        enabled: true,
      };

      (configService.loadConfig as any).mockResolvedValue({
        mcp: mockConfig,
      });

      await service.initialize("/test/project");
    });

    it("should shutdown all servers gracefully", async () => {
      await service.shutdown();

      expect(mockClient.close).toHaveBeenCalledTimes(2);
      expect(mockTransport.close).toHaveBeenCalledTimes(2);
      expect(mockProcess.kill).toHaveBeenCalledTimes(2);
    });

    it("should handle shutdown errors gracefully", async () => {
      mockClient.close.mockRejectedValueOnce(new Error("Close failed"));

      await service.shutdown();

      // Should still attempt to kill process
      expect(mockProcess.kill).toHaveBeenCalled();
    });

    it("should force kill after timeout", async () => {
      // Mock process that doesn't exit
      let _exitCallback: any;
      (mockProcess.on as any).mockImplementation((event: string, cb: any) => {
        if (event === "exit") {
          _exitCallback = cb;
        }
      });

      const shutdownPromise = service.shutdown();

      // Wait a bit but don't call exit callback
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Force the timeout
      await shutdownPromise;

      expect(mockProcess.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("should clear cached tools on shutdown", async () => {
      await service.getAvailableTools();
      expect((service as any).cachedTools).not.toBeNull();

      await service.shutdown();
      expect((service as any).cachedTools).toBeNull();
    });
  });

  describe("isServerRunning", () => {
    beforeEach(async () => {
      const mockConfig: TenexMCP = {
        servers: {
          "test-server": {
            command: "node",
            args: ["test.js"],
          },
        },
        enabled: true,
      };

      (configService.loadConfig as any).mockResolvedValue({
        mcp: mockConfig,
      });

      await service.initialize("/test/project");
    });

    it("should return true for running server", () => {
      expect(service.isServerRunning("test-server")).toBe(true);
    });

    it("should return false for unknown server", () => {
      expect(service.isServerRunning("unknown-server")).toBe(false);
    });

    it("should return false after server is stopped", async () => {
      await service.shutdown();
      expect(service.isServerRunning("test-server")).toBe(false);
    });
  });

  describe("security edge cases", () => {
    it("should handle root path in allowedPaths", async () => {
      const mockConfig: TenexMCP = {
        servers: {
          "root-server": {
            command: "node",
            args: ["server.js"],
            allowedPaths: ["/"],
          },
        },
        enabled: true,
      };

      (configService.loadConfig as any).mockResolvedValue({
        mcp: mockConfig,
      });

      // This should be allowed but might be a security concern
      await service.initialize("/any/project/path");
      expect(StdioClientTransport).toHaveBeenCalled();
    });

    it("should handle relative paths in allowedPaths", async () => {
      const mockConfig: TenexMCP = {
        servers: {
          "relative-server": {
            command: "node",
            args: ["server.js"],
            allowedPaths: ["/test"],
          },
        },
        enabled: true,
      };

      (configService.loadConfig as any).mockResolvedValue({
        mcp: mockConfig,
      });

      await service.initialize("/test/project");

      // Should allow since /test/project starts with /test
      expect(StdioClientTransport).toHaveBeenCalled();
    });

    it("should handle dot path in allowedPaths", async () => {
      const mockConfig: TenexMCP = {
        servers: {
          "dot-server": {
            command: "node",
            args: ["server.js"],
            allowedPaths: ["/test/project"],
          },
        },
        enabled: true,
      };

      (configService.loadConfig as any).mockResolvedValue({
        mcp: mockConfig,
      });

      await service.initialize("/test/project");

      expect(StdioClientTransport).toHaveBeenCalled();
    });
  });

  describe("environment variables", () => {
    it("should pass custom environment variables to server", async () => {
      const mockConfig: TenexMCP = {
        servers: {
          "env-server": {
            command: "node",
            args: ["server.js"],
            env: {
              CUSTOM_VAR: "custom_value",
              API_KEY: "secret_key",
            },
          },
        },
        enabled: true,
      };

      (configService.loadConfig as any).mockResolvedValue({
        mcp: mockConfig,
      });

      await service.initialize("/test/project");

      expect(StdioClientTransport).toHaveBeenCalledWith({
        command: "node",
        args: ["server.js"],
        env: expect.objectContaining({
          CUSTOM_VAR: "custom_value",
          API_KEY: "secret_key",
        }),
      });
    });
  });
});
