---
name: ops-cockpit-implementation
description: Repository-specific implementation guidance for the WireGuard-only ops cockpit. Use this when creating or restructuring the app, API, data model, sessions, approvals, audits, or runbook abstractions.
user-invocable: false
---

# WireGuard Ops Cockpit Implementation

Use this skill when implementing repository code for this project.

## Required reading

Read these first:

1. [project charter](../../../doc/setup/project-charter.md)
2. [target architecture](../../../doc/services/target-architecture.md)
3. [implementation plan](../../../doc/migration/implementation-plan.md)
4. [agent stack](../../../doc/setup/agent-stack.md)

## Implementation rules

1. Keep the web UI separate from any privileged execution path.
2. Model `tmux` sessions, jobs, approvals, audits, and runbooks as first-class concepts.
3. Prefer explicit placeholders over fake host integration.
4. Do not add unrestricted shell execution to the browser workflow.
5. Design for Docker Compose deployment of app services, while leaving host-coupling as a later integration step.

## When to delegate

- Use the `security-champion` agent for security review or risky design questions.
- Use the `mcp-governor` agent for MCP server decisions.

## Output expectation

Deliver code and docs that make the trust boundaries obvious to future contributors.
