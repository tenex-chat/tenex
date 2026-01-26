/**
 * SnippetExtractor - Pure utility for extracting search result snippets.
 *
 * Extracts snippets with 50-75 character TOTAL length (including matched text),
 * finding word boundaries for cleaner snippets.
 */

/** Maximum total snippet length (50-75 char target range) */
const MAX_SNIPPET_LENGTH = 75;

/**
 * Result of snippet extraction.
 */
export interface SnippetResult {
    /** The full snippet including context */
    snippet: string;
    /** The actual matched text */
    matchedText: string;
    /** Start index of match in original content */
    matchStart: number;
    /** End index of match in original content */
    matchEnd: number;
}

/**
 * Find the nearest word boundary before the given index.
 * Returns the index of the character after the boundary (space, punctuation, etc.)
 */
function findWordBoundaryBefore(text: string, index: number, minIndex: number): number {
    if (index <= minIndex) return minIndex;

    // Look for a space or punctuation within a reasonable range
    let pos = index;
    const lookbackLimit = Math.max(minIndex, index - 10); // Don't look too far back

    while (pos > lookbackLimit) {
        const char = text[pos - 1];
        if (char === " " || char === "\n" || char === "\t") {
            return pos; // Return position after the whitespace
        }
        if (char === "." || char === "," || char === ";" || char === ":" || char === "!" || char === "?") {
            return pos; // Return position after punctuation
        }
        pos--;
    }

    // No clean boundary found, use the calculated index
    return Math.max(minIndex, index);
}

/**
 * Find the nearest word boundary after the given index.
 * Returns the index of the boundary character.
 */
function findWordBoundaryAfter(text: string, index: number, maxIndex: number): number {
    if (index >= maxIndex) return maxIndex;

    // Look for a space or punctuation within a reasonable range
    let pos = index;
    const lookaheadLimit = Math.min(maxIndex, index + 10); // Don't look too far ahead

    while (pos < lookaheadLimit) {
        const char = text[pos];
        if (char === " " || char === "\n" || char === "\t") {
            return pos; // Return position of the whitespace
        }
        if (char === "." || char === "," || char === ";" || char === ":" || char === "?") {
            return pos + 1; // Include the punctuation
        }
        if (char === "!") {
            return pos + 1; // Include the punctuation
        }
        pos++;
    }

    // No clean boundary found, use the calculated index
    return Math.min(maxIndex, index);
}

/**
 * Extract a snippet from content around a search match.
 * Ensures TOTAL snippet length is between 50-75 characters.
 *
 * @param content - The full message content
 * @param searchText - The text that was searched for
 * @returns SnippetResult if match found, null otherwise
 */
