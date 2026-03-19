import { config } from "@/services/ConfigService";
import type { PrincipalRef } from "@/events/runtime/InboundEnvelope";

function toNostrPrincipalId(pubkey: string | undefined): string | undefined {
    return pubkey ? `nostr:${pubkey}` : undefined;
}

export class AuthorizedIdentityService {
    private static instance: AuthorizedIdentityService;

    private getConfiguredPrincipalIds(): Set<string> {
        const loadedConfig =
            typeof config.getConfig === "function"
                ? config.getConfig()
                : ((config as any).loadedConfig?.config ?? {});

        if (typeof (config as any).getWhitelistedIdentities === "function") {
            return new Set((config as any).getWhitelistedIdentities(loadedConfig));
        }

        const configured = new Set<string>();

        const whitelistedIdentities = Array.isArray((loadedConfig as any).whitelistedIdentities)
            ? (loadedConfig as any).whitelistedIdentities
            : [];
        for (const principalId of whitelistedIdentities) {
            if (typeof principalId === "string" && principalId.trim()) {
                configured.add(principalId.trim());
            }
        }

        const whitelistedPubkeys = Array.isArray((loadedConfig as any).whitelistedPubkeys)
            ? (loadedConfig as any).whitelistedPubkeys
            : [];
        for (const pubkey of whitelistedPubkeys) {
            if (typeof pubkey !== "string") {
                continue;
            }
            const nostrPrincipalId = toNostrPrincipalId(pubkey.trim());
            if (nostrPrincipalId) {
                configured.add(nostrPrincipalId);
            }
        }

        return configured;
    }

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
        const configured = this.getConfiguredPrincipalIds();
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
