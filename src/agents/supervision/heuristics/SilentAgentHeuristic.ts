import { isDelegateToolName } from "@/agents/tool-names";
import type { CorrectionAction, Heuristic, HeuristicDetection, PostCompletionContext, VerificationResult } from "../types";

export class SilentAgentHeuristic implements Heuristic<PostCompletionContext> {
  id = "silent-agent";
  name = "Silent Agent Detection";
  timing = "post-completion" as const;

  async detect(context: PostCompletionContext): Promise<HeuristicDetection> {
    if (context.silentCompletionRequested) {
      return {
        triggered: false,
      };
    }

    const hasLLMOutput = context.outputTokens > 0;
    const hasToolCalls = context.toolCallsMade.length > 0;

    // Silent = no LLM output AND no tool calls that would produce output
    // Exception: delegate calls are ok since agent is waiting for delegation
    const delegateCalls = context.toolCallsMade.filter((toolName) => isDelegateToolName(toolName));
    const hasOnlyDelegateCalls = hasToolCalls && delegateCalls.length === context.toolCallsMade.length;

    const isSilent = !hasLLMOutput && !hasOnlyDelegateCalls;

    return {
      triggered: isSilent,
      reason: isSilent ? `Agent completed with 0 output tokens (LLM failure or empty response)` : undefined,
      evidence: {
        outputTokens: context.outputTokens,
        messageContent: context.messageContent.substring(0, 100),
        toolCallsMade: context.toolCallsMade,
      },
    };
  }

  buildVerificationPrompt(context: PostCompletionContext, detection: HeuristicDetection): string {
    const evidence = detection.evidence as { outputTokens?: number; messageContent?: string } | undefined;
    return `The agent "${context.agentSlug}" completed its turn without producing any LLM output.
This may indicate the LLM provider failed or the agent encountered an error.

Evidence:
- Output tokens: ${evidence?.outputTokens ?? 0}
- Message content: "${evidence?.messageContent || "(empty)"}"
- Tool calls: ${JSON.stringify(context.toolCallsMade)}

Is this acceptable behavior or should the agent be prompted to respond?`;
  }

  buildCorrectionMessage(_context: PostCompletionContext, verification: VerificationResult): string {
    return verification.correctionMessage ||
      "You completed your turn without providing any response. Please provide a meaningful response to the user's request.";
  }

  getCorrectionAction(_verification: VerificationResult): CorrectionAction {
    return {
      type: "suppress-publish",
      reEngage: true,
    };
  }
}
