import { logger } from '@/utils/logger';
import { handleError } from '@/utils/error-handler';
import * as path from 'path';
import * as fs from 'fs/promises';
import { RAGService } from './rag/RAGService';
// MCP integration will be added once resource subscription is implemented in MCPManager
// import { mcpService } from './mcp/MCPManager';

// Temporary type definition until MCP resource subscription is implemented
type Notification = {
  method: string;
  params: any;
};

export enum SubscriptionStatus {
  RUNNING = 'RUNNING',
  ERROR = 'ERROR',
  STOPPED = 'STOPPED'
}

export interface RagSubscription {
  subscriptionId: string;
  agentPubkey: string;
  mcpServerId: string;
  resourceUri: string;
  ragCollection: string;
  description: string;
  status: SubscriptionStatus;
  documentsProcessed: number;
  lastDocumentIngested?: string;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}

export class RagSubscriptionService {
  private static instance: RagSubscriptionService;
  private subscriptions: Map<string, RagSubscription> = new Map();
  private persistencePath: string;
  private ragService: RAGService;
  private isInitialized = false;
  private resourceListeners: Map<string, (notification: Notification) => void> = new Map();

  private constructor() {
    const tenexDir = path.join(process.cwd(), '.tenex');
    this.persistencePath = path.join(tenexDir, 'rag_subscriptions.json');
    this.ragService = RAGService.getInstance();
  }

  public static getInstance(): RagSubscriptionService {
    if (!RagSubscriptionService.instance) {
      RagSubscriptionService.instance = new RagSubscriptionService();
    }
    return RagSubscriptionService.instance;
  }

  /**
   * Reset the singleton instance (for testing purposes)
   */
  public static resetInstance(): void {
    RagSubscriptionService.instance = null as any;
  }

