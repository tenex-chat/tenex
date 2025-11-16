import type { AgentInstance } from "@/agents/types";
import NDK, { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

export interface SignedAgent {
    agent: AgentInstance;
    signer: NDKPrivateKeySigner;
}

export interface SignedConversation {
    name: string;
    description: string;
    events: NDKEvent[];
    agents: SignedAgent[];
    user: { pubkey: string; signer: NDKPrivateKeySigner };
}

/**
 * Generate real signed Nostr events for testing threading strategies
 */
export class SignedEventGenerator {
    private ndk: NDK;

    constructor() {
        this.ndk = new NDK();
    }

    /**
     * Create a signed agent with real keys
     */
    async createAgent(name: string, slug: string, role: string): Promise<SignedAgent> {
        const signer = NDKPrivateKeySigner.generate();
        const user = await signer.user();

        const agent: AgentInstance = {
            name,
            slug,
            pubkey: user.pubkey,
            role,
            instructions: `I am ${name}, a ${role}`,
            tools: [],
        };

        return { agent, signer };
    }

    /**
     * Create user with real keys
     */
    async createUser(): Promise<{ pubkey: string; signer: NDKPrivateKeySigner }> {
        const signer = NDKPrivateKeySigner.generate();
        const user = await signer.user();
        return { pubkey: user.pubkey, signer };
    }

    /**
     * Create and sign a conversation root event
     */
    async createConversationRoot(
        content: string,
        userSigner: NDKPrivateKeySigner,
        projectId: string
    ): Promise<NDKEvent> {
        const event = new NDKEvent(this.ndk);
        event.kind = 11; // Conversation root
        event.content = content;
        event.tags = [
            ["title", content],
            ["a", `31933:${(await userSigner.user()).pubkey}:${projectId}`],
        ];

        await event.sign(userSigner);
        return event;
    }

    /**
     * Create a user reply targeting an agent
     */
    async createUserReply(
        content: string,
        parentEvent: NDKEvent,
        rootEvent: NDKEvent,
        targetAgent: SignedAgent,
        userSigner: NDKPrivateKeySigner
    ): Promise<NDKEvent> {
        const event = new NDKEvent(this.ndk);
        event.kind = 1111; // Generic reply
        event.content = content;
        event.tags = [
            ["e", parentEvent.id!, "", ""],
            ["E", rootEvent.id!, "", ""],
            ["p", targetAgent.agent.pubkey],
            ["K", String(rootEvent.kind)],
            ["P", (await userSigner.user()).pubkey],
        ];

        await event.sign(userSigner);
        return event;
    }

    /**
     * Create an agent delegation request
     * (Simplified version - not using AgentEventEncoder to avoid NDK initialization)
     */
    async createDelegation(
        fromAgent: SignedAgent,
        toAgent: SignedAgent,
        request: string,
        parentEvent: NDKEvent,
        rootEvent: NDKEvent,
        conversationId: string
    ): Promise<NDKEvent> {
        const event = new NDKEvent(this.ndk);
        event.kind = 1111;
        event.content = `@${toAgent.agent.slug} ${request}`;
        event.tags = [
            ["e", parentEvent.id!, "", ""],
            ["E", rootEvent.id!, "", ""],
            ["p", toAgent.agent.pubkey],
            ["K", String(rootEvent.kind)],
            ["P", fromAgent.agent.pubkey],
            ["phase", "EXECUTE"],
            ["delegation-request", ""],
        ];

        await event.sign(fromAgent.signer);
        return event;
    }

    /**
     * Create an agent response
     */
    async createAgentResponse(
        agent: SignedAgent,
        content: string,
        parentEvent: NDKEvent,
        rootEvent: NDKEvent,
        targetPubkey?: string,
        isCompletion = false
    ): Promise<NDKEvent> {
        const event = new NDKEvent(this.ndk);
        event.kind = 1111;
        event.content = content;

        const tags = [
            ["e", parentEvent.id!, "", ""],
            ["E", rootEvent.id!, "", ""],
            ["K", String(rootEvent.kind)],
            ["P", agent.agent.pubkey],
        ];

        if (targetPubkey) {
            tags.push(["p", targetPubkey]);
        }

        if (isCompletion) {
            tags.push(["status", "completed"]);
        }

        event.tags = tags;
        await event.sign(agent.signer);
        return event;
    }

    /**
     * Scenario 1: Complex Multi-Level Threading
     *
     * Root: User requests dark mode feature
     *   ├─ Alice (PM) delegates to Bob
     *   │   └─ Bob implements
     *   │       └─ Charlie reviews
     *   │           └─ Bob fixes
     *   │               └─ Bob reports completion to Alice
     *   └─ Diana (Tester) starts testing (parallel branch)
     *       └─ Diana finds bugs
     */
    async generateComplexThreading(): Promise<SignedConversation> {
        const user = await this.createUser();
        const alice = await this.createAgent("Alice", "alice-pm", "project-manager");
        const bob = await this.createAgent("Bob", "bob-dev", "developer");
        const charlie = await this.createAgent("Charlie", "charlie-review", "reviewer");
        const diana = await this.createAgent("Diana", "diana-test", "tester");

        const events: NDKEvent[] = [];
        const projectId = "TENEX-Dark-Mode-123";

        // Root: User requests feature
        const root = await this.createConversationRoot(
            "🚀 We need to implement dark mode for the application",
            user.signer,
            projectId
        );
        events.push(root);

        // Branch 1: Alice takes charge
        const aliceResponse = await this.createUserReply(
            "@alice can you coordinate the dark mode implementation?",
            root,
            root,
            alice,
            user.signer
        );
        events.push(aliceResponse);

        // Alice delegates to Bob
        const aliceDelegation = await this.createDelegation(
            alice,
            bob,
            "Implement dark mode toggle in settings panel with proper state management",
            aliceResponse,
            root,
            root.id!
        );
        events.push(aliceDelegation);

        // Bob accepts and starts working
        const bobAccepts = await this.createAgentResponse(
            bob,
            "Starting dark mode implementation. I'll add:\n1. Theme context\n2. Toggle component\n3. CSS variables for colors",
            aliceDelegation,
            root,
            alice.agent.pubkey
        );
        events.push(bobAccepts);

        // Bob's implementation progress
        const bobImpl = await this.createAgentResponse(
            bob,
            "Implementation complete! Added theme toggle with localStorage persistence.",
            bobAccepts,
            root,
            alice.agent.pubkey
        );
        events.push(bobImpl);

        // Charlie reviews Bob's code
        const charlieReview = await this.createAgentResponse(
            charlie,
            "@bob Great work! But I noticed:\n- Missing aria-labels for accessibility\n- Need keyboard navigation (Tab key support)\nPlease fix these issues.",
            bobImpl,
            root,
            bob.agent.pubkey
        );
        events.push(charlieReview);

        // Bob fixes issues
        const bobFixes = await this.createAgentResponse(
            bob,
            '✅ Fixed accessibility issues:\n- Added aria-label="Toggle dark mode"\n- Implemented keyboard navigation\n- Tested with screen reader',
            charlieReview,
            root,
            charlie.agent.pubkey
        );
        events.push(bobFixes);

        // Bob reports completion back to Alice
        const bobCompletion = await this.createAgentResponse(
            bob,
            "Dark mode implementation complete and reviewed. All accessibility requirements met.",
            aliceDelegation,
            root,
            alice.agent.pubkey,
            true
        );
        events.push(bobCompletion);

        // Branch 2: Diana starts testing (parallel to Alice's branch)
        const dianaStarts = await this.createUserReply(
            "@diana please test the dark mode feature",
            root,
            root,
            diana,
            user.signer
        );
        events.push(dianaStarts);

        // Diana finds issues
        const dianaBugs = await this.createAgentResponse(
            diana,
            "🐛 Found issues during testing:\n1. Charts don't update colors in dark mode\n2. Modal backgrounds are wrong\n@bob can you fix these?",
            dianaStarts,
            root,
            bob.agent.pubkey
        );
        events.push(dianaBugs);

        return {
            name: "Complex Threading",
            description: "Multi-level delegation with code review and parallel testing branch",
            events,
            agents: [alice, bob, charlie, diana],
            user,
        };
    }

    /**
     * Scenario 2: Root-Level Collaboration
     *
     * All agents respond at root level - should see each other's contributions
     */
    async generateRootCollaboration(): Promise<SignedConversation> {
        const user = await this.createUser();
        const alice = await this.createAgent("Alice", "alice-architect", "architect");
        const bob = await this.createAgent("Bob", "bob-backend", "backend-dev");
        const charlie = await this.createAgent("Charlie", "charlie-frontend", "frontend-dev");
        const diana = await this.createAgent("Diana", "diana-dba", "database-admin");

        const events: NDKEvent[] = [];
        const projectId = "TENEX-Perf-Optimization";

        // Root: User asks for help
        const root = await this.createConversationRoot(
            "Our database queries are slow. How can we optimize performance?",
            user.signer,
            projectId
        );
        events.push(root);

        // Alice responds at root level
        const aliceResponse = await this.createAgentResponse(
            alice,
            "From an architecture perspective, we should:\n1. Add proper indexes\n2. Implement query result caching\n3. Consider read replicas",
            root,
            root,
            user.pubkey
        );
        events.push(aliceResponse);

        // Bob responds at root level
        const bobResponse = await this.createAgentResponse(
            bob,
            "I can implement connection pooling to reduce connection overhead. Also, we should batch similar queries.",
            root,
            root,
            user.pubkey
        );
        events.push(bobResponse);

        // Charlie responds at root level
        const charlieResponse = await this.createAgentResponse(
            charlie,
            "On the frontend, I'll add pagination and virtual scrolling to reduce data fetching.",
            root,
            root,
            user.pubkey
        );
        events.push(charlieResponse);

        // Diana responds at root level
        const dianaResponse = await this.createAgentResponse(
            diana,
            "I'll analyze the slow queries and create optimized indexes. Can also set up query performance monitoring.",
            root,
            root,
            user.pubkey
        );
        events.push(dianaResponse);

        return {
            name: "Root Collaboration",
            description:
                "All agents respond at root level - should see each other (collaborative discussion)",
            events,
            agents: [alice, bob, charlie, diana],
            user,
        };
    }

    /**
     * Scenario 3: Deep Delegation Chain
     *
     * PM → Developer → Code Reviewer → Tester
     */
    async generateDelegationChain(): Promise<SignedConversation> {
        const user = await this.createUser();
        const pm = await this.createAgent("PM", "pm", "project-manager");
        const dev = await this.createAgent("Dev", "dev", "developer");
        const reviewer = await this.createAgent("Reviewer", "reviewer", "code-reviewer");
        const tester = await this.createAgent("Tester", "tester", "qa-tester");

        const events: NDKEvent[] = [];
        const projectId = "TENEX-OAuth-Feature";

        // Root: User requests OAuth
        const root = await this.createConversationRoot(
            "We need OAuth authentication with Google and GitHub",
            user.signer,
            projectId
        );
        events.push(root);

        // PM takes ownership
        const pmResponse = await this.createUserReply(
            "@pm can you coordinate this?",
            root,
            root,
            pm,
            user.signer
        );
        events.push(pmResponse);

        // PM delegates to Developer
        const pmToDev = await this.createDelegation(
            pm,
            dev,
            "Implement OAuth integration with Google and GitHub providers",
            pmResponse,
            root,
            root.id!
        );
        events.push(pmToDev);

        // Dev starts working
        const devStarts = await this.createAgentResponse(
            dev,
            "Starting OAuth implementation using Passport.js strategy...",
            pmToDev,
            root,
            pm.agent.pubkey
        );
        events.push(devStarts);

        // Dev delegates review to Reviewer
        const devToReviewer = await this.createDelegation(
            dev,
            reviewer,
            "Please review OAuth implementation for security best practices",
            devStarts,
            root,
            root.id!
        );
        events.push(devToReviewer);

        // Reviewer reviews
        const reviewerFeedback = await this.createAgentResponse(
            reviewer,
            "Code review complete:\n✅ PKCE flow implemented\n✅ State parameter validation\n⚠️  Need to add CSRF protection\n⚠️  Should rotate refresh tokens",
            devToReviewer,
            root,
            dev.agent.pubkey
        );
        events.push(reviewerFeedback);

        // Dev fixes and delegates to Tester
        const devFixed = await this.createAgentResponse(
            dev,
            "Fixed security issues. Ready for testing.",
            reviewerFeedback,
            root,
            reviewer.agent.pubkey
        );
        events.push(devFixed);

        const devToTester = await this.createDelegation(
            dev,
            tester,
            "Test OAuth flows for both Google and GitHub",
            devFixed,
            root,
            root.id!
        );
        events.push(devToTester);

        // Tester tests
        const testerResult = await this.createAgentResponse(
            tester,
            "✅ Testing complete:\n- Google OAuth: Working\n- GitHub OAuth: Working\n- Token refresh: Working\n- Error handling: Working",
            devToTester,
            root,
            dev.agent.pubkey,
            true
        );
        events.push(testerResult);

        // Dev reports back to PM
        const devToPM = await this.createAgentResponse(
            dev,
            "OAuth implementation complete, reviewed, and tested successfully.",
            pmToDev,
            root,
            pm.agent.pubkey,
            true
        );
        events.push(devToPM);

        return {
            name: "Delegation Chain",
            description: "Deep delegation chain: PM → Dev → Reviewer → Tester",
            events,
            agents: [pm, dev, reviewer, tester],
            user,
        };
    }

    /**
     * Generate all scenarios
     */
    async generateAllScenarios(): Promise<SignedConversation[]> {
        return Promise.all([
            this.generateComplexThreading(),
            this.generateRootCollaboration(),
            this.generateDelegationChain(),
        ]);
    }
}