export function extractSnippet(content: string, searchText: string): SnippetResult | null {
    if (!content || !searchText) return null;

    // Case-insensitive search
    const contentLower = content.toLowerCase();
    const searchLower = searchText.toLowerCase();

    const matchStart = contentLower.indexOf(searchLower);
    if (matchStart === -1) return null;

    const matchEnd = matchStart + searchText.length;
    const matchedText = content.substring(matchStart, matchEnd);
    const matchLength = matchedText.length;

    // If the match is exactly MAX_SNIPPET_LENGTH, return it as-is (no truncation needed)
    if (matchLength === MAX_SNIPPET_LENGTH) {
        return {
            snippet: matchedText,
            matchedText,
            matchStart,
            matchEnd,
        };
    }

    // If the match exceeds MAX_SNIPPET_LENGTH, truncate to 72 chars + "..." = 75 total
    if (matchLength > MAX_SNIPPET_LENGTH) {
        const truncateLength = MAX_SNIPPET_LENGTH - 3;
        const truncated = matchedText.substring(0, truncateLength);
        return {
            snippet: truncated + "...",
            matchedText: truncated,
            matchStart,
            matchEnd: matchStart + truncated.length,
        };
    }

    // Calculate available space for context (total snippet should be 50-75 chars)
    // Target: use up to MAX_SNIPPET_LENGTH total, at least MIN_SNIPPET_LENGTH if possible
    const availableContext = MAX_SNIPPET_LENGTH - matchLength;
    const contextPerSide = Math.floor(availableContext / 2);

    // Calculate ideal context boundaries
    let contextStart = Math.max(0, matchStart - contextPerSide);
    let contextEnd = Math.min(content.length, matchEnd + contextPerSide);

    // Adjust to word boundaries (but stay within our budget)
    if (contextStart > 0) {
        const adjustedStart = findWordBoundaryBefore(content, contextStart, Math.max(0, matchStart - contextPerSide - 5));
        // Only use adjusted start if it doesn't blow our budget
        if (matchEnd - adjustedStart + (contextEnd - matchEnd) <= MAX_SNIPPET_LENGTH) {
            contextStart = adjustedStart;
        }
    }
    if (contextEnd < content.length) {
        const adjustedEnd = findWordBoundaryAfter(content, contextEnd, Math.min(content.length, matchEnd + contextPerSide + 5));
        // Only use adjusted end if it doesn't blow our budget
        if (adjustedEnd - contextStart <= MAX_SNIPPET_LENGTH) {
            contextEnd = adjustedEnd;
        }
    }

    // Final enforcement: hard cap at MAX_SNIPPET_LENGTH
    if (contextEnd - contextStart > MAX_SNIPPET_LENGTH) {
        // Trim from whichever side has more context, prioritizing keeping the match centered
        const beforeMatch = matchStart - contextStart;
        const afterMatch = contextEnd - matchEnd;

        if (beforeMatch > afterMatch) {
            // Trim from start
            contextStart = contextEnd - MAX_SNIPPET_LENGTH;
        } else {
            // Trim from end
            contextEnd = contextStart + MAX_SNIPPET_LENGTH;
        }
    }

    // Ensure we don't cut into the match
    if (contextStart > matchStart) contextStart = matchStart;
    if (contextEnd < matchEnd) contextEnd = matchEnd;

    // Build snippet
    let snippet = content.substring(contextStart, contextEnd);

    // Normalize whitespace
    snippet = snippet.replace(/\s+/g, " ").trim();

    // Add ellipsis if truncated (but count them in length)
    const needsPrefixEllipsis = contextStart > 0;
    const needsSuffixEllipsis = contextEnd < content.length;

    // Adjust for ellipsis length (3 chars each)
    const ellipsisLength = (needsPrefixEllipsis ? 3 : 0) + (needsSuffixEllipsis ? 3 : 0);
    if (snippet.length + ellipsisLength > MAX_SNIPPET_LENGTH) {
        // Trim snippet to make room for ellipsis
        const targetLength = MAX_SNIPPET_LENGTH - ellipsisLength;
        if (snippet.length > targetLength) {
            // Trim evenly from both sides if possible
            const excess = snippet.length - targetLength;
            const trimStart = Math.floor(excess / 2);
            const trimEnd = excess - trimStart;
            snippet = snippet.substring(trimStart, snippet.length - trimEnd);
        }
    }

    if (needsPrefixEllipsis) {
        snippet = "..." + snippet;
    }
    if (needsSuffixEllipsis) {
        snippet = snippet + "...";
    }

    return {
        snippet,
        matchedText,
        matchStart,
        matchEnd,
    };
}

/**
 * Extract a snippet from content at a specific match position.
 * Used by extractAllSnippets to get snippets with proper context.
 *
 * @param content - The full message content
 * @param matchStart - Start index of the match in the original content
 * @param matchLength - Length of the matched text
 * @returns SnippetResult
 */
