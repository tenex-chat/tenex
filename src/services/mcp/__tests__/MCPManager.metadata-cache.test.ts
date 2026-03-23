import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Resource, ResourceTemplate } from "@modelcontextprotocol/sdk/types.js";

const addEvent = mock(() => {});

mock.module("@opentelemetry/api", () => ({
    trace: {
        getActiveSpan: () => ({
            addEvent,
        }),
    },
}));

import { MCPManager } from "../MCPManager";

function createManagerWithClient(overrides?: {
    listResources?: () => Promise<{ resources: Resource[] }>;
    listResourceTemplates?: () => Promise<{ resourceTemplates: ResourceTemplate[] }>;
}) {
    const manager = new MCPManager();
    const listResources = mock(
        overrides?.listResources ??
            (async () => ({
                resources: [{ uri: "resource://one", name: "One" }],
            }))
    );
    const listResourceTemplates = mock(
        overrides?.listResourceTemplates ??
            (async () => ({
                resourceTemplates: [{ uriTemplate: "resource://{id}", name: "Template" }],
            }))
    );

    // @ts-expect-error Accessing private state for focused unit tests
    manager.clients.set("test-server", {
        client: {
            listResources,
            listResourceTemplates,
        },
        transport: {} as never,
        serverName: "test-server",
        config: {
            command: "node",
            args: ["server.js"],
        },
    });

    return { manager, listResources, listResourceTemplates };
}

describe("MCPManager metadata caching", () => {
    beforeEach(() => {
        addEvent.mockClear();
    });

    it("reuses fresh cached resources for prompt-time lookups", async () => {
        const { manager, listResources } = createManagerWithClient();

        const first = await manager.listResourcesWithOptions("test-server", {
            preferCache: true,
        });
        const second = await manager.listResourcesWithOptions("test-server", {
            preferCache: true,
        });

        expect(first).toEqual(second);
        expect(listResources).toHaveBeenCalledTimes(1);
        expect(addEvent.mock.calls).toEqual([
            [
                "mcp.metadata_fetch_started",
                expect.objectContaining({
                    "server.name": "test-server",
                    "mcp.metadata.kind": "resources",
                    "mcp.fetch.source": "network",
                }),
            ],
            [
                "mcp.metadata_fetch_succeeded",
                expect.objectContaining({
                    "server.name": "test-server",
                    "mcp.metadata.kind": "resources",
                    "mcp.fetch.source": "network",
                    "mcp.result.count": 1,
                }),
            ],
            [
                "mcp.metadata_cache_hit",
                expect.objectContaining({
                    "server.name": "test-server",
                    "mcp.metadata.kind": "resources",
                    "mcp.fetch.source": "cache",
                    "mcp.result.count": 1,
                }),
            ],
        ]);
    });

    it("falls back to stale cached resources after timeout", async () => {
        const cachedResources: Resource[] = [{ uri: "resource://stale", name: "Stale" }];
        const { manager } = createManagerWithClient({
            listResources: async () => await new Promise(() => {}),
        });

        // @ts-expect-error Accessing private state for focused unit tests
        manager.resourceListCache.set("test-server", {
            value: cachedResources,
            expiresAt: Date.now() - 1,
        });

        const result = await manager.listResourcesWithOptions("test-server", {
            timeoutMs: 5,
            preferCache: true,
            allowStale: true,
        });

        expect(result).toEqual(cachedResources);
        expect(addEvent.mock.calls).toEqual([
            [
                "mcp.metadata_fetch_started",
                expect.objectContaining({
                    "server.name": "test-server",
                    "mcp.metadata.kind": "resources",
                    "mcp.fetch.source": "network",
                    "mcp.timeout_ms": 5,
                }),
            ],
            [
                "mcp.metadata_fetch_failed",
                expect.objectContaining({
                    "server.name": "test-server",
                    "mcp.metadata.kind": "resources",
                    "mcp.fetch.source": "network",
                }),
            ],
            [
                "mcp.metadata_stale_cache_fallback",
                expect.objectContaining({
                    "server.name": "test-server",
                    "mcp.metadata.kind": "resources",
                    "mcp.fetch.source": "stale_cache_fallback",
                    "mcp.result.count": 1,
                    "mcp.timeout_ms": 5,
                }),
            ],
        ]);
    });

    it("falls back to stale cached templates after timeout", async () => {
        const cachedTemplates: ResourceTemplate[] = [
            { uriTemplate: "resource://cached/{id}", name: "Cached Template" },
        ];
        const { manager } = createManagerWithClient({
            listResourceTemplates: async () => await new Promise(() => {}),
        });

        // @ts-expect-error Accessing private state for focused unit tests
        manager.resourceTemplateCache.set("test-server", {
            value: cachedTemplates,
            expiresAt: Date.now() - 1,
        });

        const result = await manager.listResourceTemplatesWithOptions("test-server", {
            timeoutMs: 5,
            preferCache: true,
            allowStale: true,
        });

        expect(result).toEqual(cachedTemplates);
        expect(addEvent.mock.calls).toEqual([
            [
                "mcp.metadata_fetch_started",
                expect.objectContaining({
                    "server.name": "test-server",
                    "mcp.metadata.kind": "resource_templates",
                    "mcp.fetch.source": "network",
                    "mcp.timeout_ms": 5,
                }),
            ],
            [
                "mcp.metadata_fetch_failed",
                expect.objectContaining({
                    "server.name": "test-server",
                    "mcp.metadata.kind": "resource_templates",
                    "mcp.fetch.source": "network",
                }),
            ],
            [
                "mcp.metadata_stale_cache_fallback",
                expect.objectContaining({
                    "server.name": "test-server",
                    "mcp.metadata.kind": "resource_templates",
                    "mcp.fetch.source": "stale_cache_fallback",
                    "mcp.result.count": 1,
                    "mcp.timeout_ms": 5,
                }),
            ],
        ]);
    });
});
