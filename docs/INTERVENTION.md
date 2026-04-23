# Intervention

Intervention is the mechanism that nudges a designated reviewer agent when a human user has gone silent after an agent finished its work.

This document describes the intended behavior of intervention. It is written so that anyone making changes to intervention can understand what it is supposed to do without reading code.

## Why it exists

When an agent finishes working on a human-initiated conversation, we expect the human to either engage with the result or move on. Sometimes they do neither — they walk away, they get distracted, they forget the conversation is waiting on them. The conversation stalls in a soft-failed state: the agent considers itself done, but nothing was actually delivered or acknowledged.

Intervention exists to detect that stall and involve a second agent — the **intervention agent**, sometimes called the reviewer — whose job is to decide whether the work warrants a follow-up, a prompt back to the user, a correction, or nothing at all. Intervention does not do the reviewing itself. It only decides when the reviewer should be pinged.

## Core concept

Intervention watches a single pattern: **an agent publishes a completion targeting a human user, and the human does not respond within a bounded window**. When that pattern occurs, a review request is published for the intervention agent.

Everything else in intervention exists to answer two questions:

1. Is this the kind of completion we should be watching? (eligibility)
2. Did the human come back in time? (cancellation)

## Lifecycle

Intervention for a given conversation moves through three states:

- **Idle.** Nothing is being watched for this conversation. This is the default.
- **Armed.** A completion was observed, eligibility passed, and a timer is counting down toward the review deadline.
- **Notified.** A review request was published. The conversation stays in this state for a cooldown window during which further completions on the same conversation are ignored.

The transitions are:

- Idle → Armed: an eligible completion is observed.
- Armed → Idle: the human posts into the conversation before the deadline.
- Armed → Notified: the deadline passes and eligibility still holds. A review request is published.
- Notified → Idle: the cooldown expires.

If a new eligible completion arrives while the conversation is already Armed (e.g. the agent publishes a second completion without the user in between), the armed state is refreshed — the new completion replaces the old one and the timer restarts. There is at most one Armed state per conversation.

## When a completion is eligible

A completion triggers intervention only if **every** one of the following holds. Each condition exists for a specific reason; together they prevent the reviewer from being woken up for situations where a human wouldn't have been expected to reply anyway.

### The conversation is top-level

The conversation must have been started by a human. Conversations spawned by any of the following are ineligible:

- **Delegation from another conversation.** An agent can spawn a conversation by delegating work to another agent. These conversations are agent-to-agent; there is no human waiting.
- **Scheduled tasks.** The system can start a conversation on a timer. Nobody is expected to watch these and reply.
- **Intervention itself.** A review request creates its own conversation thread. If we nudged about those, a reviewer that didn't respond would trigger a review of the review, forever.

All three cases collapse to one rule: the conversation's root event must be authored by a whitelisted human pubkey — not the backend, not any agent in the project.

### The user is whitelisted

Even if the conversation is top-level, the specific target of the completion must be a whitelisted human pubkey. This rejects:

- Completions addressed to agents (which happen during delegation follow-through even inside a human-started conversation).
- Completions addressed to the backend key (system-level events).
- Completions addressed to unknown pubkeys we have no trust relationship with.

### The agent has no outstanding delegated work

If the agent that "completed" has any still-running delegations on this conversation, the work is not actually finished — it has just paused on its own thread while waiting for sub-agents. Arming here would fire while the conversation is still actively progressing.

### The completing agent is not itself the intervention agent

If the reviewer completes a review and we treated that as a new completion, we would schedule a review of the review. This guard exists even though the top-level rule already prevents most such loops, because the reviewer could post a follow-up inside the *original* human-started conversation, which on its own would look eligible.

### The conversation is not already in the Notified cooldown

Once a review request has been published for a conversation, further completions on that same conversation are ignored until the cooldown expires. This prevents the reviewer from being re-pinged every time the agent publishes another attempt while the human remains silent.

### Intervention is enabled and an agent is configured

If the feature is turned off or no intervention agent slug is configured, nothing ever arms. If the configured slug cannot be resolved to a pubkey in this project, nothing ever arms for that project.

## The deadline

