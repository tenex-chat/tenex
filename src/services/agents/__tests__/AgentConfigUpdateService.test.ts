import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { agentStorage } from "@/agents/AgentStorage";
import type { AgentDefaultConfig, AgentProjectConfig } from "@/agents/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { AgentConfigUpdateService } from "../AgentConfigUpdateService";

describe("AgentConfigUpdateService", () => {
    let service: AgentConfigUpdateService;
    let updateDefaultConfigCalls: Array<{
        pubkey: string;
        updates: AgentDefaultConfig;
        options?: { clearProjectOverrides?: boolean };
    }>;
    let updateProjectOverrideCalls: Array<{
        pubkey: string;
        projectDTag: string;
        override: AgentProjectConfig;
        reset: boolean;
    }>;
    let updateAgentIsPMCalls: Array<{ pubkey: string; isPM: boolean | undefined }>;
    let updateProjectScopedIsPMCalls: Array<{
        pubkey: string;
        projectDTag: string;
        isPM: boolean | undefined;
    }>;

    beforeEach(() => {
        service = new AgentConfigUpdateService();
        updateDefaultConfigCalls = [];
        updateProjectOverrideCalls = [];
        updateAgentIsPMCalls = [];
        updateProjectScopedIsPMCalls = [];

        spyOn(agentStorage, "loadAgent").mockImplementation(async () => ({
            slug: "test-agent",
            name: "Test Agent",
            role: "assistant",
            nsec: "nsec1abc",
            default: { tools: ["conversation_search"] },
        } as any));
        spyOn(agentStorage, "updateDefaultConfig").mockImplementation(async (
            pubkey: string,
            updates: AgentDefaultConfig,
            options?: { clearProjectOverrides?: boolean }
        ) => {
            updateDefaultConfigCalls.push({ pubkey, updates, options });
            return true;
        });
        spyOn(agentStorage, "updateProjectOverride").mockImplementation(async (
            pubkey: string,
            projectDTag: string,
            override: AgentProjectConfig,
            reset = false
        ) => {
            updateProjectOverrideCalls.push({ pubkey, projectDTag, override, reset });
            return true;
        });
        spyOn(agentStorage, "updateAgentIsPM").mockImplementation(async (
            pubkey: string,
            isPM: boolean | undefined
        ) => {
            updateAgentIsPMCalls.push({ pubkey, isPM });
            return true;
        });
        spyOn(agentStorage, "updateProjectScopedIsPM").mockImplementation(async (
            pubkey: string,
            projectDTag: string,
            isPM: boolean | undefined
        ) => {
            updateProjectScopedIsPMCalls.push({ pubkey, projectDTag, isPM });
            return true;
        });
    });

    afterEach(() => {
        mock.restore();
    });

    it("clears project overrides on global updates", async () => {
        const event = createMockEvent([
            ["p", "agent-pubkey"],
            ["model", "ollama/qwen3.5:cloud"],
            ["tool", "fs_read"],
            ["blocked-skill", "shell"],
            ["pm"],
        ]);

        const result = await service.applyEvent(event);

        expect(result.scope).toBe("global");
        expect(updateDefaultConfigCalls).toEqual([
            {
                pubkey: "agent-pubkey",
                updates: {
                    model: "ollama/qwen3.5:cloud",
                    tools: ["fs_read"],
                    blockedSkills: ["shell"],
                },
                options: { clearProjectOverrides: true },
            },
        ]);
        expect(updateAgentIsPMCalls).toEqual([{ pubkey: "agent-pubkey", isPM: true }]);
    });

    it("converts project-scoped tool snapshots into storage deltas", async () => {
        const event = createMockEvent([
            ["p", "agent-pubkey"],
            ["a", "31933:09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7:TENEX-ff3ssq"],
            ["model", "claude auto"],
            ["tool", "conversation_search"],
            ["tool", "shell"],
            ["blocked-skill", "shell"],
        ]);

        const result = await service.applyEvent(event, { projectDTag: "TENEX-ff3ssq" });

        expect(result.scope).toBe("project");
        expect(updateProjectOverrideCalls).toEqual([
            {
                pubkey: "agent-pubkey",
                projectDTag: "TENEX-ff3ssq",
                override: {
                    model: "claude auto",
                    tools: ["+shell"],
                    blockedSkills: ["shell"],
                },
                reset: false,
            },
        ]);
        expect(updateProjectScopedIsPMCalls).toEqual([]);
    });

    it("clears project config and project-scoped PM on reset", async () => {
        const event = createMockEvent([
            ["p", "agent-pubkey"],
            ["a", "31933:09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7:TENEX-ff3ssq"],
            ["reset"],
        ]);

        const result = await service.applyEvent(event, { projectDTag: "TENEX-ff3ssq" });

        expect(result.hasReset).toBe(true);
        expect(updateProjectOverrideCalls).toEqual([
            {
                pubkey: "agent-pubkey",
                projectDTag: "TENEX-ff3ssq",
                override: {},
                reset: true,
            },
        ]);
        expect(updateProjectScopedIsPMCalls).toEqual([
            {
                pubkey: "agent-pubkey",
                projectDTag: "TENEX-ff3ssq",
                isPM: undefined,
            },
        ]);
    });
});

function createMockEvent(tags: string[][]): NDKEvent {
    return {
        tags,
        tagValue(tagName: string) {
            return tags.find((tag) => tag[0] === tagName)?.[1];
        },
    } as NDKEvent;
}
