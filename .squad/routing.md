# Work Routing

How to decide who handles what.

## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|----------|
| Architecture & scope | Architect | system design, trust boundaries, delivery slicing, major refactors |
| API, sessions & runbooks | Builder | Fastify handlers, SQLite state, agent launch flows, runbook behavior |
| Security & auth | Shield | auth/session integrity, approvals, secrets, privilege boundaries |
| Testing & CI | Verifier | regression tests, coverage gaps, flaky tests, CI gates |
| Deployment & Compose | Harbor | Docker Compose, GitHub Actions, release checks, packaging |
| Docs & decisions | Scribe | architecture notes, migration docs, decision merges |
| Code review | Verifier | Review PRs, check regressions, suggest missing tests |
| Scope & priorities | Architect | What to build next, trade-offs, acceptance criteria |
| Session logging | Scribe | Automatic — never needs routing |

## Module Ownership

| Module Path | Primary | Secondary |
|-------------|---------|-----------|
| apps/api/** | Builder | Shield |
| apps/web/** | Builder | Verifier |
| packages/tmux-adapter/** | Builder | Shield |
| packages/domain/** | Builder | Architect |
| .github/workflows/** | Harbor | Shield |
| .github/agents/** | Architect | Shield |
| .github/skills/** | Architect | Shield |
| .squad/** | Architect | Scribe |
| doc/** | Architect | Scribe |

## Issue Routing

| Label | Action | Who |
|-------|--------|-----|
| `squad` | Triage: analyze issue, assign `squad:{member}` label | Architect |
| `squad:{name}` | Pick up issue and complete the work | Named member |

### How Issue Assignment Works

1. When a GitHub issue gets the `squad` label, the **Architect** triages it — analyzing content, assigning the right `squad:{member}` label, and commenting with triage notes.
2. When a `squad:{member}` label is applied, that member picks up the issue in their next session.
3. Members can reassign by removing their label and adding another member's label.
4. The `squad` label is the "inbox" — untriaged issues waiting for Architect review.

## Rules

1. **Eager by default** — spawn all agents who could usefully start work, including anticipatory downstream work.
2. **Scribe always runs** after substantial work, always as `mode: "background"`. Never blocks.
3. **Quick facts → coordinator answers directly.** Don't spawn an agent for "what port does the server run on?"
4. **When two agents could handle it**, pick the one whose domain is the primary concern.
5. **"Team, ..." → fan-out.** Spawn all relevant agents in parallel as `mode: "background"`.
6. **Anticipate downstream work.** If a feature is being built, spawn the tester to write test cases from requirements simultaneously.
7. **Issue-labeled work** — when a `squad:{member}` label is applied to an issue, route to that member. The Architect handles all `squad` (base label) triage.
