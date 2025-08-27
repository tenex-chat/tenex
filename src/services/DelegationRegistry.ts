import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentInstance } from "@/agents/types";
import { logger } from "@/utils/logger";
import { z } from "zod";

export interface DelegationRecord {
  // Core identifiers
  delegationEventId: string; // Delegation event ID (kind:1111) or synthetic ID for multi-recipient
  delegationBatchId: string; // Groups tasks delegated together

  // Context from delegating agent
  delegatingAgent: {
    slug: string;
    pubkey: string;
    rootConversationId: string; // Root conversation where delegation originated
  };

  // Delegation assignment
  assignedTo: {
    pubkey: string;
    slug?: string; // May not be known at delegation time
  };

  // Delegation details
  content: {
    fullRequest: string;
    phase?: string;
  };

  // Status tracking
  status: "pending" | "in_progress" | "completed" | "failed";

  // Completion details (when status !== 'pending')
  completion?: {
    eventId: string; // Completion event ID
    response: string;
    summary?: string;
    completedAt: number;
    completedBy: string; // Pubkey of completing agent
  };

  // Metadata
  createdAt: number;
  updatedAt: number;

  // Related delegations (siblings in same delegation batch)
  siblingDelegationIds: string[];
}

interface DelegationBatch {
  batchId: string;
  delegatingAgent: string;
  delegationKeys: string[]; // Conversation keys for each delegation
  allCompleted: boolean;
  createdAt: number;
  originalRequest: string;
  rootConversationId: string;
}

// Zod schemas for validation
const DelegationRecordSchema = z.object({
  delegationEventId: z.string(),
  delegationBatchId: z.string(),
  delegatingAgent: z.object({
    slug: z.string(),
    pubkey: z.string(),
    rootConversationId: z.string(),
  }),
  assignedTo: z.object({
    pubkey: z.string(),
    slug: z.string().optional(),
  }),
  content: z.object({
    fullRequest: z.string(),
    phase: z.string().optional(),
  }),
  status: z.enum(["pending", "in_progress", "completed", "failed"]),
  completion: z
    .object({
      eventId: z.string(),
      response: z.string(),
      summary: z.string().optional(),
      completedAt: z.number(),
      completedBy: z.string(),
    })
    .optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  siblingDelegationIds: z.array(z.string()),
});

const DelegationBatchSchema = z.object({
  batchId: z.string(),
  delegatingAgent: z.string(),
  delegationKeys: z.array(z.string()),
  allCompleted: z.boolean(),
  createdAt: z.number(),
  originalRequest: z.string(),
  rootConversationId: z.string(),
});

const PersistedDataSchema = z.object({
  delegations: z.array(z.tuple([z.string(), DelegationRecordSchema])),
  batches: z.array(z.tuple([z.string(), DelegationBatchSchema])),
  agentTasks: z.array(z.tuple([z.string(), z.array(z.string())])),
  conversationTasks: z.array(z.tuple([z.string(), z.array(z.string())])),
  version: z.literal(1),
});

export class DelegationRegistry extends EventEmitter {
  private static instance: DelegationRegistry;
  private static isInitialized = false;

  // Primary storage: conversation key -> full record
  // Key format: "${rootConversationId}:${fromPubkey}:${toPubkey}"
  private delegations: Map<string, DelegationRecord> = new Map();

  // Index: batch ID -> batch info
  private batches: Map<string, DelegationBatch> = new Map();
  
  // Track batches that were handled synchronously to prevent double processing
  private syncHandledBatches = new Set<string>();

  // Index: agent pubkey -> active delegation event IDs
  private agentDelegations: Map<string, Set<string>> = new Map();

  // Index: root conversation ID -> delegation event IDs
  private conversationDelegations: Map<string, Set<string>> = new Map();

  // Persistence
  private persistencePath: string;
  private backupPath: string;
  private persistenceTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private isDirty = false;
  private isShuttingDown = false;

