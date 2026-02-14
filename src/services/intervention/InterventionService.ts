import * as fs from "node:fs/promises";
import * as path from "node:path";
import { InterventionPublisher } from "@/nostr/InterventionPublisher";
import { resolveAgentSlug } from "@/services/agents/AgentResolution";
import { config } from "@/services/ConfigService";
import { getTrustPubkeyService } from "@/services/trust-pubkeys/TrustPubkeyService";
import { logger } from "@/utils/logger";
import { trace } from "@opentelemetry/api";

/** Default timeout for user response: 5 minutes */
const DEFAULT_TIMEOUT_MS = 300_000;

/** Default conversation inactivity timeout: 2 minutes (in seconds) */
const DEFAULT_CONVERSATION_INACTIVITY_TIMEOUT_SECONDS = 120;

/** Default retry interval for failed publish attempts: 30 seconds */
const DEFAULT_RETRY_INTERVAL_MS = 30_000;

/** Maximum retry attempts before giving up */
const MAX_RETRY_ATTEMPTS = 5;

/**
 * Represents a pending intervention - an agent completed work
 * and we're waiting for the user to respond.
 */
export interface PendingIntervention {
    conversationId: string;
    completedAt: number; // timestamp of completion event (ms)
    agentPubkey: string; // completing agent
    userPubkey: string; // root event author (who we're waiting on)
    projectId: string; // for state scoping (replaces projectPubkey)
    retryCount?: number; // number of retry attempts for failed publishes
}

/**
 * Persisted state for InterventionService.
 * Stored in ~/.tenex/intervention_state_<projectId>.json (project-scoped)
 */
interface InterventionState {
    pending: PendingIntervention[];
}

/**
 * Pending state write operation for serialization
 */
interface WriteOperation {
    resolve: () => void;
    reject: (error: Error) => void;
}

/**
 * InterventionService monitors for agent work completions and triggers
 * a human-replica review if the user doesn't respond within the configured timeout.
 *
 * Completion detection:
 * - An event is considered a "completion" when a kind:1 event from an agent
 *   p-tags the user who authored the root event of the conversation.
 *
 * User response detection:
 * - Only counts if the response is AFTER the completion timestamp.
 * - Cancels the pending intervention timer.
 *
 * When timeout expires:
 * - Publishes a review request event to the configured intervention agent.
 */
export class InterventionService {
    private static instance: InterventionService | null = null;

    private publisher: InterventionPublisher;
    private pendingInterventions: Map<string, PendingIntervention> = new Map();
    private timers: Map<string, NodeJS.Timeout> = new Map();
    private configDir: string;
    private currentProjectId: string | null = null;

    // Lazy agent resolution - store slug and resolve on-demand
    private interventionAgentSlug: string | null = null;
    private interventionAgentPubkey: string | null = null;
    private agentResolutionAttempted = false;

    private timeoutMs: number = DEFAULT_TIMEOUT_MS;
    private conversationInactivityTimeoutSeconds: number = DEFAULT_CONVERSATION_INACTIVITY_TIMEOUT_SECONDS;
    private enabled = false;
    private initialized = false;

    // Serialized write queue for state persistence
    private writeQueue: WriteOperation[] = [];
    private isWriting = false;

    // Guards against loadState() racing with onAgentCompletion()
    private stateLoadPromise: Promise<void> | null = null;
    // Pending completion operations queued during state load
    private pendingCompletionOps: Array<() => void> = [];

    private constructor() {
        this.publisher = new InterventionPublisher();
        this.configDir = config.getConfigPath();
    }

    /**
     * Get the state file path for a given project.
     * State files are scoped by project ID.
     */
    private getStateFilePath(projectId: string): string {
        return path.join(this.configDir, `intervention_state_${projectId}.json`);
    }

    /**
     * Get the singleton instance of InterventionService.
     */
    public static getInstance(): InterventionService {
        if (!InterventionService.instance) {
            InterventionService.instance = new InterventionService();
        }
        return InterventionService.instance;
    }

    /**
     * Reset the singleton instance (useful for testing).
     */
    public static async resetInstance(): Promise<void> {
        if (InterventionService.instance) {
            await InterventionService.instance.shutdown();
        }
        InterventionService.instance = null;
    }

