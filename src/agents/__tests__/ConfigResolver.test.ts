import { describe, expect, it } from "bun:test";
import {
    isToolsDelta,
    applyToolsDelta,
    resolveEffectiveTools,
    resolveEffectiveModel,
    resolveEffectiveConfig,
    deduplicateProjectConfig,
    computeToolsDelta,
    arraysEqualUnordered,
} from "../ConfigResolver";

describe("ConfigResolver", () => {
    describe("isToolsDelta", () => {
        it("should return false for empty array", () => {
            expect(isToolsDelta([])).toBe(false);
        });

        it("should return false for plain tool list", () => {
            expect(isToolsDelta(["fs_read", "shell", "agents_write"])).toBe(false);
        });

        it("should return true when any tool has + prefix", () => {
            expect(isToolsDelta(["+fs_edit"])).toBe(true);
            expect(isToolsDelta(["fs_read", "+fs_edit"])).toBe(true);
        });

        it("should return true when any tool has - prefix", () => {
            expect(isToolsDelta(["-fs_write"])).toBe(true);
            expect(isToolsDelta(["fs_read", "-fs_write"])).toBe(true);
        });

        it("should return true when tools have mixed +/- prefixes", () => {
            expect(isToolsDelta(["+fs_edit", "-fs_write"])).toBe(true);
        });
    });

    describe("applyToolsDelta", () => {
        it("should add tools with + prefix", () => {
            const base = ["tool1", "tool2"];
            const delta = ["+tool3"];
            expect(applyToolsDelta(base, delta)).toEqual(["tool1", "tool2", "tool3"]);
        });

        it("should remove tools with - prefix", () => {
            const base = ["tool1", "tool2", "tool3"];
            const delta = ["-tool2"];
            expect(applyToolsDelta(base, delta)).toEqual(["tool1", "tool3"]);
        });

        it("should handle both + and - in the same delta", () => {
            const base = ["tool1", "tool2"];
            const delta = ["-tool1", "+tool3", "+tool4"];
            expect(applyToolsDelta(base, delta)).toEqual(["tool2", "tool3", "tool4"]);
        });

        it("should not add duplicate tools", () => {
            const base = ["tool1", "tool2"];
            const delta = ["+tool2"]; // Already exists
            expect(applyToolsDelta(base, delta)).toEqual(["tool1", "tool2"]);
        });

        it("should handle removing non-existent tool gracefully", () => {
            const base = ["tool1", "tool2"];
            const delta = ["-tool3"]; // Doesn't exist
            expect(applyToolsDelta(base, delta)).toEqual(["tool1", "tool2"]);
        });

        it("should handle empty base with additions", () => {
            const base: string[] = [];
            const delta = ["+tool1", "+tool2"];
            expect(applyToolsDelta(base, delta)).toEqual(["tool1", "tool2"]);
        });

        it("should apply the example from requirements", () => {
            // projectA: { tools: ['-tool1', '+tool4'] } with default tools: ['tool1', 'tool2']
            // Expected: [tool2, tool4]
            const base = ["tool1", "tool2"];
            const delta = ["-tool1", "+tool4"];
            expect(applyToolsDelta(base, delta)).toEqual(["tool2", "tool4"]);
        });
    });

    describe("resolveEffectiveTools", () => {
        it("should return defaults when no project override", () => {
            const defaults = ["tool1", "tool2"];
            expect(resolveEffectiveTools(defaults, undefined)).toEqual(["tool1", "tool2"]);
        });

        it("should return defaults when project override is empty", () => {
            const defaults = ["tool1", "tool2"];
            expect(resolveEffectiveTools(defaults, [])).toEqual(["tool1", "tool2"]);
        });

        it("should use full replacement when no delta syntax", () => {
            const defaults = ["tool1", "tool2"];
            const override = ["tool3", "tool4"];
            expect(resolveEffectiveTools(defaults, override)).toEqual(["tool3", "tool4"]);
        });

        it("should apply delta when + prefix used", () => {
            const defaults = ["tool1", "tool2"];
            const override = ["+tool3"];
            expect(resolveEffectiveTools(defaults, override)).toEqual(["tool1", "tool2", "tool3"]);
        });

        it("should apply delta when - prefix used", () => {
            const defaults = ["tool1", "tool2", "tool3"];
            const override = ["-tool2"];
            expect(resolveEffectiveTools(defaults, override)).toEqual(["tool1", "tool3"]);
        });

        it("should return undefined when no defaults and no override", () => {
            expect(resolveEffectiveTools(undefined, undefined)).toBeUndefined();
        });

        it("should use full replacement for override when no defaults", () => {
            expect(resolveEffectiveTools(undefined, ["tool1"])).toEqual(["tool1"]);
        });
    });

    describe("resolveEffectiveModel", () => {
        it("should return default when no project override", () => {
            expect(resolveEffectiveModel("modelA", undefined)).toBe("modelA");
        });

        it("should return project override when set", () => {
            expect(resolveEffectiveModel("modelA", "modelB")).toBe("modelB");
        });

        it("should return undefined when both undefined", () => {
            expect(resolveEffectiveModel(undefined, undefined)).toBeUndefined();
        });

        it("should return project override even if default is undefined", () => {
            expect(resolveEffectiveModel(undefined, "modelB")).toBe("modelB");
        });
    });

    describe("resolveEffectiveConfig", () => {
        it("should resolve full example from requirements: projectA", () => {
            // agentA has: default: { model: 'modelA', tools: ['tool1', 'tool2'] }
            // projectA: { model: 'modelB', tools: ['-tool1', '+tool4'] }
            // Expected: modelB, and tools tool2 and tool4
            const defaultConfig = { model: "modelA", tools: ["tool1", "tool2"] };
            const projectConfig = { model: "modelB", tools: ["-tool1", "+tool4"] };
            const resolved = resolveEffectiveConfig(defaultConfig, projectConfig);
            expect(resolved.model).toBe("modelB");
            expect(resolved.tools).toEqual(["tool2", "tool4"]);
        });

        it("should resolve full example from requirements: projectB", () => {
            // agentA has: default: { model: 'modelA', tools: ['tool1', 'tool2'] }
            // projectB: { tools: ['+tool5'] }
            // Expected: modelA (default), and tools tool1, tool2, tool5
            const defaultConfig = { model: "modelA", tools: ["tool1", "tool2"] };
            const projectConfig = { tools: ["+tool5"] };
            const resolved = resolveEffectiveConfig(defaultConfig, projectConfig);
            expect(resolved.model).toBe("modelA");
            expect(resolved.tools).toEqual(["tool1", "tool2", "tool5"]);
        });

        it("should use defaults when no project config", () => {
            const defaultConfig = { model: "modelA", tools: ["tool1"] };
            const resolved = resolveEffectiveConfig(defaultConfig, undefined);
            expect(resolved.model).toBe("modelA");
            expect(resolved.tools).toEqual(["tool1"]);
        });
    });

    describe("deduplicateProjectConfig", () => {
        it("should keep model override when different from default", () => {
            const defaultConfig = { model: "modelA", tools: ["tool1"] };
            const projectConfig = { model: "modelB" };
            const result = deduplicateProjectConfig(defaultConfig, projectConfig);
            expect(result.model).toBe("modelB");
        });

        it("should remove model override when same as default", () => {
            const defaultConfig = { model: "modelA", tools: ["tool1"] };
            const projectConfig = { model: "modelA" };
            const result = deduplicateProjectConfig(defaultConfig, projectConfig);
            expect(result.model).toBeUndefined();
        });

        it("should remove tools override when resolved result equals default", () => {
            const defaultConfig = { tools: ["tool1", "tool2"] };
            // Sending exact same list - should clear override
            const projectConfig = { tools: ["tool1", "tool2"] };
            const result = deduplicateProjectConfig(defaultConfig, projectConfig);
            expect(result.tools).toBeUndefined();
        });

        it("should keep tools override when resolved result differs from default", () => {
            const defaultConfig = { tools: ["tool1", "tool2"] };
            const projectConfig = { tools: ["tool1", "tool2", "tool3"] };
            const result = deduplicateProjectConfig(defaultConfig, projectConfig);
            expect(result.tools).toEqual(["tool1", "tool2", "tool3"]);
        });

        it("should dedup delta tools when they produce the same result as default", () => {
            // Default: [tool1, tool2, tool3]
            // ProjectA had: model: modelB, tools: -fs_write -> after: delta removes tool from defaults
            // But if we send tools: [tool1, tool2, tool3] (same as default), override should be cleared
            const defaultConfig = { tools: ["tool1", "tool2"] };
            const projectConfig = { tools: ["tool1", "tool2"] };
            const result = deduplicateProjectConfig(defaultConfig, projectConfig);
            expect(result.tools).toBeUndefined();
        });

        it("should handle requirement example: removing -fs_write when sending full list", () => {
            // agentA has:
            //   default: { model: 'test-model', tools: ['fs_write', 'fs_read'] }
            //   projectA: { model: 'test-model2', tools: ['+fs_edit', '-fs_write'] }
            // If we send 24020 with a-tag that has fs_write, fs_read, fs_edit
            // -> resolves to same as default + fs_edit being added
            // Actually, the requirement says: if sent full list { fs_write, fs_read, fs_edit }
            // and it differs from default, the override stays
            // BUT if sent same as default it should be removed
            const defaultConfig = { model: "test-model", tools: ["fs_write", "fs_read"] };
            // Sending the same as default -> dedup removes override
            const projectConfig = { model: "test-model", tools: ["fs_write", "fs_read"] };
            const result = deduplicateProjectConfig(defaultConfig, projectConfig);
            expect(result.model).toBeUndefined();
            expect(result.tools).toBeUndefined();
        });

        it("should handle requirement example: clearing -fs_write by sending fs_write, fs_read, fs_edit", () => {
            // agentA default: { model: 'test-model', tools: ['fs_write', 'fs_read'] }
            // projectA current: { model: 'test-model2', tools: ['+fs_edit', '-fs_write'] }
            // Send: tools = ['fs_write', 'fs_read', 'fs_edit'] (full list, no delta)
            // This results in tools=[fs_write,fs_read,fs_edit] which != default [fs_write,fs_read]
            // So tools override is kept
            const defaultConfig = { model: "test-model", tools: ["fs_write", "fs_read"] };
            const projectConfig = { tools: ["fs_write", "fs_read", "fs_edit"] };
            const result = deduplicateProjectConfig(defaultConfig, projectConfig);
            // tools differ from default, so kept
            expect(result.tools).toEqual(["fs_write", "fs_read", "fs_edit"]);
        });

        it("should handle requirement example: sending model same as default clears model override", () => {
            // agentA has: default.model = 'test-model'
            // projectA: { model: 'test-model2', ... }
            // Send 24020 with a-tag model='test-model' -> should remove model from projectA override
            const defaultConfig = { model: "test-model" };
            const projectConfig = { model: "test-model" }; // same as default
            const result = deduplicateProjectConfig(defaultConfig, projectConfig);
            expect(result.model).toBeUndefined(); // Cleared because same as default
        });

        it("should handle requirement: sending 24020 a-tagging projectB with exact defaults clears projectB", () => {
            // agentA has:
            //   default: { model: 'modelA', tools: ['tool1', 'tool2'] }
            //   projectB: { tools: ['+tool5'] }
            // If I then send a 24020 a-tagging projectB with: { model: 'modelA', tools: ['tool1', 'tool2'] }
            // The config becomes projectB: {} (empty = deleted)
            const defaultConfig = { model: "modelA", tools: ["tool1", "tool2"] };
            const projectConfig = { model: "modelA", tools: ["tool1", "tool2"] };
            const result = deduplicateProjectConfig(defaultConfig, projectConfig);
            expect(result.model).toBeUndefined();
            expect(result.tools).toBeUndefined();
            expect(Object.keys(result)).toHaveLength(0);
        });

        it("should clean up no-op +tool delta when tool already in defaults", () => {
            // Behavioral clarification Issue 3: If a project override delta becomes a no-op
            // against the current defaults (e.g., +tool that's already in defaults), it should
            // be cleaned up since the user is explicitly confirming the tool should be available.
            const defaultConfig = { tools: ["tool1", "tool2"] };
            // Sending a delta that adds tool1 (already in defaults) - should be a no-op
            const projectConfig = { tools: ["+tool1"] };
            const result = deduplicateProjectConfig(defaultConfig, projectConfig);
            // +tool1 resolves to [tool1, tool2] which equals defaults → clear override
            expect(result.tools).toBeUndefined();
        });

        it("should keep override when delta changes are meaningful (not all no-ops)", () => {
            // If delta adds a tool not in defaults, it should be kept
            const defaultConfig = { tools: ["tool1", "tool2"] };
            const projectConfig = { tools: ["+tool3"] };
            const result = deduplicateProjectConfig(defaultConfig, projectConfig);
            // +tool3 resolves to [tool1, tool2, tool3] which differs from defaults
            expect(result.tools).toEqual(["+tool3"]);
        });

        it("should use unordered comparison (order of tools should not matter)", () => {
            // Tools are sets — order should not matter for dedup
            const defaultConfig = { tools: ["tool1", "tool2", "tool3"] };
            const projectConfig = { tools: ["tool3", "tool1", "tool2"] }; // different order
            const result = deduplicateProjectConfig(defaultConfig, projectConfig);
            // Same set of tools as defaults → clear override
            expect(result.tools).toBeUndefined();
        });
    });

    describe("computeToolsDelta", () => {
        it("should return empty array when desired matches defaults exactly", () => {
            const defaults = ["tool1", "tool2"];
            const desired = ["tool1", "tool2"];
            expect(computeToolsDelta(defaults, desired)).toEqual([]);
        });

        it("should return additions when desired has tools not in defaults", () => {
            const defaults = ["tool1", "tool2"];
            const desired = ["tool1", "tool2", "tool3"];
            const delta = computeToolsDelta(defaults, desired);
            expect(delta).toContain("+tool3");
            expect(delta).not.toContain("+tool1");
            expect(delta).not.toContain("+tool2");
        });

        it("should return removals when defaults have tools not in desired", () => {
            const defaults = ["tool1", "tool2", "tool3"];
            const desired = ["tool1", "tool2"];
            const delta = computeToolsDelta(defaults, desired);
            expect(delta).toContain("-tool3");
            expect(delta).not.toContain("-tool1");
            expect(delta).not.toContain("-tool2");
        });

        it("should return both additions and removals", () => {
            const defaults = ["tool1", "tool2"];
            const desired = ["tool2", "tool3"]; // remove tool1, add tool3
            const delta = computeToolsDelta(defaults, desired);
            expect(delta).toContain("-tool1");
            expect(delta).toContain("+tool3");
            expect(delta).not.toContain("-tool2");
        });

        it("should return empty when desired is empty and defaults are empty", () => {
            expect(computeToolsDelta([], [])).toEqual([]);
        });

        it("should handle removing all default tools", () => {
            const defaults = ["tool1", "tool2"];
            const desired: string[] = [];
            const delta = computeToolsDelta(defaults, desired);
            expect(delta).toContain("-tool1");
            expect(delta).toContain("-tool2");
        });

        it("should handle adding tools when defaults are empty", () => {
            const defaults: string[] = [];
            const desired = ["tool1", "tool2"];
            const delta = computeToolsDelta(defaults, desired);
            expect(delta).toContain("+tool1");
            expect(delta).toContain("+tool2");
        });

        it("should round-trip correctly: applyToolsDelta(defaults, computeToolsDelta(defaults, desired)) = desired", () => {
            const defaults = ["fs_read", "fs_write", "shell"];
            const desired = ["fs_read", "fs_edit", "shell", "agents_write"];
            const delta = computeToolsDelta(defaults, desired);
            // Verify the delta, when applied, gives back the desired set
            const applied = applyToolsDelta(defaults, delta);
            expect(new Set(applied)).toEqual(new Set(desired));
        });
    });

    describe("arraysEqualUnordered", () => {
        it("should return true for same elements in same order", () => {
            expect(arraysEqualUnordered(["a", "b", "c"], ["a", "b", "c"])).toBe(true);
        });

        it("should return true for same elements in different order", () => {
            expect(arraysEqualUnordered(["a", "b", "c"], ["c", "a", "b"])).toBe(true);
        });

        it("should return false for different lengths", () => {
            expect(arraysEqualUnordered(["a", "b"], ["a", "b", "c"])).toBe(false);
        });

        it("should return false for different elements", () => {
            expect(arraysEqualUnordered(["a", "b"], ["a", "c"])).toBe(false);
        });

        it("should return true for empty arrays", () => {
            expect(arraysEqualUnordered([], [])).toBe(true);
        });
    });
});
