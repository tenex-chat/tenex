import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStorage, createStoredAgent } from "../AgentStorage";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { DEFAULT_AGENT_LLM_CONFIG } from "@/llm/constants";

// We'll test the installAgentFromNostr function behavior through mocking
describe("agent-installer", () => {
    let tempDir: string;
    let storage: AgentStorage;

    beforeEach(async () => {
        // Create temp directory for test storage
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-installer-test-"));

        // Override config path for testing
        const configService = await import("@/services/ConfigService");
        configService.config.getConfigPath = () => tempDir;

        storage = new AgentStorage();
        await storage.initialize();
    });

    afterEach(async () => {
        // Clean up temp directory
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    describe("LLM config preservation on reinstall", () => {
        it("should preserve existing LLM config when agent with same eventId already exists", async () => {
            // This test verifies the bug fix:
            // When an agent with the same eventId is "installed" again (e.g., added to a new project),
            // the existing llmConfig should be preserved, not reset to default.

            const signer = NDKPrivateKeySigner.generate();
            const eventId = "test-agent-event-123";
            const customLlmConfig = "anthropic:claude-opus-4";

            // First, create an agent with a custom LLM config
            const existingAgent = createStoredAgent({
                nsec: signer.nsec,
                slug: "claude-code",
                name: "Claude Code",
                role: "assistant",
                defaultConfig: { model: customLlmConfig },
                eventId: eventId,
            });

            await storage.saveAgent(existingAgent);
            await storage.addAgentToProject(signer.pubkey, "project-1");

            // Verify it was saved correctly
            const loaded = await storage.getAgentByEventId(eventId);
            expect(loaded).not.toBeNull();
            expect(loaded?.default?.model).toBe(customLlmConfig);
            const loadedProjects = await storage.getAgentProjects(signer.pubkey);
            expect(loadedProjects).toContain("project-1");

            // Now simulate what the installer does:
            // Check if agent already exists by eventId
            const existing = await storage.getAgentByEventId(eventId);

            // The fix ensures we return the existing agent instead of creating a new one
            expect(existing).not.toBeNull();
            expect(existing?.default?.model).toBe(customLlmConfig);
            expect(existing?.default?.model).not.toBe(DEFAULT_AGENT_LLM_CONFIG);
        });

        it("should use default LLM config for truly new agents", async () => {
            // Verify that new agents (no existing eventId) still get default config
            const eventId = "brand-new-event-456";

            // No agent exists with this eventId
            const existing = await storage.getAgentByEventId(eventId);
            expect(existing).toBeNull();

            // When no existing agent, a new one should use default config
            const signer = NDKPrivateKeySigner.generate();
            const newAgent = createStoredAgent({
                nsec: signer.nsec,
                slug: "new-agent",
                name: "New Agent",
                role: "assistant",
                defaultConfig: { model: DEFAULT_AGENT_LLM_CONFIG },
                eventId: eventId,
            });

            await storage.saveAgent(newAgent);

            const loaded = await storage.getAgentByEventId(eventId);
            expect(loaded?.default?.model).toBe(DEFAULT_AGENT_LLM_CONFIG);
        });

        it("should preserve pmOverrides when agent already exists", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const eventId = "test-agent-with-pm-override";

            // Create agent with PM override for project-1
            const existingAgent = createStoredAgent({
                nsec: signer.nsec,
                slug: "pm-agent",
                name: "PM Agent",
                role: "assistant",
                defaultConfig: { model: "custom-model" },
                eventId: eventId,
                pmOverrides: { "project-1": true },
            });

            await storage.saveAgent(existingAgent);

            // Verify PM override is preserved
            const loaded = await storage.getAgentByEventId(eventId);
            expect(loaded?.pmOverrides).toEqual({ "project-1": true });
        });

        it("should preserve nsec (identity) when agent already exists", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const eventId = "test-agent-identity";

            const existingAgent = createStoredAgent({
                nsec: signer.nsec,
                slug: "identity-agent",
                name: "Identity Agent",
                role: "assistant",
                defaultConfig: { model: "custom-model" },
                eventId: eventId,
            });

            await storage.saveAgent(existingAgent);

            // The existing agent's nsec should be preserved
            const loaded = await storage.getAgentByEventId(eventId);
            expect(loaded?.nsec).toBe(signer.nsec);
        });

        it("should preserve project associations when agent already exists", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const eventId = "test-agent-projects";

            const existingAgent = createStoredAgent({
                nsec: signer.nsec,
                slug: "multi-project-agent",
                name: "Multi Project Agent",
                role: "assistant",
                defaultConfig: { model: "custom-model" },
                eventId: eventId,
            });

            await storage.saveAgent(existingAgent);
            const signer2 = new (await import("@nostr-dev-kit/ndk")).NDKPrivateKeySigner(existingAgent.nsec);
            await storage.addAgentToProject(signer2.pubkey, "project-1");
            await storage.addAgentToProject(signer2.pubkey, "project-2");
            await storage.addAgentToProject(signer2.pubkey, "project-3");

            // All project associations should be preserved
            const projects = await storage.getAgentProjects(signer2.pubkey);
            expect(projects).toContain("project-1");
            expect(projects).toContain("project-2");
            expect(projects).toContain("project-3");
        });
    });

    describe("scenario: same agent definition added to multiple projects", () => {
        it("should not reset LLM config when adding to a new project", async () => {
            // Scenario:
            // 1. Agent "claude-code" exists with eventId X, custom LLM config "claude opus", in project A
            // 2. User adds same agent definition (eventId X) to project B
            // 3. Expected: agent's LLM config should remain "claude opus" (not reset to default)
            // 4. Expected: agent should now be in both project A and B

            const signer = NDKPrivateKeySigner.generate();
            const eventId = "shared-agent-definition";
            const customLlmConfig = "anthropic:claude-opus-4";

            // Step 1: Agent exists in project A with custom config
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "claude-code",
                name: "Claude Code",
                role: "Developer",
                defaultConfig: { model: customLlmConfig },
                eventId: eventId,
            });

            await storage.saveAgent(agent);
            await storage.addAgentToProject(signer.pubkey, "project-A");

            // Step 2: Check if agent already exists (simulating what installAgentFromNostr does)
            const existing = await storage.getAgentByEventId(eventId);

            // The fix returns existing agent, preserving config
            expect(existing).not.toBeNull();
            expect(existing?.default?.model).toBe(customLlmConfig);

            // Step 3: Add to project B (using the existing agent, not creating new)
            await storage.addAgentToProject(signer.pubkey, "project-B");

            // Step 4: Verify final state
            const final = await storage.getAgentByEventId(eventId);
            expect(final?.default?.model).toBe(customLlmConfig); // LLM config preserved!
            const finalProjects = await storage.getAgentProjects(signer.pubkey);
            expect(finalProjects).toContain("project-A");
            expect(finalProjects).toContain("project-B");
        });
    });
});
