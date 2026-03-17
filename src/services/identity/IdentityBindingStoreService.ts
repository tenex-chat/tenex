import { config } from "@/services/ConfigService";
import type { IdentityBinding, IdentityLookup } from "@/services/identity/types";
import { logger } from "@/utils/logger";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function deriveTransport(principalId: string): string {
    return principalId.split(":")[0] || "unknown";
}

function hasMeaningfulChange(existing: IdentityBinding | undefined, next: IdentityBinding): boolean {
    if (!existing) return true;

    return (
        existing.linkedPubkey !== next.linkedPubkey ||
        existing.displayName !== next.displayName ||
        existing.username !== next.username ||
        existing.kind !== next.kind
    );
}

export class IdentityBindingStore {
    private static instance: IdentityBindingStore;
    private readonly bindings = new Map<string, IdentityBinding>();
    private loaded = false;

    constructor(
        private readonly storagePath: string = join(
            config.getConfigPath("data"),
            "identity-bindings.json"
        )
    ) {}

    static getInstance(): IdentityBindingStore {
        if (!IdentityBindingStore.instance) {
            IdentityBindingStore.instance = new IdentityBindingStore();
        }
        return IdentityBindingStore.instance;
    }

    static resetInstance(): void {
        IdentityBindingStore.instance = undefined as unknown as IdentityBindingStore;
    }

    getBinding(principalId: string): IdentityBinding | undefined {
        this.ensureLoaded();
        return this.bindings.get(principalId);
    }

    rememberIdentity(lookup: IdentityLookup): IdentityBinding | undefined {
        if (!lookup.principalId) {
            return undefined;
        }

        const existing = this.getBinding(lookup.principalId);
        const next: IdentityBinding = {
            principalId: lookup.principalId,
            transport: deriveTransport(lookup.principalId),
            linkedPubkey: lookup.linkedPubkey ?? existing?.linkedPubkey,
            displayName: lookup.displayName ?? existing?.displayName,
            username: lookup.username ?? existing?.username,
            kind: lookup.kind ?? existing?.kind,
            fallbackName: lookup.fallbackName ?? existing?.fallbackName,
            updatedAt: Date.now(),
        };

        if (!hasMeaningfulChange(existing, next)) {
            return existing;
        }

        this.bindings.set(lookup.principalId, next);
        this.persist();
        logger.debug("[IdentityBindingStore] Stored principal binding", {
            principalId: next.principalId,
            transport: next.transport,
            linkedPubkey: next.linkedPubkey,
            displayName: next.displayName,
        });
        return next;
    }

    linkPrincipalToPubkey(
        principalId: string,
        linkedPubkey: string,
        details: Omit<IdentityLookup, "principalId" | "linkedPubkey"> = {}
    ): IdentityBinding {
        return this.rememberIdentity({
            principalId,
            linkedPubkey,
            ...details,
        }) as IdentityBinding;
    }

    clear(): void {
        this.bindings.clear();
        this.loaded = true;
        this.persist();
    }

    private ensureLoaded(): void {
        if (this.loaded) {
            return;
        }

        this.loaded = true;

        if (!existsSync(this.storagePath)) {
            return;
        }

        try {
            const parsed = JSON.parse(readFileSync(this.storagePath, "utf8")) as IdentityBinding[];
            for (const binding of parsed) {
                if (binding.principalId) {
                    this.bindings.set(binding.principalId, binding);
                }
            }
        } catch (error) {
            logger.warn("[IdentityBindingStore] Failed to load identity bindings", {
                storagePath: this.storagePath,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private persist(): void {
        try {
            mkdirSync(dirname(this.storagePath), { recursive: true });
            writeFileSync(
                this.storagePath,
                `${JSON.stringify(Array.from(this.bindings.values()), null, 2)}\n`
            );
        } catch (error) {
            logger.error("[IdentityBindingStore] Failed to persist identity bindings", {
                storagePath: this.storagePath,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

export const getIdentityBindingStore = (): IdentityBindingStore =>
    IdentityBindingStore.getInstance();
