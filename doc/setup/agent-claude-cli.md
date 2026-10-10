# Agent broker: Claude CLI for the work, another model family for the review

The isolated agent broker (`apps/agent-broker`, service
`wireguard-ops-cockpit-agent`) chooses the engine per role group:

- **Work roles** (planner, research, runner) run through the Claude CLI on the
  subscription (`COCKPIT_AGENT_ENGINE_WORK=claude`).
- **Review roles** (safety, verifier) are deliberately a different model
  family than the Claude that does the work and that drives James: today
  DeepSeek through opencode (`COCKPIT_AGENT_ENGINE_REVIEW=opencode`), later
  Codex once it is switched on. **Claude never reviews Claude's work**, not
  even as a fallback: `COCKPIT_AGENT_ENGINE_REVIEW=claude` is refused with
  "nicht verfügbar". Reason (operator decision 10.10.2026): about 30 Cockpit
  jobs in 30 days make the DeepSeek review cost small; the reviewer's
  independence matters more.

Both engines run under the same supervisor (preflight, own process group,
`events.jsonl`, verdict `lauf.json`, no silent fallback).

## Engines and the switches

| Engine | Allowed for | Label in the verdict |
|---|---|---|
| `claude`: Claude CLI, `claude -p --output-format stream-json --verbose` | work roles only | none (model and CLI version are recorded) |
| `opencode`: opencode with DeepSeek (`COCKPIT_SAFETY_OPENCODE_MODEL`, `DEEPSEEK_API_KEY`) | review roles (default); work roles only by switch | `DeepSeek/opencode <model> (Prüfer, andere Modellfamilie als Claude)` |
| `codex`: Codex CLI, only with `COCKPIT_CODEX_ENABLED=1`, otherwise "nicht verfügbar" | review roles once switched on | `Codex-CLI (zweiter Antrieb, nicht Claude)` |

The DeepSeek reviewer keeps exactly its previous rights (opencode `plan`
agent with `--auto --pure`, `deploy/config/opencode-agent.jsonc`); only the
supervision is new. Its preflight checks the binary, its version and that
`DEEPSEEK_API_KEY` is set for a `deepseek/…` model. An empty balance, a
rejected key or "payment required" in the run (also with exit 0 and no
answer) ends as `nicht_verfuegbar`, never as a review.

There is **no silent fallback**. If the chosen engine is not available
(binary missing, token missing or too open, login invalid, unknown version, a
model name that is not an alias), the run ends with the verdict
`nicht_verfuegbar` and its reason. The broker answers `ok:false`. The API
treats that as "no review":

- plan safety review: `not_run`/`blocked`, which means `blocked_policy` or
  approval (`apps/api/src/app.ts`, `resolveRunbookPlanState`/`evaluatePlanPolicy`);
- pre-install review (self.update, dienste.update): `reviewerError`, so the job
  stops for the operator (`apps/api/src/update-review.ts`);
- doorkeeper of the host door: "review incomplete", so nothing runs
  (`apps/api/src/host-run.ts`).

The reason appears in the job ("Wartet auf dich"), for example
`agent engine opencode not available: DeepSeek nicht verfügbar (Guthaben/Schlüssel): …; no review, nothing is approved` or
`agent engine claude not available: Token-Datei fehlt (…); no review, nothing is approved`.

The engine that wrote a review is recorded with the verdict. The plan review
records it as `details.model`, and the label (for example
`DeepSeek/opencode deepseek/deepseek-v4-pro (Prüfer, andere Modellfamilie als Claude)`)
is put in front of the summary. The pre-install review and the
doorkeeper add it as the evidence line `reviewer: …`.

## Models

Claude models are set only as aliases, in one place (the unit): the work
roles (planner, research, runner) use `COCKPIT_CLAUDE_WORK_MODEL=sonnet`.
`COCKPIT_CLAUDE_REVIEW_MODEL=opus` exists only for the rights tests and the
measurements below; the broker never starts Claude for a review role. The
DeepSeek reviewer model stays `COCKPIT_SAFETY_OPENCODE_MODEL` in `agent.env`. Allowed
values are `opus`, `sonnet`, `haiku` and `fable`. A full model name is refused
with "nicht verfügbar".

