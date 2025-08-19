import { NDKTask, NDKUser } from "@nostr-dev-kit/ndk";
import { getNDK } from "@/nostr/ndkClient";
import { getProjectContext } from "@/services/ProjectContext";
import { EventTagger } from "@/nostr/EventTagger";
import { logger } from "@/utils/logger";
import type { ConversationManager } from "@/conversations/ConversationManager";
import type { AgentInstance } from "@/agents/types";
import { DelegationRegistry } from "./DelegationRegistry";

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
    batchId: string;  // Batch ID from registry for tracking
}

/**
 * Service for handling task delegation between agents
 * Centralizes delegation logic used by both delegate and delegate_phase tools
 */
export class DelegationService {
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
        const { agent, conversationId } = context;
        
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
        
        // STEP 2: Publish tasks immediately to Nostr
        // This ensures consistency - registry state matches published events
        for (const { task } of signedTasks) {
            await task.publish();
            logger.debug("Published NDKTask", {
                taskId: task.id,
                assignedTo: task.tagValue("p"),
                conversationId: conversationId
            });
        }
        
        // STEP 3: Register with DelegationRegistry AFTER publishing
        // This ensures registry only tracks actually published tasks
        const registry = DelegationRegistry.getInstance();
        const batchId = await registry.registerDelegationBatch({
            tasks: signedTasks.map(({ task, recipientPubkey }) => ({
                taskId: task.id,
                assignedToPubkey: recipientPubkey,
                title: title,
                fullRequest: fullRequest,
                phase: phase
            })),
            delegatingAgent: agent,
            conversationId: conversationId,
            originalRequest: fullRequest
        });
        
        logger.info("Delegation tasks published and registered", {
            batchId,
            agent: agent.slug,
            taskCount: taskIds.length,
            taskIds: taskIds.map(id => id.substring(0, 8)),
            phase: phase || "none"
        });
        
        return {
            recipientPubkeys: resolvedPubkeys,
            taskIds: taskIds,
            batchId: batchId
        };
    }
}