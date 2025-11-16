import { NDKEvent } from "@nostr-dev-kit/ndk";

export interface MockAgent {
    name: string;
    slug: string;
    pubkey: string;
    color: string; // for visualization
}

export interface MockEventData {
    id: string;
    pubkey: string;
    content: string;
    kind: number;
    created_at: number;
    tags: string[][];
    sig?: string;
}

export const MOCK_AGENTS: Record<string, MockAgent> = {
    user: {
        name: "User",
        slug: "user",
        pubkey: "user-pubkey-123",
        color: "#4CAF50",
    },
    alice: {
        name: "Alice (PM)",
        slug: "alice-pm",
        pubkey: "alice-pubkey-456",
        color: "#2196F3",
    },
    bob: {
        name: "Bob (Developer)",
        slug: "bob-dev",
        pubkey: "bob-pubkey-789",
        color: "#FF9800",
    },
    charlie: {
        name: "Charlie (Reviewer)",
        slug: "charlie-review",
        pubkey: "charlie-pubkey-abc",
        color: "#9C27B0",
    },
    diana: {
        name: "Diana (Tester)",
        slug: "diana-test",
        pubkey: "diana-pubkey-def",
        color: "#F44336",
    },
};

export class MockEventGenerator {
    private eventCounter = 1000;
    private idCounter = 1;

    generateId(): string {
        return `event-${this.idCounter++}-${Math.random().toString(36).substring(7)}`;
    }

    generateSignature(): string {
        return `sig-${Math.random().toString(36).substring(2, 15)}`;
    }

    createEvent(data: Partial<MockEventData>): NDKEvent {
        const event = new NDKEvent();
        event.id = data.id || this.generateId();
        event.pubkey = data.pubkey || MOCK_AGENTS.user.pubkey;
        event.content = data.content || "";
        event.kind = data.kind || 11;
        event.created_at = data.created_at || this.eventCounter++;
        event.tags = data.tags || [];
        event.sig = data.sig || this.generateSignature();
        return event;
    }

