---
title: "Dreaming"
date: "2026-04-29"
audience: "llms"
scope: "Idea for offline counterfactual replay, agent-performance scoring, and memory reconciliation in TENEX"
status: "idea"
---

# Dreaming

## Question

What would it mean for TENEX agents to "dream" in a way that improves future behavior?

The useful version is not background summarization. It is an offline process that notices weak or surprising real runs, replays them in isolated worlds, tries variations of agent policy and memory, scores the outcomes, and promotes only source-backed improvements.

## Short Answer

TENEX dreaming should be **counterfactual replay plus memory reconciliation**.

A dream starts from a real scenario: a conversation, delegation tree, tool sequence, probe, user correction, failed verification, or costly run. TENEX snapshots enough state to replay it, runs the agent through the same scenario in a disposable sandbox, varies prompt definitions or memory organization, scores the outcomes, then discards the sandbox. The only durable output is an evaluated improvement: a proposed memory reconciliation, prompt patch, policy rule, eval fixture, or source-backed conclusion.

This keeps the agent from treating dreams as user-visible work while still letting it learn from apparent consequences.

See [SCORING.md](./SCORING.md) for the dedicated scoring and comparison model shared by live task analysis and dream analysis.

## Why "Dreaming"

Human dreaming is not known to have one settled purpose. The useful engineering analogy is that sleep appears to bundle several offline processes:

- **Memory consolidation:** recent experiences are compressed into more durable schemas.
- **Salience selection:** emotional, surprising, unresolved, or goal-relevant material gets extra processing.
- **Threat and failure simulation:** dangerous or difficult scenarios can be rehearsed without immediate real-world consequences.
- **Social simulation:** interactions and roles are modeled outside the original event.
- **Generalization:** noisy or recombined experience may reduce overfitting to one exact situation.
- **Creative recombination:** distant memories can be combined into new hypotheses.

For agents, the extrapolation should be conservative. TENEX should not hallucinate memories or preserve hidden reasoning. Dreams should produce inspectable, source-linked artifacts that can be reversed or superseded.

## Existing TENEX Substrate

The current Rust runtime already has most of the raw material for dreaming:

- `crates/tenex-conversations/src/schema.rs` stores conversations, messages, tool messages, per-agent prompt history, per-agent context state, and completion records.
- `crates/tenex-agent/src/main.rs` builds the agent prompt, loads tools, records tool calls, writes final turn state, and performs proactive RAG search across `conversations`, `project_<id>`, and `agent_<pubkey>` collections.
- `crates/tenex-agent/src/tools/rag_add_documents.rs` deliberately exposes only audience scopes, mapping `self` to the agent collection and `project` to the project collection.
- `crates/tenex-agent/src/tools/learn.rs` updates the agent's `+INDEX.md` through an LLM-maintained lesson index rather than storing lessons in RAG.
- `crates/tenex-summarizer/src/scheduler.rs` is a useful model for a background scanner: debounce recent activity, rate-limit repeated work, process quiet conversations, record state, and continue after failures.
- `crates/tenex-context/src/strategies/compaction.rs` shows that current compaction is token-budget oriented, not semantic consolidation.
- `scripts/tenex-runtime-probe.ts` and related probe scenarios already run realistic runtime flows with mock or cassette-backed LLM behavior.

This suggests a dreamer should be a runtime-adjacent service, not a tool the agent calls directly during ordinary work.

## Core Model

The basic loop:

1. **Record:** Capture a real scenario that went badly, ambiguously, expensively, or surprisingly.
2. **Score:** Produce a baseline evaluation of how well the agent performed.
3. **Select:** Decide whether the scenario deserves offline replay.
4. **Sandbox:** Create an isolated TENEX world where side effects are visible to the agent but discarded afterward.
5. **Vary:** Run the same scenario with controlled prompt, memory, retrieval, delegation, or verification variants.
6. **Evaluate:** Score each variant against the same criteria.
7. **Compare:** Look for robust improvements rather than one lucky run.
8. **Reconcile:** Convert the winning pattern into a source-backed memory or policy proposal.
9. **Promote:** Apply low-risk changes automatically, or require review for prompt identity and cross-agent policy changes.

