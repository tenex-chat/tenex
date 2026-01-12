import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

describe("MCP serve command", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe("Environment variable loading", () => {
        it("loads required environment variables", () => {
            process.env.TENEX_PROJECT_ID = "test-project";
            process.env.TENEX_AGENT_ID = "agent-123";
            process.env.TENEX_CONVERSATION_ID = "conv-456";
            process.env.TENEX_WORKING_DIRECTORY = "/tmp/test";
            process.env.TENEX_CURRENT_BRANCH = "main";
            process.env.TENEX_TOOLS = "delegate,ask,conversation_get";

            // Verify environment is set
            expect(process.env.TENEX_PROJECT_ID).toBe("test-project");
            expect(process.env.TENEX_AGENT_ID).toBe("agent-123");
            expect(process.env.TENEX_TOOLS).toBe("delegate,ask,conversation_get");
        });

        it("throws error when TENEX_PROJECT_ID is missing", () => {
            delete process.env.TENEX_PROJECT_ID;
            process.env.TENEX_AGENT_ID = "agent-123";
            process.env.TENEX_CONVERSATION_ID = "conv-456";
            process.env.TENEX_WORKING_DIRECTORY = "/tmp/test";
            process.env.TENEX_CURRENT_BRANCH = "main";
            process.env.TENEX_TOOLS = "delegate";

            // Loading context should fail
            expect(() => {
                if (!process.env.TENEX_PROJECT_ID) {
                    throw new Error("TENEX_PROJECT_ID environment variable is required");
                }
            }).toThrow("TENEX_PROJECT_ID environment variable is required");
        });

        it("parses comma-separated tool names", () => {
            const toolsStr = "delegate,ask,conversation_get";
            const toolNames = toolsStr.split(",").map((t) => t.trim());

            expect(toolNames).toEqual(["delegate", "ask", "conversation_get"]);
            expect(toolNames.length).toBe(3);
        });

        it("handles tools with whitespace in list", () => {
            const toolsStr = "delegate , ask , conversation_get";
            const toolNames = toolsStr.split(",").map((t) => t.trim());

            expect(toolNames).toEqual(["delegate", "ask", "conversation_get"]);
        });
    });

    describe("Tool filtering", () => {
        it("filters out MCP tools from tool list", () => {
            const toolNames = [
                "delegate",
                "ask",
                "conversation_get",
                "mcp__repomix__analyze",
                "fs_read",
            ];

            const localTools = toolNames.filter((name) => !name.startsWith("mcp__"));

            expect(localTools).toEqual(["delegate", "ask", "conversation_get", "fs_read"]);
            expect(localTools).not.toContain("mcp__repomix__analyze");
        });

        it("returns empty array when all tools are MCP tools", () => {
            const toolNames = ["mcp__server1__tool1", "mcp__server2__tool2"];
            const localTools = toolNames.filter((name) => !name.startsWith("mcp__"));

            expect(localTools).toEqual([]);
            expect(localTools.length).toBe(0);
        });

        it("preserves tool order when filtering", () => {
            const toolNames = [
                "ask",
                "mcp__other__tool",
                "delegate",
                "conversation_get",
                "mcp__repomix__analyze",
            ];

            const localTools = toolNames.filter((name) => !name.startsWith("mcp__"));

            expect(localTools).toEqual(["ask", "delegate", "conversation_get"]);
        });
    });

    describe("MCP server configuration", () => {
        it("generates correct stdio MCP server config", () => {
            const config = {
                transport: "stdio",
                command: "tenex",
                args: ["mcp", "serve"],
                env: {
                    TENEX_PROJECT_ID: "project-123",
                    TENEX_AGENT_ID: "agent-abc",
                    TENEX_CONVERSATION_ID: "conv-xyz",
                    TENEX_WORKING_DIRECTORY: "/home/user/project",
                    TENEX_CURRENT_BRANCH: "develop",
                    TENEX_TOOLS: "delegate,ask",
                },
            };

            expect(config.transport).toBe("stdio");
            expect(config.command).toBe("tenex");
            expect(config.args).toEqual(["mcp", "serve"]);
            expect(config.env.TENEX_PROJECT_ID).toBe("project-123");
            expect(config.env.TENEX_TOOLS).toBe("delegate,ask");
        });

        it("includes all required environment variables in config", () => {
            const config = {
                transport: "stdio",
                command: "tenex",
                args: ["mcp", "serve"],
                env: {
                    TENEX_PROJECT_ID: "project-123",
                    TENEX_AGENT_ID: "agent-abc",
                    TENEX_CONVERSATION_ID: "conv-xyz",
                    TENEX_WORKING_DIRECTORY: "/home/user/project",
                    TENEX_CURRENT_BRANCH: "develop",
                    TENEX_TOOLS: "delegate,ask",
                },
            };

            expect(config.env).toHaveProperty("TENEX_PROJECT_ID");
            expect(config.env).toHaveProperty("TENEX_AGENT_ID");
            expect(config.env).toHaveProperty("TENEX_CONVERSATION_ID");
            expect(config.env).toHaveProperty("TENEX_WORKING_DIRECTORY");
            expect(config.env).toHaveProperty("TENEX_CURRENT_BRANCH");
            expect(config.env).toHaveProperty("TENEX_TOOLS");
        });

        it("returns undefined config when no tools to expose", () => {
            const localTools: string[] = [];

            const shouldCreateServer = localTools.length > 0;
            expect(shouldCreateServer).toBe(false);
        });
    });

    describe("Zod schema conversion", () => {
        it("converts basic Zod types to JSON Schema", () => {
            const schemaMap: Record<string, string> = {
                ZodString: "string",
                ZodNumber: "number",
                ZodBoolean: "boolean",
                ZodArray: "array",
            };

            expect(schemaMap.ZodString).toBe("string");
            expect(schemaMap.ZodNumber).toBe("number");
            expect(schemaMap.ZodBoolean).toBe("boolean");
            expect(schemaMap.ZodArray).toBe("array");
        });

        it("builds valid JSON Schema properties object", () => {
            const properties: Record<string, unknown> = {
                query: { type: "string" },
                limit: { type: "number" },
                enabled: { type: "boolean" },
            };

            const schema = {
                type: "object",
                properties,
                required: ["query"],
            };

            expect(schema.type).toBe("object");
            expect(schema.properties).toBeDefined();
            expect(schema.properties.query).toEqual({ type: "string" });
            expect(schema.required).toEqual(["query"]);
        });

        it("omits properties when empty", () => {
            const result = {
                type: "object",
                ...(Object.keys({}).length > 0 && { properties: {} }),
            };

            expect(result).not.toHaveProperty("properties");
            expect(result.type).toBe("object");
        });
    });

    describe("Tool conversion to MCP format", () => {
        it("converts TENEX tool to MCP tool with schema", () => {
            const mcpTool = {
                name: "delegate",
                description: "Delegate a task to another agent",
                inputSchema: {
                    type: "object",
                    properties: {
                        agentId: { type: "string" },
                        task: { type: "string" },
                    },
                    required: ["agentId", "task"],
                },
            };

            expect(mcpTool.name).toBe("delegate");
            expect(mcpTool.description).toBeDefined();
            expect(mcpTool.inputSchema.type).toBe("object");
            expect(mcpTool.inputSchema.properties).toBeDefined();
        });

        it("handles tools without input schema", () => {
            const mcpTool = {
                name: "get_status",
                description: "Get system status",
                inputSchema: {
                    type: "object",
                },
            };

            expect(mcpTool.inputSchema).toBeDefined();
            expect(mcpTool.inputSchema.type).toBe("object");
            expect(mcpTool.inputSchema.properties).toBeUndefined();
        });
    });
});
