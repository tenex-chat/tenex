/**
 * McpSubscriptionService - Manages MCP resource subscriptions with notification delivery
 *
 * Enables agents to subscribe to MCP resource updates within a conversation context.
 * When a notification arrives, it delivers a system-reminder message to the agent
 * in the existing conversation and triggers a new AgentExecutor run.
 *
 * Features:
 * - Persistent subscriptions across restarts (JSON file)
 * - Notification delivery as system-reminder messages
 * - Automatic re-subscription on initialization
 * - Per-conversation subscription tracking
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config } from "@/services/ConfigService";
import { getProjectContext, isProjectContextInitialized } from "@/services/projects";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";

export enum McpSubscriptionStatus {
    ACTIVE = "ACTIVE",
    ERROR = "ERROR",
    STOPPED = "STOPPED",
}

export interface McpSubscription {
    /** Unique subscription ID */
    id: string;
    /** Agent pubkey that created the subscription */
    agentPubkey: string;
    /** Agent slug for display purposes */
    agentSlug: string;
    /** MCP server name */
    serverName: string;
    /** Resource URI being subscribed to */
    resourceUri: string;
    /** Conversation ID where notifications should be delivered */
    conversationId: string;
    /** Root event ID of the conversation (for event routing) */
    rootEventId: string;
    /** Project ID (NIP-33 a-tag format) */
    projectId: string;
    /** Human-readable description */
    description: string;
    /** Current subscription status */
    status: McpSubscriptionStatus;
    /** Number of notifications received */
    notificationsReceived: number;
    /** Timestamp of last notification */
    lastNotificationAt?: number;
    /** Last error message if status is ERROR */
    lastError?: string;
    /** SHA-256 hash of the last-seen resource content (for poll-based change detection) */
    lastContentHash?: string;
    /** Creation timestamp */
    createdAt: number;
    /** Last update timestamp */
    updatedAt: number;
}

/**
 * Callback type for delivering notifications to conversations.
 * Injected by the initialization layer to avoid circular dependencies.
 */
export type NotificationDeliveryHandler = (
    subscription: McpSubscription,
    content: string
) => Promise<void>;

export class McpSubscriptionService {
    private static instance: McpSubscriptionService;
    private subscriptions: Map<string, McpSubscription> = new Map();
    private persistencePath: string;
    private isInitialized = false;
    private notificationHandler: NotificationDeliveryHandler | null = null;
    /** Per-subscription handler removal functions (returned by MCPManager.addResourceNotificationHandler) */
    private handlerRemovers: Map<string, () => void> = new Map();
    /** Ref-count of active subscriptions per "server::resource" key */
    private resourceRefCounts: Map<string, number> = new Map();
    /** Active polling timers keyed by subscription ID */
    private pollTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

    /** Default polling interval in milliseconds */
    private static readonly POLL_INTERVAL_MS = 30_000;

    private constructor() {
        const tenexDir = config.getConfigPath();
        this.persistencePath = path.join(tenexDir, "mcp_subscriptions.json");
    }

    public static getInstance(): McpSubscriptionService {
        if (!McpSubscriptionService.instance) {
            McpSubscriptionService.instance = new McpSubscriptionService();
        }
        return McpSubscriptionService.instance;
    }

    /**
     * Reset the singleton instance (for testing)
     */
    public static resetInstance(): void {
        McpSubscriptionService.instance = undefined as unknown as McpSubscriptionService;
    }

    /**
     * Set the notification delivery handler.
     * Must be called before initialize() for notifications to work.
     */
    public setNotificationHandler(handler: NotificationDeliveryHandler): void {
        this.notificationHandler = handler;
    }