## Rights per role (hard, on the command line)

The only lock is `--tools` (the tools that exist in the session) plus
`--disallowedTools`. `--allowedTools` only removes the confirmation prompt and
**locks nothing**. Flags as documented by `claude --help` of the installed
version 2.1.283:

- `--tools`: "Use "" to disable all tools … or specify tool names";
- `--disallowedTools`: "Comma or space-separated list of tool names to deny";
- `--setting-sources`: "Comma-separated list of setting sources to load (user,
  project, local)". The broker passes `""`, so it loads none of them;
- `--strict-mcp-config`: "Only use MCP servers from --mcp-config, ignoring all
  other MCP configurations". The broker passes no `--mcp-config`, so there are
  no MCP servers;
- `--safe-mode`: CLAUDE.md, skills, plugins, hooks and MCP servers are off;
- `--permission-mode dontAsk`: anything not pre-allowed is denied, nothing
  waits for a prompt;
- `--no-session-persistence`, `--disable-slash-commands`.

| Role | Before (opencode) | Now (Claude CLI) |
|---|---|---|
| safety | agent `plan` with `--auto`: edit and bash are `ask` in `plan`, and `--auto` approves every `ask` | `--tools ""` (no tools) |
| verifier | as safety | `--tools ""` (no tools) |
| planner | as safety | `--tools Read,Grep,Glob` |
| research | as safety | `--tools Read,Grep,Glob` |
| runner | agent `build` with `--auto`: all tools (bash, edit, write, read, grep, glob, apply_patch, lsp, skill, todowrite, webfetch, websearch, question, task), all `allow`, `external_directory` `allow` | `--tools Bash,Read,Edit,Write,Grep,Glob` (no web, no subagents, no MCP) |

Additional rules apply to every role. `--disallowedTools` always contains
`Agent Task WebFetch WebSearch NotebookEdit Skill …`. Roles without Bash also
deny `Bash Edit Write MultiEdit`. Every role with tools gets
`Read/Grep/Glob(//<path>/**)` denials for the token directory, the Claude
config directory, the run directory, `/etc/wireguard-ops-cockpit` and `/proc`.
`/proc` is denied because the CLI's own environ holds the token. In a real run
on 2026-10-10, reading such a path failed with "File is in a directory that is
denied by your permission settings". A Grep or Glob on a parent of a denied
path is refused as a whole ("Permission to read … has been denied"), so for
example a recursive search of `/etc` is not possible. A planner reads exact
files instead.

The broker also checks the `system/init` event of every run. If the tools
loaded there differ from the role's set, or if any MCP server is loaded, the
run is killed immediately (`fehler`, "Werkzeugliste weicht von der Rolle ab").

The outer boundary stays the same: the systemd unit (`ProtectSystem=strict`,
`ProtectHome`, `NoNewPrivileges`, write access only below
`/var/lib/wireguard-ops-agent`). Mutations go only through the executor broker.

