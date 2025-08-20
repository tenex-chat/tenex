import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type NDK from "@nostr-dev-kit/ndk";
import type { AgentInstance } from "@/agents/types";
import * as services from "@/services";
import { logger } from "@/utils/logger";
import { TaskPublisher } from "../TaskPublisher";

// Define mock types for better type safety
type MockProject = {
  pubkey: string;
  name: string;
  kind: number;
};

type MockReplyEvent = {
  content: string;
  tags: string[][];
  tag: ReturnType<typeof mock>;
  sign: ReturnType<typeof mock>;
  publish: ReturnType<typeof mock>;
};

type MockTask = {
  title: string;
  content: string;
  tags: string[][];
  id: string;
  tag: ReturnType<typeof mock>;
  sign: ReturnType<typeof mock>;
  publish: ReturnType<typeof mock>;
  reply: ReturnType<typeof mock>;
};

// Create a factory for mock tasks
const createMockTask = (): MockTask => {
  const task: MockTask = {
    title: "",
    content: "",
    tags: [] as string[][],
    id: "mock-task-id",
    tag: mock((project: MockProject) => {
      task.tags.push(["a", `30311:${project.pubkey}:${project.name}`]);
    }),
    sign: mock(() => Promise.resolve()),
    publish: mock(() => Promise.resolve()),
    reply: mock(() => {
      const replyEvent: MockReplyEvent = {
        content: "",
        tags: [] as string[][],
        tag: mock((project: MockProject) => {
          replyEvent.tags.push(["a", `30311:${project.pubkey}:${project.name}`]);
        }),
        sign: mock(() => Promise.resolve()),
        publish: mock(() => Promise.resolve()),
      };
      return replyEvent;
    }),
  };
  return task;
};

// Keep track of created tasks
let currentMockTask = createMockTask();

// Mock NDKTask at module level
mock.module("@nostr-dev-kit/ndk", () => {
  return {
    NDKTask: mock(() => {
      currentMockTask = createMockTask();
      return currentMockTask;
    }),
  };
});

