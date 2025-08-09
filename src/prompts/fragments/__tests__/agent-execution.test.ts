import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import { fragmentRegistry } from "@/prompts/core/FragmentRegistry";
import type { AgentInstance } from "@/agents/types";
import type { Phase } from "@/conversations/phases";
import type { Conversation } from "@/conversations/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

// Import fragments to register them
import "../agentFragments";

describe("Agent Execution Prompt Fragments", () => {
    describe("agentSystemPromptFragment", () => {
        it("should generate correct system prompt", () => {
            const mockAgent: Agent = {
                name: "TestAgent",
                role: "Developer",
                instructions: "Test instructions",
                tools: ["read_path", "analyze"],
                pubkey: "test-pubkey",
                signer: {} as any,
                llmConfig: "test-config",
                slug: "test-agent",
            };

            const prompt = new PromptBuilder()
                .add("agent-system-prompt", {
                    agent: mockAgent,
                    phase: "chat" as Phase,
                    projectTitle: "Test Project",
                })
                .build();

            expect(prompt).toContain("Your name: TestAgent");
            expect(prompt).toContain("Your role: Developer");
            expect(prompt).toContain("Test instructions");
            expect(prompt).toContain("Project Context");
            expect(prompt).toContain('Project Name: "Test Project"');
        });
    });

    describe("phaseContextFragment", () => {
        it("should generate correct phase context for each phase", () => {
            const phases: Phase[] = ["chat", "plan", "execute", "verification"];

            phases.forEach((phase) => {
                const prompt = new PromptBuilder()
                    .add("phase-context", {
                        phase,
                    })
                    .build();

                expect(prompt).toContain("Current Phase:");
            });
        });
    });

    describe("integrated prompt building", () => {
        it("should build complete agent prompt using multiple fragments", () => {
            const mockAgent: Agent = {
                name: "IntegratedAgent",
                role: "Full Stack Developer",
                instructions: "Build amazing applications",
                tools: ["claude_code"],
                pubkey: "test-pubkey",
                signer: {} as any,
                llmConfig: "test-config",
                slug: "integrated-agent",
            };

            const _mockHistory: Conversation["history"] = [
                {
                    id: "event1",
                    content: "Build a new feature",
                    created_at: 1000,
                    tags: [["p", "user"]],
                    pubkey: "user",
                    kind: 1,
                    sig: "sig1",
                } as NDKEvent,
            ];

            const systemPrompt = new PromptBuilder()
                .add("agent-system-prompt", {
                    agent: mockAgent,
                    phase: "execute" as Phase,
                    projectTitle: "My App",
                })
                .build();

            // Conversation history is handled as message array

            const phaseContext = new PromptBuilder()
                .add("phase-context", {
                    phase: "execute" as Phase,
                })
                .build();

            // Full prompt fragment doesn't exist, so we'll just verify components separately

            // Verify all components are present
            expect(systemPrompt).toContain("Your name: IntegratedAgent");
            expect(systemPrompt).toContain("Your role: Full Stack Developer");
            expect(systemPrompt).toContain("Build amazing applications");

            expect(phaseContext).toContain("Current Phase: EXECUTE");
        });
    });
});
