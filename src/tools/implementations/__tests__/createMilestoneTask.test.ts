import { describe, it, expect, beforeEach, mock } from "bun:test";
import { createMilestoneTaskTool } from "../createMilestoneTask";
import type { ToolContext } from "@/tools/types";

// Mock logger to avoid console output during tests
mock.module("@/utils/logger", () => ({
    logger: {
        debug: mock(() => {}),
        error: mock(() => {}),
        info: mock(() => {}),
        warn: mock(() => {})
    }
}));

// Mock NDKTask
const mockNDKTask = {
    title: undefined as string | undefined,
    content: undefined as string | undefined,
    tags: [] as string[][],
    id: "mock-task-id-123",
    sign: mock(async () => {}),
    publish: mock(async () => {}),
    tag: mock(() => {}),
};

// Mock NDK
const mockNDK = {
    signer: { privateKey: () => "mock-private-key" },
    pool: {
        connectedRelays: () => [],
        relaySet: new Set(),
        addRelay: () => {}
    },
    publish: mock(async () => {}),
    calculateRelaySetFromEvent: () => ({ relays: [] })
};

mock.module("@/nostr", () => ({
    getNDK: mock(() => mockNDK)
}));

// Mock project context
const mockProjectContext = {
    project: {
        id: "test-project",
        tagId: () => "test-project-id",
        tags: [["title", "Test Project"]]
    },
    agents: new Map([
        ["executor", { 
            slug: "executor", 
            pubkey: "executor-pubkey",
            name: "Executor Agent"
        }],
        ["planner", { 
            slug: "planner", 
            pubkey: "planner-pubkey",
            name: "Planner Agent"
        }],
        ["reviewer", { 
            slug: "reviewer", 
            pubkey: "reviewer-pubkey",
            name: "Reviewer Agent"
        }]
    ])
};

mock.module("@/services/ProjectContext", () => ({
    getProjectContext: mock(() => mockProjectContext)
}));

mock.module("@nostr-dev-kit/ndk", () => {
    const MockNDKTask = function(this: any) {
        this.title = undefined;
        this.content = undefined;
        this.tags = [];
        this.id = mockNDKTask.id;
        this.sign = mockNDKTask.sign;
        this.publish = mockNDKTask.publish;
        this.tag = mock((project: any) => {
            // Simulate what the tag method does
            this.tags.push(["a", project.tagId()]);
        });
        
        // Store reference for test assertions
        Object.defineProperty(this, 'title', {
            get() { return mockNDKTask.title; },
            set(value: string | undefined) { mockNDKTask.title = value; }
        });
        Object.defineProperty(this, 'content', {
            get() { return mockNDKTask.content; },
            set(value: string | undefined) { mockNDKTask.content = value; }
        });
        Object.defineProperty(this, 'tags', {
            get() { return mockNDKTask.tags; },
            set(value: string[][]) { mockNDKTask.tags = value; }
        });
    };
    
    return { NDKTask: MockNDKTask };
});

