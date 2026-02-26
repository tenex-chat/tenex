import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SearchProviderRegistry } from "../SearchProviderRegistry";
import type { SearchProvider, SearchResult } from "../types";

/** Minimal mock provider */
function createMockProvider(name: string): SearchProvider {
    return {
        name,
        description: `Mock provider: ${name}`,
        search: async (): Promise<SearchResult[]> => [],
    };
}

describe("SearchProviderRegistry", () => {
    beforeEach(() => {
        SearchProviderRegistry.resetInstance();
    });

    afterEach(() => {
        SearchProviderRegistry.resetInstance();
    });

    it("returns singleton instance", () => {
        const a = SearchProviderRegistry.getInstance();
        const b = SearchProviderRegistry.getInstance();
        expect(a).toBe(b);
    });

    it("registers and retrieves a provider", () => {
        const registry = SearchProviderRegistry.getInstance();
        const provider = createMockProvider("reports");

        registry.register(provider);

        expect(registry.get("reports")).toBe(provider);
        expect(registry.has("reports")).toBe(true);
    });

    it("returns undefined for unregistered provider", () => {
        const registry = SearchProviderRegistry.getInstance();
        expect(registry.get("nonexistent")).toBeUndefined();
        expect(registry.has("nonexistent")).toBe(false);
    });

    it("returns all registered providers", () => {
        const registry = SearchProviderRegistry.getInstance();
        registry.register(createMockProvider("reports"));
        registry.register(createMockProvider("conversations"));
        registry.register(createMockProvider("lessons"));

        const all = registry.getAll();
        expect(all).toHaveLength(3);
        expect(registry.getNames()).toEqual(["reports", "conversations", "lessons"]);
    });

    it("filters providers by names", () => {
        const registry = SearchProviderRegistry.getInstance();
        registry.register(createMockProvider("reports"));
        registry.register(createMockProvider("conversations"));
        registry.register(createMockProvider("lessons"));

        const filtered = registry.getByNames(["reports", "lessons"]);
        expect(filtered).toHaveLength(2);
        expect(filtered.map((p) => p.name)).toEqual(["reports", "lessons"]);
    });

    it("returns all providers when no filter names provided", () => {
        const registry = SearchProviderRegistry.getInstance();
        registry.register(createMockProvider("reports"));
        registry.register(createMockProvider("conversations"));

        expect(registry.getByNames()).toHaveLength(2);
        expect(registry.getByNames([])).toHaveLength(2);
    });

    it("skips unknown names in filter", () => {
        const registry = SearchProviderRegistry.getInstance();
        registry.register(createMockProvider("reports"));

        const filtered = registry.getByNames(["reports", "nonexistent"]);
        expect(filtered).toHaveLength(1);
        expect(filtered[0].name).toBe("reports");
    });

    it("resets instance cleanly", () => {
        const registry = SearchProviderRegistry.getInstance();
        registry.register(createMockProvider("reports"));

        SearchProviderRegistry.resetInstance();

        const newRegistry = SearchProviderRegistry.getInstance();
        expect(newRegistry.getAll()).toHaveLength(0);
    });
});
