# Copilot cloud agent brief

Use this brief when asking GitHub Copilot cloud agent to extend this repository without regressing the current bounded execution model.

## Objective

Build or extend the **repository codebase and tests** for `wireguard-ops-cockpit` based on the existing planning docs, while preserving the current bounded host-runtime model and avoiding broad privilege shortcuts.

## Required inputs

Read these files first:

1. `README.md`
2. `doc/setup/project-charter.md`
3. `doc/setup/copilot-squad-adoption.md`
4. `doc/setup/agent-stack.md`
5. `doc/services/target-architecture.md`
6. `doc/migration/implementation-plan.md`

## Default implementation baseline

Unless the user overrides it in the task:

- use a TypeScript monorepo
- create a small React web UI
- create a Node.js/TypeScript backend
- use SQLite for persistence
- preserve the existing host-runtime split: host API, host `tmux`, bounded helper scripts, and localhost terminal bridge
- prepare the codebase for Docker Compose deployment

## Required boundaries

Do **not** do any of the following in the first implementation pass:

- add unrestricted shell execution from the UI
- implement blanket `sudo` access
- assume direct Docker socket access from web-facing services
- hardcode secrets, tokens, or WireGuard credentials
- bypass approval and audit concepts described in the architecture docs

## Expected deliverables

1. repository scaffolding for UI and backend
2. initial database schema and migrations
3. session/job/audit domain model
4. bounded runbook registry with explicit helper contracts
5. custom-agent registry contract
6. testable API and UI skeleton
7. local developer instructions
8. Compose-based dev or local runtime

## Squad-specific preparation

If Squad is available in the environment:

1. initialize Squad in the repository
2. keep generated team state under version control if it is repo-local
3. preserve any generated governance files unless they conflict with explicit project docs
4. record important implementation decisions in repository docs instead of leaving them implicit
5. use the repository agents and skills under `.github/agents/` and `.github/skills/`

## Customization assets included in this repository

- `.github/agents/ops-cockpit-architect.agent.md`
- `.github/agents/mcp-governor.agent.md`
- `.github/agents/security-champion.agent.md`
- `.github/skills/ops-cockpit-implementation/`
- `.github/skills/security-review/`
- `.github/skills/mcp-governance/`
- `.squad/decisions.md`
- `config/copilot-cloud-agent-mcp.example.jsonc`

## Suggested first task for the cloud agent

Implement the repository skeleton for a WireGuard-only VPS operations cockpit with:

- an authenticated web UI shell
- a backend API for sessions, jobs, audits, and approvals
- a runbook abstraction layer that stays inside the existing bounded host-helper pattern
- a custom-agent manifest model
- tests for the initial API/domain behavior

The agent should extend the existing bounded design rather than reintroducing placeholder behavior or broad host execution paths.
