/**
 * Nostr key derivation utilities
 *
 * This module provides helpers for working with Nostr keys.
 * All NDK key operations should be centralized here to maintain architectural boundaries.
 */
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

/**
 * Derive a public key from an nsec (private key)
 * @param nsec - The private key in nsec format
 * @returns The derived public key
 */
export function pubkeyFromNsec(nsec: string): string {
    const signer = new NDKPrivateKeySigner(nsec);
    return signer.pubkey;
}
