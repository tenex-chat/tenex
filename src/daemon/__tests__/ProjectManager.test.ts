import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { ProjectManager } from "../ProjectManager";
import type { ProjectData } from "../ProjectManager";
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import { logger } from "@/utils/logger";
import * as git from "@/utils/git";
import { configService } from "@/services";
import * as agentFetcher from "@/utils/agentFetcher";
import * as mcpInstaller from "@/services/mcp/mcpInstaller";

// Mock modules
mock.module("@/services", () => ({
    configService: {
        loadConfig: mock(() => Promise.resolve({
            config: {
                projectNaddr: "naddr123",
                description: "Test project",
                repoUrl: "https://github.com/test/repo"
            },
            llms: { configurations: {} }
        })),
        saveProjectConfig: mock(() => Promise.resolve()),
    },
    setProjectContext: mock(() => {}),
}));

mock.module("@/agents/AgentRegistry", () => ({
    AgentRegistry: mock(() => ({
        loadFromProject: mock(() => Promise.resolve()),
        getAllAgentsMap: mock(() => new Map([["test-agent", { name: "Test Agent" }]])),
        republishAllAgentProfiles: mock(() => Promise.resolve()),
        ensureAgent: mock(() => Promise.resolve()),
    })),
}));

mock.module("@/llm/LLMConfigEditor", () => ({
    LLMConfigEditor: mock(() => ({
        runOnboardingFlow: mock(() => Promise.resolve()),
    })),
}));

mock.module("@/tools/toolLogger", () => ({
    initializeToolLogger: mock(() => {}),
}));

// Mock node:util promisify to work with our mock exec
mock.module("node:util", () => ({
    promisify: (fn: any) => {
        return (...args: any[]) => {
            return new Promise((resolve, reject) => {
                fn(...args, (err: any, stdout: any, stderr: any) => {
                    if (err) reject(err);
                    else resolve({ stdout, stderr });
                });
            });
        };
    },
}));

// Mock child_process exec
mock.module("node:child_process", () => ({
    exec: mock((cmd: string, callback: any) => {
        if (cmd.includes("git clone")) {
            if (cmd.includes("failed-clone")) {
                callback(new Error("Permission denied"), "", "");
            } else if (cmd.includes("warning-clone")) {
                callback(null, "Cloned successfully", "warning: You appear to have cloned an empty repository.");
            } else if (cmd.includes("concurrent-project") && existsSync(path.join("/tmp", cmd.split("/").pop() || ""))) {
                callback(new Error("File exists"), "", "fatal: could not create work tree dir");
            } else {
                callback(null, "Cloned successfully", "");
            }
        } else {
            callback(null, "", "");
        }
    }),
}));

