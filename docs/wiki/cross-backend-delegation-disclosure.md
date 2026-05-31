---
title: Cross-Backend Delegation Disclosure
slug: cross-backend-delegation-disclosure
summary: When an agent is delegated to by a remote-backend agent, its user message includes a disclosure stating there is no shared filesystem and coordination must happ
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-04
updated: 2026-05-04
verified: 2026-05-04
compiled-from: conversation
sources:
  - session:0149dc43-0d5b-44fd-b432-426c3cbf45cf
---

# Cross-Backend Delegation Disclosure

## Cross-Backend Delegation Disclosure

When an agent is delegated to by a remote-backend agent, its user message includes a disclosure stating there is no shared filesystem and coordination must happen via the conversation. This cross-backend disclosure applies only when the delegating author is another project agent (identified via project p-tags), not when the author is a whitelisted human user. Inbound remote-agent delegation classification uses `project_member_pubkeys()` against the project's p-tag set, correctly excluding remote agents from the `is_external` (firewall) bucket where they had previously been misclassified. [^0149d-4]

## See Also

