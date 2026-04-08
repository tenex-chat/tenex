import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createAgentInstance } from "../agent-loader";
import { createStoredAgent } from "../AgentStorage";
import type { AgentRegistry } from "../AgentRegistry";
import type { MCPConfig } from "@/llm/providers/types";
import { config } from "@/services/ConfigService";
import { SkillWhitelistService } from "@/services/skill";
import { SkillService } from "@/services/skill/SkillService";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

/**
 * Tests for MCP config merging behavior in createAgentInstance.
 *
 * When both project-level MCP config (passed via options.mcpConfig) and
 * agent-specific MCP config (stored in agent.mcpServers) exist, they should
 * be MERGED rather than one overriding the other.
 *
 * Agent-specific servers take precedence on name collision.
 */
describe("MCP Config Merge", () => {
    // Mock registry with minimal implementation
    const mockRegistry: AgentRegistry = {
        getMetadataPath: () => "/tmp/test-metadata",
        getBasePath: () => "/tmp/test",
        getProjectDTag: () => "test-project",
    } as unknown as AgentRegistry;

    // Track what mcpConfig was passed to createLLMService
    let capturedMcpConfig: MCPConfig | undefined;
    let whitelistServiceSpy: ReturnType<typeof spyOn>;
    let skillServiceSpy: ReturnType<typeof spyOn>;
    let warnSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        capturedMcpConfig = undefined;
        SkillWhitelistService.getInstance().setInstalledSkills([]);
        skillServiceSpy = spyOn(SkillService, "getInstance").mockReturnValue({
            listAvailableSkills: mock(async () => []),
        } as never);
        whitelistServiceSpy = spyOn(SkillWhitelistService.getInstance(), "getWhitelistedSkills").mockReturnValue([]);
        warnSpy = spyOn(logger, "warn").mockImplementation(() => undefined);

        spyOn(config, "createLLMService").mockImplementation(
            (_configName: string, options: { mcpConfig?: MCPConfig }) => {
                capturedMcpConfig = options.mcpConfig;
                return { mock: true } as any;
            }
        );
    });

    afterEach(() => {
        SkillWhitelistService.getInstance().setInstalledSkills([]);
        whitelistServiceSpy?.mockRestore();
        skillServiceSpy?.mockRestore();
        warnSpy?.mockRestore();
        mock.restore();
    });

    describe("createAgentInstance MCP config merging", () => {
        it("should merge project-level and agent-specific MCP configs", async () => {
            const signer = NDKPrivateKeySigner.generate();

            // Agent has its own MCP server configured
            const storedAgent = createStoredAgent({
                nsec: signer.nsec!,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                eventId: "test-event-id",
                mcpServers: {
                    "agent-server": {
                        command: "agent-mcp-server",
                        args: ["--agent-flag"],
                    },
                },
            });

            const instance = await createAgentInstance(storedAgent, mockRegistry);

            // Project-level MCP config passed during createLLMService call
            const projectMcpConfig: MCPConfig = {
                enabled: true,
                servers: {
                    "project-server": {
                        command: "project-mcp-server",
                        args: ["--project-flag"],
                    },
                },
            };

            // Call createLLMService with project-level config
            instance.createLLMService({ mcpConfig: projectMcpConfig });

            // Both servers should be present in merged config
            expect(capturedMcpConfig).toBeDefined();
            expect(capturedMcpConfig?.enabled).toBe(true);
            expect(capturedMcpConfig?.servers["project-server"]).toBeDefined();
            expect(capturedMcpConfig?.servers["agent-server"]).toBeDefined();
            expect(capturedMcpConfig?.servers["project-server"].command).toBe(
                "project-mcp-server"
            );
            expect(capturedMcpConfig?.servers["agent-server"].command).toBe(
                "agent-mcp-server"
            );
        });

        it("should give agent-specific servers precedence on name collision", async () => {
            const signer = NDKPrivateKeySigner.generate();

            // Agent has a server named "shared-server" with agent-specific config
            const storedAgent = createStoredAgent({
                nsec: signer.nsec!,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                eventId: "test-event-id",
                mcpServers: {
                    "shared-server": {
                        command: "agent-version",
                        args: ["--agent-specific"],
                    },
                },
            });

            const instance = await createAgentInstance(storedAgent, mockRegistry);

            // Project-level config also has "shared-server" with different config
            const projectMcpConfig: MCPConfig = {
                enabled: true,
                servers: {
                    "shared-server": {
                        command: "project-version",
                        args: ["--project-specific"],
                    },
                },
            };

            instance.createLLMService({ mcpConfig: projectMcpConfig });

            // Agent-specific config should win the collision
            expect(capturedMcpConfig).toBeDefined();
            expect(capturedMcpConfig?.servers["shared-server"].command).toBe(
                "agent-version"
            );
            expect(capturedMcpConfig?.servers["shared-server"].args).toEqual([
                "--agent-specific",
            ]);
        });

        it("should use only project MCP config when agent has no MCP servers", async () => {
            const signer = NDKPrivateKeySigner.generate();

            // Agent has no MCP servers configured
            const storedAgent = createStoredAgent({
                nsec: signer.nsec!,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                eventId: "test-event-id",
            });

            const instance = await createAgentInstance(storedAgent, mockRegistry);

            const projectMcpConfig: MCPConfig = {
                enabled: true,
                servers: {
                    "project-only-server": {
                        command: "project-mcp",
                        args: [],
                    },
                },
            };

            instance.createLLMService({ mcpConfig: projectMcpConfig });

            // Should use project config directly
            expect(capturedMcpConfig).toBeDefined();
            expect(capturedMcpConfig?.servers["project-only-server"]).toBeDefined();
        });

        it("should use only agent MCP config when no project config passed", async () => {
            const signer = NDKPrivateKeySigner.generate();

            const storedAgent = createStoredAgent({
                nsec: signer.nsec!,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                eventId: "test-event-id",
                mcpServers: {
                    "agent-only-server": {
                        command: "agent-mcp",
                        args: [],
                    },
                },
            });

            const instance = await createAgentInstance(storedAgent, mockRegistry);

            // No mcpConfig passed to createLLMService
            instance.createLLMService({});

            // Should use agent config directly
            expect(capturedMcpConfig).toBeDefined();
            expect(capturedMcpConfig?.servers["agent-only-server"]).toBeDefined();
        });

        it("should have undefined MCP config when neither agent nor project has config", async () => {
            const signer = NDKPrivateKeySigner.generate();

            const storedAgent = createStoredAgent({
                nsec: signer.nsec!,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                eventId: "test-event-id",
            });

            const instance = await createAgentInstance(storedAgent, mockRegistry);

            instance.createLLMService({});

            expect(capturedMcpConfig).toBeUndefined();
        });

        it("should filter blocked alwaysSkills at load time", async () => {
            const signer = NDKPrivateKeySigner.generate();

            skillServiceSpy.mockReturnValue({
                listAvailableSkills: mock(async () => [
                    {
                        identifier: "local-skill",
                        eventId: "a".repeat(64),
                        content: "",
                        installedFiles: [],
                    },
                ]),
            } as never);

            const storedAgent = createStoredAgent({
                nsec: signer.nsec!,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                eventId: "test-event-id",
                defaultConfig: {
                    skills: ["local-skill"],
                    blockedSkills: ["a".repeat(64)],
                },
            });

            const instance = await createAgentInstance(storedAgent, mockRegistry);

            expect(instance.alwaysSkills).toBeUndefined();
            expect(instance.blockedSkills).toEqual(["a".repeat(64)]);
            expect(warnSpy).toHaveBeenCalledWith(
                "[AgentLoader] Blocked skills removed from alwaysSkills",
                expect.objectContaining({
                    agent: "test-agent",
                    blockedSkills: ["local-skill"],
                })
            );
        });

        it("should respect project-level enabled:false when merging configs", async () => {
            const signer = NDKPrivateKeySigner.generate();

            // Agent has MCP servers configured
            const storedAgent = createStoredAgent({
                nsec: signer.nsec!,
                slug: "test-agent",
                name: "Test Agent",
                role: "assistant",
                eventId: "test-event-id",
                mcpServers: {
                    "agent-server": {
                        command: "agent-mcp-server",
                        args: ["--agent-flag"],
                    },
                },
            });

            const instance = await createAgentInstance(storedAgent, mockRegistry);

            // Project-level MCP config explicitly disables MCP
            const projectMcpConfig: MCPConfig = {
                enabled: false,
                servers: {
                    "project-server": {
                        command: "project-mcp-server",
                        args: ["--project-flag"],
                    },
                },
            };

            instance.createLLMService({ mcpConfig: projectMcpConfig });

            // Merged config should have enabled: false (respecting project-level)
            expect(capturedMcpConfig).toBeDefined();
            expect(capturedMcpConfig?.enabled).toBe(false);
            // Servers should still be merged
            expect(capturedMcpConfig?.servers["project-server"]).toBeDefined();
            expect(capturedMcpConfig?.servers["agent-server"]).toBeDefined();
        });
    });
});
