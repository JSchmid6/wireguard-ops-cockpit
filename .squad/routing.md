# Work Routing

How to decide who handles what.

## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|----------|
| Architecture & scope | Architect | system design, trust boundaries, delivery slicing, major refactors |
| API, sessions & runbooks | Builder | Fastify handlers, SQLite state, agent launch flows, runbook behavior |
| Visual UI design | Canvas | layout systems, visual hierarchy, component styling, responsive polish |
| Discovery & deep interview | Compass | clarify intent, surface constraints, uncover hidden requirements, turn requests into acceptance criteria |
| Product strategy & operator value | Compass | roadmap slicing, operator pain points, outcome framing, acceptance priorities |
| UX flows & operator ergonomics | Guide | task journeys, information architecture, cockpit usability, approval flow friction |
| Security & auth | Shield | auth/session integrity, approvals, secrets, privilege boundaries |
| Testing & CI | Verifier | regression tests, coverage gaps, flaky tests, CI gates |
| Deployment & Compose | Harbor | Docker Compose, GitHub Actions, release checks, packaging |
| Docs & decisions | Scribe | architecture notes, migration docs, decision merges |
| Code review | Verifier | Review PRs, check regressions, suggest missing tests |
| Scope & priorities | Compass | What to build next, operator-facing trade-offs, release sequencing, acceptance criteria |
| Session logging | Scribe | Automatic — never needs routing |

## Module Ownership

| Module Path | Primary | Secondary |
|-------------|---------|-----------|
| apps/api/** | Builder | Shield |
| apps/web/** | Builder | Canvas |
| packages/tmux-adapter/** | Builder | Shield |
| packages/domain/** | Builder | Architect |
| .github/workflows/** | Harbor | Shield |
| .github/agents/** | Architect | Shield |
| .github/skills/** | Architect | Shield |
| .squad/** | Architect | Scribe |
| doc/** | Architect | Compass |

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
8. **No implementation before clarification.** If the request leaves goals, constraints, acceptance criteria, or trust-boundary impact unclear, stop and run a short discovery pass before editing code.
9. **Use the deep interview for ambiguous product work.** Route that discovery to Compass first, then bring in Architect, Guide, Shield, or Builder only after the request has been sharpened into a falsifiable change.

## Deep Interview

Use the deep interview when a request sounds directionally right but is still underspecified.

Trigger it when any of these are true:

- the user asks for a broad improvement without naming the exact behavior change
- multiple interpretations could lead to different UI, data model, or trust-boundary outcomes
- success criteria are implied but not explicit
- the request mixes product intent, UX, and implementation details in one sentence

Expected output of the deep interview:

1. The actual operator problem being solved
2. The constraints and non-goals
3. The acceptance criteria for the next slice
4. The smallest coherent implementation step

Reference playbook: `.squad/deep-interview.md`
