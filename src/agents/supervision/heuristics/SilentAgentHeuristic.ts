import type { CorrectionAction, Heuristic, HeuristicDetection, PostCompletionContext, VerificationResult } from "../types";

export class SilentAgentHeuristic implements Heuristic<PostCompletionContext> {
  id = "silent-agent";
  name = "Silent Agent Detection";
  timing = "post-completion" as const;

  async detect(context: PostCompletionContext): Promise<HeuristicDetection> {
    const content = context.messageContent?.trim() || "";
    const hasMeaningfulContent = content.length > 0;
    const hasToolCalls = context.toolCallsMade.length > 0;

    // Silent = no content AND no tool calls that would produce output
    // Exception: delegate calls are ok since agent is waiting for delegation
    const delegateCalls = context.toolCallsMade.filter(t =>
      t === "delegate" || t.includes("delegate")
    );
    const hasOnlyDelegateCalls = hasToolCalls && delegateCalls.length === context.toolCallsMade.length;

    const isSilent = !hasMeaningfulContent && !hasOnlyDelegateCalls;

    return {
      triggered: isSilent,
      reason: isSilent ? "Agent completed without generating any output or meaningful tool calls" : undefined,
      evidence: {
        messageContent: content.substring(0, 100),
        toolCallsMade: context.toolCallsMade,
      },
    };
  }

  buildVerificationPrompt(context: PostCompletionContext, detection: HeuristicDetection): string {
    const evidence = detection.evidence as { messageContent?: string } | undefined;
    return `The agent "${context.agentSlug}" completed its turn without producing any visible output.
This may indicate the agent failed to respond appropriately.

Evidence:
- Message content: "${evidence?.messageContent || "(empty)"}"
- Tool calls: ${JSON.stringify(context.toolCallsMade)}

Is this acceptable behavior or should the agent be prompted to respond?`;
  }

  buildCorrectionMessage(_context: PostCompletionContext, verification: VerificationResult): string {
    return verification.correctionMessage ||
      `You completed your turn without providing any response. Please provide a meaningful response to the user's request.`;
  }

  getCorrectionAction(_verification: VerificationResult): CorrectionAction {
    return {
      type: "suppress-publish",
      reEngage: true,
    };
  }
}
