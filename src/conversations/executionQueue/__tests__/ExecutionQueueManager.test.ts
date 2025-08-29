import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ExecutionQueueManager } from "../ExecutionQueueManager";
import type { ExecutionQueueConfig } from "../types";

describe("ExecutionQueueManager", () => {
  let manager: ExecutionQueueManager;
  let testProjectPath: string;
  const config: Partial<ExecutionQueueConfig> = {
    enablePersistence: true,
  };

  beforeEach(async () => {
    // Create a temporary directory for testing
    testProjectPath = path.join(tmpdir(), `test-project-${Date.now()}`);
    await fs.mkdir(testProjectPath, { recursive: true });

    // Create manager for unit tests
    manager = new ExecutionQueueManager(
      testProjectPath,
      config
    );

    await manager.initialize();
  });

  afterEach(async () => {
    // Clean up
    await manager.clearAll();

    // Remove test directory
    try {
      await fs.rm(testProjectPath, { recursive: true, force: true });
    } catch (_error) {
      // Ignore cleanup errors
    }
  });

  describe("Lock Management", () => {
    it("should acquire lock when no existing lock", async () => {
      const permission = await manager.requestExecution("conv-123", "agent-1");

      expect(permission.granted).toBe(true);
      expect(permission.waitTime).toBe(0);
      expect(permission.message).toContain("successfully");
    });

    it("should queue conversation when lock is held", async () => {
      // First conversation acquires lock
      await manager.requestExecution("conv-123", "agent-1");

      // Second conversation should be queued
      const permission = await manager.requestExecution("conv-456", "agent-2");

      expect(permission.granted).toBe(false);
      expect(permission.queuePosition).toBe(1);
      expect(permission.waitTime).toBeGreaterThan(0);
      expect(permission.message).toContain("queue");
    });

    it("should return same permission for already locked conversation", async () => {
      await manager.requestExecution("conv-123", "agent-1");

      // Same conversation requests again
      const permission = await manager.requestExecution("conv-123", "agent-1");

      expect(permission.granted).toBe(true);
      expect(permission.message).toContain("Already holding");
    });

    it("should release lock and promote next in queue", async () => {
      // Setup: Two conversations, first holds lock, second queued
      await manager.requestExecution("conv-123", "agent-1");
      await manager.requestExecution("conv-456", "agent-2");

      // Release first conversation
      await manager.releaseExecution("conv-123", "completed");

      // Check that second conversation now holds lock
      const currentLock = await manager.getCurrentLock();
      expect(currentLock?.conversationId).toBe("conv-456");
    });

    it("should handle force release", async () => {
      await manager.requestExecution("conv-123", "agent-1");

      await manager.forceRelease("conv-123", "manual_override");

      const currentLock = await manager.getCurrentLock();
      expect(currentLock).toBeNull();
    });

    it("should handle force release any", async () => {
      await manager.requestExecution("conv-123", "agent-1");

      const released = await manager.forceReleaseAny("emergency");

      expect(released).toBe("conv-123");
      const currentLock = await manager.getCurrentLock();
      expect(currentLock).toBeNull();
    });
  });

  describe("Queue Management", () => {
    it("should maintain queue order (FIFO)", async () => {
      // First conversation gets lock
      await manager.requestExecution("conv-1", "agent-1");

      // Queue multiple conversations
      const perm2 = await manager.requestExecution("conv-2", "agent-2");
      const perm3 = await manager.requestExecution("conv-3", "agent-3");
      const perm4 = await manager.requestExecution("conv-4", "agent-4");

      expect(perm2.queuePosition).toBe(1);
      expect(perm3.queuePosition).toBe(2);
      expect(perm4.queuePosition).toBe(3);

      // Release and check order
      await manager.releaseExecution("conv-1", "completed");
      let lock = await manager.getCurrentLock();
      expect(lock?.conversationId).toBe("conv-2");

      await manager.releaseExecution("conv-2", "completed");
      lock = await manager.getCurrentLock();
      expect(lock?.conversationId).toBe("conv-3");
    });

    it("should remove conversation from queue", async () => {
      await manager.requestExecution("conv-1", "agent-1");
      await manager.requestExecution("conv-2", "agent-2");
      await manager.requestExecution("conv-3", "agent-3");

      // Remove conv-2 from queue
      const removed = await manager.removeFromQueue("conv-2");
      expect(removed).toBe(true);

      // Check queue status
      const status = await manager.getQueueStatus();
      expect(status.totalWaiting).toBe(1);
      expect(status.queue[0].conversationId).toBe("conv-3");
    });

    it("should return correct queue position", async () => {
      await manager.requestExecution("conv-1", "agent-1");
      await manager.requestExecution("conv-2", "agent-2");
      await manager.requestExecution("conv-3", "agent-3");

      const pos2 = await manager.getQueuePosition("conv-2");
      const pos3 = await manager.getQueuePosition("conv-3");
      const posNone = await manager.getQueuePosition("conv-999");

      expect(pos2).toBe(1);
      expect(pos3).toBe(2);
      expect(posNone).toBe(0);
    });

    it("should check if conversation is queued", async () => {
      await manager.requestExecution("conv-1", "agent-1");
      await manager.requestExecution("conv-2", "agent-2");

      const isQueued = await manager.isQueued("conv-2");
      const notQueued = await manager.isQueued("conv-999");

      expect(isQueued).toBe(true);
      expect(notQueued).toBe(false);
    });

    it("should check if conversation is executing", async () => {
      await manager.requestExecution("conv-1", "agent-1");
      await manager.requestExecution("conv-2", "agent-2");

      const isExecuting1 = await manager.isExecuting("conv-1");
      const isExecuting2 = await manager.isExecuting("conv-2");

      expect(isExecuting1).toBe(true);
      expect(isExecuting2).toBe(false);
    });
  });

  describe("Timeout Management", () => {
    it.skip("should emit timeout event after duration - REMOVED TIMEOUTS", (done) => {
      const shortConfig: Partial<ExecutionQueueConfig> = {
        // Timeouts removed
      };

      const timeoutManager = new ExecutionQueueManager(
        testProjectPath,
        shortConfig
      );

      timeoutManager.on("timeout", (conversationId) => {
        expect(conversationId).toBe("conv-timeout");
        done();
      });

      timeoutManager.requestExecution("conv-timeout", "agent-1").then(() => {
        // Wait for timeout
      });
    }, 1000);

    it.skip("should clear timeout on release - REMOVED TIMEOUTS", async () => {
      let timeoutFired = false;

      manager.on("timeout", () => {
        timeoutFired = true;
      });

      await manager.requestExecution("conv-123", "agent-1");

      // Release before timeout
      await manager.releaseExecution("conv-123", "completed");

      // Wait a bit to ensure timeout doesn't fire
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(timeoutFired).toBe(false);
    });
  });

  describe("Status and Monitoring", () => {
    it("should return full status", async () => {
      await manager.requestExecution("conv-1", "agent-1");
      await manager.requestExecution("conv-2", "agent-2");
      await manager.requestExecution("conv-3", "agent-3");

      const status = await manager.getFullStatus();

      expect(status.lock?.conversationId).toBe("conv-1");
      expect(status.queue.totalWaiting).toBe(2);
      expect(status.queue.queue.length).toBe(2);
      // Timeout config removed
    });

    it("should clear all state", async () => {
      await manager.requestExecution("conv-1", "agent-1");
      await manager.requestExecution("conv-2", "agent-2");
      await manager.requestExecution("conv-3", "agent-3");

      await manager.clearAll();

      const status = await manager.getFullStatus();
      expect(status.lock).toBeNull();
      expect(status.queue.totalWaiting).toBe(0);
    });
  });

  describe("Persistence", () => {
    it("should persist lock across restarts", async () => {
      // Create and acquire lock
      await manager.requestExecution("conv-persist", "agent-1");

      // Create new manager instance (simulating restart)
      const newManager = new ExecutionQueueManager(
        testProjectPath,
        config
      );
      await newManager.initialize();

      // Check lock is restored
      const lock = await newManager.getCurrentLock();
      expect(lock?.conversationId).toBe("conv-persist");

      // Clean up
      await newManager.clearAll();
    });

    it("should persist queue across restarts", async () => {
      // Setup queue
      await manager.requestExecution("conv-1", "agent-1");
      await manager.requestExecution("conv-2", "agent-2");
      await manager.requestExecution("conv-3", "agent-3");

      // Create new manager instance
      const newManager = new ExecutionQueueManager(
        testProjectPath,
        config
      );
      await newManager.initialize();

      // Check queue is restored
      const status = await newManager.getQueueStatus();
      expect(status.totalWaiting).toBe(2);
      expect(status.queue[0].conversationId).toBe("conv-2");
      expect(status.queue[1].conversationId).toBe("conv-3");

      // Clean up
      await newManager.clearAll();
    });

    it.skip("should clear expired lock on startup - REMOVED TIMEOUTS", async () => {
      // Create manager with very short timeout
      const expireConfig: Partial<ExecutionQueueConfig> = {
        enablePersistence: true,
      };

      const expireManager = new ExecutionQueueManager(
        testProjectPath,
        expireConfig
      );
      await expireManager.initialize();

      // Acquire lock
      await expireManager.requestExecution("conv-expired", "agent-1");

      // Wait for lock to expire
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Create new manager
      const newManager = new ExecutionQueueManager(
        testProjectPath,
        expireConfig
      );
      await newManager.initialize();

      // Lock should be cleared due to expiry
      const lock = await newManager.getCurrentLock();
      expect(lock).toBeNull();

      // Clean up
      await newManager.clearAll();
    });
  });

  describe("Event Emissions", () => {
    it("should emit lock-acquired event", (done) => {
      manager.on("lock-acquired", (conversationId, agentPubkey) => {
        expect(conversationId).toBe("conv-event");
        expect(agentPubkey).toBe("agent-event");
        done();
      });

      manager.requestExecution("conv-event", "agent-event");
    });

    it("should emit lock-released event", (done) => {
      manager.on("lock-released", (conversationId, reason) => {
        expect(conversationId).toBe("conv-release");
        expect(reason).toBe("test-reason");
        done();
      });

      manager.requestExecution("conv-release", "agent-1").then(() => {
        manager.releaseExecution("conv-release", "test-reason");
      });
    });

    it("should emit queue-joined event", (done) => {
      manager.on("queue-joined", (conversationId, position) => {
        expect(conversationId).toBe("conv-queued");
        expect(position).toBe(1);
        done();
      });

      manager.requestExecution("conv-first", "agent-1").then(() => {
        manager.requestExecution("conv-queued", "agent-2");
      });
    });

    it("should emit queue-left event on removal", (done) => {
      manager.on("queue-left", (conversationId) => {
        expect(conversationId).toBe("conv-removed");
        done();
      });

      manager
        .requestExecution("conv-first", "agent-1")
        .then(() => {
          return manager.requestExecution("conv-removed", "agent-2");
        })
        .then(() => {
          manager.removeFromQueue("conv-removed");
        });
    });
  });
});
