import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { configService } from "@/services/ConfigService";
import type { TenexMCP } from "@/services/config/types";
import { MCPService } from "../MCPService";

// Helper to create a simple MCP server for testing
async function createTestMCPServer(serverPath: string) {
  const serverCode = `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server({
    name: "test-mcp-server",
    version: "1.0.0",
}, {
    capabilities: {
        tools: {}
    }
});

// Add test tools
server.setRequestHandler("tools/list", async () => {
    return {
        tools: [
            {
                name: "echo",
                description: "Echoes back the input",
                inputSchema: {
                    type: "object",
                    properties: {
                        message: {
                            type: "string",
                            description: "Message to echo"
                        }
                    },
                    required: ["message"]
                }
            },
            {
                name: "add",
                description: "Adds two numbers",
                inputSchema: {
                    type: "object",
                    properties: {
                        a: { type: "number", description: "First number" },
                        b: { type: "number", description: "Second number" }
                    },
                    required: ["a", "b"]
                }
            }
        ]
    };
});

// Handle tool calls
server.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: args } = request.params;
    
    if (name === "echo") {
        return {
            content: [
                { type: "text", text: \`Echo: \${args.message}\` }
            ]
        };
    } else if (name === "add") {
        const result = args.a + args.b;
        return {
            content: [
                { type: "text", text: \`Result: \${result}\` }
            ]
        };
    }
    
    throw new Error(\`Unknown tool: \${name}\`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
`;

  await fs.mkdir(path.dirname(serverPath), { recursive: true });
  await fs.writeFile(serverPath, serverCode);
}

