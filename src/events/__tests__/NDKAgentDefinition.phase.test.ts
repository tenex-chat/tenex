import { NDKEvent } from "@nostr-dev-kit/ndk";
import { describe, expect, it } from "vitest";
import { NDKAgentDefinition } from "../NDKAgentDefinition";

describe("NDKAgentDefinition - Phase Support", () => {
    describe("phase property", () => {
        it("should get and set phase property", () => {
            const agentDef = new NDKAgentDefinition();

            // Initially undefined
            expect(agentDef.phase).toBeUndefined();

            // Set phase
            agentDef.phase = "development";
            expect(agentDef.phase).toBe("development");

            // Check tag was added
            const phaseTag = agentDef.tags.find((t) => t[0] === "phase");
            expect(phaseTag).toBeDefined();
            expect(phaseTag?.[1]).toBe("development");
        });

        it("should replace existing phase tag when setting new phase", () => {
            const agentDef = new NDKAgentDefinition();

            // Set initial phase
            agentDef.phase = "development";
            expect(agentDef.tags.filter((t) => t[0] === "phase")).toHaveLength(1);

            // Update phase
            agentDef.phase = "testing";
            expect(agentDef.phase).toBe("testing");

            // Should still only have one phase tag
            const phaseTags = agentDef.tags.filter((t) => t[0] === "phase");
            expect(phaseTags).toHaveLength(1);
            expect(phaseTags[0][1]).toBe("testing");
        });

        it("should remove phase tag when setting to undefined", () => {
            const agentDef = new NDKAgentDefinition();

            // Set phase
            agentDef.phase = "production";
            expect(agentDef.tags.filter((t) => t[0] === "phase")).toHaveLength(1);

            // Remove phase
            agentDef.phase = undefined;
            expect(agentDef.phase).toBeUndefined();
            expect(agentDef.tags.filter((t) => t[0] === "phase")).toHaveLength(0);
        });

        it("should read phase from existing event tags", () => {
            const rawEvent = {
                kind: 4199,
                content: "",
                tags: [
                    ["title", "Test Agent"],
                    ["phase", "staging"],
                    ["role", "Deployer"],
                ],
                created_at: Date.now() / 1000,
                pubkey: "test-pubkey",
            };

            const ndkEvent = new NDKEvent(undefined, rawEvent);
            const agentDef = NDKAgentDefinition.from(ndkEvent);

            expect(agentDef.phase).toBe("staging");
            expect(agentDef.title).toBe("Test Agent");
            expect(agentDef.role).toBe("Deployer");
        });
    });

    describe("event creation with phase", () => {
        it("should create complete agent definition with phase", () => {
            const agentDef = new NDKAgentDefinition();

            // Set all properties including phase
            agentDef.title = "Phase-Aware Agent";
            agentDef.description = "An agent that works in specific phases";
            agentDef.role = "Phase Specialist";
            agentDef.instructions = "Handle phase-specific tasks";
            agentDef.useCriteria = "When in development phase";
            agentDef.version = 2;
            agentDef.phase = "development";

            // Verify all properties
            expect(agentDef.title).toBe("Phase-Aware Agent");
            expect(agentDef.description).toBe("An agent that works in specific phases");
            expect(agentDef.role).toBe("Phase Specialist");
            expect(agentDef.instructions).toBe("Handle phase-specific tasks");
            expect(agentDef.useCriteria).toBe("When in development phase");
            expect(agentDef.version).toBe(2);
            expect(agentDef.phase).toBe("development");

            // Verify tags
            expect(agentDef.tagValue("title")).toBe("Phase-Aware Agent");
            expect(agentDef.tagValue("description")).toBe("An agent that works in specific phases");
            expect(agentDef.tagValue("role")).toBe("Phase Specialist");
            expect(agentDef.tagValue("instructions")).toBe("Handle phase-specific tasks");
            expect(agentDef.tagValue("use-criteria")).toBe("When in development phase");
            expect(agentDef.tagValue("ver")).toBe("2");
            expect(agentDef.tagValue("phase")).toBe("development");
        });

        it("should handle agent definition without phase (universal agent)", () => {
            const agentDef = new NDKAgentDefinition();

            agentDef.title = "Universal Agent";
            agentDef.role = "General Purpose";
            // No phase set - this agent works in all phases

            expect(agentDef.title).toBe("Universal Agent");
            expect(agentDef.role).toBe("General Purpose");
            expect(agentDef.phase).toBeUndefined();
            expect(agentDef.tagValue("phase")).toBeUndefined();
        });
    });

    describe("phase tag interaction with other tags", () => {
        it("should maintain phase tag alongside other tags", () => {
            const agentDef = new NDKAgentDefinition();

            // Add various tags
            agentDef.title = "Multi-Tag Agent";
            agentDef.role = "Complex";
            agentDef.phase = "testing";
            agentDef.version = 3;

            // Add custom tag
            agentDef.tags.push(["custom", "value"]);

            // Verify all tags exist
            expect(agentDef.tags.find((t) => t[0] === "title")?.[1]).toBe("Multi-Tag Agent");
            expect(agentDef.tags.find((t) => t[0] === "role")?.[1]).toBe("Complex");
            expect(agentDef.tags.find((t) => t[0] === "phase")?.[1]).toBe("testing");
            expect(agentDef.tags.find((t) => t[0] === "ver")?.[1]).toBe("3");
            expect(agentDef.tags.find((t) => t[0] === "custom")?.[1]).toBe("value");
        });
    });
});
