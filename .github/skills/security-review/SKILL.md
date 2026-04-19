---
name: security-review
description: Security review procedure for this repository. Use this when reviewing architecture, code, workflows, MCP usage, host-integration boundaries, or runbook safety.
user-invocable: false
---

# Security Review

Use this skill whenever the task touches authentication, sessions, terminal bridging, runbooks, MCP, workflow secrets, or host privilege boundaries.

## Process

1. Read the [threat model checklist](./threat-model-checklist.md).
2. Identify trust boundaries and attacker-controlled inputs.
3. Check whether WireGuard is incorrectly treated as the only security control.
4. Review how the change affects approvals, auditability, and privilege escalation risk.
5. Escalate to the `security-champion` agent for deep review when the task affects security-sensitive code or design.

## Repository-specific hotspots

- browser terminal attachment
- websocket/session auth
- runbook parameter handling
- shell command construction
- `sudoers` and helper boundaries
- MCP tool exposure
- secret propagation in GitHub settings and workflows

Use the accompanying checklist file for concrete review points.
