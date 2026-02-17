import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStorage, createStoredAgent, type StoredAgent } from "../AgentStorage";
import { AgentSlugConflictError } from "../errors";
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

            // Set project-scoped config (legacy method - uses projectConfigs)
            storage.setProjectConfig(agent, "project-1", {
                llmConfig: "anthropic:claude-opus-4",
                isPM: true,
            });
            await storage.saveAgent(agent);

            const loaded = await storage.loadAgent(signer.pubkey);
            // After migration, projectConfigs is migrated to projectOverrides
            // but isPM stays in projectConfigs (since it's not migrated to projectOverrides)
            // Verify resolution works correctly
            expect(storage.resolveEffectiveLLMConfig(loaded!, "project-1")).toBe("anthropic:claude-opus-4");
            expect(storage.resolveEffectiveIsPM(loaded!, "project-1")).toBe(true);
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
            // New schema: stored in projectOverrides
            expect(loaded?.projectOverrides?.["project-1"]?.model).toBe("anthropic:claude-opus-4");
            // And resolves correctly
            expect(storage.resolveEffectiveLLMConfig(loaded!, "project-1")).toBe("anthropic:claude-opus-4");
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
            // New schema: stored in projectOverrides
            expect(loaded?.projectOverrides?.["project-1"]?.tools).toEqual(["fs_read", "shell", "agents_write"]);
            // And resolves correctly
            expect(storage.resolveEffectiveTools(loaded!, "project-1")).toEqual(["fs_read", "shell", "agents_write"]);
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
            // isPM is still stored in projectConfigs for legacy compat
            expect(storage.resolveEffectiveIsPM(loaded!, "project-1")).toBe(true);
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
            // After migration, projectConfigs is gone, data in projectOverrides
            expect(storage.resolveEffectiveLLMConfig(loaded!, "project-1")).toBe("anthropic:claude-opus-4");
            expect(storage.resolveEffectiveTools(loaded!, "project-1")).toEqual(["fs_read", "shell"]);
            expect(storage.resolveEffectiveIsPM(loaded!, "project-1")).toBe(true);

            // Replace with new config (authoritative - previous isPM should be gone)
            await storage.updateProjectScopedConfig(signer.pubkey, "project-1", {
                llmConfig: "anthropic:claude-sonnet-4",
                tools: [],
            });

            loaded = await storage.loadAgent(signer.pubkey);
            // Empty tools array should result in no tools field
            // isPM should be gone since it wasn't in the new config
            expect(storage.resolveEffectiveLLMConfig(loaded!, "project-1")).toBe("anthropic:claude-sonnet-4");
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
            // After update, project override should exist
            expect(
                loaded?.projectOverrides?.["project-1"] ?? loaded?.projectConfigs?.["project-1"]
            ).toBeDefined();

            // Clear config by setting empty
            await storage.updateProjectScopedConfig(signer.pubkey, "project-1", {});

            loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.projectOverrides?.["project-1"]).toBeUndefined();
            expect(loaded?.projectConfigs?.["project-1"]).toBeUndefined();
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

    describe("new schema: updateDefaultConfig and updateProjectOverride", () => {
        it("should write to default block when calling updateDefaultConfig", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1"],
            });
            await storage.saveAgent(agent);

            const success = await storage.updateDefaultConfig(signer.pubkey, {
                model: "anthropic:claude-opus-4",
                tools: ["fs_read", "shell"],
            });
            expect(success).toBe(true);

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.default?.model).toBe("anthropic:claude-opus-4");
            expect(loaded?.default?.tools).toEqual(["fs_read", "shell"]);
            // Legacy fields should be in sync
            expect(loaded?.llmConfig).toBe("anthropic:claude-opus-4");
        });

        it("should write to projectOverrides when calling updateProjectOverride", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                defaultConfig: { model: "modelA", tools: ["tool1", "tool2"] },
                projects: ["project-1"],
            });
            await storage.saveAgent(agent);

            const success = await storage.updateProjectOverride(signer.pubkey, "project-1", {
                model: "modelB",
                tools: ["-tool1", "+tool4"],
            });
            expect(success).toBe(true);

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.projectOverrides?.["project-1"]?.model).toBe("modelB");
            expect(loaded?.projectOverrides?.["project-1"]?.tools).toEqual(["-tool1", "+tool4"]);

            // Effective config should resolve delta correctly
            expect(storage.resolveEffectiveLLMConfig(loaded!, "project-1")).toBe("modelB");
            expect(storage.resolveEffectiveTools(loaded!, "project-1")).toEqual(["tool2", "tool4"]);
        });

        it("should apply dedup: remove model override when same as default", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                defaultConfig: { model: "modelA", tools: ["tool1", "tool2"] },
                projects: ["project-1"],
            });
            await storage.saveAgent(agent);

            // Set initial override
            await storage.updateProjectOverride(signer.pubkey, "project-1", {
                model: "modelB",
                tools: ["tool1", "tool2"],
            });

            let loaded = await storage.loadAgent(signer.pubkey);
            // modelB is different from default (modelA), so kept
            // tools is same as default, so should be removed by dedup
            expect(loaded?.projectOverrides?.["project-1"]?.model).toBe("modelB");
            expect(loaded?.projectOverrides?.["project-1"]?.tools).toBeUndefined();

            // Now set model to same as default -> entire override should be cleared
            await storage.updateProjectOverride(signer.pubkey, "project-1", {
                model: "modelA",
            });

            loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.projectOverrides?.["project-1"]).toBeUndefined();
        });

        it("should reset project override when reset=true", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                defaultConfig: { model: "modelA", tools: ["tool1", "tool2"] },
                projects: ["project-1"],
            });
            await storage.saveAgent(agent);

            // Set override
            await storage.updateProjectOverride(signer.pubkey, "project-1", {
                model: "modelB",
                tools: ["+tool3"],
            });

            let loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.projectOverrides?.["project-1"]).toBeDefined();

            // Reset
            const success = await storage.updateProjectOverride(
                signer.pubkey, "project-1", {}, true
            );
            expect(success).toBe(true);

            loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.projectOverrides?.["project-1"]).toBeUndefined();
            expect(loaded?.projectOverrides).toBeUndefined();

            // Effective config should fall back to defaults
            expect(storage.resolveEffectiveLLMConfig(loaded!, "project-1")).toBe("modelA");
            expect(storage.resolveEffectiveTools(loaded!, "project-1")).toEqual(["tool1", "tool2"]);
        });

        it("should handle full example from requirements", async () => {
            // agentA has:
            //   default: { model: 'modelA', tools: [ 'tool1', 'tool2' ] }
            //   projectA: { model: 'modelB', tools: [ '-tool1', '+tool4' ] } -> modelB, [tool2, tool4]
            //   projectB: { tools: [ '+tool5' ] } -> modelA, [tool1, tool2, tool5]
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "agent-a",
                name: "Agent A",
                role: "assistant",
                defaultConfig: { model: "modelA", tools: ["tool1", "tool2"] },
                projects: ["project-a", "project-b"],
                projectOverrides: {
                    "project-a": { model: "modelB", tools: ["-tool1", "+tool4"] },
                    "project-b": { tools: ["+tool5"] },
                },
            });
            await storage.saveAgent(agent);

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded).toBeDefined();

            // projectA: modelB, [tool2, tool4]
            expect(storage.resolveEffectiveLLMConfig(loaded!, "project-a")).toBe("modelB");
            expect(storage.resolveEffectiveTools(loaded!, "project-a")).toEqual(["tool2", "tool4"]);

            // projectB: modelA, [tool1, tool2, tool5]
            expect(storage.resolveEffectiveLLMConfig(loaded!, "project-b")).toBe("modelA");
            expect(storage.resolveEffectiveTools(loaded!, "project-b")).toEqual(["tool1", "tool2", "tool5"]);

            // Now send 24020 a-tagging projectB with: { model: 'modelA', tools: ['tool1', 'tool2'] }
            // -> config becomes projectB: {} (empty = deleted)
            await storage.updateProjectOverride(signer.pubkey, "project-b", {
                model: "modelA",
                tools: ["tool1", "tool2"],
            });

            const updated = await storage.loadAgent(signer.pubkey);
            expect(updated?.projectOverrides?.["project-b"]).toBeUndefined();

            // After reset, projectB uses defaults
            expect(storage.resolveEffectiveLLMConfig(updated!, "project-b")).toBe("modelA");
            expect(storage.resolveEffectiveTools(updated!, "project-b")).toEqual(["tool1", "tool2"]);

            // projectA should be unchanged
            expect(storage.resolveEffectiveLLMConfig(updated!, "project-a")).toBe("modelB");
        });

        it("should NOT clear model or tools when only isPM is updated (PM-only update behavior)", async () => {
            // DESIGN: A PM-only 24020 event (no model/tools tags) uses PARTIAL-UPDATE semantics.
            // Only fields explicitly present in the event are updated; absent fields are unchanged.
            // This means updateDefaultConfig({}) must NOT clear existing model or tools.
            // Clearing would require an explicit reset tag or explicit empty-value fields.
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                defaultConfig: { model: "anthropic:claude-sonnet-4", tools: ["fs_read", "shell"] },
                projects: ["project-1"],
            });
            await storage.saveAgent(agent);

            // Step 1: Simulate PM designation (updateAgentIsPM is called separately)
            const pmSuccess = await storage.updateAgentIsPM(signer.pubkey, true);
            expect(pmSuccess).toBe(true);

            // Step 2: Simulate the updateDefaultConfig call with no model/tools
            // This is what the event handler does when a 24020 has only a ["pm"] tag
            const success = await storage.updateDefaultConfig(signer.pubkey, {
                // No model, no tools - only pm is being changed via updateAgentIsPM above
            });
            expect(success).toBe(true);

            const loaded = await storage.loadAgent(signer.pubkey);
            // PM should now be true
            expect(loaded?.isPM).toBe(true);
            // Model and tools should be UNCHANGED - PM-only update must not clear them
            expect(loaded?.default?.model).toBe("anthropic:claude-sonnet-4");
            expect(loaded?.default?.tools).toEqual(["fs_read", "shell"]);
        });

        it("should deduplicate no-op delta: +tool where tool already in defaults is a no-op", async () => {
            // Issue 3: If a project override delta becomes a no-op (e.g., +tool that's already
            // in defaults), it should be cleaned up - user is confirming availability.
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                defaultConfig: { model: "modelA", tools: ["fs_read", "shell"] },
                projects: ["project-1"],
            });
            await storage.saveAgent(agent);

            // Pass a delta where "+fs_read" is already in defaults - resolves to same as defaults
            // resolves to: apply +fs_read to [fs_read, shell] → [fs_read, shell] = same as defaults
            const success = await storage.updateProjectOverride(signer.pubkey, "project-1", {
                tools: ["+fs_read"], // fs_read is already in defaults, so this is a no-op
            });
            expect(success).toBe(true);

            const loaded = await storage.loadAgent(signer.pubkey);
            // No-op delta: resolved tools equal defaults → override should be cleared
            expect(loaded?.projectOverrides?.["project-1"]).toBeUndefined();
        });

        it("should preserve useful part of delta when only some entries are no-ops", async () => {
            // If a delta has mixed entries (some no-op, some actual changes), only the
            // effective difference should be stored.
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                defaultConfig: { model: "modelA", tools: ["fs_read", "shell"] },
                projects: ["project-1"],
            });
            await storage.saveAgent(agent);

            // Delta: +fs_read (already there = no-op), +agents_write (new = actual change)
            // Resolved: [fs_read, shell, agents_write] ≠ defaults [fs_read, shell]
            // So override should NOT be cleared - it represents a real difference
            const success = await storage.updateProjectOverride(signer.pubkey, "project-1", {
                tools: ["+fs_read", "+agents_write"],
            });
            expect(success).toBe(true);

            const loaded = await storage.loadAgent(signer.pubkey);
            // Override should still exist because resolved result differs from defaults
            expect(loaded?.projectOverrides?.["project-1"]).toBeDefined();
            // The STORED delta should be normalized: "+fs_read" is a no-op (fs_read is already
            // in defaults), so it should be removed from the stored delta. Only "+agents_write"
            // represents a real change and should remain.
            expect(loaded?.projectOverrides?.["project-1"]?.tools).toEqual(["+agents_write"]);
            // The effective tools should be [fs_read, shell, agents_write]
            expect(storage.resolveEffectiveTools(loaded!, "project-1")).toEqual([
                "fs_read",
                "shell",
                "agents_write",
            ]);
        });

        it("should migrate legacy agent file on load (llmConfig -> default.model)", async () => {
            const signer = NDKPrivateKeySigner.generate();
            // Create agent with old schema (llmConfig directly on agent)
            const legacyAgent = createStoredAgent({
                nsec: signer.nsec,
                slug: "legacy-agent",
                name: "Legacy Agent",
                role: "assistant",
                llmConfig: "anthropic:claude-sonnet-4",
                tools: ["fs_read", "shell"],
                projects: ["project-1"],
            });
            // Save WITHOUT new schema fields (simulate old format)
            await storage.saveAgent(legacyAgent);

            // Force save with old format (without default block)
            const { default: _d, projectOverrides: _po, ...oldFormat } = legacyAgent as any;
            const filePath = `${(storage as any).agentsDir}/${signer.pubkey}.json`;
            const fs = await import("node:fs/promises");
            await fs.writeFile(filePath, JSON.stringify(oldFormat, null, 2));

            // Load agent - should trigger migration
            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded).toBeDefined();

            // After migration, default block should be populated
            expect(loaded?.default?.model).toBe("anthropic:claude-sonnet-4");
            expect(loaded?.default?.tools).toEqual(["fs_read", "shell"]);

            // Resolution should still work
            expect(storage.resolveEffectiveLLMConfig(loaded!, "project-1")).toBe("anthropic:claude-sonnet-4");
            expect(storage.resolveEffectiveTools(loaded!, "project-1")).toEqual(["fs_read", "shell"]);
        });
    });

    describe("multi-project slug index", () => {
        it("should track same agent across multiple projects in slug index", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "shared-agent",
                name: "Shared Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            await storage.saveAgent(agent);

            // Add agent to second project
            agent.projects = ["project-1", "project-2"];
            await storage.saveAgent(agent);

            // Verify slug entry tracks both projects
            const loaded = await storage.getAgentBySlug("shared-agent");
            expect(loaded).toBeDefined();
            expect(loaded?.projects).toContain("project-1");
            expect(loaded?.projects).toContain("project-2");
        });

        it("should cleanup old agent when new agent claims same slug in overlapping projects", async () => {
            const signer1 = NDKPrivateKeySigner.generate();
            const signer2 = NDKPrivateKeySigner.generate();

            const agent1 = createStoredAgent({
                nsec: signer1.nsec,
                slug: "conflict-slug",
                name: "Agent 1",
                role: "assistant",
                projects: ["project-1"],
            });

            const agent2 = createStoredAgent({
                nsec: signer2.nsec,
                slug: "conflict-slug",
                name: "Agent 2",
                role: "assistant",
                projects: ["project-1"],
            });

            await storage.saveAgent(agent1);

            // Cleanup will remove agent1 from project-1 (the overlapping project)
            // This will delete agent1 entirely since it has no projects left
            // So agent2 can take over the slug without conflict
            await storage.saveAgent(agent2);

            // Verify agent2 took the slug
            const loaded = await storage.getAgentBySlug("conflict-slug");
            expect(loaded?.name).toBe("Agent 2");

            // Verify agent1 was deleted
            const agent1Loaded = await storage.loadAgent(signer1.pubkey);
            expect(agent1Loaded).toBeNull();
        });

        it("should allow same slug in different projects when no overlap", async () => {
            const signer1 = NDKPrivateKeySigner.generate();
            const signer2 = NDKPrivateKeySigner.generate();

            const agent1 = createStoredAgent({
                nsec: signer1.nsec,
                slug: "my-agent",
                name: "Agent 1",
                role: "assistant",
                projects: ["project-1"],
            });

            const agent2 = createStoredAgent({
                nsec: signer2.nsec,
                slug: "my-agent",
                name: "Agent 2",
                role: "assistant",
                projects: ["project-2"],
            });

            await storage.saveAgent(agent1);

            // No overlap in projects, so no cleanup needed
            // Agent2 will take over the slug
            await storage.saveAgent(agent2);

            // Verify agent2 took over the slug
            const loaded = await storage.getAgentBySlug("my-agent");
            expect(loaded?.name).toBe("Agent 2");

            // Verify agent1 still exists in project-1
            // (no cleanup happened because no overlapping projects)
            const agent1Loaded = await storage.loadAgent(signer1.pubkey);
            expect(agent1Loaded).not.toBeNull();
            expect(agent1Loaded?.projects).toEqual(["project-1"]);
        });

        it("should migrate old flat index format to SlugEntry structure", async () => {
            // Override config path for this specific test
            const ConfigService = await import("@/services/ConfigService");
            const originalGetConfigPath = ConfigService.config.getConfigPath;
            ConfigService.config.getConfigPath = () => tempDir;

            try {
                const signer = NDKPrivateKeySigner.generate();
                const agent = createStoredAgent({
                    nsec: signer.nsec,
                    slug: "test-agent",
                    name: "Test Agent",
                    role: "assistant",
                    projects: ["project-1", "project-2"],
                });

                // Manually save agent file
                const agentPath = path.join(tempDir, `${signer.pubkey}.json`);
                await fs.writeFile(agentPath, JSON.stringify(agent, null, 2));

                // Create OLD format index
                const oldIndex = {
                    bySlug: {
                        "test-agent": signer.pubkey, // Old flat format
                    },
                    byEventId: {},
                    byProject: {
                        "project-1": [signer.pubkey],
                        "project-2": [signer.pubkey],
                    },
                };

                const indexPath = path.join(tempDir, "index.json");
                await fs.writeFile(indexPath, JSON.stringify(oldIndex, null, 2));

                // Create new storage instance to trigger migration
                const newStorage = new AgentStorage();
                await newStorage.initialize();

                // Verify migration happened
                const loaded = await newStorage.getAgentBySlug("test-agent");
                expect(loaded).toBeDefined();
                expect(loaded?.projects).toEqual(["project-1", "project-2"]);

                // Verify index is now in new format
                const indexContent = await fs.readFile(indexPath, "utf-8");
                const migratedIndex = JSON.parse(indexContent);
                expect(migratedIndex.bySlug["test-agent"]).toHaveProperty("pubkey");
                expect(migratedIndex.bySlug["test-agent"]).toHaveProperty("projects");
                expect(migratedIndex.bySlug["test-agent"].projects).toContain("project-1");
                expect(migratedIndex.bySlug["test-agent"].projects).toContain("project-2");
            } finally {
                ConfigService.config.getConfigPath = originalGetConfigPath;
            }
        });

        it("should handle migration with missing byProject entries", async () => {
            // Override config path for this specific test
            const ConfigService = await import("@/services/ConfigService");
            const originalGetConfigPath = ConfigService.config.getConfigPath;
            ConfigService.config.getConfigPath = () => tempDir;

            try {
                const signer = NDKPrivateKeySigner.generate();
                const agent = createStoredAgent({
                    nsec: signer.nsec,
                    slug: "orphan-agent",
                    name: "Orphan Agent",
                    role: "assistant",
                    projects: ["project-1"],
                });

                // Manually save agent file
                const agentPath = path.join(tempDir, `${signer.pubkey}.json`);
                await fs.writeFile(agentPath, JSON.stringify(agent, null, 2));

                // Create OLD format index with MISSING byProject entry
                const oldIndex = {
                    bySlug: {
                        "orphan-agent": signer.pubkey, // Old flat format
                    },
                    byEventId: {},
                    byProject: {}, // Empty - no projects tracked
                };

                const indexPath = path.join(tempDir, "index.json");
                await fs.writeFile(indexPath, JSON.stringify(oldIndex, null, 2));

                // Create new storage instance to trigger migration
                const newStorage = new AgentStorage();
                await newStorage.initialize();

                // Verify migration happened despite missing byProject
                const loaded = await newStorage.getAgentBySlug("orphan-agent");
                expect(loaded).toBeDefined();

                // Verify index is now in new format with empty projects array
                const indexContent = await fs.readFile(indexPath, "utf-8");
                const migratedIndex = JSON.parse(indexContent);
                expect(migratedIndex.bySlug["orphan-agent"]).toHaveProperty("pubkey");
                expect(migratedIndex.bySlug["orphan-agent"]).toHaveProperty("projects");
                // Should have empty projects array since byProject was missing
                expect(migratedIndex.bySlug["orphan-agent"].projects).toEqual([]);
            } finally {
                ConfigService.config.getConfigPath = originalGetConfigPath;
            }
        });

        it("should remove slug entry when agent has no projects left", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "temp-agent",
                name: "Temp Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            await storage.saveAgent(agent);

            // Remove from project (will delete agent)
            await storage.removeAgentFromProject(signer.pubkey, "project-1");

            // Slug should no longer exist
            const loaded = await storage.getAgentBySlug("temp-agent");
            expect(loaded).toBeNull();
        });

        it("should handle cleanupDuplicateSlugs correctly", async () => {
            const signer1 = NDKPrivateKeySigner.generate();
            const signer2 = NDKPrivateKeySigner.generate();

            // Agent 1 in projects 1 and 2
            const agent1 = createStoredAgent({
                nsec: signer1.nsec,
                slug: "cleanup-test",
                name: "Agent 1",
                role: "assistant",
                projects: ["project-1", "project-2"],
            });

            // Agent 2 trying to claim same slug in project 2
            const agent2 = createStoredAgent({
                nsec: signer2.nsec,
                slug: "cleanup-test",
                name: "Agent 2",
                role: "assistant",
                projects: ["project-2"],
            });

            await storage.saveAgent(agent1);
            await storage.saveAgent(agent2);

            // Agent 1 should still exist but only in project-1
            const agent1Loaded = await storage.loadAgent(signer1.pubkey);
            expect(agent1Loaded?.projects).toEqual(["project-1"]);

            // Agent 2 should have project-2
            const agent2Loaded = await storage.loadAgent(signer2.pubkey);
            expect(agent2Loaded?.projects).toEqual(["project-2"]);

            // Slug should point to agent2 (last one saved)
            const slugLookup = await storage.getAgentBySlug("cleanup-test");
            expect(slugLookup?.name).toBe("Agent 2");
        });

        it("should rebuild index with multi-project slug support", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "rebuild-test",
                name: "Rebuild Test",
                role: "assistant",
                projects: ["project-1", "project-2", "project-3"],
            });

            await storage.saveAgent(agent);

            // Rebuild index
            await storage.rebuildIndex();

            // Verify slug entry has all projects
            const loaded = await storage.getAgentBySlug("rebuild-test");
            expect(loaded).toBeDefined();
            expect(loaded?.projects).toContain("project-1");
            expect(loaded?.projects).toContain("project-2");
            expect(loaded?.projects).toContain("project-3");
        });

        it("should remove ghost projects from slug entry when agent leaves project", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "leaving-agent",
                name: "Leaving Agent",
                role: "assistant",
                projects: ["project-1", "project-2", "project-3"],
            });

            await storage.saveAgent(agent);

            // Manually verify initial state - slug entry should have all 3 projects
            const indexPath = path.join(tempDir, "index.json");
            let indexContent = await fs.readFile(indexPath, "utf-8");
            let index = JSON.parse(indexContent);
            expect(index.bySlug["leaving-agent"].projects).toEqual(["project-1", "project-2", "project-3"]);

            // Remove agent from project-2
            agent.projects = ["project-1", "project-3"];
            await storage.saveAgent(agent);

            // Verify slug entry synced to current projects (ghost project-2 removed)
            indexContent = await fs.readFile(indexPath, "utf-8");
            index = JSON.parse(indexContent);
            expect(index.bySlug["leaving-agent"].projects).toEqual(["project-1", "project-3"]);
            expect(index.bySlug["leaving-agent"].projects).not.toContain("project-2");
        });

        it("should sync slug entry when agent changes slug", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "old-slug",
                name: "Renaming Agent",
                role: "assistant",
                projects: ["project-1", "project-2"],
            });

            await storage.saveAgent(agent);

            // Change slug
            agent.slug = "new-slug";
            await storage.saveAgent(agent);

            // Verify old slug entry removed
            const indexPath = path.join(tempDir, "index.json");
            const indexContent = await fs.readFile(indexPath, "utf-8");
            const index = JSON.parse(indexContent);
            expect(index.bySlug["old-slug"]).toBeUndefined();

            // Verify new slug entry has correct projects
            expect(index.bySlug["new-slug"].pubkey).toBe(signer.pubkey);
            expect(index.bySlug["new-slug"].projects).toEqual(["project-1", "project-2"]);
        });

        it("should handle getProjectAgents when slugs are shared across projects", async () => {
            const signer1 = NDKPrivateKeySigner.generate();
            const signer2 = NDKPrivateKeySigner.generate();

            // Agent 1 with "worker" slug in project-1
            const agent1 = createStoredAgent({
                nsec: signer1.nsec,
                slug: "worker",
                name: "Worker 1",
                role: "assistant",
                projects: ["project-1"],
            });

            // Agent 2 with "worker" slug in project-2
            const agent2 = createStoredAgent({
                nsec: signer2.nsec,
                slug: "worker",
                name: "Worker 2",
                role: "assistant",
                projects: ["project-2"],
            });

            await storage.saveAgent(agent1);
            await storage.saveAgent(agent2);

            // Both agents should be retrievable from their respective projects
            const project1Agents = await storage.getProjectAgents("project-1");
            expect(project1Agents).toHaveLength(1);
            expect(project1Agents[0].name).toBe("Worker 1");

            const project2Agents = await storage.getProjectAgents("project-2");
            expect(project2Agents).toHaveLength(1);
            expect(project2Agents[0].name).toBe("Worker 2");

            // Verify bySlug points to last saved agent (agent2)
            const slugLookup = await storage.getAgentBySlug("worker");
            expect(slugLookup?.name).toBe("Worker 2");
        });

        it("should shrink slug entry when agent is removed from projects", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "shrinking-agent",
                name: "Shrinking Agent",
                role: "assistant",
                projects: ["project-1", "project-2", "project-3"],
            });

            await storage.saveAgent(agent);

            // Use removeAgentFromProject to remove from project-2
            await storage.removeAgentFromProject(signer.pubkey, "project-2");

            // Verify slug entry shrunk
            const indexPath = path.join(tempDir, "index.json");
            let indexContent = await fs.readFile(indexPath, "utf-8");
            let index = JSON.parse(indexContent);
            expect(index.bySlug["shrinking-agent"].projects).toEqual(["project-1", "project-3"]);

            // Remove from another project
            await storage.removeAgentFromProject(signer.pubkey, "project-1");

            indexContent = await fs.readFile(indexPath, "utf-8");
            index = JSON.parse(indexContent);
            expect(index.bySlug["shrinking-agent"].projects).toEqual(["project-3"]);

            // Remove from last project (should delete agent and slug entry)
            await storage.removeAgentFromProject(signer.pubkey, "project-3");

            indexContent = await fs.readFile(indexPath, "utf-8");
            index = JSON.parse(indexContent);
            expect(index.bySlug["shrinking-agent"]).toBeUndefined();
        });

        it("should handle corrupted index with duplicate slugs in same project", async () => {
            const signer1 = NDKPrivateKeySigner.generate();
            const signer2 = NDKPrivateKeySigner.generate();

            const agent1 = createStoredAgent({
                nsec: signer1.nsec,
                slug: "duplicate-slug",
                name: "Agent 1",
                role: "assistant",
                projects: ["project-1"],
            });

            const agent2 = createStoredAgent({
                nsec: signer2.nsec,
                slug: "duplicate-slug",
                name: "Agent 2",
                role: "assistant",
                projects: ["project-1"],
            });

            // Save both agents (this would normally trigger cleanup)
            await storage.saveAgent(agent1);

            // Manually corrupt the index to simulate the bug scenario
            // Add both agents to the same project with same slug
            const indexPath = path.join(tempDir, "index.json");
            let indexContent = await fs.readFile(indexPath, "utf-8");
            let index = JSON.parse(indexContent);

            // Force both pubkeys into project-1
            index.byProject["project-1"].push(signer2.pubkey);
            await fs.writeFile(indexPath, JSON.stringify(index, null, 2));

            // Manually save agent2 file
            const agent2Path = path.join(tempDir, `${signer2.pubkey}.json`);
            await fs.writeFile(agent2Path, JSON.stringify(agent2, null, 2));

            // getProjectAgents should handle this gracefully (return only first agent)
            const projectAgents = await storage.getProjectAgents("project-1");
            expect(projectAgents).toHaveLength(1);
            expect(projectAgents[0].name).toBe("Agent 1");
        });
    });
});
