import { logger } from "@/utils/logger";
import type { ExecutionContext } from "./types";
import type { AgentInstance } from "@/agents/types";
import type { ToolExecutionTracker } from "./ToolExecutionTracker";
import type { CompleteEvent } from "@/llm/service";
import { formatConversationSnapshot } from "@/utils/phase-utils";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";
import { getProjectContext, isProjectContextInitialized } from "@/services";

/**
 * AgentSupervisor - Monitors agent execution and validates completion
 *
 * This class supervises agent execution to ensure:
 * 1. The agent produces an actual response (not just reasoning)
 * 2. The agent doesn't accidentally skip defined phases
 *
 * It integrates with ToolExecutionTracker to monitor phase usage.
 */
export class AgentSupervisor {
  private invalidReason: string | undefined;
  private continuationAttempts: number = 0;
  private maxContinuationAttempts: number = 3;
  private lastInvalidReason: string | undefined;
  private phaseValidationDecision: string | undefined;

  constructor(
    private agent: AgentInstance,
    private context: ExecutionContext,
    private toolTracker: ToolExecutionTracker
  ) {}

  /**
   * Check if any phases were skipped
   */
  checkPhaseCompletion(): { skipped: boolean; unusedPhases: string[] } {
    if (!this.agent.phases) {
      logger.info('[AgentSupervisor] No phases defined for agent', {
        agent: this.agent.name
      });
      return { skipped: false, unusedPhases: [] };
    }

    // Get all executions from the current tracker
    const allExecutions = this.toolTracker.getAllExecutions();

    // Find delegate_phase executions from this turn
    const executedPhases = new Set<string>();

    for (const execution of allExecutions.values()) {
      if (execution.toolName === 'delegate_phase') {
        // Extract phase name from the args
        const args = execution.input as { phase?: string };
        if (args?.phase) {
          executedPhases.add(args.phase.toLowerCase());
        }
      }
    }

    // Also check historical phases from previous turns
    const historicalPhases = this.scanHistoricalPhases();
    const allExecutedPhases = new Set([...executedPhases, ...historicalPhases]);

    // Check what's missing
    const definedPhases = Object.keys(this.agent.phases);
    const unusedPhases = definedPhases.filter(p => !allExecutedPhases.has(p.toLowerCase()));

    logger.info('[AgentSupervisor] Phase check complete', {
      agent: this.agent.name,
      defined: definedPhases,
      executedThisTurn: Array.from(executedPhases),
      executedHistorically: Array.from(historicalPhases),
      skipped: unusedPhases.length > 0
    });

    return {
      skipped: unusedPhases.length > 0,
      unusedPhases
    };
  }

  /**
   * Scan historical phases (from previous turns)
   */
  private scanHistoricalPhases(): Set<string> {
    const historicalPhases = new Set<string>();
    const conversation = this.context.getConversation();

    if (!conversation) return historicalPhases;

    // Only scan events BEFORE this execution started
    for (const event of conversation.history) {
      if (event.pubkey !== this.agent.pubkey) continue;
      if (event.id === this.context.triggeringEvent.id) break; // Stop at current trigger

      const toolTag = event.tags.find(t => t[0] === 'tool' && t[1] === 'delegate_phase');
      if (toolTag) {
        const phaseTag = event.tags.find(t => t[0] === 'phase');
        if (phaseTag?.[1]) {
          historicalPhases.add(phaseTag[1].toLowerCase());
        }
      }
    }

    return historicalPhases;
  }

  /**
   * Reset state for continuation
   */
  reset(): void {
    this.invalidReason = undefined;
    this.phaseValidationDecision = undefined;
    // Don't reset continuationAttempts or lastInvalidReason - track across the entire execution
    // Keep toolTracker state to accumulate phase usage
  }

  /**
   * Get the phase validation decision from the last execution check
   */
  getPhaseValidationDecision(): string | undefined {
    return this.phaseValidationDecision;
  }

  /**
   * Get the continuation prompt for when execution is not complete
   */
  getContinuationPrompt(): string {
    return this.invalidReason || "Please continue with your task.";
  }

