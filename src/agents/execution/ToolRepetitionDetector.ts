
interface ToolCall {
    tool: string;
    args: string;
    timestamp: number;
}

export class ToolRepetitionDetector {
    private recentToolCalls: ToolCall[] = [];
    private readonly maxHistory: number;
    private readonly repetitionThreshold: number;

    constructor(maxHistory: number = 20, repetitionThreshold: number = 3) {
        this.maxHistory = maxHistory;
        this.repetitionThreshold = repetitionThreshold;
    }

    /**
     * Check if a tool call is being repeated excessively
     * Returns a warning message if repetition is detected, null otherwise
     */
    checkRepetition(tool: string, args: unknown): string | null {
        const argsStr = JSON.stringify(args);
        const now = Date.now();
        
        // Add current call to history
        this.recentToolCalls.push({ tool, args: argsStr, timestamp: now });
        
        // Keep history size limited
        if (this.recentToolCalls.length > this.maxHistory) {
            this.recentToolCalls.shift();
        }
        
        // Count similar recent calls (same tool and args)
        const similarCalls = this.recentToolCalls.filter(
            call => call.tool === tool && call.args === argsStr
        );
        
        if (similarCalls.length >= this.repetitionThreshold) {
            return this.generateWarningMessage(tool, similarCalls.length);
        }
        
        return null;
    }

    /**
     * Generate a warning message for repeated tool calls
     */
    private generateWarningMessage(tool: string, count: number): string {
        return `⚠️ SYSTEM: You have called the '${tool}' tool ${count} times with identical parameters. ` +
               `The tool is working correctly and returning results. ` +
               `Please process the tool output and continue with your task, or try a different approach. ` +
               `Do not call this tool again with the same parameters.`;
    }

    /**
     * Clear the history of tool calls
     */
    clearHistory(): void {
        this.recentToolCalls = [];
    }

    /**
     * Get the current number of tracked calls
     */
    getHistorySize(): number {
        return this.recentToolCalls.length;
    }
}