    /**
     * Initialize the service.
     * - Loads configuration
     * - Stores the agent slug for lazy resolution (resolved on first completion event)
     * - Note: State loading is deferred until setProject() is called
     */
    public async initialize(): Promise<void> {
        if (this.initialized) {
            logger.warn("InterventionService already initialized");
            return;
        }

        const tenexConfig = config.getConfig();
        const interventionConfig = tenexConfig.intervention;

        // Check if intervention is enabled
        if (!interventionConfig?.enabled) {
            logger.debug("InterventionService disabled (intervention.enabled is false or not set)");
            this.enabled = false;
            this.initialized = true;
            return;
        }

        // Agent slug is required if enabled
        const agentSlug = interventionConfig.agent;
        if (!agentSlug) {
            logger.error("InterventionService enabled but no agent slug configured (intervention.agent)");
            this.enabled = false;
            this.initialized = true;
            return;
        }

        // Store the slug for lazy resolution (don't resolve yet - ProjectContext may not exist)
        this.interventionAgentSlug = agentSlug;
        this.timeoutMs = interventionConfig.timeout ?? DEFAULT_TIMEOUT_MS;

        // Clamp negative values to 0 and warn
        const rawInactivityTimeout = interventionConfig.conversationInactivityTimeoutSeconds ?? DEFAULT_CONVERSATION_INACTIVITY_TIMEOUT_SECONDS;
        if (rawInactivityTimeout < 0) {
            logger.warn("InterventionService: conversationInactivityTimeoutSeconds is negative, clamping to 0", {
                configuredValue: rawInactivityTimeout,
            });
            this.conversationInactivityTimeoutSeconds = 0;
        } else {
            this.conversationInactivityTimeoutSeconds = rawInactivityTimeout;
        }
        this.enabled = true;

        // Initialize the publisher
        await this.publisher.initialize();

        // Ensure config directory exists
        await fs.mkdir(this.configDir, { recursive: true });

        this.initialized = true;

        logger.info("InterventionService initialized (agent resolution deferred)", {
            agentSlug,
            timeoutMs: this.timeoutMs,
            conversationInactivityTimeoutSeconds: this.conversationInactivityTimeoutSeconds,
        });

        trace.getActiveSpan()?.addEvent("intervention.service_initialized", {
            "intervention.agent_slug": agentSlug,
            "intervention.timeout_ms": this.timeoutMs,
            "intervention.conversation_inactivity_timeout_seconds": this.conversationInactivityTimeoutSeconds,
            "intervention.resolution_deferred": true,
        });
    }

    /**
     * Set the current project and load its state.
     * Must be called before the service will process events.
     * This is called when a project context becomes available.
     */
    public async setProject(projectId: string): Promise<void> {
        if (!this.enabled) {
            return;
        }

        // If switching projects, save current state first
        if (this.currentProjectId && this.currentProjectId !== projectId) {
            await this.flushWriteQueue();
        }

        if (this.currentProjectId === projectId) {
            if (this.stateLoadPromise) {
                await this.stateLoadPromise;
            }

            logger.debug("InterventionService project set", {
                projectId: projectId.substring(0, 12),
                pendingCount: this.pendingInterventions.size,
            });
            return;
        }

        this.currentProjectId = projectId;
        this.beginStateLoad(projectId);
        if (this.stateLoadPromise) {
            await this.stateLoadPromise;
        }

        logger.debug("InterventionService project set", {
            projectId: projectId.substring(0, 12),
            pendingCount: this.pendingInterventions.size,
        });
    }

    /**
     * Begin loading project state if no load is already in progress.
     * Ensures queued completion operations are flushed after load completes.
     */
    private beginStateLoad(projectId: string): void {
        if (this.stateLoadPromise) {
            return;
        }

        this.stateLoadPromise = this.loadState(projectId)
            .then(() => {
                this.setupCatchUpTimers();
                this.flushPendingCompletionOps();
            })
            .finally(() => {
                this.stateLoadPromise = null;
            });
    }

