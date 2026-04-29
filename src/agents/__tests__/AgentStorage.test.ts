import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStorage, createStoredAgent, isAgentActive, type StoredAgent } from "../AgentStorage";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

/**
 * Read the on-disk index.json for the test storage directory.
 *
 * Tests historically relied on `agentStorage.getAgentProjects` /
 * `agentStorage.getProjectAgents` for project membership lookups. Those methods
 * were removed when project membership migrated to the persisted kind:31933
 * event (`<TENEX_BASE_DIR>/projects/<dTag>/event.json`). Tests that exercise
 * the slug index's projectIds (still maintained by addAgentToProject /
 * removeAgentFromProject) read the raw index instead.
 */
async function readIndexFromDir(tempDir: string): Promise<{
    bySlug: Record<string, { pubkey: string; projectIds?: string[] }>;
    byEventId: Record<string, string>;
}> {
    const indexPath = path.join(tempDir, "index.json");
    const content = await fs.readFile(indexPath, "utf-8");
    return JSON.parse(content);
}

/**
 * Return the project ids the given pubkey owns via the slug index.
 * The slug index is the only in-storage record of project association after the
 * byProject removal; the canonical source is the on-disk kind:31933 event.
 */
async function projectsOwnedBy(tempDir: string, pubkey: string): Promise<string[]> {
    const index = await readIndexFromDir(tempDir);
    const owned = new Set<string>();
    for (const slugEntry of Object.values(index.bySlug)) {
        if (slugEntry.pubkey !== pubkey) continue;
        for (const projectId of slugEntry.projectIds ?? []) {
            owned.add(projectId);
        }
    }
    return [...owned];
}

/**
 * Return the canonical agents (one per slug) recorded in the slug index for the
 * given dTag. Mirrors the behaviour the old `getProjectAgents` exposed against
 * the byProject mapping, but sourced from `bySlug.projectIds` which is what the
 * mutation methods (addAgentToProject / removeAgentFromProject) write.
 */
