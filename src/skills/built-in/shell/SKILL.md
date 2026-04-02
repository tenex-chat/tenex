---
name: Shell Execution
description: Execute shell commands in the project directory
tools:
  - shell
---

# Shell Execution

Environment variables are expanded: `nak --sec $NSEC -c "$(cat $AGENT_HOME/content.txt)"`
