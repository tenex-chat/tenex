import { describe, it, expect, beforeEach } from "vitest";
import { DelegationClaimHeuristic } from "../heuristics/DelegationClaimHeuristic";
import type { PostCompletionContext } from "../types";

describe("DelegationClaimHeuristic", () => {
    let heuristic: DelegationClaimHeuristic;

    beforeEach(() => {
        heuristic = new DelegationClaimHeuristic();
        heuristic.setKnownAgentSlugs(["researcher", "debugger", "pm"]);
    });

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
        hasBeenNudgedAboutTodos: false,
        todos: [],
        ...overrides,
    });

    describe("detect", () => {
        it("should trigger when agent says 'delegate' and mentions an agent but no tool call", async () => {
            const context = createContext({
                messageContent: "I'll delegate this to the researcher to investigate.",
                toolCallsMade: [],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(true);
            expect(result.reason).toContain("researcher");
        });

        it("should trigger with 'delegating' keyword", async () => {
            const context = createContext({
                messageContent: "I'm delegating this task to the debugger.",
                toolCallsMade: [],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(true);
        });

        it("should NOT trigger when delegate tool was actually called", async () => {
            const context = createContext({
                messageContent: "I'll delegate this to the researcher.",
                toolCallsMade: ["delegate"],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });

        it("should NOT trigger with mcp__tenex__delegate tool call", async () => {
            const context = createContext({
                messageContent: "I'm delegating to pm now.",
                toolCallsMade: ["mcp__tenex__delegate"],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });

        it("should NOT trigger when no delegation keywords present", async () => {
            const context = createContext({
                messageContent: "Here is my analysis of the problem.",
                toolCallsMade: [],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });

        it("should NOT trigger when delegation keyword but no known agent mentioned", async () => {
            const context = createContext({
                messageContent: "I will delegate this to someone.",
                toolCallsMade: [],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });
    });

    describe("getCorrectionAction", () => {
        it("should return suppress-publish with reEngage", () => {
            const action = heuristic.getCorrectionAction({
                verdict: "violation",
                explanation: "Agent didn't call delegate",
            });

            expect(action.type).toBe("suppress-publish");
            expect(action.reEngage).toBe(true);
        });
    });

    describe("setKnownAgentSlugs", () => {
        it("should update the list of known agents", async () => {
            heuristic.setKnownAgentSlugs(["new-agent"]);

            const context = createContext({
                messageContent: "I'll delegate to new-agent.",
                toolCallsMade: [],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(true);
        });
    });
});
