import * as path from 'path';
import * as fs from 'fs/promises';
import { ExecutionLock, PersistedLock, ExecutionQueueConfig, DEFAULT_EXECUTION_QUEUE_CONFIG } from './types';
import { writeJsonFile, readJsonFile, ensureDirectory, handlePersistenceError, fileExists } from '../../utils/file-persistence';

export class LockManager {
  private currentLock: ExecutionLock | null = null;
  private lockFile: string;
  private config: ExecutionQueueConfig;

  constructor(
    private projectPath: string,
    config: Partial<ExecutionQueueConfig> = {}
  ) {
    this.config = { ...DEFAULT_EXECUTION_QUEUE_CONFIG, ...config };
    const persistenceDir = this.config.persistenceDir || path.join(projectPath, '.tenex', 'state');
    this.lockFile = path.join(persistenceDir, 'execution-lock.json');
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
    if (this.currentLock && !this.isLockExpired(this.currentLock)) {
      return this.currentLock;
    }

    // If current lock is expired, clear it
    if (this.currentLock && this.isLockExpired(this.currentLock)) {
      await this.clearExpiredLock();
      return null;
    }

    // Try to load from persistent storage
    if (this.config.enablePersistence) {
      const persistedLock = await this.loadLockFromDisk();
      if (persistedLock && !this.isLockExpired(persistedLock)) {
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
      maxDuration: this.config.maxExecutionDuration ?? (DEFAULT_EXECUTION_QUEUE_CONFIG.maxExecutionDuration || 300000)
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

  isLockExpired(lock: ExecutionLock): boolean {
    if (!this.config.enableAutoTimeout) {
      return false;
    }

    const now = Date.now();
    const lockAge = now - lock.timestamp;
    return lockAge > lock.maxDuration;
  }

  getLockAge(lock: ExecutionLock): number {
    return Date.now() - lock.timestamp;
  }

  getRemainingTime(lock: ExecutionLock): number {
    if (!this.config.enableAutoTimeout) {
      return Infinity;
    }

    const age = this.getLockAge(lock);
    return Math.max(0, lock.maxDuration - age);
  }

  private async clearExpiredLock(): Promise<void> {
    this.currentLock = null;
    
    if (this.config.enablePersistence) {
      await this.deleteLockFromDisk();
    }
  }

  private async saveLockToDisk(lock: ExecutionLock): Promise<void> {
    const persistedLock: PersistedLock = {
      ...lock,
      projectPath: this.projectPath
    };

    try {
      await writeJsonFile(this.lockFile, persistedLock);
    } catch (error) {
      handlePersistenceError('save lock to disk', error);
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

      // Check if lock has expired
      const lock: ExecutionLock = {
        conversationId: persistedLock.conversationId,
        agentPubkey: persistedLock.agentPubkey,
        timestamp: persistedLock.timestamp,
        maxDuration: persistedLock.maxDuration
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
      handlePersistenceError('load lock from disk', error);
      return null;
    }
  }

  private async deleteLockFromDisk(): Promise<void> {
    try {
      await fs.unlink(this.lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        handlePersistenceError('delete lock file', error);
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
      isExpired: this.isLockExpired(lock)
    };
  }
}