import { getNDK } from "@/nostr";
import { TagExtractor } from "@/nostr/TagExtractor";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { NudgeResult, NudgeToolPermissions, NudgeData } from "./types";

const tracer = trace.getTracer("tenex.nudge-service");

/**
 * Service for fetching and processing Agent Nudge events (kind:4201)
 * Single Responsibility: Retrieve nudge content and concatenate for system prompt injection
 */
export class NudgeService {
    private static instance: NudgeService;

    private constructor() {}

    static getInstance(): NudgeService {
        if (!NudgeService.instance) {
            NudgeService.instance = new NudgeService();
        }
        return NudgeService.instance;
    }

    /**
     * Fetch nudge events by IDs and concatenate their content
     * @param eventIds Array of nudge event IDs to fetch
     * @returns Concatenated content from all nudges, or empty string if none found
     */
    async fetchNudges(eventIds: string[]): Promise<string> {
        if (eventIds.length === 0) {
            return "";
        }

        const span = tracer.startSpan("tenex.nudge.fetch_nudges", {
            attributes: {
                "nudge.requested_count": eventIds.length,
            },
        }, otelContext.active());

        return otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
            try {
                const ndk = getNDK();
                const nudgeEvents = await ndk.fetchEvents({
                    ids: eventIds,
                });

                const nudges = Array.from(nudgeEvents);
                const concatenated = nudges
                    .map((nudge) => nudge.content.trim())
                    .filter((content) => content.length > 0)
                    .join("\n\n");

                const nudgeTitles = nudges.map((n) => n.tagValue("title") || "untitled").join(", ");

                span.setAttributes({
                    "nudge.fetched_count": nudges.length,
                    "nudge.content_length": concatenated.length,
                    "nudge.titles": nudgeTitles,
                });

                span.setStatus({ code: SpanStatusCode.OK });
                span.end();
                return concatenated;
            } catch (error) {
                span.recordException(error as Error);
                span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: (error as Error).message,
                });
                span.end();
                return "";
            }
        });
    }

    /**
     * Fetch a single nudge event by ID
     * @param eventId The nudge event ID
     * @returns The nudge event or null if not found
     */
    async fetchNudge(eventId: string): Promise<NDKEvent | null> {
        try {
            const ndk = getNDK();
            const events = await ndk.fetchEvents({
                ids: [eventId],
            });

            const nudge = Array.from(events).find((event) => event.kind === 4201);
            return nudge || null;
        } catch (error) {
            logger.error("[NudgeService] Failed to fetch nudge", { error, eventId });
            return null;
        }
    }

    /**
     * Fetch nudge events and extract both content and tool permissions.
     * This method extracts:
     * - only-tool tags: Highest priority, replaces ALL tools
     * - allow-tool tags: Adds tools to agent's default set
     * - deny-tool tags: Removes tools from agent's default set
     *
     * @param eventIds Array of nudge event IDs to fetch
     * @returns NudgeResult with content and tool permissions
     */
    async fetchNudgesWithPermissions(eventIds: string[]): Promise<NudgeResult> {
        const emptyResult: NudgeResult = {
            nudges: [],
            content: "",
            toolPermissions: {},
        };

        if (eventIds.length === 0) {
            return emptyResult;
        }

        const span = tracer.startSpan("tenex.nudge.fetch_nudges_with_permissions", {
            attributes: {
                "nudge.requested_count": eventIds.length,
            },
        }, otelContext.active());

        return otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
            try {
                const ndk = getNDK();
                const nudgeEvents = await ndk.fetchEvents({
                    ids: eventIds,
                });

                const nudges = Array.from(nudgeEvents);

                // Build nudge data array
                const nudgeDataArray: NudgeData[] = nudges
                    .map((nudge) => ({
                        content: nudge.content.trim(),
                        title: nudge.tagValue("title") || undefined,
                    }))
                    .filter((data) => data.content.length > 0);

                // Concatenate content for backward compatibility
                const concatenated = nudgeDataArray
                    .map((data) => data.content)
                    .join("\n\n");

                // Extract tool permissions from all nudges
                const toolPermissions = this.extractToolPermissions(nudges);

                const nudgeTitles = nudges.map((n) => n.tagValue("title") || "untitled").join(", ");

                span.setAttributes({
                    "nudge.fetched_count": nudges.length,
                    "nudge.content_length": concatenated.length,
                    "nudge.titles": nudgeTitles,
                    "nudge.only_tools_count": toolPermissions.onlyTools?.length ?? 0,
                    "nudge.allow_tools_count": toolPermissions.allowTools?.length ?? 0,
                    "nudge.deny_tools_count": toolPermissions.denyTools?.length ?? 0,
                });

                span.setStatus({ code: SpanStatusCode.OK });
                span.end();

                return {
                    nudges: nudgeDataArray,
                    content: concatenated,
                    toolPermissions,
                };
            } catch (error) {
                span.recordException(error as Error);
                span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: (error as Error).message,
                });
                span.end();
                logger.error("[NudgeService] Failed to fetch nudges with permissions", { error });
                return emptyResult;
            }
        });
    }

    /**
     * Extract tool permissions from nudge events.
     * Collects all only-tool, allow-tool, and deny-tool tags across all nudges.
     *
     * @param nudges Array of nudge events
     * @returns Aggregated tool permissions
     */
    private extractToolPermissions(nudges: NDKEvent[]): NudgeToolPermissions {
        const permissions: NudgeToolPermissions = {};

        const onlyTools: string[] = [];
        const allowTools: string[] = [];
        const denyTools: string[] = [];

        for (const nudge of nudges) {
            // Extract only-tool tags
            const onlyToolValues = TagExtractor.getTagValues(nudge, "only-tool");
            onlyTools.push(...onlyToolValues);

            // Extract allow-tool tags
            const allowToolValues = TagExtractor.getTagValues(nudge, "allow-tool");
            allowTools.push(...allowToolValues);

            // Extract deny-tool tags
            const denyToolValues = TagExtractor.getTagValues(nudge, "deny-tool");
            denyTools.push(...denyToolValues);
        }

        // Only set arrays if they have values (to keep the object clean)
        if (onlyTools.length > 0) {
            // Deduplicate and set
            permissions.onlyTools = [...new Set(onlyTools)];
        }
        if (allowTools.length > 0) {
            permissions.allowTools = [...new Set(allowTools)];
        }
        if (denyTools.length > 0) {
            permissions.denyTools = [...new Set(denyTools)];
        }

        return permissions;
    }
}
