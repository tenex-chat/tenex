import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { createZodSchema, mcpSchemaToZod, ToolSchemas } from "../zod-schema";
import { adaptMCPTool } from "@/services/mcp/MCPToolAdapter";
import { analyze } from "../implementations/analyze";
import type { ExecutionContext } from "../types";

describe("Zod Tool Schemas", () => {
    describe("createZodSchema", () => {
        it("should create a valid ParameterSchema from Zod schema", () => {
            const zodSchema = z.object({
                name: z.string().min(1).describe("User name"),
                age: z.number().int().min(0).max(150).describe("User age"),
                email: z.string().email().optional().describe("User email"),
            });

            const paramSchema = createZodSchema(zodSchema);

            // Test valid input
            const validResult = paramSchema.validate({
                name: "John Doe",
                age: 30,
                email: "john@example.com",
            });

            expect(validResult.ok).toBe(true);
            if (validResult.ok) {
                expect(validResult.value.value).toEqual({
                    name: "John Doe",
                    age: 30,
                    email: "john@example.com",
                });
            }

            // Test invalid input
            const invalidResult = paramSchema.validate({
                name: "",
                age: 200,
            });

            expect(invalidResult.ok).toBe(false);
            if (!invalidResult.ok) {
                expect(invalidResult.error.kind).toBe("validation");
            }
        });

        it("should handle nested schemas correctly", () => {
            const nestedSchema = z.object({
                user: z.object({
                    name: z.string(),
                    preferences: z.object({
                        theme: z.enum(["light", "dark"]),
                        notifications: z.boolean(),
                    }),
                }),
                items: z.array(z.string()).min(1),
            });

            const paramSchema = createZodSchema(nestedSchema);
            const result = paramSchema.validate({
                user: {
                    name: "Alice",
                    preferences: {
                        theme: "dark",
                        notifications: true,
                    },
                },
                items: ["item1", "item2"],
            });

            expect(result.ok).toBe(true);
        });
    });

    describe("mcpSchemaToZod", () => {
        it("should convert MCP schema to Zod schema", () => {
            const mcpSchema = {
                properties: {
                    query: { type: "string", description: "Search query" },
                    limit: { type: "integer", minimum: 1, maximum: 100 },
                    tags: { type: "array", items: { type: "string" } },
                    options: {
                        type: "object",
                        properties: {
                            caseSensitive: { type: "boolean" },
                        },
                    },
                },
                required: ["query"],
            };

            const zodSchema = mcpSchemaToZod(mcpSchema);
            const parsed = zodSchema.safeParse({
                query: "test search",
                limit: 10,
                tags: ["tag1", "tag2"],
                options: { caseSensitive: true },
            });

            expect(parsed.success).toBe(true);
            if (parsed.success) {
                expect(parsed.data.query).toBe("test search");
                expect(parsed.data.limit).toBe(10);
            }
        });

        it("should handle optional fields correctly", () => {
            const mcpSchema = {
                properties: {
                    required_field: { type: "string" },
                    optional_field: { type: "number" },
                },
                required: ["required_field"],
            };

            const zodSchema = mcpSchemaToZod(mcpSchema);

            // Should accept without optional field
            const result1 = zodSchema.safeParse({ required_field: "test" });
            expect(result1.success).toBe(true);

            // Should accept with optional field
            const result2 = zodSchema.safeParse({
                required_field: "test",
                optional_field: 42,
            });
            expect(result2.success).toBe(true);

            // Should fail without required field
            const result3 = zodSchema.safeParse({ optional_field: 42 });
            expect(result3.success).toBe(false);
        });
    });

    describe("MCP Tool Adapter", () => {
        it("should create a typed MCP tool with Zod validation", async () => {
            const mcpTool = {
                name: "search",
                description: "Search for items",
                inputSchema: {
                    properties: {
                        query: { type: "string", minLength: 1 },
                        limit: { type: "integer", minimum: 1, maximum: 100 },
                    },
                    required: ["query"],
                },
            };

            const mockExecute = async (args: any) => ({
                results: [`Result for ${args.query}`],
                count: 1,
            });

            const tool = adaptMCPTool(mcpTool, "test_server", mockExecute);

            expect(tool.name).toBe("mcp__test_server__search");
            expect(tool.brand._brand).toBe("effect");

            // Test parameter validation
            const validResult = tool.parameters.validate({
                query: "test",
                limit: 10,
            });
            expect(validResult.ok).toBe(true);

            const invalidResult = tool.parameters.validate({
                query: "",
                limit: 200,
            });
            expect(invalidResult.ok).toBe(false);
        });
    });

    describe("Analyze Tool Schema", () => {
        it("should have proper Zod schema validation", () => {
            const { parameters } = analyze;

            // Valid input
            const validResult = parameters.validate({
                prompt: "What is the main purpose of this codebase?",
            });
            expect(validResult.ok).toBe(true);

            // Invalid input - empty string
            const invalidResult = parameters.validate({
                prompt: "",
            });
            expect(invalidResult.ok).toBe(false);

            // Invalid input - missing prompt
            const missingResult = parameters.validate({});
            expect(missingResult.ok).toBe(false);
        });
    });

    describe("ToolSchemas utilities", () => {
        it("should validate file paths", () => {
            const schema = ToolSchemas.filePath();
            const zodSchema = z.object({ path: schema });

            const valid = zodSchema.safeParse({ path: "/home/user/file.txt" });
            expect(valid.success).toBe(true);

            const invalid = zodSchema.safeParse({ path: "../../../etc/passwd" });
            expect(invalid.success).toBe(false);
        });

        it("should validate commands", () => {
            const schema = ToolSchemas.command();
            const zodSchema = z.object({ cmd: schema });

            const valid = zodSchema.safeParse({ cmd: "ls -la" });
            expect(valid.success).toBe(true);

            const invalid = zodSchema.safeParse({ cmd: "rm -rf /" });
            expect(invalid.success).toBe(false);
        });

        it("should validate agent pubkeys", () => {
            const schema = ToolSchemas.agentPubkey();
            const zodSchema = z.object({ pubkey: schema });

            const validPubkey = "a".repeat(64); // 64 hex chars
            const valid = zodSchema.safeParse({ pubkey: validPubkey });
            expect(valid.success).toBe(true);

            const invalid = zodSchema.safeParse({ pubkey: "not-a-pubkey" });
            expect(invalid.success).toBe(false);
        });

        it("should create non-empty arrays", () => {
            const schema = ToolSchemas.nonEmptyArray(z.string());
            const zodSchema = z.object({ items: schema });

            const valid = zodSchema.safeParse({ items: ["item1", "item2"] });
            expect(valid.success).toBe(true);

            const invalid = zodSchema.safeParse({ items: [] });
            expect(invalid.success).toBe(false);
        });
    });
});
