/**
 * Prompt Compiler Service (TIN-10)
 *
 * Compiles agent lessons with user comments into optimized system prompts.
 * Uses LLM to synthesize lessons + comments into the base prompt.
 *
 * Single-file YAGNI implementation:
 * - Nostr subscription for kind 1111 events (comments on lessons)
 * - Filter by whitelisted authors and #K: ["4129"] (NIP-22)
 * - Track EOSE state with waitForEOSE() method
 * - Disk cache at .tenex/agents/prompts/{agentPubkey}.json
 * - LLM compilation with dedicated prompt-compilation config
 * - Freshness logic: recompile if max(created_at) > cache timestamp OR basePrompt hash changed
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
import { z } from "zod";

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
 * Cache entry for compiled prompts
 */
export interface CompiledPromptCacheEntry {
    /** The compiled system prompt */
    compiledPrompt: string;
    /** When the cache was written (Unix timestamp) */
    timestamp: number;
    /** max(created_at) of lessons AND comments used */
    maxCreatedAt: number;
    /** SHA-256 hash of the base prompt used */
    basePromptHash: string;
}

/**
 * Result of compile() indicating whether compilation actually occurred
 */
export interface CompileResult {
    /** The prompt (either compiled or base) */
    prompt: string;
    /** Whether LLM compilation actually occurred */
    compiled: boolean;
    /** Number of lessons that were provided */
    lessonsCount: number;
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

    constructor(agentPubkey: Hexpubkey, whitelistedPubkeys: Hexpubkey[], ndk: NDK) {
        this.agentPubkey = agentPubkey;
        this.whitelistedPubkeys = new Set(whitelistedPubkeys);
        this.ndk = ndk;

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
     * Compile lessons and their comments into a system prompt.
     * Uses caching based on maxCreatedAt and basePrompt hash.
     *
     * @param lessons The agent's lessons
     * @param basePrompt The base system prompt to enhance
     * @returns CompileResult indicating whether compilation occurred and the resulting prompt
     */
    async compile(lessons: NDKAgentLesson[], basePrompt: string): Promise<CompileResult> {
        // If no lessons, return base prompt directly (skip compilation)
        if (lessons.length === 0) {
            logger.debug("PromptCompilerService: no lessons, returning base prompt", {
                agentPubkey: this.agentPubkey.substring(0, 8),
            });
            return { prompt: basePrompt, compiled: false, lessonsCount: 0 };
        }

        // Calculate freshness inputs
        const maxCreatedAt = this.calculateMaxCreatedAt(lessons);
        const basePromptHash = this.hashString(basePrompt);

        // Check cache
        const cached = await this.readCache();
        if (cached) {
            const cacheValid =
                cached.maxCreatedAt >= maxCreatedAt &&
                cached.basePromptHash === basePromptHash;

            if (cacheValid) {
                logger.debug("PromptCompilerService: returning cached prompt", {
                    agentPubkey: this.agentPubkey.substring(0, 8),
                    cacheAge: Date.now() - cached.timestamp * 1000,
                });
                // Cached compilation was successful
                return { prompt: cached.compiledPrompt, compiled: true, lessonsCount: lessons.length };
            }

            logger.debug("PromptCompilerService: cache stale, recompiling", {
                agentPubkey: this.agentPubkey.substring(0, 8),
                cachedMaxCreatedAt: cached.maxCreatedAt,
                currentMaxCreatedAt: maxCreatedAt,
                basePromptHashMatch: cached.basePromptHash === basePromptHash,
            });
        }

        // Compile with LLM
        const compileResult = await this.compileWithLLM(lessons, basePrompt);

        // Only cache if compilation actually happened
        if (compileResult.compiled) {
            await this.writeCache({
                compiledPrompt: compileResult.prompt,
                timestamp: Math.floor(Date.now() / 1000),
                maxCreatedAt,
                basePromptHash,
            });
        }

        return { ...compileResult, lessonsCount: lessons.length };
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
     * Compile lessons + comments into a prompt using the LLM
     * @returns Result indicating whether compilation occurred
     */
    private async compileWithLLM(
        lessons: NDKAgentLesson[],
        basePrompt: string
    ): Promise<{ prompt: string; compiled: boolean }> {
        // Get LLM configuration - use prompt-compilation config if set, otherwise summarization, otherwise default
        const { llms } = await config.loadConfig();
        const configName = llms.summarization || llms.default; // TODO: Add prompt-compilation config option

        if (!configName) {
            logger.warn("PromptCompilerService: no LLM config available, caller should fall back to simple formatting");
            // Return compiled: false to signal that lessons were NOT integrated
            return { prompt: basePrompt, compiled: false };
        }

        const llmConfig = config.getLLMConfig(configName);
        const llmService = llmServiceFactory.createService(llmConfig, {
            agentName: "prompt-compiler",
            sessionId: `prompt-compiler-${this.agentPubkey.substring(0, 8)}`,
        });

        // Format lessons with their comments
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

        // Build compilation prompt
        const systemPrompt = `You are a prompt compiler that integrates lessons learned by an AI agent into their base system prompt.

Your task:
1. Analyze the provided lessons and any comments/refinements from the user
2. Synthesize the lessons into clear, actionable guidance
3. Integrate them naturally into the base prompt structure
4. Resolve any contradictions (newer lessons/comments take precedence)
5. Remove redundancy while preserving important nuances

Guidelines:
- Preserve the original structure and tone of the base prompt
- Add lessons as natural extensions, not bolted-on sections
- If a comment refines or corrects a lesson, use the refined version
- Keep the result concise but comprehensive
- Do NOT add meta-commentary about the compilation process

Output ONLY the compiled prompt, nothing else.`;

        const userPrompt = `## Base Prompt

${basePrompt}

## Lessons to Integrate

${JSON.stringify(lessonsWithComments, null, 2)}

Please compile these lessons into the base prompt.`;

        try {
            const { object: result } = await llmService.generateObject(
                [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt },
                ],
                z.object({
                    compiledPrompt: z.string().describe("The compiled system prompt with lessons integrated"),
                })
            );

            logger.info("PromptCompilerService: compiled prompt successfully", {
                agentPubkey: this.agentPubkey.substring(0, 8),
                lessonsCount: lessons.length,
                commentsCount: this.getTotalCommentsCount(),
                basePromptLength: basePrompt.length,
                compiledLength: result.compiledPrompt.length,
            });

            return { prompt: result.compiledPrompt, compiled: true };
        } catch (error) {
            logger.error("PromptCompilerService: LLM compilation failed, caller should fall back", {
                agentPubkey: this.agentPubkey.substring(0, 8),
                error: error instanceof Error ? error.message : String(error),
            });

            // Return compiled: false to signal caller should use fallback formatting
            return { prompt: basePrompt, compiled: false };
        }
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
    private async readCache(): Promise<CompiledPromptCacheEntry | null> {
        try {
            const cachePath = this.getCachePath();
            const data = await fs.readFile(cachePath, "utf-8");
            return JSON.parse(data) as CompiledPromptCacheEntry;
        } catch {
            // File doesn't exist or is invalid - that's fine
            return null;
        }
    }

    /**
     * Write cache entry to disk
     */
    private async writeCache(entry: CompiledPromptCacheEntry): Promise<void> {
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
