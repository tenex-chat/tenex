import { logger } from "@/utils/logger";
import type { AgentInstance } from "@/agents/types";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";

interface DelegationRecord {
  // Core identifiers
  taskId: string;                    // NDKTask event ID (kind 1934)
  delegationBatchId: string;         // Groups tasks delegated together
  
  // Context from delegating agent
  delegatingAgent: {
    slug: string;
    pubkey: string;
    conversationId: string;         // Where delegation originated
  };
  
  // Task assignment
  assignedTo: {
    pubkey: string;
    slug?: string;                  // May not be known at delegation time
  };
  
  // Task details
  content: {
    title: string;
    fullRequest: string;
    phase?: string;
  };
  
  // Status tracking
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  
  // Completion details (when status !== 'pending')
  completion?: {
    eventId: string;                // Completion event ID
    response: string;
    summary?: string;
    completedAt: number;
    completedBy: string;            // Pubkey of completing agent
  };
  
  // Metadata
  createdAt: number;
  updatedAt: number;
  
  // Related tasks (siblings in same delegation batch)
  siblingTaskIds: string[];
}

interface DelegationBatch {
  batchId: string;
  delegatingAgent: string;
  taskIds: string[];
  allCompleted: boolean;
  createdAt: number;
  originalRequest: string;
  conversationId: string;
}

// Zod schemas for validation
const DelegationRecordSchema = z.object({
  taskId: z.string(),
  delegationBatchId: z.string(),
  delegatingAgent: z.object({
    slug: z.string(),
    pubkey: z.string(),
    conversationId: z.string()
  }),
  assignedTo: z.object({
    pubkey: z.string(),
    slug: z.string().optional()
  }),
  content: z.object({
    title: z.string(),
    fullRequest: z.string(),
    phase: z.string().optional()
  }),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
  completion: z.object({
    eventId: z.string(),
    response: z.string(),
    summary: z.string().optional(),
    completedAt: z.number(),
    completedBy: z.string()
  }).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  siblingTaskIds: z.array(z.string())
});

const DelegationBatchSchema = z.object({
  batchId: z.string(),
  delegatingAgent: z.string(),
  taskIds: z.array(z.string()),
  allCompleted: z.boolean(),
  createdAt: z.number(),
  originalRequest: z.string(),
  conversationId: z.string()
});

const PersistedDataSchema = z.object({
  delegations: z.array(z.tuple([z.string(), DelegationRecordSchema])),
  batches: z.array(z.tuple([z.string(), DelegationBatchSchema])),
  agentTasks: z.array(z.tuple([z.string(), z.array(z.string())])),
  conversationTasks: z.array(z.tuple([z.string(), z.array(z.string())])),
  version: z.literal(1)
});

export class DelegationRegistry {
  // Primary storage: task ID -> full record
  private delegations: Map<string, DelegationRecord> = new Map();
  
  // Index: batch ID -> batch info
  private batches: Map<string, DelegationBatch> = new Map();
  
  // Index: agent pubkey -> active task IDs
  private agentTasks: Map<string, Set<string>> = new Map();
  
  // Index: conversation ID -> task IDs
  private conversationTasks: Map<string, Set<string>> = new Map();
  
  // Persistence
  private persistencePath: string;
  private backupPath: string;
  private persistenceTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Interval;
  private isDirty = false;
  private isShuttingDown = false;
  private isInitialized = false;
  
  constructor() {
    this.persistencePath = path.join(process.cwd(), '.tenex', 'delegations.json');
    this.backupPath = path.join(process.cwd(), '.tenex', 'delegations.backup.json');
  }
  
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    
    logger.debug("Initializing DelegationRegistry");
    
    // Restore data synchronously
    await this.restore();
    
    // Set up periodic cleanup (every hour)
    this.cleanupTimer = setInterval(() => {
      this.cleanupOldDelegations();
      if (this.isDirty) {
        this.schedulePersistence();
      }
    }, 60 * 60 * 1000);
    
    // Set up graceful shutdown
    this.setupGracefulShutdown();
    
