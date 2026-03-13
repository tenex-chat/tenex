import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "fs/promises";
import type { AgentInstance } from "@/agents/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import {
    CONTEXT_MANAGEMENT_KEY,
    createExecutionContextManagement,
} from "../context-management";

describe("TENEX context management integration", () => {
    const TEST_DIR = "/tmp/tenex-context-management";
    const PROJECT_ID = "project-context-management";
    const CONVERSATION_ID = "conv-context-management";
    const AGENT_PUBKEY = "agent-pubkey-123";

    let store: ConversationStore;

    beforeEach(async () => {
        await mkdir(TEST_DIR, { recursive: true });
        store = new ConversationStore(TEST_DIR);
        store.load(PROJECT_ID, CONVERSATION_ID);
    });

    afterEach(async () => {
        await rm(TEST_DIR, { recursive: true, force: true });
    });

    test("scratchpad tool persists state and affects the next prompt projection", async () => {
        const agent = {
            name: "executor",
            slug: "executor",
            pubkey: AGENT_PUBKEY,
        } as AgentInstance;
        const contextManagement = createExecutionContextManagement({
            providerId: "openrouter",
            conversationId: CONVERSATION_ID,
            agent,
            conversationStore: store,
        });

        expect(contextManagement).toBeDefined();
        expect(contextManagement?.optionalTools.scratchpad).toBeDefined();

        const scratchpadTool = contextManagement!.optionalTools.scratchpad as {
            execute: (input: unknown, options: { experimental_context: Record<string, unknown> }) => Promise<unknown>;
        };
        await scratchpadTool.execute(
            {
                notes: "Focus on the parser errors",
                omitToolCallIds: ["call-old"],
            },
            {
                experimental_context: {
                    [CONTEXT_MANAGEMENT_KEY]: contextManagement!.requestContext,
                },
            }
        );

        expect(store.getContextManagementScratchpad(AGENT_PUBKEY)).toEqual(
            expect.objectContaining({
                notes: "Focus on the parser errors",
                omitToolCallIds: ["call-old"],
            })
        );

        const transformed = await contextManagement!.middleware.transformParams?.({
            params: {
                prompt: [
                    { role: "system", content: "You are helpful." },
                    {
                        role: "assistant",
                        content: [{ type: "tool-call", toolCallId: "call-old", toolName: "fs_read", input: { path: "old.ts" } }],
                    },
                    {
                        role: "tool",
                        content: [{ type: "tool-result", toolCallId: "call-old", toolName: "fs_read", output: { type: "text", value: "old contents" } }],
                    },
                    {
                        role: "user",
                        content: [{ type: "text", text: "Continue." }],
                    },
                ],
                providerOptions: {
                    [CONTEXT_MANAGEMENT_KEY]: contextManagement!.requestContext,
                },
            },
            model: {
                specificationVersion: "v3",
                provider: "mock",
                modelId: "mock",
                supportedUrls: {},
                doGenerate: async () => {
                    throw new Error("unused");
                },
                doStream: async () => {
                    throw new Error("unused");
                },
            },
        } as any);

        expect(JSON.stringify(transformed?.prompt)).toContain("Focus on the parser errors");
        expect(JSON.stringify(transformed?.prompt)).not.toContain("\"toolCallId\":\"call-old\"");
    });
});
