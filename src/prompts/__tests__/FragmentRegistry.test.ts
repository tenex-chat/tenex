import { FragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

describe("FragmentRegistry", () => {
    let registry: FragmentRegistry;

    beforeEach(() => {
        registry = new FragmentRegistry();
    });

    describe("register", () => {
        it("should register a fragment", () => {
            const fragment: PromptFragment = {
                id: "test-fragment",
                template: () => "Test content",
            };

            registry.register(fragment);
            expect(registry.has("test-fragment")).toBe(true);
        });

        it("should throw error if fragment has no id", () => {
            const fragment = {
                template: () => "Test content",
            } as any;

            expect(() => registry.register(fragment)).toThrow("Fragment must have an id");
        });

        it("should allow overwriting existing fragments", () => {
            const fragment1: PromptFragment = {
                id: "test-fragment",
                template: () => "Content 1",
            };
            const fragment2: PromptFragment = {
                id: "test-fragment",
                template: () => "Content 2",
            };

            registry.register(fragment1);
            registry.register(fragment2);

            const retrieved = registry.get("test-fragment");
            expect(retrieved?.template({})).toBe("Content 2");
        });
    });

    describe("get", () => {
        it("should retrieve registered fragment", () => {
            const fragment: PromptFragment = {
                id: "test-fragment",
                priority: 10,
                template: () => "Test content",
            };

            registry.register(fragment);
            const retrieved = registry.get("test-fragment");

            expect(retrieved).toBe(fragment);
            expect(retrieved?.priority).toBe(10);
        });

        it("should return undefined for non-existent fragment", () => {
            expect(registry.get("non-existent")).toBeUndefined();
        });
    });

    describe("has", () => {
        it("should return true for registered fragments", () => {
            registry.register({
                id: "test-fragment",
                template: () => "Test",
            });

            expect(registry.has("test-fragment")).toBe(true);
        });

        it("should return false for non-registered fragments", () => {
            expect(registry.has("non-existent")).toBe(false);
        });
    });

    describe("clear", () => {
        it("should remove all fragments", () => {
            registry.register({ id: "fragment1", template: () => "Test 1" });
            registry.register({ id: "fragment2", template: () => "Test 2" });

            expect(registry.getAllIds()).toHaveLength(2);

            registry.clear();

            expect(registry.getAllIds()).toHaveLength(0);
            expect(registry.has("fragment1")).toBe(false);
            expect(registry.has("fragment2")).toBe(false);
        });
    });

    describe("getAllIds", () => {
        it("should return all fragment ids", () => {
            registry.register({ id: "fragment1", template: () => "Test 1" });
            registry.register({ id: "fragment2", template: () => "Test 2" });
            registry.register({ id: "fragment3", template: () => "Test 3" });

            const ids = registry.getAllIds();
            expect(ids).toHaveLength(3);
            expect(ids).toContain("fragment1");
            expect(ids).toContain("fragment2");
            expect(ids).toContain("fragment3");
        });

        it("should return empty array when no fragments registered", () => {
            expect(registry.getAllIds()).toEqual([]);
        });
    });
});
