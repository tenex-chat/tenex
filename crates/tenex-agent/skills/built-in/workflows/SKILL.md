---
name: workflows
description: Define and dispatch named multi-step workflows that turn into todo checklists, so a long procedure does not get partially forgotten between turns.
tools:
  - create_workflow
  - run_workflow
---

# Workflows

A workflow is a named procedure you have written down once so you can later dispatch it without re-deriving the steps. Dispatching a workflow turns it into your active todo checklist for a specific task.

Use this skill when you (a) repeatedly perform the same multi-step procedure and notice yourself skipping steps mid-execution, or (b) the user describes a recurring process that should not drift over time.

## When to author a workflow

Author with `create_workflow` when:

- The same multi-step procedure appears in several conversations
- Skipping a single step typically causes a regression (e.g., "always run the type-check before declaring done", "always announce completion in the briefing channel")
- The decision points in the procedure are stable enough that a model can specialise them to a fresh task

Do **not** author one-off plans this way — `todo_write` is the right tool for a single task's checklist.

## When to dispatch a workflow

Call `run_workflow("<name>", "<task description>")` when you are about to begin work that fits one of your authored workflows. Dispatch **replaces your current todo list**, so only call it when you are starting fresh — not partway through unrelated work.
