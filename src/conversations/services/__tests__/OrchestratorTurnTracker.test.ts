import { describe, it, expect, beforeEach } from "bun:test";
import { OrchestratorTurnTracker } from "../OrchestratorTurnTracker";
import { PHASES } from "@/conversations/phases";
import type { Completion } from "@/conversations/types";

describe("OrchestratorTurnTracker", () => {
    let tracker: OrchestratorTurnTracker;
    const conversationId = "conv1";

    beforeEach(() => {
        tracker = new OrchestratorTurnTracker();
    });

    describe("startTurn", () => {
        it("should create a new turn with unique ID", () => {
            const turnId1 = tracker.startTurn(conversationId, PHASES.CHAT, ["agent1"]);
            const turnId2 = tracker.startTurn(conversationId, PHASES.PLAN, ["agent2"]);

            expect(turnId1).toBeTruthy();
            expect(turnId2).toBeTruthy();
            expect(turnId1).not.toBe(turnId2);
        });

        it("should initialize turn with correct properties", () => {
            const turnId = tracker.startTurn(
                conversationId,
                PHASES.EXECUTE,
                ["agent1", "agent2"],
                "Test reason"
            );

            const turn = tracker.getCurrentTurn(conversationId);
            expect(turn).toBeTruthy();
            expect(turn?.turnId).toBe(turnId);
            expect(turn?.phase).toBe(PHASES.EXECUTE);
            expect(turn?.agents).toEqual(["agent1", "agent2"]);
            expect(turn?.reason).toBe("Test reason");
            expect(turn?.isCompleted).toBe(false);
            expect(turn?.completions).toEqual([]);
        });
    });

    describe("addCompletion", () => {
        it("should add completion to active turn", () => {
            tracker.startTurn(conversationId, PHASES.CHAT, ["agent1"]);
            tracker.addCompletion(conversationId, "agent1", "Test response");

            const turn = tracker.getCurrentTurn(conversationId);
            expect(turn?.completions).toHaveLength(1);
            expect(turn?.completions[0]).toEqual({
                agent: "agent1",
                message: "Test response",
                timestamp: expect.any(Number)
            });
        });

        it("should mark turn as completed when all agents complete", () => {
            tracker.startTurn(conversationId, PHASES.PLAN, ["agent1", "agent2"]);
            
            tracker.addCompletion(conversationId, "agent1", "Response 1");
            let turn = tracker.getCurrentTurn(conversationId);
            expect(turn?.isCompleted).toBe(false);

            tracker.addCompletion(conversationId, "agent2", "Response 2");
            turn = tracker.getCurrentTurn(conversationId);
            expect(turn?.isCompleted).toBe(true);
        });

        it("should not add completion to non-existent conversation", () => {
            tracker.addCompletion("nonexistent", "agent1", "Response");
            expect(tracker.getTurns("nonexistent")).toHaveLength(0);
        });

        it("should find correct turn for agent in multiple turns", () => {
            // First turn - complete it
            tracker.startTurn(conversationId, PHASES.CHAT, ["agent1"]);
            tracker.addCompletion(conversationId, "agent1", "Chat response");

            // Second turn - incomplete
            tracker.startTurn(conversationId, PHASES.PLAN, ["agent2"]);
            tracker.addCompletion(conversationId, "agent2", "Plan response");

            const turns = tracker.getTurns(conversationId);
            expect(turns).toHaveLength(2);
            expect(turns[0].completions[0].message).toBe("Chat response");
            expect(turns[1].completions[0].message).toBe("Plan response");
        });
    });

    describe("isCurrentTurnComplete", () => {
        it("should return true when no turns exist", () => {
            expect(tracker.isCurrentTurnComplete(conversationId)).toBe(true);
        });

        it("should return false when current turn is incomplete", () => {
            tracker.startTurn(conversationId, PHASES.CHAT, ["agent1"]);
            expect(tracker.isCurrentTurnComplete(conversationId)).toBe(false);
        });

        it("should return true when current turn is complete", () => {
            tracker.startTurn(conversationId, PHASES.CHAT, ["agent1"]);
            tracker.addCompletion(conversationId, "agent1", "Response");
            expect(tracker.isCurrentTurnComplete(conversationId)).toBe(true);
        });
    });

    describe("getCurrentTurn", () => {
        it("should return null when no turns exist", () => {
            expect(tracker.getCurrentTurn(conversationId)).toBeNull();
        });

        it("should return the most recent turn", () => {
            const turnId1 = tracker.startTurn(conversationId, PHASES.CHAT, ["agent1"]);
            const turnId2 = tracker.startTurn(conversationId, PHASES.PLAN, ["agent2"]);

            const current = tracker.getCurrentTurn(conversationId);
            expect(current?.turnId).toBe(turnId2);
            expect(current?.phase).toBe(PHASES.PLAN);
        });
    });

    describe("getRoutingHistory", () => {
        it("should return only completed turns", () => {
            // Complete turn
            tracker.startTurn(conversationId, PHASES.CHAT, ["agent1"]);
            tracker.addCompletion(conversationId, "agent1", "Response");

            // Incomplete turn
            tracker.startTurn(conversationId, PHASES.PLAN, ["agent2"]);

            const history = tracker.getRoutingHistory(conversationId);
            expect(history).toHaveLength(1);
            expect(history[0].phase).toBe(PHASES.CHAT);
        });

        it("should include all turn data in routing entries", () => {
            tracker.startTurn(conversationId, PHASES.EXECUTE, ["agent1"], "Execute reason");
            tracker.addCompletion(conversationId, "agent1", "Execute response");

            const history = tracker.getRoutingHistory(conversationId);
            expect(history).toHaveLength(1);
            expect(history[0]).toEqual({
                phase: PHASES.EXECUTE,
                agents: ["agent1"],
                completions: [{
                    agent: "agent1",
                    message: "Execute response",
                    timestamp: expect.any(Number)
                }],
                reason: "Execute reason",
                timestamp: expect.any(Number)
            });
        });
    });

    describe("buildRoutingContext", () => {
        it("should build context with narrative for new conversation", () => {
            const context = tracker.buildRoutingContext(conversationId, "User request");

            expect(context.user_request).toBe("User request");
            expect(context.workflow_narrative).toContain("ORCHESTRATOR ROUTING CONTEXT");
            expect(context.workflow_narrative).toContain("User request");
            expect(context.workflow_narrative).toContain("No agents have been routed yet");
        });

        it("should include completed turns in narrative", () => {
            tracker.startTurn(conversationId, PHASES.CHAT, ["agent1"]);
            tracker.addCompletion(conversationId, "agent1", "Response");

            const context = tracker.buildRoutingContext(conversationId, "User request");

            expect(context.workflow_narrative).toContain("WORKFLOW HISTORY");
            expect(context.workflow_narrative).toContain("CHAT phase");
            expect(context.workflow_narrative).toContain("Response");
        });

        it("should show incomplete turns as waiting in narrative", () => {
            tracker.startTurn(conversationId, PHASES.PLAN, ["agent1", "agent2"]);
            tracker.addCompletion(conversationId, "agent1", "Partial");

            const context = tracker.buildRoutingContext(conversationId, "User request");

            // Incomplete turn should show as waiting
            expect(context.workflow_narrative).toContain("Waiting for agent responses");
        });

        it("should include analysis hint for analysis requests", () => {
            const context = tracker.buildRoutingContext(
                conversationId,
                "Tell me if the README is good"
            );

            // Should detect this as an analysis request
            expect(context.workflow_narrative).toContain("analysis/review request");
        });

        it("should include completed turn in narrative", () => {
            tracker.startTurn(conversationId, PHASES.CHAT, ["agent1"]);

            const triggeringCompletion: Completion = {
                agent: "agent1",
                message: "Final completion",
                timestamp: Date.now()
            };

            // First complete the turn manually
            tracker.addCompletion(conversationId, "agent1", "Final completion");
            
            const context = tracker.buildRoutingContext(
                conversationId,
                "User request"
            );

            expect(context.workflow_narrative).toContain("Final completion");
        });

        it("should build narrative from multiple completed turns", () => {
            // First turn
            tracker.startTurn(conversationId, PHASES.CHAT, ["agent1"]);
            tracker.addCompletion(conversationId, "agent1", "Chat response");

            // Second turn  
            tracker.startTurn(conversationId, PHASES.EXECUTE, ["agent2"]);
            tracker.addCompletion(conversationId, "agent2", "Execute response");

            const context = tracker.buildRoutingContext(
                conversationId,
                "User request"
            );

            expect(context.workflow_narrative).toContain("CHAT phase");
            expect(context.workflow_narrative).toContain("Chat response");
            expect(context.workflow_narrative).toContain("EXECUTE phase");
            expect(context.workflow_narrative).toContain("Execute response");
        });
    });

    describe("getTurns / setTurns", () => {
        it("should get and set turns for conversation", () => {
            tracker.startTurn(conversationId, PHASES.CHAT, ["agent1"]);
            const turns = tracker.getTurns(conversationId);

            const newConvId = "conv2";
            tracker.setTurns(newConvId, turns);

            expect(tracker.getTurns(newConvId)).toEqual(turns);
        });
    });

    describe("clearTurns", () => {
        it("should clear all turns for conversation", () => {
            tracker.startTurn(conversationId, PHASES.CHAT, ["agent1"]);
            tracker.startTurn(conversationId, PHASES.PLAN, ["agent2"]);

            expect(tracker.getTurns(conversationId)).toHaveLength(2);

            tracker.clearTurns(conversationId);
            expect(tracker.getTurns(conversationId)).toHaveLength(0);
        });
    });
});