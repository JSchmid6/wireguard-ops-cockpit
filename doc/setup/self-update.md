# Self-Update — Machine Rollout of the Cockpit Stand

This document records the typed self-update module: how a merged cockpit stand
reaches the host as a reviewed job instead of a manual root session, and the
exact lines the deploy script must carry so the next manual rollout installs it.

## Before you change this door

Changing `deploy/helpers/cockpit-host-run`,
`cockpit-borg-retention-rules.*`, `cockpit-state-steps.*`, `cockpit-self-update-*`,
`cockpit-dienste-update-action`, `apps/api/src/update-review.ts`,
`update-review-prompt.ts`, `host-run.ts`, `hermes-security.ts` or this file:

1. Read this file completely, in particular
   [The guarantees and the one door](#the-guarantees-and-the-one-door) (G1–G10), and the approval
   matrix in `doc/setup/host-run.md` („Freigabe-Matrix“). Principle (Jochen, 30.09. and
   11.10.2026): the operator is asked only when a reviewer raises an evidenced finding or the
   risk bolt / a hard plan blocker hits; an incomplete review never runs and never becomes an
   approval offer.
2. Go through G1–G10 and decide which ones the change touches.
3. Put the line `G-Garantien berührt: <G… or keine> — <why each still holds>` into the PR
   description. CI (`.github/workflows/pr-guarantees.yml`) fails without it.

## Scope

The module rolls out one commit of the allowlisted repository
(`JSchmid6/wireguard-ops-cockpit`) that is already merged into `origin/main`.
It runs the same reviewed `homeserver-cockpit-deploy.sh` a human would run, with
`REPO_COMMIT=<sha>` and `COCKPIT_RESTART_MODE=defer`. It does not merge, does
not fetch unreviewed code, and does not touch anything outside the deploy
script's own contract. Before anything is installed, the running Cockpit
reviews the new code (see [Review before install](#review-before-install)).

## Files

| Path (host) | Source | Purpose |
| --- | --- | --- |
| `/usr/local/sbin/cockpit-self-update-action` | `deploy/helpers/cockpit-self-update-action` | The only sudo-exposed entry point. Pinned usage: `status`, `diff <sha>`, or `<sha> <diff-sha256>` (full lowercase 40-hex sha, 64-hex hash). |
| `/usr/local/lib/wireguard-ops-cockpit/cockpit-self-update-run` | `deploy/helpers/cockpit-self-update-run` | The runner. Deliberately **not** a sudo target; started only by the one-shot unit and by the transient review-diff unit. |
| `/usr/local/lib/wireguard-ops-cockpit/cockpit-self-update-snapshot` | `deploy/helpers/cockpit-self-update-snapshot` | Lab0 only: the safety net (copy of the Cockpit footprint before an update, restore on failure). Not a sudo target; called only by the runner. See [Lab0: snapshot and rollback](#lab0-snapshot-and-rollback). |
| `/usr/local/lib/wireguard-ops-cockpit/homeserver-cockpit-deploy.sh` | `deploy/lab0/homeserver-cockpit-deploy.sh` | Lab0's reviewed deploy script; installs itself here on every run. |
| `/var/lib/wireguard-ops-cockpit-self-update-snapshots/` | runtime (Lab0) | The snapshots, root 0700, newest two kept. |
| `/etc/systemd/system/wireguard-ops-cockpit-self-update@.service` | `deploy/systemd/wireguard-ops-cockpit-self-update@.service` | One-shot deploy unit, instance = `<sha>-<diff-sha256>`. |
| `/etc/sudoers.d/cockpit-executor` | `deploy/sudoers/cockpit-executor` | Gains the `cockpit-self-update-action *` line. |
| `/var/lib/wireguard-ops-cockpit/self-update/state.json` | runtime | State: `deployed_commit`, `previous_commit`, `web_url`, activation status. Root-owned, 0750. |
| `/var/log/wireguard-ops-cockpit-self-update/` | runtime | One log per run plus `history.jsonl`. Root-owned, 0750. |
| `<api data dir>/proposals/<jobId>-update-review.md` | runtime (API) | The exact prompts the isolated reviewer received for a job's self-update, one section per review pass. 0600. |

## Deploy-script integration

The next manual rollout installs the module like every other helper. Add these
lines next to the existing helper installs (the variable `$COCKPIT_DIR` is the
script's extracted repository root, as used by the `cockpit-disk-action`
lines):

```bash
install -d -m 0700 -o root -g root /var/lib/wireguard-ops-cockpit/self-update
install -d -m 0750 -o root -g root /var/log/wireguard-ops-cockpit-self-update
install -m 755 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-self-update-action" \
  /usr/local/sbin/cockpit-self-update-action
install -m 755 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-self-update-run" \
  /usr/local/lib/wireguard-ops-cockpit/cockpit-self-update-run
install -m 644 "$COCKPIT_DIR/deploy/systemd/wireguard-ops-cockpit-self-update@.service" \
  /etc/systemd/system/wireguard-ops-cockpit-self-update@.service
```

The updated `deploy/sudoers/cockpit-executor` is already installed by the
existing `install -m 440` line; the existing `systemctl daemon-reload` covers
the new unit. No further deploy-script change is needed.

Optionally, `/etc/wireguard-ops-cockpit/self-update.env` (root-owned,
`KEY=VALUE`, environment wins) overrides runtime defaults such as
`COCKPIT_SELF_UPDATE_ACTIVATION_DELAY` (default 600s) — the file is read by the
runner only.

## Job flow

0. The plan line stays `/usr/local/sbin/cockpit-self-update-action <sha>`.
   Before the job may run it, the API reviews the code (next section) and
   keeps the reviewed diff hash.
1. The typed executor calls `/usr/local/sbin/cockpit-self-update-action <sha>
   <diff-sha256>` (as `sudo -n`, pinned by sudoers). The helper validates the
   form, refuses while another update holds
   `/var/lib/wireguard-ops-cockpit/self-update/action.lock`, and starts
   `wireguard-ops-cockpit-self-update@<sha>-<diff-sha256>.service`; it waits
   for that unit and prints the structured result JSON.
2. The unit runs `cockpit-self-update-run deploy <sha>-<diff-sha256>` (as
   root). The runner verifies: repo directory exists, `origin` remote equals
   the allowlisted URL, `<sha>` is merged into `refs/remotes/origin/main`, and
   the diff from the deployed base to `<sha>` still hashes to `<diff-sha256>`.
   Only then does it run the deploy script with `REPO_COMMIT=<sha>`,
   `COCKPIT_RESTART_MODE=defer`.
3. The deploy script prepares files and writes the new `state.json` (including
   `web_url`). The runner verifies the host before activation: the four cockpit
   services are active, the socket files exist, `api_health` answers, and —
   when the WireGuard address is present — `web_url` answers. Where the deploy
   script records the built web image for this commit (`state.json`
   `web_image`: commit, name, id, container; the VPS), the image tag must still
   be that id and the web container must run, else 68. Without such a record
   (Lab0; and once on the VPS: the first update after this check came is still
   deployed by the previously installed script) the check reports
   `not-recorded`. It then schedules
   the activation as a one-shot timer (`systemd-run --on-active=600`) and
   writes `activation.status=scheduled`.
4. The activation first waits until the API reports no Hermes job a restart
   would interrupt (`GET /api/health` → `jobs.active`, by phase in
   `jobs.phases`; a job following a host run is not counted, the restarted API
   follows it). It logs what it waits for, notes `waiting-for-jobs` in the
   history, and activates at the latest after
   `COCKPIT_SELF_UPDATE_ACTIVATION_JOBS_WAIT` (default 1800 s) anyway; the
   outcome (`idle`, `timeout` with the phases, or `unknown` for an API without
   the count) is `activation.jobs_wait` in the result. A single lost health
   answer does not end the wait; after `COCKPIT_SELF_UPDATE_ACTIVATION_JOBS_SILENT`
   (default 4) in a row it activates without waiting. This wait is outside the
   run lock: a job under review needs that lock for its diff. Between the last
   `idle` answer and the restart lie a few seconds (lock, checks) in which a job
   can still start, e.g. an operator approval. A job a restart interrupts is
   taken up by the API at start-up (see
   [Jobs across a restart](#jobs-across-a-restart)).
   Then the activation waits for the run lock (a running deployment or review diff;
   up to `COCKPIT_SELF_UPDATE_ACTIVATION_LOCK_WAIT`, default 1900 s, then exit
   66 and `failed-busy` in the history — never a silent success). It skips when
   `state.json` names a different deployed commit than its own (the stand moved
   on; the older activation is superseded). Before restarting anything it checks
   that the web image tag is still the built `web_image.id` (a rebuild or
   retag since the deploy fails the activation with 68, nothing restarted).
   Then it restarts the services, verifies them again — including that the web
   container now runs exactly `web_image.id` — and writes
   `activation.status=ok` (or `failed` with the reason). Each check retries
   (services and broker sockets need a few seconds after the restart); only a
   check that is still failing on its last try fails the activation.

   `cockpit-self-update-action status` shows the reason of the last failed
   attempt in `last_attempt.error` and, after a rollback, its outcome in
   `last_attempt.rollback` (`result`, `error`) — text only, cut at 500
   characters — so the reason is readable through the Cockpit without the
   root-only log.

   Note: until the timer fires, `systemctl show -p Result` of the scheduled
   `…-activate-…` service already says `success` (the default of a unit that
   never ran). Whether it ran shows `ActiveEnterTimestamp`/`ExecMainStartTimestamp`,
   the `activation` field of `state.json` and `history.jsonl`.

### Jobs across a restart

16.10.2026: an activation restarted the API while job `946bd6ae` was planning;
the record stayed `running` with nothing behind it. At start-up the API now
takes every running `hermes-change`/`hermes-research` job up again
(`recoverInterruptedJob` in `apps/api/src/app.ts`) and notes it on the job
(`output.restarts`: time, phase, `replanned` or `abandoned`, reason; audits
`hermes.job.replanned` / `hermes.job.abandoned`):

- a started host run is followed as before (`resumeHostRun`);
- a job in `queued`, `planning` or `reviewing` — nothing has run on the host —
  is planned again from the request recorded on the job (`output.request`:
  intent, untrusted evidence, allowed capabilities, plan-only flag). The new
  plan gets a new review, a new policy decision and a new envelope; the
  interrupted attempt's plan is dropped. At most two times per job, and only
  while its last progress is younger than one hour (an old intent never runs
  unannounced);
- anything else (execution outside the host door, a job without a recorded
  request, the limits above) ends as `failed_execution` with the reason. It
  keeps what it reached and does not count towards the change circuit breaker.

Rollback is plain forward motion: run the job again with the `previous_commit`
sha from `state.json` (it is an ancestor of `origin/main`, so it deploys like
any other stand — and is reviewed like any other stand). On Lab0 a failing
update additionally rolls back by itself (next section).

## Lab0: snapshot and rollback

Stand 13.10.2026 (Kanban t_d25614f4). The VPS deploy script restores its own
targets on failure, and the general door takes a hoster snapshot. Lab0 has
neither a hoster snapshot nor a borg backup of itself — Lab0 *is* the backup
box. Its safety net for a self-update is therefore a local copy of exactly what
an update changes: `deploy/helpers/cockpit-self-update-snapshot`.

**Footprint** (what `deploy/lab0/homeserver-cockpit-deploy.sh` writes): the
checkout `/opt/wireguard-ops-cockpit` with build output and `node_modules`,
`/usr/local/lib/wireguard-ops-cockpit` (helpers, runner, the deploy script
itself), the web root, the API drop-in directory, `/usr/local/sbin/cockpit-*`,
`/etc/systemd/system/wireguard-ops-cockpit-*.service`, the retention
service/timer, `/etc/sudoers.d/cockpit-executor`, the nginx site and its wg0
drop-in, the agent's opencode config and `self-update/state.json`. Not copied:
`/etc/wireguard-ops-cockpit` (the deploy script only creates missing secrets,
never rewrites them), packages, Node/opencode under `/opt/node-*`, the borg
repository, borgmatic and everything else on the box.

**Flow** (runner, only where the helper is installed; the VPS has none and is
unchanged):

1. After the review hash matched and before the deploy script runs:
   `create su-<sha12>-<UTC time>`. The copy goes to
   `/var/lib/wireguard-ops-cockpit-self-update-snapshots/<name>/` (root 0700,
   deliberately not below `/var/lib/wireguard-ops-cockpit`, where `wgops`
   writes), the manifest is written last (`complete: true`). Rotation keeps
   the newest two and touches only names of its own form; too little free
   space (size plus 512 MB) refuses. **No snapshot, no deploy:** a failing
   create ends the job with 67, phase `snapshot`, nothing changed.
   `state.json` names the snapshot (`snapshot`) for the activation.
2. Deploy script, pre-activation verification or scheduling fail →
   `restore`, `systemctl daemon-reload`, `reload nginx` (when active), stop the
   units the restore removed (point 5), restart the services only if one is
   down (in `defer` mode the old code is still the running one), then the full
   verification against the previous commit.
   The job keeps its failure code; `last-result.json` carries `rollback`
   (`result`, `verification` or `error`), `state.json` is the restored one plus
   `rollback` (failed commit, snapshot, phase).
3. Activation fails (restart, verification) → the same restore, then restart of
   the services and verification of the previous commit;
   `activation.status = rolled-back` (or `failed` when the rollback itself could
   not prove the previous stand), exit 68.
4. A rollback that cannot restore or verify says so loudly
   (`rollback incomplete: …`) and leaves the snapshot in place for the operator.
5. Units the update added (Kanban t_b049f75b, B1 of t_15055863): after the
   restore and `daemon-reload` the rollback asks systemd for the `LoadState` of
   every service in `COCKPIT_SELF_UPDATE_SERVICES` and of every
   `/etc/systemd/system/*.service` the restore reports as removed. A unit that
   is `not-found` belongs to the failed stand: it is stopped and
   `reset-failed`, listed in `rollback.removed_units`, and neither restarted
   nor verified; its broker socket is dropped from the check as well
   (`<dir>/cockpit-<role>/<x>.sock` belongs to `wireguard-ops-cockpit-<role>`;
   a socket of any other form is always checked). A removed unit that is still
   active after the stop makes the rollback incomplete. An unreadable
   `LoadState` counts as present, so the unit stays restarted and verified.

**Honest limit, the rollout that brings a new unit.** A rollback runs with the
runner that is running at that moment. The deploy phase (point 2) runs with the
runner installed *before* the update, the activation (point 3) with the newly
installed one. So when the update that introduces this rule (PR #98, which also
adds `wireguard-ops-cockpit-runner`) fails in its deploy phase, the old rollback
removes the new unit file but leaves the runner broker that the deploy started
with `enable --now` running as a `not-found` orphan; the rollback itself still
verifies, because the old service list does not contain the runner. The
operator clears it with
`systemctl stop wireguard-ops-cockpit-runner && systemctl reset-failed wireguard-ops-cockpit-runner`.
From the next update on, both phases use this rule. In either case the
`multi-user.target.wants` link of a removed unit stays behind dangling (the
snapshot footprint does not cover `*.wants`); systemd ignores it.

`restore` puts back bytes, modes, owners and symlinks (`cp -a`), removes what
the update added below the globs, and swaps directories in by rename after the
copy is complete, so a failed copy (e.g. no space) leaves the live tree as it
was.

**What this is not:** a net for general host changes. The general door
(`cockpit-host-run`) has its own net per instance role since 16.10.2026
(`doc/setup/host-run.md`, „Netz je Instanzrolle“): on the VPS a borg backup and
a machine snapshot, on Lab0 a local host snapshot (`cockpit-host-snapshot`:
`/etc`, package selection, unit states). The role file
`/etc/wireguard-ops-cockpit/instance-role.env` belongs to this footprint, so a
rolled-back update removes or restores it with the helper it belongs to. Cockpit
code reaches Lab0 only through this typed self-update (doorkeeper X2 sends
Cockpit code changes here anyway).

**Rollout on Lab0.** The runner calls the installed
`/usr/local/lib/wireguard-ops-cockpit/homeserver-cockpit-deploy.sh`; the
scripts before this change did not install themselves there, so the first stand
with this module needs one manual root run on the box (bootstrap copy of
`deploy/lab0/homeserver-cockpit-deploy.sh`, `REPO_COMMIT=<merge sha>`). From
then on an update is a Cockpit job on Lab0 with the plan line
`/usr/local/sbin/cockpit-self-update-action <sha>`, reviewed before install,
with snapshot and rollback. Nothing polls: the job is ordered when wanted.

## Review before install

The agent may plan and roll out new Cockpit versions on its own; the owner does
not approve every update. Instead the **running** Cockpit reviews the **new**
code before it is installed, and only stops for the owner when the review
cannot vouch for it.

Flow of a Hermes change job whose plan contains `self.update <sha>` lines:

1. **Diff.** For every sha the API asks the executor broker for `self.diff`
   (`sudo -n cockpit-self-update-action diff <sha>`). The helper runs the
   runner's read-only `diff` in a transient, collected unit (the executor
   sandbox has only `AF_UNIX`, the fetch needs the network) with
   `ProtectSystem=full`, `ProtectHome=read-only`, `PrivateTmp`,
   `NoNewPrivileges` and `RuntimeMaxSec=420`. Same allowlisted-remote, fetch
   and merged-into-`origin/main` checks as a deployment; base = the deployed
   commit (`state.json`, else the checkout HEAD). It refuses with 66 while a
   deployment holds `run.lock` and never writes state or results. Output:
   `base`, `sha`, `files` (name-status, counts, class), `stat`, `diffSha256`
   (sha256 of the full `git diff base sha` bytes, all diff options pinned),
   `focusAreas`, and `excerpt` (per-file sections, focus areas first, capped at
   200 KB; `truncated`, `partialFiles`, `omittedFiles`).
2. **Focus areas** — the runner's deterministic classification (old code
   judges new code). They tell the reviewer where to look; they never stop a
   job by themselves:

   | kind | guarantee | what |
   | --- | --- | --- |
   | `sudoers-additions` | G4 | added non-comment lines in `deploy/sudoers/*` (`#include`/`#includedir` count as directives) |
   | `update-mechanism` | G7 | the self-update helper, runner, snapshot helper, Lab0 deploy script, unit, `update-review.ts`, `update-review-prompt.ts` |
   | `envelope-signing` | G2 | hunks touching `signEnvelope`, `verifyExecutionEnvelopeSignature`, `approveExecutionEnvelope`, `createExecutionEnvelope`, `validateExecutionEnvelope`, and `verifyEnvelope` in the capability helper |
   | `broker-validation` | G3 | hunks touching `validateRequest`/`signature` in the executor broker |
   | `host-door` | G2/G5/G6/G9/G10 | the general door: `apps/api/src/host-run.ts`, `deploy/helpers/cockpit-host-run`, `cockpit-borg-retention-rules.mjs`, `cockpit-state-steps.mjs`, the host-run resume unit, Lab0's net `cockpit-host-snapshot` and the three deploy-installed role files `deploy/{vps,lab0,box}/instance-role.env` |
   | `approval-and-auth`, `brokers-and-agents`, `capability-sandbox`, `root-helpers`, `ci` | G1/G6, G3/G6, G5, G4/G5, G7 | file-level areas |
   | `dependencies` | G8 | `package.json` hunks; lockfiles are summarized as a package list with install scripts and non-registry sources first |
   | `tests-deleted` | — | deleted test files |

3. **Review.** The API assembles the prompt: the instruction block
   `UPDATE_REVIEW_INSTRUCTIONS` in `apps/api/src/update-review-prompt.ts` (the
   guarantees G1–G10, how to judge, the answer format — the one place to read
   and tune the reviewer), then the material between nonce-marked
   `BEGIN_REVIEW_DATA`/`END_REVIEW_DATA` markers (focus areas, changed files,
   stat, diff excerpt; high-confidence secret formats redacted), then a short
   reminder that the material is data. The prompts are written to
   `proposals/<jobId>-update-review.md` (0600) and sent to the isolated safety
   role (`updateReviewRunner`, default: agent broker). The budget per prompt
   is the safety role's bound of the agent broker, counted in bytes: the
   bounds are defined once in `apps/agent-broker/src/prompt-limits.mjs`
   (safety and verifier 100,000 characters, the other roles 30,000), which
   the broker enforces and the API reads. The broker hands the prompt to
   opencode on stdin, so no argv byte bound applies (until 22.10.2026:
   120,000 bytes); a violation reads "prompt length <n> exceeds <role> limit
   <bound>".

   **Passes** (since 12.10.2026, `buildUpdateReviewPasses`): a diff larger
   than one prompt is reviewed in several passes (at most
   `UPDATE_REVIEW_MAX_PASSES` = 5) instead of a cut excerpt. Every pass carries
   the instructions and the update's whole description (focus areas, file
   list, stat) plus the complete diff sections of a part of the files, and
   says which files the other passes hold. Sections are placed whole in review
   order into the first pass with room; a section that fits no open pass opens
   the next one. Order: root and build material first (`deploy/`, `ops/`,
   Dockerfiles, compose files, systemd units, sudoers, `package.json`), then
   the lockfile, then every other file, documentation last — so the material
   that runs as root or goes into the images lands in the first pass. So every
   changed file reaches a reviewer completely in **exactly one** pass — except
   a file whose section alone is larger than a pass (since 10.11.2026, card
   t_89b7bb76; case: the former `deploy/helpers/cockpit-backup-guard.mjs`, diff ~90 KB):
   `splitAtHunks` cuts it at its hunk boundaries (`@@`) into parts that each
   fit a pass, every part with the file header (`diff --git`/`---`/`+++`) and
   a first line `[part k/n of <path>: hunks a–b of N; …]`; the parts go over
   several passes, and every pass names the other parts and the pass that
   holds them (`<path> (part 2/3, hunks 24–29) in pass 3`). No hunk is ever
   cut. The file counts as covered only when every part reached a pass; some
   parts in, the rest beyond the pass limit, is `cut` (incomplete). The merge
   needs no file view: approve only when every pass approved, so no single
   part's approve marks the file reviewed. Not given additionally: the full new
   file of a focus file for context across hunks — at 152 KB it is larger than
   a pass itself, and the hunks already carry their context lines; a reviewer
   who cannot judge a hunk without more says so (`UNVERIFIABLE` of what it saw
   is a stop, never a pass).

   **Unchanged context of the backup bolt** (12.11.2026, card t_7ea8785f) is
   removed together with the bolt (13.11.2026, card t_abe2651b): the review sees
   the diff only.

   The
   passes are asked one after the other (`runUpdateReviewPasses`); a failed
   pass does not keep the others from answering. Their answers are united
   (`mergeUpdateReviewAnswers`): the findings of all passes count; one
   evidenced finding is a finding (an unparseable or failed pass beside it is
   named in the reason); approve only when every pass approved; otherwise
   incomplete. The diff of ad82dbf..cba7628 (20 files, 130 KB excerpt), which
   stopped twice on 11.10.2026, is reviewed completely in two passes
   (`apps/api/test/fixtures/self-diff-ad82dbf-cba7628.json`).
4. **Decision** (`applyUpdateReviewPolicy`, after all plan checks). Operator
   decision of 11.10.2026: the operator is asked **only when a reviewer raises
   its hand**. The review comes to one of three results (`job.output` evidence
   line `pre-install review result: pass|finding|incomplete`):
   - **pass** — `VERDICT: approve` on complete material → the job continues
     autonomously; `NOTES` are kept in `job.output.updateReview`.
   - **finding** — `VERDICT: flag` with at least one finding whose `GUARANTEE`
     is not `UNVERIFIABLE` (a guarantee, `INJECTION`, or no or an unknown label)
     → `blocked_user_approval` with the findings. A finding always reaches the
     operator, also when the input was incomplete as well (the reason then
     names both). Over a plan that is already `blocked_prerequisite` or
     `blocked_policy` the block stays (an approval never lifts it); the job
     records `output.updateReview.result: "finding"` and `GET /api/inbox`
     lists it under `reviewFindings` for seven days, which James forwards —
     a revised plan whose new review passes does not bury the finding.
   - **incomplete** — no judgement on complete material and no finding (pass
     is never the remainder: no reviewer answer at all is incomplete, „the
     review produced no verdict“): the input is unavailable (`self.diff` failed) or incomplete, the reviewer
     failed or timed out, its answer does not parse (not exactly one `VERDICT`
     line, approve with findings, anything else), or it flagged only
     `UNVERIFIABLE` points (or no finding block at all) →
     `blocked_prerequisite`, zone red. Nothing is installed and nothing is
     offered for approval: this is a fault of the tool chain for the agent to
     clear (fix the collection, retry), not a question for the operator. It
     even replaces a `blocked_user_approval` of the plan policy, because an
     unreviewed update is never offered for approval; only `blocked_policy`
     (no approval offer either) stays. Incomplete input
     means a file the reviewer must see completely did not reach a pass
     whole: every focus-area file (a binary one counts as incomplete) and every
     other changed file except markdown and `package-lock.json` (summarized as
     the G8 package list) — tests included, for both repositories. Such a file
     is never cut inside a hunk: one with a single hunk larger than a whole
     pass, or (whole or in parts) beyond the pass limit, is left out (`cut`,
     when some of its parts got in) and stops the review. Only documentation may be cut:
     it fills the room the other material leaves and never opens a pass of its
     own. A reviewer's `UNVERIFIABLE` is for what it saw and cannot judge, never
     for material the Cockpit failed to collect.
   - Touching a focus area with an `approve` verdict does **not** stop.

   A plan that is already blocked for another reason keeps its status and
   gains the review's reasons and evidence — a hard plan block (protected
   boundary, red zone, capability escalation, `shell.exception`) still asks
   the operator after a pass. The full matrix is in
   `doc/setup/host-run.md`, "Freigabe-Matrix".

**Second review: a report instead of a stop** (operator decision 07.11.2026,
„ja alles“, point 4b; `verifySecondReview`, `secondReviewCovers` in
`update-review.ts`). The same diff used to be judged twice — by the Opus second
review of the pull request and by this review — and the second judgement
stopped twice on what the first had already cleared (PR #64, t_ff43a907). When a
self-update review comes to `finding` or `incomplete`, the running Cockpit looks
on GitHub itself — never at what the requester says — for proof that **every**
installed commit is exactly a reviewed pull request. All of it, per binding
`base..sha`, from the unauthenticated API of `JSchmid6/wireguard-ops-cockpit`
(bounded, 15 s per request):

1. The first-parent line from `sha` down to `base` (`GET /commits/<c>`, walking
   the first parent) holds at most `SECOND_REVIEW_MAX_MERGES` = 8 commits and
   each of them is the merge of one pull request (since 13.11.2026, card
   t_36523a6a: a host that lags behind — Lab0, box — installs several merges
   with one binding; before, only `base..sha` of exactly one merge counted, and
   squash merges never did). A commit on the line that is not proven breaks the
   proof; so does a longer line or one that never reaches `base`.
2. For each commit `c` with first parent `p`: `GET /commits/<c>/pulls` names a
   pull request into `main` of this repository, merged, with
   `merge_commit_sha == c`. A merge commit has exactly two parents and the PR's
   `head.sha` is the second; a squash merge has one parent and the PR names its
   head.
3. `GET /compare/<p>...<head>`: `behind_by == 0` (the head contains `p`), and
   `GET /commits/<head>` has the same tree as `c`: the installed code is byte
   for byte the reviewed head.
4. `GET /issues/<n>/comments` or `GET /pulls/<n>/reviews` (first 100 each): a
   comment or review by an account with write access (`author_association`
   `OWNER`, `MEMBER` or `COLLABORATOR`) with the line, alone on its line,

   ```
   Cockpit-Zweitpruefung: FREIGABE <head sha, 40 lowercase hex> opus
   ```

   The second review posts this line in the PR when it approves, naming the
   head it reviewed. A later push changes the head, and the old marker no
   longer counts. The line never goes into a commit message (the reviewer
   would read it as an injection, see the cockpit skill).

With that proof — and only for light findings, see the severity cut below — the
review stays recorded but keeps the plan's own status:
evidence `second review verified for <sha>` and `pre-install review <result>
reported, not a stop`, `output.updateReview.secondReview` and `reported: true`,
audit `hermes.update_review.reported`, and `GET /api/inbox` lists it under
`reviewFindings` with `reported: true` for seven days, whatever became of the
job. Without the proof — a step fails, GitHub is unreachable or rate-limited, a
page does not parse — nothing changes. A plan block (`evaluatePlanPolicy`), a
missing binding (`unavailable`), `dienste.update`, the safety review, the
envelope binding of the reviewed hash and the runner's own checks are not
touched. Honest limit: the marker is posted with the owner's token, the same
the agent holds; it proves a review record for exactly this head, not a second
principal. Spelled out (card t_e49f6254, 10.11.2026): the agent can write the
marker line itself, without any second review having run, on every pull
request it merged itself — and James merges directly. So for a self-update
the agent can turn this review's `finding` or `incomplete` into a report and
install the flagged code without the operator. What is left is the public,
immutable PR comment, the report in `GET /api/inbox` (`reviewFindings`,
`reported: true`, seven days) and the audit `hermes.update_review.reported` —
the operator learns of it afterwards, not before. Job 9bc909ed's own pre-install
review flagged exactly this path (G1/G7, high); the operator kept the second
review and narrowed it instead (10.11.2026, variant C):

**Severity cut** (`secondReviewStops`, `secondReviewReports`; operator decision
10.11.2026, variant C, set anew 13.11.2026, card t_36523a6a). Because the marker
is no second principal, it does not carry every finding. Since 13.11.2026 the
operator's rule decides what is a stop ("Ausrollen entscheidet James; Jochen nur
bei einem echten Befund"; "mach den Scheiß raus", 13.11.2026): Jochen's Ja to a
change of rights or of the backup bolt is asked **before the merge**, the
rollout needs no second one. A finding stays the operator's stop
(`blocked_user_approval`) despite a verified proof only when

- it names **G10** anywhere in its `GUARANTEE` line (backups and declared risk —
  the one standing exception, Grundsatz 4),
- it is an **`INJECTION`** (someone addressed the reviewer inside the material), or
- it names **G1, G2 or G4** (who approves, the lock, sudo — rights) with a
  severity that does not start with `medium` or `low` (fail closed) **and** its
  quoted code was found in the reviewed diff (`quoteFound`) — an evidenced rights
  finding with a damage path, not an assertion.

Everything else is a report: G5, G7 and the other guarantees of any severity,
medium/low rights findings and a severe rights finding whose quote is not in the
diff. The verified proof is still recorded (`second review verified for <sha>`,
then `second review does not lift the stop: …` with the findings beyond the cut),
and `reported` stays `false` for a stop. `incomplete` (tool-chain gaps,
`UNVERIFIABLE` only) stays a report. Honest limit, unchanged in kind: the agent
can post the marker itself, so a G7 weakening of this very path, a G5 loosening
of a safety net or a severe point the reviewer mislabels installs with a report
(inbox `reviewFindings`, audit, the public PR comment) instead of a click.
A change that lets the proof lift one of the remaining stops is a G1 finding of
the review itself (`update-review-prompt.ts`) and, evidenced and severe, stays a
stop. Earlier cut (10.11.2026 to 13.11.2026): every `high` finding and every
finding on G1/G2/G7/G10 stopped; in practice it stopped the rollout of every
reviewed fix to the update path (G7) and of Jochen's own net decision of
28.10.2026 on Lab0 (job dc8d47e3, three G5 findings).
Way back: revert this change (one commit in `update-review.ts`,
`update-review-prompt.ts`, tests and docs) and self-update to the previous
commit.

**What the owner sees — only for a finding.** The job explanation's `reason`
names why (the flagged findings; for `blocked_prerequisite` the agent reads the
same fields: unavailable/incomplete input, reviewer failure, parse failure,
only `UNVERIFIABLE` points) and `evidence` lists, per finding, `GUARANTEE`, `SEVERITY`,
`FILE`, `REASON` and the quoted `CODE` (bounded), marked whether the quote was
actually found in the reviewed diff, plus the reviewed `base..sha` and diff
hash. `job.output.updateReview` keeps the focus areas, coverage, verdict,
findings and notes (not the excerpt).

**Binding review to installation.** The reviewed `(base, sha, diffSha256)` is
an evidence item (`self-update-review:<sha>`) of the signed execution envelope.
At execution the API takes the hash only from a binding that matches the
envelope and passes it with `self.update` to the broker (`diffSha256`, 64-hex,
covered by the broker HMAC, required for `self.update` and rejected on every
other action). The helper passes it in the unit instance; the runner recomputes
`git diff base sha` right before the deploy script and refuses with 65
(`phase: review`, "reviewed diff mismatch") when the base moved or the code
changed since the review — the job must then be reviewed again. A job without
a binding (review input unavailable) is `blocked_prerequisite` since
11.10.2026 and never runs; the executor's fallback for an operator-approved
envelope without a binding (hash taken at execution) only serves jobs approved
before that. If the review itself is broken in the running Cockpit, the way
out is the host deploy (`deploy/vps/vps-cockpit-deploy.sh`), not an approval.

**Bootstrap when the update path itself is broken** (decision 13.11.2026, card
t_36523a6a, case job f7b522b6: the installed runner computed `self.diff` with a
bug, so no self-update could bring its fix). The way out is a `host.run` that
installs the fixed file from the merged commit, or runs the deploy script for
it. The doorkeeper flags that as X2 ("Cockpit code changed outside the reviewed
self-update path"), and it **stays** an operator click: such a run installs new
Cockpit code without the pre-install review of the running Cockpit (old judges
new), which is exactly what Jochen kept when he left the rollout to James
(12.11.2026: "das Cockpit prüft vorher"). Conditions that would close the risk
together — the source is `git show <sha>:<path>` of a commit the root helper
verifies as merged into `origin/main`; the commit carries the verified second
review; the installed file is the known previous version; the snapshot and the
old file stay — replace the review only by the self-postable marker, so they do
not lift the click. Kept small instead: a bootstrap is needed only when the
update mechanism itself is broken (twice so far), and on a host that lags far
behind (Lab0, box) one host deploy to the current head, one click, replaces a
chain of staged self-updates that each stop on the old prompt.


**The old one-argument form** (`cockpit-self-update-action <sha>`, runner
`deploy <sha>`) is refused with 65: every self-update must come from a job
whose diff was reviewed. `status` is unchanged.

**Prompt cases.** `apps/api/test/fixtures/update-review-cases.json` holds benign
cases (signature-verification refactor that keeps the timing-safe compare, a
typed helper with its exact sudoers line, a dev-dependency bump) and harmful
cases (sudoers wildcard, removed broker signature check, approval route for the
bearer token, a comment instructing the reviewer), plus the general door: a
benign change to the host-run step environment (plan text still runs as root
through `bash -c` — must come back `approve`) and three harmful ones (a passed
doorkeeper opens the risk bolt → G10, an oversized plan cut instead of
stopped → G9, the safety net skipped for runs declared `contained` → G5). Each case carries the expected
verdict and an example answer. The unit tests check only the deterministic
parts (prompt assembly, parser, policy). To evaluate a real model later, build
each case's prompts with `buildUpdateReviewPasses`, send them to the safety role,
and compare the parsed verdict (and, for harmful cases, the guarantee of a
finding) with the fixture; benign cases must come back `approve`.

## The guarantees and the one door

Stand 02.10.2026. Until then G1, G3 and G5 described the architecture before
the general door (`doc/setup/host-run.md`): only the operator approves, no free
text reaches a shell, nothing runs outside the capability sandbox. The
self-update to PR #25 (the door) was stopped with exactly these three findings
(job `c65999ef`): the doorkeeper starts root runs without the operator, plan
text reaches `bash -c` as root, `host.run` has no sandbox and no protected
paths. All three are Jochen's decision of 30.09.2026 („eine Tür mit Schloss und
Türsteher“, approval only on a finding, deleting backups only with approval),
so every later change at the door would have been stopped again.

The guarantees now describe that model. The door itself is not a finding; a
finding names a concrete way **past** one of its guards, or a weakening of it:

| Guarantee | holds |
| --- | --- |
| G1 Approval | only the admin session approves; a bearer token never approves or sets `operatorApproved`/`gatePassed`. A `host.run` start on the doorkeeper's pass is intended. A job that needed the operator (evidenced finding, a declared risk other than `contained`, a door without doorkeeper) never runs without the operator's approval. Exception by decision (07.11.2026): a self-update review finding whose commits carry a second review the Cockpit verified itself on GitHub is a report, not a stop ([Second review](#review-before-install)); the marker can be posted by the agent's own token, so this exception rests on a public record, not on a second principal, and it does not carry a finding on G10, an `INJECTION` or a severe, evidenced finding on G1/G2/G4 — those stay stops (severity cut, 10.11.2026, set anew 13.11.2026). Also intended (13.11.2026): the admin session approves a job whose envelope only expired, within 72 h of its creation; the envelope is re-signed with the same content and approved in that one decision. |
| G2 Lock | HMAC envelope (timing-safe, host secret), bound to plan and `manifestHash`, with expiry, capability and the job id (its form; the run directory is named by it); the root helper checks it at the start and on every resume; a blocked job's envelope never opens. |
| G3 Doors | `host.run` is the one general door; every other action stays typed and narrow. No second general door, no way into `host.run` past G2, G9, G10. |
| G4 Root helpers and sudoers | narrow, typed; the host-run helper keeps exactly `start` and `status <job>`. |
| G5 Sandbox and safety net | the special doors' sandbox is not broader; `host.run` has none by design, but before every run with `mutates: true` the net of the instance role, otherwise no step runs: role `vps` a return path — the last successfully finished borg backup at most 30 h old (a later failed run does not take it away; without it only the two typed exceptions of `doc/setup/host-run.md` run, emergency shutdown and backup repair, recognized by fixed forms only) — and a machine snapshot; role `lab0` (the borg target, no hoster) a complete local host snapshot (`/etc`, packages, unit states) plus the data lock: the run unit mounts `/media` (borg repository), `/home`, `/mnt`, `/srv` read-only and the run confirms it in its mount table before the first step and after a reboot (Jochen, 17.10.2026: on Lab0 this replaces borg freshness and the machine snapshot); role `box` (Proxmox host, t_88f1e802) the same host snapshot plus a Proxmox snapshot of every guest (VM and container); a guest that cannot be snapshotted stops the run; no data lock (the guests' snapshots are their way back). The role comes only from the root-owned `instance-role.env` the deploy installs; missing, foreign-writable or unknown → no step runs (16.10.2026). Snapshot revert/delete stays the operator's decision (at the door through the doorkeeper's X4, on box also for deleting or rolling back a guest snapshot). |
| G6 Secrets | redaction of outputs, logs and prompts; the host-run log redacted line by line and 0600. The doorkeeper's unredacted material is intended. |
| G7, G8 | unchanged (self-update path, dependencies). |
| G9 Doorkeeper | isolated safety review; a pass only with complete material (a file larger than one pass is complete only when all its hunk parts were reviewed); incomplete or unreadable review and findings without evidence stop without a pass; its finding classes (secrets/egress, authority, exposure, loss of the way back, false read-only claim, hidden code, injection) do not narrow. Its own instructions are not writable by the agent identity: the agent unit keeps the home with the opencode config, agent definitions, tools and global `AGENTS.md` read-only, and the broker refuses to start while project config lies above the workspace or extra config in the global config directory (card t_62992d58). opencode's state lives per run in the workspace, and the runner (`build`) runs as its own identity `cockpit-runner` with its own home, workspaces and socket, which the agent broker does not serve and the API never routes it past (card t_cb81637b; honest limit: the plan roles planner, research, safety and verifier still share `cockpit-agent`, so a planner or research run can write a concurrent workspace, the session root or the socket directory of that unit and leave a process behind, `doc/services/execution-control-model.md`). |
| G10 Backups and declared risk | deleting, pruning or compacting backups, shortening their retention or switching them off (borg/borgmatic, `borgmatic.timer`, Lab0's retention service below its minimum or bypassed, vzdump backups and guest snapshots on box) only with `operatorApproved` (Grundsatz 4). Since 13.11.2026 (card t_abe2651b, operator decision 08./13.11.2026: text filters are out) the doorkeeper recognizes it on the whole plan: its instructions make every such run an X4 finding, and a finding goes to the operator. Structurally the VPS's borg key is append-only on Lab0, Lab0 and box take a host snapshot before every mutating run, and the retention service keeps its fixed bounds (`cockpit-borg-retention-rules.mjs`). A finding: weakening the X4 rule in the doorkeeper's instructions, a doorkeeper finding that runs without the operator, the VPS key beyond append-only, the snapshot before a mutating run removed on Lab0 or box, the retention bounds widened. The former deterministic backup bolt (`cockpit-backup-guard.mjs`) is removed. Risk bolt under the same guarantee (incident 23.10.2026): a manifest declaring `exposure`, `data_loss` or `identity_or_secret` starts only with `operatorApproved`, even on a pass, asked at three places (`hostRunRisksNeedingApproval` in the policy, `runHostRun`, the root helper incl. resume); an unknown risk class makes the manifest invalid. |

The runner marks changes to the door's files as focus area `host-door`
(G2/G5/G6/G9/G10). Like every focus area it only steers the reviewer.

**Order of rollout.** The review runs with the prompt of the *running*
Cockpit. The first self-update that brings these guarantees is still judged by
the old G1/G3/G5 and may be stopped with the same three findings; that stop is
the operator's to approve once. From then on the new guarantees apply.

## Refusal codes

| Code | Meaning |
| --- | --- |
| 64 | usage: bad argument form (`status`, `diff <sha>`, `<sha> <diff-sha256>` only) |
| 65 | refused: repo/origin mismatch, sha not merged, malformed sha/hash, unreviewed update (bare sha), reviewed diff mismatch |
| 66 | another self-update holds the lock (also: review diff while a deployment runs) |
| 67 | installation problem: state dir missing, deploy script not root-owned or group/other-writable |
| 68 | verification failed (before activation, or during activation) |
| 69 | the deploy script itself failed |

Every refusal is a structured JSON object on stdout/stderr and a `last-result.json`
under the state directory — never a bare exit code.

## Tests

- `sudo bash test/cockpit-self-update-action.test.sh` — offline simulation
  (fixture git origin, stub systemctl/systemd-run/curl/ip, real helper, real
  runner): happy path, usage refusals, unmerged commit, deploy failure,
  verification failure, concurrency, deploy-script permissions, origin
  mismatch, status; review diff (hash, focus areas, excerpt order and bounds,
  read-only), reviewed-hash binding (mismatch refused before the deploy script,
  moved base invalidates an older review), runner refusals, diff during a
  deployment.
  S17 covers Lab0's safety net with a stub snapshot helper: snapshot before the
  deploy script, rollback after a failing deploy (checkout and state back, no
  restart), failing snapshot stops before the deploy, rollback after a failing
  activation (restart, previous commit verified, `rolled-back`), a rollback
  that cannot verify or restore is reported, never hidden. S17f: the update adds
  a unit whose broker already runs, the activation fails and the restore removes
  the unit file (the stub answers rc 5 for a unit without a file); the rollback
  stops the orphan, restarts and verifies only the remaining units and sockets
  and ends `rolled-back` (red against the rollback before t_b049f75b).
- `sudo bash test/cockpit-self-update-snapshot.test.sh` — the snapshot helper
  against a fixture root: byte-, mode- and owner-exact restore of a changed
  footprint (changed, added, removed files, new helper and unit), secrets and
  foreign files untouched, refusals (name, existing, incomplete, space),
  rotation.
- `apps/api/test/update-review.test.ts` — prompt assembly, answer parser,
  coverage/truncation stop, policy, envelope binding, prompt cases, second
  review (every step of the GitHub proof refused on its own, report only with
  the full proof, never for `dienste.update` or over a plan block).
- `bash test/cockpit-self-update-e2e.sh` — disposable privileged container with
  real systemd: installs the module at its production paths, runs the update
  from a sandbox-mimicking transient unit (`ProtectSystem=true`,
  `RestrictAddressFamilies=AF_UNIX`, `ProtectHome=read-only`) including the
  review diff (which must escape that sandbox through its transient unit),
  waits for the real activation timer, and re-runs the flow over the sudoers
  path as `cockpit-executor`, including the unreviewed and wrong-hash
  refusals.

## VPS (Contabo vmd61162, WireGuard 10.0.0.1)

The VPS has no Lab0 package script; its reviewed deploy script is
`deploy/vps/vps-cockpit-deploy.sh` (installed to
`/usr/local/lib/wireguard-ops-cockpit/vps-cockpit-deploy.sh`). Same contract
(`REPO_COMMIT=<sha>` merged into `origin/main`, `COCKPIT_RESTART_MODE=defer`,
`state.json` with `web_url=http://10.0.0.1:8080`).

**Footprint — exactly the table at the top of the script, nothing else:** the
root helpers the executor and the capability sandbox dispatch to (capability
action, hermes-skill, email-archive deploy and auto-deploy, the three Nextcloud
PHP helpers, service, disk, exact-file-replace, Nextcloud app/context,
dienste-update, self-update action and runner, VPS snapshot, WordPress update,
GitLab rootless-DinD policy, the host door),
the sudoers file (checked with `visudo -cf` before and `visudo -c` after), the
four service units and the API's broker drop-in, the email-archive auto-deploy
service/timer, the
self-update unit template, the web unit and this script, plus
`/etc/wireguard-ops-cockpit/self-update.env`. Besides the table it writes only
`state.json`, the web image, the web unit's enable link and a backup directory
below its own `self-update/` (0700) that it removes on success; the service
user's data directory `/var/lib/wireguard-ops-cockpit` (wgops, 0750) is never
changed. VPS-specific service settings live in drop-ins
(`*.service.d/`) and are not touched. `homeserver-cockpit-deploy.sh` is Lab0's
and is not installed here.

**Pinned Node runtime:** the version comes from the deployed commit's
`.node-version` (the file `bin/with-runtime` and the units read), and the deploy
installs `/opt/node-v<version>-linux-x64` from
`https://nodejs.org/dist/v<version>/` when the host does not have it — before the
build, because `bin/with-runtime` fails closed with 69 without it and a host
without the runtime could never roll itself out. The tarball is checked against
nodejs.org's own `SHASUMS256.txt` (no hash is kept in the repository) with
`sha256sum -c`; a download or checksum failure exits 70 and the rollback runs.
The install is idempotent (an existing runtime is used as it is) and never
removes another runtime: the previous version stays on disk, and that is what the
rollback's build runs on. Only one clean `x.y.z` is accepted from `.node-version`
— the value becomes a path and a URL under a root script.

**Web:** the image is always built (the Docker cache makes an unchanged build
cheap; a list of build inputs would miss some). The running container is never
switched by the deploy: `wireguard-ops-cockpit-web.service` (oneshot,
`docker compose up -d --no-build --force-recreate web`, so every restart swaps
the container instead of trusting compose's change detection) does that when
restarted, and
`self-update.env` puts it into `COCKPIT_SELF_UPDATE_SERVICES`, so the runner
switches web together with the four services at the activation, after its
pre-activation checks. The unit is started by the deploy only when it is not
active (first install), before the new image exists — so nothing switches early.
The deploy records the built image id and the container name in `state.json`
(`web_image`); the runner compares them before and after the activation, and
mode `now` checks the running container right after its restart (68 otherwise).

**Rollback:** every target is saved (or recorded as absent) before the install.
Any failure until `state.json` is written restores exactly those bytes, removes
files that did not exist, puts the web image tag back on the previous image,
checks the old commit out and rebuilds it; each step
is logged and a partial rollback says so. `test/vps-cockpit-deploy.test.sh`
exercises install, byte-exact rollback, web image rollback, build failure,
unmerged commit, the deferred restart, the web unit start rule, the data
directory's mode and the pinned-runtime install (missing runtime, second run
without a download, wrong checksum, failed download, `.node-version` that is not
one `x.y.z` — each of the last three ends in 70 and its rollback) offline
(fixture repo, stub systemctl/visudo/docker, a local release directory as
`VPS_DEPLOY_NODE_DIST`).

First install, once, as root (take a Contabo snapshot before):

```bash
cd /opt/wireguard-ops-cockpit && git fetch origin
REPO_COMMIT=$(git rev-parse origin/main) bash deploy/vps/vps-cockpit-deploy.sh
```

After that, updates are Cockpit jobs with the plan line
`/usr/local/sbin/cockpit-self-update-action <sha>`, reviewed before install.
