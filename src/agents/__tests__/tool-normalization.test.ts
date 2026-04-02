import { describe, expect, it } from "bun:test";
import { normalizeAgentTools, validateTools, processAgentTools } from "../tool-normalization";
import { CORE_AGENT_TOOLS, DELEGATE_TOOLS } from "../constants";

describe("normalizeAgentTools", () => {
    it("should add core and delegate tools", () => {
        const result = normalizeAgentTools(["shell"]);
        for (const coreTool of CORE_AGENT_TOOLS) {
            expect(result).toContain(coreTool);
        }
        for (const delegateTool of DELEGATE_TOOLS) {
            expect(result).toContain(delegateTool);
        }
        expect(result).toContain("shell");
    });

    it("should filter out delegation tools from input", () => {
        const result = normalizeAgentTools(["shell", "delegate", "ask"]);
        // delegate and ask should still be present (re-added as delegate tools)
        expect(result).toContain("delegate");
        expect(result).toContain("ask");
        expect(result).toContain("shell");
    });

    it("should not duplicate core tools already present", () => {
        const result = normalizeAgentTools(["kill", "shell"]);
        const killCount = result.filter((t) => t === "kill").length;
        expect(killCount).toBe(1);
    });
});

describe("validateTools", () => {
    it("should drop unrecognized tools", () => {
        const result = validateTools(["ask", "nonexistent_tool"]);
        expect(result).toContain("ask");
        expect(result).not.toContain("nonexistent_tool");
    });

    it("should drop mcp__ prefixed tools", () => {
        const result = validateTools(["ask", "mcp__server__tool"]);
        expect(result).toContain("ask");
        expect(result).not.toContain("mcp__server__tool");
    });
});

describe("processAgentTools", () => {
    it("should normalize and validate", () => {
        const result = processAgentTools(["shell"]);
        // Should have core + delegate tools, shell is skill-provided so dropped by validate
        for (const coreTool of CORE_AGENT_TOOLS) {
            expect(result).toContain(coreTool);
        }
    });
});