    /**
     * Lazily resolve the agent slug to a pubkey.
     * Called on first completion event when ProjectContext is available.
     * Returns null if resolution fails, and caches the result.
     */
    private resolveAgentPubkeyLazy(): string | null {
        // Return cached value if already resolved
        if (this.interventionAgentPubkey) {
            return this.interventionAgentPubkey;
        }

        // Don't retry if we already attempted and failed
        if (this.agentResolutionAttempted) {
            return null;
        }

        if (!this.interventionAgentSlug) {
            return null;
        }

        this.agentResolutionAttempted = true;

        try {
            const resolution = resolveAgentSlug(this.interventionAgentSlug);
            if (!resolution.pubkey) {
                logger.error("InterventionService: configured agent slug not found", {
                    slug: this.interventionAgentSlug,
                    availableSlugs: resolution.availableSlugs,
                });
                // Disable the service since we can't resolve the agent
                this.enabled = false;
                return null;
            }

            this.interventionAgentPubkey = resolution.pubkey;
            logger.info("InterventionService: agent resolved on first completion", {
                slug: this.interventionAgentSlug,
                pubkey: this.interventionAgentPubkey.substring(0, 8),
            });

            return this.interventionAgentPubkey;
        } catch (error) {
            logger.error("InterventionService: failed to resolve agent slug", {
                slug: this.interventionAgentSlug,
                error,
            });
            this.enabled = false;
            return null;
        }
    }

    /**
     * Check if the service is enabled and ready.
     */
    public isEnabled(): boolean {
        return this.enabled && this.initialized;
    }

    /**
     * Called when an agent completes work on a conversation.
     *
     * Completion is detected when:
     * - Event is kind:1
     * - Event author is an agent (not a whitelisted user)
     * - Event p-tags a whitelisted pubkey
     * - That whitelisted pubkey is the author of the root event
     *
     * If the user was recently active in the conversation (within conversationInactivityTimeoutSeconds),
     * the intervention is skipped entirely. This prevents interventions when the user is
     * actively engaged in the conversation.
     *
     * @param conversationId - The conversation ID
     * @param completedAt - Timestamp of the completion event (ms)
     * @param agentPubkey - Pubkey of the completing agent
     * @param userPubkey - Pubkey of the root event author
     * @param projectId - Project ID for state scoping
     * @param lastUserMessageTime - Timestamp of the last user message in the conversation (ms, optional)
     */
    public onAgentCompletion(
        conversationId: string,
        completedAt: number,
        agentPubkey: string,
        userPubkey: string,
        projectId: string,
        lastUserMessageTime?: number
    ): void {
        if (!this.isEnabled()) {
            return;
        }

        // Lazy resolution: resolve agent pubkey on first completion event
        // This is when ProjectContext should be available
        const resolvedPubkey = this.resolveAgentPubkeyLazy();
        if (!resolvedPubkey) {
            // Resolution failed, service is now disabled
            logger.warn("InterventionService: skipping completion, agent resolution failed");
            return;
        }

        // CRITICAL: Only trigger interventions for whitelisted user pubkeys
        // Skip if the "user" is actually an agent (agent-to-agent completion)
        const trustService = getTrustPubkeyService();
        const trustResult = trustService.isTrustedSync(userPubkey);

        if (!trustResult.trusted || trustResult.reason !== "whitelisted") {
            // The "user" is not a whitelisted human user - it's an agent or unknown
            logger.debug("InterventionService: skipping intervention, user is not whitelisted", {
                conversationId: conversationId.substring(0, 12),
                userPubkey: userPubkey.substring(0, 8),
                trustReason: trustResult.reason ?? "not-trusted",
            });

            trace.getActiveSpan()?.addEvent("intervention.skipped_not_whitelisted_user", {
                "conversation.id": conversationId,
                "user.pubkey": userPubkey.substring(0, 8),
                "trust.reason": trustResult.reason ?? "not-trusted",
            });

            return;
        }

        // Check conversation inactivity: if user was recently active, skip intervention
        if (lastUserMessageTime !== undefined && this.conversationInactivityTimeoutSeconds > 0) {
            const timeSinceLastUserMessageMs = completedAt - lastUserMessageTime;
            const thresholdMs = this.conversationInactivityTimeoutSeconds * 1000;

            if (timeSinceLastUserMessageMs < thresholdMs) {
                logger.debug("InterventionService: skipping intervention, user was recently active", {
                    conversationId: conversationId.substring(0, 12),
                    timeSinceLastUserMessageMs,
                    thresholdMs,
                    lastUserMessageTime,
                    completedAt,
                });

                trace.getActiveSpan()?.addEvent("intervention.skipped_recent_user_activity", {
                    "conversation.id": conversationId,
                    "time_since_last_user_message_ms": timeSinceLastUserMessageMs,
                    "threshold_ms": thresholdMs,
                });

                return;
            }
        }

        // Ensure project is set
        if (!this.currentProjectId) {
            this.currentProjectId = projectId;
            // Note: setProject() should have been called first in normal operation.
            // If we reach here, load state and queue this completion to run after.
            this.beginStateLoad(projectId);
        } else if (this.currentProjectId !== projectId) {
            // Different project - this shouldn't happen in normal operation
            logger.warn("InterventionService: completion from different project", {
                expected: this.currentProjectId.substring(0, 12),
                actual: projectId.substring(0, 12),
            });
        }

        // If state is still loading, queue this operation to run after
        if (this.stateLoadPromise) {
            this.pendingCompletionOps.push(() => {
                this.addPendingIntervention(conversationId, completedAt, agentPubkey, userPubkey, projectId);
            });
            return;
        }

        this.addPendingIntervention(conversationId, completedAt, agentPubkey, userPubkey, projectId);
    }

