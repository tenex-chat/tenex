import type { LanguageModelV2CallOptions } from "@ai-sdk/provider";
import crypto from "crypto";

/**
 * Creates a stable hash of a request for matching interactions.
 * The hash is based on the prompt messages only, ignoring other parameters
 * like temperature, maxTokens, etc. This allows matching interactions
 * even if non-critical parameters change.
 *
 * @param request - The request to hash
 * @returns A 16-character hex hash
 */
export function hashRequest(request: LanguageModelV2CallOptions): string {
    // Extract only the prompt for hashing
    // This makes the hash stable across parameter changes
    const hashInput = JSON.stringify(request.prompt, null, 0);

    // Create SHA-256 hash and take first 16 chars
    const hash = crypto.createHash("sha256").update(hashInput).digest("hex");
    return hash.substring(0, 16);
}

/**
 * Creates a human-readable explanation of what a hash represents.
 * This helps developers understand what interaction a hash corresponds to.
 *
 * @param request - The request that was hashed
 * @returns A human-readable string describing the request
 */
export function explainHash(request: LanguageModelV2CallOptions): string {
    const parts: string[] = [];

    // Count messages by role
    const roleCounts = new Map<string, number>();
    for (const message of request.prompt) {
        const role = message.role;
        roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
    }

    // Format role counts
    const roleStrs = Array.from(roleCounts.entries())
        .map(([role, count]) => `${count} ${role}`)
        .join(", ");
    parts.push(roleStrs);

    // Add tool information if present
    if (request.tools && request.tools.length > 0) {
        const toolNames = request.tools
            .map((tool) => {
                if ("name" in tool) return tool.name;
                return "provider-tool";
            })
            .join(", ");
        parts.push(`tools: ${toolNames}`);
    }

    // Get a snippet of the last message
    const lastMessage = request.prompt[request.prompt.length - 1];
    if (lastMessage && Array.isArray(lastMessage.content)) {
        const textParts = lastMessage.content
            .filter((part) => part.type === "text")
            .map((part) => ("text" in part ? part.text : ""))
            .join(" ");
        if (textParts) {
            const snippet = textParts.substring(0, 50);
            parts.push(`"${snippet}${textParts.length > 50 ? "..." : ""}"`);
        }
    }

    return parts.join(" | ");
}
