import { describe, it, expect, beforeEach, mock } from "bun:test";
import { ConversationManager } from "../ConversationManager";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import * as services from "@/services";
import type { AgentInstance } from "@/agents/types";
import { PHASES } from "../phases";
import os from "os";
import path from "path";

// Mock getProjectContext
mock.module("@/services", () => ({
    getProjectContext: () => ({
        agents: new Map([
            ["orchestrator", {
                slug: "orchestrator",
                pubkey: "orch-pubkey",
                name: "Orchestrator",
                isOrchestrator: true,
                llmConfig: "orchestrator"
            } as Agent],
            ["planner", {
                slug: "planner",
                pubkey: "planner-pubkey",
                name: "Planner",
                llmConfig: "default"
            } as Agent],
            ["developer", {
                slug: "developer",
                pubkey: "dev-pubkey",
                name: "Developer",
                llmConfig: "default"
            } as Agent],
            ["project-manager", {
                slug: "project-manager",
                pubkey: "pm-pubkey",
                name: "Project Manager",
                llmConfig: "default"
            } as Agent]
        ]),
        project: { path: "/test" }
    })
}));

describe("Orchestrator Routing Context", () => {
    let manager: ConversationManager;
    let tempDir: string;

    beforeEach(async () => {
        // Use a temp directory for tests
        tempDir = path.join(os.tmpdir(), `tenex-test-${Date.now()}`);
        manager = new ConversationManager(tempDir);
        await manager.initialize();
    });

    describe("Empty conversation", () => {
        it("should return empty phase history for new conversation", async () => {
            const userEvent: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "Build a login page",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent);
            const routingContext = await manager.buildOrchestratorRoutingContext(
                conversation.id,
                userEvent
            );

            expect(routingContext.initial_request).toBe("Build a login page");
            expect(routingContext.phase_history).toHaveLength(1);
            expect(routingContext.phase_history[0]).toEqual({
                phase: PHASES.CHAT,
                agents: [],
                last_messages: [{
                    agent: "user",
                    message: "Build a login page"
                }],
                result: null,
                reason: null,
                isCurrent: true
            });
        });
    });

    describe("Single phase conversation", () => {
        it("should show completed phase with result", async () => {
            const userEvent: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "Build a login page",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent);
            
            // Planner responds
            const plannerResponse: NDKEvent = {
                id: "event-2",
                pubkey: "planner-pubkey",
                content: "Here's the implementation plan:\n1. Create login component\n2. Add authentication",
                tags: [["p", "planner-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, plannerResponse);

            // Planner completes phase
            await manager.updatePhase(
                conversation.id,
                PHASES.EXECUTE,
                "Planning complete, ready for implementation",
                "Plan created for login page implementation"
            );

            const routingContext = await manager.buildOrchestratorRoutingContext(
                conversation.id
            );

            expect(routingContext.initial_request).toBe("Build a login page");
            expect(routingContext.phase_history).toHaveLength(2);
            
            // Check completed phase
            expect(routingContext.phase_history[0].phase).toBe(PHASES.PLAN);
            expect(routingContext.phase_history[0].result).toContain("Plan created");
            expect(routingContext.phase_history[0].isCurrent).toBeUndefined();
            
            // Check current phase
            expect(routingContext.phase_history[1].phase).toBe(PHASES.EXECUTE);
            expect(routingContext.phase_history[1].isCurrent).toBe(true);
        });
    });

    describe("Multi-phase conversation", () => {
        it("should track full phase history", async () => {
            const userEvent: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "Fix the authentication bug",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent);
            
            // Phase 1: Chat
            const pmResponse: NDKEvent = {
                id: "event-2",
                pubkey: "pm-pubkey",
                content: "I understand you need the authentication bug fixed",
                tags: [["p", "pm-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, pmResponse);
            
            await manager.updatePhase(
                conversation.id,
                PHASES.EXECUTE,
                "Requirements clear",
                "Bug identified in auth flow"
            );

            // Phase 2: Execute
            const devResponse: NDKEvent = {
                id: "event-3",
                pubkey: "dev-pubkey",
                content: "Fixed the JWT validation issue",
                tags: [["p", "dev-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, devResponse);
            
            await manager.updatePhase(
                conversation.id,
                PHASES.VERIFICATION,
                "Fix implemented",
                "JWT validation corrected"
            );

            // Phase 3: Verification (current)
            const pmVerify: NDKEvent = {
                id: "event-4",
                pubkey: "pm-pubkey",
                content: "Testing the authentication flow",
                tags: [["p", "pm-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, pmVerify);

            const routingContext = await manager.buildOrchestratorRoutingContext(
                conversation.id
            );

            expect(routingContext.phase_history).toHaveLength(3);
            
            // Check phase progression
            expect(routingContext.phase_history[0].phase).toBe(PHASES.CHAT);
            expect(routingContext.phase_history[0].result).toContain("Bug identified");
            
            expect(routingContext.phase_history[1].phase).toBe(PHASES.EXECUTE);
            expect(routingContext.phase_history[1].result).toContain("JWT validation");
            
            expect(routingContext.phase_history[2].phase).toBe(PHASES.VERIFICATION);
            expect(routingContext.phase_history[2].isCurrent).toBe(true);
            expect(routingContext.phase_history[2].result).toBeNull();
        });
    });

    describe("Blocked state", () => {
        it("should show blocked status in current phase", async () => {
            const userEvent: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "Deploy to production",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent);
            
            // Developer encounters issue
            const devResponse: NDKEvent = {
                id: "event-2",
                pubkey: "dev-pubkey",
                content: "Cannot proceed - missing DATABASE_URL environment variable",
                tags: [["p", "dev-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, devResponse);

            const routingContext = await manager.buildOrchestratorRoutingContext(
                conversation.id
            );

            const currentPhase = routingContext.phase_history.find(p => p.isCurrent);
            expect(currentPhase).toBeDefined();
            expect(currentPhase?.last_messages).toContainEqual({
                agent: "developer",
                message: "Cannot proceed - missing DATABASE_URL environment variable"
            });
        });
    });

    describe("User interruption", () => {
        it("should include user messages in current phase", async () => {
            const userEvent1: NDKEvent = {
                id: "event-1",
                pubkey: "user-pubkey",
                content: "Build a dashboard",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;

            const conversation = await manager.createConversation(userEvent1);
            
            // Developer working
            const devResponse: NDKEvent = {
                id: "event-2",
                pubkey: "dev-pubkey",
                content: "Building the dashboard components",
                tags: [["p", "dev-pubkey"]],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, devResponse);

            // User interrupts
            const userEvent2: NDKEvent = {
                id: "event-3",
                pubkey: "user-pubkey",
                content: "Also add dark mode support",
                tags: [],
                created_at: Date.now() / 1000
            } as NDKEvent;
            await manager.addEvent(conversation.id, userEvent2);

            const routingContext = await manager.buildOrchestratorRoutingContext(
                conversation.id,
                userEvent2
            );

            const currentPhase = routingContext.phase_history.find(p => p.isCurrent);
            expect(currentPhase?.last_messages).toContainEqual({
                agent: "user",
                message: "Also add dark mode support"
            });
        });
    });
});