  /**
   * Check if the execution is complete
   * @param completionEvent - The completion event from the LLM
   * @returns true if execution is complete, false if it needs to continue
   */
  async isExecutionComplete(completionEvent: CompleteEvent): Promise<boolean> {
    logger.info('[AgentSupervisor] Starting execution completion check', {
      agent: this.agent.name,
      hasMessage: !!completionEvent.message,
      messageLength: completionEvent.message?.length || 0,
      hasReasoning: !!completionEvent.reasoning,
      reasoningLength: completionEvent.reasoning?.length || 0,
      hasPhases: !!this.agent.phases,
      phaseCount: this.agent.phases ? Object.keys(this.agent.phases).length : 0,
      continuationAttempts: this.continuationAttempts,
      maxAttempts: this.maxContinuationAttempts
    });

    // Check if we've exceeded max continuation attempts
    if (this.continuationAttempts >= this.maxContinuationAttempts) {
      logger.warn('[AgentSupervisor] ⚠️ Max continuation attempts reached, forcing completion', {
        agent: this.agent.name,
        attempts: this.continuationAttempts,
        lastReason: this.lastInvalidReason
      });
      return true;
    }

    // First validation: Check if there's an actual response (not just reasoning)
    if (!completionEvent.message?.trim()) {
      logger.info('[AgentSupervisor] ❌ INVALID: No response content from agent', {
        agent: this.agent.name,
        hasReasoning: !!completionEvent.reasoning,
        reasoningLength: completionEvent.reasoning?.length || 0,
        attempts: this.continuationAttempts
      });

      const reason = "You didn't provide a response to the user. Please address their request.";

      // Check if we're stuck in a loop with the same issue
      if (this.lastInvalidReason === reason) {
        logger.warn('[AgentSupervisor] ⚠️ Agent stuck responding with empty content, forcing completion', {
          agent: this.agent.name,
          attempts: this.continuationAttempts
        });
        return true;
      }

      this.invalidReason = reason;
      this.lastInvalidReason = reason;
      this.continuationAttempts++;
      return false;
    }

    logger.info('[AgentSupervisor] ✓ Response validation passed', {
      agent: this.agent.name,
      messagePreview: completionEvent.message.substring(0, 100)
    });

    // Second validation: Check phase completion if applicable
    if (this.agent.phases && Object.keys(this.agent.phases).length > 0) {
      logger.info('[AgentSupervisor] Checking phase completion', {
        agent: this.agent.name,
        definedPhases: Object.keys(this.agent.phases)
      });

      const phaseCheck = this.checkPhaseCompletion();

      if (phaseCheck.skipped) {
        logger.info('[AgentSupervisor] Phases were skipped, validating if intentional', {
          agent: this.agent.name,
        });

        // Validate if skipping was intentional
        const shouldContinue = await this.validatePhaseSkipping(completionEvent.message);

        if (shouldContinue) {
          // Check if we're stuck in a loop asking to execute phases
          if (this.lastInvalidReason === shouldContinue) {
            logger.warn('[AgentSupervisor] ⚠️ Agent stuck ignoring phase execution request, forcing completion', {
              agent: this.agent.name,
              attempts: this.continuationAttempts,
              unusedPhases: phaseCheck.unusedPhases
            });
            return true;
          }

          logger.info('[AgentSupervisor] ❌ INVALID: Phases need to be executed', {
            agent: this.agent.name,
            unusedPhases: phaseCheck.unusedPhases,
            attempts: this.continuationAttempts
          });
          this.invalidReason = shouldContinue;
          this.lastInvalidReason = shouldContinue;
          this.continuationAttempts++;
          return false;
        }

        logger.info('[AgentSupervisor] ✓ Phase skipping was intentional', {
          agent: this.agent.name,
          skippedPhases: phaseCheck.unusedPhases
        });
      } else {
        logger.info('[AgentSupervisor] ✓ All phases executed or no phases skipped', {
          agent: this.agent.name
        });
      }
    }

    // All validations passed
    logger.info('[AgentSupervisor] ✅ EXECUTION COMPLETE: All validations passed', {
      agent: this.agent.name
    });
    return true;
  }

