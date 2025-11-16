/**
 * Utility functions for handling End of Message (EOM) markers
 */

/**
 * Detect and strip the EOM marker from content
 * Returns the content without the marker and whether it was found
 */
export function detectAndStripEOM(content: string): { hasEOM: boolean; cleanContent: string } {
    const lines = content.split("\n");
    const lastLine = lines[lines.length - 1]?.trim();

    if (lastLine === "=== EOM ===" || lastLine === "EOM") {
        // Remove the EOM line
        lines.pop();
        return { hasEOM: true, cleanContent: lines.join("\n").trimEnd() };
    }

    // Also check for EOM on second-to-last line (in case of trailing newline)
    if (lines.length > 1) {
        const secondToLastLine = lines[lines.length - 2]?.trim();
        if (secondToLastLine === "=== EOM ===" || secondToLastLine === "EOM") {
            // Remove the EOM line and any trailing empty line
            lines.splice(-2);
            return { hasEOM: true, cleanContent: lines.join("\n").trimEnd() };
        }
    }

    return { hasEOM: false, cleanContent: content };
}
