import type { Phase } from "../phases";
import type { 
    OrchestratorTurn, 
    Completion, 
    RoutingEntry,
    OrchestratorRoutingContext 
} from "../types";
import { logger } from "@/utils/logger";
import { getProjectContext } from "@/services/ProjectContext";

/**
 * Tracks orchestrator routing decisions and turn management.
 * Single Responsibility: Manage orchestrator turns and routing history.
 */
export class OrchestratorTurnTracker {
    private turns: Map<string, OrchestratorTurn[]> = new Map();
    private readonly MAX_RECENT_ROUTINGS = 5;
    private readonly REPETITION_THRESHOLD = 2;

    /**
     * Start a new orchestrator turn
     * @param agents Array of agent pubkeys (not slugs or names) for consistent identification
     */
    startTurn(
        conversationId: string,
        phase: Phase,
        agents: string[],
        reason?: string
    ): string {
        const turnId = `turn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const turn: OrchestratorTurn = {
            turnId,
            timestamp: Date.now(),
            phase,
            agents,
            completions: [],
            reason,
            isCompleted: false
        };

        // Get or create turns array for this conversation
        const conversationTurns = this.turns.get(conversationId) || [];
        
        // Check for routing repetition before adding the new turn
        if (this.detectRoutingRepetition(conversationTurns, phase, agents)) {
            logger.warn(`[OrchestratorTurnTracker] Detected potential routing loop for conv ${conversationId}`, {
                phase,
                agents: this.formatAgentList(agents),
                reason,
            });
            // The warning is logged but we still allow the routing to proceed
            // The orchestrator prompt will see this in the workflow narrative
        }
        
        conversationTurns.push(turn);
        this.turns.set(conversationId, conversationTurns);

        return turnId;
    }

    /**
     * Add a completion to the current turn
     * @param agentPubkey The pubkey of the agent that completed (not slug or name)
     */
    addCompletion(
        conversationId: string,
        agentPubkey: string,
        message: string
    ): void {
        const conversationTurns = this.turns.get(conversationId);
        if (!conversationTurns) {
            logger.warn(`[OrchestratorTurnTracker] No turns found for conversation ${conversationId}`);
            return;
        }

        // Find the most recent incomplete turn that includes this agent pubkey
        const currentTurn = [...conversationTurns]
            .reverse()
            .find(turn => !turn.isCompleted && turn.agents.includes(agentPubkey));

        if (!currentTurn) {
            logger.warn(`[OrchestratorTurnTracker] No active turn found for agent ${agentPubkey}`, {
                conversationId
            });
            return;
        }

        // Add completion
        currentTurn.completions.push({
            agent: agentPubkey,
            message,
            timestamp: Date.now()
        });

        // Check if all expected agents have completed
        const completedAgents = new Set(currentTurn.completions.map(c => c.agent));
        if (currentTurn.agents.every(agent => completedAgents.has(agent))) {
            currentTurn.isCompleted = true;
            logger.info(`[OrchestratorTurnTracker] Turn ${currentTurn.turnId} completed`, {
                conversationId,
                completions: currentTurn.completions.length
            });
        }
    }

    /**
     * Check if the current turn is complete
     */
    isCurrentTurnComplete(conversationId: string): boolean {
        const conversationTurns = this.turns.get(conversationId);
        if (!conversationTurns || conversationTurns.length === 0) {
            return true; // No turns, so nothing pending
        }

        const lastTurn = conversationTurns[conversationTurns.length - 1];
        return lastTurn.isCompleted;
    }

    /**
     * Get the current (most recent) turn
     */
    getCurrentTurn(conversationId: string): OrchestratorTurn | null {
        const conversationTurns = this.turns.get(conversationId);
        if (!conversationTurns || conversationTurns.length === 0) {
            return null;
        }

        return conversationTurns[conversationTurns.length - 1];
    }

    /**
     * Get all turns for a conversation
     */
    getTurns(conversationId: string): OrchestratorTurn[] {
        return this.turns.get(conversationId) || [];
    }

    /**
     * Set turns for a conversation (used when loading from persistence)
     */
    setTurns(conversationId: string, turns: OrchestratorTurn[]): void {
        this.turns.set(conversationId, turns);
    }

    /**
     * Get routing history (completed turns)
     */
    getRoutingHistory(conversationId: string): RoutingEntry[] {
        const conversationTurns = this.turns.get(conversationId) || [];
        
        return conversationTurns
            .filter(turn => turn.isCompleted)
            .map(turn => ({
                phase: turn.phase,
                agents: turn.agents,
                completions: turn.completions,
                reason: turn.reason,
                timestamp: turn.timestamp
            }));
    }

    /**
     * Build orchestrator routing context with a human-readable narrative
     * This narrative replaces the abstract JSON history for better LLM understanding
     */
    buildRoutingContext(
        conversationId: string,
        userRequest: string,
        _triggeringCompletion?: Completion
    ): OrchestratorRoutingContext {
        const conversationTurns = this.turns.get(conversationId) || [];
        const narrativeParts: string[] = [];

        narrativeParts.push(`=== ORCHESTRATOR ROUTING CONTEXT ===\n`);
        narrativeParts.push(`Initial user request: "${userRequest}"\n`);
        
        // Check for potential routing loops
        if (conversationTurns.length > 0) {
            const lastTurn = conversationTurns[conversationTurns.length - 1];
            if (lastTurn.isCompleted && this.detectRoutingRepetition(conversationTurns.slice(0, -1), lastTurn.phase, lastTurn.agents)) {
                narrativeParts.push(`\n⚠️ WARNING: Detected potential routing loop - the same agents in the same phase have been routed to multiple times recently.\n`);
            }
        }

        if (conversationTurns.length === 0) {
            narrativeParts.push(`\nThis is the first routing decision for this conversation.`);
            narrativeParts.push(`No agents have been routed yet.\n`);
        } else {
            narrativeParts.push(`\n--- WORKFLOW HISTORY ---\n`);
            
            for (const turn of conversationTurns) {
                // Show routing decision
                narrativeParts.push(`[${turn.phase} phase → ${this.formatAgentList(turn.agents)}]`);
                if (turn.reason) {
                    narrativeParts.push(`Routing reason: "${turn.reason}"`);
                }
                
                // Show completions if any
                if (turn.completions.length > 0) {
                    for (const completion of turn.completions) {
                        const agentName = this.getAgentName(completion.agent);
                        narrativeParts.push(`\n${agentName} completed:`);
                        // Include full completion message for context
                        narrativeParts.push(`"${completion.message}"\n`);
                    }
                    
                    // If turn is not complete despite having some completions
                    if (!turn.isCompleted) {
                        const waitingForAgents = turn.agents.filter(
                            agent => !turn.completions.some(c => c.agent === agent)
                        );
                        if (waitingForAgents.length > 0) {
                            narrativeParts.push(`(Waiting for agent responses from: ${this.formatAgentList(waitingForAgents)})\n`);
                        }
                    }
                } else if (!turn.isCompleted) {
                    narrativeParts.push(`(Waiting for agent responses...)\n`);
                }
            }
        }

        narrativeParts.push(`\n--- YOU ARE HERE ---`);
        narrativeParts.push(`The user's request was: "${userRequest}"`);
        narrativeParts.push(`\nDetermine the NEXT routing action based on the above workflow history.`);
        
        // Simple, clear instruction
        if (conversationTurns.length === 0 || !conversationTurns.some(turn => turn.completions.length > 0)) {
            narrativeParts.push(`No agent has responded yet. Route to an appropriate agent to handle this request.`);
        } else {
            narrativeParts.push(`If the user's request has been fully addressed, route to ["END"]. Otherwise, continue routing.`);
        }

        return {
            user_request: userRequest,
            workflow_narrative: narrativeParts.join('\n')
        };
    }

