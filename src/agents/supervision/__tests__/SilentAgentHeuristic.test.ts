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
        outputTokens: 0,
        toolCallsMade: [],
        systemPrompt: "You are a helpful assistant.",
        conversationHistory: [],
        availableTools: {},
        hasBeenNudgedAboutTodos: false,
        todos: [],
        pendingDelegationCount: 0,
        usedErrorFallback: false,
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
                outputTokens: 15,
                toolCallsMade: [],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });

        it("should NOT trigger when silent completion was explicitly requested", async () => {
            const context = createContext({
                silentCompletionRequested: true,
                messageContent: "",
                toolCallsMade: ["no_response"],
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

        it("should trigger when LLM uses error fallback", async () => {
            const context = createContext({
                messageContent: "There was an error capturing the work done, please review the conversation for the results",
                outputTokens: 0,
                toolCallsMade: [],
                usedErrorFallback: true,
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(true);
            expect(result.reason).toContain("error fallback message");
        });

        it("should NOT trigger when provider has real content but no usage metadata", async () => {
            // Codex Issue #1: Some providers don't report usage, but have legitimate content
            const context = createContext({
                messageContent: "Here is my response to your question.",
                outputTokens: 0, // Missing usage metadata coalesced to 0
                toolCallsMade: [],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });

        it("should NOT trigger in multi-step flow where final step has 0 tokens", async () => {
            // Codex Issue #2: Final message from accumulated steps, but last step outputTokens = 0
            const context = createContext({
                messageContent: "Step 1 generated this response text.",
                outputTokens: 0, // Last step was a tool call with 0 output tokens
                toolCallsMade: ["read_file"],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
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

    describe("metadata", () => {
        it("should repeat until the silence is resolved", () => {
            expect(heuristic.enforcementMode).toBe("repeat-until-resolved");
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
