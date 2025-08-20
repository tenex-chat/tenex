/**
 * Conversational logger that formats test output as a natural dialog
 * showing phase transitions and agent interactions
 */
export class ConversationalLogger {
  private static instance: ConversationalLogger;
  private conversationStartTime: Date = new Date();
  private lastPhase = "CHAT";
  private currentAgent: string | null = null;

  static getInstance(): ConversationalLogger {
    if (!ConversationalLogger.instance) {
      ConversationalLogger.instance = new ConversationalLogger();
    }
    return ConversationalLogger.instance;
  }

  private formatTime(): string {
    const elapsed = Date.now() - this.conversationStartTime.getTime();
    const seconds = Math.floor(elapsed / 1000);
    const minutes = Math.floor(seconds / 60);
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }

  private formatAgentName(agentName: string): string {
    // Capitalize and format agent names nicely
    return agentName
      .replace(/([a-z])([A-Z])/g, "$1 $2") // Add space before capitals
      .replace(/^\w/, (c) => c.toUpperCase()) // Capitalize first letter
      .replace(/-/g, " "); // Replace hyphens with spaces
  }

  private getAgentSlug(agentName: string): string {
    // Convert to lowercase slug format
    return agentName.toLowerCase().replace(/\s+/g, "-");
  }

  private formatLogLine(
    agentName: string | null,
    emoji: string,
    timeStamp: string,
    message: string
  ): string {
    const agentPrefix = agentName ? `[${this.getAgentSlug(agentName)}] ` : "";
    return `${emoji} [${timeStamp}] ${agentPrefix}${message}`;
  }

  logAgentThinking(
    agentName: string,
    context: {
      phase?: string;
      userMessage?: string;
      iteration?: number;
      agentIteration?: number;
    }
  ): void {
    this.currentAgent = agentName;
    const formattedAgent = this.formatAgentName(agentName);
    const timeStamp = this.formatTime();

    // Check if phase changed
    if (context.phase && context.phase !== this.lastPhase) {
      this.logPhaseTransition(this.lastPhase, context.phase);
      this.lastPhase = context.phase;
    }

    if (context.userMessage) {
      const message = `${formattedAgent} received: "${context.userMessage.substring(0, 60)}${context.userMessage.length > 60 ? "..." : ""}"`;
      console.log(`\n${this.formatLogLine(agentName, "🎯", timeStamp, message)}`);
    }

    const message = `${formattedAgent} is thinking...`;
    console.log(this.formatLogLine(agentName, "🤔", timeStamp, message));
  }

  logAgentResponse(
    agentName: string,
    response: {
      content?: string;
      toolCalls?: unknown[];
      phase?: string;
      reason?: string;
    }
  ): void {
    const formattedAgent = this.formatAgentName(agentName);
    const timeStamp = this.formatTime();

    if (response.content) {
      // Format routing decisions nicely
      if (agentName.toLowerCase() === "orchestrator") {
        try {
          const routing = JSON.parse(response.content);
          if (routing.agents && routing.phase && routing.reason) {
            const message = `${formattedAgent}: "I'll route this to ${routing.agents.join(", ")} in ${routing.phase} phase - ${routing.reason}"`;
            console.log(this.formatLogLine(agentName, "🎯", timeStamp, message));
            return;
          }
        } catch {
          // Not a JSON routing response, handle normally
        }
      }

      const truncatedContent =
        response.content.length > 80 ? `${response.content.substring(0, 80)}...` : response.content;
      const message = `${formattedAgent}: "${truncatedContent}"`;
      console.log(this.formatLogLine(agentName, "💬", timeStamp, message));
    }

    if (response.toolCalls && response.toolCalls.length > 0) {
      for (const toolCall of response.toolCalls) {
        const toolName =
          typeof toolCall.function === "string"
            ? toolCall.function
            : toolCall.function?.name || toolCall.name || "unknown";

        this.logToolExecution(agentName, toolName, toolCall);
      }
    }
  }

