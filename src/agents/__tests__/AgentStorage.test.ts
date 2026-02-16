import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStorage, createStoredAgent, isAgentActive, type StoredAgent } from "../AgentStorage";
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

        it("should set status to 'active' when projects are provided", () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            expect(agent.status).toBe("active");
        });

        it("should set status to 'inactive' when no projects are provided", () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: [],
            });

            expect(agent.status).toBe("inactive");
        });

        it("should set status to 'inactive' when projects is undefined", () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
            });

            expect(agent.status).toBe("inactive");
        });
    });

    describe("isAgentActive helper", () => {
        it("should return true for agents with status 'active'", () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            expect(isAgentActive(agent)).toBe(true);
        });

        it("should return false for agents with status 'inactive'", () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: [],
            });

            expect(isAgentActive(agent)).toBe(false);
        });

        it("should return true for legacy agents without status field but with projects", () => {
            const signer = NDKPrivateKeySigner.generate();
            // Simulate a legacy agent without status field
            const agent: StoredAgent = {
                nsec: signer.nsec,
                slug: "legacy-agent",
                name: "Legacy Agent",
                role: "assistant",
                projects: ["project-1"],
            };
            // Explicitly remove status to simulate legacy data
            delete (agent as Record<string, unknown>).status;

            expect(isAgentActive(agent)).toBe(true);
        });

        it("should return false for legacy agents without status field and no projects", () => {
            const signer = NDKPrivateKeySigner.generate();
            // Simulate a legacy agent without status field
            const agent: StoredAgent = {
                nsec: signer.nsec,
                slug: "legacy-agent",
                name: "Legacy Agent",
                role: "assistant",
                projects: [],
            };
            // Explicitly remove status to simulate legacy data
            delete (agent as Record<string, unknown>).status;

            expect(isAgentActive(agent)).toBe(false);
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

        it("should set agent to inactive when removed from all projects (identity preservation)", async () => {
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

            // Agent should still exist but be inactive
            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded).not.toBeNull();
            expect(loaded?.status).toBe("inactive");
            expect(loaded?.projects).toEqual([]);
            // Identity should be preserved
            expect(loaded?.nsec).toBe(signer.nsec);
            expect(loaded?.slug).toBe("test-agent");
        });

        it("should reactivate inactive agent when added to project", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            await storage.saveAgent(agent);

            // Remove from all projects - becomes inactive
            await storage.removeAgentFromProject(signer.pubkey, "project-1");
            let loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.status).toBe("inactive");

            // Add to new project - should reactivate
            await storage.addAgentToProject(signer.pubkey, "project-2");
            loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.status).toBe("active");
            expect(loaded?.projects).toContain("project-2");
            // Original identity preserved
            expect(loaded?.nsec).toBe(signer.nsec);
        });

        it("should not return inactive agents in getProjectAgents", async () => {
            const signer1 = NDKPrivateKeySigner.generate();
            const signer2 = NDKPrivateKeySigner.generate();

            const activeAgent = createStoredAgent({
                nsec: signer1.nsec,
                slug: "active-agent",
                name: "Active Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            const inactiveAgent = createStoredAgent({
                nsec: signer2.nsec,
                slug: "inactive-agent",
                name: "Inactive Agent",
                role: "assistant",
                projects: ["project-1"],
                // Note: status will be set to inactive after removal
            });

            await storage.saveAgent(activeAgent);
            await storage.saveAgent(inactiveAgent);

            // Both agents should be in project initially
            let projectAgents = await storage.getProjectAgents("project-1");
            expect(projectAgents.length).toBe(2);

            // Remove inactive agent from project (becomes inactive)
            await storage.removeAgentFromProject(signer2.pubkey, "project-1");

            // Only active agent should be returned
            projectAgents = await storage.getProjectAgents("project-1");
            expect(projectAgents.length).toBe(1);
            expect(projectAgents[0].slug).toBe("active-agent");
        });

        it("should keep inactive agent in bySlug index for reactivation", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            await storage.saveAgent(agent);

            // Remove from all projects - becomes inactive
            await storage.removeAgentFromProject(signer.pubkey, "project-1");

            // Should still be findable by slug
            const foundBySlug = await storage.getAgentBySlug("test-agent");
            expect(foundBySlug).not.toBeNull();
            expect(foundBySlug?.status).toBe("inactive");
        });

        it("should preserve active agent visibility when same-slug agent becomes inactive (slug collision bug)", async () => {
            // This is a regression test for the slug index collision bug
            // Scenario: Agent in project becomes inactive, then we verify
            // that after reactivating a different agent with the same slug,
            // the bySlug index correctly points to the active one.
            //
            // The actual bug was: when saveAgent was called on an inactive agent,
            // it would overwrite bySlug even though another active agent should own it.

            const signer1 = NDKPrivateKeySigner.generate();

            // Create an active agent with "my-agent" slug
            const agent1 = createStoredAgent({
                nsec: signer1.nsec,
                slug: "my-agent",
                name: "Agent 1",
                role: "assistant",
                projects: ["project-1"],
            });
            await storage.saveAgent(agent1);

            // Verify agent is visible
            let projectAgents = await storage.getProjectAgents("project-1");
            expect(projectAgents.length).toBe(1);
            expect(projectAgents[0].name).toBe("Agent 1");

            // Remove from project - becomes inactive
            await storage.removeAgentFromProject(signer1.pubkey, "project-1");

            // Agent should still own bySlug for reactivation lookup
            let bySlug = await storage.getAgentBySlug("my-agent");
            expect(bySlug).not.toBeNull();
            expect(bySlug?.status).toBe("inactive");

            // Reactivate the agent
            await storage.addAgentToProject(signer1.pubkey, "project-2");

            // Agent should be active and visible again
            projectAgents = await storage.getProjectAgents("project-2");
            expect(projectAgents.length).toBe(1);
            expect(projectAgents[0].status).toBe("active");

            // bySlug should still point to this agent
            bySlug = await storage.getAgentBySlug("my-agent");
            expect(bySlug?.status).toBe("active");
        });

        it("should handle inactive agent not overwriting active agent slug index on save", async () => {
            // Direct test of the saveAgent slug index logic

            const activeSigner = NDKPrivateKeySigner.generate();
            const inactiveSigner = NDKPrivateKeySigner.generate();

            // Create and save active agent first
            const activeAgent = createStoredAgent({
                nsec: activeSigner.nsec,
                slug: "shared-slug",
                name: "Active Agent",
                role: "assistant",
                projects: ["project-1"],
            });
            await storage.saveAgent(activeAgent);

            // Create inactive agent with same slug
            const inactiveAgent = createStoredAgent({
                nsec: inactiveSigner.nsec,
                slug: "shared-slug",
                name: "Inactive Agent",
                role: "assistant",
                projects: [], // No projects = inactive
            });
            // Force status to inactive since createStoredAgent now sets it
            inactiveAgent.status = "inactive";
            await storage.saveAgent(inactiveAgent);

            // bySlug should still point to the active agent
            const bySlug = await storage.getAgentBySlug("shared-slug");
            expect(bySlug).not.toBeNull();
            expect(bySlug?.name).toBe("Active Agent");
        });

        it("should reassign bySlug to active agent when canonical owner becomes inactive", async () => {
            // Regression test for: canonical slug owner becomes inactive while another
            // active agent with the same slug exists
            //
            // Repro scenario:
            // 1. Save agent A (active) → bySlug=A
            // 2. Save agent B (active, same slug) → bySlug=B
            // 3. Remove B's last project (B becomes inactive) → bySlug should become A, not stay B

            const signerA = NDKPrivateKeySigner.generate();
            const signerB = NDKPrivateKeySigner.generate();

            // Step 1: Create active agent A with slug "conflict-slug"
            const agentA = createStoredAgent({
                nsec: signerA.nsec,
                slug: "conflict-slug",
                name: "Agent A",
                role: "assistant",
                projects: ["project-a"],
            });
            await storage.saveAgent(agentA);

            // Verify A owns bySlug
            let bySlug = await storage.getAgentBySlug("conflict-slug");
            expect(bySlug?.name).toBe("Agent A");

            // Step 2: Create active agent B with same slug (takes over bySlug)
            const agentB = createStoredAgent({
                nsec: signerB.nsec,
                slug: "conflict-slug",
                name: "Agent B",
                role: "assistant",
                projects: ["project-b"],
            });
            await storage.saveAgent(agentB);

            // Verify B now owns bySlug
            bySlug = await storage.getAgentBySlug("conflict-slug");
            expect(bySlug?.name).toBe("Agent B");

            // Step 3: Remove B from its project (becomes inactive)
            await storage.removeAgentFromProject(signerB.pubkey, "project-b");

            // bySlug should now point to A (the remaining active agent with this slug)
            bySlug = await storage.getAgentBySlug("conflict-slug");
            expect(bySlug).not.toBeNull();
            expect(bySlug?.name).toBe("Agent A");
            expect(bySlug?.status).toBe("active");
        });

        it("should handle isAgentActive with null/undefined/junk status values", () => {
            // Test that isAgentActive properly handles edge cases for status field

            // Explicit 'active' status
            expect(isAgentActive({ status: "active", projects: [] } as StoredAgent)).toBe(true);
            expect(isAgentActive({ status: "active", projects: ["p1"] } as StoredAgent)).toBe(true);

            // Explicit 'inactive' status
            expect(isAgentActive({ status: "inactive", projects: [] } as StoredAgent)).toBe(false);
            expect(isAgentActive({ status: "inactive", projects: ["p1"] } as StoredAgent)).toBe(false);

            // Undefined status - falls back to projects check
            expect(isAgentActive({ status: undefined, projects: [] } as StoredAgent)).toBe(false);
            expect(isAgentActive({ status: undefined, projects: ["p1"] } as StoredAgent)).toBe(true);

            // No status field - falls back to projects check
            expect(isAgentActive({ projects: [] } as StoredAgent)).toBe(false);
            expect(isAgentActive({ projects: ["p1"] } as StoredAgent)).toBe(true);

            // Junk/invalid status values - should fall back to projects check
            expect(isAgentActive({ status: null as unknown as string, projects: [] } as StoredAgent)).toBe(false);
            expect(isAgentActive({ status: null as unknown as string, projects: ["p1"] } as StoredAgent)).toBe(true);
            expect(isAgentActive({ status: "invalid" as unknown as "active" | "inactive", projects: [] } as StoredAgent)).toBe(false);
            expect(isAgentActive({ status: "invalid" as unknown as "active" | "inactive", projects: ["p1"] } as StoredAgent)).toBe(true);
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
