/**
 * APNs push notification service.
 *
 * Responsibilities:
 * 1. Subscribe to kind 25000 events (encrypted config updates) p-tagging the backend
 * 2. Decrypt NIP-44 content to extract APNs device tokens
 * 3. Manage in-memory token store: Map<pubkey, Set<deviceToken>>
 * 4. Expose notifyIfNeeded() for the ask tool to trigger push notifications
 * 5. Handle token lifecycle (register, refresh, disable, invalidation)
 */

import { getNDK } from "@/nostr/ndkClient";
import { nip44Decrypt } from "@/nostr/encryption";
import { NDKKind } from "@/nostr/kinds";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import type { NDKEvent, NDKSubscription, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { APNsClient, type APNsClientConfig } from "./APNsClient";
import type { APNsPayload, APNsSendResult, ConfigUpdateContent, NotificationRequest } from "./types";

/** Minimal interface for APNs push delivery (testable). */
export interface APNsClientLike {
    send(deviceToken: string, payload: APNsPayload): Promise<APNsSendResult>;
}

const LOG_PREFIX = "[APNsService]";

export class APNsService {
    private static instance: APNsService | null = null;

    private client: APNsClientLike | null = null;
    private subscription: NDKSubscription | null = null;
    private backendSigner: NDKPrivateKeySigner | null = null;

    /** Factory for creating the APNs client. Overridable for testing. */
    createClient: (config: APNsClientConfig) => APNsClientLike = (c) => new APNsClient(c);

    /** In-memory token store: pubkey → Set<deviceToken> */
    private tokenStore = new Map<string, Set<string>>();

    private initialized = false;

    private constructor() {}

    static getInstance(): APNsService {
        if (!APNsService.instance) {
            APNsService.instance = new APNsService();
        }
        return APNsService.instance;
    }

    /**
     * Reset the singleton (for testing).
     */
    static resetInstance(): void {
        if (APNsService.instance) {
            APNsService.instance.shutdown();
        }
        APNsService.instance = null;
    }

    /**
     * Initialize the APNs service.
     *
     * - Reads APNs config from config.json
     * - Creates the APNsClient with .p8 key
     * - Subscribes to kind 25000 events for token registration
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            logger.warn(`${LOG_PREFIX} Already initialized`);
            return;
        }

        const tenexConfig = config.getConfig();
        const apnsConfig = tenexConfig.apns;

        if (!apnsConfig?.enabled) {
            logger.debug(`${LOG_PREFIX} Disabled (apns.enabled is false or not set)`);
            return;
        }

        // Validate required fields
        const { keyPath, keyId, teamId, bundleId } = apnsConfig;
        if (!keyPath || !keyId || !teamId || !bundleId) {
            logger.error(`${LOG_PREFIX} Missing required APNs config fields`, {
                hasKeyPath: !!keyPath,
                hasKeyId: !!keyId,
                hasTeamId: !!teamId,
                hasBundleId: !!bundleId,
            });
            return;
        }

        // Create the HTTP/2 client
        const clientConfig: APNsClientConfig = {
            keyPath,
            keyId,
            teamId,
            bundleId,
            production: apnsConfig.production ?? false,
        };
        this.client = this.createClient(clientConfig);

        // Get backend signer for NIP-44 decryption
        this.backendSigner = await config.getBackendSigner();
        const backendPubkey = (await this.backendSigner.user()).pubkey;

        // Subscribe to kind 25000 events addressed to the backend
        const ndk = getNDK();
        this.subscription = ndk.subscribe(
            {
                kinds: [NDKKind.TenexConfigUpdate as number],
                "#p": [backendPubkey],
            },
            { closeOnEose: false }
        );

        this.subscription.on("event", (event: NDKEvent) => {
            this.handleConfigUpdateEvent(event).catch((err) => {
                logger.error(`${LOG_PREFIX} Error handling config update event`, {
                    error: err instanceof Error ? err.message : String(err),
                    eventId: event.id?.substring(0, 8),
                });
            });
        });

        this.initialized = true;

        logger.info(`${LOG_PREFIX} Initialized`, {
            production: clientConfig.production,
            bundleId: clientConfig.bundleId,
            backendPubkey: backendPubkey.substring(0, 8),
        });
    }

    /**
     * Handle an incoming kind 25000 config update event.
     *
     * Decrypts NIP-44 content and processes APNs token registration/deregistration.
     */
    private async handleConfigUpdateEvent(event: NDKEvent): Promise<void> {
        if (!this.backendSigner) return;

        const senderPubkey = event.pubkey;

        try {
            // Decrypt NIP-44 content via nostr layer wrapper
            const decrypted = await nip44Decrypt(senderPubkey, event.content, this.backendSigner);
            const content = JSON.parse(decrypted) as ConfigUpdateContent;

            if (!content.notifications) {
                logger.debug(`${LOG_PREFIX} Config update has no notifications section, skipping`, {
                    sender: senderPubkey.substring(0, 8),
                });
                return;
            }

            const { enable, apn_token } = content.notifications;

            if (enable && apn_token) {
                // Register or refresh token
                this.addToken(senderPubkey, apn_token);
                logger.info(`${LOG_PREFIX} Registered device token`, {
                    sender: senderPubkey.substring(0, 8),
                    tokenPrefix: apn_token.substring(0, 8),
                    totalTokens: this.getTokenCount(senderPubkey),
                });
            } else if (!enable) {
                // Disable: remove all tokens for this user
                const removed = this.removeAllTokens(senderPubkey);
                logger.info(`${LOG_PREFIX} Disabled notifications for user`, {
                    sender: senderPubkey.substring(0, 8),
                    tokensRemoved: removed,
                });
            }
        } catch (error) {
            logger.error(`${LOG_PREFIX} Failed to process config update event`, {
                error: error instanceof Error ? error.message : String(error),
                sender: senderPubkey.substring(0, 8),
                eventId: event.id?.substring(0, 8),
            });
        }
    }

    /**
     * Send a push notification if the user has registered tokens.
     *
     * Called from the ask tool when the user is not connected.
     * No-ops gracefully if APNs is not configured or user has no tokens.
     */
    async notifyIfNeeded(userPubkey: string, request: NotificationRequest): Promise<void> {
        if (!this.client) return;

        const tokens = this.tokenStore.get(userPubkey);
        if (!tokens || tokens.size === 0) {
            logger.debug(`${LOG_PREFIX} No tokens for user, skipping push`, {
                user: userPubkey.substring(0, 8),
            });
            return;
        }

        const payload: APNsPayload = {
            aps: {
                alert: {
                    title: request.title,
                    body: request.body,
                },
                sound: "default",
                badge: 1,
            },
            conversationId: request.conversationId,
            eventId: request.eventId,
        };

        // Send to all registered tokens for this user
        const invalidTokens: string[] = [];

        for (const token of tokens) {
            const result = await this.client.send(token, payload);

            if (result.success) {
                logger.info(`${LOG_PREFIX} Push notification sent`, {
                    user: userPubkey.substring(0, 8),
                    tokenPrefix: token.substring(0, 8),
                });
            } else if (result.statusCode === 410 || result.reason === "BadDeviceToken" || result.reason === "Unregistered") {
                // Token is no longer valid
                invalidTokens.push(token);
                logger.warn(`${LOG_PREFIX} Removing invalid token`, {
                    user: userPubkey.substring(0, 8),
                    tokenPrefix: token.substring(0, 8),
                    reason: result.reason,
                });
            }
            // Other failures are logged by APNsClient but we don't remove the token
        }

        // Clean up invalid tokens
        for (const token of invalidTokens) {
            this.removeToken(userPubkey, token);
        }
    }

    /**
     * Check if APNs is enabled and has a client configured.
     */
    isEnabled(): boolean {
        return this.initialized && this.client !== null;
    }

    /**
     * Check if a user has any registered tokens.
     */
    hasTokens(userPubkey: string): boolean {
        const tokens = this.tokenStore.get(userPubkey);
        return tokens !== undefined && tokens.size > 0;
    }

    // =====================================================================================
    // TOKEN STORE MANAGEMENT
    // =====================================================================================

    private addToken(pubkey: string, token: string): void {
        let tokens = this.tokenStore.get(pubkey);
        if (!tokens) {
            tokens = new Set();
            this.tokenStore.set(pubkey, tokens);
        }
        tokens.add(token);
    }

    private removeToken(pubkey: string, token: string): void {
        const tokens = this.tokenStore.get(pubkey);
        if (tokens) {
            tokens.delete(token);
            if (tokens.size === 0) {
                this.tokenStore.delete(pubkey);
            }
        }
    }

    private removeAllTokens(pubkey: string): number {
        const tokens = this.tokenStore.get(pubkey);
        const count = tokens?.size ?? 0;
        this.tokenStore.delete(pubkey);
        return count;
    }

    private getTokenCount(pubkey: string): number {
        return this.tokenStore.get(pubkey)?.size ?? 0;
    }

    // =====================================================================================
    // LIFECYCLE
    // =====================================================================================

    shutdown(): void {
        if (this.subscription) {
            this.subscription.stop();
            this.subscription = null;
        }
        this.tokenStore.clear();
        this.client = null;
        this.backendSigner = null;
        this.initialized = false;

        logger.info(`${LOG_PREFIX} Shut down`);
    }
}