    /**
     * Add a pending intervention entry.
     * Extracted to support queuing during state load.
     */
    private addPendingIntervention(
        conversationId: string,
        completedAt: number,
        agentPubkey: string,
        userPubkey: string,
        projectId: string
    ): void {
        // Check if we already have a pending intervention for this conversation
        const existing = this.pendingInterventions.get(conversationId);
        if (existing) {
            logger.debug("Updating existing pending intervention", {
                conversationId: conversationId.substring(0, 12),
                previousCompletedAt: existing.completedAt,
                newCompletedAt: completedAt,
            });
            // Clear the old timer
            this.clearTimer(conversationId);
        }

        const pending: PendingIntervention = {
            conversationId,
            completedAt,
            agentPubkey,
            userPubkey,
            projectId,
            retryCount: 0,
        };

        this.pendingInterventions.set(conversationId, pending);
        this.startTimer(pending);
        this.saveState();

        logger.info("Agent completion detected, starting intervention timer", {
            conversationId: conversationId.substring(0, 12),
            agentPubkey: agentPubkey.substring(0, 8),
            userPubkey: userPubkey.substring(0, 8),
            timeoutMs: this.timeoutMs,
        });

        trace.getActiveSpan()?.addEvent("intervention.timer_started", {
            "conversation.id": conversationId,
            "agent.pubkey": agentPubkey.substring(0, 8),
            "user.pubkey": userPubkey.substring(0, 8),
            "timeout.ms": this.timeoutMs,
        });
    }

    /**
     * Flush queued completion operations after state load completes.
     */
    private flushPendingCompletionOps(): void {
        const ops = this.pendingCompletionOps;
        this.pendingCompletionOps = [];
        for (const op of ops) {
            op();
        }
    }

    /**
     * Called when a user responds in a conversation.
     *
     * Only cancels the timer if:
     * 1. The response is AFTER the completion timestamp
     * 2. The response is BEFORE the timeout window expires
     *
     * This prevents event loop delays from allowing late responses to cancel timers.
     *
     * @param conversationId - The conversation ID
     * @param responseAt - Timestamp of the user response (ms)
     * @param userPubkey - Pubkey of the responding user
     */
    public onUserResponse(
        conversationId: string,
        responseAt: number,
        userPubkey: string
    ): void {
        if (!this.isEnabled()) {
            return;
        }

        const pending = this.pendingInterventions.get(conversationId);
        if (!pending) {
            // No pending intervention for this conversation
            return;
        }

        // Only cancel if response is AFTER completion
        if (responseAt <= pending.completedAt) {
            logger.debug("User response before completion, not cancelling timer", {
                conversationId: conversationId.substring(0, 12),
                responseAt,
                completedAt: pending.completedAt,
            });
            return;
        }

        // Verify response is strictly BEFORE the timeout window expires
        // Responses at exactly completedAt + timeoutMs do NOT cancel (strict "before" semantics)
        const timeoutExpiry = pending.completedAt + this.timeoutMs;
        if (responseAt >= timeoutExpiry) {
            logger.debug("User response at or after timeout window, not cancelling timer", {
                conversationId: conversationId.substring(0, 12),
                responseAt,
                timeoutExpiry,
                delayMs: responseAt - timeoutExpiry,
            });
            return;
        }

        // Verify it's the same user we're waiting on
        if (userPubkey !== pending.userPubkey) {
            logger.debug("Response from different user, not cancelling timer", {
                conversationId: conversationId.substring(0, 12),
                responsePubkey: userPubkey.substring(0, 8),
                expectedPubkey: pending.userPubkey.substring(0, 8),
            });
            return;
        }

        // Cancel the timer - user responded within the timeout window
        this.clearTimer(conversationId);
        this.pendingInterventions.delete(conversationId);
        this.saveState();

        logger.info("User responded, cancelled intervention timer", {
            conversationId: conversationId.substring(0, 12),
            userPubkey: userPubkey.substring(0, 8),
            responseDelayMs: responseAt - pending.completedAt,
        });

        trace.getActiveSpan()?.addEvent("intervention.timer_cancelled", {
            "conversation.id": conversationId,
            "user.pubkey": userPubkey.substring(0, 8),
            "response.delay_ms": responseAt - pending.completedAt,
        });
    }

