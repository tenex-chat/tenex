import { describe, it, expect } from "vitest";
import { SilentAgentHeuristic } from "../heuristics/SilentAgentHeuristic";
import type { PostCompletionContext } from "../types";

describe("SilentAgentHeuristic", () => {
    const heuristic = new SilentAgentHeuristic();

    const createContext = (
        overrides: Partial<PostCompletionContext> = {}
    ): PostCompletionContext => ({
        agentSlug: "test-agent",
        agentPubkey: "abc123",
        messageContent: "",
        toolCallsMade: [],
        systemPrompt: "You are a helpful assistant.",
        conversationHistory: [],
        availableTools: {},
        hasTodoList: false,
        hasBeenNudgedAboutTodos: false,
        hasBeenRemindedAboutTodos: false,
        todos: [],
        ...overrides,
    });

    describe("detect", () => {
        it("should trigger when agent has no content and no tool calls", async () => {
            const context = createContext({
                messageContent: "",
                toolCallsMade: [],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(true);
            expect(result.reason).toBeDefined();
        });

        it("should trigger when content is only whitespace", async () => {
            const context = createContext({
                messageContent: "   \n\t  ",
                toolCallsMade: [],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(true);
        });

        it("should NOT trigger when agent has meaningful content", async () => {
            const context = createContext({
                messageContent: "Here is my response to you.",
                toolCallsMade: [],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });

        it("should NOT trigger when agent only called delegate", async () => {
            const context = createContext({
                messageContent: "",
                toolCallsMade: ["delegate"],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });

        it("should NOT trigger when agent called mcp__tenex__delegate", async () => {
            const context = createContext({
                messageContent: "",
                toolCallsMade: ["mcp__tenex__delegate"],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });

        it("should trigger when agent has tool calls but none are delegate", async () => {
            const context = createContext({
                messageContent: "",
                toolCallsMade: ["read_file", "fs_write"],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(true);
        });
    });

    describe("getCorrectionAction", () => {
        it("should return suppress-publish with reEngage", () => {
            const action = heuristic.getCorrectionAction({
                verdict: "violation",
                explanation: "Agent was silent",
            });

            expect(action.type).toBe("suppress-publish");
            expect(action.reEngage).toBe(true);
        });
    });

    describe("buildCorrectionMessage", () => {
        it("should return LLM correction message if provided", () => {
            const context = createContext();
            const message = heuristic.buildCorrectionMessage(context, {
                verdict: "violation",
                explanation: "test",
                correctionMessage: "Custom correction",
            });

            expect(message).toBe("Custom correction");
        });

        it("should return default message if no correction provided", () => {
            const context = createContext();
            const message = heuristic.buildCorrectionMessage(context, {
                verdict: "violation",
                explanation: "test",
            });

            expect(message).toContain("Please provide a meaningful response");
        });
    });
});