describe("TaskPublisher", () => {
  let taskPublisher: TaskPublisher;
  let mockNDK: NDK;
  let mockAgent: AgentInstance;
  let mockProjectContext: { project: MockProject };
  let loggerDebugSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Reset the current mock task before each test
    currentMockTask = createMockTask();

    // Setup mocks
    mockNDK = {} as NDK;

    mockAgent = {
      name: "TestAgent",
      signer: {
        sign: mock(() => Promise.resolve("mock-signature")),
        pubkey: mock(() => "mock-agent-pubkey"),
      },
    } as unknown as AgentInstance;

    mockProjectContext = {
      project: {
        name: "test-project",
        pubkey: "project-pubkey",
        kind: 30311,
      },
    };

    // Mock getProjectContext
    spyOn(services, "getProjectContext").mockReturnValue(mockProjectContext);

    // Spy on logger
    loggerDebugSpy = spyOn(logger, "debug").mockImplementation(() => {});

    // Create TaskPublisher instance
    taskPublisher = new TaskPublisher(mockNDK, mockAgent);
  });

  afterEach(() => {
    mock.restore();
  });

  describe("createTask", () => {
    it("should create a task with basic properties", async () => {
      const options = {
        title: "Test Task",
        prompt: "This is a test prompt",
      };

      const task = await taskPublisher.createTask(options);

      expect(task.title).toBe("Test Task");
      expect(task.content).toBe("This is a test prompt");
      expect(task.sign).toHaveBeenCalledWith(mockAgent.signer);
      expect(task.publish).toHaveBeenCalled();
    });

    it("should tag the project correctly", async () => {
      const options = {
        title: "Test Task",
        prompt: "Test prompt",
      };

      const task = await taskPublisher.createTask(options);

      expect(task.tag).toHaveBeenCalledWith(mockProjectContext.project);
      expect(task.tags).toContainEqual(["a", "30311:project-pubkey:test-project"]);
    });

    it("should add branch tag when provided", async () => {
      const options = {
        title: "Test Task",
        prompt: "Test prompt",
        branch: "feature/test-branch",
      };

      const task = await taskPublisher.createTask(options);

      expect(task.tags).toContainEqual(["branch", "feature/test-branch"]);
    });

    it("should link to conversation when conversationRootEventId is provided", async () => {
      const options = {
        title: "Test Task",
        prompt: "Test prompt",
        conversationRootEventId: "conv-root-123",
      };

      const task = await taskPublisher.createTask(options);

      expect(task.tags).toContainEqual(["e", "conv-root-123", "", "reply"]);
    });

    it("should store the task for future operations", async () => {
      const options = {
        title: "Test Task",
        prompt: "Test prompt",
      };

      await taskPublisher.createTask(options);

      // Test by trying to publish progress (which requires currentTask)
      await expect(taskPublisher.publishTaskProgress("Progress update")).resolves.toBeUndefined();
    });

    it("should handle errors during task creation", async () => {
      const options = {
        title: "Test Task",
        prompt: "Test prompt",
      };

      // Create a new TaskPublisher with a mock that will fail on sign
      const failingTask = createMockTask();
      failingTask.sign = mock(() => Promise.reject(new Error("Signing failed")));

      const NDKTask = (await import("@nostr-dev-kit/ndk")).NDKTask as any;
      NDKTask.mockImplementationOnce(() => failingTask);

      await expect(taskPublisher.createTask(options)).rejects.toThrow("Signing failed");
    });

    it("should handle publish errors", async () => {
      const options = {
        title: "Test Task",
        prompt: "Test prompt",
      };

      // Create a new TaskPublisher with a mock that will fail on publish
      const failingTask = createMockTask();
      failingTask.publish = mock(() => Promise.reject(new Error("Publish failed")));

      const NDKTask = (await import("@nostr-dev-kit/ndk")).NDKTask as any;
      NDKTask.mockImplementationOnce(() => failingTask);

      await expect(taskPublisher.createTask(options)).rejects.toThrow("Publish failed");
    });
  });

  describe("completeTask", () => {
    it("should throw error if no current task exists", async () => {
      await expect(taskPublisher.completeTask(true, { sessionId: "test-session" })).rejects.toThrow(
        "No current task to complete. Call createTask first."
      );
    });

    it("should complete task successfully", async () => {
      // First create a task
      await taskPublisher.createTask({
        title: "Test Task",
        prompt: "Test prompt",
      });

      // Note: completeTask method is not fully implemented in the source
      // This test validates the error handling for now
      await expect(
        taskPublisher.completeTask(true, {
          sessionId: "test-session",
          totalCost: 0.5,
          messageCount: 10,
          duration: 5000,
        })
      ).resolves.toBeUndefined();
    });
  });

  describe("publishTaskProgress", () => {
    it("should throw error if no current task exists", async () => {
      await expect(taskPublisher.publishTaskProgress("Progress update")).rejects.toThrow(
        "No current task for progress updates. Call createTask first."
      );
    });

    it("should publish progress update successfully", async () => {
      // First create a task
      const task = await taskPublisher.createTask({
        title: "Test Task",
        prompt: "Test prompt",
      });

      await taskPublisher.publishTaskProgress("Progress update", "session-123");

      expect(task.reply).toHaveBeenCalled();

      expect(loggerDebugSpy).toHaveBeenCalledWith(
        "Published task progress",
        expect.objectContaining({
          taskId: "mock-task-id",
          contentLength: 15,
          sessionId: "session-123",
        })
      );
    });

    it("should handle publish errors gracefully", async () => {
      // Create a task first
      const task = await taskPublisher.createTask({
        title: "Test Task",
        prompt: "Test prompt",
      });

      // Mock reply to throw error on publish
      const mockReply = {
        content: "",
        tags: [] as string[][],
        tag: mock(() => {}),
        sign: mock(() => Promise.resolve()),
        publish: mock(() => Promise.reject(new Error("Network error"))),
      };
      task.reply = mock(() => mockReply);

      // Should not throw, but log the error
      await expect(taskPublisher.publishTaskProgress("Progress update")).resolves.toBeUndefined();

      expect(loggerDebugSpy).toHaveBeenCalledWith(
        "Error publishing update: Network error",
        expect.objectContaining({
          taskId: "mock-task-id",
          contentLength: 15,
        })
      );
    });

    it("should add status progress tag", async () => {
      await taskPublisher.createTask({
        title: "Test Task",
        prompt: "Test prompt",
      });

      await taskPublisher.publishTaskProgress("Progress update");

      const task = (taskPublisher as any).currentTask;
      const replyCall = (task.reply as any).mock.calls[0];
      expect(replyCall).toBeDefined();

      // The implementation modifies the reply object that was returned
      const lastCall = (task.reply as any).mock.results[0].value;
      expect(lastCall.tags).toContainEqual(["status", "progress"]);
    });

    it("should add claude-session tag when sessionId is provided", async () => {
      await taskPublisher.createTask({
        title: "Test Task",
        prompt: "Test prompt",
      });

      await taskPublisher.publishTaskProgress("Progress update", "session-456");

      const task = (taskPublisher as any).currentTask;
      const lastReply = (task.reply as any).mock.results[0].value;
      expect(lastReply.tags).toContainEqual(["claude-session", "session-456"]);
    });

    it("should filter out p tags from progress updates", async () => {
      await taskPublisher.createTask({
        title: "Test Task",
        prompt: "Test prompt",
      });

      const task = (taskPublisher as any).currentTask;

      // Modify the reply method to return an object with p tags
      task.reply = mock(() => {
        const replyEvent = {
          content: "",
          tags: [
            ["p", "pubkey1"],
            ["p", "pubkey2"],
            ["other", "tag"],
          ] as string[][],
          tag: mock((_project: MockProject) => {}),
          sign: mock(() => Promise.resolve()),
          publish: mock(() => Promise.resolve()),
        };
        return replyEvent;
      });

      await taskPublisher.publishTaskProgress("Progress update");

      // Get the reply object that was created and modified
      const mockReply = (task.reply as any).mock.results[0].value;

      // p tags should be filtered out
      expect(mockReply.tags.some((tag: string[]) => tag[0] === "p")).toBe(false);
      expect(mockReply.tags.some((tag: string[]) => tag[0] === "other")).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should handle multiple task creations", async () => {
      // Create first task
      const task1 = await taskPublisher.createTask({
        title: "Task 1",
        prompt: "Prompt 1",
      });

      // Store the reply mock count for task1
      const task1ReplyCalls = (task1.reply as any).mock.calls.length;

      // Create second task (should replace current task)
      const task2 = await taskPublisher.createTask({
        title: "Task 2",
        prompt: "Prompt 2",
      });

      // Progress should be published to the second task
      await taskPublisher.publishTaskProgress("Progress for task 2");

      expect(task2.reply).toHaveBeenCalled();
      // task1.reply should not have been called again after task2 was created
      expect((task1.reply as any).mock.calls.length).toBe(task1ReplyCalls);
    });

    it("should handle empty content in createTask", async () => {
      const options = {
        title: "",
        prompt: "",
      };

      const task = await taskPublisher.createTask(options);

      expect(task.title).toBe("");
      expect(task.content).toBe("");
      expect(task.publish).toHaveBeenCalled();
    });

    it("should handle very long progress content", async () => {
      await taskPublisher.createTask({
        title: "Test Task",
        prompt: "Test prompt",
      });

      const longContent = "x".repeat(10000);

      await expect(taskPublisher.publishTaskProgress(longContent)).resolves.toBeUndefined();

      // Check if the logger was called with the expected pattern
      const calls = loggerDebugSpy.mock.calls;
      const hasProgressCall = calls.some(
        (call: unknown[]) =>
          call[0] === "Published task progress" &&
          (call[1] as { contentLength?: number })?.contentLength === 10000
      );
      expect(hasProgressCall).toBe(true);
    });
  });
});
