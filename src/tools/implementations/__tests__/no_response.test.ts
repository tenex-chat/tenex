import { beforeEach, describe, expect, it } from "bun:test";
import { RALRegistry } from "@/services/ral";
import { createMockExecutionEnvironment } from "@/test-utils";
import { createNoResponseTool } from "../no_response";

describe("no_response tool", () => {
    const projectId = "31933:test:no-response";
    const agentPubkey = "a".repeat(64);
    const conversationId = "conversation-no-response";
    let registry: RALRegistry;

    beforeEach(() => {
        // @ts-expect-error Reset singleton for test isolation
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();
    });

    it("requests silent completion for the active RAL and returns audit-friendly output", async () => {
        const context = createMockExecutionEnvironment({
            conversationId,
            ralNumber: 1,
            agent: {
                slug: "test-agent",
                pubkey: agentPubkey,
                name: "Test Agent",
                llmConfig: "default",
            } as any,
        });

        registry.create(agentPubkey, conversationId, projectId);

        const tool = createNoResponseTool(context);
        const result = await tool.execute({});

        expect(result).toEqual({
            success: true,
            mode: "silent-complete",
            message: expect.stringContaining("This turn ends immediately"),
        });
        expect(registry.isSilentCompletionRequested(agentPubkey, conversationId, 1)).toBe(true);
    });
});