describe("MCPService Integration Tests", () => {
  const testDir = path.join(process.cwd(), "test-mcp-integration");
  const serverPath = path.join(testDir, "test-server.js");
  const projectPath = path.join(testDir, "project");
  let service: MCPService;

  beforeEach(async () => {
    // Reset singleton
    (MCPService as any).instance = undefined;
    service = MCPService.getInstance();

    // Create test directories
    await fs.mkdir(projectPath, { recursive: true });

    // Create test MCP server
    await createTestMCPServer(serverPath);
  });

  afterEach(async () => {
    // Shutdown service
    await service.shutdown();

    // Clean up test files
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("Real server lifecycle", () => {
    it("should start and communicate with a real MCP server", async () => {
      const mockConfig: TenexMCP = {
        servers: {
          "test-integration": {
            command: "node",
            args: [serverPath],
          },
        },
        enabled: true,
      };

      // Mock config loading
      const loadConfigSpy = spyOn(configService, "loadConfig");
      loadConfigSpy.mockResolvedValue({ mcp: mockConfig });

      // Initialize service
      await service.initialize(projectPath);

      // Verify server is running
      expect(service.isServerRunning("test-integration")).toBe(true);

      // Get available tools
      const tools = await service.getAvailableTools();
      expect(tools).toHaveLength(2);

      // Check tool details
      const echoTool = tools.find((t) => t.name === "test-integration/echo");
      expect(echoTool).toBeDefined();
      expect(echoTool?.description).toBe("Echoes back the input");
      expect(echoTool?.parameters).toHaveLength(1);
      expect(echoTool?.parameters[0]).toEqual({
        name: "message",
        type: "string",
        description: "Message to echo",
        required: true,
      });

      const addTool = tools.find((t) => t.name === "test-integration/add");
      expect(addTool).toBeDefined();
      expect(addTool?.description).toBe("Adds two numbers");
      expect(addTool?.parameters).toHaveLength(2);
    });

    it("should execute tools on the server", async () => {
      const mockConfig: TenexMCP = {
        servers: {
          "test-integration": {
            command: "node",
            args: [serverPath],
          },
        },
        enabled: true,
      };

      const loadConfigSpy = spyOn(configService, "loadConfig");
      loadConfigSpy.mockResolvedValue({ mcp: mockConfig });

      await service.initialize(projectPath);

      // Execute echo tool
      const echoResult = await service.executeTool("test-integration/echo", {
        message: "Hello MCP!",
      });
      expect(echoResult).toBe("Echo: Hello MCP!");

      // Execute add tool
      const addResult = await service.executeTool("test-integration/add", {
        a: 5,
        b: 3,
      });
      expect(addResult).toBe("Result: 8");
    });

    it("should handle server crashes gracefully", async () => {
      const mockConfig: TenexMCP = {
        servers: {
          "test-integration": {
            command: "node",
            args: [serverPath],
          },
        },
        enabled: true,
      };

      const loadConfigSpy = spyOn(configService, "loadConfig");
      loadConfigSpy.mockResolvedValue({ mcp: mockConfig });

      await service.initialize(projectPath);

      // Get the process and kill it externally
      const client = (service as any).clients.get("test-integration");
      expect(client).toBeDefined();

      // Kill the process
      client.process.kill("SIGKILL");

      // Wait a bit for the process to die
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Server should no longer be running
      expect(service.isServerRunning("test-integration")).toBe(false);

      // Tool execution should fail
      await expect(
        service.executeTool("test-integration/echo", { message: "test" })
      ).rejects.toThrow("Server 'test-integration' is not running");
    });

    it("should manage multiple servers concurrently", async () => {
      // Create a second test server
      const server2Path = path.join(testDir, "test-server2.js");
      await createTestMCPServer(server2Path);

      const mockConfig: TenexMCP = {
        servers: {
          server1: {
            command: "node",
            args: [serverPath],
          },
          server2: {
            command: "node",
            args: [server2Path],
          },
        },
        enabled: true,
      };

      const loadConfigSpy = spyOn(configService, "loadConfig");
      loadConfigSpy.mockResolvedValue({ mcp: mockConfig });

      await service.initialize(projectPath);

      // Both servers should be running
      expect(service.isServerRunning("server1")).toBe(true);
      expect(service.isServerRunning("server2")).toBe(true);

      // Get tools from both servers
      const tools = await service.getAvailableTools();
      expect(tools).toHaveLength(4); // 2 tools from each server

      // Execute tools on both servers
      const result1 = await service.executeTool("server1/echo", {
        message: "From server 1",
      });
      expect(result1).toBe("Echo: From server 1");

      const result2 = await service.executeTool("server2/echo", {
        message: "From server 2",
      });
      expect(result2).toBe("Echo: From server 2");

      // Shutdown should stop both servers
      await service.shutdown();
      expect(service.isServerRunning("server1")).toBe(false);
      expect(service.isServerRunning("server2")).toBe(false);
    });
  });

  describe("Error scenarios", () => {
    it("should handle server that fails to start", async () => {
      const mockConfig: TenexMCP = {
        servers: {
          "failing-server": {
            command: "node",
            args: ["/nonexistent/path/server.js"],
          },
        },
        enabled: true,
      };

      const loadConfigSpy = spyOn(configService, "loadConfig");
      loadConfigSpy.mockResolvedValue({ mcp: mockConfig });

      await service.initialize(projectPath);

      // Server should not be running
      expect(service.isServerRunning("failing-server")).toBe(false);

      // No tools should be available
      const tools = await service.getAvailableTools();
      expect(tools).toEqual([]);
    });

    it("should handle server with invalid response", async () => {
      // Create a server that sends invalid JSON
      const badServerCode = `
console.log("This is not valid JSON");
process.stdin.on('data', () => {
    console.log("Still not JSON");
});
`;
      const badServerPath = path.join(testDir, "bad-server.js");
      await fs.writeFile(badServerPath, badServerCode);

      const mockConfig: TenexMCP = {
        servers: {
          "bad-server": {
            command: "node",
            args: [badServerPath],
          },
        },
        enabled: true,
      };

      const loadConfigSpy = spyOn(configService, "loadConfig");
      loadConfigSpy.mockResolvedValue({ mcp: mockConfig });

      await service.initialize(projectPath);

      // Server should fail health check
      expect(service.isServerRunning("bad-server")).toBe(false);
    });
  });

  describe("Security and paths", () => {
    it("should enforce path restrictions in real server", async () => {
      const allowedPath = path.join(testDir, "allowed");
      const disallowedProject = path.join(testDir, "disallowed");

      await fs.mkdir(allowedPath, { recursive: true });
      await fs.mkdir(disallowedProject, { recursive: true });

      const mockConfig: TenexMCP = {
        servers: {
          "restricted-server": {
            command: "node",
            args: [serverPath],
            allowedPaths: [allowedPath],
          },
        },
        enabled: true,
      };

      const loadConfigSpy = spyOn(configService, "loadConfig");
      loadConfigSpy.mockResolvedValue({ mcp: mockConfig });

      // Should not start for disallowed project
      await service.initialize(disallowedProject);
      expect(service.isServerRunning("restricted-server")).toBe(false);

      // Reset and try with allowed path
      await service.shutdown();
      (MCPService as any).instance = undefined;
      service = MCPService.getInstance();

      await service.initialize(allowedPath);
      expect(service.isServerRunning("restricted-server")).toBe(true);
    });
  });

  describe("Environment variables", () => {
    it("should pass environment variables to server", async () => {
      // Create a server that checks env vars
      const envServerCode = `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server({
    name: "env-test-server",
    version: "1.0.0",
}, {
    capabilities: {
        tools: {}
    }
});

server.setRequestHandler("tools/list", async () => {
    return {
        tools: [{
            name: "get-env",
            description: "Gets environment variable",
            inputSchema: {
                type: "object",
                properties: {
                    key: { type: "string", description: "Env var name" }
                },
                required: ["key"]
            }
        }]
    };
});

server.setRequestHandler("tools/call", async (request) => {
    const { arguments: args } = request.params;
    const value = process.env[args.key] || "NOT_SET";
    return {
        content: [{ type: "text", text: value }]
    };
});

const transport = new StdioServerTransport();
await server.connect(transport);
`;

      const envServerPath = path.join(testDir, "env-server.js");
      await fs.writeFile(envServerPath, envServerCode);

      const mockConfig: TenexMCP = {
        servers: {
          "env-server": {
            command: "node",
            args: [envServerPath],
            env: {
              CUSTOM_VAR: "custom_value",
              TEST_API_KEY: "secret123",
            },
          },
        },
        enabled: true,
      };

      const loadConfigSpy = spyOn(configService, "loadConfig");
      loadConfigSpy.mockResolvedValue({ mcp: mockConfig });

      await service.initialize(projectPath);

      // Check custom env var
      const customResult = await service.executeTool("env-server/get-env", {
        key: "CUSTOM_VAR",
      });
      expect(customResult).toBe("custom_value");

      const apiKeyResult = await service.executeTool("env-server/get-env", {
        key: "TEST_API_KEY",
      });
      expect(apiKeyResult).toBe("secret123");

      // Check that process env is also available
      const pathResult = await service.executeTool("env-server/get-env", {
        key: "PATH",
      });
      expect(pathResult).not.toBe("NOT_SET");
    });
  });
});
