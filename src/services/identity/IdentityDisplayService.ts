import { getPubkeyService } from "@/services/PubkeyService";
import { shortenPubkey } from "@/utils/conversation-id";

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

    return pubkey !== undefined && name.trim() === shortenPubkey(pubkey);
}

function shortenPrincipalId(principalId: string | undefined): string | undefined {
    if (!principalId) {
        return undefined;
    }

    const terminalSegment = principalId.split(":").pop();
    if (terminalSegment?.trim()) {
        return shortenPubkey(terminalSegment);
    }

    return shortenPubkey(principalId);
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
            (lookup.linkedPubkey ? shortenPubkey(lookup.linkedPubkey) : undefined) ??
            "Unknown"
        );
    }
}

export const getIdentityDisplayService = (): IdentityDisplayService =>
    IdentityDisplayService.getInstance();
