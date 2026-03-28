import { describe, expect, it, spyOn } from "bun:test";
import { MCPManager } from "../MCPManager";
import type { MCPServerConfig, TenexMCP } from "@/services/config/types";

function setPendingConfig(manager: MCPManager, config: TenexMCP): void {
    // @ts-expect-error Accessing private state for focused unit tests
    manager.pendingConfig = config;
}

function getClients(manager: MCPManager): Map<string, unknown> {
    // @ts-expect-error Accessing private state for focused unit tests
    return manager.clients;
}

function makeClientEntry(
    name: string,
    config: MCPServerConfig
): { client: never; transport: never; serverName: string; config: MCPServerConfig } {
    return {
        client: {} as never,
        transport: {} as never,
        serverName: name,
        config,
    };
}

describe("MCPManager startup serialization", () => {
    it("serializes concurrent targeted startup for the same server", async () => {
        const manager = new MCPManager();
        const serverConfig: MCPServerConfig = {
            command: "node",
            args: ["server.js"],
        };
        setPendingConfig(manager, {
            enabled: true,
            servers: {
                github: serverConfig,
            },
        });

        let releaseStart!: () => void;
        const startGate = new Promise<void>((resolve) => {
            releaseStart = resolve;
        });

        const refreshToolCacheSpy = spyOn(manager as never, "refreshToolCache").mockResolvedValue();
        const startServerSpy = spyOn(manager as never, "startServer").mockImplementation(
            async (name: string, config: MCPServerConfig) => {
                await startGate;
                getClients(manager).set(name, makeClientEntry(name, config));
            }
        );

        try {
            const first = manager.ensureServersForTools(["mcp__github__issues"]);
            const second = manager.ensureServersForTools(["mcp__github__pulls"]);

            releaseStart();
            await Promise.all([first, second]);

            expect(startServerSpy).toHaveBeenCalledTimes(1);
            expect(manager.isServerRunning("github")).toBe(true);
        } finally {
            startServerSpy.mockRestore();
            refreshToolCacheSpy.mockRestore();
        }
    });

    it("continues with full startup after waiting on targeted startup", async () => {
        const manager = new MCPManager();
        const githubConfig: MCPServerConfig = {
            command: "node",
            args: ["github.js"],
        };
        const slackConfig: MCPServerConfig = {
            command: "node",
            args: ["slack.js"],
        };
        setPendingConfig(manager, {
            enabled: true,
            servers: {
                github: githubConfig,
                slack: slackConfig,
            },
        });

        let releaseGithubStart!: () => void;
        const githubGate = new Promise<void>((resolve) => {
            releaseGithubStart = resolve;
        });

        const refreshToolCacheSpy = spyOn(manager as never, "refreshToolCache").mockResolvedValue();
        const startServerSpy = spyOn(manager as never, "startServer").mockImplementation(
            async (name: string, config: MCPServerConfig) => {
                if (getClients(manager).has(name)) {
                    return;
                }
                if (name === "github") {
                    await githubGate;
                }
                getClients(manager).set(name, makeClientEntry(name, config));
            }
        );
        const startDeferredServersSpy = spyOn(
            manager as never,
            "startDeferredServers"
        ).mockImplementation(async () => {
            // @ts-expect-error Accessing private state for focused unit tests
            const pendingConfig = manager.pendingConfig as TenexMCP | null;
            if (!pendingConfig) {
                return;
            }

            // @ts-expect-error Accessing private state for focused unit tests
            manager.pendingConfig = null;
            // @ts-expect-error Accessing private state for focused unit tests
            manager.serversStarted = true;

            for (const [name, config] of Object.entries(pendingConfig.servers)) {
                if (!getClients(manager).has(name)) {
                    getClients(manager).set(name, makeClientEntry(name, config));
                }
            }
        });

        try {
            const targetedStart = manager.ensureServersForTools(["mcp__github__issues"]);
            const fullStart = manager.ensureReady();

            releaseGithubStart();
            await Promise.all([targetedStart, fullStart]);

            expect(startDeferredServersSpy).toHaveBeenCalledTimes(1);
            expect(manager.isServerRunning("github")).toBe(true);
            expect(manager.isServerRunning("slack")).toBe(true);
        } finally {
            startDeferredServersSpy.mockRestore();
            startServerSpy.mockRestore();
            refreshToolCacheSpy.mockRestore();
        }
    });
});
