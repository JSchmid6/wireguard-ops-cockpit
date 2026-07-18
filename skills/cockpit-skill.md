---
name: cockpit
description: Execute audited host operations via Cockpit API.
version: 5.1.0
author: user
platforms: [linux]
---

# Cockpit Admin API

Audited host operations, tmux-isolated, opencode-reviewed. All actions logged.

**Base:** `http://127.0.0.1:3001`

## Sync Hermes Adapters (Preferred)

Use these instead of the multi-step async workflow. They block until the result is ready.

### Research (Read-Only)

```
POST /api/hermes/research
{"prompt": "What's in /etc/apache2/sites-enabled/", "timeoutMs": 30000}
```

Blocks ~8-45s. Optional `timeoutMs` (default 45s, max 5min). Returns:

```json
{"answer": "## Required Permissions\n/usr/bin/ls\n```bash\nls ...", "sessionId": "uuid", "elapsedMs": 8123}
```

**No session management needed.** Optional `sessionId` to reuse one.

### Runbook (Read + Write + Execute, Auto-Safety-Checked)

```
POST /api/hermes/runbook
{"prompt": "Restart the Apache web server", "timeoutMs": 50000}
```

Blocks ~15-50s. Optional `timeoutMs` (default 50s, max 10min). Safety review blocks `rm -rf`, requires approval for config changes. Returns:

```json
{"message":"runbook executed","sessionId":"uuid","runbookId":"gen-...",
 "plannerOutput":"...","runnerOutput":"...","elapsedMs":45123}
```

### Timeout

`timeoutMs` = **total wall-clock time** the endpoint will wait (including 8s boot per phase).

| Endpoint | Default | Max | Behavior |
|---|---|---|---|
| Research | 45s | 5min | 8s boot + remaining for planner poll |
| Runbook | 50s | 10min | 8s boot + planner poll + 8s boot + runner poll, all within total |

**Hermes has a 60s process timeout.** Research default 45s, Runbook default 50s — both fit. Planner takes ~8-15s, runner ~10-25s. Typical total: Research ~10-15s, Runbook ~25-45s. If slow, set `timeoutMs` higher but stay under 60s.

### Quick Reference

```bash
COOKIE=$(curl -s -X POST http://127.0.0.1:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"$COCKPIT_PASSWORD\"}" \
  -c - | grep cockpit_session | awk '{print $NF}')

# Research with 30s timeout
curl -s -H "Cookie: cockpit_session=$COOKIE" \
  -X POST http://127.0.0.1:3001/api/hermes/research \
  -H "Content-Type: application/json" \
  -d '{"prompt":"What time is it?","timeoutMs":30000}'

# Runbook with 20s timeout (Hermes-safe)
curl -s -H "Cookie: cockpit_session=$COOKIE" \
  -X POST http://127.0.0.1:3001/api/hermes/runbook \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Restart Apache","timeoutMs":20000}'
```

## Async Endpoints (Legacy)

| Action | Endpoint | Method |
|---|---|---|
| Health | `/api/health` | GET |
| Pipeline Health | `/api/pipeline/health` | GET |
| Login | `/api/auth/login` | POST |
| **Sync Research** | **`/api/hermes/research`** | **POST** `{prompt,sessionId?}` |
| **Sync Runbook** | **`/api/hermes/runbook`** | **POST** `{prompt,sessionId?}` |
| List runbooks | `/api/runbooks` | GET |
| Order runbook (async) | `/api/runbooks` | POST `{prompt,sessionId}` |
| Execute runbook | `/api/runbooks/:id/execute` | POST `{sessionId}` |
| Delete dynamic | `/api/runbooks/:id` | DELETE |
| Research (async) | `/api/research` | POST `{prompt,sessionId}` |
| List sessions | `/api/sessions` | GET |
| Create session | `/api/sessions` | POST `{name,cwd}` |
| Session detail | `/api/sessions/:id` | GET |
| Session output | `/api/sessions/:id/output` | GET |
| Approvals | `/api/approvals` | GET |
| Decide approval | `/api/approvals/:id/decision` | POST |
| Audit log | `/api/audits` | GET |
| Agents | `/api/agents` | GET |
| Launch agent | `/api/agents/:id/launch` | POST `{sessionId,prompt}` |
| Schedules | `/api/schedules` | GET/POST |

## Helper Scripts

```bash
/opt/data/scripts/cockpit-list          # List all runbooks
/opt/data/scripts/cockpit-runbook <id>  # Execute (handles login+session)
```

## When to Use Which

| Use Case | Endpoint | Why |
|---|---|---|
| Explore files, check config, diagnose | `POST /api/hermes/research` | One call, blocks, returns answer |
| Install package, restart service, edit file | `POST /api/hermes/runbook` | One call, auto-executes, returns output |
| Complex multi-step runbook review | Legacy async flow | Manual step-by-step |

**Rule:** Always use the sync endpoints. Don't manually manage sessions, polling, and dispatch steps.

## Security

- **Scoped temp sudo**: Only binaries listed in `## Required Permissions`. Self-destructs after execution.
- **Safety review**: opencode checks every runbook before dispatch
- **No permanent sudo**: wgops has no sudo between runbook executions
- **Filtered output**: `filterSensitiveContent()` strips API keys, tokens, passwords from output

## Pitfalls

- **SESSION CRITICAL: Always use sync endpoints (/api/hermes/research, /api/hermes/runbook).** Do NOT fall back to the legacy async flow (manual session create + polling + dispatch). The sync endpoints block until the result is ready and handle all session/planner/runner lifecycle internally. The async flow exists only for interactive debugging and is extremely slow (60-90s per step).
- **Research only plans, does not execute.** POST /api/research generates a plan in agent-planner-agent output but never runs it. To execute, use POST /api/hermes/runbook.
- **Runbook output appears as runbook-id key.** After dispatching, the result is NOT in main or agent-planner-agent. It is a third key named after the runbook ID (e.g. gen-show-current-time-and-date). The sync endpoint handles this automatically.
- **Planner generation takes 60-90 seconds.** Do NOT poll before 60s. Runner takes 20-30s after dispatch.
- **Cookie expires after 12h** — re-login on 401.
- **Cookie bug**: curl -b /tmp/ck does NOT send HttpOnly_-prefixed cookies. Always extract the value with grep cockpit_session | awk '{print $NF}' and pass as explicit -H 'Cookie: cockpit_session=$VAL'.
- **Scoped temporary sudo**: The runner gets sudo only for the specific binaries listed in the runbook. wgops has no persistent sudo.
- **Sync endpoint timeout**: If no answer within 120s (rare), the endpoint returns partial: true with a note to poll async.