function extractSnippetAtPosition(content: string, matchStart: number, matchLength: number): SnippetResult {
    const matchEnd = matchStart + matchLength;
    const matchedText = content.substring(matchStart, matchEnd);

    // If the match is exactly MAX_SNIPPET_LENGTH, return it as-is (no truncation needed)
    if (matchLength === MAX_SNIPPET_LENGTH) {
        return {
            snippet: matchedText,
            matchedText,
            matchStart,
            matchEnd,
        };
    }

    // If the match exceeds MAX_SNIPPET_LENGTH, truncate to 72 chars + "..." = 75 total
    if (matchLength > MAX_SNIPPET_LENGTH) {
        const truncateLength = MAX_SNIPPET_LENGTH - 3;
        const truncated = matchedText.substring(0, truncateLength);
        return {
            snippet: truncated + "...",
            matchedText: truncated,
            matchStart,
            matchEnd: matchStart + truncated.length,
        };
    }

    // Calculate available space for context
    const availableContext = MAX_SNIPPET_LENGTH - matchLength;
    const contextPerSide = Math.floor(availableContext / 2);

    // Calculate ideal context boundaries
    let contextStart = Math.max(0, matchStart - contextPerSide);
    let contextEnd = Math.min(content.length, matchEnd + contextPerSide);

    // Adjust to word boundaries (but stay within our budget)
    if (contextStart > 0) {
        const adjustedStart = findWordBoundaryBefore(content, contextStart, Math.max(0, matchStart - contextPerSide - 5));
        if (matchEnd - adjustedStart + (contextEnd - matchEnd) <= MAX_SNIPPET_LENGTH) {
            contextStart = adjustedStart;
        }
    }
    if (contextEnd < content.length) {
        const adjustedEnd = findWordBoundaryAfter(content, contextEnd, Math.min(content.length, matchEnd + contextPerSide + 5));
        if (adjustedEnd - contextStart <= MAX_SNIPPET_LENGTH) {
            contextEnd = adjustedEnd;
        }
    }

    // Final enforcement: hard cap at MAX_SNIPPET_LENGTH
    if (contextEnd - contextStart > MAX_SNIPPET_LENGTH) {
        const beforeMatch = matchStart - contextStart;
        const afterMatch = contextEnd - matchEnd;

        if (beforeMatch > afterMatch) {
            contextStart = contextEnd - MAX_SNIPPET_LENGTH;
        } else {
            contextEnd = contextStart + MAX_SNIPPET_LENGTH;
        }
    }

    // Ensure we don't cut into the match
    if (contextStart > matchStart) contextStart = matchStart;
    if (contextEnd < matchEnd) contextEnd = matchEnd;

    // Build snippet
    let snippet = content.substring(contextStart, contextEnd);
    snippet = snippet.replace(/\s+/g, " ").trim();

    const needsPrefixEllipsis = contextStart > 0;
    const needsSuffixEllipsis = contextEnd < content.length;

    const ellipsisLength = (needsPrefixEllipsis ? 3 : 0) + (needsSuffixEllipsis ? 3 : 0);
    if (snippet.length + ellipsisLength > MAX_SNIPPET_LENGTH) {
        const targetLength = MAX_SNIPPET_LENGTH - ellipsisLength;
        if (snippet.length > targetLength) {
            const excess = snippet.length - targetLength;
            const trimStart = Math.floor(excess / 2);
            const trimEnd = excess - trimStart;
            snippet = snippet.substring(trimStart, snippet.length - trimEnd);
        }
    }

    if (needsPrefixEllipsis) {
        snippet = "..." + snippet;
    }
    if (needsSuffixEllipsis) {
        snippet = snippet + "...";
    }

    return {
        snippet,
        matchedText,
        matchStart,
        matchEnd,
    };
}

/**
 * Extract all snippets from content for a search term.
 * Computes snippets against full content with proper offsets.
 *
 * @param content - The full message content
 * @param searchText - The text to search for
 * @param maxSnippets - Maximum number of snippets to return (default: 3)
 */
export function extractAllSnippets(
    content: string,
    searchText: string,
    maxSnippets: number = 3
): SnippetResult[] {
    if (!content || !searchText) return [];

    const results: SnippetResult[] = [];
    const contentLower = content.toLowerCase();
    const searchLower = searchText.toLowerCase();

    let startPos = 0;
    while (results.length < maxSnippets) {
        const matchStart = contentLower.indexOf(searchLower, startPos);
        if (matchStart === -1) break;

        // Extract snippet using the full content with the correct match position
        const result = extractSnippetAtPosition(content, matchStart, searchText.length);
        results.push(result);

        startPos = matchStart + searchText.length;
    }

    return results;
}
