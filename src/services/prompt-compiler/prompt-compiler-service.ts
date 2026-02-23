/**
 * Prompt Compiler Service (TIN-10)
 *
 * Compiles agent lessons with user comments into Effective Agent Instructions.
 * Uses LLM to intelligently merge:
 * - Base Agent Instructions (from agent.instructions in Kind 4199 event)
 * - Lessons (retrieved from ProjectContext, tagging the Agent Definition Event)
 * - Comments on Lesson Events
 * - Optional additionalSystemPrompt
 *
 * Terminology:
 * - Base Agent Instructions: Raw instructions stored in the agent definition Nostr event (Kind 4199)
 * - Effective Agent Instructions: Final compiled instructions = Base + Lessons + Comments
 *
 * Key behaviors:
 * - Retrieves lessons internally from ProjectContext (not passed as parameter)
 * - Uses generateText (not generateObject) for natural prompt integration
 * - Returns only the Effective Agent Instructions string (not a structured object)
 * - On LLM failure: throws error (consumer handles fallback)
 * - Cache hash (cacheInputsHash) includes: agentDefinitionEventId (nullable), baseAgentInstructions, additionalSystemPrompt
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { NDKEvent, NDKSubscription, Hexpubkey } from "@nostr-dev-kit/ndk";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKKind } from "@/nostr/kinds";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { AgentProfilePublisher } from "@/nostr/AgentProfilePublisher";
import { config } from "@/services/ConfigService";
import { llmServiceFactory } from "@/llm";
import { logger } from "@/utils/logger";
import { trace, SpanStatusCode } from "@opentelemetry/api";

// =====================================================================================
// TYPES
// =====================================================================================

/**
 * A comment on a lesson (kind 1111 event per NIP-22)
 */
export interface LessonComment {
    /** The comment event ID */
    id: string;
    /** Author pubkey */
    pubkey: Hexpubkey;
    /** Comment content */
    content: string;
    /** The lesson event ID this comment references */
    lessonEventId: string;
    /** Unix timestamp */
    createdAt: number;
}

/**
 * Cache entry for Effective Agent Instructions
 */
export interface EffectiveInstructionsCacheEntry {
    /** The Effective Agent Instructions (compiled result) */
    effectiveAgentInstructions: string;
    /** When the cache was written (Unix timestamp) */
    timestamp: number;
    /** max(created_at) of lessons AND comments used */
    maxCreatedAt: number;
    /** SHA-256 hash of cache inputs: agentDefinitionEventId (nullable), baseAgentInstructions, additionalSystemPrompt */
    cacheInputsHash: string;
}

/**
 * Compilation status tracking for eager compilation
 */
export type CompilationStatus = "idle" | "compiling" | "completed" | "error";

/**
 * Result from getEffectiveInstructionsSync() indicating source of instructions
 */
export interface EffectiveInstructionsResult {
    /** The instructions to use */
    instructions: string;
    /** Whether these are compiled (true) or base instructions (false) */
    isCompiled: boolean;
    /** Timestamp of when these instructions were compiled (undefined if using base) */
    compiledAt?: number;
    /** Source of the instructions: "compiled_cache", "base_instructions", or "compilation_in_progress" */
    source: "compiled_cache" | "base_instructions" | "compilation_in_progress";
}


// =====================================================================================
// PROMPT COMPILER SERVICE
// =====================================================================================

/**
 * PromptCompilerService compiles lessons with their comments into system prompts.
 * One instance per agent.
 */
export class PromptCompilerService {
    private ndk: NDK;
    private agentPubkey: Hexpubkey;
    private whitelistedPubkeys: Set<Hexpubkey>;

    /** Lessons for this agent — set at initialization and refreshed on each triggerCompilation call */
    private lessons: NDKAgentLesson[] = [];

    /** Subscription for kind 1111 (comment) events */
    private subscription: NDKSubscription | null = null;

    /** Comments collected from subscription, keyed by lesson event ID */
    private commentsByLesson: Map<string, LessonComment[]> = new Map();

    /** EOSE tracking */
    private eoseReceived = false;
    private eosePromise: Promise<void> | null = null;
    private eoseResolve: (() => void) | null = null;

    /** Cache directory */
    private cacheDir: string;

    // =====================================================================================
    // EAGER COMPILATION STATE (TIN-10 Enhancement)
    // =====================================================================================

    /** Current compilation status */
    private compilationStatus: CompilationStatus = "idle";

    /** In-memory cache of compiled effective instructions (loaded from disk or after compilation) */
    private cachedEffectiveInstructions: EffectiveInstructionsCacheEntry | null = null;

    /** Base agent instructions (stored for sync retrieval and recompilation) */
    private baseAgentInstructions: string = "";

    /** Agent definition event ID (stored for cache hash calculation) */
    private agentDefinitionEventId?: string;

    /** Promise for the currently running compilation (if any).
     * Useful for testing or other scenarios that need to await compilation. */
    private currentCompilationPromise: Promise<void> | null = null;

    /** Timestamp of last compilation trigger (for debouncing) */
    private lastCompilationTrigger: number = 0;

