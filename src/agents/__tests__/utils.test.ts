import { describe, it, expect } from "bun:test";
import { isClaudeBackend, isRoutingBackend, isToollessBackend } from "../utils";
import type { Agent } from "../types";

describe("Agent Utils", () => {
    describe("isClaudeBackend", () => {
        it("should return true for claude backend", () => {
            const agent = { backend: "claude" } as Agent;
            expect(isClaudeBackend(agent)).toBe(true);
        });

        it("should return false for non-claude backend", () => {
            const agent = { backend: "routing" } as Agent;
            expect(isClaudeBackend(agent)).toBe(false);
        });
    });

    describe("isRoutingBackend", () => {
        it("should return true for routing backend", () => {
            const agent = { backend: "routing" } as Agent;
            expect(isRoutingBackend(agent)).toBe(true);
        });

        it("should return false for non-routing backend", () => {
            const agent = { backend: "claude" } as Agent;
            expect(isRoutingBackend(agent)).toBe(false);
        });
    });

    describe("isToollessBackend", () => {
        it("should return true for claude backend", () => {
            const agent = { backend: "claude" } as Agent;
            expect(isToollessBackend(agent)).toBe(true);
        });

        it("should return true for routing backend", () => {
            const agent = { backend: "routing" } as Agent;
            expect(isToollessBackend(agent)).toBe(true);
        });

        it("should return false for other backends", () => {
            const agent = { backend: "other" } as Agent;
            expect(isToollessBackend(agent)).toBe(false);
        });
    });
});