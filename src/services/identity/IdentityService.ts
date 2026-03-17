import { getPubkeyService } from "@/services/PubkeyService";
import {
    IdentityBindingStore,
    getIdentityBindingStore,
} from "@/services/identity/IdentityBindingStoreService";
import type { IdentityBinding, IdentityLookup } from "@/services/identity/types";
import { PREFIX_LENGTH } from "@/utils/nostr-entity-parser";

function pickDisplayName(lookup: IdentityLookup | IdentityBinding): string | undefined {
    if (lookup.displayName?.trim()) {
        return lookup.displayName.trim();
    }
    if (lookup.username?.trim()) {
        return lookup.username.trim();
    }
    if (lookup.fallbackName?.trim()) {
        return lookup.fallbackName.trim();
    }
    return undefined;
}

function shortenPrincipalId(principalId: string): string {
    const terminalSegment = principalId.split(":").pop();
    if (terminalSegment?.trim()) {
        return terminalSegment.substring(0, PREFIX_LENGTH);
    }
    return principalId.substring(0, PREFIX_LENGTH);
}

export class IdentityService {
    private static instance: IdentityService;

    constructor(
        private readonly bindingStore: IdentityBindingStore = getIdentityBindingStore(),
        private readonly pubkeyServiceFactory: () => Pick<
            ReturnType<typeof getPubkeyService>,
            "getName" | "warmUserProfiles"
        > &
            Partial<Pick<ReturnType<typeof getPubkeyService>, "getNameSync">> = getPubkeyService
    ) {}

    static getInstance(): IdentityService {
        if (!IdentityService.instance) {
            IdentityService.instance = new IdentityService();
        }
        return IdentityService.instance;
    }

    static resetInstance(): void {
        IdentityService.instance = undefined as unknown as IdentityService;
    }

    rememberIdentity(lookup: IdentityLookup): IdentityBinding | undefined {
        return this.bindingStore.rememberIdentity(lookup);
    }

    linkPrincipalToPubkey(
        principalId: string,
        linkedPubkey: string,
        details: Omit<IdentityLookup, "principalId" | "linkedPubkey"> = {}
    ): IdentityBinding {
        return this.bindingStore.linkPrincipalToPubkey(principalId, linkedPubkey, details);
    }

    async getDisplayName(lookup: IdentityLookup): Promise<string> {
        const resolved = this.resolveLookup(lookup);
        if (resolved.linkedPubkey) {
            const pubkeyService = this.pubkeyServiceFactory();
            try {
                const linkedName = await pubkeyService.getName(resolved.linkedPubkey);
                if (!this.isLinkedPubkeyFallbackName(linkedName, resolved)) {
                    return linkedName;
                }
            } catch {
                const fallbackLinkedName = this.getLinkedPubkeyDisplayNameSync(resolved);
                if (fallbackLinkedName) {
                    return fallbackLinkedName;
                }
            }
        }

        return this.getFallbackDisplayName(resolved);
    }

    getDisplayNameSync(lookup: IdentityLookup): string {
        const resolved = this.resolveLookup(lookup);
        if (resolved.linkedPubkey) {
            const linkedName = this.getLinkedPubkeyDisplayNameSync(resolved);
            if (linkedName) {
                return linkedName;
            }
        }

        return this.getFallbackDisplayName(resolved);
    }

    async getName(pubkey: string): Promise<string> {
        return this.getDisplayName({ linkedPubkey: pubkey });
    }

    getNameSync(pubkey: string): string {
        return this.getDisplayNameSync({ linkedPubkey: pubkey });
    }

    async warmUserProfiles(pubkeys: string[]): Promise<Map<string, string>> {
        return this.pubkeyServiceFactory().warmUserProfiles(pubkeys);
    }

    private resolveLookup(lookup: IdentityLookup): IdentityLookup | IdentityBinding {
        if (!lookup.principalId) {
            return lookup;
        }

        const binding = this.bindingStore.rememberIdentity(lookup);
        if (!binding) {
            return lookup;
        }

        return {
            ...binding,
            ...lookup,
            linkedPubkey: lookup.linkedPubkey ?? binding.linkedPubkey,
            displayName: lookup.displayName ?? binding.displayName,
            username: lookup.username ?? binding.username,
            fallbackName: lookup.fallbackName ?? binding.fallbackName,
            kind: lookup.kind ?? binding.kind,
        };
    }

    private getLinkedPubkeyDisplayNameSync(lookup: IdentityLookup): string | undefined {
        const pubkeyService = this.pubkeyServiceFactory();
        if (typeof pubkeyService.getNameSync !== "function" || !lookup.linkedPubkey) {
            return undefined;
        }

        const linkedName = pubkeyService.getNameSync(lookup.linkedPubkey);
        if (this.isLinkedPubkeyFallbackName(linkedName, lookup)) {
            return undefined;
        }

        return linkedName;
    }

    private isLinkedPubkeyFallbackName(name: string | undefined, lookup: IdentityLookup): boolean {
        if (!name?.trim()) {
            return true;
        }

        if (name.trim().toLowerCase() === "unknown") {
            return true;
        }

        if (!lookup.linkedPubkey) {
            return false;
        }

        return name.trim() === lookup.linkedPubkey.substring(0, PREFIX_LENGTH);
    }

    private getFallbackDisplayName(lookup: IdentityLookup): string {
        const explicitName = pickDisplayName(lookup);
        if (explicitName) {
            return explicitName;
        }

        if (lookup.principalId) {
            return shortenPrincipalId(lookup.principalId);
        }

        if (lookup.linkedPubkey) {
            return lookup.linkedPubkey.substring(0, PREFIX_LENGTH);
        }

        return "Unknown";
    }
}

export const getIdentityService = (): IdentityService => IdentityService.getInstance();
