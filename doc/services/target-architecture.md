# Target architecture

## Design principle

The web application must never be the system's privilege boundary. It is only a presentation and request layer. All sensitive execution must pass through explicit policies, audited jobs, and narrow privilege escalation paths.

## Top-level components

### 1. Web UI

- Reachable only on the WireGuard interface or behind a firewall rule that limits access to `wg0`.
- Provides dashboards for sessions, jobs, runbooks, logs, approvals, and audit history.
- Embeds a terminal view into an existing `tmux` session rather than creating ad-hoc shells.

### 2. Control API

- Accepts requests from the Web UI.
- Enforces authentication, RBAC, approval state, and runbook allowlists.
- Creates jobs, allocates sessions, and routes execution to lower-trust workers.
- Never exposes arbitrary shell execution to the browser.

### 3. Session manager

- Owns the lifecycle of named `tmux` sessions.
- Creates task-scoped sessions such as `nextcloud-upgrade`, `os-upgrade`, or `incident-debug`.
- Captures session metadata, attachments, and terminal bridge configuration.

### 4. Agent runner

- Starts approved agent processes inside a prepared `tmux` pane or window.
- Supports local custom agents, Copilot CLI workflows, and future GitHub Copilot Squad-oriented task execution.
- Injects task context, repo path, environment variables, and policy hints.

### 5. Runbook executor

- Executes only predeclared tasks such as package updates, service restarts, backup checks, and Nextcloud maintenance flows.
- Uses narrow `sudoers` entries or service-specific helpers for privileged operations.
- Returns structured status, logs, and artifacts back to the Control API.

### 6. Audit and state store

- Persists jobs, prompts, commands, approvals, exit codes, operator interventions, and references to session transcripts.
- Starts with SQLite in v1, with a migration path to PostgreSQL.

## Trust boundaries

### Boundary A: WireGuard network

- Only peers on the WireGuard mesh can reach the UI and API.
- This reduces exposure but does not replace application authentication or authorization.

### Boundary B: Control API to workers

- The Control API talks to workers over localhost or an internal Docker network.
- Workers run under dedicated service identities.

### Boundary C: Privileged execution

- Privileged operations are isolated behind narrowly scoped helpers.
- No web-facing service user is added to `docker`, `sudo`, or equivalent broad privilege groups.
- Prefer specific `sudo` commands, wrapper scripts, or systemd units over blanket root shells.

## Runtime topology

## Host services

- `wireguard`
- reverse proxy or direct bind on WireGuard IP
- `tmux`
- selected `sudoers` policies

## Application services

- `ui`
- `control-api`
- `session-manager`
- `agent-runner`
- `runbook-executor`
- `sqlite` file storage or future `postgres`

## Operator flows

### Interactive admin task

1. Operator opens the UI over WireGuard.
2. Operator creates or resumes a task session.
3. Control API ensures a matching `tmux` session exists.
4. Agent runner starts the selected agent in that session.
5. Browser terminal attaches to the session.
6. If the workflow hits an approval gate or looks risky, the operator intervenes in the same session.

### Approved runbook

1. Operator selects a predefined runbook.
2. Control API checks policy and approval requirements.
3. Runbook executor runs a bounded helper.
4. Logs, exit status, and resulting artifacts are attached to the job record.

## Custom agent support

- Agents must register a manifest that defines:
  - name and description
  - expected inputs
  - working directory or repository binding
  - required tools
  - whether approval is mandatory before execution
  - whether privileged helpers may be requested
- Initial implementation can use a simple file-based manifest directory, later replaced by DB-backed registration.
- The same execution contract should support:
  - local CLI agents
  - custom wrappers
  - GitHub Copilot-driven sessions
  - future Copilot Squad task delegation patterns

## GitHub Copilot and Squad alignment

- Keep agent task definitions repository-backed so they can be versioned and reviewed.
- Add `.github/workflows/copilot-setup-steps.yml` early so Copilot cloud agent receives deterministic tooling.
- Treat Copilot cloud agent and Copilot Squad as accelerators for repository work, not as unrestricted host administrators.
- For host changes, require the platform to route execution back through local runbooks or session-controlled workers.

## Security controls checklist

- UI and API accessible only from WireGuard.
- Separate service users for each runtime role where practical.
- Secrets stored outside the repository and injected at deploy time.
- Full audit trail for prompts, actions, approvals, and interventions.
- Rate limiting and session expiration on the application layer.
- Approval gates for package upgrades, reboot requests, and config mutations.
- Recovery path for interrupted upgrades and abandoned sessions.
