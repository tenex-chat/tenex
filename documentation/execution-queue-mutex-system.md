# Execution Queue Mutex System Specification

## Executive Summary

The Execution Queue Mutex System implements a project-wide synchronization mechanism that ensures only one conversation per project can be in the EXECUTE phase at any given time. This system prevents execution conflicts, resource contention, and ensures deterministic task completion while providing fair queuing for waiting conversations. Built on the existing Nostr event-driven architecture, it seamlessly integrates with TENEX's conversation management system to provide transparent coordination without disrupting user experience.

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Solution Overview](#solution-overview)
3. [System Architecture](#system-architecture)
4. [Event Schema Definitions](#event-schema-definitions)
5. [Core Components](#core-components)
6. [Queue Management](#queue-management)
7. [Lock Lifecycle](#lock-lifecycle)
8. [Integration Points](#integration-points)
9. [User Experience](#user-experience)
10. [Error Handling](#error-handling)
11. [CLI Interface](#cli-interface)
12. [Implementation Guidelines](#implementation-guidelines)
13. [Security Considerations](#security-considerations)
14. [Performance Considerations](#performance-considerations)
15. [Future Extensions](#future-extensions)

## Problem Statement

### Current Challenges

TENEX currently allows multiple conversations within a project to simultaneously enter the EXECUTE phase, leading to several critical issues:

1. **Resource Conflicts**: Multiple conversations attempting to modify the same files, databases, or external systems
2. **State Inconsistency**: Concurrent executions can leave the project in an undefined state
3. **Tool Contention**: Shell commands and file operations from different conversations interfering with each other
4. **Merge Conflicts**: Simultaneous Git operations causing branch conflicts
5. **Unpredictable Outcomes**: Race conditions making execution results non-deterministic

### Requirements

The solution must provide:

- **Mutual Exclusion**: Only one conversation can execute at a time per project
- **Fair Queuing**: First-come-first-served ordering with transparent wait times
- **Automatic Recovery**: System handles failures and timeouts gracefully
- **Manual Override**: Administrative controls for stuck executions
- **User Transparency**: Clear feedback about queue status and wait times
- **Distributed Coordination**: Works across multiple TENEX instances

## Solution Overview

### Core Concept

The Execution Queue Mutex System implements a distributed lock mechanism using Nostr events as the coordination medium. Each project maintains:

1. **Execution Lock**: A unique lock that must be acquired before entering EXECUTE phase
2. **Execution Queue**: An ordered list of conversations waiting to acquire the lock
3. **Status Broadcasting**: Real-time updates about queue state and active executions
4. **Timeout Management**: Automatic lock release for stalled executions
5. **Force Release**: Administrative override for emergency situations

### Key Benefits

- **Zero Configuration**: Works out-of-the-box with existing TENEX installations
- **Fault Tolerant**: Automatically recovers from crashes and network partitions
- **User Friendly**: Transparent operation with clear status feedback
- **Administratively Controllable**: Manual overrides when needed
- **Distributed Ready**: Scales across multiple TENEX instances

## System Architecture

### Component Interaction

```
┌─────────────────────────────────────────────────────────────────┐
│                    Nostr Event Layer                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │ Kind 24010  │  │ Kind 24019  │  │ Other Conversation      │ │
│  │ Project     │  │ Force       │  │ Events                  │ │
│  │ Status      │  │ Release     │  │                         │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
└─────────────┬─────────────────────┬─────────────────────────────┘
              │                     │
              ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                ExecutionQueueManager                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │ Lock        │  │ Queue       │  │ Timeout                 │ │
│  │ Manager     │  │ Manager     │  │ Manager                 │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
└─────────────┬─────────────────────┬─────────────────────────────┘
              │                     │
              ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│            ConversationManager Integration                     │
│  ┌─────────────────────────┐  ┌─────────────────────────────┐  │
│  │ Phase Transition        │  │ Queue Status                │  │
│  │ Interceptor             │  │ Display                     │  │
│  └─────────────────────────┘  └─────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
1. Conversation requests EXECUTE phase
        ↓
2. ExecutionQueueManager checks lock status
        ↓
3. If locked: Add to queue, notify user
   If free: Acquire lock, proceed
        ↓
4. Publish updated project status (kind 24010)
        ↓
5. Execute phase completes or times out
        ↓
6. Release lock, promote next in queue
        ↓
7. Publish updated status with new active conversation
```

## Event Schema Definitions

### Enhanced Kind 24010: Project Status Events

The existing project status events (kind 24010) are enhanced to include execution queue information:

```json
{
  "kind": 24010,
  "content": "",
  "tags": [
    ["a", "30001:project_pubkey:project_identifier"],
    ["agent", "agent_pubkey", "agent_slug", "global"],
    ["model", "gpt-4", "default-config"],
    ["execution_lock", "conversation_id", "timestamp", "agent_pubkey"],
    ["execution_queue", "conversation_id_1", "timestamp_1", "agent_pubkey_1"],
    ["execution_queue", "conversation_id_2", "timestamp_2", "agent_pubkey_2"],
    ["queue_stats", "total:2", "estimated_wait:1800"]
  ],
  "created_at": 1704067200,
  "pubkey": "project_pubkey"
}
```

#### Tag Specifications

- **`execution_lock`**: Indicates active execution
  - Format: `["execution_lock", conversation_id, lock_timestamp, agent_pubkey]`
  - Only present when a conversation holds the lock
  - `lock_timestamp`: Unix timestamp when lock was acquired
  - `agent_pubkey`: Public key of the agent that acquired the lock

- **`execution_queue`**: Queued conversations waiting for execution
  - Format: `["execution_queue", conversation_id, queue_timestamp, agent_pubkey]`
  - Multiple tags, one per queued conversation
  - Ordered by `queue_timestamp` (FIFO)
  - `queue_timestamp`: When conversation joined the queue

- **`queue_stats`**: Aggregate queue statistics
  - Format: `["queue_stats", "total:N", "estimated_wait:seconds"]`
  - `total`: Number of conversations in queue
  - `estimated_wait`: Estimated wait time in seconds for new requests

### New Kind 24019: Force Release Events

Used for administrative lock release when conversations become stuck:

```json
{
  "kind": 24019,
  "content": "Forced release: execution timeout exceeded",
  "tags": [
    ["a", "30001:project_pubkey:project_identifier"],
    ["force_release", "conversation_id", "reason", "timestamp"],
    ["released_by", "admin_pubkey", "admin_name"]
  ],
  "created_at": 1704067200,
  "pubkey": "admin_pubkey"
}
```

#### Tag Specifications

- **`force_release`**: Specifies the forced release action
  - Format: `["force_release", conversation_id, reason, timestamp]`
  - `conversation_id`: ID of conversation being forcibly released
  - `reason`: Brief reason for forced release (e.g., "timeout", "user_request", "error")
  - `timestamp`: When the release was initiated

- **`released_by`**: Identifies who performed the release
  - Format: `["released_by", admin_pubkey, admin_name]`
  - Used for audit trails and accountability

## Core Components

### ExecutionQueueManager

Central coordinator for all execution synchronization:

```typescript
export class ExecutionQueueManager {
  private projectPath: string;
  private lockManager: LockManager;
  private queueManager: QueueManager;
  private timeoutManager: TimeoutManager;
  private eventPublisher: ExecutionEventPublisher;

  async requestExecution(conversationId: string): Promise<ExecutionPermission> {
    // Check current lock status
    const currentLock = await this.lockManager.getCurrentLock();
    
    if (!currentLock) {
      // Lock is available, acquire immediately
      return await this.acquireLock(conversationId);
    }
    
    if (currentLock.conversationId === conversationId) {
      // Already holds the lock
      return { granted: true, waitTime: 0 };
    }
    
    // Add to queue and wait
    const position = await this.queueManager.enqueue(conversationId);
    await this.publishStatusUpdate();
    
    return {
      granted: false,
      waitTime: this.estimateWaitTime(position),
      queuePosition: position
    };
  }

  async releaseExecution(conversationId: string): Promise<void> {
    await this.lockManager.releaseLock(conversationId);
    const nextConversation = await this.queueManager.dequeue();
    
    if (nextConversation) {
      await this.acquireLock(nextConversation.conversationId);
    }
    
    await this.publishStatusUpdate();
  }

  async forceRelease(conversationId: string, reason: string): Promise<void> {
    await this.lockManager.forceRelease(conversationId);
    await this.publishForceReleaseEvent(conversationId, reason);
    
    // Process next in queue
    const nextConversation = await this.queueManager.dequeue();
    if (nextConversation) {
      await this.acquireLock(nextConversation.conversationId);
    }
    
    await this.publishStatusUpdate();
  }
}
```

### LockManager

Manages the execution lock state:

```typescript
export class LockManager {
  private currentLock: ExecutionLock | null = null;
  private lockFile: string;

  async getCurrentLock(): Promise<ExecutionLock | null> {
    if (this.currentLock && !this.isLockExpired(this.currentLock)) {
      return this.currentLock;
    }
    
    // Try to load from persistent storage
    return await this.loadLockFromDisk();
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
      maxDuration: this.getMaxExecutionDuration()
    };
    
    this.currentLock = lock;
    await this.saveLockToDisk(lock);
    
    return true;
  }

  async releaseLock(conversationId: string): Promise<boolean> {
    const currentLock = await this.getCurrentLock();
    
    if (!currentLock || currentLock.conversationId !== conversationId) {
      return false; // Not holding the lock
    }
    
    this.currentLock = null;
    await this.deleteLockFromDisk();
    
    return true;
  }
}
```

### QueueManager

Handles the conversation queue:

```typescript
export class QueueManager {
  private queue: QueueEntry[] = [];
  private queueFile: string;

  async enqueue(conversationId: string, agentPubkey: string): Promise<number> {
    // Check if already in queue
    const existingIndex = this.queue.findIndex(
      entry => entry.conversationId === conversationId
    );
    
    if (existingIndex >= 0) {
      return existingIndex + 1; // Return 1-based position
    }
    
    const entry: QueueEntry = {
      conversationId,
      agentPubkey,
      timestamp: Date.now(),
      retryCount: 0
    };
    
    this.queue.push(entry);
    await this.saveQueueToDisk();
    
    return this.queue.length;
  }

  async dequeue(): Promise<QueueEntry | null> {
    if (this.queue.length === 0) {
      return null;
    }
    
    const entry = this.queue.shift();
    await this.saveQueueToDisk();
    
    return entry || null;
  }

  async removeFromQueue(conversationId: string): Promise<boolean> {
    const initialLength = this.queue.length;
    this.queue = this.queue.filter(
      entry => entry.conversationId !== conversationId
    );
    
    if (this.queue.length !== initialLength) {
      await this.saveQueueToDisk();
      return true;
    }
    
    return false;
  }

  getQueueStatus(): QueueStatus {
    return {
      totalWaiting: this.queue.length,
      estimatedWait: this.calculateEstimatedWait(),
      queue: [...this.queue] // Return copy
    };
  }
}
```

### TimeoutManager

Handles execution timeouts:

```typescript
export class TimeoutManager {
  private timeouts: Map<string, NodeJS.Timeout> = new Map();
  private readonly DEFAULT_TIMEOUT = 30 * 60 * 1000; // 30 minutes

  startTimeout(conversationId: string, duration?: number): void {
    this.clearTimeout(conversationId);
    
    const timeout = setTimeout(async () => {
      await this.handleTimeout(conversationId);
    }, duration || this.DEFAULT_TIMEOUT);
    
    this.timeouts.set(conversationId, timeout);
  }

  clearTimeout(conversationId: string): void {
    const timeout = this.timeouts.get(conversationId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(conversationId);
    }
  }

  private async handleTimeout(conversationId: string): Promise<void> {
    const queueManager = getExecutionQueueManager();
    await queueManager.forceRelease(conversationId, "timeout");
    
    // Notify the conversation about the timeout
    await this.notifyConversationTimeout(conversationId);
  }
}
```

## Queue Management

### Queue Data Structures

```typescript
interface ExecutionLock {
  conversationId: string;
  agentPubkey: string;
  timestamp: number;
  maxDuration: number; // Maximum execution time in milliseconds
}

interface QueueEntry {
  conversationId: string;
  agentPubkey: string;
  timestamp: number; // When added to queue
  retryCount: number; // Number of retry attempts
}

interface QueueStatus {
  totalWaiting: number;
  estimatedWait: number; // Seconds
  queue: QueueEntry[];
}

interface ExecutionPermission {
  granted: boolean;
  waitTime?: number; // Estimated wait time in seconds
  queuePosition?: number; // Position in queue (1-based)
  message?: string; // User-friendly message
}
```

### Queue Operations

#### Enqueue Process

```typescript
async enqueueForExecution(conversationId: string): Promise<ExecutionPermission> {
  // 1. Validate conversation exists and is eligible
  const conversation = await this.conversationManager.getConversation(conversationId);
  if (!conversation) {
    throw new Error(`Conversation ${conversationId} not found`);
  }

  // 2. Check if already in execute phase
  if (conversation.phase === PHASES.EXECUTE) {
    return { granted: true, waitTime: 0, message: "Already executing" };
  }

  // 3. Request execution permission
  const permission = await this.executionQueueManager.requestExecution(conversationId);
  
  // 4. If granted, transition to execute phase
  if (permission.granted) {
    await this.conversationManager.transitionPhase(
      conversationId,
      PHASES.EXECUTE,
      { reason: "Execution lock acquired" }
    );
  }

  return permission;
}
```

#### Dequeue Process

```typescript
async processNextInQueue(): Promise<void> {
  const nextEntry = await this.queueManager.dequeue();
  if (!nextEntry) {
    return; // Queue is empty
  }

  try {
    // Verify conversation still exists and wants to execute
    const conversation = await this.conversationManager.getConversation(
      nextEntry.conversationId
    );
    
    if (!conversation) {
      // Conversation no longer exists, process next
      await this.processNextInQueue();
      return;
    }

    // Grant execution permission
    await this.acquireLock(nextEntry.conversationId);
    
    // Transition to execute phase
    await this.conversationManager.transitionPhase(
      nextEntry.conversationId,
      PHASES.EXECUTE,
      { reason: "Queue promotion - execution lock acquired" }
    );

    // Notify user
    await this.notifyExecutionStarted(nextEntry.conversationId);

  } catch (error) {
    // Handle dequeue errors
    await this.handleDequeueError(nextEntry, error);
  }
}
```

### Wait Time Estimation

```typescript
private calculateEstimatedWait(): number {
  if (this.queue.length === 0) {
    return 0;
  }

  // Base estimation on historical execution times
  const averageExecutionTime = this.getAverageExecutionTime();
  const currentLockAge = this.getCurrentLockAge();
  const remainingCurrentExecution = Math.max(0, averageExecutionTime - currentLockAge);

  // Estimate for queued conversations
  const queuedExecutionTime = this.queue.length * averageExecutionTime;

  return remainingCurrentExecution + queuedExecutionTime;
}

private getAverageExecutionTime(): number {
  // Look at recent execution history to estimate
  const recentExecutions = this.getRecentExecutionHistory(50); // Last 50 executions
  
  if (recentExecutions.length === 0) {
    return 10 * 60; // Default 10 minutes
  }

  const totalTime = recentExecutions.reduce((sum, execution) => {
    return sum + (execution.endTime - execution.startTime);
  }, 0);

  return totalTime / recentExecutions.length / 1000; // Convert to seconds
}
```

## Lock Lifecycle

### Lock Acquisition Flow

```
1. Conversation requests EXECUTE phase
        ↓
2. Check current lock status
        ↓
3. Lock available?
   ├─ Yes: Acquire lock immediately
   └─ No: Add to queue, estimate wait
        ↓
4. Publish project status update
        ↓
5. Start execution timeout timer
        ↓
6. Proceed with EXECUTE phase
```

### Lock Release Flow

```
1. Conversation completes EXECUTE phase
   OR timeout occurs
   OR force release triggered
        ↓
2. Clear execution timeout timer
        ↓
3. Release lock from current holder
        ↓
4. Check queue for next conversation
        ↓
5. Next available?
   ├─ Yes: Acquire lock for next conversation
   └─ No: Mark lock as free
        ↓
6. Publish updated project status
        ↓
7. Notify affected conversations
```

### Lock Persistence

Locks are persisted to disk to survive process restarts:

```typescript
// Lock file location: .tenex/state/execution-lock.json
interface PersistedLock {
  conversationId: string;
  agentPubkey: string;
  timestamp: number;
  maxDuration: number;
  projectPath: string;
}

async saveLockToDisk(lock: ExecutionLock): Promise<void> {
  const lockFile = path.join(this.projectPath, '.tenex', 'state', 'execution-lock.json');
  const persistedLock: PersistedLock = {
    ...lock,
    projectPath: this.projectPath
  };
  
  await fs.writeFile(lockFile, JSON.stringify(persistedLock, null, 2));
}

async loadLockFromDisk(): Promise<ExecutionLock | null> {
  const lockFile = path.join(this.projectPath, '.tenex', 'state', 'execution-lock.json');
  
  try {
    const data = await fs.readFile(lockFile, 'utf-8');
    const persistedLock: PersistedLock = JSON.parse(data);
    
    // Check if lock has expired
    if (this.isLockExpired(persistedLock)) {
      await fs.unlink(lockFile); // Remove expired lock
      return null;
    }
    
    return persistedLock;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null; // No lock file exists
    }
    throw error;
  }
}
```

## Integration Points

### ConversationManager Integration

The ExecutionQueueManager integrates with ConversationManager at phase transition points:

```typescript
// In ConversationManager.transitionPhase()
async transitionPhase(
  conversationId: string,
  newPhase: Phase,
  context: PhaseTransitionContext
): Promise<void> {
  const conversation = await this.getConversation(conversationId);
  const oldPhase = conversation.phase;
  
  // Handle EXECUTE phase entry
  if (newPhase === PHASES.EXECUTE) {
    const permission = await this.executionQueueManager.requestExecution(conversationId);
    
    if (!permission.granted) {
      // Add system message about queue status
      await this.addSystemMessage(conversationId, {
        role: 'system',
        content: `Added to execution queue. Position: ${permission.queuePosition}, Estimated wait: ${formatWaitTime(permission.waitTime)}`
      });
      
      // Don't transition to EXECUTE yet, stay in current phase
      return;
    }
  }
  
  // Handle EXECUTE phase exit
  if (oldPhase === PHASES.EXECUTE && newPhase !== PHASES.EXECUTE) {
    await this.executionQueueManager.releaseExecution(conversationId);
  }
  
  // Continue with normal transition logic
  await this.performPhaseTransition(conversationId, newPhase, context);
}
```

### Event Handler Integration

```typescript
// New event handler for force release events
async handleForceReleaseEvent(event: NDKEvent): Promise<void> {
  const forceReleaseTag = event.tags.find(tag => tag[0] === 'force_release');
  if (!forceReleaseTag) return;
  
  const [, conversationId, reason] = forceReleaseTag;
  
  // Apply the force release
  await this.executionQueueManager.forceRelease(conversationId, reason);
  
  // Notify the affected conversation
  await this.notifyConversationForceReleased(conversationId, reason, event.pubkey);
}
```

### Status Display Integration

```typescript
// Enhanced project status display
async displayProjectStatus(projectPath: string): Promise<void> {
  const queueStatus = await this.executionQueueManager.getQueueStatus();
  const currentLock = await this.executionQueueManager.getCurrentLock();
  
  console.log("Project Status:");
  
  if (currentLock) {
    console.log(`🔒 Currently executing: ${currentLock.conversationId}`);
    console.log(`   Started: ${formatTimestamp(currentLock.timestamp)}`);
    console.log(`   Agent: ${currentLock.agentPubkey}`);
  } else {
    console.log("🔓 No active execution");
  }
  
  if (queueStatus.totalWaiting > 0) {
    console.log(`📋 Queue: ${queueStatus.totalWaiting} conversation(s) waiting`);
    console.log(`   Estimated wait for new requests: ${formatWaitTime(queueStatus.estimatedWait)}`);
    
    for (let i = 0; i < Math.min(3, queueStatus.queue.length); i++) {
      const entry = queueStatus.queue[i];
      console.log(`   ${i + 1}. ${entry.conversationId} (${formatTimestamp(entry.timestamp)})`);
    }
    
    if (queueStatus.queue.length > 3) {
      console.log(`   ... and ${queueStatus.queue.length - 3} more`);
    }
  } else {
    console.log("📋 Queue: Empty");
  }
}
```

## User Experience

### Visual Feedback

#### Queue Status Messages

When a conversation is added to the queue:

```
🚦 Execution Queue Status

Your conversation has been added to the execution queue.

Queue Position: 3 of 4
Estimated Wait Time: ~15 minutes
Current Execution: conv-abc123 (started 8 minutes ago)

You will be automatically notified when execution begins.
Use `tenex queue status` to check current position.
```

#### Lock Acquisition Notification

When a conversation acquires the lock:

```
🟢 Execution Started

Your conversation has acquired the execution lock.
Beginning EXECUTE phase now.

Lock acquired at: 2024-01-01 10:30:25
Maximum execution time: 30 minutes
```

#### Timeout Warnings

When approaching timeout:

```
⚠️  Execution Timeout Warning

Your conversation has been executing for 25 minutes.
Maximum execution time: 30 minutes

The execution will be automatically terminated in 5 minutes
if not completed. Consider using the `complete` tool if your
work is finished.
```

### Queue Management Commands

Users can interact with the queue system through CLI commands:

```bash
# View current queue status
tenex queue status

# View detailed queue information
tenex queue status --detailed

# Force release a stuck execution (admin only)
tenex queue release --conversation conv-abc123 --reason "user request"

# Remove conversation from queue
tenex queue remove --conversation conv-def456
```

### Real-time Updates

The system provides real-time updates through:

1. **Console Messages**: Direct feedback in the conversation
2. **Status Events**: Nostr events for real-time monitoring
3. **CLI Updates**: Live queue status in terminal
4. **Notifications**: System notifications for important events

## Error Handling

### Common Error Scenarios

#### Lock Acquisition Failures

```typescript
class LockAcquisitionError extends Error {
  constructor(
    public conversationId: string,
    public reason: 'already_locked' | 'invalid_state' | 'timeout'
  ) {
    super(`Failed to acquire execution lock: ${reason}`);
  }
}

async handleLockAcquisitionError(
  error: LockAcquisitionError,
  conversationId: string
): Promise<void> {
  switch (error.reason) {
    case 'already_locked':
      // Add to queue automatically
      await this.executionQueueManager.requestExecution(conversationId);
      break;
      
    case 'invalid_state':
      // Conversation may not be ready for execution
      await this.notifyInvalidState(conversationId, error.message);
      break;
      
    case 'timeout':
      // Lock acquisition timed out
      await this.notifyLockTimeout(conversationId);
      break;
  }
}
```

#### Queue Corruption Recovery

```typescript
async recoverQueue(): Promise<void> {
  try {
    // Attempt to load queue from disk
    const queue = await this.loadQueueFromDisk();
    this.validateQueue(queue);
  } catch (error) {
    // Queue file corrupted, rebuild from events
    console.warn('Queue corruption detected, rebuilding from events');
    
    const events = await this.fetchRecentProjectEvents();
    const rebuiltQueue = await this.rebuildQueueFromEvents(events);
    
    this.queue = rebuiltQueue;
    await this.saveQueueToDisk();
  }
}
```

#### Timeout Handling

```typescript
async handleExecutionTimeout(conversationId: string): Promise<void> {
  const conversation = await this.conversationManager.getConversation(conversationId);
  
  if (!conversation || conversation.phase !== PHASES.EXECUTE) {
    // Conversation already finished or moved on
    return;
  }
  
  // Add timeout message to conversation
  await this.conversationManager.addSystemMessage(conversationId, {
    role: 'system',
    content: `⏰ Execution timeout reached. The execution lock has been automatically released. If your work was complete, you can continue to the next phase. If not, you may request execution again.`
  });
  
  // Force release the lock
  await this.executionQueueManager.forceRelease(conversationId, 'timeout');
  
  // Optionally transition to a safe phase
  await this.conversationManager.transitionPhase(
    conversationId,
    PHASES.CHAT,
    { reason: 'Execution timeout - lock released' }
  );
}
```

#### Network Partition Recovery

```typescript
async handleNetworkPartition(): Promise<void> {
  // After network recovery, validate current state
  const localLock = await this.lockManager.getCurrentLock();
  const nostrEvents = await this.fetchRecentLockEvents();
  
  const mostRecentLockEvent = this.findMostRecentLockEvent(nostrEvents);
  
  if (localLock && mostRecentLockEvent) {
    // Check for conflicts
    if (localLock.conversationId !== mostRecentLockEvent.conversationId) {
      // Conflict detected, defer to most recent Nostr event
      await this.resolveConflict(localLock, mostRecentLockEvent);
    }
  }
}
```

## CLI Interface

### Command Structure

```bash
tenex queue <subcommand> [options]
```

### Available Subcommands

#### `status` - View Queue Status

```bash
tenex queue status [--detailed] [--watch]

Options:
  --detailed, -d    Show detailed queue information
  --watch, -w      Watch for real-time updates
  --json           Output in JSON format
```

Example output:
```
🚦 Execution Queue Status

Lock Status: 🔒 LOCKED
Current Execution: conv-abc123
  Agent: executor@project.com
  Started: 2024-01-01 10:15:30 (15m 23s ago)
  Timeout: 2024-01-01 10:45:30 (14m 37s remaining)

Queue: 2 conversations waiting
  1. conv-def456 - queued 5m 12s ago
  2. conv-ghi789 - queued 2m 31s ago

Estimated wait for new requests: ~20 minutes
```

#### `release` - Force Release Lock

```bash
tenex queue release --conversation <id> --reason <reason> [--confirm]

Options:
  --conversation, -c  Conversation ID to release (required)
  --reason, -r       Reason for release (required)
  --confirm, -y      Skip confirmation prompt
```

Example:
```bash
tenex queue release --conversation conv-abc123 --reason "stuck execution"
```

#### `remove` - Remove from Queue

```bash
tenex queue remove --conversation <id> [--confirm]

Options:
  --conversation, -c  Conversation ID to remove (required)
  --confirm, -y      Skip confirmation prompt
```

#### `history` - View Lock History

```bash
tenex queue history [--limit <n>] [--format <format>]

Options:
  --limit, -l      Number of entries to show (default: 10)
  --format, -f     Output format: table|json|csv (default: table)
```

### Implementation

```typescript
export class QueueCLI {
  async handleStatusCommand(options: StatusOptions): Promise<void> {
    const queueStatus = await this.executionQueueManager.getQueueStatus();
    const currentLock = await this.executionQueueManager.getCurrentLock();
    
    if (options.json) {
      console.log(JSON.stringify({ lock: currentLock, queue: queueStatus }, null, 2));
      return;
    }
    
    if (options.watch) {
      await this.watchQueueStatus();
      return;
    }
    
    await this.displayQueueStatus(currentLock, queueStatus, options.detailed);
  }
  
  async handleReleaseCommand(options: ReleaseOptions): Promise<void> {
    if (!options.conversation || !options.reason) {
      throw new Error('Both --conversation and --reason are required');
    }
    
    if (!options.confirm) {
      const confirm = await this.promptConfirmation(
        `Force release execution lock for conversation ${options.conversation}?`
      );
      if (!confirm) {
        console.log('Operation cancelled');
        return;
      }
    }
    
    await this.executionQueueManager.forceRelease(
      options.conversation,
      options.reason
    );
    
    console.log(`✅ Successfully released lock for conversation ${options.conversation}`);
  }
  
  private async watchQueueStatus(): Promise<void> {
    console.log('📡 Watching queue status (Press Ctrl+C to exit)...\n');
    
    // Subscribe to project status events
    const subscription = this.subscribeToProjectEvents();
    
    subscription.on('event', async (event) => {
      if (this.isQueueStatusEvent(event)) {
        await this.displayUpdatedStatus(event);
      }
    });
    
    // Also poll periodically as backup
    const interval = setInterval(async () => {
      await this.displayCurrentStatus();
    }, 30000); // Every 30 seconds
    
    process.on('SIGINT', () => {
      clearInterval(interval);
      subscription.stop();
      console.log('\n👋 Stopped watching queue status');
      process.exit(0);
    });
  }
}
```

## Implementation Guidelines

### Phase 1: Core Infrastructure

1. **Create ExecutionQueueManager**
   - Implement basic lock/queue mechanisms
   - Add persistence layer
   - Create event publishing

2. **Enhance Project Status Events**
   - Update kind 24010 schema
   - Add execution lock and queue tags
   - Modify StatusPublisher

3. **Integrate with ConversationManager**
   - Add phase transition hooks
   - Implement queue request logic
   - Add timeout management

### Phase 2: User Experience

4. **Implement CLI Commands**
   - Add queue status command
   - Add force release command
   - Add queue management commands

5. **Add User Notifications**
   - Queue position updates
   - Lock acquisition notifications
   - Timeout warnings

6. **Real-time Updates**
   - WebSocket/Nostr event streaming
   - Live CLI updates
   - Status dashboard integration

### Phase 3: Advanced Features

7. **Administrative Controls**
   - Force release events (kind 24019)
   - Admin override permissions
   - Audit logging

8. **Performance Optimization**
   - Queue persistence optimization
   - Event batching
   - Memory management

9. **Monitoring and Analytics**
   - Execution time tracking
   - Queue performance metrics
   - Usage analytics

### Development Principles

- **Test-Driven Development**: Write comprehensive tests for all queue operations
- **Graceful Degradation**: System should work even if queue features fail
- **Backward Compatibility**: Maintain compatibility with existing installations
- **Documentation**: Comprehensive documentation for all new features
- **Error Recovery**: Robust error handling and automatic recovery

### Testing Strategy

#### Unit Tests

```typescript
describe('ExecutionQueueManager', () => {
  it('should acquire lock when no existing lock', async () => {
    const permission = await queueManager.requestExecution('conv-123');
    expect(permission.granted).toBe(true);
    expect(permission.waitTime).toBe(0);
  });
  
  it('should queue conversation when lock is held', async () => {
    await queueManager.requestExecution('conv-123');
    const permission = await queueManager.requestExecution('conv-456');
    
    expect(permission.granted).toBe(false);
    expect(permission.queuePosition).toBe(1);
    expect(permission.waitTime).toBeGreaterThan(0);
  });
  
  it('should promote next conversation when lock released', async () => {
    await queueManager.requestExecution('conv-123');
    await queueManager.requestExecution('conv-456');
    
    await queueManager.releaseExecution('conv-123');
    
    const currentLock = await queueManager.getCurrentLock();
    expect(currentLock?.conversationId).toBe('conv-456');
  });
});
```

#### Integration Tests

```typescript
describe('Queue Integration', () => {
  it('should handle conversation phase transitions', async () => {
    const conversation = await createTestConversation();
    
    // Request execute phase
    await conversationManager.transitionPhase(
      conversation.id,
      PHASES.EXECUTE,
      { reason: 'Test execution' }
    );
    
    // Should acquire lock and transition
    const updatedConversation = await conversationManager.getConversation(conversation.id);
    expect(updatedConversation.phase).toBe(PHASES.EXECUTE);
    
    const currentLock = await queueManager.getCurrentLock();
    expect(currentLock?.conversationId).toBe(conversation.id);
  });
});
```

#### E2E Tests

```typescript
describe('Queue E2E', () => {
  it('should handle complete queue workflow', async () => {
    // Create multiple conversations
    const conv1 = await createTestConversation();
    const conv2 = await createTestConversation();
    const conv3 = await createTestConversation();
    
    // Request execution for all
    await Promise.all([
      conversationManager.transitionPhase(conv1.id, PHASES.EXECUTE),
      conversationManager.transitionPhase(conv2.id, PHASES.EXECUTE),
      conversationManager.transitionPhase(conv3.id, PHASES.EXECUTE)
    ]);
    
    // First should execute, others should queue
    expect(await getCurrentExecution()).toBe(conv1.id);
    expect(await getQueueLength()).toBe(2);
    
    // Complete first execution
    await conversationManager.transitionPhase(conv1.id, PHASES.VERIFICATION);
    
    // Second should start executing
    expect(await getCurrentExecution()).toBe(conv2.id);
    expect(await getQueueLength()).toBe(1);
  });
});
```

## Security Considerations

### Access Control

1. **Force Release Permissions**
   - Only authorized users can force release locks
   - Audit trail for all force releases
   - Rate limiting on force release operations

2. **Queue Manipulation**
   - Users can only remove their own conversations from queue
   - Admin roles for queue management
   - Validation of conversation ownership

3. **Event Authentication**
   - All queue events must be properly signed
   - Verify event authenticity before processing
   - Reject malformed or suspicious events

### Attack Prevention

#### Lock Hijacking

```typescript
async validateLockOwnership(conversationId: string, claimantPubkey: string): Promise<boolean> {
  const conversation = await this.conversationManager.getConversation(conversationId);
  if (!conversation) {
    return false;
  }
  
  // Verify that the claimant is associated with the conversation
  const hasParticipated = conversation.history.some(
    event => event.pubkey === claimantPubkey
  );
  
  if (!hasParticipated) {
    this.securityLogger.warn(`Lock hijacking attempt: ${claimantPubkey} claiming ${conversationId}`);
    return false;
  }
  
  return true;
}
```

#### Queue Flooding

```typescript
async validateQueueRequest(conversationId: string, agentPubkey: string): Promise<boolean> {
  // Check rate limits
  const recentRequests = await this.getRecentQueueRequests(agentPubkey, 3600000); // 1 hour
  if (recentRequests.length > 10) {
    this.securityLogger.warn(`Queue flooding attempt: ${agentPubkey}`);
    return false;
  }
  
  // Verify conversation is in valid state
  const conversation = await this.conversationManager.getConversation(conversationId);
  if (!conversation || !this.isValidForExecution(conversation)) {
    return false;
  }
  
  return true;
}
```

### Data Protection

1. **Sensitive Information**
   - Queue events should not expose sensitive conversation content
   - Use conversation IDs and metadata only
   - Implement proper data retention policies

2. **Privacy**
   - Users should only see their own queue entries
   - Admin views require special permissions
   - Audit logs protected from unauthorized access

## Performance Considerations

### Scalability Metrics

- **Queue Size**: Support up to 100 queued conversations
- **Lock Duration**: Handle executions up to 2 hours
- **Event Processing**: Process queue events within 100ms
- **Memory Usage**: Keep queue overhead under 10MB
- **Disk I/O**: Minimize write operations through batching

### Optimization Strategies

#### Memory Management

```typescript
class OptimizedQueueManager {
  private readonly MAX_QUEUE_SIZE = 100;
  private readonly MAX_HISTORY_SIZE = 1000;
  
  async optimizeMemoryUsage(): Promise<void> {
    // Limit queue size
    if (this.queue.length > this.MAX_QUEUE_SIZE) {
      const excess = this.queue.length - this.MAX_QUEUE_SIZE;
      const removed = this.queue.splice(this.MAX_QUEUE_SIZE);
      
      // Notify removed conversations
      for (const entry of removed) {
        await this.notifyQueueEviction(entry.conversationId);
      }
    }
    
    // Trim execution history
    if (this.executionHistory.length > this.MAX_HISTORY_SIZE) {
      this.executionHistory = this.executionHistory.slice(-this.MAX_HISTORY_SIZE);
    }
  }
}
```

#### Event Batching

```typescript
class BatchedEventPublisher {
  private pendingEvents: NDKEvent[] = [];
  private batchTimer?: NodeJS.Timeout;
  
  async scheduleEvent(event: NDKEvent): Promise<void> {
    this.pendingEvents.push(event);
    
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.flushEvents(), 1000);
    }
  }
  
  private async flushEvents(): Promise<void> {
    if (this.pendingEvents.length === 0) return;
    
    const events = [...this.pendingEvents];
    this.pendingEvents = [];
    this.batchTimer = undefined;
    
    // Publish all events in batch
    await Promise.all(events.map(event => event.publish()));
  }
}
```

#### Caching Strategy

```typescript
class CachedQueueManager {
  private statusCache?: {
    status: QueueStatus;
    timestamp: number;
  };
  
  async getQueueStatus(): Promise<QueueStatus> {
    // Return cached status if fresh (within 5 seconds)
    if (this.statusCache && Date.now() - this.statusCache.timestamp < 5000) {
      return this.statusCache.status;
    }
    
    // Calculate fresh status
    const status = await this.calculateQueueStatus();
    this.statusCache = {
      status,
      timestamp: Date.now()
    };
    
    return status;
  }
  
  invalidateStatusCache(): void {
    this.statusCache = undefined;
  }
}
```

### Monitoring

#### Performance Metrics

```typescript
class QueueMetrics {
  private metrics = {
    lockAcquisitionTime: new Histogram(),
    queueWaitTime: new Histogram(),
    executionDuration: new Histogram(),
    queueLength: new Gauge(),
    forceReleaseCount: new Counter()
  };
  
  recordLockAcquisition(duration: number): void {
    this.metrics.lockAcquisitionTime.record(duration);
  }
  
  recordQueueWait(duration: number): void {
    this.metrics.queueWaitTime.record(duration);
  }
  
  recordExecution(duration: number): void {
    this.metrics.executionDuration.record(duration);
  }
  
  updateQueueLength(length: number): void {
    this.metrics.queueLength.set(length);
  }
  
  incrementForceRelease(): void {
    this.metrics.forceReleaseCount.increment();
  }
}
```

## Future Extensions

### Advanced Queuing

1. **Priority Queues**
   - VIP/urgent execution priority
   - Agent-specific priority levels
   - Dynamic priority adjustment

2. **Resource-Based Queuing**
   - Different queues for different resource types
   - CPU/memory/disk usage tracking
   - Intelligent resource allocation

3. **Distributed Queuing**
   - Cross-instance queue coordination
   - Load balancing across TENEX instances
   - Failover and redundancy

### Enhanced Administration

1. **Queue Analytics Dashboard**
   - Real-time queue visualization
   - Historical performance metrics
   - Capacity planning insights

2. **Automated Management**
   - Auto-scaling queue limits
   - Intelligent timeout adjustment
   - Anomaly detection and alerts

3. **Integration APIs**
   - REST API for queue management
   - Webhook notifications
   - Third-party monitoring integration

### Smart Features

1. **Predictive Scheduling**
   - ML-based execution time prediction
   - Optimal queue ordering
   - Resource usage forecasting

2. **Conversation Clustering**
   - Group related conversations
   - Batch execution optimization
   - Dependency management

3. **Dynamic Timeouts**
   - Context-aware timeout adjustment
   - Progressive timeout warnings
   - Automatic recovery strategies

This comprehensive specification provides a complete blueprint for implementing the Execution Queue Mutex System in TENEX. The system ensures safe, coordinated execution while maintaining excellent user experience and administrative control.