import { describe, expect, it } from "bun:test";

/**
 * Test suite for mcp__tenex__* tool filtering in ProjectStatusService.
 *
 * Kind 24010 (TenexProjectStatus) events should NOT include tools with the
 * mcp__tenex__ prefix. These are internal TENEX tools wrapped through MCP
 * and should not be announced in status events.
 *
 * This test validates the filtering logic at the gatherToolInfo level.
 */
describe("ProjectStatusService mcp__tenex__ filtering", () => {
    /**
     * Test the filtering logic directly without full ProjectStatusService setup.
     * This validates that the filtering pattern works correctly.
     */
    describe("mcp__tenex__ prefix filtering pattern", () => {
        const filterMcpTenexTools = (toolName: string): boolean => {
            // This mirrors the filtering logic in ProjectStatusService.gatherToolInfo
            return toolName.startsWith("mcp__") && !toolName.startsWith("mcp__tenex__");
        };

        it("should exclude mcp__tenex__ tools", () => {
            expect(filterMcpTenexTools("mcp__tenex__schedule_task")).toBe(false);
            expect(filterMcpTenexTools("mcp__tenex__schedule_task_cancel")).toBe(false);
            expect(filterMcpTenexTools("mcp__tenex__lesson_learn")).toBe(false);
            expect(filterMcpTenexTools("mcp__tenex__report_write")).toBe(false);
            expect(filterMcpTenexTools("mcp__tenex__delegate")).toBe(false);
            expect(filterMcpTenexTools("mcp__tenex__ask")).toBe(false);
        });

        it("should include other mcp__ tools (non-tenex)", () => {
            expect(filterMcpTenexTools("mcp__filesystem__read")).toBe(true);
            expect(filterMcpTenexTools("mcp__github__issues")).toBe(true);
            expect(filterMcpTenexTools("mcp__slack__post_message")).toBe(true);
            expect(filterMcpTenexTools("mcp__custom_server__tool")).toBe(true);
        });

        it("should not affect non-mcp tools", () => {
            // Non-mcp tools return false because they don't start with mcp__
            expect(filterMcpTenexTools("delegate")).toBe(false);
            expect(filterMcpTenexTools("fs_read")).toBe(false);
            expect(filterMcpTenexTools("bash")).toBe(false);
        });
    });

    describe("toolAgentMap filtering simulation", () => {
        /**
         * Simulates the filtering applied when building toolAgentMap from cached MCP tools
         */
        it("should filter mcp__tenex__ tools when building from cached tools", () => {
            const cachedMcpTools: Record<string, unknown> = {
                "mcp__tenex__schedule_task": {},
                "mcp__tenex__schedule_task_cancel": {},
                "mcp__tenex__delegate": {},
                "mcp__github__issues": {},
                "mcp__filesystem__read": {},
            };

            const toolAgentMap = new Map<string, Set<string>>();

            // Simulate the filtering logic from gatherToolInfo
            for (const toolName of Object.keys(cachedMcpTools)) {
                if (toolName && !toolAgentMap.has(toolName) && !toolName.startsWith("mcp__tenex__")) {
                    toolAgentMap.set(toolName, new Set());
                }
            }

            // mcp__tenex__ tools should be excluded
            expect(toolAgentMap.has("mcp__tenex__schedule_task")).toBe(false);
            expect(toolAgentMap.has("mcp__tenex__schedule_task_cancel")).toBe(false);
            expect(toolAgentMap.has("mcp__tenex__delegate")).toBe(false);

            // Other mcp tools should be included
            expect(toolAgentMap.has("mcp__github__issues")).toBe(true);
            expect(toolAgentMap.has("mcp__filesystem__read")).toBe(true);
        });

        /**
         * Simulates the filtering applied when building toolAgentMap from agent tools
         */
        it("should filter mcp__tenex__ tools when adding from agent tools", () => {
            const agentTools = [
                "mcp__tenex__lesson_learn",
                "mcp__tenex__report_write",
                "mcp__tenex__ask",
                "mcp__slack__post_message",
                "mcp__linear__create_issue",
                "fs_read",
                "bash",
            ];

            const toolAgentMap = new Map<string, Set<string>>();

            // Simulate the filtering logic from gatherToolInfo (MCP tools section)
            for (const toolName of agentTools) {
                if (toolName.startsWith("mcp__") && !toolName.startsWith("mcp__tenex__")) {
                    let agentSet = toolAgentMap.get(toolName);
                    if (!agentSet) {
                        agentSet = new Set();
                        toolAgentMap.set(toolName, agentSet);
                    }
                    agentSet.add("test-agent");
                }
            }

            // mcp__tenex__ tools should be excluded
            expect(toolAgentMap.has("mcp__tenex__lesson_learn")).toBe(false);
            expect(toolAgentMap.has("mcp__tenex__report_write")).toBe(false);
            expect(toolAgentMap.has("mcp__tenex__ask")).toBe(false);

            // Other mcp tools should be included with agent association
            expect(toolAgentMap.has("mcp__slack__post_message")).toBe(true);
            expect(toolAgentMap.get("mcp__slack__post_message")?.has("test-agent")).toBe(true);
            expect(toolAgentMap.has("mcp__linear__create_issue")).toBe(true);
            expect(toolAgentMap.get("mcp__linear__create_issue")?.has("test-agent")).toBe(true);

            // Non-mcp tools are NOT added by this logic (handled elsewhere)
            expect(toolAgentMap.has("fs_read")).toBe(false);
            expect(toolAgentMap.has("bash")).toBe(false);
        });
    });

    /**
     * Test that MCP tools from agent definitions are only included if they
     * actually exist in running MCP servers (validMcpToolNames set)
     */
    describe("MCP tool validation against running servers", () => {
        /**
         * Simulates the new filtering logic that validates agent MCP tools
         * against the set of tools available from running MCP servers
         */
        it("should only include agent MCP tools that exist in running MCP servers", () => {
            // Simulate tools returned by getCachedTools() from running MCP servers
            const cachedMcpTools: Record<string, unknown> = {
                mcp__github__issues: {},
                mcp__github__pulls: {},
                mcp__slack__post_message: {},
            };

            // Build validMcpToolNames set (as done in gatherToolInfo)
            const validMcpToolNames = new Set<string>();
            for (const toolName of Object.keys(cachedMcpTools)) {
                if (toolName && !toolName.startsWith("mcp__tenex__")) {
                    validMcpToolNames.add(toolName);
                }
            }

            // Agent definition includes tools that may or may not be available
            const agentTools = [
                "mcp__github__issues", // Available - should be included
                "mcp__linear__create_issue", // NOT available - should be excluded
                "mcp__notion__read_page", // NOT available - should be excluded
                "mcp__slack__post_message", // Available - should be included
            ];

            const toolAgentMap = new Map<string, Set<string>>();
            // First, add valid MCP tools to the map (as done in gatherToolInfo)
            for (const toolName of validMcpToolNames) {
                toolAgentMap.set(toolName, new Set());
            }

            // Then, add agents to MCP tools (new logic with validation)
            for (const toolName of agentTools) {
                if (toolName.startsWith("mcp__") && validMcpToolNames.has(toolName)) {
                    const agentSet = toolAgentMap.get(toolName);
                    if (agentSet) {
                        agentSet.add("test-agent");
                    }
                }
            }

            // Tools from running servers should be in the map
            expect(toolAgentMap.has("mcp__github__issues")).toBe(true);
            expect(toolAgentMap.get("mcp__github__issues")?.has("test-agent")).toBe(true);
            expect(toolAgentMap.has("mcp__slack__post_message")).toBe(true);
            expect(toolAgentMap.get("mcp__slack__post_message")?.has("test-agent")).toBe(true);

            // Tools NOT from running servers should NOT be in the map
            expect(toolAgentMap.has("mcp__linear__create_issue")).toBe(false);
            expect(toolAgentMap.has("mcp__notion__read_page")).toBe(false);
        });

        it("should have no MCP tools when no MCP servers are running", () => {
            // No running MCP servers = empty cached tools
            const cachedMcpTools: Record<string, unknown> = {};

            // Build validMcpToolNames set (empty)
            const validMcpToolNames = new Set<string>();
            for (const toolName of Object.keys(cachedMcpTools)) {
                if (toolName && !toolName.startsWith("mcp__tenex__")) {
                    validMcpToolNames.add(toolName);
                }
            }

            // Agent definition includes MCP tools
            const agentTools = [
                "mcp__github__issues",
                "mcp__linear__create_issue",
                "mcp__slack__post_message",
            ];

            const toolAgentMap = new Map<string, Set<string>>();
            // First, add valid MCP tools to the map (none in this case)
            for (const toolName of validMcpToolNames) {
                toolAgentMap.set(toolName, new Set());
            }

            // Then, add agents to MCP tools
            for (const toolName of agentTools) {
                if (toolName.startsWith("mcp__") && validMcpToolNames.has(toolName)) {
                    const agentSet = toolAgentMap.get(toolName);
                    if (agentSet) {
                        agentSet.add("test-agent");
                    }
                }
            }

            // NO mcp__ tools should be in the map
            expect(toolAgentMap.has("mcp__github__issues")).toBe(false);
            expect(toolAgentMap.has("mcp__linear__create_issue")).toBe(false);
            expect(toolAgentMap.has("mcp__slack__post_message")).toBe(false);
            expect(toolAgentMap.size).toBe(0);
        });

        it("should handle agents with only unavailable MCP tools", () => {
            // Running server has github tools
            const cachedMcpTools: Record<string, unknown> = {
                mcp__github__issues: {},
            };

            const validMcpToolNames = new Set<string>();
            for (const toolName of Object.keys(cachedMcpTools)) {
                if (toolName && !toolName.startsWith("mcp__tenex__")) {
                    validMcpToolNames.add(toolName);
                }
            }

            // Agent only has linear tools (not available)
            const agentTools = [
                "mcp__linear__create_issue",
                "mcp__linear__list_issues",
            ];

            const toolAgentMap = new Map<string, Set<string>>();
            for (const toolName of validMcpToolNames) {
                toolAgentMap.set(toolName, new Set());
            }

            for (const toolName of agentTools) {
                if (toolName.startsWith("mcp__") && validMcpToolNames.has(toolName)) {
                    const agentSet = toolAgentMap.get(toolName);
                    if (agentSet) {
                        agentSet.add("test-agent");
                    }
                }
            }

            // github tool exists but has no agents
            expect(toolAgentMap.has("mcp__github__issues")).toBe(true);
            expect(toolAgentMap.get("mcp__github__issues")?.size).toBe(0);

            // linear tools don't exist
            expect(toolAgentMap.has("mcp__linear__create_issue")).toBe(false);
            expect(toolAgentMap.has("mcp__linear__list_issues")).toBe(false);
        });
    });

    describe("edge cases", () => {
        it("should handle empty tool names", () => {
            const toolName = "";
            const shouldInclude = toolName.startsWith("mcp__") && !toolName.startsWith("mcp__tenex__");
            expect(shouldInclude).toBe(false);
        });

        it("should handle mcp__tenex (without trailing underscore) correctly", () => {
            // "mcp__tenex" (without trailing __) should be included
            // because it doesn't match "mcp__tenex__" prefix
            const toolName = "mcp__tenex";
            const shouldInclude = toolName.startsWith("mcp__") && !toolName.startsWith("mcp__tenex__");
            expect(shouldInclude).toBe(true);
        });

        it("should handle case-sensitive matching", () => {
            // Tool names are case-sensitive, MCP__TENEX__ is not the same as mcp__tenex__
            const toolName = "MCP__TENEX__something";
            const shouldInclude = toolName.startsWith("mcp__") && !toolName.startsWith("mcp__tenex__");
            expect(shouldInclude).toBe(false); // Doesn't start with lowercase mcp__
        });
    });
});

