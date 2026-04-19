# wireguard-ops-cockpit

WireGuard-only operations cockpit for VPS administration with persistent `tmux` sessions, browser access, bounded runbooks, and agent orchestration for tools such as GitHub Copilot and custom agents.

The repository now includes a first working implementation slice:

- a small React web UI
- a Node.js/Fastify control API
- SQLite-backed state for users, sessions, jobs, approvals, and audits
- explicit `tmux` session management
- safe placeholder runbooks
- a demo local agent launch contract

## Current implementation boundaries

This first pass keeps the trust boundaries explicit:

- the web UI is never the privilege boundary
- application login still matters even on WireGuard-only networks
- `tmux` sessions are first-class
- browser terminal attachment is represented through an external ttyd-compatible URL, not hidden shell access
- privileged host behavior remains behind future local integration points

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

## Quick start

1. Copy `.env.example` to `.env`
2. Change `COCKPIT_ADMIN_PASSWORD`
3. Install dependencies
4. Start the API and web UI in separate terminals

```bash
cp .env.example .env
npm install
npm run dev:api
npm run dev:web
```

Default endpoints:

- API: `http://127.0.0.1:3001`
- Web: `http://127.0.0.1:5173`

Default login comes from `.env`:

- username: `admin`
- password: `change-me-now`

## Build and test

```bash
npm run build
npm run test
```

## Docker Compose development

The repository includes a small `docker-compose.yml` for app-level development:

```bash
cp .env.example .env
docker compose up
```

Notes:

- the compose setup is for repository development, not production deployment
- `tmux` behavior inside containers is intentionally local to the app runtime
- host-coupled privileged helpers are still out of scope

## Terminal bridge

Set `COCKPIT_TTYD_BASE_URL` to expose a terminal attachment URL in the UI. The app does not spawn a web terminal bridge itself in this first pass; it only models the integration seam explicitly.

## Cloud build readiness

The repository includes both:

- `.github/workflows/copilot-setup-steps.yml` for GitHub Copilot cloud agent
- `.devcontainer/` for Codespaces and reproducible local container development
- `.github/agents/`, `.github/skills/`, and `.squad/` for agent and Squad bootstrap

Run `squad init` in a real development environment if you want Squad to generate and validate its expected repo-local files.