describe("ProjectManager", () => {
    let projectManager: ProjectManager;
    let tempDir: string;
    let mockNDK: NDK;
    let mockProject: NDKProject;
    let loggerInfoSpy: any;
    let loggerErrorSpy: any;
    let loggerWarnSpy: any;
    let loggerDebugSpy: any;

    beforeEach(async () => {
        // Create temp directory for tests
        tempDir = path.join("/tmp", "test-projects-" + Date.now());
        await fs.mkdir(tempDir, { recursive: true });

        // Create mock project
        mockProject = {
            id: "project123",
            pubkey: "pubkey123",
            dTag: "test-project",
            description: "A test project",
            created_at: Date.now(),
            encode: mock(() => "naddr123"),
            tagValue: mock((tag: string) => {
                switch (tag) {
                    case "title": return "Test Project";
                    case "repo": return "https://github.com/test/repo";
                    default: return undefined;
                }
            }),
            tags: [
                ["t", "test"],
                ["agent", "agent123"],
                ["mcp", "mcp123"],
            ],
        } as any;

        // Create mock NDK
        mockNDK = {
            fetchEvent: mock(() => Promise.resolve(mockProject)),
        } as any;

        // Spy on logger
        loggerInfoSpy = spyOn(logger, "info").mockImplementation(() => {});
        loggerErrorSpy = spyOn(logger, "error").mockImplementation(() => {});
        loggerWarnSpy = spyOn(logger, "warn").mockImplementation(() => {});
        loggerDebugSpy = spyOn(logger, "debug").mockImplementation(() => {});

        // Create ProjectManager instance
        projectManager = new ProjectManager(tempDir);
    });

    afterEach(async () => {
        // Clean up temp directory
        try {
            await fs.rm(tempDir, { recursive: true, force: true });
        } catch (error) {
            // Cleanup error ignored in test teardown
        }
        mock.restore();
    });

    describe("initializeProject", () => {
        it("should initialize a project from scratch", async () => {
            // Mock git functions
            const initGitSpy = spyOn(git, "initializeGitRepository").mockResolvedValue();
            const ensureGitignoreSpy = spyOn(git, "ensureTenexInGitignore").mockResolvedValue();

            // Mock agent fetcher
            const fetchAgentSpy = spyOn(agentFetcher, "fetchAgentDefinition").mockResolvedValue({
                title: "Test Agent",
                role: "Test Role",
                description: "Test Description",
                instructions: "Test Instructions",
                useCriteria: ["test"],
            });

            // Mock MCP installer
            const installMCPSpy = spyOn(mcpInstaller, "installMCPServerFromEvent").mockResolvedValue();

            const projectPath = path.join(tempDir, "test-project");
            const result = await projectManager.initializeProject(projectPath, "naddr123", mockNDK);

            expect(result).toEqual({
                identifier: "test-project",
                pubkey: "pubkey123",
                naddr: "naddr123",
                title: "Test Project",
                description: "A test project",
                repoUrl: "https://github.com/test/repo",
                hashtags: ["test"],
                agentEventIds: ["agent123"],
                mcpEventIds: ["mcp123"],
                createdAt: expect.any(Number),
                updatedAt: expect.any(Number),
            });

            // Verify project directory was created
            const stats = await fs.stat(projectPath);
            expect(stats.isDirectory()).toBe(true);

            // Verify git was not initialized (repo was cloned)
            expect(initGitSpy).not.toHaveBeenCalled();
            expect(ensureGitignoreSpy).toHaveBeenCalled();
        });

        it("should initialize a project without repository", async () => {
            // Mock project without repo
            mockProject.tagValue = mock((tag: string) => {
                return tag === "title" ? "Test Project" : undefined;
            });

            // Mock git functions
            const initGitSpy = spyOn(git, "initializeGitRepository").mockResolvedValue();
            const ensureGitignoreSpy = spyOn(git, "ensureTenexInGitignore").mockResolvedValue();

            const projectPath = path.join(tempDir, "test-project");
            const result = await projectManager.initializeProject(projectPath, "naddr123", mockNDK);

            // Verify git was initialized
            expect(initGitSpy).toHaveBeenCalledWith(projectPath);
            expect(ensureGitignoreSpy).toHaveBeenCalled();
        });

        it("should handle errors during initialization", async () => {
            // Make fetchEvent throw an error
            mockNDK.fetchEvent = mock(() => Promise.reject(new Error("Network error")));

            const projectPath = path.join(tempDir, "test-project");
            
            await expect(
                projectManager.initializeProject(projectPath, "naddr123", mockNDK)
            ).rejects.toThrow("Network error");

            expect(loggerErrorSpy).toHaveBeenCalledWith(
                "Failed to initialize project",
                expect.objectContaining({ error: expect.any(Error) })
            );
        });

        it("should handle missing project event", async () => {
            mockNDK.fetchEvent = mock(() => Promise.resolve(null));

            const projectPath = path.join(tempDir, "test-project");
            
            await expect(
                projectManager.initializeProject(projectPath, "naddr123", mockNDK)
            ).rejects.toThrow("Project event not found: naddr123");
        });
    });

    describe("loadProject", () => {
        it("should load existing project", async () => {
            const projectPath = path.join(tempDir, "existing-project");
            
            const result = await projectManager.loadProject(projectPath);

            expect(result).toEqual({
                identifier: "naddr123",
                pubkey: "",
                naddr: "naddr123",
                title: "Untitled Project",
                description: "Test project",
                repoUrl: "https://github.com/test/repo",
                hashtags: [],
                agentEventIds: [],
                mcpEventIds: [],
                createdAt: undefined,
                updatedAt: undefined,
            });

            expect(configService.loadConfig).toHaveBeenCalledWith(projectPath);
        });

        it("should handle missing projectNaddr", async () => {
            // Mock config without projectNaddr
            (configService.loadConfig as any).mockResolvedValueOnce({
                config: { description: "Test" },
                llms: {},
            });

            const projectPath = path.join(tempDir, "invalid-project");
            
            await expect(
                projectManager.loadProject(projectPath)
            ).rejects.toThrow("Project configuration missing projectNaddr");
        });

        it("should handle config loading errors", async () => {
            (configService.loadConfig as any).mockRejectedValueOnce(new Error("File not found"));

            const projectPath = path.join(tempDir, "missing-project");
            
            await expect(
                projectManager.loadProject(projectPath)
            ).rejects.toThrow(`Failed to load project from ${projectPath}`);

            expect(loggerErrorSpy).toHaveBeenCalledWith(
                "Failed to load project",
                expect.objectContaining({
                    error: expect.any(Error),
                    projectPath,
                })
            );
        });
    });

    describe("ensureProjectExists", () => {
        it("should return existing project path", async () => {
            const projectPath = path.join(tempDir, "test-project");
            const tenexPath = path.join(projectPath, ".tenex");
            
            // Create existing project structure
            await fs.mkdir(tenexPath, { recursive: true });

            const result = await projectManager.ensureProjectExists("test-project", "naddr123", mockNDK);
            
            expect(result).toBe(projectPath);
            // Should not initialize (already exists)
            expect(mockNDK.fetchEvent).not.toHaveBeenCalled();
        });

        it("should initialize non-existing project", async () => {
            // Mock git functions
            spyOn(git, "initializeGitRepository").mockResolvedValue();
            spyOn(git, "ensureTenexInGitignore").mockResolvedValue();

            const result = await projectManager.ensureProjectExists("new-project", "naddr123", mockNDK);
            
            expect(result).toBe(path.join(tempDir, "new-project"));
            expect(mockNDK.fetchEvent).toHaveBeenCalledWith("naddr123");
        });
    });

    describe("loadAndInitializeProjectContext", () => {
        it("should load and initialize project context", async () => {
            const projectPath = path.join(tempDir, "test-project");
            
            await projectManager.loadAndInitializeProjectContext(projectPath, mockNDK);

            expect(configService.loadConfig).toHaveBeenCalledWith(projectPath);
            expect(mockNDK.fetchEvent).toHaveBeenCalledWith("naddr123");
            expect(loggerDebugSpy).toHaveBeenCalledWith(
                "Fetched project from Nostr",
                expect.objectContaining({
                    projectId: "project123",
                    projectTitle: "Test Project",
                })
            );
        });

        it("should handle missing projectNaddr in context", async () => {
            (configService.loadConfig as any).mockResolvedValueOnce({
                config: {},
                llms: {},
            });

            const projectPath = path.join(tempDir, "test-project");
            
            await expect(
                projectManager.loadAndInitializeProjectContext(projectPath, mockNDK)
            ).rejects.toThrow("Project configuration missing projectNaddr");
        });

        it("should handle errors during context initialization", async () => {
            mockNDK.fetchEvent = mock(() => Promise.reject(new Error("Network error")));

            const projectPath = path.join(tempDir, "test-project");
            
            await expect(
                projectManager.loadAndInitializeProjectContext(projectPath, mockNDK)
            ).rejects.toThrow("Network error");

            expect(loggerErrorSpy).toHaveBeenCalledWith(
                "Failed to initialize ProjectContext",
                expect.objectContaining({
                    error: expect.any(Error),
                    projectPath,
                })
            );
        });
    });

    describe("edge cases", () => {
        it("should handle project with no tags", async () => {
            mockProject.tags = [];
            spyOn(git, "initializeGitRepository").mockResolvedValue();
            spyOn(git, "ensureTenexInGitignore").mockResolvedValue();

            const projectPath = path.join(tempDir, "empty-project");
            const result = await projectManager.initializeProject(projectPath, "naddr123", mockNDK);

            expect(result.hashtags).toEqual([]);
            expect(result.agentEventIds).toEqual([]);
            expect(result.mcpEventIds).toEqual([]);
        });

        it("should handle git clone failures", async () => {
            const projectPath = path.join(tempDir, "failed-clone");
            
            await expect(
                projectManager.initializeProject(projectPath, "naddr123", mockNDK)
            ).rejects.toThrow("Permission denied");

            expect(loggerErrorSpy).toHaveBeenCalledWith(
                "Failed to clone repository",
                expect.objectContaining({
                    error: expect.any(Error),
                    repoUrl: "https://github.com/test/repo",
                })
            );
        });

        it("should warn on git clone stderr", async () => {
            spyOn(git, "ensureTenexInGitignore").mockResolvedValue();

            const projectPath = path.join(tempDir, "warning-clone");
            await projectManager.initializeProject(projectPath, "naddr123", mockNDK);

            expect(loggerWarnSpy).toHaveBeenCalledWith(
                "Git clone warning",
                expect.objectContaining({
                    stderr: expect.stringContaining("warning"),
                })
            );
        });

        it("should handle concurrent access to same project", async () => {
            spyOn(git, "initializeGitRepository").mockResolvedValue();
            spyOn(git, "ensureTenexInGitignore").mockResolvedValue();

            // Simulate concurrent initialization attempts
            const promises = [
                projectManager.ensureProjectExists("concurrent-project", "naddr123", mockNDK),
                projectManager.ensureProjectExists("concurrent-project", "naddr123", mockNDK),
            ];

            const results = await Promise.all(promises);
            
            // Both should return the same path
            expect(results[0]).toBe(results[1]);
            expect(results[0]).toBe(path.join(tempDir, "concurrent-project"));
        });
    });
});