    /**
     * Scenario 1: Complex Multi-Level Threading
     *
     * Structure:
     * Root: User announces project
     *   ├─ Alice (PM) creates tasks [ROOT-LEVEL SIBLING]
     *   │   └─ Bob starts implementation [DEPTH 3]
     *   │       └─ Charlie reviews Bob's code [DEPTH 4]
     *   │           └─ Bob fixes issues [DEPTH 5]
     *   ├─ Diana starts testing [ROOT-LEVEL SIBLING]
     *   │   └─ Diana finds bugs [DEPTH 3]
     *   └─ Public broadcast: "Team meeting at 3pm" [ROOT-LEVEL SIBLING]
     */
    generateComplexThreadingScenario(): NDKEvent[] {
        const events: NDKEvent[] = [];

        // Root: User announces project
        const root = this.createEvent({
            id: "root-announce",
            pubkey: MOCK_AGENTS.user.pubkey,
            content: "🚀 Starting new feature: Dark Mode implementation",
            kind: 11,
        });
        events.push(root);

        // Branch 1: Alice creates tasks (ROOT-LEVEL)
        const aliceTask = this.createEvent({
            id: "alice-tasks",
            pubkey: MOCK_AGENTS.alice.pubkey,
            content: "@bob please implement the dark mode toggle in settings",
            kind: 1111,
            tags: [
                ["e", root.id],
                ["E", root.id],
                ["p", MOCK_AGENTS.bob.pubkey],
            ],
        });
        events.push(aliceTask);

        // Bob starts implementation (DEPTH 3)
        const bobImpl = this.createEvent({
            id: "bob-implementation",
            pubkey: MOCK_AGENTS.bob.pubkey,
            content: "Working on it! I'll add the toggle to the settings panel",
            kind: 1111,
            tags: [
                ["e", aliceTask.id],
                ["E", root.id],
                ["p", MOCK_AGENTS.alice.pubkey],
            ],
        });
        events.push(bobImpl);

        // Charlie reviews Bob's code (DEPTH 4)
        const charlieReview = this.createEvent({
            id: "charlie-review",
            pubkey: MOCK_AGENTS.charlie.pubkey,
            content: "@bob Your implementation looks good but needs accessibility attributes",
            kind: 1111,
            tags: [
                ["e", bobImpl.id],
                ["E", root.id],
                ["p", MOCK_AGENTS.bob.pubkey],
            ],
        });
        events.push(charlieReview);

        // Bob fixes issues (DEPTH 5)
        const bobFix = this.createEvent({
            id: "bob-fix",
            pubkey: MOCK_AGENTS.bob.pubkey,
            content: "Added aria-labels and keyboard navigation support",
            kind: 1111,
            tags: [
                ["e", charlieReview.id],
                ["E", root.id],
                ["p", MOCK_AGENTS.charlie.pubkey],
            ],
        });
        events.push(bobFix);

        // Branch 2: Diana starts testing (ROOT-LEVEL)
        const dianaTest = this.createEvent({
            id: "diana-testing",
            pubkey: MOCK_AGENTS.diana.pubkey,
            content: "@team I'll start testing the dark mode feature",
            kind: 1111,
            tags: [
                ["e", root.id],
                ["E", root.id],
            ],
        });
        events.push(dianaTest);

        // Diana finds bugs (DEPTH 3)
        const dianaBugs = this.createEvent({
            id: "diana-bugs",
            pubkey: MOCK_AGENTS.diana.pubkey,
            content: "Found an issue: Charts don't update colors in dark mode",
            kind: 1111,
            tags: [
                ["e", dianaTest.id],
                ["E", root.id],
                ["p", MOCK_AGENTS.bob.pubkey],
            ],
        });
        events.push(dianaBugs);

        // Public broadcast (ROOT-LEVEL)
        const broadcast = this.createEvent({
            id: "public-broadcast",
            pubkey: MOCK_AGENTS.user.pubkey,
            content: "📢 Team meeting at 3pm to discuss dark mode progress",
            kind: 1111,
            tags: [
                ["e", root.id],
                ["E", root.id],
                // No p-tags = public broadcast
            ],
        });
        events.push(broadcast);

        return events;
    }

    /**
     * Scenario 2: Parallel Root-Level Collaboration
     *
     * All agents responding at root level should see each other's messages
     */
    generateRootCollaborationScenario(): NDKEvent[] {
        const events: NDKEvent[] = [];

        // Root: User asks for help
        const root = this.createEvent({
            id: "root-help",
            pubkey: MOCK_AGENTS.user.pubkey,
            content: "Need help optimizing our database queries",
            kind: 11,
        });
        events.push(root);

        // Alice responds at root level
        const aliceResponse = this.createEvent({
            id: "alice-root-response",
            pubkey: MOCK_AGENTS.alice.pubkey,
            content: "I suggest we add proper indexes first",
            kind: 1111,
            tags: [
                ["e", root.id],
                ["E", root.id],
                ["p", MOCK_AGENTS.user.pubkey],
            ],
        });
        events.push(aliceResponse);

        // Bob responds at root level
        const bobResponse = this.createEvent({
            id: "bob-root-response",
            pubkey: MOCK_AGENTS.bob.pubkey,
            content: "We should also consider query caching",
            kind: 1111,
            tags: [
                ["e", root.id],
                ["E", root.id],
                ["p", MOCK_AGENTS.user.pubkey],
            ],
        });
        events.push(bobResponse);

        // Charlie responds at root level
        const charlieResponse = this.createEvent({
            id: "charlie-root-response",
            pubkey: MOCK_AGENTS.charlie.pubkey,
            content: "Don't forget about connection pooling",
            kind: 1111,
            tags: [
                ["e", root.id],
                ["E", root.id],
                ["p", MOCK_AGENTS.user.pubkey],
            ],
        });
        events.push(charlieResponse);

        // Diana responds at root level
        const dianaResponse = this.createEvent({
            id: "diana-root-response",
            pubkey: MOCK_AGENTS.diana.pubkey,
            content: "I can benchmark the before/after performance",
            kind: 1111,
            tags: [
                ["e", root.id],
                ["E", root.id],
                ["p", MOCK_AGENTS.user.pubkey],
            ],
        });
        events.push(dianaResponse);

        return events;
    }