  private constructor() {
    super();
    this.persistencePath = path.join(process.cwd(), ".tenex", "delegations.json");
    this.backupPath = path.join(process.cwd(), ".tenex", "delegations.backup.json");
  }

  /**
   * Initialize the singleton instance.
   * Must be called once at app startup before using getInstance().
   */
  static async initialize(): Promise<void> {
    if (DelegationRegistry.isInitialized) return;

    logger.debug("Initializing DelegationRegistry singleton");

    // Create instance if it doesn't exist
    if (!DelegationRegistry.instance) {
      DelegationRegistry.instance = new DelegationRegistry();
    }

    // Restore data
    await DelegationRegistry.instance.restore();

    // Set up periodic cleanup (every hour)
    DelegationRegistry.instance.cleanupTimer = setInterval(
      () => {
        DelegationRegistry.instance.cleanupOldDelegations();
        if (DelegationRegistry.instance.isDirty) {
          DelegationRegistry.instance.schedulePersistence();
        }
      },
      60 * 60 * 1000
    );

    // Set up graceful shutdown
    DelegationRegistry.instance.setupGracefulShutdown();

    DelegationRegistry.isInitialized = true;
    logger.debug("DelegationRegistry singleton initialized successfully");
  }

  /**
   * Get the singleton instance.
   * Throws if initialize() hasn't been called.
   */
  static getInstance(): DelegationRegistry {
    if (!DelegationRegistry.isInitialized || !DelegationRegistry.instance) {
      throw new Error(
        "DelegationRegistry not initialized. Call DelegationRegistry.initialize() at app startup."
      );
    }
    return DelegationRegistry.instance;
  }

  /**
   * Register a new delegation batch
   * Called when delegate() or delegate_phase() creates delegations
   */
  async registerDelegationBatch(params: {
    tasks: Array<{
      taskId: string; // Actually the delegation event ID (kind:1111) or synthetic ID
      assignedToPubkey: string;
      fullRequest: string;
      phase?: string;
    }>;
    delegatingAgent: AgentInstance;
    conversationId: string; // The root conversation ID where delegation originated
    originalRequest: string;
  }): Promise<string> {
    const batchId = this.generateBatchId();

    // Create batch record
    const batch: DelegationBatch = {
      batchId,
      delegatingAgent: params.delegatingAgent.pubkey,
      delegationKeys: [], // Will store conversation keys
      allCompleted: false,
      createdAt: Date.now(),
      originalRequest: params.originalRequest,
      rootConversationId: params.conversationId,
    };

    // Create individual delegation records
    for (const task of params.tasks) {
      const convKey = `${params.conversationId}:${params.delegatingAgent.pubkey}:${task.assignedToPubkey}`;
      
      const record: DelegationRecord = {
        delegationEventId: task.taskId, // This is the delegation event ID (kind:1111) or synthetic ID
        delegationBatchId: batchId,
        delegatingAgent: {
          slug: params.delegatingAgent.slug,
          pubkey: params.delegatingAgent.pubkey,
          rootConversationId: params.conversationId,
        },
        assignedTo: {
          pubkey: task.assignedToPubkey,
        },
        content: {
          fullRequest: task.fullRequest,
          phase: task.phase,
        },
        status: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        siblingDelegationIds: params.tasks.filter((t) => t.taskId !== task.taskId).map((t) => t.taskId),
      };

      this.delegations.set(convKey, record);
      batch.delegationKeys.push(convKey); // Store conversation key
      this.indexDelegation(record);
    }

    this.batches.set(batchId, batch);
    this.schedulePersistence();

    logger.info("Registered delegation batch", {
      batchId,
      delegationCount: params.tasks.length,
      delegatingAgent: params.delegatingAgent.slug,
      delegatingAgentPubkey: params.delegatingAgent.pubkey.substring(0, 16),
      conversationId: params.conversationId.substring(0, 8),
      delegationEventIds: params.tasks.map((t) => ({
        id: t.taskId.substring(0, 8),
        assignedTo: t.assignedToPubkey.substring(0, 16),
      })),
    });

    // Debug: Log each individual task registration
    for (const task of params.tasks) {
      logger.debug("Registered individual delegation", {
        taskId: task.taskId.substring(0, 8),
        fullTaskId: task.taskId,
        delegatingAgentPubkey: params.delegatingAgent.pubkey.substring(0, 16),
        assignedToPubkey: task.assignedToPubkey.substring(0, 16),
        phase: task.phase,
      });
    }

    return batchId;
  }

