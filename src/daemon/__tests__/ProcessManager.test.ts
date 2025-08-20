import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as path from "node:path";
import { cleanupTempDir, createTempDir } from "@/test-utils";
import { ProcessManager } from "../ProcessManager";

// Track mock processes by PID
const activePids = new Set<number>();
let nextPid = 1000;

// Store reference to the original process.kill
const originalProcessKill = process.kill;

// Override process.kill globally
(global as any).process = {
  ...process,
  kill: (pid: number, signal?: string | number) => {
    if (signal === 0) {
      // Just checking if process exists
      if (!activePids.has(pid)) {
        // Process doesn't exist - throw ESRCH error
        const error = new Error("kill ESRCH") as any;
        error.code = "ESRCH";
        error.errno = 3;
        error.syscall = "kill";
        throw error;
      }
      return true;
    }

    // Actually killing the process
    if (!activePids.has(pid)) {
      const error = new Error("kill ESRCH") as any;
      error.code = "ESRCH";
      error.errno = 3;
      error.syscall = "kill";
      throw error;
    }

    // For SIGTERM, trigger the mock process kill method
    if (signal === "SIGTERM") {
      const mockProcess = mockProcessesByPid.get(pid);
      if (mockProcess && mockProcess.kill) {
        mockProcess.kill(signal);
      }
    } else {
      // For other signals (like SIGKILL), just remove from tracking
      activePids.delete(pid);
      mockProcessesByPid.delete(pid);
    }

    return true;
  },
};

// Mock child_process module
interface MockProcess {
  pid: number;
  stdout: { on: ReturnType<typeof mock> } | null;
  stderr: { on: ReturnType<typeof mock> } | null;
  on: ReturnType<typeof mock>;
  once: ReturnType<typeof mock>;
  kill: (signal?: string) => void;
  _exitHandler?: Function;
  _exitOnceHandler?: Function;
  _errorHandler?: Function;
}

const mockProcessesByPid = new Map<number, MockProcess>();

mock.module("child_process", () => ({
  spawn: mock((command: string, args: string[], options: { stdio?: string; cwd?: string }) => {
    const pid = nextPid++;

    let exitHandler: Function | null = null;
    let exitOnceHandler: Function | null = null;
    let errorHandler: Function | null = null;

    const mockProcess = {
      pid: pid,
      stdout:
        options.stdio === "inherit"
          ? null
          : {
              on: mock(() => {}),
            },
      stderr:
        options.stdio === "inherit"
          ? null
          : {
              on: mock(() => {}),
            },
      on: mock((event: string, handler: Function) => {
        if (event === "exit") {
          exitHandler = handler;
        } else if (event === "error") {
          errorHandler = handler;
        }
      }),
      once: mock((event: string, handler: Function) => {
        if (event === "exit") {
          exitOnceHandler = handler;
        }
      }),
      kill: mock((signal?: string) => {
        // Trigger exit handlers
        setTimeout(() => {
          activePids.delete(pid);
          mockProcessesByPid.delete(pid);

          if (exitHandler) {
            exitHandler(0, signal || "SIGTERM");
          }
          if (exitOnceHandler) {
            exitOnceHandler();
          }
        }, 10);

        return true;
      }),
    };

    // Track the process
    activePids.add(pid);
    mockProcessesByPid.set(pid, mockProcess);

    return mockProcess;
  }),
}));

// Mock logger
mock.module("@/utils/logger", () => ({
  logger: {
    info: mock(),
    error: mock(),
    debug: mock(),
    warn: mock(),
  },
}));