## Scenario Recording

A scenario is a replayable unit of agent work. It should capture the observable setup, not the private chain-of-thought of the model.

Candidate triggers:

- user correction after completion
- failed test or runtime probe
- invalid tool call
- long run with no useful progress
- repeated delegation deadlock
- unexpected timeout or abort
- contradiction between memories
- high token or tool cost for a simple task
- low evaluator score
- high user value, even if successful

Minimum scenario contents:

```ts
Scenario {
  id: string
  projectId: string
  conversationId: string
  agentPubkey: string
  trigger: "user_correction" | "probe_failure" | "timeout" | "high_cost" | "manual" | ...
  rootEventId: string
  inputEvents: EventRef[]
  initialConversationState: SnapshotRef
  initialAgentConfig: SnapshotRef
  initialMemoryState: SnapshotRef
  toolTrace: ToolCallRef[]
  completionRef?: EventRef
  baselineScore?: EvaluationRef
  sourceRefs: SourceRef[]
  createdAt: number
}
```

The scenario does not need to preserve every byte forever. It needs enough evidence to replay, score, and justify any promoted update.

## Sandboxed Worlds

The agent should experience the dream run as normal work, but the outside world should not.

An isolated dream world should include:

- separate `TENEX_BASE_DIR`
- copied or disposable project working directory
- isolated conversation database
- isolated RAG and future conclusion store
- local relay namespace or replay transport
- fake or replayed external APIs
- mock, cassette, or controlled live LLM provider
- copied agent home files when relevant
- blocked or mediated network access for side-effecting tools
- durable dream logs outside the sandbox

Side effects inside the sandbox should be realistic:

- file writes appear to succeed
- shell commands run against the copied workspace
- Nostr events publish to the isolated relay
- RAG writes affect only the sandbox collection
- `learn` updates only the sandbox `+INDEX.md`
- delegated agents can run in the same dream world

After evaluation, the sandbox is deleted. TENEX keeps only the scenario record, dream run metadata, scores, and proposed durable artifacts.

## Variation Space

The first implementation should vary a small number of meaningful controls. Randomly perturbing everything will make attribution impossible.

Good early knobs:

- agent prompt definition
- injected `+INDEX.md` lesson set
- memory organization and conclusion selection
- proactive retrieval threshold
- whether proactive memory is injected or queried by tool
- delegation policy
- verification policy
- when to ask the user instead of continuing
- model choice for evaluator or worker roles

Examples:

```ts
Variant {
  id: string
  scenarioId: string
  description: string
  promptPatch?: PromptPatch
  memoryPatch?: MemoryPatch
  retrievalPolicy?: RetrievalPolicy
  delegationPolicy?: DelegationPolicy
  verificationPolicy?: VerificationPolicy
}
```

TENEX should prefer named variants over opaque prompt mutations. A named variant lets the reconciler say what actually helped.

## Scoring

The score should be multi-objective. A single scalar is useful for ranking, but the components matter more than the aggregate.

Hard signals:

- task completed
- tests passed
- runtime probe passed
- no invalid tool calls
- no forbidden side effects
- no timeout
- no unresolved delegation
- no repeated ask loop
- correct final event shape
- lower cost for equivalent quality

Soft signals:

- understood the user's actual request
- preserved unrelated user changes
- inspected the right source files
- used delegation appropriately
- asked for clarification when needed
- avoided invented facts
- scoped edits cleanly
- gave a useful final answer

Evaluation shape:

```ts
Evaluation {
  id: string
  scenarioId: string
  runId: string
  totalScore: number
  dimensions: {
    correctness: number
    completion: number
    safety: number
    contextUse: number
    verification: number
    efficiency: number
    userAlignment: number
  }
  hardFailures: string[]
  evidence: SourceRef[]
  evaluator: "deterministic" | "llm" | "human" | "hybrid"
  notes: string
}
```

The evaluator must compare the variant to the original run, not just grade it in isolation. The promotion rule should require a meaningful margin, no new hard failures, and ideally repeated wins across related scenarios.

## Guarding Against Score Gaming