  /**
   * Register an external delegation
   * Called when delegate_external creates a delegation to an external agent
   */
  async registerExternalDelegation(params: {
    delegationEventId: string; // The kind:11 or kind:1111 event ID we published
    delegatingAgent: AgentInstance;
    assignedToPubkey: string;
    conversationId: string; // The root conversation ID where delegation originated
    fullRequest: string;
    phase?: string;
  }): Promise<string> {
    const batchId = this.generateBatchId();
    
    // Create a single-item batch for external delegation
    const batch: DelegationBatch = {
      batchId,
      delegatingAgent: params.delegatingAgent.pubkey,
      delegationKeys: [],
      allCompleted: false,
      createdAt: Date.now(),
      originalRequest: params.fullRequest,
      rootConversationId: params.conversationId,
    };

    // Create delegation record using conversation key format
    const convKey = `${params.conversationId}:${params.delegatingAgent.pubkey}:${params.assignedToPubkey}`;
    
    const record: DelegationRecord = {
      delegationEventId: params.delegationEventId,
      delegationBatchId: batchId,
      delegatingAgent: {
        slug: params.delegatingAgent.slug,
        pubkey: params.delegatingAgent.pubkey,
        rootConversationId: params.conversationId,
      },
      assignedTo: {
        pubkey: params.assignedToPubkey,
      },
      content: {
        fullRequest: params.fullRequest,
        phase: params.phase,
      },
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      siblingDelegationIds: [], // External delegations are always single
    };

    this.delegations.set(convKey, record);
    batch.delegationKeys.push(convKey);
    this.indexDelegation(record);

    this.batches.set(batchId, batch);
    this.schedulePersistence();

    logger.info("Registered external delegation", {
      batchId,
      delegationEventId: params.delegationEventId.substring(0, 8),
      delegatingAgent: params.delegatingAgent.slug,
      delegatingAgentPubkey: params.delegatingAgent.pubkey.substring(0, 16),
      assignedToPubkey: params.assignedToPubkey.substring(0, 16),
      conversationId: params.conversationId.substring(0, 8),
      phase: params.phase,
    });

    return batchId;
  }

