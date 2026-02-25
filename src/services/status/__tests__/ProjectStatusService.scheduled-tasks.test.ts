import { describe, expect, it, mock, beforeEach } from "bun:test";
import { ProjectStatusService } from "../ProjectStatusService";
import type { ScheduledTaskInfo, StatusIntent } from "@/nostr/types";
import type { ProjectContext } from "@/services/projects";
import type { AgentInstance } from "@/agents/types";
import type { AgentRegistry } from "@/agents/AgentRegistry";
import { projectContextStore } from "@/services/projects";

// Mock SchedulerService
const mockGetTasks = mock(() => Promise.resolve([]));

mock.module("@/services/scheduling/SchedulerService", () => ({
    SchedulerService: {
        getInstance: () => ({
            getTasks: mockGetTasks,
        }),
    },
}));

describe("ProjectStatusService scheduled task gathering", () => {
    function createMockProjectContext(options: {
        agents: Map<string, AgentInstance>;
        projectTagId?: string;
    }): ProjectContext {
        const mockAgentRegistry = {
            getAllAgentsMap: () => options.agents,
        } as unknown as AgentRegistry;

        return {
            agentRegistry: mockAgentRegistry,
            mcpManager: { getCachedTools: () => ({}) },
            project: {
                tags: [],
                tagValue: () => undefined,
                tagReference: () => ["a", "test"],
                tagId: () => options.projectTagId || "31933:pubkey123:test-project",
                pubkey: "mock-pubkey",
            },
        } as unknown as ProjectContext;
    }

    function createTestAgent(slug: string, pubkey: string): AgentInstance {
        return {
            name: `Test ${slug}`,
            pubkey,
            slug,
            tools: [],
            eventId: `event-${slug}`,
        } as unknown as AgentInstance;
    }

    async function callGatherScheduledTaskInfo(
        service: ProjectStatusService,
        intent: StatusIntent
    ): Promise<void> {
        await (
            service as unknown as {
                gatherScheduledTaskInfo(intent: StatusIntent): Promise<void>;
            }
        ).gatherScheduledTaskInfo(intent);
    }

    function createBaseIntent(): StatusIntent {
        return {
            type: "status",
            agents: [],
            models: [],
            tools: [],
        };
    }

    beforeEach(() => {
        mockGetTasks.mockReset();
        mockGetTasks.mockImplementation(() => Promise.resolve([]));
    });

    it("should not add scheduledTasks when there are no tasks", async () => {
        const agents = new Map<string, AgentInstance>();
        agents.set("pm", createTestAgent("pm", "pubkey-pm"));

        const mockContext = createMockProjectContext({ agents });
        const service = new ProjectStatusService();
        (service as unknown as { projectContext: ProjectContext }).projectContext = mockContext;

        const intent = createBaseIntent();

        await projectContextStore.run(mockContext, async () => {
            await callGatherScheduledTaskInfo(service, intent);
        });

        expect(intent.scheduledTasks).toBeUndefined();
    });

    it("should gather cron tasks and resolve agent slugs from pubkeys", async () => {
        const agents = new Map<string, AgentInstance>();
        agents.set("architect", createTestAgent("architect", "pubkey-arch"));
        agents.set("reporter", createTestAgent("reporter", "pubkey-reporter"));

        const projectTagId = "31933:pubkey123:my-project";
        const mockContext = createMockProjectContext({ agents, projectTagId });

        mockGetTasks.mockImplementation(() =>
            Promise.resolve([
                {
                    id: "task-1",
                    title: "Daily standup",
                    schedule: "0 9 * * *",
                    prompt: "Run the daily standup",
                    toPubkey: "pubkey-arch",
                    fromPubkey: "user-pubkey",
                    projectId: projectTagId,
                    type: "cron" as const,
                    lastRun: "2026-02-25T09:00:00.000Z",
                    createdAt: "2026-02-20T12:00:00.000Z",
                },
            ])
        );

        const service = new ProjectStatusService();
        (service as unknown as { projectContext: ProjectContext }).projectContext = mockContext;

        const intent = createBaseIntent();

        await projectContextStore.run(mockContext, async () => {
            await callGatherScheduledTaskInfo(service, intent);
        });

        expect(intent.scheduledTasks).toBeDefined();
        expect(intent.scheduledTasks).toHaveLength(1);

        const task = intent.scheduledTasks![0];
        expect(task.id).toBe("task-1");
        expect(task.title).toBe("Daily standup");
        expect(task.schedule).toBe("0 9 * * *");
        expect(task.targetAgentSlug).toBe("architect");
        expect(task.type).toBe("cron");
        expect(task.lastRun).toBe(Math.floor(new Date("2026-02-25T09:00:00.000Z").getTime() / 1000));
    });

    it("should gather oneoff tasks", async () => {
        const agents = new Map<string, AgentInstance>();
        agents.set("reporter", createTestAgent("reporter", "pubkey-reporter"));

        const projectTagId = "31933:pubkey123:my-project";
        const mockContext = createMockProjectContext({ agents, projectTagId });

        mockGetTasks.mockImplementation(() =>
            Promise.resolve([
                {
                    id: "task-oneoff-1",
                    title: "Release announcement",
                    schedule: "2026-03-01T12:00:00.000Z",
                    prompt: "Announce the v2 release",
                    toPubkey: "pubkey-reporter",
                    fromPubkey: "user-pubkey",
                    projectId: projectTagId,
                    type: "oneoff" as const,
                    executeAt: "2026-03-01T12:00:00.000Z",
                    createdAt: "2026-02-25T12:00:00.000Z",
                },
            ])
        );

        const service = new ProjectStatusService();
        (service as unknown as { projectContext: ProjectContext }).projectContext = mockContext;

        const intent = createBaseIntent();

        await projectContextStore.run(mockContext, async () => {
            await callGatherScheduledTaskInfo(service, intent);
        });

        expect(intent.scheduledTasks).toHaveLength(1);

        const task = intent.scheduledTasks![0];
        expect(task.id).toBe("task-oneoff-1");
        expect(task.type).toBe("oneoff");
        expect(task.schedule).toBe("2026-03-01T12:00:00.000Z");
        expect(task.targetAgentSlug).toBe("reporter");
        expect(task.lastRun).toBeUndefined();
    });

    it("should use truncated pubkey when target agent not found in registry", async () => {
        const agents = new Map<string, AgentInstance>();
        agents.set("pm", createTestAgent("pm", "pubkey-pm"));

        const projectTagId = "31933:pubkey123:my-project";
        const mockContext = createMockProjectContext({ agents, projectTagId });

        mockGetTasks.mockImplementation(() =>
            Promise.resolve([
                {
                    id: "task-orphan",
                    title: "Task for unknown agent",
                    schedule: "0 12 * * *",
                    prompt: "Do something",
                    toPubkey: "abcdef1234567890unknown",
                    fromPubkey: "user-pubkey",
                    projectId: projectTagId,
                },
            ])
        );

        const service = new ProjectStatusService();
        (service as unknown as { projectContext: ProjectContext }).projectContext = mockContext;

        const intent = createBaseIntent();

        await projectContextStore.run(mockContext, async () => {
            await callGatherScheduledTaskInfo(service, intent);
        });

        expect(intent.scheduledTasks).toHaveLength(1);
        // Should fall back to first 8 chars of pubkey
        expect(intent.scheduledTasks![0].targetAgentSlug).toBe("abcdef12");
    });

    it("should use prompt substring as title when title is missing", async () => {
        const agents = new Map<string, AgentInstance>();
        agents.set("pm", createTestAgent("pm", "pubkey-pm"));

        const projectTagId = "31933:pubkey123:my-project";
        const mockContext = createMockProjectContext({ agents, projectTagId });

        mockGetTasks.mockImplementation(() =>
            Promise.resolve([
                {
                    id: "task-no-title",
                    schedule: "0 6 * * 1",
                    prompt: "A very long prompt that describes what the agent should do in great detail",
                    toPubkey: "pubkey-pm",
                    fromPubkey: "user-pubkey",
                    projectId: projectTagId,
                },
            ])
        );

        const service = new ProjectStatusService();
        (service as unknown as { projectContext: ProjectContext }).projectContext = mockContext;

        const intent = createBaseIntent();

        await projectContextStore.run(mockContext, async () => {
            await callGatherScheduledTaskInfo(service, intent);
        });

        expect(intent.scheduledTasks).toHaveLength(1);
        expect(intent.scheduledTasks![0].title).toBe(
            "A very long prompt that describes what the agent s"
        );
    });

    it("should default task type to cron when not specified", async () => {
        const agents = new Map<string, AgentInstance>();
        agents.set("pm", createTestAgent("pm", "pubkey-pm"));

        const projectTagId = "31933:pubkey123:my-project";
        const mockContext = createMockProjectContext({ agents, projectTagId });

        mockGetTasks.mockImplementation(() =>
            Promise.resolve([
                {
                    id: "task-no-type",
                    title: "Legacy task",
                    schedule: "*/5 * * * *",
                    prompt: "Check status",
                    toPubkey: "pubkey-pm",
                    fromPubkey: "user-pubkey",
                    projectId: projectTagId,
                    // type is intentionally omitted (legacy tasks)
                },
            ])
        );

        const service = new ProjectStatusService();
        (service as unknown as { projectContext: ProjectContext }).projectContext = mockContext;

        const intent = createBaseIntent();

        await projectContextStore.run(mockContext, async () => {
            await callGatherScheduledTaskInfo(service, intent);
        });

        expect(intent.scheduledTasks![0].type).toBe("cron");
    });

    it("should gather multiple tasks from the same project", async () => {
        const agents = new Map<string, AgentInstance>();
        agents.set("architect", createTestAgent("architect", "pubkey-arch"));
        agents.set("reporter", createTestAgent("reporter", "pubkey-reporter"));

        const projectTagId = "31933:pubkey123:my-project";
        const mockContext = createMockProjectContext({ agents, projectTagId });

        mockGetTasks.mockImplementation(() =>
            Promise.resolve([
                {
                    id: "task-1",
                    title: "Morning report",
                    schedule: "0 8 * * *",
                    prompt: "Generate morning report",
                    toPubkey: "pubkey-reporter",
                    fromPubkey: "user-pubkey",
                    projectId: projectTagId,
                    type: "cron" as const,
                },
                {
                    id: "task-2",
                    title: "Architecture review",
                    schedule: "0 14 * * 5",
                    prompt: "Review architecture",
                    toPubkey: "pubkey-arch",
                    fromPubkey: "user-pubkey",
                    projectId: projectTagId,
                    type: "cron" as const,
                    lastRun: "2026-02-21T14:00:00.000Z",
                },
                {
                    id: "task-3",
                    title: "Deploy release",
                    schedule: "2026-03-01T18:00:00.000Z",
                    prompt: "Deploy the release",
                    toPubkey: "pubkey-arch",
                    fromPubkey: "user-pubkey",
                    projectId: projectTagId,
                    type: "oneoff" as const,
                    executeAt: "2026-03-01T18:00:00.000Z",
                },
            ])
        );

        const service = new ProjectStatusService();
        (service as unknown as { projectContext: ProjectContext }).projectContext = mockContext;

        const intent = createBaseIntent();

        await projectContextStore.run(mockContext, async () => {
            await callGatherScheduledTaskInfo(service, intent);
        });

        expect(intent.scheduledTasks).toHaveLength(3);
        expect(intent.scheduledTasks![0].targetAgentSlug).toBe("reporter");
        expect(intent.scheduledTasks![1].targetAgentSlug).toBe("architect");
        expect(intent.scheduledTasks![2].type).toBe("oneoff");
    });

    it("should pass the correct projectTagId to SchedulerService.getTasks", async () => {
        const agents = new Map<string, AgentInstance>();
        agents.set("pm", createTestAgent("pm", "pubkey-pm"));

        const projectTagId = "31933:pubkey123:specific-project";
        const mockContext = createMockProjectContext({ agents, projectTagId });

        const service = new ProjectStatusService();
        (service as unknown as { projectContext: ProjectContext }).projectContext = mockContext;

        const intent = createBaseIntent();

        await projectContextStore.run(mockContext, async () => {
            await callGatherScheduledTaskInfo(service, intent);
        });

        // Verify getTasks was called with the correct project tag ID
        expect(mockGetTasks).toHaveBeenCalledWith(projectTagId);
    });
});
