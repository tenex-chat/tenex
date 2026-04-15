import { isDelegateToolName } from "@/agents/tool-names";
import type { CorrectionAction, Heuristic, HeuristicDetection, PostCompletionContext, VerificationResult } from "../types";

export class SilentAgentHeuristic implements Heuristic<PostCompletionContext> {
  id = "silent-agent";
  name = "Silent Agent Detection";
  timing = "post-completion" as const;
  enforcementMode = "repeat-until-resolved" as const;

  async detect(context: PostCompletionContext): Promise<HeuristicDetection> {
    if (context.silentCompletionRequested) {
      return {
        triggered: false,
      };
    }

    const content = context.messageContent.trim();
    const isEmpty = content.length === 0;
    const hasToolCalls = context.toolCallsMade.length > 0;

    // Exception: delegate calls are ok since agent is waiting for delegation
    const delegateCalls = context.toolCallsMade.filter((toolName) => isDelegateToolName(toolName));
    const hasOnlyDelegateCalls = hasToolCalls && delegateCalls.length === context.toolCallsMade.length;

    // Silent if:
    // 1. Message is empty (no content at all), OR
    // 2. LLM used the error fallback message (indicates LLM failure)
    // This approach avoids false positives from:
    // - Missing usage metadata (some providers don't report tokens)
    // - Multi-step flows where final step has 0 tokens but earlier steps had content
    const isSilent = (isEmpty || context.usedErrorFallback === true) && !hasOnlyDelegateCalls;

    return {
      triggered: isSilent,
      reason: isSilent
        ? context.usedErrorFallback
          ? "Agent completed with error fallback message (LLM failure)"
          : "Agent completed without generating any output"
        : undefined,
      evidence: {
        outputTokens: context.outputTokens,
        messageContent: content.substring(0, 100),
        toolCallsMade: context.toolCallsMade,
        usedErrorFallback: context.usedErrorFallback,
      },
    };
  }

  buildVerificationPrompt(context: PostCompletionContext, detection: HeuristicDetection): string {
    const evidence = detection.evidence as {
      outputTokens?: number;
      messageContent?: string;
      usedErrorFallback?: boolean;
    } | undefined;

    const reason = evidence?.usedErrorFallback
      ? "returned the error fallback message (LLM failed to generate content)"
      : "produced no visible output";

    return `The agent "${context.agentSlug}" completed its turn but ${reason}.

Evidence:
- Message content: "${evidence?.messageContent || "(empty)"}"
- Output tokens: ${evidence?.outputTokens ?? 0}
- Error fallback: ${evidence?.usedErrorFallback ? "yes" : "no"}
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
