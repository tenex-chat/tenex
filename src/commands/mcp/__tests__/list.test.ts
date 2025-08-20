import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { TenexConfig } from "@/services/config/types";
import chalk from "chalk";
import { Command } from "commander";
import { listCommand } from "../list";

// Mock modules
mock.module("@/services/ConfigService", () => ({
  configService: {
    loadConfig: mock(),
    getProjectPath: mock(),
    projectConfigExists: mock(),
    getGlobalPath: mock(),
    loadTenexMCP: mock(),
  },
}));

// Mock console methods
const originalConsoleLog = console.log;
const mockConsoleLog = mock();

describe("MCP list command", () => {
  let program: Command;
  let mockGlobalConfig: Partial<TenexConfig>;
  let mockProjectConfig: Partial<TenexConfig>;

  // Helper to set up configService mocks
  async function setupConfigServiceMocks() {
    const { configService } = await import("@/services/ConfigService");
    (configService.getGlobalPath as any).mockReturnValue("/global/path");
    return configService;
  }

  beforeEach(() => {
    // Reset mocks
    mockConsoleLog.mockReset();
    console.log = mockConsoleLog;

    // Default mock configs
    mockGlobalConfig = {
      mcp: {
        servers: {
          "global-server1": {
            command: "node",
            args: ["global1.js"],
            description: "Global server 1",
          },
          "global-server2": {
            command: "python",
            args: ["global2.py"],
            allowedPaths: ["/global/path"],
          },
        },
        enabled: true,
      },
    };

    mockProjectConfig = {
      mcp: {
        servers: {
          "project-server1": {
            command: "bun",
            args: ["project1.ts"],
            description: "Project server 1",
            env: { API_KEY: "secret" },
          },
          "project-server2": {
            command: "deno",
            args: ["run", "project2.ts"],
            allowedPaths: ["/project/path1", "/project/path2"],
          },
        },
        enabled: true,
      },
    };

    // Create commander program
    program = new Command();
    program.exitOverride();
    const mcpCommand = new Command("mcp").description("Manage MCP servers");
    mcpCommand.addCommand(listCommand);
    program.addCommand(mcpCommand);
  });

  afterEach(() => {
    console.log = originalConsoleLog;
  });

  describe("list all servers", () => {
    it("should list both global and project servers", async () => {
      const configService = await setupConfigServiceMocks();
      (configService.projectConfigExists as any).mockResolvedValue(true);
      (configService.getProjectPath as any).mockReturnValue("/test/project");
      (configService.loadConfig as any).mockResolvedValue(mockProjectConfig); // Main config
      (configService.loadTenexMCP as any)
        .mockResolvedValueOnce(mockGlobalConfig.mcp) // Global MCP
        .mockResolvedValueOnce(mockProjectConfig.mcp); // Project MCP

      await program.parseAsync(["node", "test", "mcp", "list"]);

      // Check that logger.info was called
      expect(mockConsoleLog).toHaveBeenCalled();

      // Get the actual calls and convert to plain text
      const allOutput = mockConsoleLog.mock.calls.map((call) => call[0]).join("\n");

      // Check that key information is present in the output
      expect(allOutput).toContain("Configured MCP Servers");
      expect(allOutput).toContain("Global servers");
      expect(allOutput).toContain("Project servers");

      // Check global servers
      expect(allOutput).toContain("global-server1");
      expect(allOutput).toContain("Command:");
      expect(allOutput).toContain("node global1.js");
      expect(allOutput).toContain("Description: Global server 1");

      expect(allOutput).toContain("global-server2");
      expect(allOutput).toContain("python global2.py");
      expect(allOutput).toContain("Allowed paths: /global/path");

      // Check project servers
      expect(allOutput).toContain("project-server1");
      expect(allOutput).toContain("bun project1.ts");
      expect(allOutput).toContain("Environment: API_KEY");

      expect(allOutput).toContain("project-server2");
      expect(allOutput).toContain("deno run project2.ts");
      expect(allOutput).toContain("Allowed paths: /project/path1, /project/path2");

      // Check status footer
      expect(allOutput).toContain("MCP enabled:");
      expect(allOutput).toContain("Total servers:");
    });

    it("should show only global servers when not in a project", async () => {
      const configService = await setupConfigServiceMocks();
      (configService.projectConfigExists as any).mockResolvedValue(false);
      (configService.getProjectPath as any).mockReturnValue(undefined);
      (configService.loadConfig as any).mockResolvedValue(mockGlobalConfig);

      await program.parseAsync(["node", "test", "mcp", "list"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(chalk.bold.cyan("\nGlobal MCP Servers:"));
      expect(mockConsoleLog).not.toHaveBeenCalledWith(chalk.bold.cyan("\nProject MCP Servers:"));

      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("global-server1"));
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("global-server2"));
    });

    it("should show message when no servers configured", async () => {
      const configService = await setupConfigServiceMocks();
      (configService.projectConfigExists as any).mockResolvedValue(true);
      (configService.getProjectPath as any).mockReturnValue("/test/project");
      (configService.loadConfig as any)
        .mockResolvedValueOnce({}) // No global config
        .mockResolvedValueOnce({}); // No project config

      await program.parseAsync(["node", "test", "mcp", "list"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        chalk.yellow("No MCP servers configured globally")
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        chalk.yellow("No MCP servers configured for this project")
      );
    });

    it("should handle MCP disabled globally", async () => {
      const configService = await setupConfigServiceMocks();
      (configService.projectConfigExists as any).mockResolvedValue(true);
      (configService.getProjectPath as any).mockReturnValue("/test/project");

      const disabledGlobalConfig = {
        ...mockGlobalConfig,
        mcp: {
          ...mockGlobalConfig.mcp!,
          enabled: false,
        },
      };

      (configService.loadConfig as any)
        .mockResolvedValueOnce(disabledGlobalConfig)
        .mockResolvedValueOnce(mockProjectConfig);

      await program.parseAsync(["node", "test", "mcp", "list"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        chalk.yellow("No MCP servers configured globally")
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("project-server1"));
    });

    it("should handle empty server lists", async () => {
      const configService = await setupConfigServiceMocks();
      (configService.projectConfigExists as any).mockResolvedValue(true);
      (configService.getProjectPath as any).mockReturnValue("/test/project");

      const emptyConfig = {
        mcp: {
          servers: {},
          enabled: true,
        },
      };

      (configService.loadConfig as any)
        .mockResolvedValueOnce(emptyConfig)
        .mockResolvedValueOnce(emptyConfig);

      await program.parseAsync(["node", "test", "mcp", "list"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        chalk.yellow("No MCP servers configured globally")
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        chalk.yellow("No MCP servers configured for this project")
      );
    });
  });

  describe("list with --global flag", () => {
    it("should list only global servers", async () => {
      const configService = await setupConfigServiceMocks();
      (configService.projectConfigExists as any).mockResolvedValue(true);
      (configService.getProjectPath as any).mockReturnValue("/test/project");
      (configService.loadConfig as any).mockResolvedValue(mockGlobalConfig);

      await program.parseAsync(["node", "test", "mcp", "list", "--global"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(chalk.bold.cyan("\nGlobal MCP Servers:"));
      expect(mockConsoleLog).not.toHaveBeenCalledWith(chalk.bold.cyan("\nProject MCP Servers:"));

      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("global-server1"));
      expect(mockConsoleLog).not.toHaveBeenCalledWith(expect.stringContaining("project-server1"));
    });
  });

  describe("list with --project flag", () => {
    it("should list only project servers", async () => {
      const configService = await setupConfigServiceMocks();
      (configService.projectConfigExists as any).mockResolvedValue(true);
      (configService.getProjectPath as any).mockReturnValue("/test/project");
      (configService.loadConfig as any).mockResolvedValue(mockProjectConfig);

      await program.parseAsync(["node", "test", "mcp", "list", "--project"]);

      expect(mockConsoleLog).not.toHaveBeenCalledWith(chalk.bold.cyan("\nGlobal MCP Servers:"));
      expect(mockConsoleLog).toHaveBeenCalledWith(chalk.bold.cyan("\nProject MCP Servers:"));

      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("project-server1"));
      expect(mockConsoleLog).not.toHaveBeenCalledWith(expect.stringContaining("global-server1"));
    });

    it("should show error when --project used outside project", async () => {
      const configService = await setupConfigServiceMocks();
      (configService.projectConfigExists as any).mockResolvedValue(false);
      (configService.getProjectPath as any).mockReturnValue(undefined);

      await program.parseAsync(["node", "test", "mcp", "list", "--project"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(chalk.yellow("Not in a TENEX project directory"));
    });
  });

  describe("formatting", () => {
    it("should format servers without optional fields", async () => {
      const configService = await setupConfigServiceMocks();
      (configService.projectConfigExists as any).mockResolvedValue(false);
      (configService.getProjectPath as any).mockReturnValue(undefined);

      const minimalConfig = {
        mcp: {
          servers: {
            "minimal-server": {
              command: "node",
              args: ["server.js"],
            },
          },
          enabled: true,
        },
      };

      (configService.loadConfig as any).mockResolvedValue(minimalConfig);

      await program.parseAsync(["node", "test", "mcp", "list"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("minimal-server"));
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Command: node server.js")
      );

      // Should not show these optional fields
      expect(mockConsoleLog).not.toHaveBeenCalledWith(expect.stringContaining("Description:"));
      expect(mockConsoleLog).not.toHaveBeenCalledWith(expect.stringContaining("Allowed Paths:"));
      expect(mockConsoleLog).not.toHaveBeenCalledWith(expect.stringContaining("Environment:"));
    });

    it("should format multiple environment variables", async () => {
      const configService = await setupConfigServiceMocks();
      (configService.projectConfigExists as any).mockResolvedValue(false);
      (configService.getProjectPath as any).mockReturnValue(undefined);

      const envConfig = {
        mcp: {
          servers: {
            "env-server": {
              command: "node",
              args: ["server.js"],
              env: {
                API_KEY: "secret",
                PORT: "8080",
                DEBUG: "true",
              },
            },
          },
          enabled: true,
        },
      };

      (configService.loadConfig as any).mockResolvedValue(envConfig);

      await program.parseAsync(["node", "test", "mcp", "list"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Environment: API_KEY, PORT, DEBUG")
      );
    });

    it("should handle command with no args", async () => {
      const configService = await setupConfigServiceMocks();
      (configService.projectConfigExists as any).mockResolvedValue(false);
      (configService.getProjectPath as any).mockReturnValue(undefined);

      const noArgsConfig = {
        mcp: {
          servers: {
            "noargs-server": {
              command: "simple-server",
              args: [],
            },
          },
          enabled: true,
        },
      };

      (configService.loadConfig as any).mockResolvedValue(noArgsConfig);

      await program.parseAsync(["node", "test", "mcp", "list"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Command: simple-server")
      );
    });
  });

  describe("error handling", () => {
    it("should handle config load errors gracefully", async () => {
      const configService = await setupConfigServiceMocks();
      (configService.projectConfigExists as any).mockResolvedValue(true);
      (configService.getProjectPath as any).mockReturnValue("/test/project");
      (configService.loadConfig as any).mockRejectedValue(new Error("Config error"));

      await program.parseAsync(["node", "test", "mcp", "list"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        chalk.yellow("No MCP servers configured globally")
      );
    });

    it("should handle undefined args gracefully", async () => {
      const configService = await setupConfigServiceMocks();
      (configService.projectConfigExists as any).mockResolvedValue(false);
      (configService.getProjectPath as any).mockReturnValue(undefined);

      const malformedConfig = {
        mcp: {
          servers: {
            "malformed-server": {
              command: "node",
              // Missing args field
            },
          },
          enabled: true,
        },
      };

      (configService.loadConfig as any).mockResolvedValue(malformedConfig);

      await program.parseAsync(["node", "test", "mcp", "list"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("Command: node"));
    });
  });
});
