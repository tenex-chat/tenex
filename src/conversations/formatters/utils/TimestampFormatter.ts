export class TimestampFormatter {
  /**
   * Format a timestamp according to the specified format
   */
  format(timestamp: Date, format: "relative" | "absolute" | "time-only"): string {
    switch (format) {
      case "relative":
        return this.formatRelative(timestamp);
      case "absolute":
        return this.formatAbsolute(timestamp);
      case "time-only":
        return this.formatTimeOnly(timestamp);
      default:
        return "";
    }
  }
  
  private formatRelative(timestamp: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - timestamp.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);
    
    if (diffSec < 60) {
      return ` [${diffSec}s ago]`;
    } else if (diffMin < 60) {
      return ` [${diffMin}m ago]`;
    } else if (diffHour < 24) {
      return ` [${diffHour}h ago]`;
    } else {
      return ` [${diffDay}d ago]`;
    }
  }
  
  private formatAbsolute(timestamp: Date): string {
    const year = timestamp.getFullYear();
    const month = String(timestamp.getMonth() + 1).padStart(2, "0");
    const day = String(timestamp.getDate()).padStart(2, "0");
    const hour = String(timestamp.getHours()).padStart(2, "0");
    const minute = String(timestamp.getMinutes()).padStart(2, "0");
    const second = String(timestamp.getSeconds()).padStart(2, "0");
    
    return ` [${year}-${month}-${day} ${hour}:${minute}:${second}]`;
  }
  
  private formatTimeOnly(timestamp: Date): string {
    const hour = String(timestamp.getHours()).padStart(2, "0");
    const minute = String(timestamp.getMinutes()).padStart(2, "0");
    const second = String(timestamp.getSeconds()).padStart(2, "0");
    
    return ` [${hour}:${minute}:${second}]`;
  }
}