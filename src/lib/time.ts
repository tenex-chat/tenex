/**
 * Time formatting utilities
 */

/**
 * Format a timestamp into a human-readable "time ago" string
 */
export function formatTimeAgo(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const weeks = Math.floor(days / 7);
    const months = Math.floor(days / 30);

    if (months > 0) {
        return `${months} month${months > 1 ? "s" : ""} ago`;
    }
    if (weeks > 0) {
        return `${weeks} week${weeks > 1 ? "s" : ""} ago`;
    }
    if (days > 0) {
        return `${days} day${days > 1 ? "s" : ""} ago`;
    }
    if (hours > 0) {
        return `${hours} hour${hours > 1 ? "s" : ""} ago`;
    }
    if (minutes > 0) {
        return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
    }
    if (seconds > 30) {
        return `${seconds} seconds ago`;
    }
    return "just now";
}

/**
 * Format uptime from a start time
 */
export function formatUptime(startTime: Date | null): string {
    if (!startTime) return "N/A";
    const now = new Date();
    const diff = now.getTime() - startTime.getTime();
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    return `${hours}h ${minutes}m ${seconds}s`;
}