describe("createMilestoneTask tool", () => {
    let context: ToolContext;

    beforeEach(() => {
        // Reset mocks
        mockNDKTask.sign.mockClear();
        mockNDKTask.publish.mockClear();
        mockNDKTask.title = undefined;
        mockNDKTask.content = undefined;
        mockNDKTask.tags = [];
        
        // Create tool context
        context = {
            agent: {
                name: "Orchestrator",
                slug: "orchestrator",
                pubkey: "orchestrator-pubkey",
                signer: { privateKey: () => "mock-private-key" }
            },
            phase: "PLAN",
            conversationId: "test-conversation-123",
            projectPath: "/test/project"
        } as ToolContext;
    });

    describe("metadata", () => {
        it("should have correct tool name", () => {
            expect(createMilestoneTaskTool.name).toBe("create_milestone_task");
        });

        it("should have descriptive documentation", () => {
            expect(createMilestoneTaskTool.description).toContain("Create a trackable milestone task");
            expect(createMilestoneTaskTool.description).toContain("orchestrator");
        });
    });

    describe("schema validation", () => {
        it("should require title field", () => {
            const result = createMilestoneTaskTool.parameters.validate({
                description: "Test description"
            });
            
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.field).toBe("title");
                expect(result.error.message).toContain("Required");
            }
        });

        it("should require description field", () => {
            const result = createMilestoneTaskTool.parameters.validate({
                title: "Test title"
            });
            
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.field).toBe("description");
                expect(result.error.message).toContain("Required");
            }
        });

        it("should accept valid input with title and description", () => {
            const result = createMilestoneTaskTool.parameters.validate({
                title: "Implement authentication",
                description: "Add OAuth2 authentication with Google provider"
            });
            
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value.value.title).toBe("Implement authentication");
                expect(result.value.value.description).toBe("Add OAuth2 authentication with Google provider");
                expect(result.value.value.assignees).toBeUndefined();
            }
        });

        it("should accept optional assignees array", () => {
            const result = createMilestoneTaskTool.parameters.validate({
                title: "Test task",
                description: "Test description",
                assignees: ["executor", "planner"]
            });
            
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value.value.assignees).toEqual(["executor", "planner"]);
            }
        });
    });

    describe("execution", () => {
        it("should create a milestone task successfully", async () => {
            const input = {
                value: {
                    title: "Implement user authentication",
                    description: "Add complete authentication system with login, logout, and session management"
                },
                ts: Date.now()
            };

            const result = await createMilestoneTaskTool.execute(input, context);

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value.message).toContain("✅ Milestone task created");
                expect(result.value.message).toContain("Implement user authentication");
                expect(result.value.eventId).toBe("mock-task-id-123");
                expect(result.value.title).toBe("Implement user authentication");
                expect(result.value.descriptionLength).toBe(77);
                expect(result.value.assignees).toBeUndefined();
            }

            // Verify NDKTask was created correctly
            expect(mockNDKTask.title).toBe("Implement user authentication");
            expect(mockNDKTask.content).toBe("Add complete authentication system with login, logout, and session management");
            
            // Verify tags were added
            expect(mockNDKTask.tags).toContainEqual(["a", "test-project-id"]);
            expect(mockNDKTask.tags).toContainEqual(["status", "pending"]);
            expect(mockNDKTask.tags).toContainEqual(["milestone", "true"]);
            expect(mockNDKTask.tags).toContainEqual(["phase", "PLAN"]);
            expect(mockNDKTask.tags).toContainEqual(["e", "test-conversation-123"]);

            // Verify task was signed and published
            expect(mockNDKTask.sign).toHaveBeenCalledTimes(1);
            expect(mockNDKTask.publish).toHaveBeenCalledTimes(1);
        });

        it("should create a task with assignees", async () => {
            const input = {
                value: {
                    title: "Review codebase",
                    description: "Perform code review and suggest improvements",
                    assignees: ["executor", "reviewer"]
                },
                ts: Date.now()
            };

            const result = await createMilestoneTaskTool.execute(input, context);

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value.message).toContain("Assigned to: executor, reviewer");
                expect(result.value.assignees).toEqual(["executor", "reviewer"]);
            }

            // Verify assignee tags were added
            expect(mockNDKTask.tags).toContainEqual(["p", "executor-pubkey"]);
            expect(mockNDKTask.tags).toContainEqual(["p", "reviewer-pubkey"]);
        });

        it("should handle unknown assignee gracefully", async () => {
            const input = {
                value: {
                    title: "Test task",
                    description: "Test with unknown assignee",
                    assignees: ["executor", "unknown-agent", "planner"]
                },
                ts: Date.now()
            };

            const result = await createMilestoneTaskTool.execute(input, context);

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value.assignees).toEqual(["executor", "unknown-agent", "planner"]);
            }

            // Verify only valid assignees got p tags
            expect(mockNDKTask.tags).toContainEqual(["p", "executor-pubkey"]);
            expect(mockNDKTask.tags).toContainEqual(["p", "planner-pubkey"]);
            expect(mockNDKTask.tags).not.toContainEqual(["p", "unknown-agent-pubkey"]);
        });

        it("should fail when agent signer is not available", async () => {
            context.agent.signer = undefined;

            const input = {
                value: {
                    title: "Test task",
                    description: "This should fail"
                },
                ts: Date.now()
            };

            const result = await createMilestoneTaskTool.execute(input, context);

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.kind).toBe("execution");
                expect(result.error.tool).toBe("create_milestone_task");
                expect(result.error.message).toContain("Agent signer not available");
            }
        });

        it("should fail when NDK is not available", async () => {
            // Mock getNDK to return null
            const { getNDK } = await import("@/nostr");
            (getNDK as any).mockReturnValueOnce(null);

            const input = {
                value: {
                    title: "Test task",
                    description: "This should fail"
                },
                ts: Date.now()
            };

            const result = await createMilestoneTaskTool.execute(input, context);

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.kind).toBe("execution");
                expect(result.error.message).toContain("NDK instance not available");
            }
        });

        it("should handle task creation errors gracefully", async () => {
            // Mock sign to throw an error
            mockNDKTask.sign.mockRejectedValueOnce(new Error("Signing failed"));

            const input = {
                value: {
                    title: "Test task",
                    description: "This should handle errors"
                },
                ts: Date.now()
            };

            const result = await createMilestoneTaskTool.execute(input, context);

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.kind).toBe("execution");
                expect(result.error.message).toContain("Signing failed");
            }
        });

        it("should work without conversationId", async () => {
            context.conversationId = undefined;

            const input = {
                value: {
                    title: "Standalone task",
                    description: "Task not linked to a conversation"
                },
                ts: Date.now()
            };

            const result = await createMilestoneTaskTool.execute(input, context);

            expect(result.ok).toBe(true);
            
            // Verify no conversation reference tag was added
            expect(mockNDKTask.tags).not.toContainEqual(expect.arrayContaining(["e", expect.any(String)]));
        });
    });
});