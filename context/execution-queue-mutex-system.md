# Specification: Execution Queue Mutex System

## 1. Summary

This document specifies a mutex system to manage access to the `EXECUTE` phase within a TENEX project. The goal is to prevent multiple conversations from entering the `EXECUTE` phase concurrently for the same project, which can lead to resource conflicts and unpredictable behavior. The system uses a FIFO (First-In, First-Out) queue to serialize execution requests.

## 2. Problem Statement

When multiple users or automated processes interact with the same TENEX project, there is a risk of them initiating `EXECUTE` phases simultaneously. This can cause race conditions, inconsistent state, and corrupted project files. A locking mechanism is required to ensure that only one conversation can be in the `EXECUTE` phase at any given time for a single project.

## 3. Functional Requirements

### 3.1. Mutex and Locking

*   **Exclusive Access:** Only one conversation per project can hold the execution lock and be in the `EXECUTE` phase at a time.
*   **Lock Acquisition:** A conversation automatically attempts to acquire the lock when it transitions into the `EXECUTE` phase.
*   **Natural Lock Release:** The lock is automatically released when the active conversation transitions out of the `EXECUTE` phase (e.g., to `VERIFICATION`, `CHORES`, or `REFLECTION`).

### 3.2. Queuing Mechanism

*   **FIFO Queue:** If a conversation attempts to enter the `EXECUTE` phase while the lock is held by another conversation, it shall be placed in a queue.
*   **Automatic Dequeue:** When the lock is released, the conversation at the front of the queue automatically acquires the lock and proceeds with its execution.
*   **Queue Transparency:** Users should be able to view the current queue, their position in it, and an estimated wait time.

### 3.3. Timeout and Recovery

*   **Execution Timeout:** A lock has a configurable timeout period (default: 30 minutes) to prevent indefinite blocking.
*   **Timeout Warning:** A warning is issued 5 minutes before the lock expires.
*   **Automatic Release on Timeout:** If the execution is not completed within the timeout period, the lock is automatically released to unblock the queue.

### 3.4. Manual Override

*   **Force Release:** A mechanism must exist for a project administrator to manually force the release of a lock. This is a safety hatch for situations where a process might be stuck.

## 4. Nostr Integration

The system leverages Nostr events for status broadcasting and coordination.

*   **Kind 24010 (Project Status):** This event is enhanced to broadcast the state of the execution queue using a pure tag-based system, avoiding JSON in the `.content` field as a best practice. The queue's state is represented by the order and structure of `execution-queue` tags.
    *   **Tag Order:** The order of the `execution-queue` tags represents the FIFO queue order. The first tag is the active conversation, the second is the next in line, and so on.
    *   **Active Conversation:** The conversation currently holding the lock is denoted by the tag: `["execution-queue", "<conversation-id>", "active"]`.
    *   **Waiting Conversations:** Conversations waiting in the queue are denoted by the tag: `["execution-queue", "<conversation-id>"]`.
*   **Kind 24019 (Force Release):** A new event kind to signal a force release.
    *   An `a` tag pointing to the `project_id` will be used to target the correct project.
    *   Publishing this event triggers the immediate release of the execution lock for the specified project.

## 5. Technical Implementation Overview

The system is implemented through a set of cooperating classes:

*   **`ExecutionQueueManager`**: The central orchestrator that integrates the other components.
*   **`LockManager`**: Manages the acquisition, release, and state of the execution lock, with persistence.
*   **`QueueManager`**: Manages the conversation queue with FIFO logic.
*   **`TimeoutManager`**: Handles the execution timeout logic, including warnings.
*   **`ExecutionEventPublisher`**: Broadcasts the queue status via Nostr events.
*   **`NostrEventService`**: A general service for signing and publishing Nostr events.

## 6. CLI Commands

The following CLI commands are provided for interacting with the Execution Queue:

*   `tenex queue status`: View the current lock holder and the list of conversations in the queue.
*   `tenex queue release`: Manually force the release of the current execution lock.
*   `tenex queue remove <conversationId>`: Remove a specific conversation from the queue.
*   `tenex queue history`: View a history of past executions.
*   `tenex queue clear`: Clear all state from the queue (lock and waiting conversations).

## 7. Known Issues and Resolutions

### `ProjectContext not initialized`

*   **Symptom:** During initial verification, running any `tenex queue` command resulted in a fatal `ProjectContext not initialized` error.
*   **Root Cause:** The CLI command handlers were being executed without the necessary project context (including services like `ConversationManager` and `ExecutionQueueManager`) being loaded and initialized first.
*   **Resolution:**
    1.  A function `ensureProjectInitialized()` was created to handle the loading and initialization of the project context.
    2.  This function is now called at the beginning of every `tenex queue` command action to guarantee the context is available before the command logic runs.
    3.  The `ProjectManager` was updated to automatically create and attach the `ConversationManager` and `ExecutionQueueManager` when the project context is loaded.
