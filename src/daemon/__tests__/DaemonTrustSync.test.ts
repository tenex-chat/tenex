/**
 * Tests for Daemon-level trust sync behavior.
 *
 * Exercises the actual syncTrustServiceAgentPubkeys() and handleDynamicAgentAdded()
 * methods on a Daemon instance to verify that:
 * - Stored (non-running) project agents retain trust after sync
 * - Dynamically added agents are persisted in storedAgentPubkeys
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";

// Mock heavy dependencies that Daemon imports but we don't need for trust tests
mock.module("@/utils/logger", () => ({
    logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
    },
}));

mock.module("@/services/ConfigService", () => ({
    config: {
        getConfig: () => ({}),
        getConfigPath: (subdir?: string) => `/mock/path/${subdir || ""}`,
        getWhitelistedPubkeys: () => [],
        getBackendSigner: async () => ({ pubkey: "mock-backend-pubkey" }),
    },
}));

mock.module("@/services/projects", () => ({
    projectContextStore: {
        getContext: () => null,
    },
}));

// Import TrustPubkeyService after mocks are set up
import { TrustPubkeyService } from "@/services/trust-pubkeys/TrustPubkeyService";
import { Daemon } from "../Daemon";

/**
 * Helper to access private Daemon members for testing.
 * We test the actual Daemon methods rather than re-implementing the logic.
 */
function getDaemonInternals(daemon: Daemon) {
    const d = daemon as any;
    return {
        get storedAgentPubkeys(): Set<string> {
            return d.storedAgentPubkeys;
        },
        get agentPubkeyToProjects(): Map<string, Set<string>> {
            return d.agentPubkeyToProjects;
        },
        syncTrustServiceAgentPubkeys: () => d.syncTrustServiceAgentPubkeys(),
        handleDynamicAgentAdded: (projectId: string, agent: any) =>
            d.handleDynamicAgentAdded(projectId, agent),
    };
}

describe("Daemon trust sync (syncTrustServiceAgentPubkeys)", () => {
    let daemon: Daemon;
    let internals: ReturnType<typeof getDaemonInternals>;
    let trustService: TrustPubkeyService;

    beforeEach(() => {
        // Reset trust service singleton
        (TrustPubkeyService as any).instance = undefined;
        trustService = TrustPubkeyService.getInstance();
        trustService.resetAll();

        // Create a fresh Daemon (not started — we only test trust sync internals)
        daemon = new Daemon();
        internals = getDaemonInternals(daemon);
    });

    test("sync unions active runtime pubkeys with stored pubkeys", () => {
        // Simulate startup: seed storedAgentPubkeys (as Daemon.start() does)
        internals.storedAgentPubkeys.add("stored-agent-a");
        internals.storedAgentPubkeys.add("stored-agent-b");
        internals.storedAgentPubkeys.add("stored-agent-c");

        // Simulate one project running with only agent-a active
        internals.agentPubkeyToProjects.set("stored-agent-a", new Set(["project-1"]));

        // Call the actual Daemon method
        internals.syncTrustServiceAgentPubkeys();

        // All stored pubkeys must remain trusted
        expect(trustService.isTrustedSync("stored-agent-a").trusted).toBe(true);
        expect(trustService.isTrustedSync("stored-agent-b").trusted).toBe(true);
        expect(trustService.isTrustedSync("stored-agent-c").trusted).toBe(true);
    });

    test("stored pubkeys survive after a project is removed from runtime", () => {
        // Seed stored pubkeys
        internals.storedAgentPubkeys.add("agent-proj-x");
        internals.storedAgentPubkeys.add("agent-proj-y");

        // Both projects initially running
        internals.agentPubkeyToProjects.set("agent-proj-x", new Set(["proj-x"]));
        internals.agentPubkeyToProjects.set("agent-proj-y", new Set(["proj-y"]));

        internals.syncTrustServiceAgentPubkeys();
        expect(trustService.isTrustedSync("agent-proj-x").trusted).toBe(true);
        expect(trustService.isTrustedSync("agent-proj-y").trusted).toBe(true);

        // Project Y stops: remove from runtime map
        internals.agentPubkeyToProjects.delete("agent-proj-y");

        // Re-sync — agent-proj-y should still be trusted via storedAgentPubkeys
        internals.syncTrustServiceAgentPubkeys();
        expect(trustService.isTrustedSync("agent-proj-x").trusted).toBe(true);
        expect(trustService.isTrustedSync("agent-proj-y").trusted).toBe(true);
    });

    test("new runtime agents that are NOT in storedAgentPubkeys are still trusted", () => {
        // Seed with one stored agent
        internals.storedAgentPubkeys.add("old-agent");

        // New project starts with a brand-new agent
        internals.agentPubkeyToProjects.set("new-runtime-agent", new Set(["new-project"]));

        internals.syncTrustServiceAgentPubkeys();

        expect(trustService.isTrustedSync("old-agent").trusted).toBe(true);
        expect(trustService.isTrustedSync("new-runtime-agent").trusted).toBe(true);
    });

    test("unknown pubkeys remain untrusted", () => {
        internals.storedAgentPubkeys.add("known-agent");
        internals.agentPubkeyToProjects.set("known-agent", new Set(["proj-1"]));

        internals.syncTrustServiceAgentPubkeys();

        expect(trustService.isTrustedSync("totally-unknown").trusted).toBe(false);
    });
});

describe("Daemon handleDynamicAgentAdded persists to storedAgentPubkeys", () => {
    let daemon: Daemon;
    let internals: ReturnType<typeof getDaemonInternals>;
    let trustService: TrustPubkeyService;

    beforeEach(() => {
        (TrustPubkeyService as any).instance = undefined;
        trustService = TrustPubkeyService.getInstance();
        trustService.resetAll();

        daemon = new Daemon();
        internals = getDaemonInternals(daemon);
    });

    test("dynamically added agent is persisted in storedAgentPubkeys", () => {
        const agent = {
            name: "New Agent",
            slug: "new-agent",
            pubkey: "dynamic-agent-pubkey",
            role: "developer",
            llmConfig: "default",
            tools: [],
            signer: {} as any,
        };

        internals.handleDynamicAgentAdded("project-123", agent);

        // Should be in storedAgentPubkeys
        expect(internals.storedAgentPubkeys.has("dynamic-agent-pubkey")).toBe(true);

        // Should be in runtime map
        expect(internals.agentPubkeyToProjects.has("dynamic-agent-pubkey")).toBe(true);
    });

    test("dynamically added agent retains trust after project stops", () => {
        // Add agent dynamically
        const agent = {
            name: "Dynamic Agent",
            slug: "dynamic-agent",
            pubkey: "dynamic-pubkey",
            role: "developer",
            llmConfig: "default",
            tools: [],
            signer: {} as any,
        };

        internals.handleDynamicAgentAdded("project-abc", agent);
        internals.syncTrustServiceAgentPubkeys();

        expect(trustService.isTrustedSync("dynamic-pubkey").trusted).toBe(true);

        // Simulate project stop: remove from runtime map
        internals.agentPubkeyToProjects.delete("dynamic-pubkey");

        // Re-sync — dynamic agent should still be trusted via storedAgentPubkeys
        internals.syncTrustServiceAgentPubkeys();
        expect(trustService.isTrustedSync("dynamic-pubkey").trusted).toBe(true);
    });
});
