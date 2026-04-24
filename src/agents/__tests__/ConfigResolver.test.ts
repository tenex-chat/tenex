import { describe, expect, it } from "bun:test";
import {
    applyToolsDelta,
    resolveEffectiveTools,
    resolveEffectiveModel,
    resolveEffectiveSkills,
    resolveEffectiveBlockedSkills,
    resolveEffectiveConfig,
    arraysEqualUnordered,
} from "../ConfigResolver";

describe("ConfigResolver", () => {
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

        it("should apply delta additions even when no defaults", () => {
            expect(resolveEffectiveTools(undefined, ["+tool1"])).toEqual(["tool1"]);
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

    describe("resolveEffectiveSkills", () => {
        it("should return defaults when no project override exists", () => {
            expect(resolveEffectiveSkills(["make-posters"], undefined)).toEqual(["make-posters"]);
        });

        it("should return project override when set", () => {
            expect(resolveEffectiveSkills(["make-posters"], ["edit-videos"])).toEqual([
                "edit-videos",
            ]);
        });

        it("should allow project override to clear all skills", () => {
            expect(resolveEffectiveSkills(["make-posters"], [])).toEqual([]);
        });
    });

    describe("resolveEffectiveBlockedSkills", () => {
        it("should return undefined when both inputs are undefined", () => {
            expect(resolveEffectiveBlockedSkills(undefined, undefined)).toBeUndefined();
        });

        it("should return default list when project list is undefined", () => {
            expect(resolveEffectiveBlockedSkills(["shell"], undefined)).toEqual(["shell"]);
        });

        it("should return project list when default list is undefined", () => {
            expect(resolveEffectiveBlockedSkills(undefined, ["write-access"])).toEqual([
                "write-access",
            ]);
        });

        it("should merge default and project lists with union semantics", () => {
            expect(resolveEffectiveBlockedSkills(["shell"], ["write-access", "shell"])).toEqual([
                "shell",
                "write-access",
            ]);
        });

        it("should keep default blocks when project list is empty", () => {
            expect(resolveEffectiveBlockedSkills(["shell"], [])).toEqual(["shell"]);
        });
    });

    describe("resolveEffectiveConfig", () => {
        it("should resolve model and tools from default config", () => {
            const defaultConfig = { model: "modelA", tools: ["tool1", "tool2"] };
            const resolved = resolveEffectiveConfig(defaultConfig);
            expect(resolved.model).toBe("modelA");
            expect(resolved.tools).toEqual(["tool1", "tool2"]);
        });

        it("should resolve skills from default config", () => {
            const defaultConfig = { model: "modelA", tools: ["tool1"], skills: ["make-posters"] };
            const resolved = resolveEffectiveConfig(defaultConfig);
            expect(resolved.skills).toEqual(["make-posters"]);
        });

        it("should resolve blockedSkills from default config", () => {
            const defaultConfig = { model: "modelA", tools: ["tool1"], blockedSkills: ["shell"] };
            const resolved = resolveEffectiveConfig(defaultConfig);
            expect(resolved.blockedSkills).toEqual(["shell"]);
        });

        it("should resolve mcpAccess from default config", () => {
            const defaultConfig = { mcpAccess: ["github", "slack"] };
            const resolved = resolveEffectiveConfig(defaultConfig);
            expect(resolved.mcpAccess).toEqual(["github", "slack"]);
        });

        it("should return undefined fields when not set in default config", () => {
            const resolved = resolveEffectiveConfig({});
            expect(resolved.model).toBeUndefined();
            expect(resolved.tools).toBeUndefined();
            expect(resolved.skills).toBeUndefined();
            expect(resolved.blockedSkills).toBeUndefined();
            expect(resolved.mcpAccess).toBeUndefined();
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
