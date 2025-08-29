/**
 * Types and interfaces for the Execution Queue Mutex System
 */

export interface ExecutionLock {
  conversationId: string;
  agentPubkey: string;
  timestamp: number;
}

export interface QueueEntry {
  conversationId: string;
  agentPubkey: string;
  timestamp: number; // When added to queue
  retryCount: number; // Number of retry attempts
}

export interface QueueStatus {
  totalWaiting: number;
  estimatedWait: number; // Seconds
  queue: QueueEntry[];
}

export interface ExecutionPermission {
  granted: boolean;
  waitTime?: number; // Estimated wait time in seconds
  queuePosition?: number; // Position in queue (1-based)
  message?: string; // User-friendly message
}

export interface PersistedLock {
  conversationId: string;
  agentPubkey: string;
  timestamp: number;
  projectPath: string;
}

export interface ExecutionHistory {
  conversationId: string;
  startTime: number;
  endTime: number;
  agentPubkey: string;
  reason: "completed" | "forced" | "error";
}

export interface ForceReleaseRequest {
  conversationId: string;
  reason: string;
  releasedBy: string;
  timestamp: number;
}

export interface ExecutionQueueEvent {
  type: "lock_acquired" | "lock_released" | "queue_joined" | "queue_left" | "force_released";
  conversationId: string;
  agentPubkey?: string;
  timestamp: number;
  details?: Record<string, unknown>;
}

export interface ExecutionQueueConfig {
  maxQueueSize?: number; // Default: 100
  maxHistorySize?: number; // Default: 1000
  persistenceDir?: string; // Default: .tenex/state
  enablePersistence?: boolean; // Default: true
}

export const DEFAULT_EXECUTION_QUEUE_CONFIG: ExecutionQueueConfig = {
  maxQueueSize: 100,
  maxHistorySize: 1000,
  enablePersistence: true,
};
