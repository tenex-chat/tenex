import { NudgeSkillWhitelistService } from "./NudgeWhitelistService";
import { shortenEventId } from "@/utils/conversation-id";

const FULL_EVENT_ID_REGEX = /^[0-9a-f]{64}$/;

export interface NudgeIdentifierResolution {
    resolvedNudgeEventIds: string[];
    unresolvedIdentifiers: string[];
}

/**
 * Resolves prompt-facing nudge identifiers into canonical nudge event IDs.
 * Delegate still allows unresolved raw IDs to pass through for backward
 * compatibility, but this resolver handles the new slugged whitelist IDs.
 */
export class NudgeIdentifierResolverService {
    private static instance: NudgeIdentifierResolverService;

    private constructor() {}

    static getInstance(): NudgeIdentifierResolverService {
        if (!NudgeIdentifierResolverService.instance) {
            NudgeIdentifierResolverService.instance = new NudgeIdentifierResolverService();
        }
        return NudgeIdentifierResolverService.instance;
    }

    resolveNudgeIdentifier(nudgeIdentifier: string): string | null {
        return this.resolveNudgeIdentifierWithMap(
            nudgeIdentifier,
            this.buildAvailableNudgeIdMap()
        );
    }

    resolveNudgeIdentifiers(nudgeIdentifiers: string[]): NudgeIdentifierResolution {
        const availableNudgeIds = this.buildAvailableNudgeIdMap();
        const resolvedNudgeEventIds: string[] = [];
        const unresolvedIdentifiers: string[] = [];

        for (const rawIdentifier of nudgeIdentifiers) {
            const resolvedEventId = this.resolveNudgeIdentifierWithMap(
                rawIdentifier,
                availableNudgeIds
            );

            if (!resolvedEventId) {
                unresolvedIdentifiers.push(rawIdentifier);
                continue;
            }

            resolvedNudgeEventIds.push(resolvedEventId);
        }

        return {
            resolvedNudgeEventIds: [...new Set(resolvedNudgeEventIds)],
            unresolvedIdentifiers,
        };
    }

    private resolveNudgeIdentifierWithMap(
        rawIdentifier: string,
        availableNudgeIds: Map<string, string>
    ): string | null {
        const normalizedIdentifier = rawIdentifier.trim().toLowerCase();
        if (!normalizedIdentifier) {
            return null;
        }

        return (
            availableNudgeIds.get(normalizedIdentifier) ??
            (FULL_EVENT_ID_REGEX.test(normalizedIdentifier) ? normalizedIdentifier : null)
        );
    }

    private buildAvailableNudgeIdMap(): Map<string, string> {
        const availableNudges = NudgeSkillWhitelistService.getInstance().getWhitelistedNudges();
        const availableNudgeIds = new Map<string, string>();

        for (const nudge of availableNudges) {
            const canonicalEventId = nudge.eventId.toLowerCase();
            availableNudgeIds.set(canonicalEventId, canonicalEventId);
            availableNudgeIds.set(
                (nudge.identifier ?? nudge.shortId ?? shortenEventId(canonicalEventId)).toLowerCase(),
                canonicalEventId
            );
            availableNudgeIds.set(
                (nudge.shortId ?? shortenEventId(canonicalEventId)).toLowerCase(),
                canonicalEventId
            );
        }

        return availableNudgeIds;
    }
}
