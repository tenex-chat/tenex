import { NDKTask, NDKUser, type NDKEvent } from "@nostr-dev-kit/ndk";
import { getNDK } from "@/nostr/ndkClient";
import { getProjectContext } from "@/services/ProjectContext";
import { EventTagger } from "@/nostr/EventTagger";
import { logger } from "@/utils/logger";
import type { ConversationManager, Conversation } from "@/conversations/ConversationManager";
import type { AgentInstance } from "@/agents/types";

export interface DelegationRequest {
    recipients: string[];
    title: string;
    fullRequest: string;
    phase?: string;  // Optional, only used by delegate_phase
}

export interface DelegationContext {
    agent: AgentInstance;
    conversationId: string;
    conversationManager: ConversationManager;
}

export interface DelegationResult {
    recipientPubkeys: string[];
    taskIds: string[];
    serializedEvents?: any[];  // Serialized NDKTask events for deferred publishing
}

/**
 * Service for handling task delegation between agents
 * Centralizes delegation logic used by both delegate and delegate_phase tools
 */
export class DelegationService {
    /**
     * Find the parent conversation ID for a task-related event.
     * This resolves the task hierarchy to find where delegation state lives.
     * 
     * @param event The event (e.g., kind 1111 replying to a task)
     * @param conversation The conversation the event belongs to
     * @returns The parent conversation ID, or null if not found
     */
    static findParentConversationId(
        event: NDKEvent,
        conversation: Conversation
    ): string | null {
        // If this is a reply to a task (K=1934), find the task in conversation history
        if (event.tagValue("K") === "1934") {
            const taskId = event.tagValue("E");
            if (!taskId) {
                logger.debug("No E tag found in K=1934 event");
                return null;
            }
            
            // Find the task event in the conversation history
            const taskEvent = conversation.history?.find(e => e.id === taskId);
            if (!taskEvent) {
                logger.debug("Task event not found in conversation history", { 
                    taskId: taskId.substring(0, 8),
                    historyLength: conversation.history?.length || 0
                });
                return null;
            }
            
            // Find the root conversation tag in the task
            const rootTag = taskEvent.tags.find(t => t[0] === "e" && t[3] === "root");
            if (!rootTag || !rootTag[1]) {
                logger.debug("No root tag found in task event", {
                    taskId: taskId.substring(0, 8)
                });
                return null;
            }
            
            logger.debug("Found parent conversation ID from task root tag", {
                taskId: taskId.substring(0, 8),
                parentConversationId: rootTag[1].substring(0, 8)
            });
            
            return rootTag[1];
        }
        
        // If this IS a task (kind 1934), check its own root tag
        if (event.kind === 1934) {
            const rootTag = event.tags.find(t => t[0] === "e" && t[3] === "root");
            if (rootTag && rootTag[1]) {
                logger.debug("Found parent conversation ID from task's own root tag", {
                    taskId: event.id?.substring(0, 8),
                    parentConversationId: rootTag[1].substring(0, 8)
                });
                return rootTag[1];
            }
        }
        
        return null;
    }
    /**
     * Resolve a recipient string to a pubkey
     * @param recipient - Agent slug, name, npub, or hex pubkey
     * @returns Pubkey hex string or null if not found
     */
    static resolveRecipientToPubkey(recipient: string): string | null {
        // Trim whitespace
        recipient = recipient.trim();
        
        // Check if it's an npub
        if (recipient.startsWith("npub")) {
            try {
                return new NDKUser({ npub: recipient }).pubkey;
            } catch (error) {
                logger.debug("Failed to decode npub", { recipient, error });
            }
        }
        
        // Check if it's a hex pubkey (64 characters)
        if (/^[0-9a-f]{64}$/i.test(recipient)) {
            return recipient.toLowerCase();
        }
        
        // Try to resolve as agent slug or name (case-insensitive)
        try {
            const projectContext = getProjectContext();
            
            // Check project agents with case-insensitive matching for both slug and name
            const recipientLower = recipient.toLowerCase();
            for (const [slug, agent] of projectContext.agents.entries()) {
                if (slug.toLowerCase() === recipientLower || 
                    agent.name.toLowerCase() === recipientLower) {
                    return agent.pubkey;
                }
            }
            
            logger.debug("Agent slug or name not found", { recipient });
            return null;
        } catch (error) {
            logger.debug("Failed to resolve agent slug or name", { recipient, error });
            return null;
        }
    }

