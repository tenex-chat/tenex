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
                tools: ["fs_read", "shell"],
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
            expect(agent.tools).toEqual(["fs_read", "shell"]);
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
            });

            expect(agent.description).toBeUndefined();
            expect(agent.instructions).toBeUndefined();
            expect(agent.useCriteria).toBeUndefined();
            expect(agent.tools).toBeUndefined();
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
                tools: ["fs_read"],
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
                tools: ["fs_read"],
            });

            await storage.saveAgent(agent);

            const newTools = ["fs_read", "shell", "agents_write"];
            const success = await storage.updateAgentTools(signer.pubkey, newTools);
            expect(success).toBe(true);

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.tools).toEqual(newTools);
        });

        it("should return false for non-existent agent", async () => {
            const success = await storage.updateAgentTools("nonexistent-pubkey", ["fs_read"]);
            expect(success).toBe(false);
        });
    });

    describe("updateAgentIsPM", () => {
        it("should set isPM flag in storage", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
            });

            await storage.saveAgent(agent);

            const success = await storage.updateAgentIsPM(signer.pubkey, true);
            expect(success).toBe(true);

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.isPM).toBe(true);
        });

        it("should clear isPM flag when set to false", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
            });

            await storage.saveAgent(agent);

            // First set to true
            await storage.updateAgentIsPM(signer.pubkey, true);
            let loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.isPM).toBe(true);

            // Then set to false - should delete the field
            await storage.updateAgentIsPM(signer.pubkey, false);
            loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.isPM).toBeUndefined();
        });

        it("should clear isPM flag when set to undefined", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
            });

            await storage.saveAgent(agent);

            // First set to true
            await storage.updateAgentIsPM(signer.pubkey, true);
            let loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.isPM).toBe(true);

            // Then clear with undefined
            await storage.updateAgentIsPM(signer.pubkey, undefined);
            loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.isPM).toBeUndefined();
        });

        it("should return false for non-existent agent", async () => {
            const success = await storage.updateAgentIsPM("nonexistent-pubkey", true);
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

    describe("project-scoped configuration", () => {
        it("should set and get project-scoped config", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                llmConfig: "anthropic:claude-sonnet-4",
                projects: ["project-1"],
            });

            await storage.saveAgent(agent);

            // Set project-scoped config
            storage.setProjectConfig(agent, "project-1", {
                llmConfig: "anthropic:claude-opus-4",
                isPM: true,
            });
            await storage.saveAgent(agent);

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.projectConfigs?.["project-1"]).toEqual({
                llmConfig: "anthropic:claude-opus-4",
                isPM: true,
            });
        });

        it("should resolve effective LLM config with project override", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                llmConfig: "anthropic:claude-sonnet-4",
                projects: ["project-1", "project-2"],
            });

            // Set project-scoped override for project-1 only
            storage.setProjectConfig(agent, "project-1", {
                llmConfig: "anthropic:claude-opus-4",
            });

            // project-1 should use override
            expect(storage.resolveEffectiveLLMConfig(agent, "project-1")).toBe("anthropic:claude-opus-4");

            // project-2 should use global
            expect(storage.resolveEffectiveLLMConfig(agent, "project-2")).toBe("anthropic:claude-sonnet-4");
        });

        it("should resolve effective tools with project override", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                tools: ["fs_read", "shell"],
                projects: ["project-1", "project-2"],
            });

            // Set project-scoped override for project-1 only
            storage.setProjectConfig(agent, "project-1", {
                tools: ["fs_read", "shell", "agents_write"],
            });

            // project-1 should use override
            expect(storage.resolveEffectiveTools(agent, "project-1")).toEqual(["fs_read", "shell", "agents_write"]);

            // project-2 should use global
            expect(storage.resolveEffectiveTools(agent, "project-2")).toEqual(["fs_read", "shell"]);
        });

        it("should resolve effective isPM with priority order", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1", "project-2", "project-3"],
            });

            // Test 1: No PM designation
            expect(storage.resolveEffectiveIsPM(agent, "project-1")).toBe(false);

            // Test 2: Legacy pmOverrides
            agent.pmOverrides = { "project-1": true };
            expect(storage.resolveEffectiveIsPM(agent, "project-1")).toBe(true);
            expect(storage.resolveEffectiveIsPM(agent, "project-2")).toBe(false);

            // Test 3: Project-scoped config takes precedence over pmOverrides for same project
            storage.setProjectConfig(agent, "project-2", { isPM: true });
            expect(storage.resolveEffectiveIsPM(agent, "project-2")).toBe(true);

            // Test 4: Global isPM takes highest precedence
            agent.isPM = true;
            expect(storage.resolveEffectiveIsPM(agent, "project-1")).toBe(true);
            expect(storage.resolveEffectiveIsPM(agent, "project-2")).toBe(true);
            expect(storage.resolveEffectiveIsPM(agent, "project-3")).toBe(true);
        });

        it("should update project-scoped LLM config via async method", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                llmConfig: "anthropic:claude-sonnet-4",
                projects: ["project-1"],
            });

            await storage.saveAgent(agent);

            const success = await storage.updateProjectScopedLLMConfig(
                signer.pubkey,
                "project-1",
                "anthropic:claude-opus-4"
            );
            expect(success).toBe(true);

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.projectConfigs?.["project-1"]?.llmConfig).toBe("anthropic:claude-opus-4");
        });

        it("should update project-scoped tools via async method", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                tools: ["fs_read"],
                projects: ["project-1"],
            });

            await storage.saveAgent(agent);

            const success = await storage.updateProjectScopedTools(
                signer.pubkey,
                "project-1",
                ["fs_read", "shell", "agents_write"]
            );
            expect(success).toBe(true);

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.projectConfigs?.["project-1"]?.tools).toEqual(["fs_read", "shell", "agents_write"]);
        });

        it("should update project-scoped isPM via async method", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            await storage.saveAgent(agent);

            const success = await storage.updateProjectScopedIsPM(
                signer.pubkey,
                "project-1",
                true
            );
            expect(success).toBe(true);

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.projectConfigs?.["project-1"]?.isPM).toBe(true);
        });

        it("should update complete project-scoped config authoritatively", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            await storage.saveAgent(agent);

            // Set initial config
            await storage.updateProjectScopedConfig(signer.pubkey, "project-1", {
                llmConfig: "anthropic:claude-opus-4",
                tools: ["fs_read", "shell"],
                isPM: true,
            });

            let loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.projectConfigs?.["project-1"]).toEqual({
                llmConfig: "anthropic:claude-opus-4",
                tools: ["fs_read", "shell"],
                isPM: true,
            });

            // Replace with new config (authoritative - previous isPM should be gone)
            await storage.updateProjectScopedConfig(signer.pubkey, "project-1", {
                llmConfig: "anthropic:claude-sonnet-4",
                tools: [],
            });

            loaded = await storage.loadAgent(signer.pubkey);
            // Empty tools array should result in no tools field
            // isPM should be gone since it wasn't in the new config
            expect(loaded?.projectConfigs?.["project-1"]).toEqual({
                llmConfig: "anthropic:claude-sonnet-4",
            });
        });

        it("should clear project config when all values are empty", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            await storage.saveAgent(agent);

            // Set config
            await storage.updateProjectScopedConfig(signer.pubkey, "project-1", {
                llmConfig: "anthropic:claude-opus-4",
            });

            let loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.projectConfigs?.["project-1"]).toBeDefined();

            // Clear config by setting empty
            await storage.updateProjectScopedConfig(signer.pubkey, "project-1", {});

            loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.projectConfigs).toBeUndefined();
        });

        it("should clean up undefined values in setProjectConfig", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            // Set config with undefined values
            storage.setProjectConfig(agent, "project-1", {
                llmConfig: "anthropic:claude-opus-4",
                tools: undefined,
                isPM: undefined,
            });

            // Only llmConfig should be present
            expect(agent.projectConfigs?.["project-1"]).toEqual({
                llmConfig: "anthropic:claude-opus-4",
            });
        });

        it("should merge with existing project config", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            // Set initial config
            storage.setProjectConfig(agent, "project-1", {
                llmConfig: "anthropic:claude-opus-4",
            });

            // Merge additional config
            storage.setProjectConfig(agent, "project-1", {
                isPM: true,
            });

            // Both should be present
            expect(agent.projectConfigs?.["project-1"]).toEqual({
                llmConfig: "anthropic:claude-opus-4",
                isPM: true,
            });
        });

        it("should clear project config via clearProjectConfig", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1", "project-2"],
            });

            storage.setProjectConfig(agent, "project-1", { llmConfig: "config-1" });
            storage.setProjectConfig(agent, "project-2", { llmConfig: "config-2" });

            expect(Object.keys(agent.projectConfigs!).length).toBe(2);

            storage.clearProjectConfig(agent, "project-1");

            expect(agent.projectConfigs?.["project-1"]).toBeUndefined();
            expect(agent.projectConfigs?.["project-2"]).toEqual({ llmConfig: "config-2" });
        });

        it("should clean up projectConfigs when last project config is cleared", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            storage.setProjectConfig(agent, "project-1", { llmConfig: "config-1" });
            expect(agent.projectConfigs).toBeDefined();

            storage.clearProjectConfig(agent, "project-1");
            expect(agent.projectConfigs).toBeUndefined();
        });
    });
});
