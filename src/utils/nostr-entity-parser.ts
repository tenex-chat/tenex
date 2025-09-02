import NDK, { NDKEvent, NDKUser } from '@nostr-dev-kit/ndk';

/**
 * Parses various Nostr user identifier formats into a pubkey
 * Handles: npub, nprofile, hex pubkey, with or without "nostr:" prefix
 * 
 * @param input - The user identifier in various formats
 * @param ndk - NDK instance for validation
 * @returns The parsed pubkey or null if invalid
 */
export function parseNostrUser(input: string | undefined, ndk?: NDK): string | null {
    if (!input) return null;
    
    try {
        // Strip nostr: prefix if present
        let cleaned = input.trim();
        if (cleaned.startsWith('nostr:')) {
            cleaned = cleaned.substring(6);
        }
        
        // Handle npub format
        if (cleaned.startsWith('npub1')) {
            const user = new NDKUser({ npub: cleaned });
            return user.pubkey;
        }
        
        // Handle nprofile format
        if (cleaned.startsWith('nprofile1')) {
            const user = new NDKUser({ nprofile: cleaned });
            return user.pubkey;
        }
        
        // Assume it's a hex pubkey - validate format
        if (/^[0-9a-fA-F]{64}$/.test(cleaned)) {
            return cleaned.toLowerCase();
        }
        
        // Try to create user anyway in case it's a valid format we didn't check
        try {
            const user = new NDKUser({ pubkey: cleaned });
            if (user.pubkey && /^[0-9a-fA-F]{64}$/.test(user.pubkey)) {
                return user.pubkey;
            }
        } catch {
            // Ignore and return null
        }
        
        return null;
    } catch (error) {
        console.debug('Failed to parse Nostr user identifier:', input, error);
        return null;
    }
}

/**
 * Parses various Nostr event identifier formats and fetches the event
 * Handles: nevent, note, naddr, hex event id, with or without "nostr:" prefix
 * 
 * @param input - The event identifier in various formats
 * @param ndk - NDK instance for fetching
 * @returns The fetched event or null if not found/invalid
 */
export async function parseNostrEvent(input: string | undefined, ndk: NDK): Promise<NDKEvent | null> {
    if (!input) return null;
    
    try {
        // Strip nostr: prefix if present
        let cleaned = input.trim();
        if (cleaned.startsWith('nostr:')) {
            cleaned = cleaned.substring(6);
        }
        
        // Try to fetch directly - NDK handles various formats
        if (cleaned.startsWith('nevent1') || cleaned.startsWith('note1') || cleaned.startsWith('naddr1')) {
            const event = await ndk.fetchEvent(cleaned);
            return event;
        }
        
        // Try as hex event ID
        if (/^[0-9a-fA-F]{64}$/.test(cleaned)) {
            const event = await ndk.fetchEvent(cleaned);
            return event;
        }
        
        // Last attempt - try to fetch as-is
        const event = await ndk.fetchEvent(cleaned);
        return event;
    } catch (error) {
        console.debug('Failed to parse/fetch Nostr event:', input, error);
        return null;
    }
}

/**
 * Validates and normalizes a Nostr identifier, removing prefixes
 * Returns the cleaned identifier or null if invalid
 */
export function normalizeNostrIdentifier(input: string | undefined): string | null {
    if (!input) return null;
    
    let cleaned = input.trim();
    if (cleaned.startsWith('nostr:')) {
        cleaned = cleaned.substring(6);
    }
    
    // Basic validation - should be bech32 or hex
    if (cleaned.match(/^(npub1|nprofile1|nevent1|note1|nsec1|naddr1)[0-9a-z]+$/i) ||
        cleaned.match(/^[0-9a-fA-F]{64}$/)) {
        return cleaned;
    }
    
    return null;
}