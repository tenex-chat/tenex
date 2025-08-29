import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  ensureDirectory,
  fileExists,
  handlePersistenceError,
  readJsonFile,
  writeJsonFile,
} from "../../utils/file-persistence";
import {
  DEFAULT_EXECUTION_QUEUE_CONFIG,
  type ExecutionLock,
  type ExecutionQueueConfig,
  type PersistedLock,
} from "./types";

export class LockManager {
  private currentLock: ExecutionLock | null = null;
  private lockFile: string;
  private config: ExecutionQueueConfig;

  constructor(
    private projectPath: string,
    config: Partial<ExecutionQueueConfig> = {}
  ) {
    this.config = { ...DEFAULT_EXECUTION_QUEUE_CONFIG, ...config };
    const persistenceDir = this.config.persistenceDir || path.join(projectPath, ".tenex", "state");
    this.lockFile = path.join(persistenceDir, "execution-lock.json");
  }

  async initialize(): Promise<void> {
    if (this.config.enablePersistence) {
      // Ensure persistence directory exists
      const lockDir = path.dirname(this.lockFile);
      await ensureDirectory(lockDir);

      // Try to load existing lock from disk
      this.currentLock = await this.loadLockFromDisk();
    }
  }

  async getCurrentLock(): Promise<ExecutionLock | null> {
    if (this.currentLock) {
      return this.currentLock;
    }

    // Try to load from persistent storage
    if (this.config.enablePersistence) {
      const persistedLock = await this.loadLockFromDisk();
      if (persistedLock) {
        this.currentLock = persistedLock;
        return persistedLock;
      }
    }

    return null;
  }

  async acquireLock(conversationId: string, agentPubkey: string): Promise<boolean> {
    const currentLock = await this.getCurrentLock();

    if (currentLock && currentLock.conversationId !== conversationId) {
      return false; // Lock held by another conversation
    }

    const lock: ExecutionLock = {
      conversationId,
      agentPubkey,
      timestamp: Date.now(),
    };

    this.currentLock = lock;

    if (this.config.enablePersistence) {
      await this.saveLockToDisk(lock);
    }

    return true;
  }

  async releaseLock(conversationId: string): Promise<boolean> {
    const currentLock = await this.getCurrentLock();

    if (!currentLock || currentLock.conversationId !== conversationId) {
      return false; // Not holding the lock
    }

    this.currentLock = null;

    if (this.config.enablePersistence) {
      await this.deleteLockFromDisk();
    }

    return true;
  }

  async forceRelease(conversationId: string): Promise<boolean> {
    const currentLock = await this.getCurrentLock();

    if (!currentLock || currentLock.conversationId !== conversationId) {
      return false; // Lock not held by this conversation
    }

    this.currentLock = null;

    if (this.config.enablePersistence) {
      await this.deleteLockFromDisk();
    }

    return true;
  }

  async forceReleaseAny(): Promise<string | null> {
    const currentLock = await this.getCurrentLock();

    if (!currentLock) {
      return null; // No lock to release
    }

    const releasedConversationId = currentLock.conversationId;
    this.currentLock = null;

    if (this.config.enablePersistence) {
      await this.deleteLockFromDisk();
    }

    return releasedConversationId;
  }

  isLockExpired(_lock: ExecutionLock): boolean {
    // Timeouts removed - locks never expire
    return false;
  }

  getLockAge(lock: ExecutionLock): number {
    return Date.now() - lock.timestamp;
  }

  getRemainingTime(_lock: ExecutionLock): number {
    // Timeouts removed - infinite time remaining
    return Number.POSITIVE_INFINITY;
  }


  private async saveLockToDisk(lock: ExecutionLock): Promise<void> {
    const persistedLock: PersistedLock = {
      ...lock,
      projectPath: this.projectPath,
    };

    try {
      await writeJsonFile(this.lockFile, persistedLock);
    } catch (error) {
      handlePersistenceError("save lock to disk", error);
      // Don't throw - allow operation to continue without persistence
    }
  }

  private async loadLockFromDisk(): Promise<ExecutionLock | null> {
    try {
      const persistedLock = await readJsonFile<PersistedLock>(this.lockFile);

      // Verify this lock belongs to the current project
      if (persistedLock.projectPath !== this.projectPath) {
        // Lock file from different project, ignore it
        await this.deleteLockFromDisk();
        return null;
      }

      // Convert persisted lock to ExecutionLock
      const lock: ExecutionLock = {
        conversationId: persistedLock.conversationId,
        agentPubkey: persistedLock.agentPubkey,
        timestamp: persistedLock.timestamp,
      };

      if (this.isLockExpired(lock)) {
        await this.deleteLockFromDisk(); // Remove expired lock
        return null;
      }

      return lock;
    } catch (error) {
      if (!(await fileExists(this.lockFile))) {
        return null; // No lock file exists
      }
      handlePersistenceError("load lock from disk", error);
      return null;
    }
  }

  private async deleteLockFromDisk(): Promise<void> {
    try {
      await fs.unlink(this.lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        handlePersistenceError("delete lock file", error);
      }
      // Don't throw - allow operation to continue
    }
  }

  // Utility methods for monitoring and debugging
  async getLockInfo(): Promise<{
    isLocked: boolean;
    lock?: ExecutionLock;
    age?: number;
    remainingTime?: number;
    isExpired?: boolean;
  }> {
    const lock = await this.getCurrentLock();

    if (!lock) {
      return { isLocked: false };
    }

    return {
      isLocked: true,
      lock,
      age: this.getLockAge(lock),
      remainingTime: this.getRemainingTime(lock),
      isExpired: this.isLockExpired(lock),
    };
  }
}
