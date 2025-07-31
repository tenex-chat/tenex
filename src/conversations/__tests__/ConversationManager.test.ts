import { describe, it, expect, beforeEach, mock } from "bun:test";
import { ConversationManager } from "../ConversationManager";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Phase, PhaseTransition } from "../types";
import * as fs from "@/lib/fs";

// Mock the fs module
mock.module("@/lib/fs", () => ({
    ensureDirectory: mock(),
    fileExists: mock(),
    readFile: mock(),
    writeJsonFile: mock(),
}));

// Mock the persistence module
mock.module("../persistence", () => ({
    FileSystemAdapter: mock(() => ({
        initialize: mock().mockResolvedValue(undefined),
        save: mock().mockResolvedValue(undefined),
        list: mock().mockResolvedValue([]),
        load: mock().mockResolvedValue(null),
    })),
}));

describe("ConversationManager", () => {
    let manager: ConversationManager;
    const projectPath = "/test/project";

    beforeEach(() => {
        manager = new ConversationManager(projectPath);
    });

    describe("phase transitions", () => {
        it("should create and store phase transitions with mandatory message", async () => {
            await manager.initialize();

            // Create a conversation
            const mockEvent: NDKEvent = {
                id: "test-event-id",
                content: "Start conversation",
                tags: [["title", "Test Conversation"]],
                created_at: Date.now() / 1000,
            } as NDKEvent;

            const conversation = await manager.createConversation(mockEvent);
            expect(conversation.phase).toBe("chat");
            expect(conversation.phaseTransitions).toEqual([]);

            // Perform phase transition
            const transitionMessage = `## User Requirements
- Build a CLI tool
- Support multiple commands
- Include documentation

## Technical Constraints
- Must use TypeScript
- Node.js 18+
- No external dependencies`;

            await manager.updatePhase(
                conversation.id,
                "plan",
                transitionMessage,
                "pm-agent-pubkey",
                "PM Agent",
                "requirements gathered"
            );

            const updated = manager.getConversation(conversation.id);
            expect(updated?.phase).toBe("plan");
            expect(updated?.phaseTransitions).toHaveLength(1);

            const transition = updated?.phaseTransitions[0];
            expect(transition).toMatchObject({
                from: "chat",
                to: "plan",
                message: transitionMessage,
                agentPubkey: "pm-agent-pubkey",
                agentName: "PM Agent",
                reason: "requirements gathered",
                timestamp: expect.any(Number),
            });
        });

        it("should handle multiple phase transitions", async () => {
            await manager.initialize();

            const mockEvent: NDKEvent = {
                id: "test-event-id",
                content: "Start conversation",
                tags: [],
            } as NDKEvent;

            const conversation = await manager.createConversation(mockEvent);

            // First transition: chat -> plan
            await manager.updatePhase(
                conversation.id,
                "plan",
                "Requirements: Build a CLI tool",
                "pm-agent-1",
                "PM Agent",
                "moving to planning"
            );

            // Second transition: plan -> execute
            await manager.updatePhase(
                conversation.id,
                "execute",
                "Plan: 1. Setup project 2. Implement commands 3. Add tests",
                "pm-agent-1",
                "PM Agent",
                "plan approved"
            );

            // Third transition: execute -> verification
            await manager.updatePhase(
                conversation.id,
                "verification",
                "Implementation complete: Created 5 files, all tests passing",
                "pm-agent-1",
                "PM Agent",
                "ready for verification"
            );

            const updated = manager.getConversation(conversation.id);
            expect(updated?.phase).toBe("verification");
            expect(updated?.phaseTransitions).toHaveLength(3);

            // Verify transition history
            const transitions = updated?.phaseTransitions || [];
            expect(transitions[0]).toMatchObject({ from: "chat", to: "plan" });
            expect(transitions[1]).toMatchObject({ from: "plan", to: "execute" });
            expect(transitions[2]).toMatchObject({ from: "execute", to: "verification" });
        });

        it("should create handoff transition even when phase does not change", async () => {
            await manager.initialize();

            const mockEvent: NDKEvent = {
                id: "test-event-id",
                content: "Start conversation",
                tags: [],
            } as NDKEvent;

            const conversation = await manager.createConversation(mockEvent);

            // Try to transition to the same phase (handoff)
            await manager.updatePhase(
                conversation.id,
                "chat",
                "Still in chat phase",
                "pm-agent-1",
                "PM Agent"
            );

            const updated = manager.getConversation(conversation.id);
            expect(updated?.phase).toBe("chat");
            expect(updated?.phaseTransitions).toHaveLength(1);
            
            // Verify handoff transition details
            const handoff = updated?.phaseTransitions[0];
            expect(handoff?.from).toBe("chat");
            expect(handoff?.to).toBe("chat");
            expect(handoff?.message).toBe("Still in chat phase");
            expect(handoff?.agentName).toBe("PM Agent");
        });

        it("should preserve transition message content exactly", async () => {
            await manager.initialize();

            const mockEvent: NDKEvent = {
                id: "test-event-id",
                content: "Start",
                tags: [],
            } as NDKEvent;

            const conversation = await manager.createConversation(mockEvent);

            const complexMessage = `# Complex Transition Message

## Section 1: Requirements
- **Requirement A**: Build a CLI tool with the following features:
  - Command parsing
  - Help system
  - Configuration management
- **Requirement B**: Support for plugins

## Section 2: Technical Details
\`\`\`typescript
interface Config {
    version: string;
    plugins: Plugin[];
}
\`\`\`

## Section 3: Constraints
1. Must use TypeScript
2. Node.js 18+ required
3. Performance: < 100ms startup time

Special characters: "quotes", 'apostrophes', \`backticks\`, \\backslashes\\`;

            await manager.updatePhase(
                conversation.id,
                "plan",
                complexMessage,
                "pm-agent-1",
                "PM Agent"
            );

            const updated = manager.getConversation(conversation.id);
            const transition = updated?.phaseTransitions[0];
            expect(transition?.message).toBe(complexMessage);
        });
    });

    describe("conversation persistence", () => {
        it("should persist phase transitions", async () => {
            const mockPersistence = {
                initialize: mock().mockResolvedValue(undefined),
                save: mock().mockResolvedValue(undefined),
                list: mock().mockResolvedValue([]),
                load: mock().mockResolvedValue(null),
            };

            const { FileSystemAdapter } = await import("../persistence");
            (FileSystemAdapter as any).mockImplementation(() => mockPersistence);

            manager = new ConversationManager(projectPath);
            await manager.initialize();

            const mockEvent: NDKEvent = {
                id: "test-event-id",
                content: "Start",
                tags: [],
            } as NDKEvent;

            const conversation = await manager.createConversation(mockEvent);

            await manager.updatePhase(
                conversation.id,
                "plan",
                "Moving to plan phase",
                "agent-1",
                "Agent One"
            );

            // Verify save was called with conversation including transitions
            expect(mockPersistence.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: conversation.id,
                    phase: "plan",
                    phaseTransitions: expect.arrayContaining([
                        expect.objectContaining({
                            from: "chat",
                            to: "plan",
                            message: "Moving to plan phase",
                        }),
                    ]),
                })
            );
        });
    });
});