  /**
   * Record delegation completion
   * Called when a delegation completion event (kind:1111 reply) is received
   */
  async recordTaskCompletion(params: {
    conversationId: string; // The root conversation ID
    fromPubkey: string;
    toPubkey: string;
    completionEventId: string;
    response: string;
    summary?: string;
  }): Promise<{
    batchComplete: boolean;
    batchId: string;
    delegatingAgent: string;
    delegatingAgentSlug: string;
    remainingDelegations: number;
    conversationId: string;
  }> {
    const convKey = `${params.conversationId}:${params.fromPubkey}:${params.toPubkey}`;
    const record = this.delegations.get(convKey);
    if (!record) {
      throw new Error(`No delegation record for ${convKey}`);
    }

    // Update record
    record.status = "completed";
    record.completion = {
      eventId: params.completionEventId,
      response: params.response,
      summary: params.summary,
      completedAt: Date.now(),
      completedBy: params.toPubkey,
    };
    record.updatedAt = Date.now();

    // Update indexes
    this.updateIndexesForCompletion(record);

    // Check if batch is complete
    const batch = this.batches.get(record.delegationBatchId);
    if (!batch) {
      throw new Error(`No batch found for ${record.delegationBatchId}`);
    }

    const batchDelegations = batch.delegationKeys.map((convKey) => this.delegations.get(convKey));
    const allComplete = batchDelegations.every((d) => d?.status === "completed");
    const remainingDelegations = batchDelegations.filter((d) => d?.status === "pending").length;

    if (allComplete) {
      batch.allCompleted = true;
      
      // Check if there's a synchronous listener waiting
      const hasListener = this.listenerCount(`${batch.batchId}:completion`) > 0;
      
      logger.info("🎯 Delegation batch completed - emitting completion event", {
        batchId: batch.batchId,
        delegationCount: batch.delegationKeys.length,
        rootConversationId: record.delegatingAgent.rootConversationId.substring(0, 8),
        hasListeners: hasListener,
        mode: hasListener ? "synchronous" : "async-fallback",
      });
      
      // If there's a sync listener, mark this batch as sync-handled
      if (hasListener) {
        this.syncHandledBatches.add(batch.batchId);
        // Auto-cleanup after 10 seconds to prevent memory leak
        setTimeout(() => {
          this.syncHandledBatches.delete(batch.batchId);
          logger.debug("Cleaned up sync-handled batch", { batchId: batch.batchId });
        }, 10000);
      }
      
      // Emit completion event for synchronous waiting
      const completions = this.getBatchCompletions(batch.batchId);
      this.emit(`${batch.batchId}:completion`, {
        batchId: batch.batchId,
        completions,
        rootConversationId: record.delegatingAgent.rootConversationId,
        delegatingAgent: record.delegatingAgent.pubkey,
      });
    } else {
      logger.debug("Delegation completed, batch still pending", {
        delegationEventId: record.delegationEventId.substring(0, 8),
        batchId: batch.batchId,
        remainingDelegations,
      });
    }

    this.schedulePersistence();

    return {
      batchComplete: allComplete,
      batchId: record.delegationBatchId,
      delegatingAgent: record.delegatingAgent.pubkey,
      delegatingAgentSlug: record.delegatingAgent.slug,
      remainingDelegations,
      conversationId: record.delegatingAgent.rootConversationId,
    };
  }

  /**
   * Get delegation context from conversation and agent pubkeys
   */
  getDelegationContext(conversationId: string, fromPubkey: string, toPubkey: string): DelegationRecord | undefined {
    const convKey = `${conversationId}:${fromPubkey}:${toPubkey}`;
    
    logger.debug("Looking up delegation context", {
      conversationId: conversationId.substring(0, 8),
      fromPubkey: fromPubkey.substring(0, 16),
      toPubkey: toPubkey.substring(0, 16),
      convKey,
      totalDelegations: this.delegations.size,
      hasRecord: this.delegations.has(convKey),
    });

    const record = this.delegations.get(convKey);

    if (record) {
      logger.debug("Found delegation context", {
        conversationId: conversationId.substring(0, 8),
        delegatingAgentSlug: record.delegatingAgent.slug,
        delegatingAgentPubkey: record.delegatingAgent.pubkey.substring(0, 16),
        status: record.status,
        batchId: record.delegationBatchId,
      });
    } else {
      logger.warn("No delegation context found", {
        conversationId: conversationId.substring(0, 8),
        fromPubkey: fromPubkey.substring(0, 16),
        toPubkey: toPubkey.substring(0, 16),
        availableKeys: Array.from(this.delegations.keys()),
      });
    }

    return record;
  }
  
  /**
   * Legacy method for backward compatibility - looks up by delegation event ID
   * Used when we have an explicit delegation completion with e-tags
   * Now also handles synthetic delegation IDs for multi-recipient delegations
   */
  getDelegationContextByTaskId(taskId: string): DelegationRecord | undefined {
    // First try direct match (for both old style and synthetic IDs)
    for (const record of this.delegations.values()) {
      if (record.delegationEventId === taskId) {
        return record;
      }
    }
    
    // If the provided delegationEventId looks like a synthetic ID but wasn't found,
    // it might be because we're looking up with responder pubkey but need to match assignee
    if (taskId.includes(':')) {
      const [baseEventId, pubkey] = taskId.split(':');
      
      // Look for records where the delegation event ID starts with the base event ID
      // and the assignedTo matches the pubkey portion
      for (const record of this.delegations.values()) {
        if (record.delegationEventId.startsWith(`${baseEventId}:`) && 
            record.assignedTo.pubkey === pubkey) {
          return record;
        }
      }
    }
    
    return undefined;
  }

