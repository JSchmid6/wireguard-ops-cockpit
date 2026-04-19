# Project charter

## Problem statement

The target system should provide a secure operator cockpit for VPS administration where browser access is available only over WireGuard, automation remains transparent, and long-running work happens inside persistent `tmux` sessions that a human operator can inspect or take over at any time.

## Primary use cases

1. Start or resume an operations session for a task such as a Nextcloud update or OS upgrade.
2. Launch an agent into that session with task context, logs, and approval checkpoints.
3. Observe output live from the web UI and step in through the same `tmux` session when needed.
4. Trigger a limited set of audited runbooks for recurring actions.
5. Review audit history, job status, and session artifacts after the task completes.

## Non-goals for v1

- General-purpose shell access for arbitrary unaudited commands from the browser.
- Multi-tenant access for unrelated teams.
- Full infrastructure management across many hosts.
- Autonomous root access without approval or policy boundaries.

## Core requirements

- WireGuard-only reachability for the UI and control plane.
- Persistent `tmux` sessions as the operational backbone.
- Explicit privilege separation between UI, orchestrator, and privileged executors.
- Auditable actions, prompts, approvals, outputs, and exit states.
- Support for custom agents in addition to GitHub Copilot-powered workflows.
- Compatibility planning for GitHub Copilot cloud agent and GitHub Copilot Squad usage.

## Working assumptions

- Single primary VPS is the initial target.
- A trusted operator will connect through WireGuard from a local workstation.
- The first deployment can use Docker Compose for application services, while host integration may still use systemd and targeted `sudoers` rules.
- The first storage backend can be SQLite if concurrency remains low; PostgreSQL becomes an upgrade path.

## Open decisions

1. **Control backend stack:** Go, FastAPI, or Node.js/TypeScript.
2. **Web terminal approach:** `ttyd`, `Wetty`, or a custom `xterm.js` bridge to `tmux`.
3. **Auth model:** local accounts, external OIDC, or GitHub OAuth plus WireGuard.
4. **Approval policy:** confirm only privileged steps, or require approval for every runbook and agent action.
5. **Data store:** SQLite for v1 or PostgreSQL from day one.
6. **Agent substrate:** local Copilot CLI sessions, GitHub Copilot cloud agent, Copilot Squad, or a hybrid execution model.
7. **Deployment split:** all services in Compose, or Compose plus dedicated systemd units for host-facing workers.

## Recommended defaults

- **Backend:** TypeScript for UI and control plane if the implementation favors GitHub/Copilot ecosystem alignment; otherwise Go for a leaner runtime.
- **Terminal bridge:** start with `ttyd` or `Wetty` behind the control plane instead of building a custom PTY bridge in v1.
- **Auth:** keep local auth plus strong WireGuard restriction for v1; add OIDC later if needed.
- **Approval:** mandatory approval for any privileged runbook or package-management action.
- **Storage:** SQLite first, with a schema that can move to PostgreSQL later.
