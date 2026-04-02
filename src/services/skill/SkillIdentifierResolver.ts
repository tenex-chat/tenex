import { SkillWhitelistService } from "./SkillWhitelistService";
import { shortenEventId } from "@/utils/conversation-id";

const FULL_EVENT_ID_REGEX = /^[0-9a-f]{64}$/;

export interface SkillIdentifierResolution {
    resolvedSkillEventIds: string[];
    unresolvedIdentifiers: string[];
}

/**
 * Resolves prompt-facing skill identifiers into canonical skill event IDs.
 * Delegate still allows unresolved raw IDs to pass through for backward
 * compatibility, but this resolver handles the slugged whitelist IDs.
 */
export class SkillIdentifierResolver {
    private static instance: SkillIdentifierResolver;

    private constructor() {}

    static getInstance(): SkillIdentifierResolver {
        if (!SkillIdentifierResolver.instance) {
            SkillIdentifierResolver.instance = new SkillIdentifierResolver();
        }
        return SkillIdentifierResolver.instance;
    }

    resolveSkillIdentifier(skillIdentifier: string): string | null {
        return this.resolveSkillIdentifierWithMap(
            skillIdentifier,
            this.buildAvailableSkillIdMap()
        );
    }

    resolveSkillIdentifiers(skillIdentifiers: string[]): SkillIdentifierResolution {
        const availableSkillIds = this.buildAvailableSkillIdMap();
        const resolvedSkillEventIds: string[] = [];
        const unresolvedIdentifiers: string[] = [];

        for (const rawIdentifier of skillIdentifiers) {
            const resolvedEventId = this.resolveSkillIdentifierWithMap(
                rawIdentifier,
                availableSkillIds
            );

            if (!resolvedEventId) {
                unresolvedIdentifiers.push(rawIdentifier);
                continue;
            }

            resolvedSkillEventIds.push(resolvedEventId);
        }

        return {
            resolvedSkillEventIds: [...new Set(resolvedSkillEventIds)],
            unresolvedIdentifiers,
        };
    }

    private resolveSkillIdentifierWithMap(
        rawIdentifier: string,
        availableSkillIds: Map<string, string>
    ): string | null {
        const normalizedIdentifier = rawIdentifier.trim().toLowerCase();
        if (!normalizedIdentifier) {
            return null;
        }

        return (
            availableSkillIds.get(normalizedIdentifier) ??
            (FULL_EVENT_ID_REGEX.test(normalizedIdentifier) ? normalizedIdentifier : null)
        );
    }

    private buildAvailableSkillIdMap(): Map<string, string> {
        const availableSkills = SkillWhitelistService.getInstance().getWhitelistedSkills();
        const availableSkillIds = new Map<string, string>();

        for (const skill of availableSkills) {
            const canonicalEventId = skill.eventId.toLowerCase();
            availableSkillIds.set(canonicalEventId, canonicalEventId);
            availableSkillIds.set(
                (skill.identifier ?? skill.shortId ?? shortenEventId(canonicalEventId)).toLowerCase(),
                canonicalEventId
            );
            availableSkillIds.set(
                (skill.shortId ?? shortenEventId(canonicalEventId)).toLowerCase(),
                canonicalEventId
            );
        }

        return availableSkillIds;
    }
}