  /**
   * Check if a batch was handled synchronously
   */
  isBatchSyncHandled(batchId: string): boolean {
    return this.syncHandledBatches.has(batchId);
  }

  /**
   * Get all completions for a batch
   * Used when synthesizing responses after all delegations complete
   */
  getBatchCompletions(batchId: string): Array<{
    taskId: string;
    response: string;
    summary?: string;
    assignedTo: string;
  }> {
    const batch = this.batches.get(batchId);
    if (!batch) return [];

    return batch.delegationKeys
      .map((convKey) => this.delegations.get(convKey))
      .filter(
        (
          record
        ): record is DelegationRecord & {
          completion: NonNullable<DelegationRecord["completion"]>;
        } => record !== undefined && record.completion !== undefined
      )
      .map((record) => ({
        taskId: record.delegationEventId,
        response: record.completion.response,
        summary: record.completion.summary,
        assignedTo: record.assignedTo.pubkey,
      }));
  }

  /**
   * Wait for a delegation batch to complete.
   * Used by delegate() tool to synchronously wait for responses.
   * This will wait indefinitely as delegations are long-running jobs.
   * 
   * @param batchId - The batch ID to wait for
   * @returns The batch completions when all delegations are done
   */
  async waitForBatchCompletion(
    batchId: string
  ): Promise<Array<{
    taskId: string;
    response: string;
    summary?: string;
    assignedTo: string;
  }>> {
    // Check if already complete
    const batch = this.batches.get(batchId);
    if (batch?.allCompleted) {
      logger.debug("Batch already completed, returning immediately", { batchId });
      return this.getBatchCompletions(batchId);
    }

    // Wait for completion event - no timeout as delegations are long-running
    return new Promise((resolve) => {
      const handler = (data: { completions: Array<any> }) => {
        logger.debug("Batch completion event received", { 
          batchId, 
          completionCount: data.completions.length 
        });
        resolve(data.completions);
      };

      this.once(`${batchId}:completion`, handler);
      logger.debug("🕑 Setting up synchronous wait listener for long-running delegation", { 
        batchId, 
        mode: "synchronous",
        timeout: "none - long-running job"
      });
    });
  }

  /**
   * Get active delegations for an agent
   */
  getAgentActiveDelegations(agentPubkey: string): DelegationRecord[] {
    const delegationIds = this.agentDelegations.get(agentPubkey);
    if (!delegationIds) return [];

    return Array.from(delegationIds)
      .map((id) => this.delegations.get(id))
      .filter((r): r is DelegationRecord => r !== undefined && r.status === "pending");
  }

  /**
   * Get all delegations for a conversation
   */
  getConversationTasks(conversationId: string): DelegationRecord[] {
    const delegationIds = this.conversationDelegations.get(conversationId);
    if (!delegationIds) return [];

    return Array.from(delegationIds)
      .map((id) => this.delegations.get(id))
      .filter((r): r is DelegationRecord => r !== undefined);
  }

  // Private helper methods

