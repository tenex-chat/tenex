import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { SchedulerService } from "../SchedulerService";
import NDK from "@nostr-dev-kit/ndk";
import * as fs from 'fs/promises';
import * as path from 'path';
import { ConfigService } from "../ConfigService";

// Mock ConfigService
mock.module("../ConfigService", () => ({
  ConfigService: {
    getInstance: () => ({
      getConfig: () => ({
        userPubkey: "test-user-pubkey",
        projectPubkey: "test-project-pubkey",
        systemAgentPubkeys: ["test-agent-pubkey"]
      })
    })
  }
}));

describe("SchedulerService", () => {
  let service: SchedulerService;
  let ndk: NDK;
  const testTasksPath = path.join(process.cwd(), '.tenex', 'scheduled_tasks.json');

  beforeEach(async () => {
    // Clean up any existing test tasks file
    try {
      await fs.unlink(testTasksPath);
    } catch {
      // File might not exist, that's okay
    }

    // Create a mock NDK instance
    ndk = new NDK();

    // Mock NDK publish for kind:11 events
    ndk.publish = mock(async (event: any) => {
      event.id = `test-event-${Date.now()}`;
      return { size: 1 };
    }) as any;

    // Get the singleton instance and reset it
    service = SchedulerService.getInstance();
    await service.initialize(ndk);
    await service.clearAllTasks(); // Clear any existing tasks
  });

  afterEach(async () => {
    // Shutdown the service to stop all cron jobs
    service.shutdown();

    // Clean up test tasks file
    try {
      await fs.unlink(testTasksPath);
    } catch {
      // File might not exist, that's okay
    }
  });

  it("should add a scheduled task locally without Nostr event", async () => {
    const schedule = "0 9 * * *"; // Daily at 9am
    const prompt = "Send daily report";
    const agentPubkey = "test-agent-pubkey";

    const taskId = await service.addTask(schedule, prompt, agentPubkey);

    expect(taskId).toBeDefined();
    expect(taskId).toContain("task-");

    // Verify the task was added locally
    const tasks = await service.getTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].prompt).toBe(prompt);
    expect(tasks[0].schedule).toBe(schedule);
    expect(tasks[0].agentPubkey).toBe(agentPubkey);
  });

  it("should handle single-run cron expressions", async () => {
    // Use a specific date/time cron expression that runs once
    const schedule = "30 15 25 12 *"; // December 25th at 3:30 PM
    const prompt = "Christmas reminder";

    const taskId = await service.addTask(schedule, prompt);

    expect(taskId).toBeDefined();

    const tasks = await service.getTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].schedule).toBe(schedule);
  });

  it("should remove a scheduled task locally", async () => {
    const schedule = "*/5 * * * *"; // Every 5 minutes
    const prompt = "Check status";

    const taskId = await service.addTask(schedule, prompt);

    // Verify task was added
    let tasks = await service.getTasks();
    expect(tasks.length).toBe(1);

    // Remove the task
    const removed = await service.removeTask(taskId);
    expect(removed).toBe(true);

    // Verify task was removed
    tasks = await service.getTasks();
    expect(tasks.length).toBe(0);
  });

  it("should list all local tasks", async () => {
    // Add multiple tasks
    await service.addTask("0 9 * * *", "Task 1");
    await service.addTask("0 10 * * *", "Task 2");
    await service.addTask("0 0 * * 0", "Task 3"); // Weekly on Sunday

    const tasks = await service.getTasks();
    expect(tasks).toHaveLength(3);
    expect(tasks[0].prompt).toBe("Task 1");
    expect(tasks[1].prompt).toBe("Task 2");
    expect(tasks[2].prompt).toBe("Task 3");
  });

  it("should persist tasks to disk", async () => {
    const schedule = "0 12 * * *";
    const prompt = "Lunch reminder";

    await service.addTask(schedule, prompt);

    // Verify the file was created
    const fileContent = await fs.readFile(testTasksPath, 'utf-8');
    const savedTasks = JSON.parse(fileContent);

    expect(savedTasks).toHaveLength(1);
    expect(savedTasks[0].schedule).toBe(schedule);
    expect(savedTasks[0].prompt).toBe(prompt);
  });

  it("should load tasks from disk on initialization", async () => {
    // Add a task and shut down
    const schedule = "0 8 * * *";
    const prompt = "Morning standup";
    const taskId = await service.addTask(schedule, prompt);

    // Get initial tasks
    const initialTasks = await service.getTasks();
    expect(initialTasks.length).toBe(1);

    service.shutdown();

    // Create a new instance and initialize
    const newService = SchedulerService.getInstance();
    await newService.initialize(ndk);

    // Tasks should be loaded from disk
    const loadedTasks = await newService.getTasks();
    expect(loadedTasks.length).toBe(1);
    expect(loadedTasks[0].prompt).toBe(prompt);

    // Clean up
    newService.shutdown();
  });

  it("should reject invalid cron expressions", async () => {
    const invalidSchedule = "invalid cron";
    const prompt = "Test task";

    try {
      await service.addTask(invalidSchedule, prompt);
      expect(true).toBe(false); // Should not reach here
    } catch (error: any) {
      expect(error.message).toContain("Invalid cron expression");
    }
  });

  it.skip("should publish kind:11 event when task executes", async () => {
    // Skipping this test as it requires a full NDK setup with signers
    // This is integration testing territory and would be better tested
    // in an integration test suite with real NDK instances
  });

  it("should include agent pubkey in scheduled task", async () => {
    const schedule = "0 15 * * *";
    const prompt = "Afternoon task";
    const agentPubkey = "specific-agent-pubkey";

    const taskId = await service.addTask(schedule, prompt, agentPubkey);

    const tasks = await service.getTasks();
    expect(tasks[0].agentPubkey).toBe(agentPubkey);
  });

  it("should use default agent pubkey when not specified", async () => {
    const schedule = "0 16 * * *";
    const prompt = "Default agent task";

    const taskId = await service.addTask(schedule, prompt);

    const tasks = await service.getTasks();
    // Should use the first system agent pubkey from config
    expect(tasks[0].agentPubkey).toBe("test-agent-pubkey");
  });
});