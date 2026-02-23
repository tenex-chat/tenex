/**
 * NIP-44 encryption/decryption helpers.
 *
 * Wraps NDK runtime objects (NDKUser) so that service-layer code
 * never needs to construct NDK instances directly.
 */

import { NDKUser } from "@nostr-dev-kit/ndk";
import type { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

/**
 * Decrypt NIP-44 encrypted content from a sender.
 *
 * @param senderPubkey - Hex pubkey of the sender
 * @param content - Encrypted content string
 * @param signer - The private key signer to decrypt with
 * @returns Decrypted plaintext string
 */
export async function nip44Decrypt(
    senderPubkey: string,
    content: string,
    signer: NDKPrivateKeySigner,
): Promise<string> {
    const sender = new NDKUser({ pubkey: senderPubkey });
    return signer.decrypt(sender, content, "nip44");
}
