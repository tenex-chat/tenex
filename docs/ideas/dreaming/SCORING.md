---
title: "Task Scoring For Dreaming"
date: "2026-04-29"
audience: "llms"
scope: "Design thoughts for a shared task-analysis and dream-analysis scorer"
status: "idea"
---

# Task Scoring For Dreaming

## Question

How should TENEX score how well an agent performed on a task, and how can the same mechanism support both live task analysis and offline dream analysis?

## Short Answer

The scorer should be built around a frozen **evaluation contract**.

Before or near the start of a task, TENEX derives a task-specific evaluation plan: what success means, what constraints matter, what evidence should be inspected, and which failure gates are non-negotiable. After a live run or dream replay, TENEX gathers evidence from the same surfaces and evaluates the run against that contract. Dream variants can then be compared to the original run without the evaluator silently changing the rubric after seeing different outcomes.

The scorer should not be just an LLM judge over the final answer. It should combine deterministic checks, trace-derived evidence, repo/test/probe results, supervision signals, user feedback, and LLM judgment for semantic qualities that cannot be checked mechanically.

## Core Principle

Separate these three jobs:

1. **Task analysis:** define the success contract.
2. **Run evaluation:** score one execution against that contract.
3. **Comparative analysis:** decide whether one run is meaningfully better than another.

If these are collapsed into one prompt, the system will be hard to calibrate. It will also be too easy for dream runs to win by changing the implicit standard of success.

## Evaluation Contract

The evaluation contract is the shared object used by live task analysis and dream analysis.

It should be produced once, versioned, and stored with the task or scenario. Later revisions are allowed, but they must create a new version so old dream comparisons remain interpretable.

```ts
TaskEvaluationPlan {
  id: string
  version: number
  projectId: string
  conversationId: string
  rootEventId: string
  createdAt: number
  createdBy: "deterministic" | "llm" | "human" | "hybrid"

  taskSummary: string
  userIntent: string
  explicitRequirements: Requirement[]
  inferredRequirements: Requirement[]
  constraints: Constraint[]
  allowedSideEffects: SideEffectPolicy[]
  expectedEvidence: EvidenceExpectation[]
  hardGates: HardGate[]
  scoreDimensions: ScoreDimensionSpec[]
  comparisonPolicy: ComparisonPolicy
}
```

The plan should distinguish explicit requirements from inferred requirements. Violating an explicit user instruction should be much worse than failing an inferred nicety.

Example requirements:

```ts
Requirement {
  id: string
  source: "user" | "project_instruction" | "agent_instruction" | "repo_convention" | "inference"
  text: string
  priority: "must" | "should" | "could"
  evidenceHint?: string
}
```

Example hard gates:

- no destructive action outside the allowed workspace
- no final completion while required todos remain unresolved
- no claim of delegation without a delegation event
- no passing score if tests required by the task fail
- no passing score if the final answer says work was done but no relevant side effect occurred
- no promotion if a dream variant improves one dimension while introducing a safety failure

## Evidence Bundle

The scorer should evaluate evidence, not vibes.

For each run, TENEX should assemble a normalized evidence bundle:

```ts
RunEvidenceBundle {
  runId: string
  scenarioId?: string
  evaluationPlanId: string
  mode: "live" | "dream"

  userMessages: MessageRef[]
  finalAnswer?: MessageRef
  conversationTranscript: TranscriptRef
  toolCalls: ToolCallRef[]
  toolResults: ToolResultRef[]
  fileDiffs: FileDiffRef[]
  commandResults: CommandResultRef[]
  testResults: TestResultRef[]
  probeVerdicts: ProbeVerdictRef[]
  delegationEvents: DelegationEventRef[]
  completionEvents: CompletionEventRef[]
  supervisionEvents: SupervisionEventRef[]
  telemetry: TelemetryRef[]
  userFeedback?: UserFeedbackRef[]
  cost: CostSummary
  durationMs: number
}
```

Useful existing surfaces:

- conversation rows in `crates/tenex-conversations`
- tool messages recorded by the agent runtime
- completion rows and final Nostr events
- runtime probe verdicts in `scripts/tenex-runtime-probe-verdicts.ts`
- supervision detections and re-engagements
- progress monitor stops
- shell/test output
- git diff or copied workspace diff
- user corrections after completion

The same evidence bundle shape should be used for live and dream runs. The dream runner may have a sandboxed filesystem and relay, but the evaluator should not care as long as the evidence bundle is normalized.

## Scoring Model

Use hard gates plus dimensional scores.

Hard gates answer: "Is this run disqualified or blocked from promotion?"