    /**
     * Format agent list from pubkeys to readable names
     */
    private formatAgentList(agentPubkeys: string[]): string {
        return agentPubkeys.map(pubkey => this.getAgentName(pubkey)).join(', ');
    }

    /**
     * Get human-readable agent name from pubkey
     */
    private getAgentName(agentPubkey: string): string {
        try {
            const projectContext = getProjectContext();
            // Look through all agents to find matching pubkey
            for (const [slug, agent] of projectContext.agents) {
                if (agent.pubkey === agentPubkey) {
                    return `@${agent.name || slug}`;
                }
            }
        } catch (error) {
            // ProjectContext might not be initialized yet
            logger.debug("Could not get agent name from ProjectContext", { error });
        }
        
        // Fallback to shortened pubkey
        return `@agent-${agentPubkey.substring(0, 8)}`;
    }

    /**
     * Clear all turns for a conversation
     */
    clearTurns(conversationId: string): void {
        this.turns.delete(conversationId);
        logger.debug(`[OrchestratorTurnTracker] Cleared turns for conversation ${conversationId}`);
    }
    
    /**
     * Detect if we're in a routing repetition loop
     */
    private detectRoutingRepetition(
        turns: OrchestratorTurn[],
        currentPhase: Phase,
        currentAgents: string[]
    ): boolean {
        // Filter for recent completed turns with the same phase and agents
        const recentSimilarTurns = turns
            .slice(-this.MAX_RECENT_ROUTINGS)
            .filter(turn =>
                turn.isCompleted && // Only consider completed turns
                turn.phase === currentPhase &&
                turn.agents.length === currentAgents.length &&
                turn.agents.every(agent => currentAgents.includes(agent))
            );

        // If we have hit the repetition threshold, it's likely a loop
        return recentSimilarTurns.length >= this.REPETITION_THRESHOLD;
    }
}