    /**
     * Create and publish delegation tasks for multiple recipients
     * Handles task creation, publishing, mapping registration, and state tracking
     */
    static async createDelegationTasks(
        request: DelegationRequest,
        context: DelegationContext
    ): Promise<DelegationResult> {
        const { recipients, title, fullRequest, phase } = request;
        const { agent, conversationId, conversationManager } = context;
        
        // Resolve all recipients to pubkeys
        const resolvedPubkeys: string[] = [];
        const failedRecipients: string[] = [];
        
        for (const recipient of recipients) {
            const pubkey = this.resolveRecipientToPubkey(recipient);
            if (pubkey) {
                resolvedPubkeys.push(pubkey);
            } else {
                failedRecipients.push(recipient);
            }
        }
        
        // If any recipients failed to resolve, throw error
        if (failedRecipients.length > 0) {
            throw new Error(
                `Cannot resolve recipient(s) to pubkey: ${failedRecipients.join(", ")}. ` +
                `Must be valid agent slug(s), npub(s), or hex pubkey(s).`
            );
        }
        
        // If no valid recipients, throw error
        if (resolvedPubkeys.length === 0) {
            throw new Error("No valid recipients provided.");
        }
        
        // Create EventTagger instance for consistent tagging
        const eventTagger = new EventTagger(getProjectContext().project);
        
        // Create and sign all NDKTask events first (but don't publish yet)
        const taskIds: string[] = [];
        const tasks = new Map<string, { recipientPubkey: string; status: string; delegatedAgent?: string }>();
        const signedTasks: { task: NDKTask; recipientPubkey: string }[] = [];
        
        // STEP 1: Create and sign all tasks
        for (const recipientPubkey of resolvedPubkeys) {
            // Create a new NDKTask for this specific recipient
            const task = new NDKTask(getNDK());
            task.content = fullRequest;
            
            // Use EventTagger for delegation-specific tags
            eventTagger.tagForDelegation(task, {
                assignedTo: recipientPubkey,
                conversationId
            });
            
            // Add task-specific metadata (title, phase) separately
            // These are not part of the core delegation intent
            task.tags.push(["title", title]);
            if (phase) {
                task.tags.push(["phase", phase]);
            }
            
            // Sign the task (we need the ID)
            await task.sign(agent.signer);
            
            // Track this task
            taskIds.push(task.id);
            tasks.set(task.id, {
                recipientPubkey,
                status: "pending",
                delegatedAgent: recipientPubkey
            });
            
            // Store for publishing later
            signedTasks.push({ task, recipientPubkey });
            
            logger.debug("Prepared NDKTask for delegation", {
                taskId: task.id,
                conversationId,
                phase: phase || "none",
                fromAgent: agent.slug,
                toAgent: recipientPubkey,
            });
        }
        
        // STEP 2: Update agent's state BEFORE publishing
        // This ensures the state is ready when completions arrive
        await conversationManager.updateAgentState(
            conversationId,
            agent.slug,
            {
                pendingDelegation: {
                    taskIds: taskIds,
                    tasks: tasks,
                    originalRequest: fullRequest,
                    timestamp: Date.now(),
                }
            }
        );
        
        logger.debug("Agent delegation state updated", {
            agent: agent.slug,
            taskCount: taskIds.length,
            taskIds: taskIds.map(id => id.substring(0, 8))
        });
        
        // STEP 3: Register all task mappings BEFORE publishing
        for (const taskId of taskIds) {
            await conversationManager.registerTaskMapping(
                taskId,
                conversationId
            );
        }
        
        logger.debug("Task mappings registered", {
            taskCount: taskIds.length,
            conversationId
        });
        
        // STEP 4: Collect serialized events for deferred publishing
        const serializedEvents = signedTasks.map(({ task }) => task.rawEvent());
        
        logger.info("Delegation prepared - deferring task publication", {
            fromAgent: agent.slug,
            waitingForTasks: taskIds.length,
            taskIds: taskIds,
            phase: phase || "none",
        });
        
        return {
            recipientPubkeys: resolvedPubkeys,
            taskIds: taskIds,
            serializedEvents: serializedEvents,
        };
    }
}