import { getPubkeyService } from "@/services/PubkeyService";
import { PUBKEY_DISPLAY_LENGTH } from "@/utils/nostr-entity-parser";

export interface IdentityDisplayLookup {
    principalId?: string;
    linkedPubkey?: string;
    displayName?: string;
    username?: string;
}

function getPrincipalDisplayName(lookup: IdentityDisplayLookup): string | undefined {
    if (lookup.displayName?.trim()) {
        return lookup.displayName.trim();
    }

    if (lookup.username?.trim()) {
        return lookup.username.trim();
    }

    return undefined;
}

function isFallbackPubkeyLabel(name: string | undefined, pubkey: string | undefined): boolean {
    if (!name?.trim()) {
        return true;
    }

    if (name.trim().toLowerCase() === "unknown") {
        return true;
    }

    return pubkey !== undefined && name.trim() === pubkey.substring(0, PUBKEY_DISPLAY_LENGTH);
}

function shortenPrincipalId(principalId: string | undefined): string | undefined {
    if (!principalId) {
        return undefined;
    }

    const terminalSegment = principalId.split(":").pop();
    if (terminalSegment?.trim()) {
        return terminalSegment.substring(0, PUBKEY_DISPLAY_LENGTH);
    }

    return principalId.substring(0, PUBKEY_DISPLAY_LENGTH);
}

export class IdentityDisplayService {
    private static instance: IdentityDisplayService;

    private readonly pubkeyService = getPubkeyService();

    static getInstance(): IdentityDisplayService {
        if (!IdentityDisplayService.instance) {
            IdentityDisplayService.instance = new IdentityDisplayService();
        }
        return IdentityDisplayService.instance;
    }

    static resetInstance(): void {
        IdentityDisplayService.instance = undefined as unknown as IdentityDisplayService;
    }

    resolveDisplayNameSync(lookup: IdentityDisplayLookup): string {
        const principalName = getPrincipalDisplayName(lookup);
        const resolvedName =
            lookup.linkedPubkey && typeof this.pubkeyService.getNameSync === "function"
                ? this.pubkeyService.getNameSync(lookup.linkedPubkey)
                : undefined;

        if (principalName && isFallbackPubkeyLabel(resolvedName, lookup.linkedPubkey)) {
            return principalName;
        }

        if (resolvedName?.trim()) {
            return resolvedName;
        }

        if (principalName) {
            return principalName;
        }

        return (
            shortenPrincipalId(lookup.principalId) ??
            (lookup.linkedPubkey ? lookup.linkedPubkey.substring(0, PUBKEY_DISPLAY_LENGTH) : undefined) ??
            "Unknown"
        );
    }
}

export const getIdentityDisplayService = (): IdentityDisplayService =>
    IdentityDisplayService.getInstance();
