import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStorage, createStoredAgent, type StoredAgent } from "../AgentStorage";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

describe("AgentStorage", () => {
    let tempDir: string;
    let storage: AgentStorage;

    beforeEach(async () => {
        // Create temp directory for test storage
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-storage-test-"));

        // Override config path for testing
        const originalGetConfigPath = (await import("@/services/ConfigService")).config.getConfigPath;
        (await import("@/services/ConfigService")).config.getConfigPath = () => tempDir;

        storage = new AgentStorage();
        await storage.initialize();

        // Restore original
        (await import("@/services/ConfigService")).config.getConfigPath = originalGetConfigPath;
    });

    afterEach(async () => {
        // Clean up temp directory
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    describe("createStoredAgent factory", () => {
        it("should create a StoredAgent with all required fields", () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                description: "A test agent",
                instructions: "Test instructions",
                useCriteria: "Test criteria",
                llmConfig: "anthropic:claude-sonnet-4",
                tools: ["read_path", "shell"],
                phases: { planning: "Plan the task" },
                eventId: "test-event-id",
                projects: ["project-1"],
            });

            expect(agent.nsec).toBe(signer.nsec);
            expect(agent.slug).toBe("test-agent");
            expect(agent.name).toBe("Test Agent");
            expect(agent.role).toBe("assistant");
            expect(agent.description).toBe("A test agent");
            expect(agent.instructions).toBe("Test instructions");
            expect(agent.useCriteria).toBe("Test criteria");
            expect(agent.llmConfig).toBe("anthropic:claude-sonnet-4");
            expect(agent.tools).toEqual(["read_path", "shell"]);
            expect(agent.phases).toEqual({ planning: "Plan the task" });
            expect(agent.eventId).toBe("test-event-id");
            expect(agent.projects).toEqual(["project-1"]);
        });

        it("should handle null values by converting to undefined", () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                description: null,
                instructions: null,
                useCriteria: null,
                tools: null,
                phases: null,
            });

            expect(agent.description).toBeUndefined();
            expect(agent.instructions).toBeUndefined();
            expect(agent.useCriteria).toBeUndefined();
            expect(agent.tools).toBeUndefined();
            expect(agent.phases).toBeUndefined();
        });

        it("should default projects to empty array", () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
            });

            expect(agent.projects).toEqual([]);
        });
    });

    describe("saveAgent and loadAgent", () => {
        it("should save and load an agent", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                tools: ["read_path"],
            });

            await storage.saveAgent(agent);

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded).toBeDefined();
            expect(loaded?.slug).toBe("test-agent");
            expect(loaded?.name).toBe("Test Agent");
            expect(loaded?.nsec).toBe(signer.nsec);
        });

        it("should return null for non-existent agent", async () => {
            const loaded = await storage.loadAgent("nonexistent-pubkey");
            expect(loaded).toBeNull();
        });

        it("should overwrite existing agent on save", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Original Name",
                role: "assistant",
            });

            await storage.saveAgent(agent);

            // Update and save again
            agent.name = "Updated Name";
            await storage.saveAgent(agent);

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.name).toBe("Updated Name");
        });
    });

    describe("index management", () => {
        it("should index agent by slug", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
            });

            await storage.saveAgent(agent);

            const loaded = await storage.getAgentBySlug("test-agent");
            expect(loaded).toBeDefined();
            expect(loaded?.name).toBe("Test Agent");
        });

        it("should index agent by eventId", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                eventId: "test-event-123",
            });

            await storage.saveAgent(agent);

            const loaded = await storage.getAgentByEventId("test-event-123");
            expect(loaded).toBeDefined();
            expect(loaded?.slug).toBe("test-agent");
        });

        it("should update index when agent slug changes", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "old-slug",
                name: "Test Agent",
                role: "assistant",
            });

            await storage.saveAgent(agent);

            // Change slug and save
            agent.slug = "new-slug";
            await storage.saveAgent(agent);

            // Old slug should not exist
            const oldLookup = await storage.getAgentBySlug("old-slug");
            expect(oldLookup).toBeNull();

            // New slug should work
            const newLookup = await storage.getAgentBySlug("new-slug");
            expect(newLookup).toBeDefined();
            expect(newLookup?.slug).toBe("new-slug");
        });
    });

    describe("updateAgentLLMConfig", () => {
        it("should update LLM config in storage", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                llmConfig: "anthropic:claude-sonnet-4",
            });

            await storage.saveAgent(agent);

            const success = await storage.updateAgentLLMConfig(
                signer.pubkey,
                "anthropic:claude-opus-4"
            );
            expect(success).toBe(true);

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.llmConfig).toBe("anthropic:claude-opus-4");
        });

        it("should return false for non-existent agent", async () => {
            const success = await storage.updateAgentLLMConfig(
                "nonexistent-pubkey",
                "anthropic:claude-opus-4"
            );
            expect(success).toBe(false);
        });
    });

    describe("updateAgentTools", () => {
        it("should update tools in storage", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                tools: ["read_path"],
            });

            await storage.saveAgent(agent);

            const newTools = ["read_path", "shell", "agents_write"];
            const success = await storage.updateAgentTools(signer.pubkey, newTools);
            expect(success).toBe(true);

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.tools).toEqual(newTools);
        });

        it("should return false for non-existent agent", async () => {
            const success = await storage.updateAgentTools("nonexistent-pubkey", ["read_path"]);
            expect(success).toBe(false);
        });
    });

    describe("project associations", () => {
        it("should add agent to project", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: [],
            });

            await storage.saveAgent(agent);

            await storage.addAgentToProject(signer.pubkey, "project-1");

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.projects).toContain("project-1");
        });

        it("should not add duplicate project", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            await storage.saveAgent(agent);

            await storage.addAgentToProject(signer.pubkey, "project-1");

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.projects.filter((p) => p === "project-1").length).toBe(1);
        });

        it("should remove agent from project", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1", "project-2"],
            });

            await storage.saveAgent(agent);

            await storage.removeAgentFromProject(signer.pubkey, "project-1");

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.projects).not.toContain("project-1");
            expect(loaded?.projects).toContain("project-2");
        });

        it("should delete agent when removed from all projects", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            await storage.saveAgent(agent);

            await storage.removeAgentFromProject(signer.pubkey, "project-1");

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded).toBeNull();
        });
    });
});
