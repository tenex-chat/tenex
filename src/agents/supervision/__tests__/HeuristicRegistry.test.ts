import { describe, it, expect, beforeEach, vi } from "vitest";
import { HeuristicRegistry } from "../heuristics/HeuristicRegistry";
import { SilentAgentHeuristic } from "../heuristics/SilentAgentHeuristic";
import { DelegationClaimHeuristic } from "../heuristics/DelegationClaimHeuristic";

// Mock logger
vi.mock("@/utils/logger", () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

describe("HeuristicRegistry", () => {
    beforeEach(() => {
        // Clear registry before each test
        HeuristicRegistry.getInstance().clear();
    });

    it("should return the same instance (singleton)", () => {
        const instance1 = HeuristicRegistry.getInstance();
        const instance2 = HeuristicRegistry.getInstance();
        expect(instance1).toBe(instance2);
    });

    it("should register heuristics", () => {
        const registry = HeuristicRegistry.getInstance();
        const heuristic = new SilentAgentHeuristic();

        registry.register(heuristic);

        expect(registry.get("silent-agent")).toBe(heuristic);
        expect(registry.size).toBe(1);
    });

    it("should get heuristics by timing", () => {
        const registry = HeuristicRegistry.getInstance();
        registry.register(new SilentAgentHeuristic());
        registry.register(new DelegationClaimHeuristic());

        const postCompletion = registry.getByTiming("post-completion");
        const preTool = registry.getByTiming("pre-tool-execution");

        expect(postCompletion.length).toBe(2);
        expect(preTool.length).toBe(0);
    });

    it("should get pre-tool heuristics filtered by tool name", () => {
        const registry = HeuristicRegistry.getInstance();
        // No pre-tool heuristics registered

        const delegateHeuristics = registry.getPreToolHeuristics("delegate");
        const otherHeuristics = registry.getPreToolHeuristics("some-other-tool");

        expect(delegateHeuristics.length).toBe(0);
        expect(otherHeuristics.length).toBe(0);
    });

    it("should get post-completion heuristics", () => {
        const registry = HeuristicRegistry.getInstance();
        registry.register(new SilentAgentHeuristic());
        registry.register(new DelegationClaimHeuristic());

        const postCompletion = registry.getPostCompletionHeuristics();

        expect(postCompletion.length).toBe(2);
        expect(postCompletion.map(h => h.id)).toContain("silent-agent");
        expect(postCompletion.map(h => h.id)).toContain("delegation-claim");
    });

    it("should return all registered IDs", () => {
        const registry = HeuristicRegistry.getInstance();
        registry.register(new SilentAgentHeuristic());
        registry.register(new DelegationClaimHeuristic());

        const ids = registry.getAllIds();

        expect(ids).toContain("silent-agent");
        expect(ids).toContain("delegation-claim");
    });

    it("should clear all heuristics", () => {
        const registry = HeuristicRegistry.getInstance();
        registry.register(new SilentAgentHeuristic());

        registry.clear();

        expect(registry.size).toBe(0);
        expect(registry.get("silent-agent")).toBeUndefined();
    });
});
