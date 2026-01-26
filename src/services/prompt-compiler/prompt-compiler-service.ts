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
import type NDK from "@nostr-dev-kit/ndk";
import { NDKKind } from "@/nostr/kinds";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { config } from "@/services/ConfigService";
import { llmServiceFactory } from "@/llm";
import { logger } from "@/utils/logger";
import type { ProjectContext } from "@/services/projects/ProjectContext";

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
    private projectContext: ProjectContext;

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

    constructor(
        agentPubkey: Hexpubkey,
        whitelistedPubkeys: Hexpubkey[],
        ndk: NDK,
        projectContext: ProjectContext
    ) {
        this.agentPubkey = agentPubkey;
        this.whitelistedPubkeys = new Set(whitelistedPubkeys);
        this.ndk = ndk;
        this.projectContext = projectContext;

        // Cache at ~/.tenex/agents/prompts/{agentPubkey}.json
        this.cacheDir = path.join(config.getConfigPath(), "agents", "prompts");
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
        // Retrieve lessons from ProjectContext
        const lessons = this.projectContext.getLessonsForAgent(this.agentPubkey);

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
        const systemPrompt = `You are a prompt compiler that rewrites and integrates lessons learned by an AI agent into their Base Agent Instructions.

Your task:
1. Rewrite the Base Agent Instructions to naturally incorporate the provided lessons
2. Integrate lessons as natural parts of the instructions, not as separate sections
3. Resolve any contradictions (newer lessons/comments take precedence)
4. Remove redundancy while preserving important nuances
5. You may restructure and reformat the instructions for better clarity

Guidelines:
- Lessons should feel like they were always part of the original instructions
- If a comment refines or corrects a lesson, use the refined version
- Keep the result concise but comprehensive
- Do NOT add meta-commentary about the compilation process
- Do NOT mention that lessons were integrated

Output ONLY the Effective Agent Instructions, nothing else.`;

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
    // CACHE MANAGEMENT
    // =====================================================================================

    /**
     * Get the cache file path for this agent
     */
    private getCachePath(): string {
        return path.join(this.cacheDir, `${this.agentPubkey}.json`);
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
