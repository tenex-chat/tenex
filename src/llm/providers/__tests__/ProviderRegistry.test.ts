import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { ProviderRegistry } from "../registry/ProviderRegistry";
import type { ILLMProvider, ProviderMetadata, ProviderRegistration } from "../types";

// Mock provider for testing
const createMockProviderClass = (id: string, requiresApiKey = true): ProviderRegistration => {
    const metadata: ProviderMetadata = {
        id,
        displayName: `Mock ${id}`,
        description: `Mock provider ${id}`,
        category: "standard",
        defaultModel: "mock-model",
        capabilities: {
            streaming: true,
            toolCalling: true,
            builtInTools: false,
            sessionResumption: false,
            requiresApiKey,
            mcpSupport: false,
        },
    };

    class MockProvider implements ILLMProvider {
        metadata = metadata;
        private initialized = false;

        async initialize() {
            this.initialized = true;
        }

        isInitialized() {
            return this.initialized;
        }

        isAvailable() {
            return this.initialized;
        }

        getProviderInstance() {
            return { id };
        }

        createModel(modelId: string) {
            return {
                model: { id: modelId } as any,
                bypassRegistry: false,
            };
        }

        reset() {
            this.initialized = false;
        }
    }

    return {
        Provider: MockProvider,
        metadata,
    };
};

describe("ProviderRegistry", () => {
    let registry: ProviderRegistry;

    beforeEach(() => {
        // Reset the singleton for each test
        ProviderRegistry.resetInstance();
        registry = ProviderRegistry.getInstance();
    });

    afterEach(() => {
        ProviderRegistry.resetInstance();
    });

    describe("singleton pattern", () => {
        it("returns the same instance", () => {
            const instance1 = ProviderRegistry.getInstance();
            const instance2 = ProviderRegistry.getInstance();
            expect(instance1).toBe(instance2);
        });

        it("resets instance correctly", () => {
            const instance1 = ProviderRegistry.getInstance();
            ProviderRegistry.resetInstance();
            const instance2 = ProviderRegistry.getInstance();
            expect(instance1).not.toBe(instance2);
        });
    });

    describe("registration", () => {
        it("registers a provider", () => {
            const mockProvider = createMockProviderClass("test-provider");
            registry.register(mockProvider);

            const registered = registry.getRegisteredProviders();
            expect(registered.length).toBe(1);
            expect(registered[0].id).toBe("test-provider");
        });

        it("prevents duplicate registrations", () => {
            const mockProvider = createMockProviderClass("test-provider");
            registry.register(mockProvider);
            registry.register(mockProvider);

            const registered = registry.getRegisteredProviders();
            expect(registered.length).toBe(1);
        });

        it("registers multiple providers", () => {
            const providers = [
                createMockProviderClass("provider-1"),
                createMockProviderClass("provider-2"),
                createMockProviderClass("provider-3"),
            ];

            registry.registerAll(providers);

            const registered = registry.getRegisteredProviders();
            expect(registered.length).toBe(3);
        });
    });

    describe("initialization", () => {
        it("initializes providers with API keys", async () => {
            const mockProvider = createMockProviderClass("test-provider");
            registry.register(mockProvider);

            await registry.initialize({
                "test-provider": { apiKey: "test-key" },
            });

            expect(registry.hasProvider("test-provider")).toBe(true);
        });

        it("skips providers without API key when required", async () => {
            const mockProvider = createMockProviderClass("test-provider", true);
            registry.register(mockProvider);

            await registry.initialize({});

            expect(registry.hasProvider("test-provider")).toBe(false);
        });

        it("initializes providers that don't require API key", async () => {
            const mockProvider = createMockProviderClass("test-provider", false);
            registry.register(mockProvider);

            await registry.initialize({});

            expect(registry.hasProvider("test-provider")).toBe(true);
        });

        it("returns initialization results", async () => {
            const provider1 = createMockProviderClass("provider-1", false);
            const provider2 = createMockProviderClass("provider-2", true);

            registry.registerAll([provider1, provider2]);

            const results = await registry.initialize({
                "provider-1": {},
                "provider-2": { apiKey: "test-key" },
            });

            expect(results.length).toBe(2);
            expect(results.every(r => r.success)).toBe(true);
        });
    });

    describe("provider access", () => {
        beforeEach(async () => {
            const mockProvider = createMockProviderClass("test-provider", false);
            registry.register(mockProvider);
            await registry.initialize({});
        });

        it("gets provider by id", () => {
            const provider = registry.getProvider("test-provider");
            expect(provider).toBeDefined();
            expect(provider?.metadata.id).toBe("test-provider");
        });

        it("returns undefined for unknown provider", () => {
            const provider = registry.getProvider("unknown");
            expect(provider).toBeUndefined();
        });

        it("checks provider availability", () => {
            expect(registry.hasProvider("test-provider")).toBe(true);
            expect(registry.hasProvider("unknown")).toBe(false);
        });

        it("gets available providers", () => {
            const available = registry.getAvailableProviders();
            expect(available.length).toBe(1);
            expect(available[0].id).toBe("test-provider");
        });
    });

    describe("model creation", () => {
        beforeEach(async () => {
            const mockProvider = createMockProviderClass("test-provider", false);
            registry.register(mockProvider);
            await registry.initialize({});
        });

        it("creates model from provider", () => {
            const result = registry.createModel("test-provider", "test-model");
            expect(result).toBeDefined();
            expect(result.bypassRegistry).toBe(false);
        });

        it("throws for unknown provider", () => {
            expect(() => registry.createModel("unknown", "test-model")).toThrow(
                /not available/
            );
        });
    });

    describe("reset", () => {
        it("clears all providers on reset", async () => {
            const mockProvider = createMockProviderClass("test-provider", false);
            registry.register(mockProvider);
            await registry.initialize({});

            expect(registry.hasProvider("test-provider")).toBe(true);

            registry.reset();

            expect(registry.hasProvider("test-provider")).toBe(false);
            expect(registry.isInitialized()).toBe(false);
        });
    });
});
