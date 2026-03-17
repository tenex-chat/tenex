export interface IdentityLookup {
    principalId?: string;
    linkedPubkey?: string;
    displayName?: string;
    username?: string;
    fallbackName?: string;
    kind?: "agent" | "human" | "system";
}

export interface IdentityBinding extends IdentityLookup {
    principalId: string;
    transport: string;
    updatedAt: number;
}
