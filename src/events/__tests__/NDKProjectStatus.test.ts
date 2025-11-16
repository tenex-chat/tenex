import { beforeEach, describe, expect, it } from "bun:test";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKProjectStatus } from "../NDKProjectStatus";

describe("NDKProjectStatus", () => {
    let status: NDKProjectStatus;
    let mockNdk: NDK;

    beforeEach(() => {
        mockNdk = {} as NDK;
        status = new NDKProjectStatus(mockNdk);
    });

    describe("model management with new format", () => {
        it("should add models with agent lists", () => {
            // Add a model with multiple agents
            status.addModel("gpt-4", ["agent1", "agent2", "agent3"]);

            // Check the tag was added correctly
            expect(status.tags).toContainEqual(["model", "gpt-4", "agent1", "agent2", "agent3"]);

            // Check the model can be retrieved
            const models = status.models;
            expect(models).toHaveLength(1);
            expect(models[0]).toEqual({
                modelSlug: "gpt-4",
                agents: ["agent1", "agent2", "agent3"],
            });
        });

        it("should retrieve agents that use a specific model", () => {
            status.addModel("gpt-4", ["agent1", "agent2"]);
            status.addModel("claude-3", ["agent2", "agent3"]);

            expect(status.getModelAgents("gpt-4")).toEqual(["agent1", "agent2"]);
            expect(status.getModelAgents("claude-3")).toEqual(["agent2", "agent3"]);
            expect(status.getModelAgents("non-existent")).toEqual([]);
        });

        it("should check if an agent uses a specific model", () => {
            status.addModel("gpt-4", ["agent1", "agent2"]);
            status.addModel("claude-3", ["agent3"]);

            expect(status.agentUsesModel("gpt-4", "agent1")).toBe(true);
            expect(status.agentUsesModel("gpt-4", "agent2")).toBe(true);
            expect(status.agentUsesModel("gpt-4", "agent3")).toBe(false);
            expect(status.agentUsesModel("claude-3", "agent3")).toBe(true);
            expect(status.agentUsesModel("claude-3", "agent1")).toBe(false);
        });

        it("should get all models used by a specific agent", () => {
            status.addModel("gpt-4", ["agent1", "agent2"]);
            status.addModel("claude-3", ["agent2", "agent3"]);
            status.addModel("llama-2", ["agent1"]);

            expect(status.getAgentModels("agent1")).toEqual(["gpt-4", "llama-2"]);
            expect(status.getAgentModels("agent2")).toEqual(["gpt-4", "claude-3"]);
            expect(status.getAgentModels("agent3")).toEqual(["claude-3"]);
            expect(status.getAgentModels("agent4")).toEqual([]);
        });

        it("should replace existing model when adding with same slug", () => {
            status.addModel("gpt-4", ["agent1"]);
            status.addModel("gpt-4", ["agent2", "agent3"]);

            // Should only have one gpt-4 tag with the new agents
            const modelTags = status.tags.filter((tag) => tag[0] === "model" && tag[1] === "gpt-4");
            expect(modelTags).toHaveLength(1);
            expect(modelTags[0]).toEqual(["model", "gpt-4", "agent2", "agent3"]);
        });

        it("should remove a model", () => {
            status.addModel("gpt-4", ["agent1", "agent2"]);
            status.addModel("claude-3", ["agent3"]);

            status.removeModel("gpt-4");

            expect(status.hasModel("gpt-4")).toBe(false);
            expect(status.hasModel("claude-3")).toBe(true);
            expect(status.models).toHaveLength(1);
        });

        it("should clear all models", () => {
            status.addModel("gpt-4", ["agent1"]);
            status.addModel("claude-3", ["agent2"]);

            status.clearModels();

            expect(status.models).toHaveLength(0);
            expect(status.hasModel("gpt-4")).toBe(false);
            expect(status.hasModel("claude-3")).toBe(false);
        });
    });

    describe("tool management (for comparison)", () => {
        it("should use same format as models for tools", () => {
            // Tools use the same format: ["tool", "tool-name", ...agent-slugs]
            status.addTool("delegate", ["agent1", "agent2"]);

            expect(status.tags).toContainEqual(["tool", "delegate", "agent1", "agent2"]);

            const tools = status.tools;
            expect(tools).toHaveLength(1);
            expect(tools[0]).toEqual({
                toolName: "delegate",
                agents: ["agent1", "agent2"],
            });
        });
    });
});
