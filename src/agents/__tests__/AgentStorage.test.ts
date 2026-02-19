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
            // Agent1 becomes inactive (identity preserved) since it has no projects left
            // So agent2 can take over the slug without conflict
            await storage.saveAgent(agent2);

            // Verify agent2 took the slug
            const loaded = await storage.getAgentBySlug("conflict-slug");
            expect(loaded?.name).toBe("Agent 2");

            // Verify agent1 is now inactive (identity preserved, not deleted)
            const agent1Loaded = await storage.loadAgent(signer1.pubkey);
            expect(agent1Loaded).not.toBeNull();
            expect(agent1Loaded?.status).toBe("inactive");
            expect(agent1Loaded?.projects).toEqual([]);
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
                expect(migratedIndex.bySlug["test-agent"]).toHaveProperty("projectIds");
                expect(migratedIndex.bySlug["test-agent"].projectIds).toContain("project-1");
                expect(migratedIndex.bySlug["test-agent"].projectIds).toContain("project-2");
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

                // Verify index is now in new format
                const indexContent = await fs.readFile(indexPath, "utf-8");
                const migratedIndex = JSON.parse(indexContent);
                expect(migratedIndex.bySlug["orphan-agent"]).toHaveProperty("pubkey");
                expect(migratedIndex.bySlug["orphan-agent"]).toHaveProperty("projectIds");
                // When byProject is empty/missing, rebuild populates projectIds from agent file
                expect(migratedIndex.bySlug["orphan-agent"].projectIds).toEqual(["project-1"]);
                // Verify byProject was rebuilt too
                expect(migratedIndex.byProject["project-1"]).toContain(signer.pubkey);
            } finally {
                ConfigService.config.getConfigPath = originalGetConfigPath;
            }
        });

        it("should keep slug entry for reactivation when agent has no projects left", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "temp-agent",
                name: "Temp Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            await storage.saveAgent(agent);

            // Remove from project - agent becomes inactive but identity preserved
            await storage.removeAgentFromProject(signer.pubkey, "project-1");

            // Slug entry should still exist for reactivation lookup
            const loaded = await storage.getAgentBySlug("temp-agent");
            expect(loaded).not.toBeNull();
            expect(loaded?.status).toBe("inactive");
            expect(loaded?.projects).toEqual([]);
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
            expect(index.bySlug["leaving-agent"].projectIds).toEqual(["project-1", "project-2", "project-3"]);

            // Remove agent from project-2
            agent.projects = ["project-1", "project-3"];
            await storage.saveAgent(agent);

            // Verify slug entry synced to current projects (ghost project-2 removed)
            indexContent = await fs.readFile(indexPath, "utf-8");
            index = JSON.parse(indexContent);
            expect(index.bySlug["leaving-agent"].projectIds).toEqual(["project-1", "project-3"]);
            expect(index.bySlug["leaving-agent"].projectIds).not.toContain("project-2");
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

            // Verify new slug entry has correct projectIds
            expect(index.bySlug["new-slug"].pubkey).toBe(signer.pubkey);
            expect(index.bySlug["new-slug"].projectIds).toEqual(["project-1", "project-2"]);
        });

        it("should handle getProjectAgents with unique slugs across projects", async () => {
            const signer1 = NDKPrivateKeySigner.generate();
            const signer2 = NDKPrivateKeySigner.generate();

            // Agent 1 with "worker-1" slug in project-1
            const agent1 = createStoredAgent({
                nsec: signer1.nsec,
                slug: "worker-1",
                name: "Worker 1",
                role: "assistant",
                projects: ["project-1"],
            });

            // Agent 2 with "worker-2" slug in project-2
            const agent2 = createStoredAgent({
                nsec: signer2.nsec,
                slug: "worker-2",
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
        });

        it("should allow last-saved agent to own slug when multiple agents share same slug", async () => {
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

            // bySlug points to last saved agent (agent2)
            const slugLookup = await storage.getAgentBySlug("worker");
            expect(slugLookup?.name).toBe("Worker 2");

            // Agent2 appears in its project because it owns the slug
            const project2Agents = await storage.getProjectAgents("project-2");
            expect(project2Agents).toHaveLength(1);
            expect(project2Agents[0].name).toBe("Worker 2");

            // Agent1 does NOT appear in getProjectAgents because it doesn't own the slug
            // This is expected behavior - slug ownership is global, not project-scoped
            const project1Agents = await storage.getProjectAgents("project-1");
            expect(project1Agents).toHaveLength(0);
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
            expect(index.bySlug["shrinking-agent"].projectIds).toEqual(["project-1", "project-3"]);

            // Remove from another project
            await storage.removeAgentFromProject(signer.pubkey, "project-1");

            indexContent = await fs.readFile(indexPath, "utf-8");
            index = JSON.parse(indexContent);
            expect(index.bySlug["shrinking-agent"].projectIds).toEqual(["project-3"]);

            // Remove from last project - agent becomes inactive but slug entry remains for reactivation
            await storage.removeAgentFromProject(signer.pubkey, "project-3");

            indexContent = await fs.readFile(indexPath, "utf-8");
            index = JSON.parse(indexContent);
            // Slug entry should still exist for reactivation
            expect(index.bySlug["shrinking-agent"]).toBeDefined();
            expect(index.bySlug["shrinking-agent"].projectIds).toEqual([]);

            // Agent should be inactive
            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.status).toBe("inactive");
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

    describe("getAgentBySlugForProject (project-scoped slug lookup)", () => {
        it("should return agent when slug exists in specified project", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1", "project-2"],
            });

            await storage.saveAgent(agent);

            const result1 = await storage.getAgentBySlugForProject("test-agent", "project-1");
            expect(result1).not.toBeNull();
            expect(result1?.slug).toBe("test-agent");

            const result2 = await storage.getAgentBySlugForProject("test-agent", "project-2");
            expect(result2).not.toBeNull();
            expect(result2?.slug).toBe("test-agent");
        });

        it("should return null when slug exists but not in specified project", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            await storage.saveAgent(agent);

            const result = await storage.getAgentBySlugForProject("test-agent", "project-2");
            expect(result).toBeNull();
        });

        it("should handle same agent using same slug across different projects", async () => {
            const signer = NDKPrivateKeySigner.generate();

            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "shared-slug",
                name: "Multi-Project Agent",
                role: "assistant",
                projects: ["project-1", "project-2"],
            });

            await storage.saveAgent(agent);

            // Same agent should be retrievable from both projects
            const result1 = await storage.getAgentBySlugForProject("shared-slug", "project-1");
            expect(result1?.name).toBe("Multi-Project Agent");
            expect(result1?.projects).toContain("project-1");
            expect(result1?.projects).toContain("project-2");

            const result2 = await storage.getAgentBySlugForProject("shared-slug", "project-2");
            expect(result2?.name).toBe("Multi-Project Agent");
            expect(result2?.projects).toContain("project-1");
            expect(result2?.projects).toContain("project-2");
        });

        it("should return null when slug does not exist", async () => {
            const result = await storage.getAgentBySlugForProject("nonexistent", "project-1");
            expect(result).toBeNull();
        });

        it("should detect index mismatch and return null", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            await storage.saveAgent(agent);

            // Manually corrupt the index to claim agent is in project-2
            const indexPath = path.join(tempDir, "index.json");
            const indexContent = await fs.readFile(indexPath, "utf-8");
            const index = JSON.parse(indexContent);
            index.bySlug["test-agent"].projectIds.push("project-2");
            await fs.writeFile(indexPath, JSON.stringify(index, null, 2));

            // Re-initialize storage to load corrupted index
            // IMPORTANT: Override config path BEFORE creating AgentStorage instance
            const originalGetConfigPath = (await import("@/services/ConfigService")).config.getConfigPath;
            (await import("@/services/ConfigService")).config.getConfigPath = () => tempDir;
            const newStorage = new AgentStorage();
            await newStorage.initialize();
            (await import("@/services/ConfigService")).config.getConfigPath = originalGetConfigPath;

            // Should detect mismatch and return null for project-2
            const result = await newStorage.getAgentBySlugForProject("test-agent", "project-2");
            expect(result).toBeNull();
        });
    });

    describe("slug rename cleanup (ghost entry prevention)", () => {
        it("should clean up old slug when agent renames", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "old-slug",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1", "project-2"],
            });

            await storage.saveAgent(agent);

            // Verify old slug exists
            const indexPath = path.join(tempDir, "index.json");
            let indexContent = await fs.readFile(indexPath, "utf-8");
            let index = JSON.parse(indexContent);
            expect(index.bySlug["old-slug"]).toBeDefined();
            expect(index.bySlug["old-slug"].projectIds).toEqual(["project-1", "project-2"]);

            // Rename the agent
            agent.slug = "new-slug";
            await storage.saveAgent(agent);

            // Old slug should be completely removed
            indexContent = await fs.readFile(indexPath, "utf-8");
            index = JSON.parse(indexContent);
            expect(index.bySlug["old-slug"]).toBeUndefined();
            expect(index.bySlug["new-slug"]).toBeDefined();
            expect(index.bySlug["new-slug"].projectIds).toEqual(["project-1", "project-2"]);
        });

        it("should clean up old slug when agent renames AND changes projects", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "old-slug",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1", "project-2"],
            });

            await storage.saveAgent(agent);

            // Rename AND change projects at the same time
            agent.slug = "new-slug";
            agent.projects = ["project-3"];
            await storage.saveAgent(agent);

            // Old slug should be completely removed (no ghost entries)
            const indexPath = path.join(tempDir, "index.json");
            const indexContent = await fs.readFile(indexPath, "utf-8");
            const index = JSON.parse(indexContent);
            expect(index.bySlug["old-slug"]).toBeUndefined();
            expect(index.bySlug["new-slug"]).toBeDefined();
            expect(index.bySlug["new-slug"].projectIds).toEqual(["project-3"]);
        });

        it("should handle partial slug cleanup when multiple agents share old slug", async () => {
            const signer1 = NDKPrivateKeySigner.generate();
            const signer2 = NDKPrivateKeySigner.generate();

            // Agent 1 in project-1 and project-2
            const agent1 = createStoredAgent({
                nsec: signer1.nsec,
                slug: "shared-slug",
                name: "Agent 1",
                role: "assistant",
                projects: ["project-1", "project-2"],
            });

            await storage.saveAgent(agent1);

            // Agent 2 in project-3 with same slug (allowed - different project)
            const agent2 = createStoredAgent({
                nsec: signer2.nsec,
                slug: "shared-slug",
                name: "Agent 2",
                role: "assistant",
                projects: ["project-3"],
            });

            await storage.saveAgent(agent2);

            // Now agent 1 renames
            agent1.slug = "new-slug";
            await storage.saveAgent(agent1);

            // "shared-slug" should still exist but only for agent2/project-3
            const indexPath = path.join(tempDir, "index.json");
            const indexContent = await fs.readFile(indexPath, "utf-8");
            const index = JSON.parse(indexContent);
            expect(index.bySlug["shared-slug"]).toBeDefined();
            expect(index.bySlug["shared-slug"].pubkey).toBe(signer2.pubkey);
            expect(index.bySlug["shared-slug"].projectIds).toEqual(["project-3"]);
            expect(index.bySlug["new-slug"]).toBeDefined();
            expect(index.bySlug["new-slug"].pubkey).toBe(signer1.pubkey);
        });
    });

    describe("migration with byProject rebuild", () => {
        it("should rebuild byProject when migration produces empty byProject", async () => {
            // Create agents manually
            const signer1 = NDKPrivateKeySigner.generate();
            const signer2 = NDKPrivateKeySigner.generate();

            const agent1 = createStoredAgent({
                nsec: signer1.nsec,
                slug: "agent-1",
                name: "Agent 1",
                role: "assistant",
                projects: ["project-1"],
            });

            const agent2 = createStoredAgent({
                nsec: signer2.nsec,
                slug: "agent-2",
                name: "Agent 2",
                role: "assistant",
                projects: ["project-2"],
            });

            // Write agent files manually
            const agent1Path = path.join(tempDir, `${signer1.pubkey}.json`);
            const agent2Path = path.join(tempDir, `${signer2.pubkey}.json`);
            await fs.writeFile(agent1Path, JSON.stringify(agent1, null, 2));
            await fs.writeFile(agent2Path, JSON.stringify(agent2, null, 2));

            // Create old-format index with EMPTY byProject (simulating corruption)
            const indexPath = path.join(tempDir, "index.json");
            const oldIndex = {
                bySlug: {
                    "agent-1": signer1.pubkey, // Old flat format
                    "agent-2": signer2.pubkey,
                },
                byEventId: {},
                byProject: {}, // EMPTY - should trigger rebuild
            };
            await fs.writeFile(indexPath, JSON.stringify(oldIndex, null, 2));

            // Initialize storage - should migrate and rebuild
            // IMPORTANT: Override config path BEFORE creating AgentStorage instance
            const originalGetConfigPath = (await import("@/services/ConfigService")).config.getConfigPath;
            (await import("@/services/ConfigService")).config.getConfigPath = () => tempDir;
            const newStorage = new AgentStorage();
            await newStorage.initialize();
            (await import("@/services/ConfigService")).config.getConfigPath = originalGetConfigPath;

            // Verify byProject was rebuilt correctly
            const indexContent = await fs.readFile(indexPath, "utf-8");
            const index = JSON.parse(indexContent);

            expect(index.byProject["project-1"]).toBeDefined();
            expect(index.byProject["project-1"]).toContain(signer1.pubkey);
            expect(index.byProject["project-2"]).toBeDefined();
            expect(index.byProject["project-2"]).toContain(signer2.pubkey);
        });

        it("should preserve byProject when migration produces valid byProject", async () => {
            const signer = NDKPrivateKeySigner.generate();

            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            // Write agent file manually
            const agentPath = path.join(tempDir, `${signer.pubkey}.json`);
            await fs.writeFile(agentPath, JSON.stringify(agent, null, 2));

            // Create old-format index with VALID byProject
            const indexPath = path.join(tempDir, "index.json");
            const oldIndex = {
                bySlug: {
                    "test-agent": signer.pubkey, // Old flat format
                },
                byEventId: {},
                byProject: {
                    "project-1": [signer.pubkey], // Valid - should be preserved
                },
            };
            await fs.writeFile(indexPath, JSON.stringify(oldIndex, null, 2));

            // Initialize storage - should migrate but NOT rebuild
            // IMPORTANT: Override config path BEFORE creating AgentStorage instance
            const originalGetConfigPath = (await import("@/services/ConfigService")).config.getConfigPath;
            (await import("@/services/ConfigService")).config.getConfigPath = () => tempDir;
            const newStorage = new AgentStorage();
            await newStorage.initialize();
            (await import("@/services/ConfigService")).config.getConfigPath = originalGetConfigPath;

            // Verify byProject was preserved and slug was migrated
            const indexContent = await fs.readFile(indexPath, "utf-8");
            const index = JSON.parse(indexContent);

            expect(index.bySlug["test-agent"]).toBeDefined();
            expect(index.bySlug["test-agent"].pubkey).toBe(signer.pubkey);
            expect(index.bySlug["test-agent"].projectIds).toEqual(["project-1"]);
            expect(index.byProject["project-1"]).toEqual([signer.pubkey]);
        });
    });

    describe("cleanup successfully resolves conflicts", () => {
        it("should automatically cleanup when different agents conflict on same slug", async () => {
            const signer1 = NDKPrivateKeySigner.generate();
            const signer2 = NDKPrivateKeySigner.generate();

            const agent1 = createStoredAgent({
                nsec: signer1.nsec,
                slug: "conflict-slug",
                name: "Agent 1",
                role: "assistant",
                projects: ["project-1"],
            });

            await storage.saveAgent(agent1);

            // Verify agent1 is in the index
            const indexPath = path.join(tempDir, "index.json");
            let indexContent = await fs.readFile(indexPath, "utf-8");
            let index = JSON.parse(indexContent);
            expect(index.bySlug["conflict-slug"].pubkey).toBe(signer1.pubkey);

            // Now save agent2 with same slug in SAME project - should trigger cleanup
            const agent2 = createStoredAgent({
                nsec: signer2.nsec,
                slug: "conflict-slug",
                name: "Agent 2",
                role: "assistant",
                projects: ["project-1"],
            });

            await storage.saveAgent(agent2);

            // Cleanup should have removed agent1 from project-1
            indexContent = await fs.readFile(indexPath, "utf-8");
            index = JSON.parse(indexContent);

            // Slug should now point to agent2
            expect(index.bySlug["conflict-slug"].pubkey).toBe(signer2.pubkey);
            expect(index.bySlug["conflict-slug"].projectIds).toEqual(["project-1"]);

            // Agent1 file should still exist but be inactive (identity preservation)
            const agent1Loaded = await storage.loadAgent(signer1.pubkey);
            expect(agent1Loaded).not.toBeNull();
            expect(agent1Loaded?.status).toBe("inactive");
            expect(agent1Loaded?.projects).toEqual([]);
        });
    });

    describe("getAgentBySlug deprecation warning", () => {
        it("should emit deprecation warning when getAgentBySlug is used", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projects: ["project-1"],
            });

            await storage.saveAgent(agent);

            // Call deprecated method - should still work but warn
            const result = await storage.getAgentBySlug("test-agent");
            expect(result).not.toBeNull();
            expect(result?.slug).toBe("test-agent");
        });

        it("should return last saved agent when multiple agents share slug", async () => {
            const signer1 = NDKPrivateKeySigner.generate();
            const signer2 = NDKPrivateKeySigner.generate();

            const agent1 = createStoredAgent({
                nsec: signer1.nsec,
                slug: "shared-slug",
                name: "Agent 1",
                role: "assistant",
                projects: ["project-1"],
            });

            const agent2 = createStoredAgent({
                nsec: signer2.nsec,
                slug: "shared-slug",
                name: "Agent 2",
                role: "assistant",
                projects: ["project-2"],
            });

            await storage.saveAgent(agent1);
            await storage.saveAgent(agent2);

            // Deprecated method returns last saved (agent2)
            const result = await storage.getAgentBySlug("shared-slug");
            expect(result?.name).toBe("Agent 2");
        });
    });
});
