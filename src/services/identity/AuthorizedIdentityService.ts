import { config } from "@/services/ConfigService";
import type { PrincipalRef } from "@/events/runtime/InboundEnvelope";

function toNostrPrincipalId(pubkey: string | undefined): string | undefined {
    return pubkey ? `nostr:${pubkey}` : undefined;
}

export class AuthorizedIdentityService {
    private static instance: AuthorizedIdentityService;

    private getConfiguredPrincipalIds(): Set<string> {
        return new Set(config.getWhitelistedIdentities());
    }

    static getInstance(): AuthorizedIdentityService {
        if (!AuthorizedIdentityService.instance) {
            AuthorizedIdentityService.instance = new AuthorizedIdentityService();
        }
        return AuthorizedIdentityService.instance;
    }

    isAuthorizedPrincipal(
        principal: Pick<PrincipalRef, "id" | "linkedPubkey">
    ): boolean {
        const configured = this.getConfiguredPrincipalIds();

        if (configured.has(principal.id)) {
            return true;
        }

        const nostrPrincipalId = toNostrPrincipalId(principal.linkedPubkey);
        if (nostrPrincipalId && configured.has(nostrPrincipalId)) {
            return true;
        }

        return false;
    }
}

export const getAuthorizedIdentityService = (): AuthorizedIdentityService =>
    AuthorizedIdentityService.getInstance();