  /**
   * Validate if phase skipping was intentional using conversation snapshot
   * @param completionContent - The agent's response that skipped phases
   * @returns continuation instruction if agent should continue with phases, empty string if skipping was intentional
   */
  async validatePhaseSkipping(completionContent: string): Promise<string> {
    const phaseCheck = this.checkPhaseCompletion();
    if (!phaseCheck.skipped) {
      logger.info('[AgentSupervisor] No phase validation needed - no phases skipped', {
        agent: this.agent.name
      });
      return ''; // No phases skipped, no need to continue
    }

    logger.info('[AgentSupervisor] 🔍 Starting phase validation with conversation snapshot', {
      agent: this.agent.name,
      unusedPhases: phaseCheck.unusedPhases,
      responseLength: completionContent.length
    });

    try {
      // Format the conversation as a readable snapshot
      const conversationSnapshot = await formatConversationSnapshot(this.context);

      // Get the agent's system prompt to understand its behavior and phase definitions
      const systemPrompt = await this.getSystemPrompt();

      // Build validation messages with system context + snapshot
      const validationPrompt = this.buildValidationPrompt(
        phaseCheck.unusedPhases,
        conversationSnapshot,
        completionContent
      );

      // Create LLM service with NO TOOLS to force text response
      const llmService = this.context.agent.createLLMService();

      // Make the validation call with system prompt + validation question
      const result = await llmService.complete(
        [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'system',
            content: validationPrompt.system
          },
          {
            role: 'user',
            content: validationPrompt.user
          }
        ],
        {} // No tools
      );

      const response = result.text?.trim() || '';
      const responseLower = response.toLowerCase();
      const shouldContinue = responseLower.includes('continue');
      const isDone = responseLower.includes("i'm done") || responseLower.includes('im done');

      logger.info('[AgentSupervisor] 📊 Phase validation LLM response', {
        agent: this.agent.name,
        llmResponse: response,
        interpretation: shouldContinue ? 'CONTINUE WITH PHASES' : (isDone ? 'INTENTIONALLY DONE' : 'SKIP WAS INTENTIONAL'),
      });

      // Store the decision for later retrieval
      this.phaseValidationDecision = response;

      return shouldContinue ? response : '';
    } catch (error) {
      logger.error('[AgentSupervisor] ❌ Phase validation failed', {
        agent: this.agent.name,
        error: error instanceof Error ? error.message : String(error),
        defaulting: 'Assuming phases were intentionally skipped'
      });
      // On error, assume phases were intentional
      return '';
    }
  }

  /**
   * Get the agent's system prompt
   */
  private async getSystemPrompt(): Promise<string> {
    const conversation = this.context.getConversation();

    if (!conversation) {
      // Fallback minimal prompt
      return `You are ${this.context.agent.name}. ${this.context.agent.instructions || ""}`;
    }

    if (isProjectContextInitialized()) {
      // Project mode
      const projectCtx = getProjectContext();
      const project = projectCtx.project;
      const availableAgents = Array.from(projectCtx.agents.values());
      const agentLessonsMap = new Map();
      const currentAgentLessons = projectCtx.getLessonsForAgent(this.context.agent.pubkey);

      if (currentAgentLessons.length > 0) {
        agentLessonsMap.set(this.context.agent.pubkey, currentAgentLessons);
      }

      const isProjectManager = this.context.agent.pubkey === projectCtx.getProjectManager().pubkey;

      const systemMessages = await buildSystemPromptMessages({
        agent: this.context.agent,
        project,
        availableAgents,
        conversation,
        agentLessons: agentLessonsMap,
        isProjectManager,
        projectManagerPubkey: projectCtx.getProjectManager().pubkey,
      });

      // Combine all system messages into one
      return systemMessages.map(msg => msg.message.content).join('\n\n');
    } else {
      // Fallback minimal prompt
      return `You are ${this.context.agent.name}. ${this.context.agent.instructions || ""}`;
    }
  }

  /**
   * Build a contextual validation prompt that speaks directly to the agent
   */
  private buildValidationPrompt(
    unusedPhases: string[],
    conversationSnapshot: string,
    agentResponse: string
  ): { system: string; user: string } {
    const system = `You just completed a response without executing all your defined phases.

<conversation-history>
${conversationSnapshot}
</conversation-history>

<your-response>
${agentResponse}
</your-response>

<phases not executed>
${unusedPhases.join(', ')}
</phases not executed>`;

    const user = `Review the conversation flow and your response. Consider:
1. Did you fully address what was requested in the conversation?
2. Would executing your unused phases provide additional value or complete the task?
3. Was skipping these phases appropriate given the specific request?

Respond in one of two formats:
- "I'M DONE: [brief explanation of why you intentionally skipped the phases]"
- "CONTINUE: [brief explanation of what you will do next]" if you should execute your phases for a more complete response. Be specific about which phase you'll execute and why.`;

    return { system, user };
  }
}