Dreaming creates a Goodhart risk: the system may learn to maximize evaluator scores rather than do better work.

Mitigations:

- keep hard failure gates separate from soft scores
- use scenario families, not one-off wins
- include adversarial or held-out scenarios
- evaluate regressions on previously successful runs
- track cost and latency as constraints, not primary goals
- preserve evidence for every promoted update
- require human approval for broad policy or identity changes
- let memories be superseded or revoked

The dreamer should be conservative by default. A failed promotion is worse than a missed optimization because it changes future behavior.

## Memory Organization And Reconciliation

Dreams should not mainly add more memory. They should organize memory.

The primitive should be a source-backed conclusion, not a blob of retrieved text. Raw events and observations are evidence. Durable memory is a maintained representation of what TENEX believes is useful for future action.

Suggested distinction:

- **Observation:** Something that happened or was said.
- **Conclusion:** A derived belief or policy inferred from observations.
- **Card:** A compact current representation of a user, agent, project, task, subsystem, or workflow.
- **Reconciliation:** The process that merges, splits, supersedes, revokes, or scopes conclusions.

Potential conclusion shape:

```ts
Conclusion {
  id: string
  observerPubkey: string
  subjectKind: "user" | "agent" | "project" | "task" | "subsystem" | "workflow"
  subjectId: string
  scopeProjectId?: string
  kind: "preference" | "invariant" | "risk" | "workflow_policy" | "capability" | "failure_mode"
  statement: string
  premises: SourceRef[]
  confidence: "low" | "medium" | "high"
  status: "active" | "superseded" | "revoked"
  supersedes: string[]
  createdAt: number
  updatedAt: number
}
```

Reconciliation actions:

- merge duplicate lessons
- split project-specific facts from global agent behavior
- demote stale or contradicted conclusions
- convert repeated failures into workflow policies
- update an agent card with strengths and failure modes
- update a project card with invariants and verification recipes
- remove memory that no longer predicts future success
- produce a new eval scenario when a memory conflict cannot be resolved

For TENEX, this should sit beside the existing lesson and RAG systems:

- RAG stores retrievable documents.
- `+INDEX.md` stores compact agent-owned lessons that are always injected.
- A conclusion store would hold structured, scoped, provenance-aware memory.
- A reconciler would decide what belongs in each place.

## Promotion Gate

A dream run should never directly rewrite durable behavior just because one variant scored higher.

Promotion should produce a proposal:

```ts
PromotionProposal {
  id: string
  scenarioIds: string[]
  winningRunIds: string[]
  proposedChanges: ProposedChange[]
  scoreDelta: EvaluationDelta
  regressionChecks: EvaluationRef[]
  risk: "low" | "medium" | "high"
  requiresHumanApproval: boolean
  rationale: string
  evidence: SourceRef[]
}
```

Low-risk examples:

- add a source-backed project conclusion
- supersede a duplicate memory
- create a new eval fixture
- mark a scenario as needing more examples

Higher-risk examples:

- change an agent's base instructions
- change delegation policy globally
- change prompt compiler behavior
- promote user preference across projects
- modify scoring weights

The promotion artifact should explain both why the change helped and what it might break.

## Suggested TENEX Components

### Dream Scheduler

Background process similar in spirit to `tenex-summarizer`. It scans conversations, completions, probe results, telemetry, and manual marks. It chooses candidates after quiet periods, rate-limits repeated work, and records dream state so crashes do not duplicate expensive runs.

### Scenario Recorder

Builds replayable scenarios from real runs. It should know how to snapshot conversation state, project state, relevant agent config, memory state, and tool traces.

### Dream Runner

Runs actual TENEX binaries inside isolated worlds. It should reuse the runtime probe harness where possible, because probes already exercise relay routing, process execution, tool calls, persistence, and status publication.

### Variant Generator

Creates named variants from a controlled search space. Early versions can be hand-authored policies. Later versions can use an LLM to propose variants, but the generated variants should still be explicit and diffable.

### Evaluator

Scores baseline and dream runs. It should combine deterministic checks, probe verdicts, telemetry-derived metrics, and LLM judging where deterministic checks are insufficient.

### Reconciler