async function projectAgentsFromIndex(
    tempDir: string,
    storage: AgentStorage,
    dTag: string,
): Promise<StoredAgent[]> {
    const index = await readIndexFromDir(tempDir);
    const agents: StoredAgent[] = [];
    for (const slugEntry of Object.values(index.bySlug)) {
        if (!(slugEntry.projectIds ?? []).includes(dTag)) continue;
        const agent = await storage.loadAgent(slugEntry.pubkey);
        if (!agent) continue;
        if (!isAgentActive(agent)) continue;
        agents.push(agent);
    }
    return agents;
}

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
                defaultConfig: {
                    model: "anthropic:claude-sonnet-4",
                },
                eventId: "test-event-id",
            });

            expect(agent.nsec).toBe(signer.nsec);
            expect(agent.slug).toBe("test-agent");
            expect(agent.name).toBe("Test Agent");
            expect(agent.role).toBe("assistant");
            expect(agent.description).toBe("A test agent");
            expect(agent.instructions).toBe("Test instructions");
            expect(agent.useCriteria).toBe("Test criteria");
            expect(agent.default?.model).toBe("anthropic:claude-sonnet-4");
            expect(agent.eventId).toBe("test-event-id");
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
            });

            expect(agent.description).toBeUndefined();
            expect(agent.instructions).toBeUndefined();
            expect(agent.useCriteria).toBeUndefined();
        });

        it("should set status to 'active' by default", () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
            });

            expect(agent.status).toBe("active");
        });

        it("stores Telegram transport on the agent itself", () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                telegram: {
                    botToken: "agent-token",
                    allowDMs: true,
                },
            });

            expect(agent.telegram).toEqual({
                botToken: "agent-token",
                allowDMs: true,
            });
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
            });
            agent.status = "inactive";

            expect(isAgentActive(agent)).toBe(false);
        });

        it("should return true for agents without status field (treat as active)", () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent: StoredAgent = {
                nsec: signer.nsec,
                slug: "legacy-agent",
                name: "Legacy Agent",
                role: "assistant",
            };
            // Explicitly remove status to simulate legacy data
            (agent as Record<string, unknown>).status = undefined;

            expect(isAgentActive(agent)).toBe(true);
        });

        it("should handle isAgentActive with null/undefined/junk status values", () => {
            // Test that isAgentActive properly handles edge cases for status field

            // Explicit 'active' status
            expect(isAgentActive({ status: "active" } as StoredAgent)).toBe(true);

            // Explicit 'inactive' status
            expect(isAgentActive({ status: "inactive" } as StoredAgent)).toBe(false);

            // Undefined status - treated as active
            expect(isAgentActive({ status: undefined } as StoredAgent)).toBe(true);

            // No status field - treated as active
            expect(isAgentActive({} as StoredAgent)).toBe(true);
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

    describe("updateDefaultConfig", () => {
        it("should update default model in storage", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                defaultConfig: { model: "anthropic:claude-sonnet-4" },
            });

            await storage.saveAgent(agent);

            const success = await storage.updateDefaultConfig(signer.pubkey, {
                model: "anthropic:claude-opus-4",
            });
            expect(success).toBe(true);

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.default?.model).toBe("anthropic:claude-opus-4");
        });

        it("should update default mcp in storage", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                defaultConfig: { mcp: ["github", "slack"] },
            });

            await storage.saveAgent(agent);

            const success = await storage.updateDefaultConfig(signer.pubkey, {
                mcp: ["github", "notion"],
            });
            expect(success).toBe(true);

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.default?.mcp).toEqual(["github", "notion"]);
        });

        it("should update top-level Telegram config in storage", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "telegram-agent",
                name: "Telegram Agent",
                role: "assistant",
                telegram: {
                    botToken: "legacy-token",
                    allowDMs: true,
                },
            });

            await storage.saveAgent(agent);

            const success = await storage.updateAgentTelegramConfig(signer.pubkey, {
                botToken: "updated-token",
                allowDMs: false,
            });
            expect(success).toBe(true);

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.telegram).toEqual({
                botToken: "updated-token",
                allowDMs: false,
            });
        });

        it("should clear top-level Telegram config when updated with undefined", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "telegram-agent",
                name: "Telegram Agent",
                role: "assistant",
                telegram: {
                    botToken: "token",
                    allowDMs: true,
                },
            });

            await storage.saveAgent(agent);

            const success = await storage.updateAgentTelegramConfig(signer.pubkey, undefined);
            expect(success).toBe(true);

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.telegram).toBeUndefined();
        });

        it("should return false for non-existent agent", async () => {
            const success = await storage.updateDefaultConfig("nonexistent-pubkey", {
                model: "anthropic:claude-opus-4",
            });
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
            });

            await storage.saveAgent(agent);

            await storage.addAgentToProject(signer.pubkey, "project-1");

            const projects = await projectsOwnedBy(tempDir, signer.pubkey);
            expect(projects).toContain("project-1");
        });

        it("should not add duplicate project", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
            });

            await storage.saveAgent(agent);
            await storage.addAgentToProject(signer.pubkey, "project-1");

            await storage.addAgentToProject(signer.pubkey, "project-1");

            const projects = await projectsOwnedBy(tempDir, signer.pubkey);
            expect(projects.filter((p) => p === "project-1").length).toBe(1);
        });

        it("should remove agent from project", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
            });

            await storage.saveAgent(agent);
            await storage.addAgentToProject(signer.pubkey, "project-1");
            await storage.addAgentToProject(signer.pubkey, "project-2");

            await storage.removeAgentFromProject(signer.pubkey, "project-1");

            const projects = await projectsOwnedBy(tempDir, signer.pubkey);
            expect(projects).not.toContain("project-1");
            expect(projects).toContain("project-2");
        });

        it("should set agent to inactive when removed from all projects (identity preservation)", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
            });

            await storage.saveAgent(agent);
            await storage.addAgentToProject(signer.pubkey, "project-1");

            await storage.removeAgentFromProject(signer.pubkey, "project-1");

            // Agent should still exist but be inactive
            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded).not.toBeNull();
            expect(loaded?.status).toBe("inactive");
            // Identity should be preserved
            expect(loaded?.nsec).toBe(signer.nsec);
            expect(loaded?.slug).toBe("test-agent");

            // No projects remain
            const projects = await projectsOwnedBy(tempDir, signer.pubkey);
            expect(projects).toEqual([]);
        });

        it("should reactivate inactive agent when added to project", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
            });

            await storage.saveAgent(agent);
            await storage.addAgentToProject(signer.pubkey, "project-1");

            // Remove from all projects - becomes inactive
            await storage.removeAgentFromProject(signer.pubkey, "project-1");
            let loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.status).toBe("inactive");

            // Add to new project - should reactivate
            await storage.addAgentToProject(signer.pubkey, "project-2");
            loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded?.status).toBe("active");
            const projects = await projectsOwnedBy(tempDir, signer.pubkey);
            expect(projects).toContain("project-2");
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
            });

            const inactiveAgent = createStoredAgent({
                nsec: signer2.nsec,
                slug: "inactive-agent",
                name: "Inactive Agent",
                role: "assistant",
            });

            await storage.saveAgent(activeAgent);
            await storage.addAgentToProject(signer1.pubkey, "project-1");

            await storage.saveAgent(inactiveAgent);
            await storage.addAgentToProject(signer2.pubkey, "project-1");

            // Both agents should be in project initially
            let projectAgents = await projectAgentsFromIndex(tempDir, storage, "project-1");
            expect(projectAgents.length).toBe(2);

            // Remove inactive agent from project (becomes inactive)
            await storage.removeAgentFromProject(signer2.pubkey, "project-1");

            // Only active agent should be returned
            projectAgents = await projectAgentsFromIndex(tempDir, storage, "project-1");
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
            });

            await storage.saveAgent(agent);
            await storage.addAgentToProject(signer.pubkey, "project-1");

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

            const signer1 = NDKPrivateKeySigner.generate();

            // Create an active agent with "my-agent" slug
            const agent1 = createStoredAgent({
                nsec: signer1.nsec,
                slug: "my-agent",
                name: "Agent 1",
                role: "assistant",
            });
            await storage.saveAgent(agent1);
            await storage.addAgentToProject(signer1.pubkey, "project-1");

            // Verify agent is visible
            let projectAgents = await projectAgentsFromIndex(tempDir, storage, "project-1");
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
            projectAgents = await projectAgentsFromIndex(tempDir, storage, "project-2");
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
            });
            await storage.saveAgent(activeAgent);
            await storage.addAgentToProject(activeSigner.pubkey, "project-1");

            // Create inactive agent with same slug
            const inactiveAgent = createStoredAgent({
                nsec: inactiveSigner.nsec,
                slug: "shared-slug",
                name: "Inactive Agent",
                role: "assistant",
            });
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

            const signerA = NDKPrivateKeySigner.generate();
            const signerB = NDKPrivateKeySigner.generate();

            // Step 1: Create active agent A with slug "conflict-slug"
            const agentA = createStoredAgent({
                nsec: signerA.nsec,
                slug: "conflict-slug",
                name: "Agent A",
                role: "assistant",
            });
            await storage.saveAgent(agentA);
            await storage.addAgentToProject(signerA.pubkey, "project-a");

            // Step 2: Save agent B (active, same slug, different project)
            const agentB = createStoredAgent({
                nsec: signerB.nsec,
                slug: "conflict-slug",
                name: "Agent B",
                role: "assistant",
            });
            await storage.saveAgent(agentB);
            await storage.addAgentToProject(signerB.pubkey, "project-b");

            // Step 3: Remove B from its last project (B becomes inactive) → bySlug should become A
            await storage.removeAgentFromProject(signerB.pubkey, "project-b");

            // bySlug should now point to Agent A (the remaining active one)
            const bySlug = await storage.getAgentBySlug("conflict-slug");
            expect(bySlug).not.toBeNull();
            expect(bySlug?.name).toBe("Agent A");
            expect(bySlug?.status).toBe("active");
        });
    });

    describe("migrateAgentData", () => {
        it("strips projectOverrides from loaded agent data", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const filePath = path.join(tempDir, `${signer.pubkey}.json`);

            // Write agent with legacy projectOverrides field
            await fs.writeFile(filePath, JSON.stringify({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                projectOverrides: {
                    "project-1": { model: "anthropic:claude-opus-4" },
                },
            }, null, 2));

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded).not.toBeNull();
            expect((loaded as any).projectOverrides).toBeUndefined();

            // Verify the file was rewritten without projectOverrides
            const content = await fs.readFile(filePath, "utf-8");
            const stored = JSON.parse(content);
            expect(stored.projectOverrides).toBeUndefined();
        });

        it("strips pmOverrides from loaded agent data", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const filePath = path.join(tempDir, `${signer.pubkey}.json`);

            await fs.writeFile(filePath, JSON.stringify({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                pmOverrides: { "project-1": true },
            }, null, 2));

            const loaded = await storage.loadAgent(signer.pubkey);
            expect(loaded).not.toBeNull();
            expect((loaded as any).pmOverrides).toBeUndefined();

            const content = await fs.readFile(filePath, "utf-8");
            const stored = JSON.parse(content);
            expect(stored.pmOverrides).toBeUndefined();
        });

        it("does not rewrite file when no legacy fields present", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const filePath = path.join(tempDir, `${signer.pubkey}.json`);

            const originalData = {
                nsec: signer.nsec,
                slug: "clean-agent",
                name: "Clean Agent",
                role: "assistant",
                default: { model: "anthropic:claude-sonnet-4" },
            };
            await fs.writeFile(filePath, JSON.stringify(originalData, null, 2));

            const statBefore = await fs.stat(filePath);
            // Small delay to detect mtime changes
            await new Promise((r) => setTimeout(r, 10));

            await storage.loadAgent(signer.pubkey);

            const statAfter = await fs.stat(filePath);
            // File should NOT have been rewritten (mtime unchanged)
            expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
        });
    });

    describe("global agent listings", () => {
        it("should return every stored agent record in getAllStoredAgents", async () => {
            const signer1 = NDKPrivateKeySigner.generate();
            const signer2 = NDKPrivateKeySigner.generate();
            const signer3 = NDKPrivateKeySigner.generate();

            const canonicalAgent = createStoredAgent({
                nsec: signer1.nsec,
                slug: "shared-slug",
                name: "Canonical Agent",
                role: "assistant",
            });
            const duplicateAgent = createStoredAgent({
                nsec: signer2.nsec,
                slug: "shared-slug",
                name: "Duplicate Agent",
                role: "assistant",
            });
            const inactiveAgent = createStoredAgent({
                nsec: signer3.nsec,
                slug: "inactive-slug",
                name: "Inactive Agent",
                role: "assistant",
            });

            await storage.saveAgent(canonicalAgent);
            await storage.addAgentToProject(signer1.pubkey, "project-1");

            await storage.saveAgent(duplicateAgent);
            await storage.addAgentToProject(signer2.pubkey, "project-2");

            await storage.saveAgent(inactiveAgent);
            await storage.addAgentToProject(signer3.pubkey, "project-3");
            await storage.removeAgentFromProject(signer3.pubkey, "project-3");

            const storedAgents = await storage.getAllStoredAgents();
            expect(storedAgents).toHaveLength(3);
            expect(storedAgents.map((agent) => agent.name).sort()).toEqual([
                "Canonical Agent",
                "Duplicate Agent",
                "Inactive Agent",
            ]);
        });

        it("should return only canonical active agents in getCanonicalActiveAgents", async () => {
            const signer1 = NDKPrivateKeySigner.generate();
            const signer2 = NDKPrivateKeySigner.generate();
            const signer3 = NDKPrivateKeySigner.generate();

            const firstAgent = createStoredAgent({
                nsec: signer1.nsec,
                slug: "shared-slug",
                name: "First Agent",
                role: "assistant",
            });
            const canonicalAgent = createStoredAgent({
                nsec: signer2.nsec,
                slug: "shared-slug",
                name: "Canonical Agent",
                role: "assistant",
            });
            const inactiveAgent = createStoredAgent({
                nsec: signer3.nsec,
                slug: "inactive-slug",
                name: "Inactive Agent",
                role: "assistant",
            });

            await storage.saveAgent(firstAgent);
            await storage.addAgentToProject(signer1.pubkey, "project-1");

            await storage.saveAgent(canonicalAgent);
            await storage.addAgentToProject(signer2.pubkey, "project-2");

            await storage.saveAgent(inactiveAgent);
            await storage.addAgentToProject(signer3.pubkey, "project-3");
            await storage.removeAgentFromProject(signer3.pubkey, "project-3");

            const activeAgents = await storage.getCanonicalActiveAgents();
            expect(activeAgents).toHaveLength(1);
            expect(activeAgents[0]?.name).toBe("Canonical Agent");
            expect(activeAgents[0]?.slug).toBe("shared-slug");
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
            });

            await storage.saveAgent(agent);
            await storage.addAgentToProject(signer.pubkey, "project-1");
            await storage.addAgentToProject(signer.pubkey, "project-2");

            // Verify both projects are tracked in the index
            const projects = await projectsOwnedBy(tempDir, signer.pubkey);
            expect(projects).toContain("project-1");
            expect(projects).toContain("project-2");

            // And slug entry reflects both projects
            const indexPath = path.join(tempDir, "index.json");
            const indexContent = await fs.readFile(indexPath, "utf-8");
            const index = JSON.parse(indexContent);
            expect(index.bySlug["shared-agent"].projectIds).toContain("project-1");
            expect(index.bySlug["shared-agent"].projectIds).toContain("project-2");
        });

        it("should cleanup old agent when new agent claims same slug in overlapping projects", async () => {
            const signer1 = NDKPrivateKeySigner.generate();
            const signer2 = NDKPrivateKeySigner.generate();

            const agent1 = createStoredAgent({
                nsec: signer1.nsec,
                slug: "conflict-slug",
                name: "Agent 1",
                role: "assistant",
            });

            const agent2 = createStoredAgent({
                nsec: signer2.nsec,
                slug: "conflict-slug",
                name: "Agent 2",
                role: "assistant",
            });

            await storage.saveAgent(agent1);
            await storage.addAgentToProject(signer1.pubkey, "project-1");

            // Cleanup will remove agent1 from project-1 (the overlapping project)
            // Agent1 becomes inactive (identity preserved) since it has no projects left
            await storage.saveAgent(agent2);
            await storage.addAgentToProject(signer2.pubkey, "project-1");

            // Verify agent2 took the slug
            const loaded = await storage.getAgentBySlug("conflict-slug");
            expect(loaded?.name).toBe("Agent 2");

            // Verify agent1 is now inactive (identity preserved, not deleted)
            const agent1Loaded = await storage.loadAgent(signer1.pubkey);
            expect(agent1Loaded).not.toBeNull();
            expect(agent1Loaded?.status).toBe("inactive");
            const agent1Projects = await projectsOwnedBy(tempDir, signer1.pubkey);
            expect(agent1Projects).toEqual([]);
        });

        it("should allow same slug in different projects when no overlap", async () => {
            const signer1 = NDKPrivateKeySigner.generate();
            const signer2 = NDKPrivateKeySigner.generate();

            const agent1 = createStoredAgent({
                nsec: signer1.nsec,
                slug: "my-agent",
                name: "Agent 1",
                role: "assistant",
            });

            const agent2 = createStoredAgent({
                nsec: signer2.nsec,
                slug: "my-agent",
                name: "Agent 2",
                role: "assistant",
            });

            await storage.saveAgent(agent1);
            await storage.addAgentToProject(signer1.pubkey, "project-1");

            // No overlap in projects, so no cleanup needed
            // Agent2 will take over the slug
            await storage.saveAgent(agent2);
            await storage.addAgentToProject(signer2.pubkey, "project-2");

            // Verify agent2 took over the slug
            const loaded = await storage.getAgentBySlug("my-agent");
            expect(loaded?.name).toBe("Agent 2");

            // Agent1 remains active (its project-1 association lives in the canonical
            // kind:31933 event, not in the slug index whose ownership shifted to agent2).
            const agent1Loaded = await storage.loadAgent(signer1.pubkey);
            expect(agent1Loaded).not.toBeNull();
            expect(agent1Loaded?.status).toBe("active");
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

                // Verify index is now in new format and the legacy byProject was dropped.
                // projectIds is empty post-migration: project membership is derived from
                // the persisted kind:31933 event and is no longer mirrored in the index.
                const indexContent = await fs.readFile(indexPath, "utf-8");
                const migratedIndex = JSON.parse(indexContent);
                expect(migratedIndex.bySlug["test-agent"]).toHaveProperty("pubkey");
                expect(migratedIndex.bySlug["test-agent"]).toHaveProperty("projectIds");
                expect(migratedIndex.bySlug["test-agent"].projectIds).toEqual([]);
                expect(migratedIndex.byProject).toBeUndefined();
            } finally {
                ConfigService.config.getConfigPath = originalGetConfigPath;
            }
        });

        it("migrates a legacy index with no project associations", async () => {
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
                });

                const agentPath = path.join(tempDir, `${signer.pubkey}.json`);
                await fs.writeFile(agentPath, JSON.stringify(agent, null, 2));

                // Old-format index with the flat bySlug shape and no project map.
                const oldIndex = {
                    bySlug: { "orphan-agent": signer.pubkey },
                    byEventId: {},
                };

                const indexPath = path.join(tempDir, "index.json");
                await fs.writeFile(indexPath, JSON.stringify(oldIndex, null, 2));

                const newStorage = new AgentStorage();
                await newStorage.initialize();

                const loaded = await newStorage.getAgentBySlug("orphan-agent");
                expect(loaded).toBeDefined();

                const indexContent = await fs.readFile(indexPath, "utf-8");
                const migratedIndex = JSON.parse(indexContent);
                expect(migratedIndex.bySlug["orphan-agent"]).toHaveProperty("pubkey");
                expect(migratedIndex.bySlug["orphan-agent"]).toHaveProperty("projectIds");
                expect(migratedIndex.bySlug["orphan-agent"].projectIds).toEqual([]);
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
            });

            await storage.saveAgent(agent);
            await storage.addAgentToProject(signer.pubkey, "project-1");

            // Remove from project - agent becomes inactive but identity preserved
            await storage.removeAgentFromProject(signer.pubkey, "project-1");

            // Slug entry should still exist for reactivation lookup
            const loaded = await storage.getAgentBySlug("temp-agent");
            expect(loaded).not.toBeNull();
            expect(loaded?.status).toBe("inactive");
            const projects = await projectsOwnedBy(tempDir, signer.pubkey);
            expect(projects).toEqual([]);
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
            });

            // Agent 2 trying to claim same slug in project 2
            const agent2 = createStoredAgent({
                nsec: signer2.nsec,
                slug: "cleanup-test",
                name: "Agent 2",
                role: "assistant",
            });

            await storage.saveAgent(agent1);
            await storage.addAgentToProject(signer1.pubkey, "project-1");
            await storage.addAgentToProject(signer1.pubkey, "project-2");

            await storage.saveAgent(agent2);
            await storage.addAgentToProject(signer2.pubkey, "project-2");

            // Agent 2 takes ownership of the slug. Agent 1's project-1 association is no
            // longer tracked by the slug index — that's expected: the canonical source of
            // project membership is the persisted kind:31933 event, not this index.
            // Agent 1 itself is still active (still in project-1 according to the canonical
            // source) and addressable by pubkey.
            const agent1Loaded = await storage.loadAgent(signer1.pubkey);
            expect(agent1Loaded).not.toBeNull();
            expect(agent1Loaded?.status).toBe("active");

            // The slug now points to agent2 with project-2.
            const agent2Projects = await projectsOwnedBy(tempDir, signer2.pubkey);
            expect(agent2Projects).toContain("project-2");

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
            });

            await storage.saveAgent(agent);
            await storage.addAgentToProject(signer.pubkey, "project-1");
            await storage.addAgentToProject(signer.pubkey, "project-2");
            await storage.addAgentToProject(signer.pubkey, "project-3");

            // Rebuild index
            await storage.rebuildIndex();

            // Agent should still be findable by slug
            const loaded = await storage.getAgentBySlug("rebuild-test");
            expect(loaded).toBeDefined();
        });

        it("should remove ghost projects from slug entry when agent leaves project", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "leaving-agent",
                name: "Leaving Agent",
                role: "assistant",
            });

            await storage.saveAgent(agent);
            await storage.addAgentToProject(signer.pubkey, "project-1");
            await storage.addAgentToProject(signer.pubkey, "project-2");
            await storage.addAgentToProject(signer.pubkey, "project-3");

            // Manually verify initial state - slug entry should have all 3 projects
            const indexPath = path.join(tempDir, "index.json");
            let indexContent = await fs.readFile(indexPath, "utf-8");
            let index = JSON.parse(indexContent);
            expect(index.bySlug["leaving-agent"].projectIds).toContain("project-1");
            expect(index.bySlug["leaving-agent"].projectIds).toContain("project-2");
            expect(index.bySlug["leaving-agent"].projectIds).toContain("project-3");

            // Remove agent from project-2
            await storage.removeAgentFromProject(signer.pubkey, "project-2");

            // Verify slug entry synced to current projects (ghost project-2 removed)
            indexContent = await fs.readFile(indexPath, "utf-8");
            index = JSON.parse(indexContent);
            expect(index.bySlug["leaving-agent"].projectIds).not.toContain("project-2");
            expect(index.bySlug["leaving-agent"].projectIds).toContain("project-1");
            expect(index.bySlug["leaving-agent"].projectIds).toContain("project-3");
        });

        it("should sync slug entry when agent changes slug", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "old-slug",
                name: "Renaming Agent",
                role: "assistant",
            });

            await storage.saveAgent(agent);
            await storage.addAgentToProject(signer.pubkey, "project-1");
            await storage.addAgentToProject(signer.pubkey, "project-2");

            // Change slug
            agent.slug = "new-slug";
            await storage.saveAgent(agent);

            // Verify old slug entry removed
            const indexPath = path.join(tempDir, "index.json");
            const indexContent = await fs.readFile(indexPath, "utf-8");
            const index = JSON.parse(indexContent);
            expect(index.bySlug["old-slug"]).toBeUndefined();

            // Verify new slug entry exists with correct pubkey
            expect(index.bySlug["new-slug"].pubkey).toBe(signer.pubkey);
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
            });

            // Agent 2 with "worker-2" slug in project-2
            const agent2 = createStoredAgent({
                nsec: signer2.nsec,
                slug: "worker-2",
                name: "Worker 2",
                role: "assistant",
            });

            await storage.saveAgent(agent1);
            await storage.addAgentToProject(signer1.pubkey, "project-1");

            await storage.saveAgent(agent2);
            await storage.addAgentToProject(signer2.pubkey, "project-2");

            // Both agents should be retrievable from their respective projects
            const project1Agents = await projectAgentsFromIndex(tempDir, storage, "project-1");
            expect(project1Agents).toHaveLength(1);
            expect(project1Agents[0].name).toBe("Worker 1");

            const project2Agents = await projectAgentsFromIndex(tempDir, storage, "project-2");
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
            });

            // Agent 2 with "worker" slug in project-2
            const agent2 = createStoredAgent({
                nsec: signer2.nsec,
                slug: "worker",
                name: "Worker 2",
                role: "assistant",
            });

            await storage.saveAgent(agent1);
            await storage.addAgentToProject(signer1.pubkey, "project-1");

            await storage.saveAgent(agent2);
            await storage.addAgentToProject(signer2.pubkey, "project-2");

            // bySlug points to last saved agent (agent2)
            const slugLookup = await storage.getAgentBySlug("worker");
            expect(slugLookup?.name).toBe("Worker 2");

            // Agent2 appears in its project because it owns the slug
            const project2Agents = await projectAgentsFromIndex(tempDir, storage, "project-2");
            expect(project2Agents).toHaveLength(1);
            expect(project2Agents[0].name).toBe("Worker 2");

            // Agent1 does NOT appear in getProjectAgents because it doesn't own the slug
            // This is expected behavior - slug ownership is global, not project-scoped
            const project1Agents = await projectAgentsFromIndex(tempDir, storage, "project-1");
            expect(project1Agents).toHaveLength(0);
        });

        it("should shrink slug entry when agent is removed from projects", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "shrinking-agent",
                name: "Shrinking Agent",
                role: "assistant",
            });

            await storage.saveAgent(agent);
            await storage.addAgentToProject(signer.pubkey, "project-1");
            await storage.addAgentToProject(signer.pubkey, "project-2");
            await storage.addAgentToProject(signer.pubkey, "project-3");

            // Use removeAgentFromProject to remove from project-2
            await storage.removeAgentFromProject(signer.pubkey, "project-2");

            // Verify slug entry shrunk
            const indexPath = path.join(tempDir, "index.json");
            let indexContent = await fs.readFile(indexPath, "utf-8");
            let index = JSON.parse(indexContent);
            expect(index.bySlug["shrinking-agent"].projectIds).not.toContain("project-2");
            expect(index.bySlug["shrinking-agent"].projectIds).toContain("project-1");
            expect(index.bySlug["shrinking-agent"].projectIds).toContain("project-3");

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
            });

            const agent2 = createStoredAgent({
                nsec: signer2.nsec,
                slug: "duplicate-slug",
                name: "Agent 2",
                role: "assistant",
            });

            // Save both agents — addAgentToProject runs cleanupDuplicateSlugs so the
            // second add evicts agent1 from project-1 and agent2 takes the slug.
            await storage.saveAgent(agent1);
            await storage.addAgentToProject(signer1.pubkey, "project-1");
            await storage.saveAgent(agent2);
            await storage.addAgentToProject(signer2.pubkey, "project-1");

            // Only one canonical owner per slug remains in project-1 (agent2 took over).
            const projectAgents = await projectAgentsFromIndex(tempDir, storage, "project-1");
            expect(projectAgents).toHaveLength(1);
            expect(projectAgents[0].name).toBe("Agent 2");
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
            });

            await storage.saveAgent(agent);
            await storage.addAgentToProject(signer.pubkey, "project-1");
            await storage.addAgentToProject(signer.pubkey, "project-2");

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
            });

            await storage.saveAgent(agent);
            await storage.addAgentToProject(signer.pubkey, "project-1");

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
            });

            await storage.saveAgent(agent);
            await storage.addAgentToProject(signer.pubkey, "project-1");
            await storage.addAgentToProject(signer.pubkey, "project-2");

            // Same agent should be retrievable from both projects
            const result1 = await storage.getAgentBySlugForProject("shared-slug", "project-1");
            expect(result1?.name).toBe("Multi-Project Agent");

            const result2 = await storage.getAgentBySlugForProject("shared-slug", "project-2");
            expect(result2?.name).toBe("Multi-Project Agent");
        });

        it("should return null when slug does not exist", async () => {
            const result = await storage.getAgentBySlugForProject("nonexistent", "project-1");
            expect(result).toBeNull();
        });

        it("should use index exclusively for project membership check", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
            });

            await storage.saveAgent(agent);
            await storage.addAgentToProject(signer.pubkey, "project-1");

            // Manually extend the slug entry's projectIds to claim agent is in project-2
            const indexPath = path.join(tempDir, "index.json");
            const indexContent = await fs.readFile(indexPath, "utf-8");
            const index = JSON.parse(indexContent);
            index.bySlug["test-agent"].projectIds.push("project-2");
            await fs.writeFile(indexPath, JSON.stringify(index, null, 2));

            // Re-initialize storage to load updated index
            const originalGetConfigPath = (await import("@/services/ConfigService")).config.getConfigPath;
            (await import("@/services/ConfigService")).config.getConfigPath = () => tempDir;
            const newStorage = new AgentStorage();
            await newStorage.initialize();
            (await import("@/services/ConfigService")).config.getConfigPath = originalGetConfigPath;

            // Should find agent in project-2 because index says so (no agent-file double-check)
            const result = await newStorage.getAgentBySlugForProject("test-agent", "project-2");
            expect(result).not.toBeNull();
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
            });

            await storage.saveAgent(agent);
            await storage.addAgentToProject(signer.pubkey, "project-1");
            await storage.addAgentToProject(signer.pubkey, "project-2");

            // Verify old slug exists
            const indexPath = path.join(tempDir, "index.json");
            let indexContent = await fs.readFile(indexPath, "utf-8");
            let index = JSON.parse(indexContent);
            expect(index.bySlug["old-slug"]).toBeDefined();

            // Rename the agent
            agent.slug = "new-slug";
            await storage.saveAgent(agent);

            // Old slug should be completely removed
            indexContent = await fs.readFile(indexPath, "utf-8");
            index = JSON.parse(indexContent);
            expect(index.bySlug["old-slug"]).toBeUndefined();
            expect(index.bySlug["new-slug"]).toBeDefined();
        });

        it("should clean up old slug when agent renames AND changes projects", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "old-slug",
                name: "Test Agent",
                role: "assistant",
            });

            await storage.saveAgent(agent);
            await storage.addAgentToProject(signer.pubkey, "project-1");
            await storage.addAgentToProject(signer.pubkey, "project-2");

            // Rename the agent (project changes now handled via addAgentToProject/removeAgentFromProject)
            agent.slug = "new-slug";
            await storage.saveAgent(agent);

            // Old slug should be completely removed (no ghost entries)
            const indexPath = path.join(tempDir, "index.json");
            const indexContent = await fs.readFile(indexPath, "utf-8");
            const index = JSON.parse(indexContent);
            expect(index.bySlug["old-slug"]).toBeUndefined();
            expect(index.bySlug["new-slug"]).toBeDefined();
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
            });

            await storage.saveAgent(agent1);
            await storage.addAgentToProject(signer1.pubkey, "project-1");
            await storage.addAgentToProject(signer1.pubkey, "project-2");

            // Agent 2 in project-3 with same slug (allowed - different project)
            const agent2 = createStoredAgent({
                nsec: signer2.nsec,
                slug: "shared-slug",
                name: "Agent 2",
                role: "assistant",
            });

            await storage.saveAgent(agent2);
            await storage.addAgentToProject(signer2.pubkey, "project-3");

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

    describe("legacy index migration", () => {
        it("migrates flat bySlug entries and silently drops legacy byProject", async () => {
            const signer = NDKPrivateKeySigner.generate();

            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
            });

            const agentPath = path.join(tempDir, `${signer.pubkey}.json`);
            await fs.writeFile(agentPath, JSON.stringify(agent, null, 2));

            // Old-format index with both the flat bySlug shape and a stale byProject map.
            // Both should be normalized: bySlug becomes SlugEntry; byProject is dropped.
            const indexPath = path.join(tempDir, "index.json");
            const legacyIndex = {
                bySlug: { "test-agent": signer.pubkey },
                byEventId: {},
                byProject: { "project-1": [signer.pubkey] },
            };
            await fs.writeFile(indexPath, JSON.stringify(legacyIndex, null, 2));

            const originalGetConfigPath = (await import("@/services/ConfigService")).config.getConfigPath;
            (await import("@/services/ConfigService")).config.getConfigPath = () => tempDir;
            const newStorage = new AgentStorage();
            await newStorage.initialize();
            (await import("@/services/ConfigService")).config.getConfigPath = originalGetConfigPath;

            const migratedIndex = JSON.parse(await fs.readFile(indexPath, "utf-8"));

            expect(migratedIndex.bySlug["test-agent"]).toBeDefined();
            expect(migratedIndex.bySlug["test-agent"].pubkey).toBe(signer.pubkey);
            // projectIds resets to [] — project membership now lives in event.json.
            expect(migratedIndex.bySlug["test-agent"].projectIds).toEqual([]);
            expect(migratedIndex.byProject).toBeUndefined();
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
            });

            await storage.saveAgent(agent1);
            await storage.addAgentToProject(signer1.pubkey, "project-1");

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
            });

            await storage.saveAgent(agent2);
            await storage.addAgentToProject(signer2.pubkey, "project-1");

            // Cleanup should have removed agent1 from project-1
            indexContent = await fs.readFile(indexPath, "utf-8");
            index = JSON.parse(indexContent);

            // Slug should now point to agent2
            expect(index.bySlug["conflict-slug"].pubkey).toBe(signer2.pubkey);
            expect(index.bySlug["conflict-slug"].projectIds).toContain("project-1");

            // Agent1 file should still exist but be inactive (identity preservation)
            const agent1Loaded = await storage.loadAgent(signer1.pubkey);
            expect(agent1Loaded).not.toBeNull();
            expect(agent1Loaded?.status).toBe("inactive");
            const agent1Projects = await projectsOwnedBy(tempDir, signer1.pubkey);
            expect(agent1Projects).toEqual([]);
        });
    });

    describe("getAgentBySlug global lookup", () => {
        it("should find agent by slug regardless of project", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
            });

            await storage.saveAgent(agent);
            await storage.addAgentToProject(signer.pubkey, "project-1");

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
            });

            const agent2 = createStoredAgent({
                nsec: signer2.nsec,
                slug: "shared-slug",
                name: "Agent 2",
                role: "assistant",
            });

            await storage.saveAgent(agent1);
            await storage.addAgentToProject(signer1.pubkey, "project-1");

            await storage.saveAgent(agent2);
            await storage.addAgentToProject(signer2.pubkey, "project-2");

            const result = await storage.getAgentBySlug("shared-slug");
            expect(result?.name).toBe("Agent 2");
        });
    });
});
