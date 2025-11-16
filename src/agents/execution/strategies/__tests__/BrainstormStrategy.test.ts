import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Conversation } from "@/conversations/types";
import { NostrKind, NostrTag, TagValue } from "@/nostr/constants";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ExecutionContext } from "../../types";
import { BrainstormStrategy } from "../BrainstormStrategy";

describe("BrainstormStrategy", () => {
    let strategy: BrainstormStrategy;

    beforeEach(() => {
        strategy = new BrainstormStrategy();
    });

    // Lightweight mock event factory
    const createMockEvent = (params: {
        id: string;
        pubkey: string;
        kind: number;
        content?: string;
        tags?: string[][];
    }): NDKEvent =>
        ({
            id: params.id,
            pubkey: params.pubkey,
            created_at: Date.now() / 1000,
            kind: params.kind,
            tags: params.tags || [],
            content: params.content || `Content for ${params.id}`,
            sig: "mock-sig",
            tagValue: (tagName: string) => {
                const tag = (params.tags || []).find((t) => t[0] === tagName);
                return tag?.[1];
            },
        }) as any;

    // Mock conversation factory
    const createMockConversation = (history: NDKEvent[]): Conversation => ({
        id: "test-conv",
        history,
        title: "Test conversation",
        createdAt: Date.now(),
        agentStates: new Map(),
        metadata: {},
        executionTime: {
            totalSeconds: 0,
            isActive: false,
            lastUpdated: Date.now(),
        },
    });

    // Mock execution context factory
    const createMockContext = (
        conversation: Conversation,
        triggeringEvent: NDKEvent
    ): ExecutionContext => ({
        conversationId: conversation.id,
        agent: {
            name: "Test Agent",
            pubkey: "test-agent",
            slug: "test",
            instructions: "Test agent",
            tools: [],
        } as any,
        triggeringEvent,
        conversationCoordinator: {
            getConversation: () => conversation,
        } as any,
        projectPath: "/test/path",
    });

    describe("buildMessages", () => {
        it("should include only selected responses based on kind:7 reactions", async () => {
            // Setup
            const brainstormRoot = createMockEvent({
                id: "brainstorm1",
                pubkey: "user",
                kind: NostrKind.BRAINSTORM_REQUEST,
                content: "Let's brainstorm",
                tags: [
                    [NostrTag.MODE, TagValue.BRAINSTORM_MODE],
                    [NostrTag.PUBKEY, "moderator"],
                    [NostrTag.PARTICIPANT, "agent1"],
                    [NostrTag.PARTICIPANT, "agent2"],
                ],
            });

            const response1 = createMockEvent({
                id: "response1",
                pubkey: "agent1",
                kind: NostrKind.GENERIC_REPLY,
                content: "Agent 1 response",
                tags: [[NostrTag.ROOT_EVENT, "brainstorm1"]],
            });

            const response2 = createMockEvent({
                id: "response2",
                pubkey: "agent2",
                kind: NostrKind.GENERIC_REPLY,
                content: "Agent 2 response",
                tags: [[NostrTag.ROOT_EVENT, "brainstorm1"]],
            });

            const selection = createMockEvent({
                id: "selection1",
                pubkey: "moderator",
                kind: NostrKind.REACTION,
                content: TagValue.REACTION_POSITIVE,
                tags: [
                    [NostrTag.ROOT_EVENT, "brainstorm1"],
                    [NostrTag.EVENT, "response2"],
                    [NostrTag.PUBKEY, "agent2"],
                ],
            });

            const conversation = createMockConversation([
                brainstormRoot,
                response1,
                response2,
                selection,
            ]);

            const context = createMockContext(conversation, brainstormRoot);

            // Execute
            const messages = await strategy.buildMessages(context, brainstormRoot);

            // Assert
            const messageContent = messages.map((m) => m.content).join(" ");
            expect(messageContent).toContain("Agent 2 response");
            expect(messageContent).not.toContain("Agent 1 response");
        });

        it("should include multiple selected responses", async () => {
            // Setup
            const brainstormRoot = createMockEvent({
                id: "brainstorm1",
                pubkey: "user",
                kind: NostrKind.BRAINSTORM_REQUEST,
                content: "Brainstorm topic",
                tags: [[NostrTag.MODE, TagValue.BRAINSTORM_MODE]],
            });

            const response1 = createMockEvent({
                id: "response1",
                pubkey: "agent1",
                kind: NostrKind.GENERIC_REPLY,
                content: "First response",
                tags: [[NostrTag.ROOT_EVENT, "brainstorm1"]],
            });

            const response2 = createMockEvent({
                id: "response2",
                pubkey: "agent2",
                kind: NostrKind.GENERIC_REPLY,
                content: "Second response",
                tags: [[NostrTag.ROOT_EVENT, "brainstorm1"]],
            });

            // Both responses selected
            const selection1 = createMockEvent({
                id: "selection1",
                pubkey: "moderator",
                kind: NostrKind.REACTION,
                content: TagValue.REACTION_POSITIVE,
                tags: [
                    [NostrTag.ROOT_EVENT, "brainstorm1"],
                    [NostrTag.EVENT, "response1"],
                ],
            });

            const selection2 = createMockEvent({
                id: "selection2",
                pubkey: "user",
                kind: NostrKind.REACTION,
                content: TagValue.REACTION_POSITIVE,
                tags: [
                    [NostrTag.ROOT_EVENT, "brainstorm1"],
                    [NostrTag.EVENT, "response2"],
                ],
            });

            const conversation = createMockConversation([
                brainstormRoot,
                response1,
                response2,
                selection1,
                selection2,
            ]);

            const context = createMockContext(conversation, brainstormRoot);

            // Execute
            const messages = await strategy.buildMessages(context, brainstormRoot);

            // Assert
            const messageContent = messages.map((m) => m.content).join(" ");
            expect(messageContent).toContain("First response");
            expect(messageContent).toContain("Second response");
        });

        it("should handle brainstorms with no selections", async () => {
            // Setup
            const brainstormRoot = createMockEvent({
                id: "brainstorm1",
                pubkey: "user",
                kind: NostrKind.BRAINSTORM_REQUEST,
                content: "No selections",
                tags: [[NostrTag.MODE, TagValue.BRAINSTORM_MODE]],
            });

            const response = createMockEvent({
                id: "response1",
                pubkey: "agent1",
                kind: NostrKind.GENERIC_REPLY,
                content: "Unselected response",
                tags: [[NostrTag.ROOT_EVENT, "brainstorm1"]],
            });

            const conversation = createMockConversation([brainstormRoot, response]);
            const context = createMockContext(conversation, brainstormRoot);

            // Execute
            const messages = await strategy.buildMessages(context, brainstormRoot);

            // Assert
            const messageContent = messages.map((m) => m.content).join(" ");
            expect(messageContent).not.toContain("Unselected response");
            expect(messageContent).toContain("No selections"); // Root prompt should be included
        });

        it("should handle multiple brainstorm rounds", async () => {
            // Setup
            const brainstorm1 = createMockEvent({
                id: "brainstorm1",
                pubkey: "user",
                kind: NostrKind.BRAINSTORM_REQUEST,
                content: "First brainstorm",
                tags: [[NostrTag.MODE, TagValue.BRAINSTORM_MODE]],
            });

            const response1 = createMockEvent({
                id: "response1",
                pubkey: "agent1",
                kind: NostrKind.GENERIC_REPLY,
                content: "First round response",
                tags: [[NostrTag.ROOT_EVENT, "brainstorm1"]],
            });

            const selection1 = createMockEvent({
                id: "selection1",
                pubkey: "moderator",
                kind: NostrKind.REACTION,
                content: TagValue.REACTION_POSITIVE,
                tags: [
                    [NostrTag.ROOT_EVENT, "brainstorm1"],
                    [NostrTag.EVENT, "response1"],
                ],
            });

            const brainstorm2 = createMockEvent({
                id: "brainstorm2",
                pubkey: "user",
                kind: NostrKind.BRAINSTORM_REQUEST,
                content: "Second brainstorm",
                tags: [[NostrTag.MODE, TagValue.BRAINSTORM_MODE]],
            });

            const response2 = createMockEvent({
                id: "response2",
                pubkey: "agent2",
                kind: NostrKind.GENERIC_REPLY,
                content: "Second round response",
                tags: [[NostrTag.ROOT_EVENT, "brainstorm2"]],
            });

            const selection2 = createMockEvent({
                id: "selection2",
                pubkey: "moderator",
                kind: NostrKind.REACTION,
                content: TagValue.REACTION_POSITIVE,
                tags: [
                    [NostrTag.ROOT_EVENT, "brainstorm2"],
                    [NostrTag.EVENT, "response2"],
                ],
            });

            const conversation = createMockConversation([
                brainstorm1,
                response1,
                selection1,
                brainstorm2,
                response2,
                selection2,
            ]);

            const context = createMockContext(conversation, brainstorm2);

            // Execute
            const messages = await strategy.buildMessages(context, brainstorm2);

            // Assert
            const messageContent = messages.map((m) => m.content).join(" ");
            expect(messageContent).toContain("First round response");
            expect(messageContent).toContain("Second round response");
        });

        it("should exclude responses with negative reactions", async () => {
            // Setup
            const brainstormRoot = createMockEvent({
                id: "brainstorm1",
                pubkey: "user",
                kind: NostrKind.BRAINSTORM_REQUEST,
                content: "Test brainstorm",
                tags: [[NostrTag.MODE, TagValue.BRAINSTORM_MODE]],
            });

            const response = createMockEvent({
                id: "response1",
                pubkey: "agent1",
                kind: NostrKind.GENERIC_REPLY,
                content: "Rejected response",
                tags: [[NostrTag.ROOT_EVENT, "brainstorm1"]],
            });

            // Negative reaction
            const rejection = createMockEvent({
                id: "rejection1",
                pubkey: "moderator",
                kind: NostrKind.REACTION,
                content: "-", // Negative reaction
                tags: [
                    [NostrTag.ROOT_EVENT, "brainstorm1"],
                    [NostrTag.EVENT, "response1"],
                ],
            });

            const conversation = createMockConversation([brainstormRoot, response, rejection]);

            const context = createMockContext(conversation, brainstormRoot);

            // Execute
            const messages = await strategy.buildMessages(context, brainstormRoot);

            // Assert
            const messageContent = messages.map((m) => m.content).join(" ");
            expect(messageContent).not.toContain("Rejected response");
        });
    });
});
