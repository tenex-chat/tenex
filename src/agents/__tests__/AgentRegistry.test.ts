import { beforeEach, describe, expect, it, mock } from "bun:test";
import * as path from "node:path";
import type { AgentConfig } from "@/agents/types";
import * as fs from "@/lib/fs";
import { configService } from "@/services";
import { nip19 } from "nostr-tools";
import { AgentRegistry } from "../AgentRegistry";

// Mock file system
mock.module("@/lib/fs", () => ({
  fileExists: mock(),
  readFile: mock(),
  writeJsonFile: mock(),
  ensureDirectory: mock(),
}));

// Mock config service
mock.module("@/services", () => ({
  configService: {
    loadTenexAgents: mock(),
    saveProjectAgents: mock(),
  },
  getProjectContext: mock(),
}));

// No more built-in agents to mock

describe("AgentRegistry", () => {
  let registry: AgentRegistry;
  const testProjectPath = "/test/project";

  beforeEach(() => {
    // Reset mocks
    (fs.fileExists as any).mockReset();
    (fs.readFile as any).mockReset();
    (fs.writeJsonFile as any).mockReset();
    (fs.ensureDirectory as any).mockReset();
    (configService.loadTenexAgents as any).mockReset();
    (configService.saveProjectAgents as any).mockReset();

    registry = new AgentRegistry(testProjectPath);
  });

  describe("loadFromProject", () => {
    it("should load agents from .tenex/agents.json", async () => {
      const mockRegistry = {
        developer: {
          nsec: "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5",
          file: "developer.json",
        },
        reviewer: {
          nsec: "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5",
          file: "reviewer.json",
        },
      };

      const developerDefinition = {
        name: "Developer",
        role: "Software Developer",
        expertise: "Full-stack development",
        instructions: "Write clean code",
        tools: ["read_path", "shell"],
        llmConfig: "default",
      };

      const reviewerDefinition = {
        name: "Reviewer",
        role: "Code Reviewer",
        expertise: "Code quality",
        instructions: "Review code thoroughly",
        tools: ["read_path"],
        llmConfig: "fast",
      };

      (fs.ensureDirectory as any).mockResolvedValue(undefined);
      (configService.loadTenexAgents as any).mockResolvedValue(mockRegistry);
      (fs.fileExists as any).mockImplementation(async (path: string) => {
        return path.includes("developer.json") || path.includes("reviewer.json");
      });
      (fs.readFile as any).mockImplementation(async (path: string) => {
        if (path.includes("developer.json")) {
          return JSON.stringify(developerDefinition);
        }
        if (path.includes("reviewer.json")) {
          return JSON.stringify(reviewerDefinition);
        }
        return "{}";
      });

      await registry.loadFromProject();

      // Ensure agent developer
      const developer = await registry.ensureAgent("developer", {
        name: "Developer",
        role: "Software Developer",
        expertise: "Full-stack development",
        instructions: "Write clean code",
        nsec: "",
        tools: ["read_path", "shell"],
        llmConfig: "default",
      });

      expect(developer).toBeDefined();
      expect(developer?.name).toBe("Developer");
      expect(developer?.role).toBe("Software Developer");
      expect(developer?.tools).toEqual(["read_path", "shell"]);

      // Ensure agent reviewer
      const reviewer = await registry.ensureAgent("reviewer", {
        name: "Reviewer",
        role: "Code Reviewer",
        expertise: "Code quality",
        instructions: "Review code thoroughly",
        nsec: "",
        tools: ["read_path"],
        llmConfig: "fast",
      });

      expect(reviewer).toBeDefined();
      expect(reviewer?.name).toBe("Reviewer");
      expect(reviewer?.role).toBe("Code Reviewer");
    });

    it("should handle empty registry", async () => {
      (fs.ensureDirectory as any).mockResolvedValue(undefined);
      (configService.loadTenexAgents as any).mockResolvedValue({});

      await registry.loadFromProject();

      expect(configService.loadTenexAgents).toHaveBeenCalledWith(
        path.join(testProjectPath, ".tenex")
      );
    });

    it("should handle errors when loading registry", async () => {
      (fs.ensureDirectory as any).mockResolvedValue(undefined);
      (configService.loadTenexAgents as any).mockRejectedValue(new Error("Failed to load"));

      // Should not throw, but set empty registry
      await registry.loadFromProject();

      const agents = registry.getAllAgents();
      expect(agents).toHaveLength(0);
    });
  });

  describe("ensureAgent", () => {
    beforeEach(async () => {
      (fs.ensureDirectory as any).mockResolvedValue(undefined);
      (configService.loadTenexAgents as any).mockResolvedValue({});
      (configService.saveProjectAgents as any).mockResolvedValue(undefined);
      (fs.fileExists as any).mockResolvedValue(false);
      (fs.writeJsonFile as any).mockResolvedValue(undefined);

      await registry.loadFromProject();
    });

    it("should create a new agent if it doesn't exist", async () => {
      const config: AgentConfig = {
        name: "TestAgent",
        role: "Tester",
        expertise: "Testing",
        instructions: "Test everything",
        nsec: "",
        tools: ["shell"],
        llmConfig: "default",
      };

      const agent = await registry.ensureAgent("tester", config);

      expect(agent).toBeDefined();
      expect(agent.name).toBe("TestAgent");
      expect(agent.role).toBe("Tester");
      expect(agent.signer).toBeDefined();
      expect(agent.pubkey).toBeDefined();
      expect(fs.writeJsonFile).toHaveBeenCalled();
      expect(configService.saveProjectAgents).toHaveBeenCalled();
    });

    it("should generate nsec if not provided", async () => {
      const config: AgentConfig = {
        name: "TestAgent",
        role: "Tester",
        expertise: "Testing",
        instructions: "Test everything",
        nsec: "", // Empty nsec
        tools: [],
      };

      const agent = await registry.ensureAgent("tester", config);

      expect(agent.signer).toBeDefined();
      expect(agent.signer).toBeDefined();
      const user = await agent.signer.user();
      expect(agent.pubkey).toBe(user.pubkey);
    });

    it("should use provided nsec", async () => {
      const testPrivateKey = Uint8Array.from([
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
        0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e,
        0x1f, 0x20,
      ]);
      const nsec = nip19.nsecEncode(testPrivateKey);

      const config: AgentConfig = {
        name: "TestAgent",
        role: "Tester",
        expertise: "Testing",
        instructions: "Test everything",
        nsec: nsec,
        tools: [],
      };

      const agent = await registry.ensureAgent("tester", config);

      expect(agent.signer).toBeDefined();
      expect(agent.pubkey).toBeDefined();
    });

    it("should return existing agent if already registered", async () => {
      const config: AgentConfig = {
        name: "TestAgent",
        role: "Tester",
        expertise: "Testing",
        instructions: "Test everything",
        nsec: "",
        tools: [],
      };

      const agent1 = await registry.ensureAgent("tester", config);

      // Clear write mock to check it's not called again
      (fs.writeJsonFile as any).mockClear();
      (configService.saveProjectAgents as any).mockClear();

      const agent2 = await registry.ensureAgent("tester", config);

      expect(agent1).toBe(agent2);
      expect(fs.writeJsonFile).not.toHaveBeenCalled();
      expect(configService.saveProjectAgents).not.toHaveBeenCalled();
    });

    it("should save agent configuration to disk", async () => {
      const config: AgentConfig = {
        name: "TestAgent",
        role: "Tester",
        expertise: "Testing",
        instructions: "Test everything",
        nsec: "",
        tools: ["read_path", "shell"],
        llmConfig: "fast",
      };

      await registry.ensureAgent("tester", config);

      // Check that writeJsonFile was called for the tester agent
      const calls = (fs.writeJsonFile as any).mock.calls;
      expect(calls.length).toBe(1);

      const [filePath, content] = calls[0];
      expect(filePath).toContain("tester.json");
      expect(content).toMatchObject({
        name: "TestAgent",
        role: "Tester",
        instructions: "Test everything",
        tools: ["read_path", "shell"],
        llmConfig: "fast",
      });

      expect(configService.saveProjectAgents).toHaveBeenCalledWith(
        testProjectPath,
        expect.objectContaining({
          tester: expect.objectContaining({
            nsec: expect.stringMatching(/^nsec1/),
            file: "tester.json",
          }),
        })
      );
    });
  });

  describe("getAgent", () => {
    beforeEach(async () => {
      (fs.ensureDirectory as any).mockResolvedValue(undefined);
      (configService.loadTenexAgents as any).mockResolvedValue({});
      (configService.saveProjectAgents as any).mockResolvedValue(undefined);
      (fs.fileExists as any).mockResolvedValue(false);
      (fs.writeJsonFile as any).mockResolvedValue(undefined);

      await registry.loadFromProject();

      // Ensure a developer agent
      await registry.ensureAgent("developer", {
        name: "Developer",
        role: "Software Developer",
        expertise: "Full-stack development",
        instructions: "Write clean code",
        nsec: "",
        tools: ["shell"],
      });
    });

    it("should return agent by name", () => {
      const agent = registry.getAgent("developer");

      expect(agent).toBeDefined();
      expect(agent?.name).toBe("Developer");
      expect(agent?.role).toBe("Software Developer");
    });

    it("should return undefined for non-existent agent", () => {
      const agent = registry.getAgent("nonexistent");

      expect(agent).toBeUndefined();
    });
  });

  describe("getAllAgents", () => {
    it("should return all registered agents", async () => {
      (fs.ensureDirectory as any).mockResolvedValue(undefined);
      (configService.loadTenexAgents as any).mockResolvedValue({});
      (configService.saveProjectAgents as any).mockResolvedValue(undefined);
      (fs.fileExists as any).mockResolvedValue(false);
      (fs.writeJsonFile as any).mockResolvedValue(undefined);

      await registry.loadFromProject();

      // Ensure agents
      await registry.ensureAgent("developer", {
        name: "Developer",
        role: "Software Developer",
        expertise: "Full-stack development",
        instructions: "Write clean code",
        nsec: "",
        tools: [],
      });

      await registry.ensureAgent("reviewer", {
        name: "Reviewer",
        role: "Code Reviewer",
        expertise: "Code quality",
        instructions: "Review code",
        nsec: "",
        tools: [],
      });

      const agents = registry.getAllAgents();

      expect(agents).toHaveLength(2);
      expect(agents.map((a) => a.name)).toContain("Developer");
      expect(agents.map((a) => a.name)).toContain("Reviewer");
    });

    it("should return empty array when no agents exist", async () => {
      (fs.ensureDirectory as any).mockResolvedValue(undefined);
      (configService.loadTenexAgents as any).mockResolvedValue({});

      await registry.loadFromProject();

      const agents = registry.getAllAgents();

      expect(agents).toHaveLength(0);
    });
  });

  describe("getAgentByPubkey", () => {
    it("should return agent by pubkey", async () => {
      (fs.ensureDirectory as any).mockResolvedValue(undefined);
      (configService.loadTenexAgents as any).mockResolvedValue({});
      (configService.saveProjectAgents as any).mockResolvedValue(undefined);
      (fs.fileExists as any).mockResolvedValue(false);
      (fs.writeJsonFile as any).mockResolvedValue(undefined);

      await registry.loadFromProject();

      const agent = await registry.ensureAgent("developer", {
        name: "Developer",
        role: "Software Developer",
        expertise: "Full-stack development",
        instructions: "Write clean code",
        nsec: "",
        tools: [],
      });

      const foundAgent = registry.getAgentByPubkey(agent.pubkey);
      expect(foundAgent).toBe(agent);
    });

    it("should return undefined for unknown pubkey", async () => {
      const agent = registry.getAgentByPubkey("unknown-pubkey");
      expect(agent).toBeUndefined();
    });
  });

  describe("loadAgentBySlug", () => {
    it("should load agent from registry", async () => {
      const mockRegistry = {
        developer: {
          nsec: "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5",
          file: "developer.json",
          eventId: "event123",
        },
      };

      const developerDefinition = {
        name: "Developer",
        role: "Software Developer",
        expertise: "Full-stack development",
        instructions: "Write clean code",
        tools: ["read_path", "shell"],
        llmConfig: "default",
      };

      (fs.ensureDirectory as any).mockResolvedValue(undefined);
      (configService.loadTenexAgents as any).mockResolvedValue(mockRegistry);
      (fs.fileExists as any).mockResolvedValue(true);
      (fs.readFile as any).mockResolvedValue(JSON.stringify(developerDefinition));
      (configService.saveProjectAgents as any).mockResolvedValue(undefined);
      (fs.writeJsonFile as any).mockResolvedValue(undefined);

      await registry.loadFromProject();

      const agent = await registry.loadAgentBySlug("developer");

      expect(agent).toBeDefined();
      expect(agent?.name).toBe("Developer");
      expect(agent?.role).toBe("Software Developer");
      expect(agent?.eventId).toBe("event123");
    });

    it("should return null for non-existent slug", async () => {
      (fs.ensureDirectory as any).mockResolvedValue(undefined);
      (configService.loadTenexAgents as any).mockResolvedValue({});

      await registry.loadFromProject();

      const agent = await registry.loadAgentBySlug("nonexistent");
      expect(agent).toBeNull();
    });

    it("should return null when agent file doesn't exist", async () => {
      const mockRegistry = {
        developer: {
          nsec: "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5",
          file: "developer.json",
        },
      };

      (fs.ensureDirectory as any).mockResolvedValue(undefined);
      (configService.loadTenexAgents as any).mockResolvedValue(mockRegistry);
      (fs.fileExists as any).mockResolvedValue(false);

      await registry.loadFromProject();

      const agent = await registry.loadAgentBySlug("developer");
      expect(agent).toBeNull();
    });
  });
});
