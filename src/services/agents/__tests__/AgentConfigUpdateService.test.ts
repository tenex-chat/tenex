import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { agentStorage } from "@/agents/AgentStorage";
import type { AgentDefaultConfig } from "@/agents/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { AgentConfigUpdateService } from "../AgentConfigUpdateService";

describe("AgentConfigUpdateService", () => {
    let service: AgentConfigUpdateService;
    let updateDefaultConfigCalls: Array<{
        pubkey: string;
        updates: AgentDefaultConfig;
    }>;
    let updateAgentIsPMCalls: Array<{ pubkey: string; isPM: boolean | undefined }>;
    let resetDefaultConfigCalls: Array<{ pubkey: string }>;

    beforeEach(() => {
        service = new AgentConfigUpdateService();
        updateDefaultConfigCalls = [];
        updateAgentIsPMCalls = [];
        resetDefaultConfigCalls = [];

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
        ) => {
            updateDefaultConfigCalls.push({ pubkey, updates });
            return true;
        });
        spyOn(agentStorage, "updateAgentIsPM").mockImplementation(async (
            pubkey: string,
            isPM: boolean | undefined
        ) => {
            updateAgentIsPMCalls.push({ pubkey, isPM });
            return true;
        });
        spyOn(agentStorage, "resetDefaultConfig").mockImplementation(async (pubkey: string) => {
            resetDefaultConfigCalls.push({ pubkey });
            return true;
        });
    });

    afterEach(() => {
        mock.restore();
    });

    it("applies global config update", async () => {
        const event = createMockEvent([
            ["p", "agent-pubkey"],
            ["model", "ollama/qwen3.5:cloud"],
            ["tool", "fs_read"],
            ["blocked-skill", "shell"],
            ["pm"],
        ]);

        const result = await service.applyEvent(event);

        expect(result.configUpdated).toBe(true);
        expect(updateDefaultConfigCalls).toEqual([
            {
                pubkey: "agent-pubkey",
                updates: {
                    model: "ollama/qwen3.5:cloud",
                    tools: ["fs_read"],
                    blockedSkills: ["shell"],
                },
            },
        ]);
        expect(updateAgentIsPMCalls).toEqual([{ pubkey: "agent-pubkey", isPM: true }]);
    });

    it("treats a-tag event as global config update", async () => {
        const event = createMockEvent([
            ["p", "agent-pubkey"],
            ["a", "31933:09d48a:TENEX-ff3ssq"],
            ["model", "claude auto"],
            ["tool", "fs_read"],
        ]);

        const result = await service.applyEvent(event);

        expect(result.configUpdated).toBe(true);
        expect(updateDefaultConfigCalls).toHaveLength(1);
        expect(updateDefaultConfigCalls[0].pubkey).toBe("agent-pubkey");
        expect(resetDefaultConfigCalls).toHaveLength(0);
    });

    it("resets default config and isPM when reset tag is present", async () => {
        const event = createMockEvent([
            ["p", "agent-pubkey"],
            ["reset"],
        ]);

        const result = await service.applyEvent(event);

        expect(result.hasReset).toBe(true);
        expect(result.configUpdated).toBe(true);
        expect(result.pmUpdated).toBe(true);
        expect(resetDefaultConfigCalls).toEqual([{ pubkey: "agent-pubkey" }]);
        expect(updateDefaultConfigCalls).toHaveLength(0);
        expect(updateAgentIsPMCalls).toHaveLength(0);
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