    /** Minimum interval between compilation triggers (ms) - debounce rapid lesson arrivals */
    private static readonly COMPILATION_DEBOUNCE_MS = 5000;

    /** Flag indicating a recompilation is pending (set when trigger arrives during active compilation or debounce) */
    private pendingRecompile: boolean = false;

    /** Timer for debounced compilation (to ensure triggers aren't dropped when idle) */
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;

    /** Flag indicating if initialize() has been called */
    private initialized: boolean = false;

    /** Agent metadata for kind:0 publishing (set via setAgentMetadata) */
    private agentSigner: NDKPrivateKeySigner | null = null;
    private agentName: string | null = null;
    private agentRole: string | null = null;
    private projectTitle: string | null = null;

    constructor(
        agentPubkey: Hexpubkey,
        whitelistedPubkeys: Hexpubkey[],
        ndk: NDK
    ) {
        this.agentPubkey = agentPubkey;
        this.whitelistedPubkeys = new Set(whitelistedPubkeys);
        this.ndk = ndk;

        // Cache at ~/.tenex/agents/prompts/{agentPubkey}.json
        this.cacheDir = path.dirname(PromptCompilerService.getCachePathForAgent(agentPubkey));
    }

    /**
     * Set agent metadata required for kind:0 publishing after compilation.
     * Must be called before triggerCompilation() to enable kind:0 publishing.
     *
     * @param agentSigner The agent's NDKPrivateKeySigner for signing kind:0 events
     * @param agentName The agent's display name
     * @param agentRole The agent's role description
     * @param projectTitle The project title for the profile description
     */
    setAgentMetadata(
        agentSigner: NDKPrivateKeySigner,
        agentName: string,
        agentRole: string,
        projectTitle: string
    ): void {
        this.agentSigner = agentSigner;
        this.agentName = agentName;
        this.agentRole = agentRole;
        this.projectTitle = projectTitle;
    }

    // =====================================================================================
    // SUBSCRIPTION MANAGEMENT
    // =====================================================================================

    /**
     * Start subscribing to kind 1111 (comment) events for lessons authored by this agent.
     * Filters by:
     * - kind: 1111 (NIP-22 comments)
     * - #K: ["4129"] (comments on lesson events)
     * - authors: whitelisted pubkeys only
     * - #p or #e referencing this agent's pubkey or lesson events
     */
    subscribe(): void {
        if (this.subscription) {
            logger.warn("PromptCompilerService: subscription already active", {
                agentPubkey: this.agentPubkey.substring(0, 8),
            });
            return;
        }

        // Reset EOSE state for fresh subscription lifecycle
        this.eoseReceived = false;
        this.eoseResolve = null;

        // Initialize EOSE promise
        this.eosePromise = new Promise<void>((resolve) => {
            this.eoseResolve = resolve;
        });

        // NIP-22 comment filter:
        // - kind: NDKKind.Comment (1111)
        // - #K: [NDKKind.AgentLesson] (referencing lesson events)
        // - authors: whitelisted pubkeys only
        // - #p: [agentPubkey] (comments mentioning the agent)
        const filter = {
            kinds: [NDKKind.Comment],
            "#K": [String(NDKKind.AgentLesson)], // Comments on kind 4129 (lessons)
            "#p": [this.agentPubkey], // Comments that mention this agent
            authors: Array.from(this.whitelistedPubkeys),
        };

        logger.debug("PromptCompilerService: starting subscription", {
            agentPubkey: this.agentPubkey.substring(0, 8),
            whitelistSize: this.whitelistedPubkeys.size,
            filter,
        });

        this.subscription = this.ndk.subscribe([filter], {
            closeOnEose: false,
            groupable: true,
        });

        this.subscription.on("event", (event: NDKEvent) => {
            this.handleCommentEvent(event);
        });

        this.subscription.on("eose", () => {
            logger.debug("PromptCompilerService: EOSE received", {
                agentPubkey: this.agentPubkey.substring(0, 8),
                commentsCount: this.getTotalCommentsCount(),
            });
            this.eoseReceived = true;
            if (this.eoseResolve) {
                this.eoseResolve();
            }
        });
    }

    /**
     * Block until EOSE is received from the subscription.
     * Call this after subscribe() before calling compile().
     */
    async waitForEOSE(): Promise<void> {
        if (this.eoseReceived) {
            return;
        }

        if (!this.eosePromise) {
            throw new Error("PromptCompilerService: waitForEOSE called before subscribe()");
        }

        await this.eosePromise;
    }

    /**
     * Stop the subscription and reset EOSE state
     */
    stop(): void {
        if (this.subscription) {
            this.subscription.stop();
            this.subscription = null;
        }

        // Clear debounce timer to prevent post-shutdown compilation triggers
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }

        // Reset compilation state to ensure full quiescence
        this.pendingRecompile = false;