    /**
     * Initialize the service and restore subscriptions from disk.
     * Re-subscribes all active subscriptions with the MCP servers.
     */
    public async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        try {
            const tenexDir = path.dirname(this.persistencePath);
            await fs.mkdir(tenexDir, { recursive: true });

            await this.loadSubscriptions();

            // Re-subscribe all active subscriptions
            for (const subscription of this.subscriptions.values()) {
                if (subscription.status === McpSubscriptionStatus.ACTIVE) {
                    try {
                        await this.setupMcpSubscription(subscription);
                    } catch (error) {
                        subscription.status = McpSubscriptionStatus.ERROR;
                        subscription.lastError = error instanceof Error ? error.message : String(error);
                        subscription.updatedAt = Date.now();
                        logger.warn(`Failed to re-establish subscription '${subscription.id}'`, {
                            error: subscription.lastError,
                        });
                    }
                }
            }

            await this.saveSubscriptions();
            this.isInitialized = true;

            logger.info(`McpSubscriptionService initialized with ${this.subscriptions.size} subscriptions`);
            trace.getActiveSpan()?.addEvent("mcp_subscription.initialized", {
                "subscriptions.count": this.subscriptions.size,
            });
        } catch (error) {
            logger.error("Failed to initialize McpSubscriptionService", { error });
            throw error;
        }
    }

    /**
     * Create a new MCP resource subscription.
     */
    public async createSubscription(params: {
        agentPubkey: string;
        agentSlug: string;
        serverName: string;
        resourceUri: string;
        conversationId: string;
        rootEventId: string;
        projectId: string;
        description: string;
    }): Promise<McpSubscription> {
        const id = this.generateSubscriptionId();

        const subscription: McpSubscription = {
            id,
            agentPubkey: params.agentPubkey,
            agentSlug: params.agentSlug,
            serverName: params.serverName,
            resourceUri: params.resourceUri,
            conversationId: params.conversationId,
            rootEventId: params.rootEventId,
            projectId: params.projectId,
            description: params.description,
            status: McpSubscriptionStatus.ACTIVE,
            notificationsReceived: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };

        // Setup MCP subscription with notification handler
        await this.setupMcpSubscription(subscription);

        this.subscriptions.set(id, subscription);
        await this.saveSubscriptions();

        logger.info(`Created MCP subscription '${id}'`, {
            agent: params.agentSlug,
            server: params.serverName,
            resource: params.resourceUri,
            conversation: params.conversationId.substring(0, 12),
        });

        trace.getActiveSpan()?.addEvent("mcp_subscription.created", {
            "subscription.id": id,
            "subscription.server": params.serverName,
            "subscription.resource": params.resourceUri,
        });

        return subscription;
    }

    /**
     * Stop and remove a subscription.
     */
    public async stopSubscription(subscriptionId: string, agentPubkey: string): Promise<boolean> {
        const subscription = this.subscriptions.get(subscriptionId);

        if (!subscription) {
            return false;
        }

        // Authorization check
        if (subscription.agentPubkey !== agentPubkey) {
            return false;
        }

        try {
            // Unsubscribe from MCP server
            await this.teardownMcpSubscription(subscription);

            // Remove from in-memory state
            this.subscriptions.delete(subscriptionId);
            await this.saveSubscriptions();

            logger.info(`Stopped MCP subscription '${subscriptionId}'`);
            trace.getActiveSpan()?.addEvent("mcp_subscription.stopped", {
                "subscription.id": subscriptionId,
            });

            return true;
        } catch (error) {
            logger.error(`Failed to stop subscription '${subscriptionId}'`, { error });
            // Still remove from our tracking even if unsubscribe fails
            this.subscriptions.delete(subscriptionId);
            await this.saveSubscriptions();
            return true;
        }
    }

    /**
     * Get all active subscriptions for an agent in a conversation.
     */
    public getSubscriptionsForAgent(
        agentPubkey: string,
        conversationId?: string
    ): McpSubscription[] {
        const results: McpSubscription[] = [];
        for (const sub of this.subscriptions.values()) {
            if (sub.agentPubkey !== agentPubkey) continue;
            if (conversationId && sub.conversationId !== conversationId) continue;
            results.push(sub);
        }
        return results;
    }

    /**
     * Get a subscription by ID.
     */
    public getSubscription(subscriptionId: string): McpSubscription | undefined {
        return this.subscriptions.get(subscriptionId);
    }

    /**
     * Check if an agent has any active subscriptions.
     */
    public hasActiveSubscriptions(agentPubkey: string): boolean {
        for (const sub of this.subscriptions.values()) {
            if (sub.agentPubkey === agentPubkey && sub.status === McpSubscriptionStatus.ACTIVE) {
                return true;
            }
        }
        return false;
    }

    /**
     * Check if an agent has any subscriptions that can be stopped (ACTIVE or ERROR).
     * Used for dynamic tool injection of mcp_subscription_stop.
     */
    public hasStoppableSubscriptions(agentPubkey: string): boolean {
        for (const sub of this.subscriptions.values()) {
            if (sub.agentPubkey !== agentPubkey) continue;
            if (sub.status === McpSubscriptionStatus.ACTIVE || sub.status === McpSubscriptionStatus.ERROR) {
                return true;
            }
        }
        return false;
    }

    /**
     * Setup MCP resource subscription and notification listener.
     * Uses dispatcher pattern for handlers (no clobbering) and ref-counting for resources.
     */
    private async setupMcpSubscription(subscription: McpSubscription): Promise<void> {
        if (!isProjectContextInitialized()) {
            throw new Error("Project context not available for MCP subscription setup");
        }

        const projectCtx = getProjectContext();
        const mcpManager = projectCtx.mcpManager;

        if (!mcpManager) {
            throw new Error("MCPManager not available in project context");
        }

        if (!mcpManager.isServerRunning(subscription.serverName)) {
            throw new Error(`MCP server '${subscription.serverName}' is not running`);
        }

        // Register per-subscription notification handler (dispatcher-safe, no clobbering)
        const removeHandler = mcpManager.addResourceNotificationHandler(
            subscription.serverName,
            async (notification: { uri: string }) => {
                if (notification.uri !== subscription.resourceUri) {
                    return;
                }
                await this.handleNotification(subscription, notification.uri);
            }
        );

        // Ref-count: only subscribe to the MCP server resource if this is the first subscription.
        const refKey = this.makeResourceRefKey(subscription.serverName, subscription.resourceUri);
        const currentCount = this.resourceRefCounts.get(refKey) ?? 0;
        if (currentCount === 0) {
            try {
                await mcpManager.subscribeToResource(subscription.serverName, subscription.resourceUri);
            } catch (error) {
                // Gracefully degrade — server may not support resource subscriptions.
                // Polling (below) will be the actual change-detection mechanism.
                logger.warn(`subscribeToResource failed for '${subscription.id}', relying on polling`, {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        this.handlerRemovers.set(subscription.id, removeHandler);
        this.resourceRefCounts.set(refKey, currentCount + 1);

        // Seed the content hash so the first poll doesn't fire a spurious notification
        await this.seedContentHash(subscription, mcpManager);

        // Start polling for resource changes
        this.startPolling(subscription);

        logger.info(`MCP subscription '${subscription.id}' active (with polling)`, {
            server: subscription.serverName,
            resource: subscription.resourceUri,
            resourceRefCount: currentCount + 1,
            pollIntervalMs: McpSubscriptionService.POLL_INTERVAL_MS,
        });
    }

    /**
     * Teardown MCP subscription.
     * Removes the per-subscription handler and decrements the resource ref-count.
     * Only unsubscribes from the MCP server when the last subscription for a resource is removed.
     */
    private async teardownMcpSubscription(subscription: McpSubscription): Promise<void> {
        // Stop polling timer
        this.stopPolling(subscription.id);

        // Remove per-subscription notification handler
        const removeHandler = this.handlerRemovers.get(subscription.id);
        const setupSucceeded = removeHandler !== undefined;
        if (removeHandler) {
            removeHandler();
            this.handlerRemovers.delete(subscription.id);
        }

        // Only decrement ref-count if setup actually succeeded (handler was registered).
        // If setupMcpSubscription failed, ref-count was never incremented, so decrementing
        // here would corrupt the count for other active subscriptions on the same resource.
        if (!setupSucceeded) {
            return;
        }

        // Decrement ref-count; only unsubscribe from MCP server when count reaches 0
        const refKey = this.makeResourceRefKey(subscription.serverName, subscription.resourceUri);
        const currentCount = this.resourceRefCounts.get(refKey) ?? 0;
        const newCount = currentCount - 1;

        if (newCount <= 0) {
            this.resourceRefCounts.delete(refKey);

            if (!isProjectContextInitialized()) {
                return;
            }

            try {
                const projectCtx = getProjectContext();
                const mcpManager = projectCtx.mcpManager;

                if (mcpManager && mcpManager.isServerRunning(subscription.serverName)) {
                    await mcpManager.unsubscribeFromResource(
                        subscription.serverName,
                        subscription.resourceUri
                    );
                }
            } catch (error) {
                logger.warn("Failed to unsubscribe from MCP resource", {
                    subscription: subscription.id,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        } else {
            this.resourceRefCounts.set(refKey, newCount);
        }
    }

    /**
     * Build a ref-count key for a server+resource pair.
     */
    private makeResourceRefKey(serverName: string, resourceUri: string): string {
        return `${serverName}::${resourceUri}`;
    }

    /**
     * Handle an MCP resource push notification.
     * Reads the updated resource content and delivers it to the conversation.
     * Guarded against missing project context (push notifications may arrive asynchronously).
     */
    private async handleNotification(subscription: McpSubscription, uri: string): Promise<void> {
        // Guard: push notifications may fire outside projectContextStore.run() scope
        if (!isProjectContextInitialized()) {
            logger.warn(`Ignoring push notification for '${subscription.id}': project context not available`);
            return;
        }

        try {
            const projectCtx = getProjectContext();
            const mcpManager = projectCtx.mcpManager;

            if (!mcpManager) {
                throw new Error("MCPManager not available");
            }

            const content = await this.readResourceContent(mcpManager, subscription.serverName, uri);

            if (!content) {
                logger.debug(`Empty notification for subscription '${subscription.id}'`);
                return;
            }

            await this.deliverNotificationContent(subscription, content);
        } catch (error) {
            subscription.status = McpSubscriptionStatus.ERROR;
            subscription.lastError = error instanceof Error ? error.message : String(error);
            subscription.updatedAt = Date.now();
            await this.saveSubscriptions();

            logger.error(`Failed to handle notification for subscription '${subscription.id}'`, {
                error: subscription.lastError,
            });
        }
    }

    /**
     * Read a resource and return its text content.
     */
    private async readResourceContent(
        mcpManager: { readResource(serverName: string, uri: string): Promise<{ contents: Array<Record<string, unknown>> }> },
        serverName: string,
        uri: string
    ): Promise<string> {
        const result = await mcpManager.readResource(serverName, uri);

        const textContents: string[] = [];
        for (const content of result.contents) {
            if ("text" in content && typeof content.text === "string") {
                textContents.push(content.text);
            } else if ("blob" in content && typeof content.blob === "string") {
                textContents.push(`[Binary content: ${content.blob.length} bytes]`);
            }
        }

        return textContents.join("\n\n");
    }

    /**
     * Deliver notification content to the conversation.
     * Updates subscription metrics and calls the registered notification handler.
     */
    private async deliverNotificationContent(
        subscription: McpSubscription,
        content: string
    ): Promise<void> {
        // Update metrics and recover from ERROR state on successful delivery
        subscription.notificationsReceived++;
        subscription.lastNotificationAt = Date.now();
        subscription.updatedAt = Date.now();
        if (subscription.status === McpSubscriptionStatus.ERROR) {
            subscription.status = McpSubscriptionStatus.ACTIVE;
            subscription.lastError = undefined;
            logger.info(`Subscription '${subscription.id}' recovered from ERROR to ACTIVE`);
        }
        await this.saveSubscriptions();

        // Deliver notification to conversation
        if (this.notificationHandler) {
            await this.notificationHandler(subscription, content);
        } else {
            logger.warn(`No notification handler registered for subscription '${subscription.id}'`);
        }

        logger.debug(`Delivered notification for subscription '${subscription.id}'`, {
            notificationsTotal: subscription.notificationsReceived,
            contentLength: content.length,
        });

        trace.getActiveSpan()?.addEvent("mcp_subscription.notification_delivered", {
            "subscription.id": subscription.id,
            "notification.content_length": content.length,
            "notification.total": subscription.notificationsReceived,
        });
    }

    // ========== Polling ==========

    /**
     * Seed the content hash for a new subscription by reading the current resource.
     * Prevents the first poll from triggering a spurious notification.
     */
    private async seedContentHash(
        subscription: McpSubscription,
        mcpManager: { readResource(serverName: string, uri: string): Promise<{ contents: Array<Record<string, unknown>> }> }
    ): Promise<void> {
        try {
            const content = await this.readResourceContent(
                mcpManager,
                subscription.serverName,
                subscription.resourceUri
            );
            if (content) {
                subscription.lastContentHash = createHash("sha256").update(content).digest("hex");
            }
        } catch (error) {
            logger.debug(`Failed to seed content hash for subscription '${subscription.id}'`, {
                error: error instanceof Error ? error.message : String(error),
            });
            // Non-fatal: first poll will simply trigger a notification
        }
    }

    /**
     * Start periodic polling for a subscription.
     */
    private startPolling(subscription: McpSubscription): void {
        // Clear any existing timer for this subscription
        this.stopPolling(subscription.id);

        const timer = setInterval(
            () => void this.pollSubscription(subscription),
            McpSubscriptionService.POLL_INTERVAL_MS
        );

        // Allow the Node.js process to exit even if timers are still active
        timer.unref();

        this.pollTimers.set(subscription.id, timer);
    }

    /**
     * Stop polling for a subscription.
     */
    private stopPolling(subscriptionId: string): void {
        const timer = this.pollTimers.get(subscriptionId);
        if (timer) {
            clearInterval(timer);
            this.pollTimers.delete(subscriptionId);
        }
    }

    /**
     * Poll a single subscription: read the resource, compare hash, deliver if changed.
     */
    private async pollSubscription(subscription: McpSubscription): Promise<void> {
        if (subscription.status !== McpSubscriptionStatus.ACTIVE) {
            return;
        }

        if (!isProjectContextInitialized()) {
            return;
        }

        try {
            const projectCtx = getProjectContext();
            const mcpManager = projectCtx.mcpManager;

            if (!mcpManager || !mcpManager.isServerRunning(subscription.serverName)) {
                return;
            }

            const content = await this.readResourceContent(
                mcpManager,
                subscription.serverName,
                subscription.resourceUri
            );

            if (!content) {
                return;
            }

            const contentHash = createHash("sha256").update(content).digest("hex");

            // No change since last read
            if (subscription.lastContentHash === contentHash) {
                return;
            }

            // Content changed — update hash and deliver
            subscription.lastContentHash = contentHash;
            subscription.updatedAt = Date.now();
            await this.saveSubscriptions();

            logger.info(`Poll detected change for subscription '${subscription.id}'`, {
                server: subscription.serverName,
                resource: subscription.resourceUri,
            });

            await this.deliverNotificationContent(subscription, content);
        } catch (error) {
            logger.warn(`Poll failed for subscription '${subscription.id}'`, {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    // ========== Persistence ==========

    private async loadSubscriptions(): Promise<void> {
        try {
            const data = await fs.readFile(this.persistencePath, "utf-8");
            const subscriptions = JSON.parse(data) as McpSubscription[];

            for (const sub of subscriptions) {
                this.subscriptions.set(sub.id, sub);
            }

            logger.debug(`Loaded ${subscriptions.length} MCP subscriptions from disk`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                logger.error("Failed to load MCP subscriptions", { error });
            }
        }
    }

    private async saveSubscriptions(): Promise<void> {
        try {
            const subscriptions = Array.from(this.subscriptions.values());
            await fs.writeFile(this.persistencePath, JSON.stringify(subscriptions, null, 2));
        } catch (error) {
            logger.error("Failed to save MCP subscriptions", { error });
        }
    }

    private generateSubscriptionId(): string {
        return `mcp-sub-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    }

    /**
     * Shutdown all active subscriptions.
     */
    public async shutdown(): Promise<void> {
        // Stop all polling timers first (collect keys to avoid mutation during iteration)
        for (const subscriptionId of [...this.pollTimers.keys()]) {
            this.stopPolling(subscriptionId);
        }

        for (const subscription of this.subscriptions.values()) {
            if (subscription.status === McpSubscriptionStatus.ACTIVE) {
                await this.teardownMcpSubscription(subscription);
            }
        }

        logger.info("McpSubscriptionService shutdown complete");
    }
}
