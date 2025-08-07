import { findAgentByName } from "../utils";
import type { Agent } from "../types";

describe("findAgentByName normalization", () => {
    let agents: Map<string, Agent>;

    beforeEach(() => {
        // Set up test agents
        agents = new Map([
            ["project-manager", { 
                name: "Project Manager",
                slug: "project-manager",
                pubkey: "pubkey1",
                npub: "npub1",
                role: "test",
                isOrchestrator: false,
            } as Agent],
            ["human-replica", {
                name: "Human Replica",
                slug: "human-replica",
                pubkey: "pubkey2",
                npub: "npub2",
                role: "test",
                isOrchestrator: false,
            } as Agent],
            ["executor", {
                name: "Executor",
                slug: "executor",
                pubkey: "pubkey3",
                npub: "npub3",
                role: "test",
                isOrchestrator: false,
            } as Agent],
        ]);
    });

    describe("exact matching", () => {
        it("should find agent with exact slug match", () => {
            const agent = findAgentByName(agents, "project-manager");
            expect(agent).toBeDefined();
            expect(agent?.slug).toBe("project-manager");
        });
    });

    describe("case-insensitive matching", () => {
        it("should find agent with different case", () => {
            const agent = findAgentByName(agents, "PROJECT-MANAGER");
            expect(agent).toBeDefined();
            expect(agent?.slug).toBe("project-manager");
        });

        it("should find agent with mixed case", () => {
            const agent = findAgentByName(agents, "Project-Manager");
            expect(agent).toBeDefined();
            expect(agent?.slug).toBe("project-manager");
        });
    });

    describe("kebab-case normalization", () => {
        it("should find agent when given space-separated name", () => {
            const agent = findAgentByName(agents, "Project Manager");
            expect(agent).toBeDefined();
            expect(agent?.slug).toBe("project-manager");
        });

        it("should find agent when given underscore-separated name", () => {
            const agent = findAgentByName(agents, "project_manager");
            expect(agent).toBeDefined();
            expect(agent?.slug).toBe("project-manager");
        });

        it("should find agent with mixed separators", () => {
            const agent = findAgentByName(agents, "Project_Manager");
            expect(agent).toBeDefined();
            expect(agent?.slug).toBe("project-manager");
        });

        it("should handle multiple spaces", () => {
            const agent = findAgentByName(agents, "Project   Manager");
            expect(agent).toBeDefined();
            expect(agent?.slug).toBe("project-manager");
        });

        it("should handle trailing/leading spaces", () => {
            const agent = findAgentByName(agents, " Project Manager ");
            expect(agent).toBeDefined();
            expect(agent?.slug).toBe("project-manager");
        });
    });

    describe("complex normalization cases", () => {
        it("should find Human Replica with various formats", () => {
            const variations = [
                "Human Replica",
                "human replica",
                "HUMAN REPLICA",
                "Human_Replica",
                "human_replica",
                "Human  Replica",
                " human replica ",
            ];

            for (const variation of variations) {
                const agent = findAgentByName(agents, variation);
                expect(agent).toBeDefined();
                expect(agent?.slug).toBe("human-replica");
            }
        });

        it("should find single-word agents", () => {
            const variations = [
                "executor",
                "Executor",
                "EXECUTOR",
                " executor ",
            ];

            for (const variation of variations) {
                const agent = findAgentByName(agents, variation);
                expect(agent).toBeDefined();
                expect(agent?.slug).toBe("executor");
            }
        });
    });

    describe("non-matching cases", () => {
        it("should return undefined for non-existent agent", () => {
            const agent = findAgentByName(agents, "non-existent-agent");
            expect(agent).toBeUndefined();
        });

        it("should return undefined for completely wrong names", () => {
            const agent = findAgentByName(agents, "Random Agent Name");
            expect(agent).toBeUndefined();
        });
    });
});