  logToolExecution(agentName: string, toolName: string, toolCall: unknown): void {
    const formattedAgent = this.formatAgentName(agentName);
    const timeStamp = this.formatTime();

    switch (toolName) {
      case "continue":
        try {
          const args =
            typeof toolCall.function === "string"
              ? JSON.parse(toolCall.args || "{}")
              : JSON.parse(toolCall.function?.arguments || "{}");

          if (args.agents) {
            const message = `${formattedAgent}: "Passing control to ${args.agents.join(", ")} - ${args.reason || "continuing workflow"}"`;
            console.log(this.formatLogLine(agentName, "🔄", timeStamp, message));
          } else {
            const message = `${formattedAgent}: "Continuing with next phase - ${args.summary || args.reason || "proceeding"}"`;
            console.log(this.formatLogLine(agentName, "🔄", timeStamp, message));
          }
        } catch {
          const message = `${formattedAgent}: "Continuing workflow..."`;
          console.log(this.formatLogLine(agentName, "🔄", timeStamp, message));
        }
        break;

      case "complete":
        try {
          const args =
            typeof toolCall.function === "string"
              ? JSON.parse(toolCall.args || "{}")
              : JSON.parse(toolCall.function?.arguments || "{}");
          const message = `${formattedAgent}: "Task completed - ${args.finalResponse || args.summary || "done"}"`;
          console.log(this.formatLogLine(agentName, "✅", timeStamp, message));
        } catch {
          const message = `${formattedAgent}: "Task completed successfully"`;
          console.log(this.formatLogLine(agentName, "✅", timeStamp, message));
        }
        break;

      case "shell":
        try {
          const args =
            typeof toolCall.function === "string"
              ? JSON.parse(toolCall.args || "{}")
              : JSON.parse(toolCall.function?.arguments || "{}");
          const message = `${formattedAgent}: "Executing: ${args.command}"`;
          console.log(this.formatLogLine(agentName, "⚡", timeStamp, message));
        } catch {
          const message = `${formattedAgent}: "Executing shell command..."`;
          console.log(this.formatLogLine(agentName, "⚡", timeStamp, message));
        }
        break;

      case "generateInventory":
        try {
          const args =
            typeof toolCall.function === "string"
              ? JSON.parse(toolCall.args || "{}")
              : JSON.parse(toolCall.function?.arguments || "{}");
          const message = `${formattedAgent}: "Analyzing project structure in ${args.paths?.join(", ") || "current directory"}"`;
          console.log(this.formatLogLine(agentName, "📋", timeStamp, message));
        } catch {
          const message = `${formattedAgent}: "Generating project inventory..."`;
          console.log(this.formatLogLine(agentName, "📋", timeStamp, message));
        }
        break;

      case "writeFile":
      case "writeContextFile":
        try {
          const args =
            typeof toolCall.function === "string"
              ? JSON.parse(toolCall.args || "{}")
              : JSON.parse(toolCall.function?.arguments || "{}");
          const message = `${formattedAgent}: "Writing to ${args.path || args.filename || "file"}"`;
          console.log(this.formatLogLine(agentName, "📝", timeStamp, message));
        } catch {
          const message = `${formattedAgent}: "Writing file..."`;
          console.log(this.formatLogLine(agentName, "📝", timeStamp, message));
        }
        break;

      default: {
        const message = `${formattedAgent}: "Using ${toolName} tool"`;
        console.log(this.formatLogLine(agentName, "🔧", timeStamp, message));
      }
    }
  }

  logPhaseTransition(fromPhase: string, toPhase: string): void {
    const timeStamp = this.formatTime();
    console.log(`\n📍 [${timeStamp}] Phase transition: ${fromPhase} → ${toPhase}`);
  }

  logError(agentName: string, error: string): void {
    const formattedAgent = this.formatAgentName(agentName);
    const timeStamp = this.formatTime();
    const message = `${formattedAgent}: "Error occurred - ${error}"`;
    console.log(this.formatLogLine(agentName, "❌", timeStamp, message));
  }

  logTestStart(testName: string): void {
    this.conversationStartTime = new Date();
    this.lastPhase = "CHAT";
    console.log(`\n🎬 Starting test: ${testName}`);
    console.log(`📅 ${this.conversationStartTime.toISOString()}`);
    console.log(`${"=".repeat(60)}\n`);
  }

  logTestEnd(success: boolean, testName?: string): void {
    const timeStamp = this.formatTime();
    const status = success ? "✅ PASSED" : "❌ FAILED";
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🏁 [${timeStamp}] Test completed: ${status} ${testName || ""}`);
  }

  logMatchedResponse(mockResponse: unknown): void {
    const timeStamp = this.formatTime();
    const trigger = mockResponse.trigger;
    const agentName = trigger.agentName || this.currentAgent;

    let triggerDescription = "";
    if (trigger.agentName) {
      triggerDescription += `Agent: ${this.formatAgentName(trigger.agentName)}`;
    }
    if (trigger.phase) {
      triggerDescription += `, Phase: ${trigger.phase}`;
    }
    if (trigger.userMessage) {
      const msgPreview = trigger.userMessage.toString().substring(0, 30);
      triggerDescription += `, Message: "${msgPreview}..."`;
    }

    const message = `Mock matched (${triggerDescription})`;
    console.log(this.formatLogLine(agentName, "🎯", timeStamp, message));

    if (mockResponse.response.content) {
      const preview = mockResponse.response.content.substring(0, 50);
      console.log(
        `   → Response: "${preview}${mockResponse.response.content.length > 50 ? "..." : ""}"`
      );
    }

    // Log tool calls if present
    if (mockResponse.response.toolCalls && mockResponse.response.toolCalls.length > 0) {
      const toolNames = mockResponse.response.toolCalls.map((tc: unknown) => {
        const toolName = tc.function?.name || tc.name || "unknown";
        return toolName;
      });
      console.log(`   → Tools: [${toolNames.join(", ")}]`);
    }
  }

  reset(): void {
    this.conversationStartTime = new Date();
    this.lastPhase = "CHAT";
    this.currentAgent = null;
  }
}

// Export singleton instance
export const conversationalLogger = ConversationalLogger.getInstance();
