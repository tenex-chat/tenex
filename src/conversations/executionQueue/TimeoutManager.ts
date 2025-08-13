import { EventEmitter } from 'events';
import { ExecutionQueueConfig, DEFAULT_EXECUTION_QUEUE_CONFIG } from './types';

export interface TimeoutManagerEvents {
  'timeout': (conversationId: string) => void;
  'warning': (conversationId: string, remainingMs: number) => void;
}

export class TimeoutManager extends EventEmitter {
  private timeouts: Map<string, NodeJS.Timeout> = new Map();
  private warnings: Map<string, NodeJS.Timeout> = new Map();
  private config: ExecutionQueueConfig;
  private readonly WARNING_THRESHOLD = 5 * 60 * 1000; // 5 minutes before timeout

  constructor(config: Partial<ExecutionQueueConfig> = {}) {
    super();
    this.config = { ...DEFAULT_EXECUTION_QUEUE_CONFIG, ...config };
  }

  startTimeout(conversationId: string, duration?: number): void {
    if (!this.config.enableAutoTimeout) {
      return;
    }

    this.clearTimeout(conversationId);

    const timeoutDuration = duration || this.config.maxExecutionDuration!;

    // Set up warning timeout (5 minutes before expiry)
    if (timeoutDuration > this.WARNING_THRESHOLD) {
      const warningTimeout = setTimeout(() => {
        this.emit('warning', conversationId, this.WARNING_THRESHOLD);
        this.warnings.delete(conversationId);
      }, timeoutDuration - this.WARNING_THRESHOLD);

      this.warnings.set(conversationId, warningTimeout);
    }

    // Set up main timeout
    const timeout = setTimeout(() => {
      this.emit('timeout', conversationId);
      this.timeouts.delete(conversationId);
      this.warnings.delete(conversationId);
    }, timeoutDuration);

    this.timeouts.set(conversationId, timeout);
  }

  clearTimeout(conversationId: string): void {
    // Clear main timeout
    const timeout = this.timeouts.get(conversationId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(conversationId);
    }

    // Clear warning timeout
    const warning = this.warnings.get(conversationId);
    if (warning) {
      clearTimeout(warning);
      this.warnings.delete(conversationId);
    }
  }

  extendTimeout(conversationId: string, additionalMs: number): void {
    if (!this.config.enableAutoTimeout) {
      return;
    }

    const existingTimeout = this.timeouts.get(conversationId);
    if (!existingTimeout) {
      return; // No timeout to extend
    }

    // Clear existing timeouts
    this.clearTimeout(conversationId);

    // Start new timeout with extended duration
    this.startTimeout(conversationId, this.config.maxExecutionDuration! + additionalMs);
  }

  getRemainingTime(conversationId: string): number | null {
    const timeout = this.timeouts.get(conversationId);
    if (!timeout) {
      return null;
    }

    // Node.js timeout objects have a _idleStart property we can use
    // This is a bit hacky but works for our purposes
    // In production, we might want to track start times separately
    const timeoutObj = timeout as any;
    if (timeoutObj._idleStart) {
      const elapsed = Date.now() - timeoutObj._idleStart;
      const remaining = this.config.maxExecutionDuration! - elapsed;
      return Math.max(0, remaining);
    }

    return null;
  }

  isActive(conversationId: string): boolean {
    return this.timeouts.has(conversationId);
  }

  clearAll(): void {
    // Clear all timeouts
    for (const timeout of this.timeouts.values()) {
      clearTimeout(timeout);
    }
    this.timeouts.clear();

    // Clear all warnings
    for (const warning of this.warnings.values()) {
      clearTimeout(warning);
    }
    this.warnings.clear();
  }

  getActiveTimeouts(): string[] {
    return Array.from(this.timeouts.keys());
  }

  // Utility method for debugging
  getTimeoutInfo(): {
    activeTimeouts: string[];
    activeWarnings: string[];
    config: {
      enableAutoTimeout: boolean;
      maxExecutionDuration: number;
      warningThreshold: number;
    };
  } {
    return {
      activeTimeouts: Array.from(this.timeouts.keys()),
      activeWarnings: Array.from(this.warnings.keys()),
      config: {
        enableAutoTimeout: this.config.enableAutoTimeout!,
        maxExecutionDuration: this.config.maxExecutionDuration!,
        warningThreshold: this.WARNING_THRESHOLD
      }
    };
  }

  // Override EventEmitter methods for type safety
  on<K extends keyof TimeoutManagerEvents>(
    event: K,
    listener: TimeoutManagerEvents[K]
  ): this {
    return super.on(event, listener);
  }

  emit<K extends keyof TimeoutManagerEvents>(
    event: K,
    ...args: Parameters<TimeoutManagerEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  off<K extends keyof TimeoutManagerEvents>(
    event: K,
    listener: TimeoutManagerEvents[K]
  ): this {
    return super.off(event, listener);
  }
}