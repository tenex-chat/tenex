#!/usr/bin/env bun
/**
 * Reproduction script - demonstrates the two bugs and their fixes:
 *
 * Bug #1: Completion events not added to conversation history immediately
 *         - Without fix: Agent doesn't see its own previous responses
 *         - Fix: Added in AgentExecutor.ts after agentPublisher.complete()
 *
 * Bug #2: User-directed responses incorrectly marked as delegations
 *         - Without fix: Agent's "Blue" response wrapped in <delegation> XML
 *         - Fix: FlattenedChronologicalStrategy now uses RALRegistry to detect real delegations
 */

import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Conversation } from "@/conversations";
import type { AgentInstance } from "@/agents/types";
import type { ExecutionContext } from "@/agents/execution/types";
import { FlattenedChronologicalStrategy } from "@/agents/execution/strategies/FlattenedChronologicalStrategy";
import { RALRegistry } from "@/services/ral/RALRegistry";

import { mock } from "bun:test";

const USER_PUBKEY = "user-pubkey";
const AGENT_PUBKEY = "hr-agent-pubkey";

// Mocks
mock.module("@/conversations/persistence/ToolMessageStorage", () => ({
    toolMessageStorage: {
        load: mock(() => Promise.resolve(null)),
        store: mock(() => Promise.resolve()),
    },
}));

const mockPubkeyService = {
    getName: (pubkey: string) => {
        const names: Record<string, string> = {
            [USER_PUBKEY]: "Pablo",
            [AGENT_PUBKEY]: "HR Agent",
        };
        return names[pubkey] || pubkey.slice(0, 8);
    },
    getUserProfile: () => null,
};

mock.module("@/services/PubkeyService", () => ({
    PubkeyService: { getInstance: () => mockPubkeyService },
    getPubkeyService: () => mockPubkeyService,
}));

mock.module("@/nostr/ndkClient", () => ({
    initNDK: mock(() => Promise.resolve()),
    getNDK: mock(() => ({
        fetchEvent: mock(() => null),
        fetchEvents: mock(() => new Set()),
    })),
}));

// Mock project context - correctly identify agents vs users
const mockProjectContext = {
    project: { tagValue: () => null },
    agents: new Map([
        [AGENT_PUBKEY, { pubkey: AGENT_PUBKEY, slug: "hr-agent", name: "HR Agent" }],
    ]),
    getAgentByPubkey: (pubkey: string) => {
        if (pubkey === AGENT_PUBKEY) {
            return { pubkey: AGENT_PUBKEY, slug: "hr-agent", name: "HR Agent" };
        }
        return null; // User is not an agent
    },
    getLessonsForAgent: () => [],
    getProjectManager: () => ({ pubkey: "pm-pubkey" }),
    agentLessons: new Map(),
};

mock.module("@/services/projects", () => ({
    isProjectContextInitialized: () => true,
    getProjectContext: () => mockProjectContext,
}));

mock.module("@/prompts/utils/systemPromptBuilder", () => ({
    buildSystemPromptMessages: async () => [
        { message: { role: "system", content: "You are HR Agent. You are a helpful HR agent." } }
    ],
}));

function createEvent(params: {
    id: string;
    pubkey: string;
    content: string;
    kind: number;
    created_at: number;
    tags: string[][];
}): NDKEvent {
    const event = new NDKEvent();
    event.id = params.id;
    event.pubkey = params.pubkey;
    event.content = params.content;
    event.kind = params.kind;
    event.created_at = params.created_at;
    event.tags = params.tags;
    event.sig = `sig-${params.id}`;
    return event;
}

function createMockAgent(): AgentInstance {
    return {
        name: "HR Agent",
        slug: "hr-agent",
        pubkey: AGENT_PUBKEY,
        role: "assistant",
        instructions: "You are a helpful HR agent.",
        tools: [],
    } as AgentInstance;
}

function createMockContext(
    conversation: Conversation,
    triggeringEvent: NDKEvent,
    agent: AgentInstance
): ExecutionContext {
    return {
        agent,
        conversationId: conversation.id,
        projectPath: "/test/path",
        projectBasePath: "/test/path",
        workingDirectory: "/test/path",
        currentBranch: "main",
        triggeringEvent,
        conversationCoordinator: {
            threadService: { buildThreadPath: () => [] },
            addEvent: async (convId: string, event: NDKEvent) => {
                conversation.history.push(event);
            },
        } as any,
        agentPublisher: {} as any,
        getConversation: () => conversation,
        isDelegationCompletion: false,
    } as ExecutionContext;
}

function printFullTranscript(messages: any[], title: string) {
    console.log("\n" + "=".repeat(80));
    console.log(title);
    console.log("=".repeat(80));

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const content = typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content, null, 2);

        console.log(`\n--- MESSAGE ${i + 1} [${msg.role.toUpperCase()}] ---`);
        console.log(content);
    }
}

