# Threat model checklist

## Access control

- Is application auth present in addition to WireGuard?
- Are authorization checks explicit for sessions, jobs, approvals, and logs?
- Could one operator access another task or session accidentally?

## Terminal and command safety

- Can browser input influence command execution unsafely?
- Are runbook parameters validated and bounded?
- Is there any path from UI input to arbitrary shell execution?

## Privilege boundaries

- Does any web-facing service gain broad system rights?
- Is Docker socket access being used as a shortcut?
- Are privileged tasks routed through narrow helpers instead of blanket sudo?

## Network and secret handling

- Are secrets kept out of the repository?
- Are MCP credentials scoped and named with the proper `COPILOT_MCP_` prefix when needed?
- Are external callbacks, URLs, or fetch targets validated?

## Auditing and recovery

- Are sensitive actions attributable after the fact?
- Are approval checkpoints explicit before risky mutations?
- Is there a safe recovery path for interrupted upgrades or abandoned sessions?