Turns winning or conflicting evidence into memory operations. It should prefer structured conclusions over more prose. It should also delete, supersede, or narrow stale memories.

### Promotion Reviewer

Applies low-risk proposals automatically and queues higher-risk proposals for human review.

## Minimal Viable Path

1. Add a manual `dream` command or script that replays one recorded probe scenario in an isolated base directory.
2. Score baseline versus one or two named prompt or memory variants.
3. Produce a Markdown promotion proposal without applying it.
4. Add a small conclusion store with source refs, scope, status, and supersession.
5. Teach the agent prompt builder or retrieval layer to include selected active conclusions.
6. Add reconciliation over `+INDEX.md`, RAG entries, and conclusions.
7. Add automatic candidate selection from failed probes, user corrections, and runtime telemetry.

This keeps the first milestone inspectable: TENEX can dream, but it cannot silently rewrite itself.

## Contracts And Invariants

- Dreams are never user-visible completions.
- Dream side effects are contained and discarded.
- Durable memory must cite evidence.
- The system must distinguish observation from conclusion.
- The system must distinguish project, agent, user, and global scope.
- A single dream run cannot promote a broad behavioral change.
- High-risk prompt or policy changes need review.
- Hidden chain-of-thought is not stored as memory.
- Agents do not manage RAG collections directly.
- The existing `learn` behavior remains `+INDEX.md` oriented unless intentionally redesigned.
- Dream replay should use real TENEX execution paths whenever practical.

## Failure Modes

- **Evaluator overfitting:** variants optimize the score but regress real work.
- **Memory bloat:** dreams add more facts without reconciling older ones.
- **False causality:** a variant wins by chance and the system attributes success to the wrong change.
- **Leaky sandbox:** a dream run publishes or writes outside the isolated world.
- **Prompt drift:** repeated small promotions make the agent less coherent.
- **Scope leakage:** a project-specific conclusion becomes global.
- **Contradiction hiding:** the reconciler merges conflicting memories too aggressively.
- **Cost runaway:** replay search consumes more tokens than the improvement is worth.

## Open Questions

- What is the smallest replay snapshot that preserves enough scenario fidelity?
- Should the first scorer be mostly deterministic, mostly LLM-judged, or hybrid?
- Where should conclusion memory live: conversation DB, project DB, separate memory DB, or agent home?
- How should promoted conclusions be injected: always-on prompt, proactive retrieval, or explicit memory query?
- How many scenario wins are enough before changing an agent prompt definition?
- Should dream scenarios be shared across agents, or owned by the observing agent?
- How do we represent negative lessons without making agents timid?
- What privacy boundary should apply to user-specific conclusions?

## Research Influences

- Plastic Labs, [Memory as Reasoning](https://blog.plasticlabs.ai/blog/Memory-as-Reasoning): memory as maintained representation and inference rather than static retrieval.
- Plastic Labs, [Honcho 3](https://blog.plasticlabs.ai/blog/Honcho-3): split ingestion, reasoning, and retrieval; observations versus conclusions; background Dreamer-style reasoning.
- Honcho docs, [Reasoning](https://docs.honcho.dev/v3/documentation/core-concepts/reasoning), [Dreaming](https://docs.honcho.dev/v3/documentation/features/advanced/dreaming), and [Chat](https://docs.honcho.dev/v3/documentation/features/chat): useful product vocabulary for memory reasoning and deep memory queries.
- Spens and Burgess, [A generative model of memory construction and consolidation](https://www.nature.com/articles/s41562-023-01799-z): memory as generative construction and schema consolidation.
- Wamsley, [Dreaming and offline memory consolidation](https://pmc.ncbi.nlm.nih.gov/articles/PMC4704085/): relationship between dreams and memory consolidation.
- Malinowski and Horton, [Emotion assimilation and dreams](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2015.01132/pdf): dream content as emotional memory processing.
- Hoel, [The Overfitted Brain Hypothesis](https://arxiv.org/abs/2007.09560): dreams as noisy offline experience that may improve generalization.
- Gwern, [AI Daydreaming](https://gwern.net/ai-daydreaming): background search and self-improvement loops for AI systems.
