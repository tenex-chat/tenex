import { describe, expect, it, beforeEach } from "@jest/globals";
import { OrchestratorTurnTracker } from "../OrchestratorTurnTracker";
import { PHASES } from "../../phases";
import type { Completion } from "../../types";

describe("OrchestratorTurnTracker", () => {
    let tracker: OrchestratorTurnTracker;
    const conversationId = "conv1";

    beforeEach(() => {
        tracker = new OrchestratorTurnTracker();
    });

    describe("startTurn", () => {
        it("should create a new turn with unique ID", () => {
            const turnId1 = tracker.startTurn(conversationId, PHASES.CHAT, ["agent1"], "test reason");
            const turnId2 = tracker.startTurn(conversationId, PHASES.PLAN, ["agent2"], "another reason");

            expect(turnId1).toBeTruthy();
            expect(turnId2).toBeTruthy();
            expect(turnId1).not.toBe(turnId2);
        });

        it("should initialize turn with correct properties", () => {
            const turnId = tracker.startTurn(conversationId, PHASES.EXECUTE, ["agent1", "agent2"], "test");
            const turn = tracker.getCurrentTurn(conversationId);

            expect(turn).toBeDefined();
            expect(turn?.turnId).toBe(turnId);
            expect(turn?.phase).toBe(PHASES.EXECUTE);
            expect(turn?.agents).toEqual(["agent1", "agent2"]);
            expect(turn?.reason).toBe("test");
            expect(turn?.isCompleted).toBe(false);
            expect(turn?.completions).toEqual([]);
        });
    });

    describe("addCompletion", () => {
        it("should add completion to active turn", () => {
            tracker.startTurn(conversationId, PHASES.CHAT, ["agent1", "agent2"]);
            tracker.addCompletion(conversationId, "agent1", "Task completed");

            const turn = tracker.getCurrentTurn(conversationId);
            expect(turn?.completions).toHaveLength(1);
            expect(turn?.completions[0]).toMatchObject({
                agent: "agent1",
                message: "Task completed"
            });
        });

        it("should mark turn as completed when all agents complete", () => {
            tracker.startTurn(conversationId, PHASES.CHAT, ["agent1", "agent2"]);
            
            tracker.addCompletion(conversationId, "agent1", "Agent 1 done");
            let turn = tracker.getCurrentTurn(conversationId);
            expect(turn?.isCompleted).toBe(false);

            tracker.addCompletion(conversationId, "agent2", "Agent 2 done");
            turn = tracker.getCurrentTurn(conversationId);
            expect(turn?.isCompleted).toBe(true);
        });

        it("should not add completion to non-existent conversation", () => {
            tracker.addCompletion("nonexistent", "agent1", "message");
            // Should not throw, just warn
        });

        it("should find correct turn for agent in multiple turns", () => {
            // Start first turn with agent1
            tracker.startTurn(conversationId, PHASES.CHAT, ["agent1"]);
            tracker.addCompletion(conversationId, "agent1", "First turn done");

            // Start second turn with agent2 and agent3
            tracker.startTurn(conversationId, PHASES.PLAN, ["agent2", "agent3"]);
            tracker.addCompletion(conversationId, "agent2", "Second turn agent2");

            const turns = tracker.getTurns(conversationId);
            expect(turns).toHaveLength(2);
            expect(turns[0].isCompleted).toBe(true);
            expect(turns[1].completions).toHaveLength(1);
        });
    });

    describe("isCurrentTurnComplete", () => {
        it("should return true when no turns exist", () => {
            expect(tracker.isCurrentTurnComplete(conversationId)).toBe(true);
        });

        it("should return false when current turn is incomplete", () => {
            tracker.startTurn(conversationId, PHASES.CHAT, ["agent1", "agent2"]);
            tracker.addCompletion(conversationId, "agent1", "Done");

            expect(tracker.isCurrentTurnComplete(conversationId)).toBe(false);
        });

        it("should return true when current turn is complete", () => {
            tracker.startTurn(conversationId, PHASES.CHAT, ["agent1"]);
            tracker.addCompletion(conversationId, "agent1", "Done");

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
        });
    });

    describe("getRoutingHistory", () => {
        it("should return only completed turns", () => {
            // Create completed turn
            tracker.startTurn(conversationId, PHASES.CHAT, ["agent1"]);
            tracker.addCompletion(conversationId, "agent1", "Done");

            // Create incomplete turn
            tracker.startTurn(conversationId, PHASES.PLAN, ["agent2", "agent3"]);
            tracker.addCompletion(conversationId, "agent2", "Partial");

            const history = tracker.getRoutingHistory(conversationId);
            expect(history).toHaveLength(1);
            expect(history[0].phase).toBe(PHASES.CHAT);
        });

        it("should include all turn data in routing entries", () => {
            tracker.startTurn(conversationId, PHASES.EXECUTE, ["agent1"], "Execute task");
            tracker.addCompletion(conversationId, "agent1", "Task executed");

            const history = tracker.getRoutingHistory(conversationId);
            expect(history[0]).toMatchObject({
                phase: PHASES.EXECUTE,
                agents: ["agent1"],
                reason: "Execute task"
            });
            expect(history[0].completions).toHaveLength(1);
        });
    });

    describe("buildRoutingContext", () => {
        it("should build context with empty history for new conversation", () => {
            const context = tracker.buildRoutingContext(conversationId, "User request");

            expect(context.user_request).toBe("User request");
            expect(context.routing_history).toEqual([]);
            // current_routing no longer exists in the interface
        });

        it("should include completed turns in history", () => {
            tracker.startTurn(conversationId, PHASES.CHAT, ["agent1"]);
            tracker.addCompletion(conversationId, "agent1", "Response");

            const context = tracker.buildRoutingContext(conversationId, "User request");

            expect(context.routing_history).toHaveLength(1);
            // current_routing no longer exists in the interface
        });

        it("should skip incomplete turns in routing context", () => {
            tracker.startTurn(conversationId, PHASES.PLAN, ["agent1", "agent2"]);
            tracker.addCompletion(conversationId, "agent1", "Partial");

            const context = tracker.buildRoutingContext(conversationId, "User request");

            // Incomplete turn should not be in history since orchestrator
            // is only called when turns are complete
            expect(context.routing_history).toHaveLength(0);
        });

        it("should not include triggering completion in context", () => {
            tracker.startTurn(conversationId, PHASES.CHAT, ["agent1", "agent2"]);

            const triggeringCompletion: Completion = {
                agent: "agent1",
                message: "New completion",
                timestamp: Date.now()
            };

            const context = tracker.buildRoutingContext(
                conversationId,
                "User request",
                triggeringCompletion
            );

            // With new optimization, orchestrator isn't called until turn is complete
            // so triggering completion handling is no longer needed
            expect(context.routing_history).toHaveLength(0);
        });

        it("should include completed turn in history", () => {
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

            expect(context.routing_history).toHaveLength(1);
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