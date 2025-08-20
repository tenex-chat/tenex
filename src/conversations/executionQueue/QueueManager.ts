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
  type ExecutionHistory,
  type ExecutionQueueConfig,
  type QueueEntry,
  type QueueStatus,
} from "./types";

export class QueueManager {
  private queue: QueueEntry[] = [];
  private executionHistory: ExecutionHistory[] = [];
  private queueFile: string;
  private historyFile: string;
  private config: ExecutionQueueConfig;

  constructor(projectPath: string, config: Partial<ExecutionQueueConfig> = {}) {
    this.config = { ...DEFAULT_EXECUTION_QUEUE_CONFIG, ...config };
    const persistenceDir = this.config.persistenceDir || path.join(projectPath, ".tenex", "state");
    this.queueFile = path.join(persistenceDir, "execution-queue.json");
    this.historyFile = path.join(persistenceDir, "execution-history.json");
  }

  async initialize(): Promise<void> {
    if (this.config.enablePersistence) {
      // Ensure persistence directory exists
      const queueDir = path.dirname(this.queueFile);
      await ensureDirectory(queueDir);

      // Load queue and history from disk
      await this.loadQueueFromDisk();
      await this.loadHistoryFromDisk();
    }
  }

  async enqueue(conversationId: string, agentPubkey: string): Promise<number> {
    // Check if already in queue
    const existingIndex = this.queue.findIndex((entry) => entry.conversationId === conversationId);

    if (existingIndex >= 0) {
      return existingIndex + 1; // Return 1-based position
    }

    // Check queue size limit
    const maxQueueSize =
      this.config.maxQueueSize ?? (DEFAULT_EXECUTION_QUEUE_CONFIG.maxQueueSize || 10);
    if (this.queue.length >= maxQueueSize) {
      throw new Error(`Queue is full (max size: ${maxQueueSize})`);
    }

    const entry: QueueEntry = {
      conversationId,
      agentPubkey,
      timestamp: Date.now(),
      retryCount: 0,
    };

    this.queue.push(entry);

    if (this.config.enablePersistence) {
      await this.saveQueueToDisk();
    }

    return this.queue.length;
  }

  async dequeue(): Promise<QueueEntry | null> {
    if (this.queue.length === 0) {
      return null;
    }

    const entry = this.queue.shift();

    if (this.config.enablePersistence) {
      await this.saveQueueToDisk();
    }

    return entry || null;
  }

  async removeFromQueue(conversationId: string): Promise<boolean> {
    const initialLength = this.queue.length;
    this.queue = this.queue.filter((entry) => entry.conversationId !== conversationId);

    if (this.queue.length !== initialLength) {
      if (this.config.enablePersistence) {
        await this.saveQueueToDisk();
      }
      return true;
    }

    return false;
  }

  async requeue(entry: QueueEntry): Promise<number> {
    // Increment retry count
    entry.retryCount++;

    // Add back to front of queue (priority for retries)
    this.queue.unshift(entry);

    if (this.config.enablePersistence) {
      await this.saveQueueToDisk();
    }

    return 1; // Always position 1 for requeued items
  }

  getQueueStatus(): QueueStatus {
    return {
      totalWaiting: this.queue.length,
      estimatedWait: this.calculateEstimatedWait(),
      queue: [...this.queue], // Return copy
    };
  }

  getQueuePosition(conversationId: string): number {
    const index = this.queue.findIndex((entry) => entry.conversationId === conversationId);
    return index >= 0 ? index + 1 : 0;
  }

  isInQueue(conversationId: string): boolean {
    return this.queue.some((entry) => entry.conversationId === conversationId);
  }

  async addToHistory(history: ExecutionHistory): Promise<void> {
    this.executionHistory.push(history);

    // Trim history if it exceeds max size
    const maxHistorySize =
      this.config.maxHistorySize ?? (DEFAULT_EXECUTION_QUEUE_CONFIG.maxHistorySize || 100);
    if (this.executionHistory.length > maxHistorySize) {
      this.executionHistory = this.executionHistory.slice(-maxHistorySize);
    }

    if (this.config.enablePersistence) {
      await this.saveHistoryToDisk();
    }
  }

