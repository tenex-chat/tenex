/**
 * Centralized validation utilities for common patterns
 */

/**
 * Validates if a string is a valid slug format (alphanumeric with hyphens and underscores)
 */
export function isValidSlug(name: string): boolean {
  return /^[a-zA-Z0-9-_]+$/.test(name);
}

/**
 * Validates if a filename has a markdown extension
 */
export function isMarkdownFile(filename: string): boolean {
  return filename.endsWith(".md");
}

/**
 * Validates if a string is a valid Nostr pubkey (64 hex characters)
 */
export function isValidPubkey(pubkey: string): boolean {
  return /^[a-fA-F0-9]{64}$/.test(pubkey);
}

/**
 * Validates if a string is a valid Nostr npub (starts with npub1)
 */
export function isValidNpub(npub: string): boolean {
  return npub.startsWith("npub1") && npub.length === 63;
}

/**
 * Validates if a path is absolute
 */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || (process.platform === "win32" && /^[a-zA-Z]:/.test(path));
}

/**
 * Validates if a string is a valid UUID v4
 */
export function isValidUuid(uuid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
}
