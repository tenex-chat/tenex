import { logger } from "@/utils/logger";

/**
 * Conversational logger that formats test output as a natural dialog
 * showing phase transitions and agent interactions
 */
export class ConversationalLogger {
    private static instance: ConversationalLogger;
    private conversationStartTime: Date = new Date();
    private lastPhase: string = "CHAT";

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
            .replace(/([a-z])([A-Z])/g, '$1 $2') // Add space before capitals
            .replace(/^\w/, c => c.toUpperCase()) // Capitalize first letter
            .replace(/-/g, ' '); // Replace hyphens with spaces
    }

    logAgentThinking(agentName: string, context: {
        phase?: string;
        userMessage?: string;
        iteration?: number;
        agentIteration?: number;
    }): void {
        const formattedAgent = this.formatAgentName(agentName);
        const timeStamp = this.formatTime();
        
        // Check if phase changed
        if (context.phase && context.phase !== this.lastPhase) {
            this.logPhaseTransition(this.lastPhase, context.phase);
            this.lastPhase = context.phase;
        }

        if (context.userMessage) {
            console.log(`\n🎯 [${timeStamp}] ${formattedAgent} received: "${context.userMessage.substring(0, 60)}${context.userMessage.length > 60 ? '...' : ''}"`);
        }
        
        console.log(`🤔 [${timeStamp}] ${formattedAgent} is thinking...`);
    }

    logAgentResponse(agentName: string, response: {
        content?: string;
        toolCalls?: any[];
        phase?: string;
        reason?: string;
    }): void {
        const formattedAgent = this.formatAgentName(agentName);
        const timeStamp = this.formatTime();
        
        if (response.content) {
            // Format routing decisions nicely
            if (agentName.toLowerCase() === 'orchestrator') {
                try {
                    const routing = JSON.parse(response.content);
                    if (routing.agents && routing.phase && routing.reason) {
                        console.log(`🎯 [${timeStamp}] ${formattedAgent}: "I'll route this to ${routing.agents.join(', ')} in ${routing.phase} phase - ${routing.reason}"`);
                        return;
                    }
                } catch (e) {
                    // Not a JSON routing response, handle normally
                }
            }
            
            const truncatedContent = response.content.length > 80 
                ? response.content.substring(0, 80) + '...' 
                : response.content;
            console.log(`💬 [${timeStamp}] ${formattedAgent}: "${truncatedContent}"`);
        }

        if (response.toolCalls && response.toolCalls.length > 0) {
            for (const toolCall of response.toolCalls) {
                const toolName = typeof toolCall.function === 'string' 
                    ? toolCall.function 
                    : toolCall.function?.name || toolCall.name || 'unknown';
                
                this.logToolExecution(agentName, toolName, toolCall);
            }
        }
    }

    logToolExecution(agentName: string, toolName: string, toolCall: any): void {
        const formattedAgent = this.formatAgentName(agentName);
        const timeStamp = this.formatTime();
        
        switch (toolName) {
            case 'continue':
                try {
                    const args = typeof toolCall.function === 'string' 
                        ? JSON.parse(toolCall.args || '{}')
                        : JSON.parse(toolCall.function?.arguments || '{}');
                    
                    if (args.agents) {
                        console.log(`🔄 [${timeStamp}] ${formattedAgent}: "Passing control to ${args.agents.join(', ')} - ${args.reason || 'continuing workflow'}"`);
                    } else {
                        console.log(`🔄 [${timeStamp}] ${formattedAgent}: "Continuing with next phase - ${args.summary || args.reason || 'proceeding'}"`);
                    }
                } catch (e) {
                    console.log(`🔄 [${timeStamp}] ${formattedAgent}: "Continuing workflow..."`);
                }
                break;
            
            case 'complete':
                try {
                    const args = typeof toolCall.function === 'string' 
                        ? JSON.parse(toolCall.args || '{}')
                        : JSON.parse(toolCall.function?.arguments || '{}');
                    console.log(`✅ [${timeStamp}] ${formattedAgent}: "Task completed - ${args.finalResponse || args.summary || 'done'}"`);
                } catch (e) {
                    console.log(`✅ [${timeStamp}] ${formattedAgent}: "Task completed successfully"`);
                }
                break;
            
            case 'shell':
                try {
                    const args = typeof toolCall.function === 'string' 
                        ? JSON.parse(toolCall.args || '{}')
                        : JSON.parse(toolCall.function?.arguments || '{}');
                    console.log(`⚡ [${timeStamp}] ${formattedAgent}: "Executing: ${args.command}"`);
                } catch (e) {
                    console.log(`⚡ [${timeStamp}] ${formattedAgent}: "Executing shell command..."`);
                }
                break;
            
            case 'generateInventory':
                try {
                    const args = typeof toolCall.function === 'string' 
                        ? JSON.parse(toolCall.args || '{}')
                        : JSON.parse(toolCall.function?.arguments || '{}');
                    console.log(`📋 [${timeStamp}] ${formattedAgent}: "Analyzing project structure in ${args.paths?.join(', ') || 'current directory'}"`);
                } catch (e) {
                    console.log(`📋 [${timeStamp}] ${formattedAgent}: "Generating project inventory..."`);
                }
                break;
            
            case 'writeFile':
            case 'writeContextFile':
                try {
                    const args = typeof toolCall.function === 'string' 
                        ? JSON.parse(toolCall.args || '{}')
                        : JSON.parse(toolCall.function?.arguments || '{}');
                    console.log(`📝 [${timeStamp}] ${formattedAgent}: "Writing to ${args.path || args.filename || 'file'}"`);
                } catch (e) {
                    console.log(`📝 [${timeStamp}] ${formattedAgent}: "Writing file..."`);
                }
                break;
            
            default:
                console.log(`🔧 [${timeStamp}] ${formattedAgent}: "Using ${toolName} tool"`);
        }
    }

    logPhaseTransition(fromPhase: string, toPhase: string): void {
        const timeStamp = this.formatTime();
        console.log(`\n📍 [${timeStamp}] Phase transition: ${fromPhase} → ${toPhase}`);
    }

    logError(agentName: string, error: string): void {
        const formattedAgent = this.formatAgentName(agentName);
        const timeStamp = this.formatTime();
        console.log(`❌ [${timeStamp}] ${formattedAgent}: "Error occurred - ${error}"`);
    }

    logTestStart(testName: string): void {
        this.conversationStartTime = new Date();
        this.lastPhase = "CHAT";
        console.log(`\n🎬 Starting test: ${testName}`);
        console.log(`📅 ${this.conversationStartTime.toISOString()}`);
        console.log(`${'='.repeat(60)}\n`);
    }

    logTestEnd(success: boolean, testName?: string): void {
        const timeStamp = this.formatTime();
        const status = success ? '✅ PASSED' : '❌ FAILED';
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🏁 [${timeStamp}] Test completed: ${status} ${testName || ''}`);
    }

    logMatchedResponse(mockResponse: any): void {
        const timeStamp = this.formatTime();
        const trigger = mockResponse.trigger;
        
        let triggerDescription = '';
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
        
        console.log(`🎯 [${timeStamp}] Mock matched (${triggerDescription})`);
        
        if (mockResponse.response.content) {
            const preview = mockResponse.response.content.substring(0, 50);
            console.log(`   → Response: "${preview}${mockResponse.response.content.length > 50 ? '...' : ''}"`);
        }
    }

    reset(): void {
        this.conversationStartTime = new Date();
        this.lastPhase = "CHAT";
    }
}

// Export singleton instance
export const conversationalLogger = ConversationalLogger.getInstance();
