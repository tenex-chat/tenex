import inquirer from "inquirer";
import chalk from "chalk";
import type { ConversationManager } from "@/conversations/ConversationManager";
import { formatDuration } from "@/utils/formatting";

interface ConversationChoice {
    name: string;
    value: string;
    short: string;
}

export async function selectConversation(conversationManager: ConversationManager): Promise<string | null> {
    const conversations = conversationManager.getAllConversations();
    
    if (conversations.length === 0) {
        console.log(chalk.yellow("No conversations found."));
        return null;
    }
    
    // Sort conversations by last event timestamp (most recent first)
    const sortedConversations = conversations.sort((a, b) => {
        const aLastEvent = a.history[a.history.length - 1];
        const bLastEvent = b.history[b.history.length - 1];
        const aTimestamp = aLastEvent?.created_at || 0;
        const bTimestamp = bLastEvent?.created_at || 0;
        return bTimestamp - aTimestamp;
    });
    
    // Create choices for inquirer
    const choices: ConversationChoice[] = sortedConversations.map((conv) => {
        const lastEvent = conv.history[conv.history.length - 1];
        const lastEventTime = lastEvent?.created_at 
            ? new Date(lastEvent.created_at * 1000).toLocaleString()
            : "Unknown time";
        
        const duration = conv.executionTime?.totalSeconds 
            ? formatDuration(conv.executionTime.totalSeconds * 1000)
            : "N/A";
            
        const eventCount = conv.history.length;
        const phaseTransitionCount = conv.phaseTransitions.length;
        
        // Create a display name with metadata
        const name = [
            chalk.bold(conv.title),
            chalk.gray(`[${conv.phase}]`),
            chalk.dim(`Last: ${lastEventTime}`),
            chalk.dim(`Duration: ${duration}`),
            chalk.dim(`Events: ${eventCount}, Transitions: ${phaseTransitionCount}`)
        ].join(" ");
        
        return {
            name,
            value: conv.id,
            short: conv.title
        };
    });
    
    // Add separator and cancel option
    choices.push(new inquirer.Separator() as unknown as ConversationChoice);
    choices.push({
        name: chalk.red("Cancel"),
        value: "cancel",
        short: "Cancel"
    });
    
    try {
        const { conversationId } = await inquirer.prompt([
            {
                type: "list",
                name: "conversationId",
                message: "Select a conversation to view timeline:",
                choices,
                pageSize: 15,
                loop: false
            }
        ]);
        
        if (conversationId === "cancel") {
            return null;
        }
        
        return conversationId;
    } catch {
        // Handle Ctrl+C
        console.log(chalk.red("\nCancelled."));
        return null;
    }
}

