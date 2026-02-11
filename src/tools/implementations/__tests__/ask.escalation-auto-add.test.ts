import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStorage, createStoredAgent } from "@/agents/AgentStorage";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

/**
 * Tests for escalation agent auto-add functionality.
 *
 * The auto-add feature ensures that when config.escalation.agent is set to a slug that:
 * - IS in the current project: use it directly
 * - EXISTS in global storage but NOT in project: auto-add it to the project
 * - DOES NOT exist anywhere: return null (no escalation routing)
 *
 * This test file focuses on the AgentStorage operations that support the auto-add feature,
 * since the actual getEscalationTarget function requires full runtime context.
 */

describe("Escalation Agent Auto-Add - Storage Operations", () => {
    let tempDir: string;
    let storage: AgentStorage;

    beforeEach(async () => {
        // Create temp directory for test storage
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "escalation-auto-add-test-"));

        // Override config path for testing
        const configModule = await import("@/services/ConfigService");
        const originalGetConfigPath = configModule.config.getConfigPath;
        configModule.config.getConfigPath = () => tempDir;

        storage = new AgentStorage();
        await storage.initialize();

        // Restore original
        configModule.config.getConfigPath = originalGetConfigPath;
    });

    afterEach(async () => {
        // Clean up temp directory
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    describe("getAgentBySlug - for finding escalation agents in global storage", () => {
        it("should find an agent by slug when it exists in storage", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "escalation-agent",
                name: "Escalation Agent",
                role: "escalation",
                projects: [], // Not in any project yet
            });
            await storage.saveAgent(agent);

            const found = await storage.getAgentBySlug("escalation-agent");

            expect(found).not.toBeNull();
            expect(found?.slug).toBe("escalation-agent");
            expect(found?.name).toBe("Escalation Agent");
            expect(found?.projects).toEqual([]);
        });

        it("should return null when agent does not exist", async () => {
            const found = await storage.getAgentBySlug("nonexistent-agent");
            expect(found).toBeNull();
        });
    });

    describe("addAgentToProject - for auto-adding escalation agent", () => {
        it("should add an existing agent to a project", async () => {
            // Create agent not in any project
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "escalation-agent",
                name: "Escalation Agent",
                role: "escalation",
                projects: [], // Not in any project
            });
            await storage.saveAgent(agent);

            // Auto-add to project
            await storage.addAgentToProject(signer.pubkey, "test-project");

            // Verify agent is now in project
            const updated = await storage.loadAgent(signer.pubkey);
            expect(updated?.projects).toContain("test-project");
        });

        it("should be idempotent - adding to same project twice should not duplicate", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "escalation-agent",
                name: "Escalation Agent",
                role: "escalation",
                projects: [],
            });
            await storage.saveAgent(agent);

            // Add to project twice
            await storage.addAgentToProject(signer.pubkey, "test-project");
            await storage.addAgentToProject(signer.pubkey, "test-project");

            // Should only appear once
            const updated = await storage.loadAgent(signer.pubkey);
            expect(updated?.projects).toEqual(["test-project"]);
        });

        it("should throw when agent does not exist", async () => {
            await expect(
                storage.addAgentToProject("nonexistent-pubkey", "test-project")
            ).rejects.toThrow("Agent nonexistent-pubkey not found");
        });
    });

    describe("getProjectAgents - for checking if agent is already in project", () => {
        it("should return empty array when no agents in project", async () => {
            const agents = await storage.getProjectAgents("empty-project");
            expect(agents).toEqual([]);
        });

        it("should return agent after it's added to project", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "escalation-agent",
                name: "Escalation Agent",
                role: "escalation",
                projects: ["test-project"],
            });
            await storage.saveAgent(agent);

            const agents = await storage.getProjectAgents("test-project");
            expect(agents.length).toBe(1);
            expect(agents[0].slug).toBe("escalation-agent");
        });

        it("should return agent only for its assigned projects", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "escalation-agent",
                name: "Escalation Agent",
                role: "escalation",
                projects: ["project-a"],
            });
            await storage.saveAgent(agent);

            // Agent should be in project-a
            const agentsA = await storage.getProjectAgents("project-a");
            expect(agentsA.length).toBe(1);

            // Agent should NOT be in project-b
            const agentsB = await storage.getProjectAgents("project-b");
            expect(agentsB.length).toBe(0);
        });
    });

    describe("Complete auto-add workflow", () => {
        it("should support the complete escalation agent auto-add flow", async () => {
            // Step 1: Create an escalation agent in storage (not in any project)
            const signer = NDKPrivateKeySigner.generate();
            const escalationAgent = createStoredAgent({
                nsec: signer.nsec,
                slug: "architect-orchestrator",
                name: "Architect Orchestrator",
                role: "Strategic PM",
                description: "Handles question escalation",
                projects: [], // Not in any project initially
            });
            await storage.saveAgent(escalationAgent);

            // Step 2: Simulate checking if agent is in project (it's not)
            const projectAgents = await storage.getProjectAgents("tenex-backend");
            const agentInProject = projectAgents.find(a => a.slug === "architect-orchestrator");
            expect(agentInProject).toBeUndefined();

            // Step 3: Agent exists in storage but not in project - find by slug
            const foundAgent = await storage.getAgentBySlug("architect-orchestrator");
            expect(foundAgent).not.toBeNull();
            expect(foundAgent?.slug).toBe("architect-orchestrator");

            // Step 4: Auto-add to project
            await storage.addAgentToProject(signer.pubkey, "tenex-backend");

            // Step 5: Reload and verify
            const reloadedAgent = await storage.loadAgent(signer.pubkey);
            expect(reloadedAgent?.projects).toContain("tenex-backend");

            // Step 6: Verify agent now shows up in project agents
            const updatedProjectAgents = await storage.getProjectAgents("tenex-backend");
            const addedAgent = updatedProjectAgents.find(a => a.slug === "architect-orchestrator");
            expect(addedAgent).not.toBeUndefined();
            expect(addedAgent?.slug).toBe("architect-orchestrator");
        });

        it("should handle agent already in multiple projects", async () => {
            // Create agent in project-a
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "shared-escalation-agent",
                name: "Shared Escalation Agent",
                role: "escalation",
                projects: ["project-a"],
            });
            await storage.saveAgent(agent);

            // Auto-add to project-b
            await storage.addAgentToProject(signer.pubkey, "project-b");

            // Agent should now be in both projects
            const updated = await storage.loadAgent(signer.pubkey);
            expect(updated?.projects).toContain("project-a");
            expect(updated?.projects).toContain("project-b");

            // Both projects should list the agent
            const agentsA = await storage.getProjectAgents("project-a");
            const agentsB = await storage.getProjectAgents("project-b");
            expect(agentsA.find(a => a.slug === "shared-escalation-agent")).not.toBeUndefined();
            expect(agentsB.find(a => a.slug === "shared-escalation-agent")).not.toBeUndefined();
        });
    });
});
