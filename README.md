# wireguard-ops-cockpit

WireGuard-only operations cockpit for VPS administration with persistent `tmux` sessions, browser access, bounded runbooks, and agent orchestration for tools such as GitHub Copilot and custom agents.

The repository now includes a first working implementation slice:

- a small React web UI
- a Node.js/Fastify control API
- SQLite-backed state for users, sessions, jobs, approvals, and audits
- explicit `tmux` session management
- bounded host runbooks for disk checks, Nextcloud planning, manifest-bound Nextcloud rollback, and selected service restarts
- a public `planner-agent` plus a supervised session repair agent, both staying advisory-only behind approvals and bounded runbooks
- a `ttyd`-backed browser terminal bridge for task-scoped `tmux` sessions

## Current implementation boundaries

This first pass keeps the trust boundaries explicit:

- the web UI is never the privilege boundary
- application login still matters even on WireGuard-only networks
- `tmux` sessions are first-class
- browser terminal attachment is represented through an external ttyd-compatible URL, not hidden shell access
- privileged host behavior runs only through bounded host helpers, approvals, and narrow `sudoers` rules

## Repository structure

- `apps/api/` - Fastify control API, SQLite storage, auth, sessions, audits, approvals, runbooks, agents
- `apps/web/` - React cockpit UI shell
- `packages/domain/` - shared domain types
- `packages/tmux-adapter/` - safe local `tmux` adapter with disabled fallback
- `doc/` - charter, architecture, rollout, and Copilot/Squad guidance
- `.github/workflows/` - cloud-agent setup workflow
- `.github/skills/` and `.squad/` - repo-local implementation guidance and memory

## Source of truth

Read these first:

1. `doc/setup/project-charter.md`
2. `doc/services/target-architecture.md`
3. `doc/migration/implementation-plan.md`
4. `doc/setup/copilot-squad-adoption.md`
5. `doc/migration/copilot-cloud-agent-brief.md`
6. `doc/setup/agent-stack.md`
7. `doc/services/execution-control-model.md`

## Quick start

1. Copy `.env.example` to `.env`
2. Change `COCKPIT_ADMIN_PASSWORD`
3. Make sure GitHub Copilot CLI is installed and authenticated if you want a real `planner-agent` runtime
4. Install dependencies
5. Start the API and web UI in separate terminals

```bash
cp .env.example .env
npm install
npm run dev:api
npm run dev:web
```

Planner runtime notes:

- default planner runtime: `COCKPIT_PLANNER_RUNTIME=copilot-cli`
- fallback planner runtime: `COCKPIT_PLANNER_RUNTIME=demo-local`
- default executable: `COCKPIT_COPILOT_EXECUTABLE=copilot`
- optional model pin: `COCKPIT_COPILOT_MODEL=gpt-5.4`
- the planner runtime is intentionally bounded to plan-only Copilot CLI usage; host mutation still stays behind approvals and bounded runbooks
- runbook plans now attach a reviewable safety report in Session detail; high-risk plans stay blocked or pending approval until that review path clears
- runbook cards now expose reviewed workflow steps so multi-step flows such as Nextcloud maintenance can stay visible in the dashboard
- the Nextcloud maintenance path is now split into bounded preflight, maintenance-mode, occ-upgrade, maintenance-exit, verification, and optional restart runbooks instead of one larger follow-up step
- Nextcloud rollback is now a separate reviewed restore plus verify path that only reads an approved manifest under the bounded backup root before maintenance mode is cleared again
- the supervised repair agent now carries an explicit checkpoint contract in the execution plan and a reviewable checkpoint state in the launched job, so the dashboard can show and advance structured operator checkpoints without turning the agent into the privilege boundary
- the supervised repair agent runs in the same tmux task context, but it still needs launch approval and cannot authorize or execute host mutation on its own
- Copilot CLI must already be authenticated; classic `ghp_` PATs are not accepted by Copilot CLI, so use `/login`, `gh auth login`, or a fine-grained token instead

Default endpoints:

- API: `http://127.0.0.1:3001`
- Web: `http://127.0.0.1:5173`

Default login comes from `.env`:

- username: `admin`
- password: `change-me-now`

## Execution plan integration notes

- runbook execution and agent launch now create a persisted execution plan before dispatch
- session detail exposes planner, safety, policy, and hook state for each plan
- approval dispatch revalidates the exact approved plan hash, session binding, and requester binding before bounded execution continues

## Upgrade note for existing SQLite state

- the API adds `cockpit_sessions.owner_id` automatically when an older database is opened
- legacy sessions with `owner_id = NULL` stay fail-closed and do not appear in `/api/sessions` until they are claimed again
- reclaim a legacy session by creating or resuming the same session name after login as the intended operator, or migrate `owner_id` explicitly outside the app before rollout

## Build and test

```bash
npm run build
npm run test
npm run coverage
npm run check
```

`npm run test` covers the shared tmux adapter plus the API and web workspaces. `npm run check` is the same build-and-test gate used by CI.
`npm run coverage` enforces workspace-specific coverage thresholds for the tmux adapter, API, and web UI and is also run in CI.

## Docker Compose development

The repository includes a small `docker-compose.yml` for app-level development:

```bash
cp .env.example .env
docker compose up
```

Notes:

- the compose setup is for repository development, not production deployment
- `tmux` behavior inside containers is intentionally local to the app runtime
- host-coupled privileged helpers are implemented only in the VPS host-runtime path, not in the dev compose stack

## VPS deployment handover

For a host-local bring-up path that a Copilot instance on the VPS can execute, use the production-oriented files below instead of the dev compose stack:

- `.env.vps.example`
- `docker-compose.vps.yml`
- `Dockerfile.api`
- `Dockerfile.web`
- `doc/setup/vps-handover.md`

Minimal flow:

```bash
cp .env.vps.example .env
sudo apt-get install -y tmux ttyd
curl -fsSLO https://nodejs.org/dist/v20.19.1/node-v20.19.1-linux-x64.tar.xz
sudo tar -C /opt -xf node-v20.19.1-linux-x64.tar.xz
sudo systemctl enable --now wireguard-ops-cockpit-api wireguard-ops-cockpit-ttyd
docker compose --env-file .env -f docker-compose.vps.yml up -d --build web
```

Important notes:

- set `COCKPIT_BIND_IP` to the WireGuard IP on the VPS before startup
- set `COCKPIT_TMUX_MODE=auto` for the host runtime
- install and authenticate GitHub Copilot CLI on the VPS if the planner runtime should be real instead of `demo-local`
- set `COCKPIT_TTYD_BASE_URL=/terminal` and a unique `COCKPIT_TERMINAL_SIGNING_SECRET`
- set `COCKPIT_COOKIE_SECURE=true` only when the stack is behind HTTPS
- the dashboard stays bound to the WireGuard IP while API and ttyd stay on `127.0.0.1`

## Terminal bridge

Set `COCKPIT_TTYD_BASE_URL=/terminal` and run the host-side `wireguard-ops-cockpit-ttyd` service to expose browser attachment URLs in the UI. The bridge validates a signed session token and attaches only to registered cockpit `tmux` sessions.

## Cloud build readiness

The repository includes both:

- `.github/workflows/copilot-setup-steps.yml` for GitHub Copilot cloud agent
- `.github/workflows/ci.yml` for repository build/test validation on push and pull request
- `.devcontainer/` for Codespaces and reproducible local container development
- `.github/agents/`, `.github/skills/`, and `.squad/` for agent and Squad bootstrap

Run `squad init` in a real development environment if you want Squad to generate and validate its expected repo-local files.
