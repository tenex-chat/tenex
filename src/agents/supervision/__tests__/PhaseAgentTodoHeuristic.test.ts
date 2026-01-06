import { describe, it, expect } from "vitest";
import { PhaseAgentTodoHeuristic } from "../heuristics/PhaseAgentTodoHeuristic";
import type { PreExecutionEnvironment } from "../types";

describe("PhaseAgentTodoHeuristic", () => {
    const heuristic = new PhaseAgentTodoHeuristic();

    const createContext = (
        overrides: Partial<PreExecutionEnvironment> = {}
    ): PreExecutionEnvironment => ({
        agentSlug: "pm",
        agentPubkey: "abc123",
        hasPhases: true,
        toolName: "delegate",
        toolArgs: { agents: [{ slug: "researcher" }] },
        hasTodoList: false,
        systemPrompt: "You are a project manager.",
        conversationHistory: [],
        availableTools: {},
        ...overrides,
    });

    describe("properties", () => {
        it("should have correct id", () => {
            expect(heuristic.id).toBe("phase-agent-todo");
        });

        it("should have pre-tool-execution timing", () => {
            expect(heuristic.timing).toBe("pre-tool-execution");
        });

        it("should have tool filter for delegate tools", () => {
            expect(heuristic.toolFilter).toContain("delegate");
            expect(heuristic.toolFilter).toContain("mcp__tenex__delegate");
        });
    });

    describe("detect", () => {
        it("should trigger when phase agent delegates without todo list", async () => {
            const context = createContext({
                hasPhases: true,
                hasTodoList: false,
                toolName: "delegate",
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(true);
            expect(result.reason).toContain("todo list");
        });

        it("should NOT trigger when agent has no phases", async () => {
            const context = createContext({
                hasPhases: false,
                hasTodoList: false,
                toolName: "delegate",
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });

        it("should NOT trigger when agent has todo list", async () => {
            const context = createContext({
                hasPhases: true,
                hasTodoList: true,
                toolName: "delegate",
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });

        it("should trigger for mcp__tenex__delegate tool", async () => {
            const context = createContext({
                hasPhases: true,
                hasTodoList: false,
                toolName: "mcp__tenex__delegate",
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(true);
        });
    });

    describe("getCorrectionAction", () => {
        it("should return block-tool with reEngage", () => {
            const action = heuristic.getCorrectionAction({
                verdict: "violation",
                explanation: "Agent should set up todo first",
            });

            expect(action.type).toBe("block-tool");
            expect(action.reEngage).toBe(true);
        });
    });

    describe("buildCorrectionMessage", () => {
        it("should return LLM correction message if provided", () => {
            const context = createContext();
            const message = heuristic.buildCorrectionMessage(context, {
                verdict: "violation",
                explanation: "test",
                correctionMessage: "Please set up todos first",
            });

            expect(message).toBe("Please set up todos first");
        });

        it("should return default message if no correction provided", () => {
            const context = createContext();
            const message = heuristic.buildCorrectionMessage(context, {
                verdict: "violation",
                explanation: "test",
            });

            expect(message).toContain("todo list");
        });
    });
});