  private generateBatchId(): string {
    return `batch_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private indexDelegation(record: DelegationRecord): void {
    // Index by agent
    let agentDelegationSet = this.agentDelegations.get(record.delegatingAgent.pubkey);
    if (!agentDelegationSet) {
      agentDelegationSet = new Set();
      this.agentDelegations.set(record.delegatingAgent.pubkey, agentDelegationSet);
    }
    agentDelegationSet.add(record.delegationEventId);

    // Index by conversation
    let conversationDelegationSet = this.conversationDelegations.get(record.delegatingAgent.rootConversationId);
    if (!conversationDelegationSet) {
      conversationDelegationSet = new Set();
      this.conversationDelegations.set(record.delegatingAgent.rootConversationId, conversationDelegationSet);
    }
    conversationDelegationSet.add(record.delegationEventId);
  }

  private updateIndexesForCompletion(record: DelegationRecord): void {
    // Remove from active agent delegations if completed
    if (record.status === "completed" || record.status === "failed") {
      const agentDelegations = this.agentDelegations.get(record.delegatingAgent.pubkey);
      if (agentDelegations) {
        agentDelegations.delete(record.delegationEventId);
      }
    }
  }

  private schedulePersistence(): void {
    this.isDirty = true;

    if (this.persistenceTimer) {
      clearTimeout(this.persistenceTimer);
    }

    // Debounce persistence to avoid excessive writes
    this.persistenceTimer = setTimeout(() => {
      this.persist().catch((err) =>
        logger.error("Failed to persist delegation registry", { error: err })
      );
    }, 1000);
  }

  private async persist(): Promise<void> {
    if (!this.isDirty || this.isShuttingDown) return;

    const data = {
      delegations: Array.from(this.delegations.entries()),
      batches: Array.from(this.batches.entries()),
      agentTasks: Array.from(this.agentDelegations.entries()).map(([k, v]) => [k, Array.from(v)]),
      conversationTasks: Array.from(this.conversationDelegations.entries()).map(([k, v]) => [
        k,
        Array.from(v),
      ]),
      version: 1,
    };

    try {
      // Validate data before persisting
      PersistedDataSchema.parse(data);

      // Ensure directory exists
      const dir = path.dirname(this.persistencePath);
      await fs.mkdir(dir, { recursive: true });

      // Create backup of existing file if it exists
      try {
        await fs.access(this.persistencePath);
        await fs.copyFile(this.persistencePath, this.backupPath);
      } catch {
        // File doesn't exist yet, that's ok
      }

      // Write atomically with temp file
      const tempPath = `${this.persistencePath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
      await fs.rename(tempPath, this.persistencePath);

      this.isDirty = false;
      logger.debug("Persisted delegation registry", {
        delegations: this.delegations.size,
        batches: this.batches.size,
      });
    } catch (error) {
      logger.error("Failed to persist delegation registry", {
        error,
        delegations: this.delegations.size,
        batches: this.batches.size,
      });
      throw error;
    }
  }

  private async restore(): Promise<void> {
    let dataLoaded = false;
    let data: unknown = null;

    // Try to load from main file first
    try {
      const rawData = await fs.readFile(this.persistencePath, "utf-8");
      data = JSON.parse(rawData);
      dataLoaded = true;
      logger.debug("Loaded delegation registry from main file");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") {
        logger.warn("Failed to load main delegation registry file", { error });
      }
    }

