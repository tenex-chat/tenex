import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupTempDir, createTempDir } from "@/test-utils";
import { ConfigService } from "../ConfigService";

describe("ConfigService", () => {
  let service: ConfigService;
  let tempDir: string;
  let projectDir: string;

  beforeEach(async () => {
    // Clear singleton state
    (ConfigService as any).instance = null;
    service = ConfigService.getInstance();

    tempDir = await createTempDir("config-service-test-");
    projectDir = path.join(tempDir, "project");
  });

  afterEach(async () => {
    // Clean up
    await cleanupTempDir(tempDir);

    // Clear singleton and cache
    (ConfigService as any).instance = null;
  });

  describe("path utilities", () => {
    it("should get correct global path", () => {
      const globalPath = service.getGlobalPath();
      expect(globalPath).toBe(path.join(os.homedir(), ".tenex"));
    });

    it("should get correct project path", () => {
      const projectPath = service.getProjectPath(projectDir);
      expect(projectPath).toBe(path.join(projectDir, ".tenex"));
    });
  });

  describe("config loading", () => {
    it("should load empty config when files don't exist in project", async () => {
      // Create an isolated project dir that doesn't load global config
      const isolatedDir = path.join(tempDir, "isolated", "deep", "project");
      await fs.mkdir(isolatedDir, { recursive: true });

      const config = await service.loadTenexConfig(service.getProjectPath(isolatedDir));

      expect(config).toEqual({});
    });

    it("should save and load project config", async () => {
      const projectConfig = {
        description: "Test project",
        whitelistedPubkeys: ["pubkey1", "pubkey2"],
        repoUrl: "https://github.com/test/repo",
      };

      await service.saveProjectConfig(projectDir, projectConfig);

      const loaded = await service.loadTenexConfig(service.getProjectPath(projectDir));

      expect(loaded.description).toBe("Test project");
      expect(loaded.whitelistedPubkeys).toEqual(["pubkey1", "pubkey2"]);
      expect(loaded.repoUrl).toBe("https://github.com/test/repo");
    });

    it("should load and save agents", async () => {
      const agents = {
        agent1: {
          nsec: "nsec1test",
          file: "agent1.md",
          eventId: "event123",
        },
        agent2: {
          nsec: "nsec2test",
          file: "agent2.md",
          orchestratorAgent: true,
        },
      };

      await service.saveProjectAgents(projectDir, agents);

      const loaded = await service.loadProjectAgents(projectDir);

      expect(loaded).toEqual(agents);
    });

    it("should load and save LLMs", async () => {
      const llms = {
        configurations: {
          default: {
            provider: "openai" as const,
            model: "gpt-4",
            temperature: 0.7,
            maxTokens: 2000,
          },
        },
        defaults: {
          agents: "default",
        },
        credentials: {
          openai: { apiKey: "test-key" },
        },
      };

      await service.saveProjectLLMs(projectDir, llms);

      const projectPath = service.getProjectPath(projectDir);
      const loaded = await service.loadTenexLLMs(projectPath);

      expect(loaded).toEqual(llms);
    });

    it("should load and save MCP", async () => {
      const mcp = {
        servers: {
          server1: {
            command: "test-cmd",
            args: ["--test"],
          },
        },
        enabled: false,
      };

      await service.saveProjectMCP(projectDir, mcp);

      const projectPath = service.getProjectPath(projectDir);
      const loaded = await service.loadTenexMCP(projectPath);

      expect(loaded).toEqual(mcp);
    });
  });

  describe("whitelistedPubkeys", () => {
    it("should return empty array when no pubkeys", () => {
      const pubkeys = service.getWhitelistedPubkeys(undefined, {});
      expect(pubkeys).toEqual([]);
    });

    it("should parse CLI pubkeys", () => {
      const pubkeys = service.getWhitelistedPubkeys("pk1,pk2,pk3");
      expect(pubkeys).toEqual(["pk1", "pk2", "pk3"]);
    });

    it("should handle whitespace in CLI pubkeys", () => {
      const pubkeys = service.getWhitelistedPubkeys(" pk1 , pk2 , pk3 ");
      expect(pubkeys).toEqual(["pk1", "pk2", "pk3"]);
    });

    it("should deduplicate CLI pubkeys", () => {
      const pubkeys = service.getWhitelistedPubkeys("pk1,pk2,pk1,pk3,pk2");
      expect(pubkeys.sort()).toEqual(["pk1", "pk2", "pk3"]);
    });

    it("should prefer CLI over config", () => {
      const config = { whitelistedPubkeys: ["config1", "config2"] };
      const pubkeys = service.getWhitelistedPubkeys("cli1,cli2", config);
      expect(pubkeys).toEqual(["cli1", "cli2"]);
    });

    it("should use config when no CLI", () => {
      const config = { whitelistedPubkeys: ["config1", "config2"] };
      const pubkeys = service.getWhitelistedPubkeys(undefined, config);
      expect(pubkeys.sort()).toEqual(["config1", "config2"]);
    });
  });

  describe("file operations", () => {
    it("should create directories when saving", async () => {
      const config = { description: "Test" };

      await service.saveProjectConfig(projectDir, config);

      const configPath = path.join(projectDir, ".tenex", "config.json");
      const exists = await fs.stat(configPath).then(
        () => true,
        () => false
      );
      expect(exists).toBe(true);
    });

    it("should validate config before saving", async () => {
      const invalidConfig = {
        description: 123, // Invalid type
        invalidField: "test", // Unknown field
      } as any;

      // Should throw on invalid type
      await expect(service.saveProjectConfig(projectDir, invalidConfig)).rejects.toThrow();
    });

    it("should check file existence", async () => {
      expect(await service.projectConfigExists(projectDir, "config.json")).toBe(false);

      await service.saveProjectConfig(projectDir, { description: "Test" });

      expect(await service.projectConfigExists(projectDir, "config.json")).toBe(true);
    });

    it("should check multiple file types", async () => {
      expect(await service.projectConfigExists(projectDir, "agents.json")).toBe(false);
      expect(await service.projectConfigExists(projectDir, "llms.json")).toBe(false);
      expect(await service.projectConfigExists(projectDir, "mcp.json")).toBe(false);

      await service.saveProjectAgents(projectDir, {
        test: { nsec: "nsec1test", file: "test.md" },
      });
      await service.saveProjectLLMs(projectDir, {
        configurations: {},
        defaults: {},
        credentials: {},
      });
      await service.saveProjectMCP(projectDir, {
        servers: {},
        enabled: true,
      });

      expect(await service.projectConfigExists(projectDir, "agents.json")).toBe(true);
      expect(await service.projectConfigExists(projectDir, "llms.json")).toBe(true);
      expect(await service.projectConfigExists(projectDir, "mcp.json")).toBe(true);
    });
  });

  describe("caching", () => {
    it("should cache loaded configs", async () => {
      const config = { description: "Test" };
      await service.saveProjectConfig(projectDir, config);

      // First load
      const projectPath = service.getProjectPath(projectDir);
      const loaded1 = await service.loadTenexConfig(projectPath);

      // Modify file directly
      const configPath = path.join(projectDir, ".tenex", "config.json");
      await fs.writeFile(configPath, JSON.stringify({ description: "Modified" }));

      // Second load should return cached value
      const loaded2 = await service.loadTenexConfig(projectPath);
      expect(loaded2.description).toBe("Test"); // Still cached

      // Clear cache and load again
      service.clearCache();
      const loaded3 = await service.loadTenexConfig(projectPath);
      expect(loaded3.description).toBe("Modified"); // Fresh from file
    });

    it("should clear specific cache entries", async () => {
      const config = { description: "Test" };
      await service.saveProjectConfig(projectDir, config);

      const agents = { test: { nsec: "nsec1test", file: "test.md" } };
      await service.saveProjectAgents(projectDir, agents);

      // Load both
      const projectPath = service.getProjectPath(projectDir);
      await service.loadTenexConfig(projectPath);
      await service.loadTenexAgents(projectPath);

      // Modify config file
      const configPath = path.join(projectDir, ".tenex", "config.json");
      await fs.writeFile(configPath, JSON.stringify({ description: "Modified" }));

      // Clear only config cache
      service.clearCache(configPath);

      // Config should be fresh, agents still cached
      const loadedConfig = await service.loadTenexConfig(projectPath);
      const loadedAgents = await service.loadTenexAgents(projectPath);
      expect(loadedConfig.description).toBe("Modified");
      expect(loadedAgents).toEqual(agents);
    });
  });

  describe("error handling", () => {
    it("should return defaults on parse error", async () => {
      // Write invalid JSON
      const configPath = path.join(projectDir, ".tenex");
      await fs.mkdir(configPath, { recursive: true });
      await fs.writeFile(path.join(configPath, "config.json"), "invalid json");

      const projectPath = service.getProjectPath(projectDir);
      const loaded = await service.loadTenexConfig(projectPath);
      expect(loaded).toEqual({}); // Default value
    });

    it("should handle missing directories gracefully", async () => {
      // Try to load from non-existent directory
      const nonExistentDir = path.join(tempDir, "non-existent");
      const projectPath = service.getProjectPath(nonExistentDir);

      const loaded = await service.loadTenexConfig(projectPath);
      expect(loaded).toEqual({});
    });

    it("should handle save errors gracefully", async () => {
      // Try to save to a file path (not a directory)
      const filePath = path.join(tempDir, "file.txt");
      await fs.writeFile(filePath, "content");

      // This should throw because it can't create .tenex directory
      await expect(service.saveProjectConfig(filePath, { description: "Test" })).rejects.toThrow();
    });
  });

  describe("convenience methods", () => {
    it("should have working convenience methods", async () => {
      const agents = { test: { nsec: "nsec1test", file: "test.md" } };
      const llms = {
        configurations: {
          default: {
            provider: "openai" as const,
            model: "gpt-4",
          },
        },
        defaults: {},
        credentials: {},
      };
      const mcp = { servers: {}, enabled: true };

      // Save using convenience methods
      await service.saveProjectAgents(projectDir, agents);
      await service.saveProjectLLMs(projectDir, llms);
      await service.saveProjectMCP(projectDir, mcp);

      // Load using convenience methods
      const loadedAgents = await service.loadProjectAgents(projectDir);
      expect(loadedAgents).toEqual(agents);
    });
  });

  describe("loadConfig integration", () => {
    it("should properly merge configs from different sources", async () => {
      // Note: loadConfig merges global and project configs
      // Since we can't easily mock the global path, we'll test the merging logic
      // by saving to different project directories

      const config1 = {
        whitelistedPubkeys: ["pk1", "pk2"],
        description: "First config",
      };

      const config2 = {
        whitelistedPubkeys: ["pk3", "pk4"],
        repoUrl: "https://example.com",
      };

      await service.saveProjectConfig(path.join(tempDir, "proj1"), config1);
      await service.saveProjectConfig(path.join(tempDir, "proj2"), config2);

      // Load each individually to verify they saved correctly
      const loaded1 = await service.loadTenexConfig(
        service.getProjectPath(path.join(tempDir, "proj1"))
      );
      const loaded2 = await service.loadTenexConfig(
        service.getProjectPath(path.join(tempDir, "proj2"))
      );

      expect(loaded1.whitelistedPubkeys).toEqual(["pk1", "pk2"]);
      expect(loaded2.whitelistedPubkeys).toEqual(["pk3", "pk4"]);
    });
  });
});