Dimensional scores answer: "How good was it among non-disqualified runs?"

Suggested dimensions:

```ts
RunEvaluation {
  id: string
  runId: string
  evaluationPlanId: string
  hardGateResults: HardGateResult[]
  dimensions: {
    correctness: DimensionScore
    completeness: DimensionScore
    instructionFollowing: DimensionScore
    safety: DimensionScore
    contextUse: DimensionScore
    verification: DimensionScore
    delegation: DimensionScore
    efficiency: DimensionScore
    recoverability: DimensionScore
    userExperience: DimensionScore
  }
  totalScore: number
  confidence: "low" | "medium" | "high"
  evaluatorVersions: EvaluatorVersion[]
  evidence: SourceRef[]
  summary: string
}
```

Each dimension should carry evidence and confidence:

```ts
DimensionScore {
  score: number        // normalized 0..1
  label: "failed" | "weak" | "acceptable" | "strong" | "excellent"
  confidence: "low" | "medium" | "high"
  rationale: string
  evidence: SourceRef[]
}
```

A total score is useful for ranking, but promotion should never depend only on the total. A dream run with better efficiency but worse correctness is not better.

## Score Dimensions

| Dimension | Question | Typical evidence |
| --- | --- | --- |
| Correctness | Did the produced work satisfy the actual task? | tests, probes, file diffs, semantic review, user correction |
| Completeness | Did the agent finish all required parts? | todo state, requirement checklist, unresolved asks/delegations, missing files |
| Instruction following | Did the agent follow user, project, and runtime instructions? | direct constraints, `AGENTS.md`, tool rules, final answer format |
| Safety | Did the run avoid harmful or unauthorized side effects? | shell commands, file writes/deletes, network calls, git operations, path boundaries |
| Context use | Did the agent inspect and apply the right context? | files read, docs consulted, RAG/search use, local pattern matching, preservation of unrelated changes |
| Verification | Did the agent verify at the right level for task risk? | test commands, runtime probes, typechecks, lint, stated verification blockers |
| Delegation | Did the agent coordinate with other agents appropriately? | delegation events, delegate prompt quality, completion routing, parent synthesis |
| Efficiency | Was the result achieved with reasonable cost and latency? | tokens, wall time, LLM turns, tool count, repeated loops |
| Recoverability | Was the run easy to inspect, revert, or continue from? | clean diff scope, durable logs, reproducible commands, clear final answer |
| User experience | Was the interaction useful to the user? | directness, surfaced blockers, clarification behavior, avoidable corrections |

Efficiency should usually be a tie-breaker, not the primary optimization target.

## Evaluation Pipeline

### 1. Build Or Retrieve The Plan

For a live task, TENEX creates an evaluation contract from:

- the triggering user message
- project instructions
- agent instructions
- known task type
- current conversation context
- existing eval fixtures for similar tasks

For a dream run, TENEX reuses the exact plan from the original scenario unless a human intentionally creates a new plan version.

### 2. Collect Evidence

After completion, TENEX builds the `RunEvidenceBundle`.

This should be mostly deterministic. The evidence collector should not judge; it should normalize facts.

### 3. Run Deterministic Checks

Examples:

- final event has `status=completed`
- expected tool event was published
- no mock fallback response appeared
- tests passed
- no pending delegation remained
- no forbidden command ran
- expected file changed
- expected transcript marker appears in the correct conversation

The existing runtime probe verdict style is the right shape: named verdicts with `ok` and `detail`.

### 4. Run LLM Judgment Where Needed

An LLM judge is useful for:

- semantic correctness
- instruction-following nuance
- context-use quality
- final-answer usefulness
- whether a clarification question was warranted

The judge should receive the frozen evaluation plan and a compact evidence bundle. It should return structured scores with citations to evidence ids. It should not be asked to infer from hidden chain-of-thought.

### 5. Combine Results

Hard gates can cap or disqualify the total score. Dimensional scores can be weighted by task type.

Example:

- coding implementation tasks weight correctness, verification, context use, and safety.
- planning tasks weight instruction following, completeness, and user experience.
- review tasks weight bug-finding quality, evidence, and false-positive control.
- delegation tasks weight routing, delegate prompt quality, and parent synthesis.

### 6. Store The Evaluation

Store the plan, evidence bundle pointer, deterministic verdicts, LLM judge output, score summary, and evaluator version.

Evaluator versioning matters because score drift will happen as prompts, models, and deterministic checks evolve.

## Comparative Analysis

Dreaming needs pairwise comparison, not only independent scores.