    /**
     * Trigger an intervention for a pending conversation.
     * Called when the timer expires.
     * Includes retry logic with exponential backoff on publish failure.
     */
    private async triggerIntervention(pending: PendingIntervention): Promise<void> {
        if (!this.interventionAgentPubkey) {
            logger.error("Cannot trigger intervention: no agent pubkey configured");
            return;
        }

        const retryCount = pending.retryCount ?? 0;

        logger.info("Triggering intervention review", {
            conversationId: pending.conversationId.substring(0, 12),
            userPubkey: pending.userPubkey.substring(0, 8),
            agentPubkey: pending.agentPubkey.substring(0, 8),
            timeElapsedMs: Date.now() - pending.completedAt,
            retryCount,
        });

        trace.getActiveSpan()?.addEvent("intervention.triggered", {
            "conversation.id": pending.conversationId,
            "user.pubkey": pending.userPubkey.substring(0, 8),
            "agent.pubkey": pending.agentPubkey.substring(0, 8),
            "time_elapsed_ms": Date.now() - pending.completedAt,
            "retry_count": retryCount,
        });

        try {
            const eventId = await this.publisher.publishReviewRequest(
                this.interventionAgentPubkey,
                pending.conversationId,
                pending.userPubkey,
                pending.agentPubkey
            );

            logger.info("Intervention review request published", {
                eventId: eventId.substring(0, 8),
                conversationId: pending.conversationId.substring(0, 12),
            });

            // Remove from pending after successful publish
            this.pendingInterventions.delete(pending.conversationId);
            this.saveState();
        } catch (error) {
            logger.error("Failed to publish intervention review request", {
                error,
                conversationId: pending.conversationId.substring(0, 12),
                retryCount,
            });

            // Retry logic with backoff
            if (retryCount < MAX_RETRY_ATTEMPTS) {
                // Update retry count
                pending.retryCount = retryCount + 1;
                this.pendingInterventions.set(pending.conversationId, pending);
                this.saveState();

                // Re-arm timer with exponential backoff
                const backoffMs = DEFAULT_RETRY_INTERVAL_MS * Math.pow(2, retryCount);
                this.scheduleRetry(pending, backoffMs);

                logger.info("Scheduled retry for failed intervention", {
                    conversationId: pending.conversationId.substring(0, 12),
                    retryCount: pending.retryCount,
                    nextRetryMs: backoffMs,
                });
            } else {
                logger.error("Max retry attempts reached for intervention", {
                    conversationId: pending.conversationId.substring(0, 12),
                    maxRetries: MAX_RETRY_ATTEMPTS,
                });
                // Remove from pending - we've exhausted retries
                this.pendingInterventions.delete(pending.conversationId);
                this.saveState();
            }
        }
    }

    /**
     * Schedule a retry for a failed intervention publish.
     */
    private scheduleRetry(pending: PendingIntervention, delayMs: number): void {
        const timer = setTimeout(() => {
            this.timers.delete(pending.conversationId);
            this.triggerIntervention(pending);
        }, delayMs);

        this.timers.set(pending.conversationId, timer);

        logger.debug("Intervention retry scheduled", {
            conversationId: pending.conversationId.substring(0, 12),
            delayMs,
        });
    }

