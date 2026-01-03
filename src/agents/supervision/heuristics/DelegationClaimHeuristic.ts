import type { CorrectionAction, Heuristic, HeuristicDetection, PostCompletionContext, VerificationResult } from "../types";

export class DelegationClaimHeuristic implements Heuristic<PostCompletionContext> {
  id = "delegation-claim";
  name = "Delegation Claim Without Tool Call";
  timing = "post-completion" as const;

  // List of known agent slugs should be passed in or fetched
  private knownAgentSlugs: string[] = [];

  setKnownAgentSlugs(slugs: string[]): void {
    this.knownAgentSlugs = slugs;
  }

  async detect(context: PostCompletionContext): Promise<HeuristicDetection> {
    const content = context.messageContent.toLowerCase();

    // Check for delegation-related keywords
    const hasDelegationIntent =
      content.includes("delegate") ||
      content.includes("delegating") ||
      content.includes("i'll delegate") ||
      content.includes("i will delegate") ||
      content.includes("let me delegate");

    if (!hasDelegationIntent) {
      return { triggered: false };
    }

    // Check if delegate tool was actually called
    const delegateToolCalled = context.toolCallsMade.some(t =>
      t === "delegate" || t === "mcp__tenex__delegate"
    );

    if (delegateToolCalled) {
      return { triggered: false };
    }

    // Check if any known agent slugs are mentioned
    const mentionedSlugs = this.knownAgentSlugs.filter(slug =>
      content.includes(slug.toLowerCase())
    );

    const triggered = hasDelegationIntent && !delegateToolCalled && mentionedSlugs.length > 0;

    return {
      triggered,
      reason: triggered
        ? `Agent claimed to delegate to ${mentionedSlugs.join(", ")} but did not call delegate tool`
        : undefined,
      evidence: {
        mentionedSlugs,
        delegationPhraseFound: hasDelegationIntent,
        toolCallsMade: context.toolCallsMade,
      },
    };
  }

  buildVerificationPrompt(context: PostCompletionContext, detection: HeuristicDetection): string {
    const evidence = detection.evidence as { mentionedSlugs?: string[] } | undefined;
    return `The agent "${context.agentSlug}" mentioned delegating to agents ${JSON.stringify(evidence?.mentionedSlugs)} but did not call the delegate tool.

Message content excerpt: "${context.messageContent.substring(0, 500)}"

Tools called: ${JSON.stringify(context.toolCallsMade)}

Did the agent intend to delegate but forget to use the tool, or was this just a discussion about delegation?`;
  }

  buildCorrectionMessage(_context: PostCompletionContext, verification: VerificationResult): string {
    return verification.correctionMessage ||
      `You mentioned delegating to an agent but did not call the delegate tool. If you intended to delegate, please use the delegate tool. If you were just discussing delegation, please clarify your intentions.`;
  }

  getCorrectionAction(_verification: VerificationResult): CorrectionAction {
    return {
      type: "suppress-publish",
      reEngage: true,
    };
  }
}
