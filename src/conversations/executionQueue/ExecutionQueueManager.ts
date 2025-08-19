import { EventEmitter } from 'events';
import { LockManager } from './LockManager';
import { QueueManager } from './QueueManager';
import { TimeoutManager } from './TimeoutManager';
import {
  ExecutionPermission,
  ExecutionQueueConfig,
  DEFAULT_EXECUTION_QUEUE_CONFIG,
  ExecutionHistory,
  ExecutionLock,
  QueueStatus
} from './types';

export interface ExecutionQueueManagerEvents {
  'lock-acquired': (conversationId: string, agentPubkey: string) => void;
  'lock-released': (conversationId: string, reason: string) => void;
  'queue-joined': (conversationId: string, position: number) => void;
  'queue-left': (conversationId: string) => void;
  'timeout-warning': (conversationId: string, remainingMs: number) => void;
  'timeout': (conversationId: string) => void;
}

export class ExecutionQueueManager extends EventEmitter {
  private lockManager: LockManager;
  private queueManager: QueueManager;
  private timeoutManager: TimeoutManager;
  private config: ExecutionQueueConfig;
  private initialized = false;

  constructor(
    projectPath: string,
    _projectPubkey?: string,
    _projectIdentifier?: string,
    config: Partial<ExecutionQueueConfig> = {}
  ) {
    super();
    this.config = { ...DEFAULT_EXECUTION_QUEUE_CONFIG, ...config };
    
    // Initialize components
    this.lockManager = new LockManager(projectPath, config);
    this.queueManager = new QueueManager(projectPath, config);
    this.timeoutManager = new TimeoutManager(config);

    // Set up timeout event handlers
    this.setupTimeoutHandlers();
  }

  private setupTimeoutHandlers(): void {
    this.timeoutManager.on('timeout', async (conversationId) => {
      await this.handleTimeout(conversationId);
    });

    this.timeoutManager.on('warning', async (conversationId, remainingMs) => {
      this.emit('timeout-warning', conversationId, remainingMs);
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.lockManager.initialize();
    await this.queueManager.initialize();
    this.initialized = true;

    // Check for any stale locks on startup
    await this.checkStaleLock();
  }

  private async checkStaleLock(): Promise<void> {
    const lock = await this.lockManager.getCurrentLock();
    if (lock && this.lockManager.isLockExpired(lock)) {
      // Release the stale lock
      await this.forceRelease(lock.conversationId, 'stale_lock_on_startup');
    }
  }

  async requestExecution(conversationId: string, agentPubkey: string): Promise<ExecutionPermission> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Check current lock status
    const currentLock = await this.lockManager.getCurrentLock();

    if (!currentLock) {
      // Lock is available, acquire immediately
      return await this.acquireLock(conversationId, agentPubkey);
    }

    if (currentLock.conversationId === conversationId) {
      // Already holds the lock
      return { 
        granted: true, 
        waitTime: 0,
        message: 'Already holding execution lock'
      };
    }

    // Add to queue and wait
    const position = await this.queueManager.enqueue(conversationId, agentPubkey);
    const estimatedWait = this.queueManager.getQueueStatus().estimatedWait;

    // Emit queue joined event
    this.emit('queue-joined', conversationId, position);

    return {
      granted: false,
      waitTime: estimatedWait,
      queuePosition: position,
      message: `Added to execution queue at position ${position}. Estimated wait: ${this.formatWaitTime(estimatedWait)}`
    };
  }

  private async acquireLock(conversationId: string, agentPubkey: string): Promise<ExecutionPermission> {
    const acquired = await this.lockManager.acquireLock(conversationId, agentPubkey);

    if (!acquired) {
      throw new Error('Failed to acquire lock when it should be available');
    }

    // Start timeout timer
    this.timeoutManager.startTimeout(conversationId, this.config.maxExecutionDuration);

    // Emit lock acquired event
    this.emit('lock-acquired', conversationId, agentPubkey);

    return {
      granted: true,
      waitTime: 0,
      message: 'Execution lock acquired successfully'
    };
  }

  async releaseExecution(conversationId: string, reason: string = 'completed'): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    const currentLock = await this.lockManager.getCurrentLock();
    
    if (!currentLock || currentLock.conversationId !== conversationId) {
      // Not holding the lock, nothing to release
      return;
    }

    // Clear timeout
    this.timeoutManager.clearTimeout(conversationId);

    // Record execution history
    const endTime = Date.now();
    const history: ExecutionHistory = {
      conversationId,
      startTime: currentLock.timestamp,
      endTime,
      agentPubkey: currentLock.agentPubkey,
      reason: reason as 'completed' | 'timeout' | 'forced' | 'error'
    };
    await this.queueManager.addToHistory(history);

    // Release the lock
    await this.lockManager.releaseLock(conversationId);

    // Emit lock released event
    this.emit('lock-released', conversationId, reason);

    // Process next in queue
    await this.processNextInQueue();
  }