  /**
   * Initialize the service and restore subscriptions from disk
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Ensure .tenex directory exists
      const tenexDir = path.dirname(this.persistencePath);
      await fs.mkdir(tenexDir, { recursive: true });

      // Load existing subscriptions
      await this.loadSubscriptions();

      // Re-subscribe to all active subscriptions
      for (const subscription of this.subscriptions.values()) {
        if (subscription.status === SubscriptionStatus.RUNNING) {
          await this.setupResourceSubscription(subscription);
        }
      }

      this.isInitialized = true;
      logger.info(`RagSubscriptionService initialized with ${this.subscriptions.size} subscriptions`);
    } catch (error) {
      handleError(error, 'Failed to initialize RagSubscriptionService', { logLevel: 'error' });
      throw error;
    }
  }

  /**
   * Create a new RAG subscription
   */
  public async createSubscription(
    subscriptionId: string,
    agentPubkey: string,
    mcpServerId: string,
    resourceUri: string,
    ragCollection: string,
    description: string
  ): Promise<RagSubscription> {
    // Check if subscription already exists
    if (this.subscriptions.has(subscriptionId)) {
      throw new Error(`Subscription with ID '${subscriptionId}' already exists`);
    }

    // Verify the RAG collection exists
    const collections = await this.ragService.listCollections();
    if (!collections.some(c => c.name === ragCollection)) {
      throw new Error(`RAG collection '${ragCollection}' does not exist`);
    }

    // Create subscription object
    const subscription: RagSubscription = {
      subscriptionId,
      agentPubkey,
      mcpServerId,
      resourceUri,
      ragCollection,
      description,
      status: SubscriptionStatus.RUNNING,
      documentsProcessed: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    try {
      // Setup MCP resource subscription
      await this.setupResourceSubscription(subscription);

      // Store subscription
      this.subscriptions.set(subscriptionId, subscription);
      await this.saveSubscriptions();

      logger.info(`Created RAG subscription '${subscriptionId}' for agent ${agentPubkey}`);
      return subscription;
    } catch (error) {
      subscription.status = SubscriptionStatus.ERROR;
      subscription.lastError = error instanceof Error ? error.message : 'Unknown error';
      handleError(error, `Failed to create subscription '${subscriptionId}'`, { logLevel: 'error' });
      throw error;
    }
  }

  /**
   * Setup MCP resource subscription and listener
   */
  private async setupResourceSubscription(subscription: RagSubscription): Promise<void> {
    const listenerKey = `${subscription.mcpServerId}:${subscription.resourceUri}`;
    
    // Create listener for this resource
    const listener = async (notification: Notification) => {
      await this.handleResourceUpdate(subscription, notification);
    };

    // Subscribe to the MCP resource
    try {
      // TODO: Implement MCP resource subscription once MCPManager supports it
      // await mcpService.subscribeToResource(subscription.mcpServerId, subscription.resourceUri);
      
      // Store listener reference
      this.resourceListeners.set(listenerKey, listener);
      
      // TODO: Register the listener with MCP service
      // mcpService.onResourceUpdate(subscription.mcpServerId, subscription.resourceUri, listener);
      
      logger.warn(`MCP resource subscription not yet implemented for '${subscription.subscriptionId}'. Will be added when MCPManager supports resource subscriptions.`);
    } catch (error) {
      subscription.status = SubscriptionStatus.ERROR;
      subscription.lastError = error instanceof Error ? error.message : 'Unknown error';
      throw error;
    }
  }

  /**
   * Handle resource update notifications
   */
  private async handleResourceUpdate(subscription: RagSubscription, notification: Notification): Promise<void> {
    try {
      // Extract content from notification
      const content = this.extractContentFromNotification(notification);
      
      if (!content) {
        logger.warn(`Received empty update for subscription '${subscription.subscriptionId}'`);
        return;
      }

      // Add document to RAG collection
      await this.ragService.addDocuments(subscription.ragCollection, [{
        content,
        metadata: {
          subscriptionId: subscription.subscriptionId,
          mcpServerId: subscription.mcpServerId,
          resourceUri: subscription.resourceUri,
          timestamp: Date.now()
        },
        source: `${subscription.mcpServerId}:${subscription.resourceUri}`,
        timestamp: Date.now()
      }]);

      // Update subscription metrics
      subscription.documentsProcessed++;
      subscription.lastDocumentIngested = content.substring(0, 200); // Store snippet
      subscription.updatedAt = Date.now();
      subscription.status = SubscriptionStatus.RUNNING;
      delete subscription.lastError;

      await this.saveSubscriptions();
      
      logger.debug(`Processed update for subscription '${subscription.subscriptionId}', total documents: ${subscription.documentsProcessed}`);
    } catch (error) {
      subscription.status = SubscriptionStatus.ERROR;
      subscription.lastError = error instanceof Error ? error.message : 'Unknown error';
      subscription.updatedAt = Date.now();
      await this.saveSubscriptions();
      
      handleError(error, `Failed to process update for subscription '${subscription.subscriptionId}'`, { logLevel: 'error' });
    }
  }

  /**
   * Extract content from MCP notification
   */
  private extractContentFromNotification(notification: Notification): string {
    // Handle different notification formats
    if (typeof notification.params === 'object' && notification.params !== null) {
      if ('content' in notification.params) {
        return String(notification.params.content);
      }
      if ('data' in notification.params) {
        return JSON.stringify(notification.params.data);
      }
      if ('text' in notification.params) {
        return String(notification.params.text);
      }
    }
    
    // Fallback to stringifying the entire params
    return JSON.stringify(notification.params);
  }

  /**
   * List all subscriptions for an agent
   */
  public async listSubscriptions(agentPubkey: string): Promise<RagSubscription[]> {
    const agentSubscriptions = Array.from(this.subscriptions.values())
      .filter(sub => sub.agentPubkey === agentPubkey);
    
    return agentSubscriptions;
  }

  /**
   * Get a specific subscription
   */
  public async getSubscription(subscriptionId: string, agentPubkey: string): Promise<RagSubscription | null> {
    const subscription = this.subscriptions.get(subscriptionId);
    
    if (!subscription || subscription.agentPubkey !== agentPubkey) {
      return null;
    }
    
    return subscription;
  }

  /**
   * Delete a subscription
   */
  public async deleteSubscription(subscriptionId: string, agentPubkey: string): Promise<boolean> {
    const subscription = this.subscriptions.get(subscriptionId);
    
    if (!subscription || subscription.agentPubkey !== agentPubkey) {
      return false;
    }

    try {
      // Unsubscribe from MCP resource
      const listenerKey = `${subscription.mcpServerId}:${subscription.resourceUri}`;
      const listener = this.resourceListeners.get(listenerKey);
      
      if (listener) {
        // TODO: Unsubscribe from MCP resource once MCPManager supports it
        // await mcpService.unsubscribeFromResource(subscription.mcpServerId, subscription.resourceUri);
        // mcpService.removeResourceListener(subscription.mcpServerId, subscription.resourceUri, listener);
        this.resourceListeners.delete(listenerKey);
      }

      // Remove subscription
      this.subscriptions.delete(subscriptionId);
      await this.saveSubscriptions();
      
      logger.info(`Deleted subscription '${subscriptionId}'`);
      return true;
    } catch (error) {
      handleError(error, `Failed to delete subscription '${subscriptionId}'`, { logLevel: 'error' });
      throw error;
    }
  }

  /**
   * Load subscriptions from disk
   */
  private async loadSubscriptions(): Promise<void> {
    try {
      const data = await fs.readFile(this.persistencePath, 'utf-8');
      const subscriptions = JSON.parse(data) as RagSubscription[];
      
      for (const subscription of subscriptions) {
        this.subscriptions.set(subscription.subscriptionId, subscription);
      }
      
      logger.debug(`Loaded ${subscriptions.length} subscriptions from disk`);
    } catch (error) {
      // File doesn't exist yet, that's okay
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        handleError(error, 'Failed to load subscriptions', { logLevel: 'warn' });
      }
    }
  }

  /**
   * Save subscriptions to disk
   */
  private async saveSubscriptions(): Promise<void> {
    try {
      const subscriptions = Array.from(this.subscriptions.values());
      await fs.writeFile(this.persistencePath, JSON.stringify(subscriptions, null, 2));
      logger.debug(`Saved ${subscriptions.length} subscriptions to disk`);
    } catch (error) {
      handleError(error, 'Failed to save subscriptions', { logLevel: 'error' });
    }
  }

  /**
   * Get statistics for all subscriptions
   */
  public getStatistics(): {
    total: number;
    running: number;
    error: number;
    stopped: number;
    totalDocuments: number;
  } {
    let running = 0;
    let error = 0;
    let stopped = 0;
    let totalDocuments = 0;

    for (const subscription of this.subscriptions.values()) {
      totalDocuments += subscription.documentsProcessed;
      
      switch (subscription.status) {
        case SubscriptionStatus.RUNNING:
          running++;
          break;
        case SubscriptionStatus.ERROR:
          error++;
          break;
        case SubscriptionStatus.STOPPED:
          stopped++;
          break;
      }
    }

    return {
      total: this.subscriptions.size,
      running,
      error,
      stopped,
      totalDocuments
    };
  }
}