Sources for the "before" column: `apps/agent-broker/src/index.mjs` before this
change (`opencodeAgent = request.role === "runner" ? "build" : "plan"`, args
`run --auto --pure --agent …`), `deploy/config/opencode-agent.jsonc`
(`external_directory: allow`), and the opencode docs: agents ("Build is the
default primary agent with all tools enabled"; Plan: "file edits … bash … set
to ask"), permissions (most permissions default to `allow`), tools (the list
of built-in tools) and CLI (`--auto`: "Auto-approve permissions that are not
explicitly denied"). The fact that `--auto` also approves the `ask` steps of
`plan` is derived from the docs and was not run against the live opencode.

## Context and workspace

As before, each run gets a private workspace below
`/var/lib/wireguard-ops-agent/sessions`, and the role context is AGENTS.md +
architecture + role file. The Claude CLI does not read AGENTS.md in the
workspace on its own (tested: a code word in AGENTS.md was unknown). The
broker therefore passes the same text with `--append-system-prompt`. The
prompt goes through stdin, never through argv.

## Supervised run (CLI operation after LifeOS, sections 1, 6, 8)

Each run gets a directory `$COCKPIT_AGENT_RUNS_ROOT/<requestId>-<role>/` (0700):

- **Preflight**: model alias, token file (regular file, not readable by group
  or others, not empty), `claude --version` (version readable) and
  `claude auth status` (`loggedIn: true`). If any check fails, the run ends as
  `nicht_verfuegbar` and no model is called.
- **Own process group**: the engine is started detached. Every abort goes to
  the whole group: SIGTERM, then SIGKILL after 5 s. After a normal end, any
  leftover member of the group is ended as well.
- **`engine.pid`**: holds the broker PID, the engine PID, engine, model, role,
  start time and CLI version.
- **`events.jsonl`**: every stdout line of the engine, written to disk at once.
- **`lauf.json`** (the verdict): `status` (`erfolg | fehler | zeit | nicht_verfuegbar`),
  `grund`, `exitCode`, `signal`, `start`, `ende`, `dauerMs`, `antrieb`,
  `modell`, `etikett`, `cliVersion`, `cliVersionNeu`, `werkzeuge`
  (the tools actually loaded) and `ereignisse`.
- **`abbrueche.jsonl`** in the run root: every verdict other than `erfolg`,
  with its last three events.
- **CLI version**: every change of version is logged in `cli-versionen.jsonl`,
  and the first run on a new version carries `cliVersionNeu: true`. After a
  version change, run the review cases again (see Validation).
- **Orphaned runs**: when the broker starts, it looks for a run directory with
  `engine.pid` but no `lauf.json`. Its group is ended only if
  `/proc/<pid>/cmdline` still names `claude`, `codex` or `opencode` **and** the
  run marker `COCKPIT_AGENT_RUN_ID=<run>` is in `/proc/<pid>/environ` (this
  guards against PID reuse). Each such run gets a verdict either way.
  Finished runs are removed after 14 days.

The engine's environment is only `HOME`, `PATH`, `CLAUDE_CONFIG_DIR`,
`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
`DISABLE_AUTOUPDATER=1` and the run marker. The broker itself never writes
the token to events, verdicts or logs. If the runner reads it anyway (token
file or `/proc/<pid>/environ`, see the honest limit below), it is in that
run's `events.jsonl` in plain text. On the API path the runner handoff, the
verifier prompt and the stored job result go through `filterSensitiveContent`,
which uses the token patterns of `redactSecrets` (`sk-ant-oat01-…` included):
there it is redacted.

## Time limits

The budget per role includes the preflight. Runner: 30 min. Planner, safety
and verifier: 15 min. Research: 120 s. The API socket waits 15 s longer
(`apps/api/src/agent-broker.ts`): two 5 s kill graces plus a margin.

Measured with Claude on 2026-10-10 (safety role, `opus`, CLI 2.1.283, the 21
review cases twice, sequential, wall time including the preflight): minimum
7.2 s, median 12.7 s, maximum 28.3 s. A real self-update review sends up to
100,000 characters, about ten times the case size, so a few minutes stay
realistic. The 15-minute budget keeps a margin of more than 30 times the
slowest measured case. The budgets stay as they are because they were sized
for the slowest real work: a runner update with its backup, and a planner that
explores the host. The review cases do not measure those. The kill grace is
5 s.

## Validation

`test/review-cases-eval.mjs` sends the recorded review cases
(`apps/api/test/fixtures/dienste-review-cases.json`,
`update-review-cases.json`) to the safety role through the real broker path,
scores verdict, guarantee, quotes and policy, and writes every answer and a
`summary.json`. Run it after a change of the reviewer engine or its CLI
version. It uses the configured review engine (`COCKPIT_AGENT_ENGINE_REVIEW`,
default DeepSeek: API costs, one call per case). The Claude measurements in
this document come from an earlier state of this branch in which Claude was
the reviewer; they stay as a comparison only.

## Deployment: manual steps for the operator (once, BEFORE the rollout)

The broker never uses the login of root or James. It gets its own long-lived
token.

1. Install the Claude CLI for all users at `/usr/local/bin/claude`
   (owned by root, not writable by the agent). Without it, every run is
   "nicht verfügbar".
2. Create the token as the broker's identity, in a throwaway config
   directory (interactive, browser sign-in with the subscription):

   ```sh
   D=$(runuser -u cockpit-agent -- mktemp -d)
   runuser -u cockpit-agent -- env CLAUDE_CONFIG_DIR="$D" /usr/local/bin/claude setup-token
   ```

3. Store the token it prints, without echoing it into the shell history:

   ```sh
   install -d -m 0755 /etc/wireguard-ops-agent
   ( umask 077; IFS= read -rs T; printf %s "$T" > /etc/wireguard-ops-agent/claude-oauth-token; unset T )   # paste, then Enter
   chown cockpit-agent /etc/wireguard-ops-agent/claude-oauth-token
   chmod 0400 /etc/wireguard-ops-agent/claude-oauth-token
   rm -rf "$D"
   ```

4. Roll out through the Cockpit's own `self.update` path (with the update
   review), never by hand. The unit sets every path and both engine switches.
   `/etc/wireguard-ops-cockpit/agent.env` keeps `DEEPSEEK_API_KEY` and
   `COCKPIT_SAFETY_OPENCODE_MODEL` for the reviewer, as before. The previous
   single switch `COCKPIT_AGENT_ENGINE` is no longer read.
5. Check: start a job; below `/var/lib/wireguard-ops-agent/runs/` the
   planner's `lauf.json` must show `status: erfolg`, `antrieb: claude` and the
   CLI version, the safety review's `antrieb: opencode` with its label.

## Security assumptions and limits

- **Token storage**: one file, owner `cockpit-agent`, mode 0400, outside the
  repository. Every run reads it fresh, so rotating it needs no restart. It
  is passed to the CLI only through the environment, never as an argument.
  The tool roles cannot read it (deny rules). The runner's Bash does not see
  it in its environment (observed: `env | grep -c CLAUDE_CODE_OAUTH_TOKEN` gives
  `0`).
- **Honest limit**: the runner runs as the same OS user. With Bash it could
  read the token file or `/proc/<claude-pid>/environ`, and the output would
  then be in `events.jsonl` and in its answer (the API redacts it from the
  handoff, the verifier prompt and the job result). Deny rules cannot lock Bash.
  This is the same class of risk as the old `DEEPSEEK_API_KEY` in the opencode
  environment. The safeguards are the role prompt and the reviewed plan, and
  the runner never receives a free task. In a test, the runner refused an
  `env` probe for the token variable on its own.
- **Label on the review paths**: the safety review (plan review, pre-install
  review, doorkeeper) shows the DeepSeek label in the job. The verifier's
  answer goes to the API as plain text; its engine and label are in
  `lauf.json` only (open point).
- **Planner and research** have no shell any more. Live probes such as
  `systemctl status` are no longer possible there. They read files only.
- **Reviewer rights** are unchanged from before this branch: safety and
  verifier on opencode `plan` with `--auto` (shell and edit are derived from
  the opencode docs, not measured live). Tightening them is a separate step;
  Claude's `--tools ""` for these roles exists but is never used, because
  Claude does not review.
- **Without DeepSeek** (empty balance, key missing, opencode missing) every
  review is `nicht_verfuegbar`: nothing is approved, the job waits for the
  operator with the reason. There is no switch to Claude.
- **Codex** has no mode without tools. `read-only` is its narrowest sandbox.
  It stays off until it is switched on.