        // Reset EOSE state so waitForEOSE is reliable after restart
        this.eoseReceived = false;
        this.eosePromise = null;
        this.eoseResolve = null;
    }

    // =====================================================================================
    // COMMENT HANDLING
    // =====================================================================================

    /**
     * Add a comment directly (called by Daemon when routing comments)
     * @param comment The lesson comment to add
     */
    addComment(comment: LessonComment): void {
        // Add to our collection
        const existing = this.commentsByLesson.get(comment.lessonEventId) || [];

        // Check for duplicates
        if (existing.some(c => c.id === comment.id)) {
            return;
        }

        existing.push(comment);
        this.commentsByLesson.set(comment.lessonEventId, existing);

        logger.debug("PromptCompilerService: added comment", {
            commentId: comment.id.substring(0, 8),
            lessonEventId: comment.lessonEventId.substring(0, 8),
            totalCommentsForLesson: existing.length,
        });

        // Trigger recompilation when a new comment arrives (debounced)
        this.onCommentArrived();
    }

    /**
     * Called when a new comment arrives for a lesson.
     * Triggers recompilation in the background.
     */
    onCommentArrived(): void {
        const tracer = trace.getTracer("tenex.prompt-compiler");
        tracer.startActiveSpan("tenex.prompt_compilation.comment_trigger", (span) => {
            span.setAttribute("agent.pubkey", this.agentPubkey.substring(0, 8));
            span.setAttribute("trigger.source", "new_comment");
            span.end();
        });

        logger.debug("PromptCompilerService: new comment arrived, triggering recompilation", {
            agentPubkey: this.agentPubkey.substring(0, 8),
        });
        this.triggerCompilation();
    }

    /**
     * Handle an incoming kind 1111 comment event from subscription.
     * Delegates to addComment after parsing the event.
     */
    private handleCommentEvent(event: NDKEvent): void {
        // Extract the lesson event ID using shared helper
        const lessonEventId = this.extractLessonEventId(event);
        if (!lessonEventId) {
            logger.debug("PromptCompilerService: comment missing lesson event reference", {
                eventId: event.id?.substring(0, 8),
            });
            return;
        }

        // Verify author is in whitelist
        if (!this.whitelistedPubkeys.has(event.pubkey)) {
            logger.debug("PromptCompilerService: comment from non-whitelisted author", {
                eventId: event.id?.substring(0, 8),
                author: event.pubkey.substring(0, 8),
            });
            return;
        }

        // Delegate to addComment for centralized storage with de-duplication
        this.addComment({
            id: event.id || "",
            pubkey: event.pubkey,
            content: event.content,
            lessonEventId,
            createdAt: event.created_at || 0,
        });
    }

    /**
     * Extract the lesson event ID from a kind 1111 comment event.
     * Per NIP-22, the root 'e' tag references the target event.
     */
    private extractLessonEventId(event: NDKEvent): string | null {
        // Look for 'e' tag with "root" marker, or first 'e' tag
        const rootETag = event.tags.find(
            (tag) => tag[0] === "e" && tag[3] === "root"
        );
        if (rootETag?.[1]) {
            return rootETag[1];
        }

        // Fallback: first 'e' tag
        const firstETag = event.tags.find((tag) => tag[0] === "e");
        return firstETag?.[1] || null;
    }

    /**
     * Get comments for a specific lesson
     */
    getCommentsForLesson(lessonEventId: string): LessonComment[] {
        return this.commentsByLesson.get(lessonEventId) || [];
    }

    /**
     * Get total number of comments across all lessons
     */
    private getTotalCommentsCount(): number {
        let total = 0;
        for (const comments of this.commentsByLesson.values()) {
            total += comments.length;
        }
        return total;
    }

    // =====================================================================================
    // COMPILATION
    // =====================================================================================

    /**
     * Compile lessons and their comments into Effective Agent Instructions.
     * Uses LLM to intelligently merge Base Agent Instructions with lessons.
     *
     * @param baseAgentInstructions The Base Agent Instructions to enhance (from agent.instructions)
     * @param agentDefinitionEventId Optional event ID for cache hash (for non-local agents)
     * @param additionalSystemPrompt Optional additional instructions to integrate
     * @returns The Effective Agent Instructions string
     * @throws Error if LLM compilation fails (consumer should handle fallback)
     */
    async compile(
        baseAgentInstructions: string,
        agentDefinitionEventId?: string,
        additionalSystemPrompt?: string
    ): Promise<string> {
        // Use the lessons set at initialization time
        const lessons = this.lessons;

        // If no lessons and no additional prompt, return Base Agent Instructions directly
        if (lessons.length === 0 && !additionalSystemPrompt) {
            logger.debug("PromptCompilerService: no lessons or additional prompt, returning Base Agent Instructions", {
                agentPubkey: this.agentPubkey.substring(0, 8),
            });
            return baseAgentInstructions;
        }

        // Calculate freshness inputs
        const maxCreatedAt = this.calculateMaxCreatedAt(lessons);
        // Create deterministic cache key from all relevant inputs:
        // - agentDefinitionEventId (when provided for non-local agents)
        // - baseAgentInstructions (always included - captures local agent definition changes)
        // - additionalSystemPrompt (captures dynamic context changes)
        const cacheHash = this.hashString(JSON.stringify({
            agentDefinitionEventId: agentDefinitionEventId || null,
            baseAgentInstructions,
            additionalSystemPrompt: additionalSystemPrompt || null,
        }));

        // Check cache
        const cached = await this.readCache();
        if (cached) {
            const cacheValid =
                cached.maxCreatedAt >= maxCreatedAt &&
                cached.cacheInputsHash === cacheHash;

            if (cacheValid) {
                logger.debug("PromptCompilerService: returning cached Effective Agent Instructions", {
                    agentPubkey: this.agentPubkey.substring(0, 8),
                    cacheAge: Date.now() - cached.timestamp * 1000,
                });
                return cached.effectiveAgentInstructions;
            }

            logger.debug("PromptCompilerService: cache stale, recompiling", {
                agentPubkey: this.agentPubkey.substring(0, 8),
                cachedMaxCreatedAt: cached.maxCreatedAt,
                currentMaxCreatedAt: maxCreatedAt,
                cacheHashMatch: cached.cacheInputsHash === cacheHash,
            });
        }

        // Compile with LLM
        const effectiveAgentInstructions = await this.compileWithLLM(lessons, baseAgentInstructions, additionalSystemPrompt);

        // Cache the result
        await this.writeCache({
            effectiveAgentInstructions,
            timestamp: Math.floor(Date.now() / 1000),
            maxCreatedAt,
            cacheInputsHash: cacheHash,
        });

        return effectiveAgentInstructions;
    }

    /**
     * Calculate the max created_at across lessons AND their comments
     */
    private calculateMaxCreatedAt(lessons: NDKAgentLesson[]): number {
        let max = 0;

        for (const lesson of lessons) {
            // Lesson's own created_at
            if (lesson.created_at && lesson.created_at > max) {
                max = lesson.created_at;
            }

            // Comments on this lesson
            const comments = this.getCommentsForLesson(lesson.id || "");
            for (const comment of comments) {
                if (comment.createdAt > max) {
                    max = comment.createdAt;
                }
            }
        }

        return max;
    }

    /**
     * Compile lessons + comments into Effective Agent Instructions using the LLM.
     * Uses generateText to naturally integrate lessons into the Base Agent Instructions.
     *
     * @param lessons The agent's lessons
     * @param baseAgentInstructions The Base Agent Instructions to enhance
     * @param additionalSystemPrompt Optional additional instructions to integrate
     * @returns The Effective Agent Instructions string
     * @throws Error if LLM compilation fails
     */
    private async compileWithLLM(
        lessons: NDKAgentLesson[],
        baseAgentInstructions: string,
        additionalSystemPrompt?: string
    ): Promise<string> {
        // Get LLM configuration - use promptCompilation config if set, then summarization, then default
        const { llms } = await config.loadConfig();
        const configName = llms.promptCompilation || llms.summarization || llms.default;

        if (!configName) {
            throw new Error("PromptCompilerService: no LLM config available for prompt compilation");
        }

        const llmConfig = config.getLLMConfig(configName);
        const llmService = llmServiceFactory.createService(llmConfig, {
            agentName: "prompt-compiler",
            sessionId: `prompt-compiler-${this.agentPubkey.substring(0, 8)}`,
        });

        // Format lessons with their comments (all lessons, regardless of comments)
        const lessonsWithComments = lessons.map((lesson) => {
            const comments = this.getCommentsForLesson(lesson.id || "");
            return {
                title: lesson.title || "Untitled",
                lesson: lesson.lesson,
                category: lesson.category,
                hashtags: lesson.hashtags,
                detailed: lesson.detailed,
                comments: comments.map((c) => c.content),
            };
        });

        // Build compilation prompt with emphasis on natural integration
        const systemPrompt = `You are a Technical Systems Architect responsible for compiling and upgrading the operating manuals (system instructions) for autonomous AI agents.Your Goal: Create a 'Single Source of Truth' instruction set that is rigorously executable, technically precise, and authoritative.## Input Data1. Base Agent Instructions (Current State)2. Lessons Learned (New requirements, fixes, and configuration changes)## Compilation Rules1. **Preserve Hard Data**: You must NEVER summarize, omit, or generalize specific technical values found in the lessons. If a lesson contains file paths, Hex keys, NSEC/NPUB credentials, or specific CLI flags, they MUST appear verbatim in the final output.2. **Strict Protocol Enforcement**: If a lesson dictates a mandatory workflow (e.g., \"Always do X first\"), this must be elevated to a top-level 'CRITICAL PROTOCOL' section, not buried in a bullet point.3. **Conflict Resolution**: Newer lessons represent the current reality. If a lesson contradicts the Base Instructions, delete the old instruction entirely and replace it with the new logic.4. **Structure for Utility**: Do not force all information into prose. Use dedicated sections for 'Configuration Constants', 'Reference Paths', and 'Forbidden Actions' to make the instructions scannable and executable.5. **Tone**: The output should be imperative and strict. Use 'MUST', 'NEVER', and 'REQUIRED' for constraints.## Output Requirements- Output ONLY the Effective Agent Instructions.- Do NOT add meta-commentary.- Do NOT summarize the compilation process.`;

        // Build user prompt with all inputs
        let userPrompt = `## Base Agent Instructions

${baseAgentInstructions}

## Lessons to Integrate

${JSON.stringify(lessonsWithComments, null, 2)}`;

        // Add additional system prompt if provided
        if (additionalSystemPrompt) {
            userPrompt += `

## Additional Instructions

${additionalSystemPrompt}`;
        }

        userPrompt += `

Please rewrite and compile this into unified, cohesive Effective Agent Instructions.`;

        const { text: effectiveAgentInstructions } = await llmService.generateText([
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ]);

        logger.info("PromptCompilerService: compiled Effective Agent Instructions successfully", {
            agentPubkey: this.agentPubkey.substring(0, 8),
            lessonsCount: lessons.length,
            commentsCount: this.getTotalCommentsCount(),
            baseInstructionsLength: baseAgentInstructions.length,
            effectiveInstructionsLength: effectiveAgentInstructions.length,
            hasAdditionalPrompt: !!additionalSystemPrompt,
        });

        return effectiveAgentInstructions;
    }

    // =====================================================================================
    // EAGER COMPILATION API (TIN-10 Enhancement)
    // =====================================================================================

    /**
     * Initialize the compiler with base agent instructions and current lessons.
     * This MUST be called before triggerCompilation() or getEffectiveInstructionsSync().
     *
     * @param baseAgentInstructions The Base Agent Instructions from agent.instructions
     * @param lessons The agent's current lessons
     * @param agentDefinitionEventId Optional event ID for cache hash (for non-local agents)
     */
    async initialize(
        baseAgentInstructions: string,
        lessons: NDKAgentLesson[],
        agentDefinitionEventId?: string
    ): Promise<void> {
        const tracer = trace.getTracer("tenex.prompt-compiler");

        return tracer.startActiveSpan("tenex.prompt_compilation.initialize", async (span) => {
            span.setAttribute("agent.pubkey", this.agentPubkey.substring(0, 8));

            this.baseAgentInstructions = baseAgentInstructions;
            this.lessons = lessons;
            this.agentDefinitionEventId = agentDefinitionEventId;
            this.initialized = true;

            // Try to load existing cache from disk into memory
            const cached = await this.readCache();
            if (cached) {
                // Validate the cache is for the same inputs
                const cacheHash = this.hashString(JSON.stringify({
                    agentDefinitionEventId: agentDefinitionEventId || null,
                    baseAgentInstructions,
                    additionalSystemPrompt: null,
                }));

                if (cached.cacheInputsHash === cacheHash) {
                    this.cachedEffectiveInstructions = cached;
                    this.compilationStatus = "completed";
                    span.addEvent("tenex.prompt_compilation.cache_loaded_from_disk", {
                        "cache.timestamp": cached.timestamp,
                        "cache.max_created_at": cached.maxCreatedAt,
                    });
                    span.setAttribute("cache.loaded_from_disk", true);
                    logger.debug("PromptCompilerService: loaded valid cache into memory", {
                        agentPubkey: this.agentPubkey.substring(0, 8),
                        cacheTimestamp: cached.timestamp,
                    });
                } else {
                    span.addEvent("tenex.prompt_compilation.cache_inputs_changed");
                    span.setAttribute("cache.loaded_from_disk", false);
                    span.setAttribute("cache.inputs_changed", true);
                    logger.debug("PromptCompilerService: cache inputs changed, will need recompilation", {
                        agentPubkey: this.agentPubkey.substring(0, 8),
                    });
                }
            } else {
                span.setAttribute("cache.loaded_from_disk", false);
                span.setAttribute("cache.exists", false);
            }

            span.end();
        });
    }

    /**
     * Trigger compilation in the background (fire and forget).
     * This is the key method for EAGER compilation - called at project startup.
     * Does NOT block - compilation happens asynchronously.
     *
     * Safe to call multiple times - uses debouncing and pendingRecompile to ensure
     * no triggers are dropped. If a trigger arrives during active compilation or
     * within the debounce window, a follow-up compilation will be scheduled.
     */
    triggerCompilation(): void {
        // Guard: ensure initialize() was called
        if (!this.initialized) {
            logger.warn("PromptCompilerService: triggerCompilation called before initialize()", {
                agentPubkey: this.agentPubkey.substring(0, 8),
            });
            return;
        }

        const tracer = trace.getTracer("tenex");

        // Debounce rapid triggers (e.g., multiple lessons arriving quickly)
        const now = Date.now();
        const timeSinceLastTrigger = now - this.lastCompilationTrigger;
        if (timeSinceLastTrigger < PromptCompilerService.COMPILATION_DEBOUNCE_MS) {
            // Within debounce window
            logger.debug("PromptCompilerService: debouncing compilation trigger", {
                agentPubkey: this.agentPubkey.substring(0, 8),
                timeSinceLastTrigger,
            });

            // If a compilation is in progress, just mark pending (will be handled in finally block)
            if (this.compilationStatus === "compiling") {
                this.pendingRecompile = true;
                logger.debug("PromptCompilerService: compilation in progress, marked pending recompile", {
                    agentPubkey: this.agentPubkey.substring(0, 8),
                });
                return;
            }

            // If idle (no active compilation), schedule a timer to compile after debounce window expires
            // This ensures triggers aren't dropped when the system is idle
            if (!this.debounceTimer) {
                const remainingDebounce = PromptCompilerService.COMPILATION_DEBOUNCE_MS - timeSinceLastTrigger;
                this.debounceTimer = setTimeout(() => {
                    this.debounceTimer = null;
                    logger.debug("PromptCompilerService: debounce timer fired, triggering compilation", {
                        agentPubkey: this.agentPubkey.substring(0, 8),
                    });
                    this.triggerCompilation();
                }, remainingDebounce);
                logger.debug("PromptCompilerService: scheduled debounce timer", {
                    agentPubkey: this.agentPubkey.substring(0, 8),
                    remainingDebounceMs: remainingDebounce,
                });
            }
            return;
        }
        this.lastCompilationTrigger = now;

        // Clear any pending debounce timer since we're about to compile now
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }

        // If already compiling, mark pending and let the running compilation handle it
        if (this.compilationStatus === "compiling") {
            this.pendingRecompile = true;
            logger.debug("PromptCompilerService: compilation in progress, marked pending recompile", {
                agentPubkey: this.agentPubkey.substring(0, 8),
            });
            return;
        }

        // Clear pending flag since we're about to compile
        this.pendingRecompile = false;

        // Fire and forget - don't await
        this.currentCompilationPromise = tracer.startActiveSpan("tenex.prompt_compilation", async (span) => {
            span.setAttribute("agent.pubkey", this.agentPubkey.substring(0, 8));

            try {
                span.addEvent("tenex.prompt_compilation.started");
                this.compilationStatus = "compiling";

                const startTime = Date.now();

                // Wait for EOSE with a timeout to ensure we have comments
                try {
                    await Promise.race([
                        this.waitForEOSE(),
                        new Promise<void>((_, reject) =>
                            setTimeout(() => reject(new Error("EOSE timeout")), 5000)
                        ),
                    ]);
                } catch {
                    // Continue without all comments
                    logger.debug("PromptCompilerService: EOSE timeout during eager compilation", {
                        agentPubkey: this.agentPubkey.substring(0, 8),
                    });
                }

                // Run the actual compilation
                const effectiveInstructions = await this.compile(
                    this.baseAgentInstructions,
                    this.agentDefinitionEventId
                );

                // Update in-memory cache
                const maxCreatedAt = this.calculateMaxCreatedAt(this.lessons);
                const cacheHash = this.hashString(JSON.stringify({
                    agentDefinitionEventId: this.agentDefinitionEventId || null,
                    baseAgentInstructions: this.baseAgentInstructions,
                    additionalSystemPrompt: null,
                }));

                this.cachedEffectiveInstructions = {
                    effectiveAgentInstructions: effectiveInstructions,
                    timestamp: Math.floor(Date.now() / 1000),
                    maxCreatedAt,
                    cacheInputsHash: cacheHash,
                };

                this.compilationStatus = "completed";

                const duration = Date.now() - startTime;
                span.addEvent("tenex.prompt_compilation.completed", {
                    "compilation.duration_ms": duration,
                    "compilation.lessons_count": this.lessons.length,
                });
                span.setStatus({ code: SpanStatusCode.OK });

                logger.info("PromptCompilerService: eager compilation completed", {
                    agentPubkey: this.agentPubkey.substring(0, 8),
                    durationMs: duration,
                    lessonsCount: this.lessons.length,
                });

                // Publish kind:0 with compiled instructions (fire-and-forget)
                // Only publish if agent metadata was provided
                if (this.agentSigner && this.agentName && this.agentRole && this.projectTitle) {
                    void AgentProfilePublisher.publishCompiledInstructions(
                        this.agentSigner,
                        effectiveInstructions,
                        this.agentName,
                        this.agentRole,
                        this.projectTitle
                    );
                }
            } catch (error) {
                this.compilationStatus = "error";
                span.addEvent("tenex.prompt_compilation.error", {
                    "error.message": error instanceof Error ? error.message : String(error),
                });
                span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: error instanceof Error ? error.message : String(error),
                });

                logger.error("PromptCompilerService: eager compilation failed", {
                    agentPubkey: this.agentPubkey.substring(0, 8),
                    error: error instanceof Error ? error.message : String(error),
                });
            } finally {
                span.end();
                this.currentCompilationPromise = null;

                // Check if a recompile was requested while we were compiling
                if (this.pendingRecompile) {
                    logger.debug("PromptCompilerService: pending recompile detected, scheduling follow-up", {
                        agentPubkey: this.agentPubkey.substring(0, 8),
                    });
                    // Reset timestamp to allow immediate trigger
                    this.lastCompilationTrigger = 0;
                    // Use setImmediate to avoid deep recursion
                    setImmediate(() => this.triggerCompilation());
                }
            }
        });
    }

    /**
     * Get the effective instructions SYNCHRONOUSLY.
     * This is the key method for agent execution - NEVER blocks on compilation.
     *
     * Priority order:
     * 1. Fresh compiled instructions (cache is valid)
     * 2. Stale compiled instructions (cache exists but is stale - triggers background recompile)
     * 3. Base instructions (no cache available - compilation pending, in progress, or failed)
     *
     * Staleness is determined by:
     * - maxCreatedAt: new lessons have arrived since last compilation
     * - cacheInputsHash: base instructions or agentDefinitionEventId changed
     *
     * Per requirements: agent should NEVER wait. We serve stale compiled instructions
     * (which are better than base) while a recompile runs in the background.
     *
     * Includes telemetry to track which source was used.
     */
    getEffectiveInstructionsSync(): EffectiveInstructionsResult {
        const tracer = trace.getTracer("tenex");

        // If we have cached compiled instructions, check freshness
        if (this.cachedEffectiveInstructions) {
            const cached = this.cachedEffectiveInstructions;
            // Check if cache is still fresh by comparing maxCreatedAt AND input hash
            const currentMaxCreatedAt = this.calculateMaxCreatedAt(this.lessons);

            // Also check if inputs (base instructions, agentDefinitionEventId) have changed
            const currentInputsHash = this.hashString(JSON.stringify({
                agentDefinitionEventId: this.agentDefinitionEventId || null,
                baseAgentInstructions: this.baseAgentInstructions,
                additionalSystemPrompt: null,
            }));
            const inputsMatch = cached.cacheInputsHash === currentInputsHash;

            const cacheIsFresh = inputsMatch &&
                cached.maxCreatedAt >= currentMaxCreatedAt;

            if (cacheIsFresh) {
                // Cache is fresh - return immediately (no span needed for happy path)
                logger.debug("PromptCompilerService: returning fresh cached effective instructions", {
                    agentPubkey: this.agentPubkey.substring(0, 8),
                    cacheTimestamp: cached.timestamp,
                });

                return {
                    instructions: cached.effectiveAgentInstructions,
                    isCompiled: true,
                    compiledAt: cached.timestamp,
                    source: "compiled_cache",
                };
            }

            // Cache is stale - but we can still serve it while recompile is in-flight
            // This follows the requirement: "agent should never wait"
            // Cache can be stale due to: new lessons (maxCreatedAt) OR changed inputs (base instructions)
            const staleReason = !inputsMatch ? "inputs_changed" : "new_lessons";
            logger.debug("PromptCompilerService: cache is stale, serving stale while triggering recompile", {
                agentPubkey: this.agentPubkey.substring(0, 8),
                staleReason,
                inputsMatch,
                cachedMaxCreatedAt: cached.maxCreatedAt,
                currentMaxCreatedAt,
                compilationStatus: this.compilationStatus,
            });

            // Trigger background recompile if not already compiling
            if (this.compilationStatus !== "compiling") {
                this.triggerCompilation();
            }

            // Return stale cache (better than base instructions)
            tracer.startActiveSpan("tenex.prompt_compilation.cache_stale", (span) => {
                span.setAttribute("compilation.timestamp", cached.timestamp);
                span.setAttribute("compilation.is_compiled", true);
                span.setAttribute("compilation.is_stale", true);
                span.setAttribute("compilation.stale_reason", staleReason);
                span.setAttribute("compilation.inputs_match", inputsMatch);
                span.setAttribute("compilation.cached_max_created_at", cached.maxCreatedAt);
                span.setAttribute("compilation.current_max_created_at", currentMaxCreatedAt);
                span.end();
            });

            return {
                instructions: cached.effectiveAgentInstructions,
                isCompiled: true,
                compiledAt: cached.timestamp,
                source: "compiled_cache",
            };
        }

        // No compiled instructions available - return base instructions
        // This happens when:
        // 1. Compilation hasn't started yet
        // 2. Compilation is in progress
        // 3. Compilation failed

        const source = this.compilationStatus === "compiling"
            ? "compilation_in_progress"
            : "base_instructions";

        tracer.startActiveSpan("tenex.prompt_compilation.fallback_to_base", (span) => {
            span.setAttribute("compilation.status", this.compilationStatus);
            span.setAttribute("compilation.is_compiled", false);
            span.setAttribute("compilation.source", source);
            span.end();
        });

        logger.debug("PromptCompilerService: returning base instructions (no compiled cache)", {
            agentPubkey: this.agentPubkey.substring(0, 8),
            compilationStatus: this.compilationStatus,
            source,
        });

        return {
            instructions: this.baseAgentInstructions,
            isCompiled: false,
            source,
        };
    }

    /**
     * Get the current compilation status
     */
    getCompilationStatus(): CompilationStatus {
        return this.compilationStatus;
    }

    /**
     * Check if compiled instructions are available
     */
    hasCompiledInstructions(): boolean {
        return this.cachedEffectiveInstructions !== null;
    }

    /**
     * Called when a new lesson arrives for this agent.
     * Triggers recompilation in the background.
     */
    onLessonArrived(): void {
        const tracer = trace.getTracer("tenex.prompt-compiler");
        tracer.startActiveSpan("tenex.prompt_compilation.lesson_trigger", (span) => {
            span.setAttribute("agent.pubkey", this.agentPubkey.substring(0, 8));
            span.setAttribute("trigger.source", "new_lesson");
            span.end();
        });

        logger.debug("PromptCompilerService: new lesson arrived, triggering recompilation", {
            agentPubkey: this.agentPubkey.substring(0, 8),
        });
        this.triggerCompilation();
    }

    /**
     * Called when a lesson is deleted for this agent.
     * Triggers recompilation in the background to remove the deleted lesson from compiled prompts.
     */
    onLessonDeleted(): void {
        const tracer = trace.getTracer("tenex.prompt-compiler");
        tracer.startActiveSpan("tenex.prompt_compilation.lesson_deleted_trigger", (span) => {
            span.setAttribute("agent.pubkey", this.agentPubkey.substring(0, 8));
            span.setAttribute("trigger.source", "lesson_deleted");
            span.end();
        });

        logger.debug("PromptCompilerService: lesson deleted, triggering recompilation", {
            agentPubkey: this.agentPubkey.substring(0, 8),
        });
        this.triggerCompilation();
    }

    /**
     * Update the lessons for this compiler.
     * Called by the cache system when lessons may have changed since the compiler was created.
     * Triggers recompilation if the lesson set has changed.
     *
     * @param newLessons The updated set of lessons from ProjectContext
     */
    updateLessons(newLessons: NDKAgentLesson[]): void {
        // Quick check: if counts differ, definitely changed
        const previousCount = this.lessons.length;
        if (newLessons.length !== previousCount) {
            this.lessons = newLessons;
            logger.debug("PromptCompilerService: lessons updated (count changed)", {
                agentPubkey: this.agentPubkey.substring(0, 8),
                previousCount,
                newCount: newLessons.length,
            });
            this.triggerCompilation();
            return;
        }

        // Deep check: compare lesson IDs (lessons are ordered most recent first)
        const currentIds = new Set(this.lessons.map((l) => l.id));
        const newIds = new Set(newLessons.map((l) => l.id));

        const changed = newLessons.some((l) => !currentIds.has(l.id)) ||
                        this.lessons.some((l) => !newIds.has(l.id));

        if (changed) {
            this.lessons = newLessons;
            logger.debug("PromptCompilerService: lessons updated (IDs changed)", {
                agentPubkey: this.agentPubkey.substring(0, 8),
                lessonsCount: newLessons.length,
            });
            this.triggerCompilation();
        }
    }

    /**
     * Wait for the current compilation to complete (for testing purposes).
     * Returns immediately if no compilation is in progress.
     */
    async waitForCompilation(): Promise<void> {
        if (this.currentCompilationPromise) {
            await this.currentCompilationPromise;
        }
    }

    // =====================================================================================
    // CACHE MANAGEMENT
    // =====================================================================================

    /**
     * Get the cache file path for a given agent pubkey.
     * Static variant for external consumers that need to read the cache directly.
     */
    static getCachePathForAgent(agentPubkey: string): string {
        const cacheDir = path.join(config.getConfigPath(), "agents", "prompts");
        return path.join(cacheDir, `${agentPubkey}.json`);
    }

    /**
     * Get the cache file path for this agent
     */
    private getCachePath(): string {
        return PromptCompilerService.getCachePathForAgent(this.agentPubkey);
    }

    /**
     * Read cache entry from disk
     */
    private async readCache(): Promise<EffectiveInstructionsCacheEntry | null> {
        try {
            const cachePath = this.getCachePath();
            const data = await fs.readFile(cachePath, "utf-8");
            return JSON.parse(data) as EffectiveInstructionsCacheEntry;
        } catch {
            // File doesn't exist or is invalid - that's fine
            return null;
        }
    }

    /**
     * Write cache entry to disk
     */
    private async writeCache(entry: EffectiveInstructionsCacheEntry): Promise<void> {
        try {
            await fs.mkdir(this.cacheDir, { recursive: true });
            const cachePath = this.getCachePath();
            await fs.writeFile(cachePath, JSON.stringify(entry, null, 2));

            logger.debug("PromptCompilerService: wrote cache", {
                agentPubkey: this.agentPubkey.substring(0, 8),
                cachePath,
            });
        } catch (error) {
            logger.error("PromptCompilerService: failed to write cache", {
                agentPubkey: this.agentPubkey.substring(0, 8),
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    // =====================================================================================
    // UTILITIES
    // =====================================================================================

    /**
     * Hash a string using SHA-256
     */
    private hashString(input: string): string {
        return crypto.createHash("sha256").update(input).digest("hex");
    }
}

// =====================================================================================
// EXPORTS
// =====================================================================================

export default PromptCompilerService;
