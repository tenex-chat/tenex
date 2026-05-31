---
title: Summarizer
slug: summarizer
summary: The summarizer uses the model "openrouter/openai/gpt-4o-mini" via OpenRouter for its summarization role.
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-03
updated: 2026-05-03
verified: 2026-05-03
compiled-from: conversation
sources:
  - session:a9f3bf6d-8036-406c-9792-70df3a59dc49
  - session:2bb7b8ee-5386-4998-b3d1-e8842f41e901
---

# Summarizer

## Model

The summarizer uses the model "openrouter/openai/gpt-4o-mini" via OpenRouter for its summarization role. [^a9f3b-1]


## Scheduling

The summarizer scheduler scans for conversations with recent activity every 5 seconds. It identifies conversations with recent activity that are between 10 seconds and 7 days old. A conversation must not be re-summarized more frequently than every 10 minutes. [^a9f3b-2]

## Output

When summarizing a conversation, the LLM generates a title, a 1-sentence summary, a status label/activity, and category tags. Generated summary metadata is written locally and published to Nostr relays. [^a9f3b-3]

## Constants

The minimum interval between successive summaries for a given conversation (MIN_INTERVAL_MS) is set to 10 minutes. [^a9f3b-4]

The summarizer scheduler logs the full anyhow cause chain for conversation.db open failures using Debug formatting (?e) instead of Display formatting (%e). [^2bb7b-4]
## See Also