    /**
     * Start a timer for a pending intervention.
     */
    private startTimer(pending: PendingIntervention): void {
        const now = Date.now();
        const elapsed = now - pending.completedAt;
        const remaining = Math.max(0, this.timeoutMs - elapsed);

        if (remaining === 0) {
            // Timer already expired, trigger immediately
            this.triggerIntervention(pending);
            return;
        }

        const timer = setTimeout(() => {
            this.timers.delete(pending.conversationId);
            this.triggerIntervention(pending);
        }, remaining);

        this.timers.set(pending.conversationId, timer);

        logger.debug("Intervention timer started", {
            conversationId: pending.conversationId.substring(0, 12),
            remainingMs: remaining,
        });
    }

    /**
     * Clear a timer for a conversation.
     */
    private clearTimer(conversationId: string): void {
        const timer = this.timers.get(conversationId);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(conversationId);
        }
    }

    /**
     * Setup catch-up timers for pending interventions loaded from state.
     */
    private setupCatchUpTimers(): void {
        for (const pending of this.pendingInterventions.values()) {
            this.startTimer(pending);
        }
    }

    /**
     * Load persisted state from disk for the given project.
     */
    private async loadState(projectId: string): Promise<void> {
        const stateFilePath = this.getStateFilePath(projectId);

        try {
            const data = await fs.readFile(stateFilePath, "utf-8");
            const state = JSON.parse(data) as InterventionState;

            // Clear existing pending interventions (for project switch)
            this.pendingInterventions.clear();

            for (const pending of state.pending) {
                // Migrate old projectPubkey field to projectId if present
                if ("projectPubkey" in pending && !pending.projectId) {
                    (pending as PendingIntervention).projectId = projectId;
                }
                this.pendingInterventions.set(pending.conversationId, pending);
            }

            logger.debug("Loaded intervention state", {
                projectId: projectId.substring(0, 12),
                pendingCount: this.pendingInterventions.size,
            });

            trace.getActiveSpan()?.addEvent("intervention.state_loaded", {
                "intervention.project_id": projectId.substring(0, 12),
                "intervention.pending_count": this.pendingInterventions.size,
            });
        } catch (error: unknown) {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
                // No existing file, starting fresh - this is expected
                logger.debug("No existing intervention state file, starting fresh", {
                    projectId: projectId.substring(0, 12),
                });
            } else {
                logger.error("Failed to load intervention state:", error);
            }
        }
    }

    /**
     * Save state to disk atomically using a write queue.
     * Writes are serialized to prevent race conditions from back-to-back saves.
     */
    private saveState(): void {
        if (!this.currentProjectId) {
            logger.warn("Cannot save state: no project ID set");
            return;
        }

        // Queue the write operation (we don't await it - fire-and-forget for normal operation)
        this.writeQueue.push({
            resolve: () => { /* resolved when write completes */ },
            reject: () => { /* errors are logged in processWriteQueue */ },
        });

        // Start processing if not already
        if (!this.isWriting) {
            this.processWriteQueue();
        }
    }

    /**
     * Process the write queue, serializing all state writes.
     */
    private async processWriteQueue(): Promise<void> {
        if (this.isWriting || this.writeQueue.length === 0) {
            return;
        }

        this.isWriting = true;

        while (this.writeQueue.length > 0) {
            // Take all pending operations and coalesce them into one write
            const operations = [...this.writeQueue];
            this.writeQueue = [];

            try {
                await this.writeStateAtomically();

                // Resolve all coalesced operations
                for (const op of operations) {
                    op.resolve();
                }
            } catch (error) {
                // Reject all coalesced operations
                for (const op of operations) {
                    op.reject(error instanceof Error ? error : new Error(String(error)));
                }
            }
        }

        this.isWriting = false;
    }

    /**
     * Atomically write state to disk using temp file and rename.
     */
    private async writeStateAtomically(): Promise<void> {
        if (!this.currentProjectId) {
            return;
        }

        const stateFilePath = this.getStateFilePath(this.currentProjectId);
        const tempFilePath = `${stateFilePath}.tmp.${Date.now()}`;

        try {
            const state: InterventionState = {
                pending: Array.from(this.pendingInterventions.values()),
            };

            // Ensure directory exists before writing
            try {
                await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
            } catch (mkdirError: unknown) {
                // Directory may have been deleted (e.g., during test cleanup)
                if (mkdirError && typeof mkdirError === "object" && "code" in mkdirError) {
                    const code = (mkdirError as { code: string }).code;
                    if (code === "ENOENT" || code === "EINVAL") {
                        logger.debug("State directory unavailable, skipping write");
                        return;
                    }
                }
                throw mkdirError;
            }

            // Write to temp file first
            await fs.writeFile(tempFilePath, JSON.stringify(state, null, 2));

            // Atomic rename
            await fs.rename(tempFilePath, stateFilePath);

            logger.debug("Saved intervention state atomically", {
                projectId: this.currentProjectId.substring(0, 12),
                pendingCount: state.pending.length,
            });
        } catch (error: unknown) {
            // If directory was deleted during write, log and continue
            if (error && typeof error === "object" && "code" in error) {
                const code = (error as { code: string }).code;
                if (code === "ENOENT" || code === "EINVAL") {
                    logger.debug("State write failed (directory unavailable), skipping");
                    return;
                }
            }

            logger.error("Failed to save intervention state:", error);

            // Clean up temp file if it exists
            try {
                await fs.unlink(tempFilePath);
            } catch {
                // Ignore cleanup errors
            }

            throw error;
        }
    }

    /**
     * Flush the write queue, waiting for all pending writes to complete.
     * Useful for shutdown and project switch.
     */
    private async flushWriteQueue(): Promise<void> {
        // Force a final write if there's any pending data
        if (this.pendingInterventions.size > 0 && this.currentProjectId) {
            await this.writeStateAtomically();
        }

        // Wait for queue to drain
        while (this.writeQueue.length > 0 || this.isWriting) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    /**
     * Shutdown the service.
     * - Clears all timers
     * - Flushes pending state writes
     */
    public async shutdown(): Promise<void> {
        logger.info("InterventionService shutting down", {
            pendingCount: this.pendingInterventions.size,
            timerCount: this.timers.size,
        });

        trace.getActiveSpan()?.addEvent("intervention.shutting_down", {
            "intervention.pending_count": this.pendingInterventions.size,
            "intervention.timer_count": this.timers.size,
        });

        // Clear all timers
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();

        // Flush pending state writes
        try {
            await this.flushWriteQueue();
        } catch (error) {
            logger.error("Failed to flush state on shutdown:", error);
        }

        this.initialized = false;
        this.enabled = false;

        trace.getActiveSpan()?.addEvent("intervention.shutdown_complete");
    }

    /**
     * Get pending interventions count (for diagnostics).
     */
    public getPendingCount(): number {
        return this.pendingInterventions.size;
    }

    /**
     * Get a pending intervention by conversation ID (for testing).
     */
    public getPending(conversationId: string): PendingIntervention | undefined {
        return this.pendingInterventions.get(conversationId);
    }

    /**
     * Get the current timeout value in milliseconds (for testing).
     */
    public getTimeoutMs(): number {
        return this.timeoutMs;
    }

    /**
     * Get the conversation inactivity timeout in seconds (for testing).
     */
    public getConversationInactivityTimeoutSeconds(): number {
        return this.conversationInactivityTimeoutSeconds;
    }

    /**
     * Get the current project ID (for testing).
     */
    public getCurrentProjectId(): string | null {
        return this.currentProjectId;
    }

    /**
     * Force agent resolution for testing purposes.
     * This bypasses the lazy resolution and allows tests to verify resolution logic.
     */
    public forceAgentResolution(): string | null {
        return this.resolveAgentPubkeyLazy();
    }

    /**
     * Wait for all pending writes to complete (for testing).
     */
    public async waitForWrites(): Promise<void> {
        await this.flushWriteQueue();
    }

    /**
     * Wait for pending state load and queued operations to complete (for testing).
     * This ensures all deferred completion operations have been processed.
     */
    public async waitForPendingOps(): Promise<void> {
        if (this.stateLoadPromise) {
            await this.stateLoadPromise;
        }
        // Give microtasks a chance to flush
        await Promise.resolve();
    }
}