```ts
RunComparison {
  id: string
  evaluationPlanId: string
  baselineRunId: string
  candidateRunId: string
  winner: "baseline" | "candidate" | "tie" | "inconclusive"
  scoreDelta: DimensionDelta[]
  newFailures: HardGateResult[]
  resolvedFailures: HardGateResult[]
  confidence: "low" | "medium" | "high"
  rationale: string
  evidence: SourceRef[]
}
```

Comparison policy should prefer dominance:

- candidate fixes a hard failure and introduces no new hard failure
- candidate improves the task's primary dimensions
- candidate does not regress safety, correctness, or instruction following
- candidate improvement repeats across related scenarios
- candidate cost increase is justified by quality gain

If a variant wins only by being shorter, faster, or more assertive, it should not be promoted unless task quality is unchanged.

## Live Task Analysis And Dream Analysis

The same evaluator can run in two modes.

### Live Mode

Purpose:

- score the just-finished task
- generate user-visible confidence only when useful
- trigger supervision or re-engagement for clear failures
- decide whether to queue the scenario for dreaming
- capture user corrections as future labels

Live scoring should be conservative about blocking. TENEX already has supervision for immediate gates. The broader scorer can run after completion unless a hard runtime invariant is violated.

### Dream Mode

Purpose:

- score replayed variants against the frozen plan
- compare variants to the original run
- identify which prompt, memory, or policy change helped
- produce promotion proposals

Dream scoring can spend more tokens because it is offline. It can also run multiple evaluators or repeated candidate runs when the proposed promotion is risky.

## Relationship To Supervision

Supervision and scoring should remain separate.

Supervision is an online control loop. It decides whether the agent may continue, use a tool, or publish a completion.

Scoring is an outcome analysis loop. It grades what happened and produces evidence for dreaming, memory reconciliation, and future policy updates.

They can share signals:

- a supervision re-engagement is evidence for scoring
- repeated low scoring can suggest new supervision heuristics
- deterministic scorer checks can graduate into online gates if they are reliable

But not every low score should block live work. Some judgments are only safe after the full trace exists.

## Relationship To Memory Reconciliation

Scores are not memory by themselves. They are evidence.

A bad run should not automatically become "agent is bad at X." The reconciler should look for repeated patterns:

- "This agent skips repo orientation before editing Rust."
- "Runtime probe failures are often caused by incomplete conversation-route assertions."
- "This project requires preserving user worktree changes before patching."
- "Delegation prompts succeed more often when they include expected output shape."

The scorer provides structured failures and successes. The dream reconciler turns stable patterns into source-backed conclusions.

## Calibration

The scorer will need its own evals.

Calibration sources:

- human-labeled task outcomes
- existing runtime probe verdicts
- known bad runs
- known good runs
- pairs where humans prefer one run over another
- regression scenarios for prior scoring mistakes

Track:

- false positives: scorer says bad, human says acceptable
- false negatives: scorer says good, human finds important failure
- judge drift across model upgrades
- dimension weights that over-optimize cheap qualities
- score inflation over time

Human corrections are especially valuable. A user saying "this is wrong" should become both scenario evidence and scoring calibration data.

## Data To Avoid

Do not score using private chain-of-thought. Do not store it as evidence.

Avoid:

- hidden model reasoning
- raw provider internals not needed for auditing
- unverifiable evaluator speculation
- dream-only memories treated as real observations
- user preference guesses without user or behavioral evidence

Score observable behavior, artifacts, and outcomes.

## Minimal Implementation Path

1. Define `TaskEvaluationPlan`, `RunEvidenceBundle`, `RunEvaluation`, and `RunComparison` schemas.
2. Build evidence collection for runtime probe runs first.
3. Convert existing probe verdicts into hard-gate and deterministic-check results.
4. Add one LLM judge that scores semantic dimensions from a compact evidence bundle.
5. Store evaluator version, plan version, and source refs with every score.
6. Run the scorer on live completed tasks without blocking completion.
7. Queue low-scoring or high-uncertainty tasks as dream candidates.
8. Reuse the same evaluation plan for dream variants.
9. Add pairwise comparison and promotion proposal generation.

This path makes the scorer useful before the full dream system exists.

## Open Questions

- Should the evaluation plan be shown to the working agent as a success checklist?
- Should users be able to edit the evaluation contract before a high-stakes task begins?
- What score threshold should trigger dreaming?
- How should TENEX handle tasks where the user wanted exploration, not completion?
- How much should efficiency matter when a variant is more reliable but slower?
- Should evaluator output be visible in the UI, or mostly internal telemetry?
- Where should live evaluations be stored relative to conversation state?
- Should project owners be able to configure dimension weights?