When a conversation is armed, a timer is set to fire a fixed duration after the completion. The duration is configurable; the default gives the human a few minutes to respond before the reviewer is pinged.

The timer represents the human's grace period. Its precise length is a policy choice, not a structural one — shortening or lengthening it changes how responsive intervention is without changing anything else in the lifecycle.

## What cancels the armed state

Any post from the armed user into the armed conversation, arriving before the deadline, cancels the timer. Intervention is not trying to interpret what the user said; engagement of any kind is treated as "the human is back, stand down."

Posts from other users, from agents, from the backend, or into other conversations, do not cancel. This is deliberate: intervention is watching for a specific human to re-engage with a specific conversation.

## What happens when the timer fires

At fire time, eligibility is re-evaluated from scratch. The world may have changed while the timer was running — a new delegation may have started, the conversation may have become non-top-level in an edge case, the configuration may have been disabled. If any eligibility condition no longer holds, the fire is discarded silently and the conversation returns to Idle.

If eligibility still holds, a review request is published. The review request is a Nostr event targeted at the intervention agent, signed by the system's backend key, and threaded into the project so that the intervention agent sees it like any other work assigned to it. The request includes:

- Which conversation is being reviewed.
- Which agent completed the work.
- Which user has gone silent.
- A human-readable prompt asking the reviewer to decide whether action is warranted.

The review request flows through the normal event pipeline. The intervention agent is not launched through any special path; it picks up the request, decides what to do, and either posts a response into the reviewed conversation, delegates, or does nothing — whatever the reviewer's prompt tells it to.

## The cooldown after notification

After a review request is published for a conversation, further intervention activity on that conversation is suppressed for a cooldown window (currently 24 hours). Within the cooldown:

- New completions on the same conversation do not arm.
- The Notified state is treated as sticky.

This prevents the reviewer from being repeatedly pinged about the same silent user while the agent continues to work on the conversation. The tradeoff is that within the cooldown there is one intervention per conversation; if the first review didn't resolve the stall, there is no automatic second chance inside the window. This is intentional — we prefer under-nudging to nudge-spam.

After the cooldown, the conversation returns to Idle and is eligible again.

## Configuration

Intervention configuration is global (one set of values shared across all projects), but agent slug resolution is per-project — the same configured slug can resolve to a different pubkey in each project, and intervention will arm for each project independently.

The configurable knobs are:

- Whether intervention is enabled at all.
- Which agent slug serves as the reviewer.
- How long the grace period is before the timer fires.

The 24-hour cooldown, the exclusion rules above, and the retry policy for failed publishes are fixed behavior, not configuration.

## What intervention is not

Intervention is not any of the following, even though people sometimes conflate them:

- **Supervision.** Supervision checks an agent's behavior *before* a completion is allowed to publish. It is a pre-publish gate. Intervention observes *after* publish and does not block anything.
- **Escalation.** Escalation is the mechanism by which an agent can redirect its own `ask()` to a designated intermediary when no human is directly addressable. It runs inside an agent's own turn. Intervention runs outside any agent's turn, after one has finished.
- **Delegation completion.** When an agent finishes delegated work and sends a completion back to its delegator, that is delegation tracking (RAL). Intervention only activates when the completion reaches a human user at the top of the conversation tree.

Intervention is a safety net for silent humans, nothing more.

## Relationship to the daemon

Intervention is a daemon-lifetime concern. The timer must survive individual worker executions because the grace period is longer than any single worker lives. The daemon owns the armed state, observes completions and user replies, fires timers, and publishes review requests. Agent workers only contribute to intervention by the events they publish through the normal event pipeline; they do not call into intervention directly.

## Navigation pointers

For contributors who need to locate intervention code, start with the `intervention` module inside the daemon crate. The durable arm/fire state is expressed in terms of the daemon's existing scheduled-wakeup primitives. Eligibility checks consult the daemon's project agent inventory, the delegation/RAL state, and the trust/whitelist configuration. The review request is published through the standard backend publish pipeline, and the resulting event is routed to the intervention agent by the same inbound routing that handles every other project event.

These pointers are deliberately brief. If any of the behavior described above is unclear from the code, fix the code or the doc — not by adding more pointers here.