  private async processNextInQueue(): Promise<void> {
    const nextEntry = await this.queueManager.dequeue();
    
    if (!nextEntry) {
      return; // Queue is empty
    }

    try {
      // Emit queue left event for the conversation being promoted
      this.emit('queue-left', nextEntry.conversationId);

      // Grant execution permission
      await this.acquireLock(nextEntry.conversationId, nextEntry.agentPubkey);

      // The conversation manager will be notified via events
      // and can transition the conversation to EXECUTE phase
    } catch (error) {
      console.error('Failed to process next in queue:', error);
      
      // If acquisition failed, try the next one
      await this.processNextInQueue();
    }
  }

  async forceRelease(conversationId: string, _reason: string): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    const currentLock = await this.lockManager.getCurrentLock();
    
    if (!currentLock || currentLock.conversationId !== conversationId) {
      // Not locked by this conversation
      return;
    }

    // Release the lock
    await this.releaseExecution(conversationId, 'forced');
  }

  async forceReleaseAny(reason: string): Promise<string | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    const currentLock = await this.lockManager.getCurrentLock();
    
    if (!currentLock) {
      return null;
    }

    await this.forceRelease(currentLock.conversationId, reason);
    return currentLock.conversationId;
  }

  private async handleTimeout(conversationId: string): Promise<void> {
    console.log(`Execution timeout for conversation ${conversationId}`);
    
    // Force release due to timeout
    await this.forceRelease(conversationId, 'timeout');

    // Emit timeout event
    this.emit('timeout', conversationId);
  }

  async removeFromQueue(conversationId: string): Promise<boolean> {
    if (!this.initialized) {
      await this.initialize();
    }

    const removed = await this.queueManager.removeFromQueue(conversationId);
    
    if (removed) {
      this.emit('queue-left', conversationId);
    }

    return removed;
  }

  async getCurrentLock(): Promise<ExecutionLock | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    return await this.lockManager.getCurrentLock();
  }

  async getQueueStatus(): Promise<QueueStatus> {
    if (!this.initialized) {
      await this.initialize();
    }

    return this.queueManager.getQueueStatus();
  }

  /**
   * Get the execution queue state for status publishing.
   * Returns the active conversation (if any) and the queued conversations in order.
   */
  async getExecutionQueueState(): Promise<{
    active: string | null;
    queued: string[];
  }> {
    if (!this.initialized) {
      await this.initialize();
    }

    const currentLock = await this.lockManager.getCurrentLock();
    const queueStatus = this.queueManager.getQueueStatus();

    return {
      active: currentLock?.conversationId || null,
      queued: queueStatus.queue.map(entry => entry.conversationId)
    };
  }

  async getQueuePosition(conversationId: string): Promise<number> {
    if (!this.initialized) {
      await this.initialize();
    }

    return this.queueManager.getQueuePosition(conversationId);
  }

  async isExecuting(conversationId: string): Promise<boolean> {
    const lock = await this.getCurrentLock();
    return lock?.conversationId === conversationId;
  }

  async isQueued(conversationId: string): Promise<boolean> {
    if (!this.initialized) {
      await this.initialize();
    }

    return this.queueManager.isInQueue(conversationId);
  }


  private formatWaitTime(seconds: number): string {
    if (seconds < 60) {
      return `${Math.floor(seconds)} seconds`;
    } else if (seconds < 3600) {
      return `${Math.floor(seconds / 60)} minutes`;
    } else {
      return `${Math.floor(seconds / 3600)} hours`;
    }
  }

  // Utility methods for monitoring and debugging
  async getFullStatus(): Promise<{
    lock: ExecutionLock | null;
    queue: QueueStatus;
    activeTimeouts: string[];
    config: ExecutionQueueConfig;
  }> {
    if (!this.initialized) {
      await this.initialize();
    }

    return {
      lock: await this.lockManager.getCurrentLock(),
      queue: this.queueManager.getQueueStatus(),
      activeTimeouts: this.timeoutManager.getActiveTimeouts(),
      config: this.config
    };
  }

  async clearAll(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Clear all timeouts
    this.timeoutManager.clearAll();

    // Force release any lock
    await this.lockManager.forceReleaseAny();

    // Clear the queue
    this.queueManager.clearQueue();
  }

  // Override EventEmitter methods for type safety
  on<K extends keyof ExecutionQueueManagerEvents>(
    event: K,
    listener: ExecutionQueueManagerEvents[K]
  ): this {
    return super.on(event, listener);
  }

  emit<K extends keyof ExecutionQueueManagerEvents>(
    event: K,
    ...args: Parameters<ExecutionQueueManagerEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  off<K extends keyof ExecutionQueueManagerEvents>(
    event: K,
    listener: ExecutionQueueManagerEvents[K]
  ): this {
    return super.off(event, listener);
  }
}