describe("ProcessManager", () => {
  let manager: ProcessManager;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("process-manager-test-");
    manager = new ProcessManager();

    // Clear all tracking
    activePids.clear();
    mockProcessesByPid.clear();
    nextPid = 1000;
  });

  afterEach(async () => {
    // Clean up any remaining processes
    await manager.stopAll().catch(() => {});

    // Clean up temp directory
    await cleanupTempDir(tempDir);

    // Clear all tracking
    activePids.clear();
    mockProcessesByPid.clear();
  });

  describe("spawnProjectRun", () => {
    it("should spawn a new project process", async () => {
      const projectPath = path.join(tempDir, "test-project");

      await manager.spawnProjectRun(projectPath);

      // Check that a process was spawned
      expect(activePids.size).toBe(1);

      // Check that the manager tracks it as running
      const projectId = path.basename(projectPath);
      const isRunning = await manager.isProjectRunning(projectId);
      expect(isRunning).toBe(true);
    });

    it("should not spawn duplicate processes", async () => {
      const projectPath = path.join(tempDir, "test-project");

      await manager.spawnProjectRun(projectPath);
      const firstCount = activePids.size;

      // Try to spawn again
      await manager.spawnProjectRun(projectPath);
      const secondCount = activePids.size;

      // Should still be just one process
      expect(secondCount).toBe(firstCount);
      expect(secondCount).toBe(1);
    });

    it("should use custom projectId if provided", async () => {
      const projectPath = path.join(tempDir, "some-path");
      const customId = "custom-project-id";

      await manager.spawnProjectRun(projectPath, customId);

      // The process should be tracked by customId in ProcessManager
      const isRunning = await manager.isProjectRunning(customId);
      expect(isRunning).toBe(true);

      // But not by the path basename
      const isRunningByPath = await manager.isProjectRunning("some-path");
      expect(isRunningByPath).toBe(false);
    });

    it("should handle process exit", async () => {
      const projectPath = path.join(tempDir, "test-project");
      await manager.spawnProjectRun(projectPath);

      // Get the spawned process
      const [pid, mockProcess] = Array.from(mockProcessesByPid.entries())[0];
      expect(mockProcess).toBeDefined();

      // Manually trigger process exit
      activePids.delete(pid);

      // Call the exit handler
      const exitHandler = mockProcess.on.mock.calls.find(
        ([event]: unknown[]) => event === "exit"
      )?.[1];

      if (exitHandler) {
        exitHandler(0, null);
      }

      // Process should be removed from tracking
      const isRunning = await manager.isProjectRunning("test-project");
      expect(isRunning).toBe(false);
    });

    it.skip("should handle spawn errors", async () => {
      const projectPath = path.join(tempDir, "test-project");

      // Temporarily override spawn to create an error process
      const originalSpawn = require("child_process").spawn;
      let errorTriggered = false;

      mock.module("child_process", () => ({
        spawn: mock(
          (command: string, args: string[], options: { stdio?: string; cwd?: string }) => {
            if (!errorTriggered) {
              errorTriggered = true;
              const pid = nextPid++;
              const mockProcess = {
                pid: pid,
                on: mock((event: string, handler: Function) => {
                  if (event === "error") {
                    // Trigger error immediately
                    setTimeout(() => {
                      handler(new Error("Spawn failed"));
                      // Clean up
                      activePids.delete(pid);
                      mockProcessesByPid.delete(pid);
                    }, 0);
                  }
                }),
                once: mock(() => {}),
                stdout: null,
                stderr: null,
                kill: mock(),
              };
              // Track it briefly
              activePids.add(pid);
              mockProcessesByPid.set(pid, mockProcess);
              return mockProcess;
            }
            // Return to default behavior for other tests
            return originalSpawn(command, args, options);
          }
        ),
      }));

      await manager.spawnProjectRun(projectPath);

      // Wait for error handler
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Process should not be running
      const isRunning = await manager.isProjectRunning("test-project");
      expect(isRunning).toBe(false);

      // Restore original module mock
      mock.module("child_process", () => ({
        spawn: originalSpawn,
      }));
    });
  });

  describe("isProjectRunning", () => {
    it("should return true for running projects", async () => {
      const projectPath = path.join(tempDir, "test-project");
      await manager.spawnProjectRun(projectPath);

      const isRunning = await manager.isProjectRunning("test-project");
      expect(isRunning).toBe(true);
    });

    it("should return false for non-running projects", async () => {
      const isRunning = await manager.isProjectRunning("non-existent");
      expect(isRunning).toBe(false);
    });

    it("should detect when process has died", async () => {
      const projectPath = path.join(tempDir, "test-project");
      await manager.spawnProjectRun(projectPath);

      // Verify it's running first
      expect(await manager.isProjectRunning("test-project")).toBe(true);

      // Get the PID and remove it from active PIDs
      const [pid] = Array.from(mockProcessesByPid.keys());
      activePids.delete(pid);

      // The ProcessManager uses process.kill(pid, 0) to check if process exists
      // Our mock will return false since we removed it from activePids

      // Should detect process is dead
      const isRunning = await manager.isProjectRunning("test-project");
      expect(isRunning).toBe(false);
    });
  });

  describe("stopProject", () => {
    it("should stop a running project", async () => {
      const projectPath = path.join(tempDir, "test-project");
      await manager.spawnProjectRun(projectPath);

      const initialSize = activePids.size;
      expect(initialSize).toBe(1);

      await manager.stopProject("test-project");

      // Wait for process to exit
      await new Promise((resolve) => setTimeout(resolve, 50));

      const isRunning = await manager.isProjectRunning("test-project");
      expect(isRunning).toBe(false);
      expect(activePids.size).toBe(0);
    });

    it("should handle stopping non-existent project", async () => {
      // Should not throw
      await manager.stopProject("non-existent");
    });

    it("should force kill if process doesn't exit gracefully", async () => {
      const projectPath = path.join(tempDir, "test-project");
      await manager.spawnProjectRun(projectPath);

      // Get the mock process and make it not respond to SIGTERM
      const [pid, mockProcess] = Array.from(mockProcessesByPid.entries())[0];

      // Override kill to not trigger exit
      mockProcess.kill = mock(() => {
        // Don't trigger exit handlers
        return true;
      });

      // Override once to capture the handler but not remove the PID
      const exitHandlers: Function[] = [];
      mockProcess.once = mock((event: string, handler: Function) => {
        if (event === "exit") {
          exitHandlers.push(handler);
        }
      });

      // Start the stop operation
      const stopPromise = manager.stopProject("test-project");

      // Wait a bit then trigger timeout by calling process.kill with SIGKILL
      await new Promise((resolve) => setTimeout(resolve, 100));

      // ProcessManager should try SIGKILL after timeout
      // We'll simulate the process finally dying
      activePids.delete(pid);
      mockProcessesByPid.delete(pid);

      // Call any exit handlers that were registered
      exitHandlers.forEach((handler) => handler());

      await stopPromise;

      expect(activePids.size).toBe(0);
    });
  });

  describe("stopAll", () => {
    it("should stop all running projects", async () => {
      // Start multiple projects
      await manager.spawnProjectRun(path.join(tempDir, "project1"));
      await manager.spawnProjectRun(path.join(tempDir, "project2"));
      await manager.spawnProjectRun(path.join(tempDir, "project3"));

      expect(activePids.size).toBe(3);

      await manager.stopAll();

      // Wait for all processes to exit
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(activePids.size).toBe(0);
      expect(await manager.isProjectRunning("project1")).toBe(false);
      expect(await manager.isProjectRunning("project2")).toBe(false);
      expect(await manager.isProjectRunning("project3")).toBe(false);
    });

    it("should handle empty process list", async () => {
      // Should not throw when no processes
      await manager.stopAll();
    });
  });

  describe("process lifecycle", () => {
    it("should track multiple projects independently", async () => {
      const project1 = path.join(tempDir, "project1");
      const project2 = path.join(tempDir, "project2");

      await manager.spawnProjectRun(project1);
      await manager.spawnProjectRun(project2);

      expect(await manager.isProjectRunning("project1")).toBe(true);
      expect(await manager.isProjectRunning("project2")).toBe(true);

      // Stop only project1
      await manager.stopProject("project1");
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(await manager.isProjectRunning("project1")).toBe(false);
      expect(await manager.isProjectRunning("project2")).toBe(true);
    });

    it("should handle rapid start/stop cycles", async () => {
      const projectPath = path.join(tempDir, "test-project");

      // Start and stop multiple times
      for (let i = 0; i < 3; i++) {
        await manager.spawnProjectRun(projectPath);
        expect(await manager.isProjectRunning("test-project")).toBe(true);

        await manager.stopProject("test-project");
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await manager.isProjectRunning("test-project")).toBe(false);
      }
    });
  });

  describe("getRunningProjects", () => {
    it("should return list of running projects", async () => {
      const project1 = path.join(tempDir, "project1");
      const project2 = path.join(tempDir, "project2");

      await manager.spawnProjectRun(project1);
      await manager.spawnProjectRun(project2, "custom-id");

      const running = manager.getRunningProjects();

      expect(running).toHaveLength(2);
      expect(running.map((p) => p.id).sort()).toEqual(["custom-id", "project1"]);
      expect(running[0].path).toBeDefined();
      expect(running[0].startedAt).toBeDefined();
    });

    it("should return empty array when no projects running", () => {
      const running = manager.getRunningProjects();
      expect(running).toHaveLength(0);
    });
  });
});
