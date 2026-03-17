import { config } from "@/services/ConfigService";
import type { PrincipalRef } from "@/events/runtime/InboundEnvelope";

function toNostrPrincipalId(pubkey: string | undefined): string | undefined {
    return pubkey ? `nostr:${pubkey}` : undefined;
}

export class AuthorizedIdentityService {
    private static instance: AuthorizedIdentityService;

    static getInstance(): AuthorizedIdentityService {
        if (!AuthorizedIdentityService.instance) {
            AuthorizedIdentityService.instance = new AuthorizedIdentityService();
        }
        return AuthorizedIdentityService.instance;
    }

    isAuthorizedPrincipal(
        principal: Pick<PrincipalRef, "id" | "linkedPubkey">,
        additionalPrincipalIds: string[] = []
    ): boolean {
        const configured = new Set(config.getWhitelistedIdentities(config.getConfig()));
        for (const principalId of additionalPrincipalIds) {
            const trimmed = principalId.trim();
            if (trimmed) {
                configured.add(trimmed);
            }
        }

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
