/**
 * Utility functions for scheduling operations.
 * Shared between the scheduler service and tools.
 */

/**
 * Parse a relative time string (e.g., "5m", "2h", "3d") into milliseconds.
 * Supported formats:
 * - Xm: X minutes
 * - Xh: X hours
 * - Xd: X days
 *
 * @param delay - The delay string to parse
 * @returns The delay in milliseconds, or null if the format is invalid
 */
export function parseRelativeDelay(delay: string): number | null {
    const match = delay.match(/^(\d+(?:\.\d+)?)\s*(m|h|d)$/i);
    if (!match) {
        return null;
    }

    const value = Number.parseFloat(match[1]);
    const unit = match[2].toLowerCase();

    switch (unit) {
        case "m":
            return value * 60 * 1000; // minutes to ms
        case "h":
            return value * 60 * 60 * 1000; // hours to ms
        case "d":
            return value * 24 * 60 * 60 * 1000; // days to ms
        default:
            return null;
    }
}

/**
 * Format a delay string in human-readable form.
 *
 * @param delay - The delay string (e.g., "5m", "2h", "3d")
 * @returns A human-readable string (e.g., "5 minutes", "2 hours", "3 days")
 */
export function formatDelay(delay: string): string {
    const match = delay.match(/^(\d+(?:\.\d+)?)\s*(m|h|d)$/i);
    if (!match) return delay;

    const value = Number.parseFloat(match[1]);
    const unit = match[2].toLowerCase();

    const unitNames: Record<string, string> = {
        m: value === 1 ? "minute" : "minutes",
        h: value === 1 ? "hour" : "hours",
        d: value === 1 ? "day" : "days",
    };

    return `${value} ${unitNames[unit]}`;
}

/**
 * Format an ISO timestamp in a human-readable format with UTC timezone.
 * Handles invalid dates gracefully.
 *
 * @param isoString - The ISO date string to format
 * @returns A formatted string like "Jan 30, 2024, 10:00 AM UTC" or "Invalid date" for invalid input
 */
export function formatExecuteAt(isoString: string): string {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
        return "Invalid date";
    }

    return `${date.toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
    })} UTC`;
}
