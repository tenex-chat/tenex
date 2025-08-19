import { logger } from "@/utils/logger";
import type { AgentInstance } from "@/agents/types";
import { promises as fs } from "fs";
import path from "path";

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

export class DelegationRegistry {
  private static instance: DelegationRegistry;
  
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
  private persistenceTimer?: NodeJS.Timeout;
  private isDirty = false;
  
  private constructor() {
    this.persistencePath = path.join(process.cwd(), '.tenex', 'delegations.json');
    this.restore().catch(err => 
      logger.error("Failed to restore delegation registry", { error: err })
    );
  }
  
  static getInstance(): DelegationRegistry {
    if (!this.instance) {
      this.instance = new DelegationRegistry();
    }
    return this.instance;
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
      conversationId: params.conversationId.substring(0, 8)
    });
    
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
    return this.delegations.get(taskId);
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
      .filter(record => record?.completion)
      .map(record => ({
        taskId: record!.taskId,
        response: record!.completion!.response,
        summary: record!.completion?.summary,
        assignedTo: record!.assignedTo.pubkey
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
    if (!this.agentTasks.has(record.delegatingAgent.pubkey)) {
      this.agentTasks.set(record.delegatingAgent.pubkey, new Set());
    }
    this.agentTasks.get(record.delegatingAgent.pubkey)!.add(record.taskId);
    
    // Index by conversation
    if (!this.conversationTasks.has(record.delegatingAgent.conversationId)) {
      this.conversationTasks.set(record.delegatingAgent.conversationId, new Set());
    }
    this.conversationTasks.get(record.delegatingAgent.conversationId)!.add(record.taskId);
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
    if (!this.isDirty) return;
    
    const data = {
      delegations: Array.from(this.delegations.entries()),
      batches: Array.from(this.batches.entries()),
      agentTasks: Array.from(this.agentTasks.entries())
        .map(([k, v]) => [k, Array.from(v)]),
      conversationTasks: Array.from(this.conversationTasks.entries())
        .map(([k, v]) => [k, Array.from(v)]),
      version: 1
    };
    
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
      batches: this.batches.size
    });
  }
  
  private async restore(): Promise<void> {
    try {
      const data = JSON.parse(
        await fs.readFile(this.persistencePath, 'utf-8')
      );
      
      if (data.version !== 1) {
        logger.warn("Unknown delegation registry version", { version: data.version });
        return;
      }
      
      this.delegations = new Map(data.delegations);
      this.batches = new Map(data.batches);
      this.agentTasks = new Map(
        data.agentTasks.map(([k, v]: [string, string[]]) => [k, new Set(v)])
      );
      this.conversationTasks = new Map(
        data.conversationTasks.map(([k, v]: [string, string[]]) => [k, new Set(v)])
      );
      
      // Clean up old completed delegations (older than 24 hours)
      this.cleanupOldDelegations();
      
      logger.info("Restored delegation registry", {
        delegations: this.delegations.size,
        batches: this.batches.size
      });
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        logger.debug("No existing delegation registry to restore");
      } else {
        logger.error("Failed to restore delegation registry", { error });
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
}