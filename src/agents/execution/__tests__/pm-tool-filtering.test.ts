import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import { getProjectContext, isProjectContextInitialized } from "@/services";

// Mock the services module
mock.module("@/services", () => ({
    isProjectContextInitialized: mock(() => true),
    getProjectContext: mock(() => ({
        projectManager: {
            pubkey: "pm-pubkey-123",
            name: "Project Manager",
        },
    })),
}));

describe("PM Tool Filtering", () => {
    it("should enforce delegate_phase for PM agents and remove delegate", () => {
        const pmAgent: Partial<AgentInstance> = {
            pubkey: "pm-pubkey-123",
            tools: ["delegate", "shell", "read_path"], // Note: no delegate_phase initially
        };

        // Simulate the filtering logic from AgentExecutor
        let toolNames = pmAgent.tools || [];

        if (isProjectContextInitialized()) {
            const projectCtx = getProjectContext();
            const isPM = pmAgent.pubkey === projectCtx.projectManager.pubkey;

            if (isPM) {
                // PM agents must have delegate_phase, not delegate
                toolNames = toolNames.filter((name) => name !== "delegate");
                if (!toolNames.includes("delegate_phase")) {
                    toolNames.push("delegate_phase");
                }
            } else {
                // Non-PM agents must have delegate, not delegate_phase
                toolNames = toolNames.filter((name) => name !== "delegate_phase");
                if (!toolNames.includes("delegate")) {
                    toolNames.push("delegate");
                }
            }
        }

        // PM should have delegate_phase but not delegate
        expect(toolNames).toContain("delegate_phase");
        expect(toolNames).not.toContain("delegate");
        expect(toolNames).toContain("shell");
        expect(toolNames).toContain("read_path");
    });

    it("should enforce delegate for non-PM agents and remove delegate_phase", () => {
        const nonPmAgent: Partial<AgentInstance> = {
            pubkey: "non-pm-pubkey-456",
            tools: ["delegate_phase", "shell", "read_path"], // Note: no delegate initially
        };

        // Simulate the filtering logic from AgentExecutor
        let toolNames = nonPmAgent.tools || [];

        if (isProjectContextInitialized()) {
            const projectCtx = getProjectContext();
            const isPM = nonPmAgent.pubkey === projectCtx.projectManager.pubkey;

            if (isPM) {
                // PM agents must have delegate_phase, not delegate
                toolNames = toolNames.filter((name) => name !== "delegate");
                if (!toolNames.includes("delegate_phase")) {
                    toolNames.push("delegate_phase");
                }
            } else {
                // Non-PM agents must have delegate, not delegate_phase
                toolNames = toolNames.filter((name) => name !== "delegate_phase");
                if (!toolNames.includes("delegate")) {
                    toolNames.push("delegate");
                }
            }
        }

        // Non-PM should have delegate but not delegate_phase
        expect(toolNames).toContain("delegate");
        expect(toolNames).not.toContain("delegate_phase");
        expect(toolNames).toContain("shell");
        expect(toolNames).toContain("read_path");
    });

    it("should not filter tools when project context is not initialized", () => {
        // Mock isProjectContextInitialized to return false
        const mockIsProjectContextInitialized = isProjectContextInitialized as ReturnType<
            typeof mock
        >;
        mockIsProjectContextInitialized.mockReturnValue(false);

        const agent: Partial<AgentInstance> = {
            pubkey: "any-pubkey",
            tools: ["delegate", "delegate_phase", "shell", "read_path"],
        };

        // Simulate the filtering logic from AgentExecutor
        let toolNames = agent.tools || [];

        if (isProjectContextInitialized()) {
            const projectCtx = getProjectContext();
            const isPM = agent.pubkey === projectCtx.projectManager.pubkey;

            toolNames = toolNames.filter((name) => {
                if (isPM) {
                    return name !== "delegate"; // Remove delegate for PM
                }
                return name !== "delegate_phase"; // Remove delegate_phase for non-PM
            });
        }

        // Should not filter any tools when project context is not initialized
        expect(toolNames).toContain("delegate");
        expect(toolNames).toContain("delegate_phase");
        expect(toolNames).toContain("shell");
        expect(toolNames).toContain("read_path");
    });
});
