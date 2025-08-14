import type { Phase } from "../phases";
import type { 
    OrchestratorTurn, 
    Completion, 
    RoutingEntry,
    OrchestratorRoutingContext 
} from "../types";
import { logger } from "@/utils/logger";

/**
 * Tracks orchestrator routing decisions and turn management.
 * Single Responsibility: Manage orchestrator turns and routing history.
 */
export class OrchestratorTurnTracker {
    private turns: Map<string, OrchestratorTurn[]> = new Map();

    /**
     * Start a new orchestrator turn
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
        conversationTurns.push(turn);
        this.turns.set(conversationId, conversationTurns);

        return turnId;
    }

    /**
     * Add a completion to the current turn
     */
    addCompletion(
        conversationId: string,
        agentSlug: string,
        message: string
    ): void {
        const conversationTurns = this.turns.get(conversationId);
        if (!conversationTurns) {
            logger.warn(`[OrchestratorTurnTracker] No turns found for conversation ${conversationId}`);
            return;
        }

        // Find the most recent incomplete turn that includes this agent
        const currentTurn = [...conversationTurns]
            .reverse()
            .find(turn => !turn.isCompleted && turn.agents.includes(agentSlug));

        if (!currentTurn) {
            logger.warn(`[OrchestratorTurnTracker] No active turn found for agent ${agentSlug}`, {
                conversationId
            });
            return;
        }

        // Add completion
        currentTurn.completions.push({
            agent: agentSlug,
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
     * Build orchestrator routing context
     * Note: Now that orchestrator is only invoked when turns are complete,
     * we no longer need current_routing - it would always be null
     */
    buildRoutingContext(
        conversationId: string,
        userRequest: string,
        _triggeringCompletion?: Completion
    ): OrchestratorRoutingContext {
        const conversationTurns = this.turns.get(conversationId) || [];
        const routing_history: RoutingEntry[] = [];

        // Process all completed turns into history
        // Since orchestrator is only called when turns are complete,
        // all turns should be in history
        for (const turn of conversationTurns) {
            if (turn.isCompleted) {
                routing_history.push({
                    phase: turn.phase,
                    agents: turn.agents,
                    completions: turn.completions,
                    reason: turn.reason,
                    timestamp: turn.timestamp
                });
            }
            // Note: Incomplete turns are skipped since orchestrator won't be invoked
            // while waiting for agents to complete
        }

        return {
            user_request: userRequest,
            routing_history
            // current_routing removed - always null with new optimization
        };
    }

    /**
     * Clear all turns for a conversation
     */
    clearTurns(conversationId: string): void {
        this.turns.delete(conversationId);
        logger.debug(`[OrchestratorTurnTracker] Cleared turns for conversation ${conversationId}`);
    }
}