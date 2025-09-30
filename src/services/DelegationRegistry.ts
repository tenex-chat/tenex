import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentInstance } from "@/agents/types";
import { logger } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { z } from "zod";

export interface DelegationRecord {
  // Core identifiers
  delegationEventId: string; // Delegation event ID (kind:1111) - actual Nostr event ID
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
    response: string;
    summary?: string;
    completedAt: number;
    completedBy: string; // Pubkey of completing agent
    event?: NDKEvent; // The actual completion event for threading
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
      response: z.string(),
      summary: z.string().optional(),
      completedAt: z.number(),
      completedBy: z.string(),
      event: z.string().optional(), // Serialized NDKEvent
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
  private persistenceTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private isDirty = false;

  private constructor() {
    super();
    this.persistencePath = path.join(process.cwd(), ".tenex", "delegations.json");
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
   * Register a delegation - Unified interface for single and multi-recipient
   * 
   * @param delegationEventId - The actual Nostr event ID (kind:11 or kind:1111)
   * @param recipients - Array of recipients (can be single or multiple)
   * @param delegatingAgent - The agent creating the delegation  
   * @param rootConversationId - The root conversation where delegation originated
   * @param originalRequest - The original request text
   */
  async registerDelegation(params: {
    delegationEventId: string;
    recipients: Array<{
      pubkey: string;
      request: string;
      phase?: string;
    }>;
    delegatingAgent: AgentInstance;
    rootConversationId: string;
    originalRequest: string;
  }): Promise<string> {
    const batchId = this.generateBatchId();

    // Create batch record
    const batch: DelegationBatch = {
      batchId,
      delegatingAgent: params.delegatingAgent.pubkey,
      delegationKeys: [],
      allCompleted: false,
      createdAt: Date.now(),
      originalRequest: params.originalRequest,
      rootConversationId: params.rootConversationId,
    };

    // Registration details logged at the end of this method

    // Create individual delegation records
    for (const recipient of params.recipients) {
      const convKey = `${params.rootConversationId}:${params.delegatingAgent.pubkey}:${recipient.pubkey}`;
      
      const record: DelegationRecord = {
        delegationEventId: params.delegationEventId,
        delegationBatchId: batchId,
        delegatingAgent: {
          slug: params.delegatingAgent.slug,
          pubkey: params.delegatingAgent.pubkey,
          rootConversationId: params.rootConversationId,
        },
        assignedTo: {
          pubkey: recipient.pubkey,
        },
        content: {
          fullRequest: recipient.request,
          phase: recipient.phase,
        },
        status: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        siblingDelegationIds: [],
      };

      this.delegations.set(convKey, record);
      batch.delegationKeys.push(convKey);
      this.indexDelegation(record);
    }

    // Update sibling IDs
    for (const convKey of batch.delegationKeys) {
      const record = this.delegations.get(convKey);
      if (!record) {
        throw new Error(`No delegation record found for ${convKey}`);
      }
      record.siblingDelegationIds = batch.delegationKeys.filter(k => k !== convKey);
    }

    this.batches.set(batchId, batch);
    this.schedulePersistence();

    logger.debug("✅ Delegation registered", {
      batchId,
      delegationEventId: params.delegationEventId.substring(0, 8),
      recipientCount: params.recipients.length,
      delegatingAgent: params.delegatingAgent.slug,
    });

    return batchId;
  }


  /**
   * Check if an event is a delegation response we're waiting for.
   * A valid delegation response must:
   * 1. Be kind 1111
   * 2. Have an e-tag pointing to the delegation event
   * 3. Have a p-tag pointing to the delegating agent
   */
  isDelegationResponse(event: NDKEvent): boolean {
    if (event.kind !== 1111) return false;
    
    const eTags = event.getMatchingTags("e");
    for (const eTagArray of eTags) {
      const delegationEventId = eTagArray[1];
      if (!delegationEventId) continue;
      
      const delegation = this.findDelegationByEventAndResponder(delegationEventId, event.pubkey);
      if (delegation) {
        // Check if the event p-tags the delegating agent
        const pTags = event.getMatchingTags("p");
        for (const pTagArray of pTags) {
          const taggedPubkey = pTagArray[1];
          if (taggedPubkey === delegation.delegatingAgent.pubkey) {
            logger.debug("Valid delegation response detected", {
              respondingAgent: event.pubkey.substring(0, 8),
              delegatingAgent: delegation.delegatingAgent.pubkey.substring(0, 8),
              delegationEventId: delegationEventId.substring(0, 8),
              eventId: event.id.substring(0, 8),
            });
            return true;
          }
        }
        
        logger.debug("Event references delegation but doesn't p-tag delegating agent", {
          respondingAgent: event.pubkey.substring(0, 8),
          delegatingAgent: delegation.delegatingAgent.pubkey.substring(0, 8),
          delegationEventId: delegationEventId.substring(0, 8),
          eventId: event.id.substring(0, 8),
          pTags: pTags.map(p => p[1].substring(0, 8)),
        });
      }
    }
    return false;
  }

  /**
   * Handle a delegation response - find the delegation and record completion
   */
  async handleDelegationResponse(event: NDKEvent): Promise<void> {
    if (!this.isDelegationResponse(event)) {
      throw new Error(`Event ${event.id} is not a delegation response`);
    }

    // Find the delegation this is responding to
    const eTags = event.getMatchingTags("e");
    for (const eTagArray of eTags) {
      const delegationEventId = eTagArray[1];
      if (!delegationEventId) continue;
      
      const delegation = this.findDelegationByEventAndResponder(delegationEventId, event.pubkey);
      if (delegation) {
        await this.recordDelegationCompletion({
          conversationId: delegation.delegatingAgent.rootConversationId,
          fromPubkey: delegation.delegatingAgent.pubkey,
          toPubkey: event.pubkey,
          completionEventId: event.id,
          response: event.content,
          summary: event.tagValue?.("summary"),
          completionEvent: event, // Pass the actual event
        });
        break;
      }
    }
  }

  /**
   * Record delegation completion
   * Called when a delegation completion event (kind:1111 reply) is received
   */
  async recordDelegationCompletion(params: {
    conversationId: string; // The root conversation ID
    fromPubkey: string;
    toPubkey: string;
    completionEventId: string;
    response: string;
    summary?: string;
    completionEvent?: NDKEvent; // The actual completion event
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
    
    // Prevent duplicate completions
    if (record.status === "completed") {
      throw new Error(`Delegation already completed for ${convKey}. Original completion: ${record.completion?.event?.id}`);
    }

    // Log which event is being used to mark delegation as complete
    logger.info("📝 Marking delegation as complete", {
      convKey,
      delegationEventId: record.delegationEventId,
      completionEventId: params.completionEventId,
      completingAgent: params.toPubkey,
      batchId: record.delegationBatchId,
    });

    // Update record
    record.status = "completed";
    record.completion = {
      response: params.response,
      summary: params.summary,
      completedAt: Date.now(),
      completedBy: params.toPubkey,
      event: params.completionEvent,
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
        completions: completions.map(c => ({
          taskId: c.delegationId,
          response: c.response,
          summary: c.summary,
          assignedTo: c.assignedTo
        })),
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
   * Get delegation context by conversation key lookup
   * This is the primary way to find a delegation record
   * 
   * @param rootConversationId - The root conversation where delegation originated
   * @param fromPubkey - The delegating agent's pubkey
   * @param toPubkey - The recipient agent's pubkey
   * @returns The delegation record if found
   */
  getDelegationByConversationKey(
    rootConversationId: string,
    fromPubkey: string,
    toPubkey: string
  ): DelegationRecord | undefined {
    const convKey = `${rootConversationId}:${fromPubkey}:${toPubkey}`;
    
    logger.debug("🔍 Looking up delegation by conversation key", {
      convKey,
      rootConversationId: rootConversationId.substring(0, 8),
      fromPubkey: fromPubkey.substring(0, 16),
      toPubkey: toPubkey.substring(0, 16),
      exists: this.delegations.has(convKey),
    });

    const record = this.delegations.get(convKey);
    
    if (record) {
      logger.debug("✅ Found delegation by conversation key", {
        delegationEventId: record.delegationEventId.substring(0, 8),
        status: record.status,
        batchId: record.delegationBatchId,
      });
    } else {
      logger.debug("❌ No delegation found for conversation key", {
        convKey,
        availableKeys: Array.from(this.delegations.keys()).slice(0, 5), // Log first 5 for debugging
      });
    }

    return record;
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
    delegationId: string;
    response: string;
    summary?: string;
    assignedTo: string;
    event?: NDKEvent;
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
        delegationId: record.delegationEventId,
        response: record.completion.response,
        summary: record.completion.summary,
        assignedTo: record.assignedTo.pubkey,
        event: record.completion.event,
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
    delegationId: string;
    response: string;
    summary?: string;
    assignedTo: string;
    event?: NDKEvent;
  }>> {
    // Check if already complete
    const batch = this.batches.get(batchId);
    if (batch?.allCompleted) {
      logger.debug("Batch already completed, returning immediately", { batchId });
      return this.getBatchCompletions(batchId);
    }

    // Wait for completion event - no timeout as delegations are long-running
    return new Promise((resolve) => {
      const handler = (data: { completions: Array<{ taskId: string; response: string; summary?: string; assignedTo: string; event?: NDKEvent; }> }): void => {
        logger.debug("Batch completion event received", { 
          batchId, 
          completionCount: data.completions.length 
        });
        resolve(data.completions.map(c => ({
          delegationId: c.taskId,
          response: c.response,
          summary: c.summary,
          assignedTo: c.assignedTo,
          event: c.event
        })));
      };

      this.once(`${batchId}:completion`, handler);
    });
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
    if (!this.isDirty) return;

    // Serialize NDKEvent objects properly before JSON.stringify
    const serializableDelegations = Array.from(this.delegations.entries()).map(([key, record]) => {
      const serializedRecord = { ...record };
      if (record.completion?.event) {
        serializedRecord.completion = {
          ...record.completion,
          event: record.completion.event.serialize(),
        };
      }
      return [key, serializedRecord];
    });

    const data = {
      delegations: serializableDelegations,
      batches: Array.from(this.batches.entries()),
      agentTasks: Array.from(this.agentDelegations.entries()).map(([k, v]) => [k, Array.from(v)]),
      conversationTasks: Array.from(this.conversationDelegations.entries()).map(([k, v]) => [
        k,
        Array.from(v),
      ]),
      version: 1,
    };

    try {
      // Ensure directory exists
      const dir = path.dirname(this.persistencePath);
      await fs.mkdir(dir, { recursive: true });

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


    // If no data loaded, start fresh
    if (!dataLoaded) {
      logger.info("No existing delegation registry found, starting fresh");
      return;
    }

    // Validate and load data
    try {
      const validatedData = PersistedDataSchema.parse(data);
      
      // Deserialize NDKEvent objects when loading delegations
      const deserializedDelegations = validatedData.delegations.map(([key, record]) => {
        if (record.completion?.event && typeof record.completion.event === 'string') {
          const deserializedRecord = { ...record };
          deserializedRecord.completion = {
            ...record.completion,
            event: NDKEvent.deserialize(undefined, record.completion.event),
          };
          return [key, deserializedRecord] as [string, DelegationRecord];
        }
        return [key, record] as [string, DelegationRecord];
      });
      
      this.delegations = new Map(deserializedDelegations);
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
   * Find delegation records by event ID and responder pubkey
   * Used when processing completion events
   * 
   * @param eventId - The delegation event ID from the e-tag
   * @param responderPubkey - The pubkey of the responding agent
   * @returns The matching delegation record if found
   */
  findDelegationByEventAndResponder(
    eventId: string,
    responderPubkey: string
  ): DelegationRecord | undefined {
    logger.debug("🔍 Finding delegation by event ID and responder", {
      eventId: eventId.substring(0, 8),
      responderPubkey: responderPubkey.substring(0, 16),
    });
    
    // Search through all delegations
    for (const [convKey, record] of this.delegations.entries()) {
      if (record.delegationEventId === eventId && 
          record.assignedTo.pubkey === responderPubkey) {
        
        logger.debug("✅ Found delegation match", {
          conversationKey: convKey,
          status: record.status,
          delegatingAgent: record.delegatingAgent.slug,
        });
        
        return record;
      }
    }
    
    logger.debug("❌ No delegation found for event+responder combination");
    return undefined;
  }

}
