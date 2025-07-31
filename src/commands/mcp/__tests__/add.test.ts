import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Command } from "commander";
import { addCommand } from "../add";
import type { TenexConfig } from "@/services/config/types";
import * as fs from "@/lib/fs";
import * as path from "node:path";

// Mock modules
mock.module("@/lib/fs", () => ({
    fileExists: mock(),
    readFile: mock(),
    writeJsonFile: mock(),
    ensureDirectory: mock(),
}));

mock.module("@/services/ConfigService", () => ({
    configService: {
        projectConfigExists: mock(),
        getProjectPath: mock(),
        getGlobalPath: mock(),
        loadTenexMCP: mock(),
        saveProjectMCP: mock(),
        saveGlobalMCP: mock(),
    },
}));

// Mock process.exit
const mockProcessExit = mock();
const originalProcessExit = process.exit;
process.exit = mockProcessExit as any;

// Mock which command validation
const mockWhich = mock();
mock.module("@/lib/shell", () => ({
    which: mockWhich,
}));

// Mock console methods
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const mockConsoleLog = mock();
const mockConsoleError = mock();

describe("MCP add command", () => {
    let program: Command;
    let mockConfig: Partial<TenexConfig>;

    beforeEach(() => {
        // Reset mocks
        (fs.fileExists as any).mockReset();
        (fs.readFile as any).mockReset();
        (fs.writeJsonFile as any).mockReset();
        (fs.ensureDirectory as any).mockReset();
        mockWhich.mockReset();
        mockConsoleLog.mockReset();
        mockConsoleError.mockReset();
        mockProcessExit.mockReset();

        // Replace console methods
        console.log = mockConsoleLog;
        console.error = mockConsoleError;

        // Default mock config
        mockConfig = {
            mcp: {
                servers: {},
                enabled: true,
            },
        };

        // Setup default mocks
        mockWhich.mockResolvedValue("/usr/bin/node");
        (fs.fileExists as any).mockResolvedValue(true);

        // Create commander program with mcp subcommand
        program = new Command();
        program.exitOverride(); // Prevent process.exit during tests

        const mcpCommand = new Command("mcp").description("Manage MCP servers");
        mcpCommand.addCommand(addCommand);
        program.addCommand(mcpCommand);
    });

    afterEach(() => {
        // Restore console methods
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
        process.exit = originalProcessExit;
    });

    describe("command-line mode", () => {
        it("should add a new MCP server with name and command", async () => {
            const { configService } = await import("@/services/ConfigService");
            (configService.projectConfigExists as any).mockResolvedValue(true);
            (configService.getProjectPath as any).mockReturnValue("/test/project");
            (configService.loadTenexMCP as any).mockResolvedValue({
                servers: {},
                enabled: true,
            });
            (configService.saveProjectMCP as any).mockResolvedValue(undefined);

            await program.parseAsync([
                "node",
                "test",
                "mcp",
                "add",
                "test-server",
                "node",
                "test-server.js",
                "--paths",
                "/test/path1,/test/path2",
            ]);

            expect(configService.saveProjectMCP).toHaveBeenCalledWith(
                process.cwd(), // The actual implementation uses process.cwd()
                {
                    servers: {
                        "test-server": {
                            command: "node",
                            args: ["test-server.js"],
                            allowedPaths: ["/test/path1", "/test/path2"],
                        },
                    },
                    enabled: true,
                }
            );

            expect(mockConsoleLog).toHaveBeenCalledWith(
                expect.stringContaining("Added MCP server 'test-server' to project configuration")
            );
        });

        it("should validate server name format", async () => {
            const { configService } = await import("@/services/ConfigService");
            (configService.projectConfigExists as any).mockResolvedValue(true);
            (configService.getProjectPath as any).mockReturnValue("/test/project");
            (configService.loadTenexMCP as any).mockResolvedValue({
                servers: {},
                enabled: true,
            });

            await expect(
                program.parseAsync([
                    "node",
                    "test",
                    "mcp",
                    "add",
                    "invalid-name!",
                    "node",
                    "test.js",
                ])
            ).rejects.toThrow();

            expect(mockConsoleError).toHaveBeenCalledWith(
                expect.stringContaining(
                    "Name can only contain letters, numbers, hyphens, and underscores"
                )
            );
        });

        it("should validate server name uniqueness", async () => {
            const { configService } = await import("@/services/ConfigService");
            (configService.projectConfigExists as any).mockResolvedValue(true);
            (configService.getProjectPath as any).mockReturnValue("/test/project");
            (configService.loadTenexMCP as any).mockResolvedValue({
                servers: {
                    "existing-server": {
                        command: "node",
                        args: ["existing.js"],
                    },
                },
                enabled: true,
            });

            await expect(
                program.parseAsync([
                    "node",
                    "test",
                    "mcp",
                    "add",
                    "existing-server",
                    "node",
                    "new.js",
                ])
            ).rejects.toThrow();

            expect(mockConsoleError).toHaveBeenCalledWith(
                expect.stringContaining("MCP server 'existing-server' already exists")
            );
        });

        it("should validate command exists", async () => {
            mockWhich.mockResolvedValue(null);

            await expect(
                program.parseAsync([
                    "node",
                    "test",
                    "mcp",
                    "add",
                    "test-server",
                    "nonexistent-command",
                ])
            ).rejects.toThrow();

            expect(mockConsoleError).toHaveBeenCalledWith(
                expect.stringContaining("Command not found: nonexistent-command")
            );
        });

        it("should skip validation for special commands", async () => {
            const { configService } = await import("@/services/ConfigService");
            const specialCommands = ["npx", "npm", "bun", "deno", "yarn", "pnpm"];

            for (const cmd of specialCommands) {
                // Reset mocks
                mockWhich.mockReset();
                (configService.projectConfigExists as any).mockResolvedValue(true);
                (configService.getProjectPath as any).mockReturnValue("/test/project");
                (configService.loadTenexMCP as any).mockResolvedValue({
                    servers: {},
                    enabled: true,
                });
                (configService.saveProjectMCP as any).mockResolvedValue(undefined);

                await program.parseAsync([
                    "node",
                    "test",
                    "mcp",
                    "add",
                    `${cmd}-server`,
                    cmd,
                    "some-package",
                ]);

                // Should not call which for special commands
                expect(mockWhich).not.toHaveBeenCalled();
            }
        });

        it("should handle empty allowed paths", async () => {
            const { configService } = await import("@/services/ConfigService");
            (configService.projectConfigExists as any).mockResolvedValue(true);
            (configService.getProjectPath as any).mockReturnValue("/test/project");
            (configService.loadTenexMCP as any).mockResolvedValue({
                servers: {},
                enabled: true,
            });
            (configService.saveProjectMCP as any).mockResolvedValue(undefined);

            await program.parseAsync([
                "node",
                "test",
                "mcp",
                "add",
                "test-server",
                "node",
                "test.js",
            ]);

            expect(configService.saveProjectMCP).toHaveBeenCalledWith(process.cwd(), {
                servers: {
                    "test-server": {
                        command: "node",
                        args: ["test.js"],
                    },
                },
                enabled: true,
            });
        });

        it("should trim whitespace from allowed paths", async () => {
            const { configService } = await import("@/services/ConfigService");
            (configService.projectConfigExists as any).mockResolvedValue(true);
            (configService.getProjectPath as any).mockReturnValue("/test/project");
            (configService.loadTenexMCP as any).mockResolvedValue({
                servers: {},
                enabled: true,
            });
            (configService.saveProjectMCP as any).mockResolvedValue(undefined);

            await program.parseAsync([
                "node",
                "test",
                "mcp",
                "add",
                "test-server",
                "node",
                "test.js",
                "--paths",
                " /path1 , /path2 , /path3 ",
            ]);

            expect(configService.saveProjectMCP).toHaveBeenCalledWith(
                process.cwd(),
                expect.objectContaining({
                    servers: expect.objectContaining({
                        "test-server": expect.objectContaining({
                            allowedPaths: ["/path1", "/path2", "/path3"],
                        }),
                    }),
                })
            );
        });

        it("should add server with options", async () => {
            const { configService } = await import("@/services/ConfigService");
            (configService.projectConfigExists as any).mockResolvedValue(true);
            (configService.getProjectPath as any).mockReturnValue("/test/project");
            (configService.loadTenexMCP as any).mockResolvedValue({
                servers: {},
                enabled: true,
            });
            (configService.saveProjectMCP as any).mockResolvedValue(undefined);

            await program.parseAsync([
                "node",
                "test",
                "mcp",
                "add",
                "test-server",
                "node",
                "test.js",
                "--paths",
                "/path1,/path2",
            ]);

            expect(configService.saveProjectMCP).toHaveBeenCalledWith(process.cwd(), {
                servers: {
                    "test-server": {
                        command: "node",
                        args: ["test.js"],
                        allowedPaths: ["/path1", "/path2"],
                    },
                },
                enabled: true,
            });
        });

        it("should add to global config with --global flag", async () => {
            const { configService } = await import("@/services/ConfigService");
            (configService.getGlobalPath as any).mockReturnValue("/global/path");
            (configService.loadTenexMCP as any).mockResolvedValue({
                servers: {},
                enabled: true,
            });
            (configService.saveGlobalMCP as any).mockResolvedValue(undefined);

            await program.parseAsync([
                "node",
                "test",
                "mcp",
                "add",
                "global-server",
                "node",
                "global.js",
                "--global",
            ]);

            expect(configService.saveGlobalMCP).toHaveBeenCalledWith(expect.any(Object));
        });

        it("should handle complex command with arguments", async () => {
            const { configService } = await import("@/services/ConfigService");
            (configService.projectConfigExists as any).mockResolvedValue(true);
            (configService.getProjectPath as any).mockReturnValue("/test/project");
            (configService.loadTenexMCP as any).mockResolvedValue({
                servers: {},
                enabled: true,
            });
            (configService.saveProjectMCP as any).mockResolvedValue(undefined);

            await program.parseAsync([
                "node",
                "test",
                "mcp",
                "add",
                "complex-server",
                "python",
                "-m",
                "server",
                "--port",
                "8080",
                "--host",
                "localhost",
            ]);

            expect(configService.saveProjectMCP).toHaveBeenCalledWith(
                process.cwd(),
                expect.objectContaining({
                    servers: expect.objectContaining({
                        "complex-server": {
                            command: "python",
                            args: ["-m", "server", "--port", "8080", "--host", "localhost"],
                        },
                    }),
                })
            );
        });

        it("should reject duplicate server names", async () => {
            const { configService } = await import("@/services/ConfigService");
            (configService.projectConfigExists as any).mockResolvedValue(true);
            (configService.getProjectPath as any).mockReturnValue("/test/project");
            (configService.loadTenexMCP as any).mockResolvedValue({
                servers: {
                    existing: {
                        command: "node",
                        args: ["existing.js"],
                    },
                },
                enabled: true,
            });

            await expect(
                program.parseAsync(["node", "test", "mcp", "add", "existing", "node", "new.js"])
            ).rejects.toThrow();

            expect(mockConsoleError).toHaveBeenCalledWith(
                expect.stringContaining("MCP server 'existing' already exists")
            );
        });

        it("should reject invalid commands", async () => {
            mockWhich.mockResolvedValue(null);

            await expect(
                program.parseAsync(["node", "test", "mcp", "add", "nonexistent-command"])
            ).rejects.toThrow();

            expect(mockConsoleError).toHaveBeenCalledWith(
                expect.stringContaining("Command not found: nonexistent-command")
            );
        });
    });

    describe("error handling", () => {
        it("should handle missing arguments", async () => {
            await expect(program.parseAsync(["node", "test", "mcp", "add"])).rejects.toThrow();
        });

        it("should handle save errors", async () => {
            const { configService } = await import("@/services/ConfigService");
            (configService.projectConfigExists as any).mockResolvedValue(true);
            (configService.getProjectPath as any).mockReturnValue("/test/project");
            (configService.loadTenexMCP as any).mockResolvedValue({
                servers: {},
                enabled: true,
            });
            (configService.saveProjectMCP as any).mockRejectedValue(new Error("Save error"));

            await expect(
                program.parseAsync(["node", "test", "mcp", "add", "test-server", "node", "test.js"])
            ).rejects.toThrow();

            expect(mockConsoleError).toHaveBeenCalledWith(
                expect.stringContaining("Failed to add MCP server:")
            );
        });

        it("should create default MCP config if none exists", async () => {
            const { configService } = await import("@/services/ConfigService");
            (configService.projectConfigExists as any).mockResolvedValue(true);
            (configService.getProjectPath as any).mockReturnValue("/test/project");
            (configService.loadTenexMCP as any).mockResolvedValue({
                servers: {},
                enabled: true,
            });
            (configService.saveProjectMCP as any).mockResolvedValue(undefined);

            await program.parseAsync([
                "node",
                "test",
                "mcp",
                "add",
                "first-server",
                "node",
                "first.js",
            ]);

            expect(configService.saveProjectMCP).toHaveBeenCalledWith(process.cwd(), {
                servers: {
                    "first-server": {
                        command: "node",
                        args: ["first.js"],
                    },
                },
                enabled: true,
            });
        });
    });
});