    /**
     * Scenario 3: Delegation Chain
     *
     * PM delegates to Developer, who delegates to Tester
     */
    generateDelegationScenario(): NDKEvent[] {
        const events: NDKEvent[] = [];

        // Root: User requests feature
        const root = this.createEvent({
            id: "root-feature-request",
            pubkey: MOCK_AGENTS.user.pubkey,
            content: "We need user authentication with OAuth",
            kind: 11,
        });
        events.push(root);

        // Alice (PM) takes charge
        const aliceResponse = this.createEvent({
            id: "alice-pm-response",
            pubkey: MOCK_AGENTS.alice.pubkey,
            content: "I'll coordinate this. @bob can you implement OAuth?",
            kind: 1111,
            tags: [
                ["e", root.id],
                ["E", root.id],
                ["p", MOCK_AGENTS.bob.pubkey],
                ["delegation-request", ""],
            ],
        });
        events.push(aliceResponse);

        // Bob accepts delegation
        const bobAccepts = this.createEvent({
            id: "bob-accepts-delegation",
            pubkey: MOCK_AGENTS.bob.pubkey,
            content: "Starting OAuth implementation now",
            kind: 1111,
            tags: [
                ["e", aliceResponse.id],
                ["E", root.id],
                ["p", MOCK_AGENTS.alice.pubkey],
            ],
        });
        events.push(bobAccepts);

        // Bob delegates testing to Diana
        const bobDelegates = this.createEvent({
            id: "bob-delegates-testing",
            pubkey: MOCK_AGENTS.bob.pubkey,
            content: "@diana can you test the OAuth flow?",
            kind: 1111,
            tags: [
                ["e", bobAccepts.id],
                ["E", root.id],
                ["p", MOCK_AGENTS.diana.pubkey],
                ["delegation-request", ""],
            ],
        });
        events.push(bobDelegates);

        // Diana completes testing
        const dianaComplete = this.createEvent({
            id: "diana-testing-complete",
            pubkey: MOCK_AGENTS.diana.pubkey,
            content: "OAuth testing complete - all flows working",
            kind: 1111,
            tags: [
                ["e", bobDelegates.id],
                ["E", root.id],
                ["p", MOCK_AGENTS.bob.pubkey],
                ["status", "completed"],
            ],
        });
        events.push(dianaComplete);

        // Bob reports back to Alice
        const bobReports = this.createEvent({
            id: "bob-reports-complete",
            pubkey: MOCK_AGENTS.bob.pubkey,
            content: "OAuth implementation complete and tested",
            kind: 1111,
            tags: [
                ["e", aliceResponse.id],
                ["E", root.id],
                ["p", MOCK_AGENTS.alice.pubkey],
                ["status", "completed"],
            ],
        });
        events.push(bobReports);

        return events;
    }

    /**
     * Generate all scenarios
     */
    generateAllScenarios(): Record<string, NDKEvent[]> {
        return {
            complexThreading: this.generateComplexThreadingScenario(),
            rootCollaboration: this.generateRootCollaborationScenario(),
            delegation: this.generateDelegationScenario(),
        };
    }
}

// Export for use in tests
export function createMockEvents(scenario: string): NDKEvent[] {
    const generator = new MockEventGenerator();
    const scenarios = generator.generateAllScenarios();
    return scenarios[scenario] || [];
}