/**
 * Integration tests for ProjectStatusService.gatherToolInfo
 *
 * These tests instantiate the real ProjectStatusService and verify the actual
 * behavior with mocked dependencies, ensuring end-to-end filtering works correctly.
 */
import { ProjectStatusService } from "../ProjectStatusService";
import type { StatusIntent } from "@/nostr/types";
import type { ProjectContext } from "@/services/projects";
import type { AgentInstance } from "@/agents/types";
import type { MCPManager } from "@/services/mcp/MCPManager";
import type { AgentRegistry } from "@/agents/AgentRegistry";
import { projectContextStore } from "@/services/projects";

describe("ProjectStatusService.gatherToolInfo integration", () => {
    /**
     * Creates a minimal mock ProjectContext for testing gatherToolInfo.
     */
    function createMockProjectContext(options: {
        agents: Map<string, AgentInstance>;
        mcpCachedTools: Record<string, unknown>;
    }): ProjectContext {
        const mockAgentRegistry = {
            getAllAgentsMap: () => options.agents,
        } as unknown as AgentRegistry;

        const mockMcpManager = {
            getCachedTools: () => options.mcpCachedTools,
        } as unknown as MCPManager;

        return {
            agentRegistry: mockAgentRegistry,
            mcpManager: mockMcpManager,
            // Minimal project mock - only needed fields
            project: {
                tags: [],
                tagValue: () => undefined,
                tagReference: () => ["a", "test"],
                pubkey: "mock-pubkey",
            },
        } as unknown as ProjectContext;
    }

    /**
     * Creates a minimal mock agent for testing.
     */
    function createTestAgent(slug: string, tools: string[]): AgentInstance {
        return {
            name: `Test ${slug}`,
            pubkey: `pubkey-${slug}`,
            slug,
            tools,
            eventId: `event-${slug}`,
        } as unknown as AgentInstance;
    }

    /**
     * Accesses the private gatherToolInfo method for testing.
     * This is a common pattern in TypeScript testing.
     */
    async function callGatherToolInfo(
        service: ProjectStatusService,
        intent: StatusIntent
    ): Promise<void> {
        // Access private method for testing
        await (service as unknown as { gatherToolInfo(intent: StatusIntent): Promise<void> }).gatherToolInfo(intent);
    }

    it("should filter mcp__tenex__ tools from intent.tools when agent defines them", async () => {
        // Setup: Agent has both mcp__tenex__ tools and regular MCP tools
        const agents = new Map<string, AgentInstance>();
        agents.set("test-agent", createTestAgent("test-agent", [
            "mcp__tenex__delegate",
            "mcp__tenex__lesson_learn",
            "mcp__github__issues",
            "mcp__slack__post_message",
            "fs_read",
        ]));

        // MCPManager has all these tools available (simulating running MCP servers)
        const mcpCachedTools = {
            "mcp__tenex__delegate": {},
            "mcp__tenex__lesson_learn": {},
            "mcp__github__issues": {},
            "mcp__slack__post_message": {},
        };

        const mockContext = createMockProjectContext({ agents, mcpCachedTools });
        const service = new ProjectStatusService();

        // Set projectContext to avoid needing AsyncLocalStorage
        (service as unknown as { projectContext: ProjectContext }).projectContext = mockContext;

        const intent: StatusIntent = {
            type: "status",
            agents: [],
            models: [],
            tools: [],
        };

        // Run within projectContextStore to satisfy isProjectContextInitialized() check
        await projectContextStore.run(mockContext, async () => {
            await callGatherToolInfo(service, intent);
        });

        // Verify: mcp__tenex__ tools should NOT be in the tools list
        const toolNames = intent.tools.map((t) => t.name);
        expect(toolNames).not.toContain("mcp__tenex__delegate");
        expect(toolNames).not.toContain("mcp__tenex__lesson_learn");

        // Verify: Regular MCP tools SHOULD be in the tools list (with agent assigned)
        const githubTool = intent.tools.find((t) => t.name === "mcp__github__issues");
        expect(githubTool).toBeDefined();
        expect(githubTool?.agents).toContain("test-agent");

        const slackTool = intent.tools.find((t) => t.name === "mcp__slack__post_message");
        expect(slackTool).toBeDefined();
        expect(slackTool?.agents).toContain("test-agent");
    });

    it("should not include MCP tools from agent definition if not in MCPManager", async () => {
        // Setup: Agent defines MCP tools, but MCPManager doesn't have them
        const agents = new Map<string, AgentInstance>();
        agents.set("test-agent", createTestAgent("test-agent", [
            "mcp__github__issues",       // Available in MCPManager
            "mcp__linear__create_issue", // NOT available in MCPManager
            "mcp__notion__read_page",    // NOT available in MCPManager
        ]));

        // MCPManager only has github tools
        const mcpCachedTools = {
            "mcp__github__issues": {},
            "mcp__github__pulls": {},
        };

        const mockContext = createMockProjectContext({ agents, mcpCachedTools });
        const service = new ProjectStatusService();
        (service as unknown as { projectContext: ProjectContext }).projectContext = mockContext;

        const intent: StatusIntent = {
            type: "status",
            agents: [],
            models: [],
            tools: [],
        };

        await projectContextStore.run(mockContext, async () => {
            await callGatherToolInfo(service, intent);
        });

        const toolNames = intent.tools.map((t) => t.name);

        // github tools should be present (available in MCPManager)
        expect(toolNames).toContain("mcp__github__issues");
        expect(toolNames).toContain("mcp__github__pulls");

        // linear and notion tools should NOT be present (not in MCPManager)
        expect(toolNames).not.toContain("mcp__linear__create_issue");
        expect(toolNames).not.toContain("mcp__notion__read_page");

        // Verify agent assignment for available tool
        const githubTool = intent.tools.find((t) => t.name === "mcp__github__issues");
        expect(githubTool?.agents).toContain("test-agent");

        // github pulls is in MCPManager but agent doesn't have it, so no agent assigned
        const pullsTool = intent.tools.find((t) => t.name === "mcp__github__pulls");
        expect(pullsTool?.agents).toEqual([]);
    });

    it("should handle the end-to-end scenario: agent defines mcp__tenex__ tool that MCPManager has, tool should not appear in 24010", async () => {
        // This is the critical test case:
        // Agent definition includes mcp__tenex__ask
        // MCPManager HAS mcp__tenex__ask (because TENEX wraps its own tools via MCP)
        // The tool should STILL be filtered out from the 24010 event

        const agents = new Map<string, AgentInstance>();
        agents.set("coordinator", createTestAgent("coordinator", [
            "mcp__tenex__delegate",
            "mcp__tenex__ask",
            "mcp__tenex__lesson_learn",
            "mcp__tenex__report_write",
        ]));

        // Simulate MCPManager having all TENEX tools (as would happen in real system)
        const mcpCachedTools = {
            "mcp__tenex__delegate": {},
            "mcp__tenex__ask": {},
            "mcp__tenex__lesson_learn": {},
            "mcp__tenex__report_write": {},
            "mcp__tenex__todo_write": {},
        };

        const mockContext = createMockProjectContext({ agents, mcpCachedTools });
        const service = new ProjectStatusService();
        (service as unknown as { projectContext: ProjectContext }).projectContext = mockContext;

        const intent: StatusIntent = {
            type: "status",
            agents: [],
            models: [],
            tools: [],
        };

        await projectContextStore.run(mockContext, async () => {
            await callGatherToolInfo(service, intent);
        });

        // Critical assertion: NO mcp__tenex__ tools should appear in the output
        const mcpTenexTools = intent.tools.filter((t) => t.name.startsWith("mcp__tenex__"));
        expect(mcpTenexTools).toHaveLength(0);
    });
});
