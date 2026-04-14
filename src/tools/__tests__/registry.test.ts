import { describe, expect, it, mock, spyOn } from "bun:test";
import type { TelegramAgentConfig } from "@/agents/types";
import { config as configService } from "@/services/ConfigService";
import * as transportBindingsModule from "@/services/ingress/TransportBindingStoreService";
import { projectContextStore } from "@/services/projects";
import { createMockAgent, createMockExecutionEnvironment } from "@/test-utils";
import type { ToolName } from "../types";
import { getAllTools, getTool, getTools, getToolsObject } from "../registry";

describe("Tool Registry", () => {
    const mockContext = createMockExecutionEnvironment();

    describe("getTool", () => {
        it("should return tool when exists", () => {
            const tool = getTool("ask", mockContext);
            expect(tool).toBeDefined();
            expect(tool?.description).toBeDefined();
        });

        it("should not expose the no_response tool outside Telegram", () => {
            const tool = getTool("no_response", mockContext);
            expect(tool).toBeUndefined();
        });

        it("should expose the no_response tool in Telegram context", () => {
            const tool = getTool(
                "no_response",
                createMockExecutionEnvironment({
                    triggeringEnvelope: {
                        transport: "telegram",
                    } as any,
                })
            );

            expect(tool).toBeDefined();
            expect(tool?.description).toContain("silent completion");
        });

        it("should return undefined for non-existent tool", () => {
            // @ts-expect-error Testing invalid tool name
            const tool = getTool("non_existent_tool" as ToolName, mockContext);
            expect(tool).toBeUndefined();
        });

        it("should handle empty string", () => {
            // @ts-expect-error Testing invalid tool name
            const tool = getTool("" as ToolName, mockContext);
            expect(tool).toBeUndefined();
        });
    });

    describe("getTools", () => {
        it("should return array of existing tools", () => {
            const tools = getTools(["ask", "kill"], mockContext);
            expect(tools).toHaveLength(2);
        });

        it("should filter out non-existent tools", () => {
            // @ts-expect-error Testing with invalid tool name
            const tools = getTools(["ask", "non_existent" as ToolName, "kill"], mockContext);
            expect(tools).toHaveLength(2);
        });

        it("should return empty array for all non-existent tools", () => {
            // @ts-expect-error Testing with invalid tool names
            const tools = getTools(["non_existent1" as ToolName, "non_existent2" as ToolName], mockContext);
            expect(tools).toHaveLength(0);
        });

        it("should handle empty array input", () => {
            const tools = getTools([], mockContext);
            expect(tools).toHaveLength(0);
        });
    });

    describe("getAllTools", () => {
        it("should return array of all tools", () => {
            const tools = getAllTools(mockContext);
            expect(tools).toBeDefined();
            expect(Array.isArray(tools)).toBe(true);
            expect(tools.length).toBeGreaterThan(0);
        });

        it("should include known tools", () => {
            const tools = getAllTools(mockContext);
            const toolDescriptions = tools.map((t) => t.description);

            expect(toolDescriptions.some(d => d?.includes("delegate"))).toBe(true);
            expect(toolDescriptions.some(d => d?.includes("kill") || d?.includes("terminate"))).toBe(true);
        });

        it("should return tools with required AI SDK properties", () => {
            const tools = getAllTools(mockContext);

            for (const tool of tools) {
                expect(tool).toHaveProperty("description");
                expect(tool).toHaveProperty("execute");
                expect(typeof tool.description).toBe("string");
                expect(typeof tool.execute).toBe("function");
                // AI SDK tools have parameters in their schema
                expect(tool.parameters || tool.inputSchema).toBeDefined();
            }
        });
    });

    describe("getToolsObject", () => {
        it("auto-injects send_message when the agent has remembered Telegram bindings", async () => {
            const context = createMockExecutionEnvironment({
                agent: createMockAgent({
                    telegram: {
                        botToken: "token",
                    } as TelegramAgentConfig,
                }),
            });

            const storeSpy = spyOn(transportBindingsModule, "getTransportBindingStore").mockReturnValue({
                listBindingsForAgentProject: () => [{
                    transport: "telegram",
                    agentPubkey: context.agent.pubkey,
                    channelId: "telegram:chat:1001",
                    projectId: "test-project",
                    createdAt: 1,
                    updatedAt: 1,
                }],
            } as any);
            const tools = await projectContextStore.run({
                project: {
                    dTag: "test-project",
                    tagValue: (name: string) => (name === "d" ? "test-project" : undefined),
                },
            } as any, async () => getToolsObject([], context));

            expect(tools.send_message).toBeDefined();
            storeSpy.mockRestore();
        });

        it("auto-injects no_response only for Telegram-triggered turns", async () => {
            const nonTelegramTools = await getToolsObject([], mockContext);
            expect(nonTelegramTools.no_response).toBeUndefined();

            const telegramContext = createMockExecutionEnvironment({
                triggeringEnvelope: {
                    transport: "telegram",
                } as any,
            });

            const telegramTools = await getToolsObject([], telegramContext);
            expect(telegramTools.no_response).toBeDefined();
        });

        it("auto-injects self_delegate as a core tool", async () => {
            const tools = await getToolsObject([], mockContext);
            expect(tools.self_delegate).toBeDefined();
        });

        it("does not auto-inject skill-management tools for orchestrator agents", async () => {
            const tools = await getToolsObject([], createMockExecutionEnvironment({
                agent: createMockAgent({
                    category: "orchestrator",
                }),
            }));

            expect(tools.skill_list).toBeUndefined();
            expect(tools.skills_set).toBeUndefined();
            expect(tools.self_delegate).toBeDefined();
        });

        it("keeps change_model auto-injected for meta-model agents", async () => {
            const getRawLLMConfigSpy = spyOn(configService, "getRawLLMConfig").mockReturnValue({
                provider: "meta",
                default: "fast",
                variants: {
                    fast: { model: "fast-model" },
                },
            } as any);

            const tools = await getToolsObject([], createMockExecutionEnvironment({
                agent: createMockAgent({
                    llmConfig: "meta-config",
                }),
            }));

            expect(tools.change_model).toBeDefined();
            getRawLLMConfigSpy.mockRestore();
        });
    });
});