    // If main file failed, try backup
    if (!dataLoaded) {
      try {
        const rawData = await fs.readFile(this.backupPath, "utf-8");
        data = JSON.parse(rawData);
        dataLoaded = true;
        logger.info("Loaded delegation registry from backup file");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") {
          logger.warn("Failed to load backup delegation registry file", { error });
        }
      }
    }

    // If no data loaded, start fresh
    if (!dataLoaded) {
      logger.info("No existing delegation registry found, starting fresh");
      return;
    }

    // Validate and load data
    try {
      const validatedData = PersistedDataSchema.parse(data);

      this.delegations = new Map(validatedData.delegations);
      this.batches = new Map(validatedData.batches);
      this.agentDelegations = new Map(validatedData.agentTasks.map(([k, v]) => [k, new Set(v)]));
      this.conversationDelegations = new Map(
        validatedData.conversationTasks.map(([k, v]) => [k, new Set(v)])
      );

      // Clean up old completed delegations (older than 24 hours)
      this.cleanupOldDelegations();

      logger.info("Restored delegation registry", {
        delegations: this.delegations.size,
        batches: this.batches.size,
        activeTasks: Array.from(this.delegations.values()).filter((d) => d.status === "pending")
          .length,
      });
    } catch (error) {
      logger.error("Failed to validate restored delegation data", {
        error,
        dataKeys: data && typeof data === "object" && data !== null ? Object.keys(data) : [],
      });

      // If validation fails, start fresh but save the corrupted data for debugging
      const corruptPath = `${this.persistencePath}.corrupt.${Date.now()}`;
      try {
        await fs.writeFile(corruptPath, JSON.stringify(data, null, 2));
        logger.info("Saved corrupted delegation data for debugging", { path: corruptPath });
      } catch (saveError) {
        logger.error("Failed to save corrupted data", { error: saveError });
      }
    }
  }

  private cleanupOldDelegations(): void {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    let cleaned = 0;

    for (const [delegationKey, record] of this.delegations.entries()) {
      if (record.status === "completed" && record.updatedAt < oneDayAgo) {
        this.delegations.delete(delegationKey);

        // Clean up from indexes
        const agentDelegations = this.agentDelegations.get(record.delegatingAgent.pubkey);
        if (agentDelegations) {
          agentDelegations.delete(record.delegationEventId);
        }

        const convDelegations = this.conversationDelegations.get(record.delegatingAgent.rootConversationId);
        if (convDelegations) {
          convDelegations.delete(record.delegationEventId);
        }

        cleaned++;
      }
    }

    // Clean up completed batches
    for (const [batchId, batch] of this.batches.entries()) {
      if (batch.allCompleted && batch.createdAt < oneDayAgo) {
        this.batches.delete(batchId);
      }
    }

    if (cleaned > 0) {
      logger.debug("Cleaned up old delegations", { count: cleaned });
      this.isDirty = true;
    }
  }

  /**
   * Clear all delegation data (useful for testing)
   */
  async clear(): Promise<void> {
    this.delegations.clear();
    this.batches.clear();
    this.agentDelegations.clear();
    this.conversationDelegations.clear();
    this.isDirty = true;
    await this.persist();
  }

  /**
   * Set up graceful shutdown handlers
   */
  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string): Promise<void> => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      logger.info(`DelegationRegistry: Received ${signal}, saving state...`);

      // Cancel any pending persistence timer
      if (this.persistenceTimer) {
        clearTimeout(this.persistenceTimer);
      }

      // Cancel cleanup timer
      if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
      }

      // Force final persistence
      if (this.isDirty) {
        try {
          await this.persist();
          logger.info("DelegationRegistry: State saved successfully");
        } catch (error) {
          logger.error("DelegationRegistry: Failed to save state during shutdown", { error });
        }
      }
    };

    // Handle various shutdown signals
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGUSR2", () => shutdown("SIGUSR2")); // Nodemon restart

    // Handle uncaught errors
    process.once("uncaughtException", async (error) => {
      logger.error("DelegationRegistry: Uncaught exception, saving state", { error });
      await shutdown("uncaughtException");
      process.exit(1);
    });

    process.once("unhandledRejection", async (reason) => {
      logger.error("DelegationRegistry: Unhandled rejection, saving state", { reason });
      await shutdown("unhandledRejection");
      process.exit(1);
    });
  }

  /**
   * Get registry statistics
   */
  getStats(): {
    totalDelegations: number;
    pendingDelegations: number;
    completedDelegations: number;
    failedDelegations: number;
    totalBatches: number;
    completedBatches: number;
    activeAgents: number;
    activeConversations: number;
  } {
    const delegationArray = Array.from(this.delegations.values());

    return {
      totalDelegations: delegationArray.length,
      pendingDelegations: delegationArray.filter((d) => d.status === "pending").length,
      completedDelegations: delegationArray.filter((d) => d.status === "completed").length,
      failedDelegations: delegationArray.filter((d) => d.status === "failed").length,
      totalBatches: this.batches.size,
      completedBatches: Array.from(this.batches.values()).filter((b) => b.allCompleted).length,
      activeAgents: Array.from(this.agentDelegations.entries()).filter(([_, delegations]) => delegations.size > 0)
        .length,
      activeConversations: Array.from(this.conversationDelegations.entries()).filter(
        ([_, delegations]) => delegations.size > 0
      ).length,
    };
  }
}