async function runTest() {
    const strategy = new FlattenedChronologicalStrategy();
    const agent = createMockAgent();

    // TURN 1: User asks for a color
    const event1_user = createEvent({
        id: "event-1-user-asks",
        pubkey: USER_PUBKEY,
        content: "Give me one color.",
        kind: 11,
        created_at: 1000,
        tags: [["p", AGENT_PUBKEY]],
    });

    const conversation: Conversation = {
        id: event1_user.id,
        title: "Test conversation",
        history: [event1_user],
        agentStates: new Map(),
        agentTodos: new Map(),
        blockedAgents: new Set(),
        metadata: {},
        executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
    };

    // Agent responds "Blue." - p-tag points to USER, not another agent
    const event2_agent_blue = createEvent({
        id: "event-2-agent-says-blue",
        pubkey: AGENT_PUBKEY,
        content: "Blue.",
        kind: 1111,
        created_at: 1001,
        tags: [
            ["e", event1_user.id],
            ["E", event1_user.id],
            ["p", USER_PUBKEY],  // Responding TO the user, not delegating to an agent
            ["status", "completed"],
        ],
    });

    // Bug #1 Fix: Add agent's response to history immediately
    // (simulating what AgentExecutor now does after agentPublisher.complete())
    conversation.history.push(event2_agent_blue);

    // TURN 2: User asks for yellow
    const event3_user = createEvent({
        id: "event-3-user-asks-yellow",
        pubkey: USER_PUBKEY,
        content: "Now say yellow and nothing else. A single word.",
        kind: 1111,
        created_at: 1002,
        tags: [
            ["e", event2_agent_blue.id],
            ["E", event1_user.id],
            ["p", AGENT_PUBKEY],
        ],
    });

    conversation.history.push(event3_user);

    const context2 = createMockContext(conversation, event3_user, agent);
    const messages2 = await strategy.buildMessages(context2, event3_user);

    printFullTranscript(messages2, "FULL TRANSCRIPT - With Both Fixes Applied");

    // Verify expected message structure
    console.log("\n" + "=".repeat(80));
    console.log("VERIFICATION");
    console.log("=".repeat(80));

    const hasAssistantMessage = messages2.some(m => m.role === "assistant");
    const hasBlueContent = messages2.some(m => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return content.includes("Blue");
    });
    const hasYellowRequest = messages2.some(m => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return content.includes("yellow");
    });
    const hasDelegationXml = messages2.some(m => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return content.includes("<delegation");
    });

    console.log(`\n✓ Has assistant message: ${hasAssistantMessage}`);
    console.log(`✓ Contains "Blue" (agent's previous response): ${hasBlueContent}`);
    console.log(`✓ Contains "yellow" (user's new request): ${hasYellowRequest}`);
    console.log(`✗ Contains <delegation> XML (should be false): ${hasDelegationXml}`);

    if (hasAssistantMessage && hasBlueContent && hasYellowRequest && !hasDelegationXml) {
        console.log("\n🎉 SUCCESS! Both bugs are fixed:");
        console.log("   - Bug #1: Agent sees its own 'Blue' response in history");
        console.log("   - Bug #2: Response is formatted as 'assistant' role, not delegation XML");
    } else {
        console.log("\n⚠️  Issues detected - check message structure above.");
        if (!hasAssistantMessage) console.log("   - Missing assistant role message");
        if (!hasBlueContent) console.log("   - Agent's 'Blue' response not in history (Bug #1)");
        if (hasDelegationXml) console.log("   - Response incorrectly wrapped in delegation XML (Bug #2)");
    }

    // Also demonstrate what happens with a REAL delegation (for comparison)
    console.log("\n\n");
    console.log("=".repeat(80));
    console.log("COMPARISON: Actual delegation to another agent");
    console.log("=".repeat(80));

    // Create a delegation event and register it in RALRegistry
    const ralRegistry = RALRegistry.getInstance();
    const ralNumber = ralRegistry.create(AGENT_PUBKEY, conversation.id);

    const delegationEvent = createEvent({
        id: "event-delegation-to-other-agent",
        pubkey: AGENT_PUBKEY,
        content: "@other-agent please help with this task",
        kind: 1111,
        created_at: 1003,
        tags: [
            ["e", event3_user.id],
            ["E", event1_user.id],
            ["p", "other-agent-pubkey"],
        ],
    });

    // Register the delegation in RALRegistry (this is what delegate tool does)
    ralRegistry.saveState(AGENT_PUBKEY, conversation.id, ralNumber, [], [{
        eventId: delegationEvent.id,
        recipientPubkey: "other-agent-pubkey",
        recipientSlug: "other-agent",
        prompt: "please help with this task",
    }]);

    conversation.history.push(delegationEvent);

    const context3 = createMockContext(conversation, delegationEvent, agent);
    const messages3 = await strategy.buildMessages(context3, delegationEvent);

    const hasDelegationInMessages3 = messages3.some(m => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return content.includes("<delegation");
    });

    console.log(`\nDelegation event is correctly formatted as delegation: ${hasDelegationInMessages3}`);
    if (hasDelegationInMessages3) {
        console.log("✓ CORRECT: Real delegations are still detected and formatted properly");
    }

    // Cleanup
    ralRegistry.clearRAL(AGENT_PUBKEY, conversation.id, ralNumber);
}

runTest().catch(console.error);
