import { getNDK } from "@/nostr";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";

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
        });

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
}
