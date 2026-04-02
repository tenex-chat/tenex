import { slugifyIdentifier } from "@/lib/string";
import { shortenEventId } from "@/utils/conversation-id";

export interface CapabilityIdentifierSource {
    eventId: string;
    dTag?: string | null;
    name?: string | null;
    title?: string | null;
}

export interface CapabilityIdentifier {
    identifier: string;
    shortId: string;
}

function getPreferredIdentifier(source: CapabilityIdentifierSource): CapabilityIdentifier {
    const shortId = shortenEventId(source.eventId);
    const candidates = [source.dTag, source.name, source.title];

    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }

        const slug = slugifyIdentifier(candidate);
        if (slug.length > 0) {
            return { identifier: slug, shortId };
        }
    }

    return { identifier: shortId, shortId };
}

/**
 * Build stable prompt-facing identifiers for a list of skills.
 *
 * Slugged d-tag/name/title identifiers are preferred. When multiple items
 * collapse to the same slug, they fall back to their short event IDs so the
 * prompt never advertises an ambiguous identifier.
 */
export function assignCapabilityIdentifiers(
    sources: CapabilityIdentifierSource[]
): Map<string, CapabilityIdentifier> {
    const preferredEntries = sources.map((source) => ({
        source,
        preferred: getPreferredIdentifier(source),
    }));

    const preferredCounts = new Map<string, number>();
    for (const entry of preferredEntries) {
        preferredCounts.set(
            entry.preferred.identifier,
            (preferredCounts.get(entry.preferred.identifier) ?? 0) + 1
        );
    }

    const results = new Map<string, CapabilityIdentifier>();
    const usedIdentifiers = new Map<string, string>();

    for (const entry of preferredEntries) {
        const preferredId = entry.preferred.identifier;
        const shortId = entry.preferred.shortId;
        let identifier = preferredId;

        if ((preferredCounts.get(preferredId) ?? 0) > 1) {
            identifier = shortId;
        }

        const existingEventId = usedIdentifiers.get(identifier);
        if (existingEventId && existingEventId !== entry.source.eventId) {
            identifier =
                identifier === shortId
                    ? `${preferredId}-${shortId}`
                    : shortId;
        }

        results.set(entry.source.eventId, {
            identifier,
            shortId,
        });
        usedIdentifiers.set(identifier, entry.source.eventId);
    }

    return results;
}
