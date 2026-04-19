# Agent stack and customization strategy

## Goal

Shape the repository so GitHub Copilot, custom agents, and Squad all work toward the same architecture instead of inventing competing workflows.

## Recommended agent roles

### 1. `ops-cockpit-architect`

Owns architecture consistency for the product:

- web UI, API, session manager, runbook boundaries
- persistent `tmux` session model
- audit and approval flows
- Docker Compose and deployability

### 2. `mcp-governor`

Owns MCP safety and integration design:

- which MCP servers are allowed
- which tools are allowlisted
- how secrets are injected
- whether a proposed MCP server belongs in cloud-side repo work at all

### 3. `security-champion`

Owns security review and hardening:

- auth and session controls
- command injection and shell bridging risks
- file/path traversal, SSRF, CSRF, XSS, secret handling
- privilege boundaries for runbooks and host integration
- dependency and supply-chain checks

## Model guidance

Use the strongest available reasoning model for the `security-champion` role whenever your GitHub Copilot plan and interface allow explicit model choice.

Recommended priority:

1. **GPT-5.4** as the default practical choice for this project
2. **Claude Sonnet 4.6** for good standard-quality review if needed
3. **GPT-5.4 mini** for cheaper routine work

For architecture and MCP design, a standard model is usually enough. Use GPT-5.4 for the `security-champion` by default unless a stronger security-specialized option becomes available and worth the extra cost.

## Skill strategy

Project skills should capture repeated procedures that should stay consistent across Copilot CLI, VS Code, and Copilot cloud agent:

- `ops-cockpit-implementation`
- `security-review`
- `mcp-governance`

These belong in `.github/skills/` so they remain repository-local, versioned, and reviewable.

## MCP strategy

### Default rule

**Default deny.** Only allow MCP servers and tools that are explicitly justified for repository work.

### Early safe candidates

- built-in `github` read-only tooling
- built-in `playwright` tooling for localhost UI testing
- optional future observability tools with read-only operations

### Avoid in the first implementation pass

- action-capable infrastructure MCP servers
- broad admin or deployment MCP servers
- anything that lets cloud-side agents mutate the real VPS
- remote MCP servers that rely on unsupported or brittle auth flows

## Squad bootstrap approach

Use `squad init` once the repository is on GitHub and cloned into a real development environment. The repository already includes:

- custom agents under `.github/agents/`
- skills under `.github/skills/`
- initial memory and decisions under `.squad/`
- a repository `squad` coordinator stub under `.github/agents/squad.agent.md`

This gives Squad and Copilot a project-specific baseline before code generation starts.

## Working rule for this project

Cloud-side agents build and review the repository. Local controlled services perform host operations later through explicit runbooks and approvals.