    this.isInitialized = true;
    logger.debug("DelegationRegistry initialized successfully");
  }
  
  /**
   * Register a new delegation batch
   * Called when delegate() or delegate_phase() creates tasks
   */
  async registerDelegationBatch(params: {
    tasks: Array<{
      taskId: string;
      assignedToPubkey: string;
      title: string;
      fullRequest: string;
      phase?: string;
    }>;
    delegatingAgent: AgentInstance;
    conversationId: string;
    originalRequest: string;
  }): Promise<string> {
    const batchId = this.generateBatchId();
    
    // Create batch record
    const batch: DelegationBatch = {
      batchId,
      delegatingAgent: params.delegatingAgent.pubkey,
      taskIds: params.tasks.map(t => t.taskId),
      allCompleted: false,
      createdAt: Date.now(),
      originalRequest: params.originalRequest,
      conversationId: params.conversationId
    };
    
    // Create individual delegation records
    for (const task of params.tasks) {
      const record: DelegationRecord = {
        taskId: task.taskId,
        delegationBatchId: batchId,
        delegatingAgent: {
          slug: params.delegatingAgent.slug,
          pubkey: params.delegatingAgent.pubkey,
          conversationId: params.conversationId
        },
        assignedTo: {
          pubkey: task.assignedToPubkey
        },
        content: {
          title: task.title,
          fullRequest: task.fullRequest,
          phase: task.phase
        },
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        siblingTaskIds: params.tasks
          .filter(t => t.taskId !== task.taskId)
          .map(t => t.taskId)
      };
      
      this.delegations.set(task.taskId, record);
      this.indexTask(record);
    }
    
    this.batches.set(batchId, batch);
    this.schedulePersistence();
    
    logger.info("Registered delegation batch", {
      batchId,
      taskCount: params.tasks.length,
      delegatingAgent: params.delegatingAgent.slug,
      delegatingAgentPubkey: params.delegatingAgent.pubkey.substring(0, 16),
      conversationId: params.conversationId.substring(0, 8),
      taskIds: params.tasks.map(t => ({ id: t.taskId.substring(0, 8), assignedTo: t.assignedToPubkey.substring(0, 16) }))
    });
    
    // Debug: Log each individual task registration
    for (const task of params.tasks) {
      logger.debug("Registered individual delegation task", {
        taskId: task.taskId.substring(0, 8),
        fullTaskId: task.taskId,
        delegatingAgentPubkey: params.delegatingAgent.pubkey.substring(0, 16),
        assignedToPubkey: task.assignedToPubkey.substring(0, 16),
        title: task.title,
        phase: task.phase
      });
    }
    
    return batchId;
  }
  
  /**
   * Record task completion
   * Called when a task completion event is received
   */
  async recordTaskCompletion(params: {
    taskId: string;
    completionEventId: string;
    response: string;
    summary?: string;
    completedBy: string;
  }): Promise<{
    batchComplete: boolean;
    batchId: string;
    delegatingAgent: string;
    delegatingAgentSlug: string;
    remainingTasks: number;
    conversationId: string;
  }> {
    const record = this.delegations.get(params.taskId);
    if (!record) {
      throw new Error(`No delegation record for task ${params.taskId}`);
    }
    
    // Update record
    record.status = 'completed';
    record.completion = {
      eventId: params.completionEventId,
      response: params.response,
      summary: params.summary,
      completedAt: Date.now(),
      completedBy: params.completedBy
    };
    record.updatedAt = Date.now();
    
    // Update indexes
    this.updateIndexesForCompletion(record);
    
    // Check if batch is complete
    const batch = this.batches.get(record.delegationBatchId);
    if (!batch) {
      throw new Error(`No batch found for ${record.delegationBatchId}`);
    }
    
    const batchTasks = batch.taskIds.map(id => this.delegations.get(id));
    const allComplete = batchTasks.every(t => t?.status === 'completed');
    const remainingTasks = batchTasks.filter(t => t?.status === 'pending').length;
    
    if (allComplete) {
      batch.allCompleted = true;
      logger.info("Delegation batch completed", {
        batchId: batch.batchId,
        taskCount: batch.taskIds.length,
        conversationId: record.delegatingAgent.conversationId.substring(0, 8)
      });
    } else {
      logger.debug("Task completed, batch still pending", {
        taskId: params.taskId.substring(0, 8),
        batchId: batch.batchId,
        remainingTasks
      });
    }
    
    this.schedulePersistence();
    
    return {
      batchComplete: allComplete,
      batchId: record.delegationBatchId,
      delegatingAgent: record.delegatingAgent.pubkey,
      delegatingAgentSlug: record.delegatingAgent.slug,
      remainingTasks,
      conversationId: record.delegatingAgent.conversationId
    };
  }
  
  /**
   * Get delegation context from just a task ID
   * This is the KEY improvement - no conversation lookup needed
   */
  getDelegationContext(taskId: string): DelegationRecord | undefined {
    logger.debug("Looking up delegation context", {
      taskId: taskId.substring(0, 8),
      fullTaskId: taskId,
      totalDelegations: this.delegations.size,
      hasRecord: this.delegations.has(taskId)
    });
    
    const record = this.delegations.get(taskId);
    
    if (record) {
      logger.debug("Found delegation context", {
        taskId: taskId.substring(0, 8),
        delegatingAgentSlug: record.delegatingAgent.slug,
        delegatingAgentPubkey: record.delegatingAgent.pubkey.substring(0, 16),
        status: record.status,
        batchId: record.delegationBatchId
      });
    } else {
      logger.warn("No delegation context found", {
        taskId: taskId.substring(0, 8),
        fullTaskId: taskId,
        availableTaskIds: Array.from(this.delegations.keys()).map(id => id.substring(0, 8))
      });
    }
    
    return record;
  }
  
  /**
   * Get all completions for a batch
   * Used when synthesizing responses after all tasks complete
   */
  getBatchCompletions(batchId: string): Array<{
    taskId: string;
    response: string;
    summary?: string;
    assignedTo: string;
  }> {
    const batch = this.batches.get(batchId);
    if (!batch) return [];
    
    return batch.taskIds
      .map(id => this.delegations.get(id))
      .filter((record): record is DelegationRecord & { completion: NonNullable<DelegationRecord['completion']> } => 
        record !== undefined && record.completion !== undefined
      )
      .map(record => ({
        taskId: record.taskId,
        response: record.completion.response,
        summary: record.completion.summary,
        assignedTo: record.assignedTo.pubkey
      }));
  }
  
  /**
   * Get active delegations for an agent
   */
  getAgentActiveDelegations(agentPubkey: string): DelegationRecord[] {
    const taskIds = this.agentTasks.get(agentPubkey);
    if (!taskIds) return [];
    
    return Array.from(taskIds)
      .map(id => this.delegations.get(id))
      .filter((r): r is DelegationRecord => 
        r !== undefined && r.status === 'pending'
      );
  }
  
  /**
   * Get all tasks for a conversation
   */
  getConversationTasks(conversationId: string): DelegationRecord[] {
    const taskIds = this.conversationTasks.get(conversationId);
    if (!taskIds) return [];
    
    return Array.from(taskIds)
      .map(id => this.delegations.get(id))
      .filter((r): r is DelegationRecord => r !== undefined);
  }
  
  // Private helper methods
  
  private generateBatchId(): string {
    return `batch_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
  
  private indexTask(record: DelegationRecord): void {
    // Index by agent
    let agentTaskSet = this.agentTasks.get(record.delegatingAgent.pubkey);
    if (!agentTaskSet) {
      agentTaskSet = new Set();
      this.agentTasks.set(record.delegatingAgent.pubkey, agentTaskSet);
    }
    agentTaskSet.add(record.taskId);
    
    // Index by conversation
    let conversationTaskSet = this.conversationTasks.get(record.delegatingAgent.conversationId);
    if (!conversationTaskSet) {
      conversationTaskSet = new Set();
      this.conversationTasks.set(record.delegatingAgent.conversationId, conversationTaskSet);
    }
    conversationTaskSet.add(record.taskId);
  }
  
  private updateIndexesForCompletion(record: DelegationRecord): void {
    // Remove from active agent tasks if completed
    if (record.status === 'completed' || record.status === 'failed') {
      const agentTasks = this.agentTasks.get(record.delegatingAgent.pubkey);
      if (agentTasks) {
        agentTasks.delete(record.taskId);
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
      this.persist().catch(err => 
        logger.error("Failed to persist delegation registry", { error: err })
      );
    }, 1000);
  }
  
  private async persist(): Promise<void> {
    if (!this.isDirty || this.isShuttingDown) return;
    
    const data = {
      delegations: Array.from(this.delegations.entries()),
      batches: Array.from(this.batches.entries()),
      agentTasks: Array.from(this.agentTasks.entries())
        .map(([k, v]) => [k, Array.from(v)]),
      conversationTasks: Array.from(this.conversationTasks.entries())
        .map(([k, v]) => [k, Array.from(v)]),
      version: 1
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
        batches: this.batches.size
      });
    } catch (error) {
      logger.error("Failed to persist delegation registry", { 
        error,
        delegations: this.delegations.size,
        batches: this.batches.size
      });
      throw error;
    }
  }
  
  private async restore(): Promise<void> {
    let dataLoaded = false;
    let data: unknown = null;
    
    // Try to load from main file first
    try {
      const rawData = await fs.readFile(this.persistencePath, 'utf-8');
      data = JSON.parse(rawData);
      dataLoaded = true;
      logger.debug("Loaded delegation registry from main file");
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') {
        logger.warn("Failed to load main delegation registry file", { error });
      }
    }
    
    // If main file failed, try backup
    if (!dataLoaded) {
      try {
        const rawData = await fs.readFile(this.backupPath, 'utf-8');
        data = JSON.parse(rawData);
        dataLoaded = true;
        logger.info("Loaded delegation registry from backup file");
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') {
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
      this.agentTasks = new Map(
        validatedData.agentTasks.map(([k, v]) => [k, new Set(v)])
      );
      this.conversationTasks = new Map(
        validatedData.conversationTasks.map(([k, v]) => [k, new Set(v)])
      );
      
      // Clean up old completed delegations (older than 24 hours)
      this.cleanupOldDelegations();
      
      logger.info("Restored delegation registry", {
        delegations: this.delegations.size,
        batches: this.batches.size,
        activeTasks: Array.from(this.delegations.values()).filter(d => d.status === 'pending').length
      });
    } catch (error) {
      logger.error("Failed to validate restored delegation data", { 
        error,
        dataKeys: data && typeof data === 'object' && data !== null ? Object.keys(data) : []
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
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    let cleaned = 0;
    
    for (const [taskId, record] of this.delegations.entries()) {
      if (record.status === 'completed' && record.updatedAt < oneDayAgo) {
        this.delegations.delete(taskId);
        
        // Clean up from indexes
        const agentTasks = this.agentTasks.get(record.delegatingAgent.pubkey);
        if (agentTasks) {
          agentTasks.delete(taskId);
        }
        
        const convTasks = this.conversationTasks.get(record.delegatingAgent.conversationId);
        if (convTasks) {
          convTasks.delete(taskId);
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
    this.agentTasks.clear();
    this.conversationTasks.clear();
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
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGUSR2', () => shutdown('SIGUSR2')); // Nodemon restart
    
    // Handle uncaught errors
    process.once('uncaughtException', async (error) => {
      logger.error("DelegationRegistry: Uncaught exception, saving state", { error });
      await shutdown('uncaughtException');
      process.exit(1);
    });
    
    process.once('unhandledRejection', async (reason) => {
      logger.error("DelegationRegistry: Unhandled rejection, saving state", { reason });
      await shutdown('unhandledRejection');
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
      pendingDelegations: delegationArray.filter(d => d.status === 'pending').length,
      completedDelegations: delegationArray.filter(d => d.status === 'completed').length,
      failedDelegations: delegationArray.filter(d => d.status === 'failed').length,
      totalBatches: this.batches.size,
      completedBatches: Array.from(this.batches.values()).filter(b => b.allCompleted).length,
      activeAgents: Array.from(this.agentTasks.entries()).filter(([_, tasks]) => tasks.size > 0).length,
      activeConversations: Array.from(this.conversationTasks.entries()).filter(([_, tasks]) => tasks.size > 0).length
    };
  }
}