import type { Phase } from "../phases";
import { PHASES, getValidTransitions } from "../phases";
import type { Conversation, PhaseTransition } from "../types";
import type { ExecutionQueueManager } from "../executionQueue";
import { logger } from "@/utils/logger";

export interface PhaseTransitionContext {
    agentPubkey: string;
    agentName: string;
    message: string;
}

export interface PhaseTransitionResult {
    success: boolean;
    transition?: PhaseTransition;
    queued?: boolean;
    queuePosition?: number;
    queueMessage?: string;
    estimatedWait?: number;
}

/**
 * Manages conversation phase transitions and validation.
 * Single Responsibility: Handle all phase-related logic and rules.
 */
export class PhaseManager {
    constructor(private executionQueueManager?: ExecutionQueueManager) {}

    /**
     * Check if a phase transition is valid
     */
    canTransition(from: Phase, to: Phase): boolean {
        // Allow same-phase transitions (handoffs between agents)
        if (from === to) {
            return true;
        }
        
        // Check if the transition is in the allowed list
        const validTransitions = getValidTransitions(from);
        return validTransitions.includes(to);
    }

    /**
     * Attempt a phase transition
     */
    async transition(
        conversation: Conversation,
        to: Phase,
        context: PhaseTransitionContext
    ): Promise<PhaseTransitionResult> {
        const from = conversation.phase;

        // Validate transition
        if (from === to) {
            // Same phase handoff is always allowed
            const transition: PhaseTransition = {
                from,
                to,
                message: context.message,
                timestamp: Date.now(),
                agentPubkey: context.agentPubkey,
                agentName: context.agentName
            };

            return {
                success: true,
                transition
            };
        }

        if (!this.canTransition(from, to)) {
            const validTransitions = getValidTransitions(from);
            logger.warn(`[PhaseManager] Invalid transition requested from ${from} to ${to}`, {
                validTransitions: validTransitions.join(', '),
                conversationId: conversation.id,
                agent: context.agentName
            });
            logger.debug(`[PhaseManager] Valid transitions from ${from}: ${validTransitions.join(', ')}`);
            return {
                success: false
            };
        }

        // Handle EXECUTE phase entry with queue management
        if (to === PHASES.EXECUTE && this.executionQueueManager) {
            const permission = await this.executionQueueManager.requestExecution(
                conversation.id,
                context.agentPubkey
            );

            if (!permission.granted) {
                const queueMessage = this.formatQueueMessage(
                    permission.queuePosition!,
                    permission.waitTime!
                );

                logger.info(`[PhaseManager] Conversation ${conversation.id} queued for execution`, {
                    position: permission.queuePosition,
                    estimatedWait: permission.waitTime
                });

                return {
                    success: false,
                    queued: true,
                    queuePosition: permission.queuePosition,
                    queueMessage,
                    estimatedWait: permission.waitTime
                };
            }
        }

        // Handle EXECUTE phase exit
        if (from === PHASES.EXECUTE && to !== PHASES.EXECUTE && this.executionQueueManager) {
            await this.executionQueueManager.releaseExecution(
                conversation.id,
                'phase_transition'
            );
        }

        // Create transition record
        const transition: PhaseTransition = {
            from,
            to,
            message: context.message,
            timestamp: Date.now(),
            agentPubkey: context.agentPubkey,
            agentName: context.agentName
        };

        logger.info(`[PhaseManager] Phase transition`, {
            conversationId: conversation.id,
            from,
            to,
            agent: context.agentName
        });

        return {
            success: true,
            transition
        };
    }

    /**
     * Get the rules for a specific phase
     */
    getPhaseRules(phase: Phase): {
        canTransitionTo: Phase[];
        description: string;
    } {
        // All phases can transition to all other phases
        const allPhases: Phase[] = Object.values(PHASES) as Phase[];
        
        const descriptions: Record<Phase, string> = {
            [PHASES.CHAT]: "Open discussion and requirement gathering",
            [PHASES.BRAINSTORM]: "Creative ideation and exploration",
            [PHASES.PLAN]: "Planning and design phase",
            [PHASES.EXECUTE]: "Implementation and execution phase",
            [PHASES.VERIFICATION]: "Testing and verification phase",
            [PHASES.CHORES]: "Maintenance and routine tasks",
            [PHASES.REFLECTION]: "Review and reflection phase"
        };

        return {
            canTransitionTo: allPhases.filter(p => p !== phase),
            description: descriptions[phase] || "Phase description not available"
        };
    }

    /**
     * Setup queue event listeners
     */
    setupQueueListeners(
        onLockAcquired: (conversationId: string, agentPubkey: string) => Promise<void>,
        onTimeout: (conversationId: string) => Promise<void>,
        onTimeoutWarning: (conversationId: string, remainingMs: number) => Promise<void>
    ): void {
        if (!this.executionQueueManager) return;

        this.executionQueueManager.on('lock-acquired', onLockAcquired);
        this.executionQueueManager.on('timeout', onTimeout);
        this.executionQueueManager.on('timeout-warning', onTimeoutWarning);
    }

    private formatQueueMessage(position: number, waitTimeSeconds: number): string {
        const waitTime = this.formatWaitTime(waitTimeSeconds);
        return `🚦 Execution Queue Status\n\n` +
            `Your conversation has been added to the execution queue.\n\n` +
            `Queue Position: ${position}\n` +
            `Estimated Wait Time: ${waitTime}\n\n` +
            `You will be automatically notified when execution begins.`;
    }

    private formatWaitTime(seconds: number): string {
        if (seconds < 60) {
            return `~${Math.floor(seconds)} seconds`;
        } else if (seconds < 3600) {
            return `~${Math.floor(seconds / 60)} minutes`;
        } else {
            return `~${Math.floor(seconds / 3600)} hours`;
        }
    }
}