  getRecentExecutionHistory(count = 50): ExecutionHistory[] {
    return this.executionHistory.slice(-count);
  }

  getAverageExecutionTime(): number {
    const recentExecutions = this.getRecentExecutionHistory(50);

    if (recentExecutions.length === 0) {
      return 10 * 60; // Default 10 minutes in seconds
    }

    const validExecutions = recentExecutions.filter(
      (exec) => exec.reason === "completed" && exec.endTime > exec.startTime
    );

    if (validExecutions.length === 0) {
      return 10 * 60; // Default if no valid executions
    }

    const totalTime = validExecutions.reduce((sum, execution) => {
      return sum + (execution.endTime - execution.startTime);
    }, 0);

    return totalTime / validExecutions.length / 1000; // Convert to seconds
  }

  private calculateEstimatedWait(): number {
    if (this.queue.length === 0) {
      return 0;
    }

    // Base estimation on historical execution times
    const averageExecutionTime = this.getAverageExecutionTime();

    // Estimate for queued conversations (assuming current execution is halfway done)
    const currentExecutionRemaining = averageExecutionTime / 2;
    const queuedExecutionTime = (this.queue.length - 1) * averageExecutionTime;

    return currentExecutionRemaining + queuedExecutionTime;
  }

  private async saveQueueToDisk(): Promise<void> {
    try {
      await writeJsonFile(this.queueFile, this.queue);
    } catch (error) {
      handlePersistenceError("save queue to disk", error);
      // Don't throw - allow operation to continue without persistence
    }
  }

  private async loadQueueFromDisk(): Promise<void> {
    try {
      this.queue = await readJsonFile<QueueEntry[]>(this.queueFile);

      // Validate queue entries
      this.queue = this.queue.filter(
        (entry) => entry.conversationId && entry.agentPubkey && typeof entry.timestamp === "number"
      );
    } catch (error) {
      if (!(await fileExists(this.queueFile))) {
        this.queue = []; // No queue file exists
      } else {
        handlePersistenceError("load queue from disk", error);
        this.queue = [];
      }
    }
  }

  private async saveHistoryToDisk(): Promise<void> {
    try {
      await writeJsonFile(this.historyFile, this.executionHistory);
    } catch (error) {
      handlePersistenceError("save history to disk", error);
      // Don't throw - allow operation to continue without persistence
    }
  }

  private async loadHistoryFromDisk(): Promise<void> {
    try {
      this.executionHistory = await readJsonFile<ExecutionHistory[]>(this.historyFile);

      // Validate history entries
      this.executionHistory = this.executionHistory.filter(
        (entry) =>
          entry.conversationId &&
          typeof entry.startTime === "number" &&
          typeof entry.endTime === "number"
      );

      // Trim to max size
      const maxHistorySize =
        this.config.maxHistorySize ?? (DEFAULT_EXECUTION_QUEUE_CONFIG.maxHistorySize || 100);
      if (this.executionHistory.length > maxHistorySize) {
        this.executionHistory = this.executionHistory.slice(-maxHistorySize);
      }
    } catch (error) {
      if (!(await fileExists(this.historyFile))) {
        this.executionHistory = []; // No history file exists
      } else {
        handlePersistenceError("load history from disk", error);
        this.executionHistory = [];
      }
    }
  }

  // Utility methods for monitoring and debugging
  getQueueInfo(): {
    queueLength: number;
    entries: QueueEntry[];
    estimatedWait: number;
    averageExecutionTime: number;
    historySize: number;
  } {
    return {
      queueLength: this.queue.length,
      entries: [...this.queue],
      estimatedWait: this.calculateEstimatedWait(),
      averageExecutionTime: this.getAverageExecutionTime(),
      historySize: this.executionHistory.length,
    };
  }

  clearQueue(): void {
    this.queue = [];
    if (this.config.enablePersistence) {
      this.saveQueueToDisk().catch((error) =>
        handlePersistenceError("save queue after update", error)
      );
    }
  }

  clearHistory(): void {
    this.executionHistory = [];
    if (this.config.enablePersistence) {
      this.saveHistoryToDisk().catch((error) =>
        handlePersistenceError("save history after update", error)
      );
    }
  }
}
