# Implementation plan

## Delivery strategy

Build the platform in layers so the first usable version already gives safe operator visibility and session takeover, then add runbooks and agent features on top.

## Phase 0 - Foundations

- Choose the backend stack and terminal bridge.
- Create the application skeleton and local development environment.
- Define the initial database schema for users, sessions, jobs, approvals, and audit entries.
- Decide whether deployment is all-Compose or a Compose plus systemd hybrid.

## Phase 1 - Secure access and identity

- Bind the UI and API only to the WireGuard network path.
- Add application authentication and session handling.
- Implement an `admin` role first; postpone richer roles until real usage requires them.
- Add basic audit logging for login and session activity.

## Phase 2 - Persistent session layer

- Implement `tmux` session creation, discovery, resume, and cleanup policies.
- Add a browser terminal attachment flow.
- Make every task map to a named session and durable job record.
- Expose session status and transcript references in the UI.

## Phase 3 - Runbooks and controlled privilege

- Define 5 to 10 bounded runbooks for the first release.
- Add wrapper scripts or helpers for privileged tasks with narrow `sudoers` rules.
- Require approval before package-management, service-management, or OS mutation steps.
- Capture structured output, exit codes, and rollback hints for each runbook.

## Phase 4 - Agent execution

- Implement an agent registry with versioned manifests.
- Start agents inside existing `tmux` sessions, not detached hidden shells.
- Pass context, repository path, environment, and approval hints to the selected agent.
- Support custom agents first, then add Copilot-oriented adapters.

## Phase 5 - GitHub and Copilot integration

- Add GitHub repository integration for task metadata and source-controlled agent definitions.
- Refine `.github/workflows/copilot-setup-steps.yml` as the codebase gains dependencies.
- Define how Copilot cloud agent, Copilot CLI, and future Copilot Squad usage map onto the local execution model.
- Ensure any cloud-side agent work produces plans or patches that still require local controlled execution for host changes.

## Phase 6 - Production hardening

- Add health checks, backup strategy, alerting, and session retention policies.
- Test recovery from interrupted upgrades, server restarts, and broken agent runs.
- Tighten firewall rules, service permissions, and secrets management.
- Validate reboot persistence for all long-lived services.

## Suggested v1 scope

Ship v1 when all of the following exist:

1. WireGuard-only access path
2. Application login
3. Persistent `tmux` sessions
4. Browser terminal attach
5. Job and audit records
6. 3 to 5 safe runbooks
7. One custom agent integration
8. One Copilot-oriented workflow adapter

## Initial runbooks

- Nextcloud application update
- Distribution package upgrade
- Container or service restart
- Disk and backup health check
- Log bundle collection for incident debugging

## Acceptance criteria

- An operator can start a task, observe it in real time, and take over through the same session.
- A privileged operation cannot run without the configured approval path.
- All important actions are attributable after the fact.
- A reboot does not silently break the cockpit's core services.
- The architecture stays compatible with adding custom agents and Copilot Squad-oriented workflows later.
