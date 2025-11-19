import * as fs from "node:fs/promises";
import { config } from "@/services/ConfigService";
import * as path from "node:path";
import { handleError } from "@/utils/error-handler";
import { logger } from "@/utils/logger";
import { RAGService } from "./RAGService";

/**
 * RagSubscriptionService - Manages persistent RAG subscriptions to MCP resources
 *
 * This service enables automatic ingestion of MCP resource updates into RAG collections.
 * When a resource is updated, the MCP server sends a notification, which is automatically
 * processed and added to the configured RAG collection.
 *
 * Features:
 * - Persistent subscriptions across restarts
 * - Automatic reconnection on initialization
 * - Error tracking and metrics
 * - Fallback polling support for servers without subscription capabilities
 */

type Notification = {
    method: string;
    params: Record<string, unknown>;
};

export enum SubscriptionStatus {
    RUNNING = "RUNNING",
    ERROR = "ERROR",
    STOPPED = "STOPPED",
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
        // Use global location for RAG subscriptions since it's a singleton
        const tenexDir = config.getConfigPath();
        this.persistencePath = path.join(tenexDir, "rag_subscriptions.json");
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
        RagSubscriptionService.instance = undefined as unknown as RagSubscriptionService;
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
            logger.info(
                `RagSubscriptionService initialized with ${this.subscriptions.size} subscriptions`
            );
        } catch (error) {
            handleError(error, "Failed to initialize RagSubscriptionService", {
                logLevel: "error",
            });
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

        // Validate resourceUri is a proper URI format
        try {
            new URL(resourceUri);
        } catch {
            throw new Error(
                `Invalid resourceUri: "${resourceUri}". Resource URI must be a valid URI format (e.g., "nostr://feed/pubkey/kinds", "file:///path/to/file"). This appears to be a tool name or invalid format. If you're using a resource template, you must first expand it with parameters to get the actual URI.`
            );
        }

        // Verify the RAG collection exists
        const collections = await this.ragService.listCollections();
        if (!collections.includes(ragCollection)) {
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
            updatedAt: Date.now(),
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
            subscription.lastError = error instanceof Error ? error.message : "Unknown error";
            handleError(error, `Failed to create subscription '${subscriptionId}'`, {
                logLevel: "error",
            });
            throw error;
        }
    }

    /**
     * Setup MCP resource subscription and listener
     */
    private async setupResourceSubscription(subscription: RagSubscription): Promise<void> {
        const listenerKey = `${subscription.mcpServerId}:${subscription.resourceUri}`;

        // Create listener for this resource
        const listener = async (notification: { uri: string; content?: string }): Promise<void> => {
            await this.handleResourceUpdate(subscription, {
                method: "notifications/resources/updated",
                params: notification,
            });
        };

        try {
            // Validate that resourceUri is a proper URI format
            try {
                new URL(subscription.resourceUri);
            } catch {
                throw new Error(
                    `Invalid resourceUri: "${subscription.resourceUri}". Resource URI must be a valid URI format (e.g., "nostr://feed/pubkey/kinds", "file:///path/to/file"). This appears to be a tool name or invalid format. If you're using a resource template, you must first expand it with parameters to get the actual URI.`
                );
            }

            // Import mcpManager dynamically to avoid circular dependency
            const { mcpManager } = await import("../mcp/MCPManager");

            // Try to subscribe to resource updates
            let subscriptionSupported = true;
            try {
                // Register notification handler
                mcpManager.onResourceNotification(subscription.mcpServerId, listener);

                // Subscribe to resource updates
                await mcpManager.subscribeToResource(
                    subscription.mcpServerId,
                    subscription.resourceUri
                );

                // Store listener reference for cleanup
                this.resourceListeners.set(
                    listenerKey,
                    listener as unknown as (notification: Notification) => void
                );

                logger.info(
                    `RAG subscription '${subscription.subscriptionId}' active with push notifications. ` +
                        `Listening for updates from ${subscription.mcpServerId}:${subscription.resourceUri}`
                );
            } catch (error) {
                if (
                    error instanceof Error &&
                    error.message.includes("does not support resource subscriptions")
                ) {
                    // Server doesn't support subscriptions, use polling instead
                    subscriptionSupported = false;
                    logger.warn(
                        `Server '${subscription.mcpServerId}' does not support resource subscriptions. Subscription '${subscription.subscriptionId}' will use polling mode. Call pollResource() manually or set up a polling interval.`
                    );
                    process.exit(1);
                } else {
                    throw error;
                }
            }

            if (!subscriptionSupported) {
                subscription.lastError = "Server does not support subscriptions - use polling mode";
            }
        } catch (error) {
            subscription.status = SubscriptionStatus.ERROR;
            subscription.lastError = error instanceof Error ? error.message : "Unknown error";
            throw error;
        }
    }

    /**
     * Handle resource update notifications
     */
    private async handleResourceUpdate(
        subscription: RagSubscription,
        notification: Notification
    ): Promise<void> {
        try {
            // Extract content from notification
            const content = this.extractContentFromNotification(notification);

            if (!content) {
                logger.warn(
                    `Received empty update for subscription '${subscription.subscriptionId}'`
                );
                return;
            }

            // Add document to RAG collection
            await this.ragService.addDocuments(subscription.ragCollection, [
                {
                    content,
                    metadata: {
                        subscriptionId: subscription.subscriptionId,
                        mcpServerId: subscription.mcpServerId,
                        resourceUri: subscription.resourceUri,
                        timestamp: Date.now(),
                    },
                    source: `${subscription.mcpServerId}:${subscription.resourceUri}`,
                    timestamp: Date.now(),
                },
            ]);

            // Update subscription metrics
            subscription.documentsProcessed++;
            subscription.lastDocumentIngested = content.substring(0, 200); // Store snippet
            subscription.updatedAt = Date.now();
            subscription.status = SubscriptionStatus.RUNNING;
            subscription.lastError = undefined;

            await this.saveSubscriptions();

            logger.debug(
                `Processed update for subscription '${subscription.subscriptionId}', total documents: ${subscription.documentsProcessed}`
            );
        } catch (error) {
            subscription.status = SubscriptionStatus.ERROR;
            subscription.lastError = error instanceof Error ? error.message : "Unknown error";
            subscription.updatedAt = Date.now();
            await this.saveSubscriptions();

            handleError(
                error,
                `Failed to process update for subscription '${subscription.subscriptionId}'`,
                { logLevel: "error" }
            );
        }
    }

    /**
     * Extract content from MCP notification
     */
    private extractContentFromNotification(notification: Notification): string {
        // Handle different notification formats
        if (typeof notification.params === "object" && notification.params !== null) {
            if ("content" in notification.params) {
                return String(notification.params.content);
            }
            if ("data" in notification.params) {
                return JSON.stringify(notification.params.data);
            }
            if ("text" in notification.params) {
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
        const agentSubscriptions = Array.from(this.subscriptions.values()).filter(
            (sub) => sub.agentPubkey === agentPubkey
        );

        return agentSubscriptions;
    }

    /**
     * Get a specific subscription
     */
    public async getSubscription(
        subscriptionId: string,
        agentPubkey: string
    ): Promise<RagSubscription | null> {
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
                const { mcpManager } = await import("../mcp/MCPManager");

                // Unsubscribe from the resource
                await mcpManager.unsubscribeFromResource(
                    subscription.mcpServerId,
                    subscription.resourceUri
                );

                this.resourceListeners.delete(listenerKey);
            }

            // Remove subscription
            this.subscriptions.delete(subscriptionId);
            await this.saveSubscriptions();

            logger.info(`Deleted subscription '${subscriptionId}'`);
            return true;
        } catch (error) {
            handleError(error, `Failed to delete subscription '${subscriptionId}'`, {
                logLevel: "error",
            });
            throw error;
        }
    }

    /**
     * Load subscriptions from disk
     */
    private async loadSubscriptions(): Promise<void> {
        try {
            const data = await fs.readFile(this.persistencePath, "utf-8");
            const subscriptions = JSON.parse(data) as RagSubscription[];

            for (const subscription of subscriptions) {
                this.subscriptions.set(subscription.subscriptionId, subscription);
            }

            logger.debug(`Loaded ${subscriptions.length} subscriptions from disk`);
        } catch (error) {
            // File doesn't exist yet, that's okay
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                handleError(error, "Failed to load subscriptions", { logLevel: "warn" });
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
            handleError(error, "Failed to save subscriptions", { logLevel: "error" });
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
            totalDocuments,
        };
    }

    /**
     * Manually trigger a resource update for a subscription
     *
     * This is a workaround until MCP SDK supports resources/subscribe.
     * Allows manual polling or webhook-triggered updates to be processed.
     *
     * @param subscriptionId - The subscription to update
     * @param agentPubkey - Agent pubkey for authorization
     * @param content - The resource content to ingest
     */
    public async manualResourceUpdate(
        subscriptionId: string,
        agentPubkey: string,
        content: string
    ): Promise<void> {
        const subscription = this.subscriptions.get(subscriptionId);

        if (!subscription || subscription.agentPubkey !== agentPubkey) {
            throw new Error(`Subscription '${subscriptionId}' not found or unauthorized`);
        }

        // Simulate a notification
        const notification: Notification = {
            method: "notifications/resources/updated",
            params: {
                content,
                uri: subscription.resourceUri,
                timestamp: Date.now(),
            },
        };

        await this.handleResourceUpdate(subscription, notification);
    }

    /**
     * Poll a resource and update the subscription
     *
     * Fetches the current resource content via MCPManager and ingests it.
     * This is a workaround until MCP SDK supports resources/subscribe.
     *
     * @param subscriptionId - The subscription to poll
     * @param agentPubkey - Agent pubkey for authorization
     */
    public async pollResource(subscriptionId: string, agentPubkey: string): Promise<void> {
        const subscription = this.subscriptions.get(subscriptionId);

        if (!subscription || subscription.agentPubkey !== agentPubkey) {
            throw new Error(`Subscription '${subscriptionId}' not found or unauthorized`);
        }

        try {
            // Import mcpManager here to avoid circular dependency
            const { mcpManager } = await import("../mcp/MCPManager");

            // Read the current resource content
            const result = await mcpManager.readResource(
                subscription.mcpServerId,
                subscription.resourceUri
            );

            // Extract text content
            for (const content of result.contents) {
                if ("text" in content) {
                    // Create notification with the content
                    const notification: Notification = {
                        method: "notifications/resources/updated",
                        params: {
                            content: content.text,
                            uri: subscription.resourceUri,
                            timestamp: Date.now(),
                        },
                    };

                    await this.handleResourceUpdate(subscription, notification);
                }
            }

            logger.debug(`Polled resource for subscription '${subscriptionId}'`);
        } catch (error) {
            subscription.status = SubscriptionStatus.ERROR;
            subscription.lastError = error instanceof Error ? error.message : "Unknown error";
            subscription.updatedAt = Date.now();
            await this.saveSubscriptions();

            handleError(error, `Failed to poll resource for subscription '${subscriptionId}'`, {
                logLevel: "error",
            });
            throw error;
        }
    }
}
