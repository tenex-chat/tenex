import { describe, it, expect, beforeEach } from "bun:test";
import { StreamStateManager } from "../StreamStateManager";

describe("StreamStateManager", () => {
    let manager: StreamStateManager;

    beforeEach(() => {
        manager = new StreamStateManager();
    });

    describe("setState", () => {
        it("should set and get state correctly", () => {
            manager.setState("key1", "value1");
            expect(manager.getState("key1")).toBe("value1");
        });

        it("should overwrite existing state", () => {
            manager.setState("key1", "value1");
            manager.setState("key1", "value2");
            expect(manager.getState("key1")).toBe("value2");
        });
    });

    describe("hasState", () => {
        it("should return true for existing state", () => {
            manager.setState("key1", "value1");
            expect(manager.hasState("key1")).toBe(true);
        });

        it("should return false for non-existing state", () => {
            expect(manager.hasState("nonexistent")).toBe(false);
        });
    });

    describe("deleteState", () => {
        it("should delete existing state", () => {
            manager.setState("key1", "value1");
            manager.deleteState("key1");
            expect(manager.hasState("key1")).toBe(false);
            expect(manager.getState("key1")).toBeUndefined();
        });

        it("should handle deleting non-existent state gracefully", () => {
            expect(() => manager.deleteState("nonexistent")).not.toThrow();
        });
    });

    describe("getAllState", () => {
        it("should return all state as an object", () => {
            manager.setState("key1", "value1");
            manager.setState("key2", { nested: "value" });
            const allState = manager.getAllState();
            expect(allState).toEqual({
                key1: "value1",
                key2: { nested: "value" }
            });
        });

        it("should return empty object when no state exists", () => {
            expect(manager.getAllState()).toEqual({});
        });
    });

    describe("clear", () => {
        it("should clear all state", () => {
            manager.setState("key1", "value1");
            manager.setState("key2", "value2");
            manager.clear();
            expect(manager.getAllState()).toEqual({});
        });
    });
});