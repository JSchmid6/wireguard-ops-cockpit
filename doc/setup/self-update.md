# Self-Update — Machine Rollout of the Cockpit Stand

This document records the typed self-update module: how a merged cockpit stand
reaches the host as a reviewed job instead of a manual root session, and the
exact lines the deploy script must carry so the next manual rollout installs it.

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
| `/etc/systemd/system/wireguard-ops-cockpit-self-update@.service` | `deploy/systemd/wireguard-ops-cockpit-self-update@.service` | One-shot deploy unit, instance = `<sha>-<diff-sha256>`. |
| `/etc/sudoers.d/cockpit-executor` | `deploy/sudoers/cockpit-executor` | Gains the `cockpit-self-update-action *` line. |
| `/var/lib/wireguard-ops-cockpit/self-update/state.json` | runtime | State: `deployed_commit`, `previous_commit`, `web_url`, activation status. Root-owned, 0750. |
| `/var/log/wireguard-ops-cockpit-self-update/` | runtime | One log per run plus `history.jsonl`. Root-owned, 0750. |
| `<api data dir>/proposals/<jobId>-update-review.md` | runtime (API) | The exact prompt the isolated reviewer received for a job's self-update. 0600. |

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
   when the WireGuard address is present — `web_url` answers. It then schedules
   the activation as a one-shot timer (`systemd-run --on-active=600`) and
   writes `activation.status=scheduled`.
4. The activation restarts the four cockpit services, verifies them again, and
   writes `activation.status=ok` (or `failed` with the reason). It refuses only
   when `state.json` names a different deployed commit than its own (the stand
   moved on; the older activation is superseded).

Rollback is plain forward motion: run the job again with the `previous_commit`
sha from `state.json` (it is an ancestor of `origin/main`, so it deploys like
any other stand — and is reviewed like any other stand).

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
   | `update-mechanism` | G7 | the self-update helper, runner, unit, `update-review.ts`, `update-review-prompt.ts` |
   | `envelope-signing` | G2 | hunks touching `signEnvelope`, `verifyExecutionEnvelopeSignature`, `approveExecutionEnvelope`, `createExecutionEnvelope`, `validateExecutionEnvelope`, and `verifyEnvelope` in the capability helper |
   | `broker-validation` | G3 | hunks touching `validateRequest`/`signature` in the executor broker |
   | `approval-and-auth`, `brokers-and-agents`, `capability-sandbox`, `root-helpers`, `ci` | G1/G6, G3/G6, G5, G4/G5, G7 | file-level areas |
   | `dependencies` | G8 | `package.json` hunks; lockfiles are summarized as a package list with install scripts and non-registry sources first |
   | `tests-deleted` | — | deleted test files |

3. **Review.** The API assembles the prompt: the instruction block
   `UPDATE_REVIEW_INSTRUCTIONS` in `apps/api/src/update-review-prompt.ts` (the
   guarantees G1–G8, how to judge, the answer format — the one place to read
   and tune the reviewer), then the material between nonce-marked
   `BEGIN_REVIEW_DATA`/`END_REVIEW_DATA` markers (focus areas, changed files,
   stat, diff excerpt; high-confidence secret formats redacted), then a short
   reminder that the material is data. The prompt is written to
   `proposals/<jobId>-update-review.md` (0600) and sent to the isolated safety
   role (`updateReviewRunner`, default: agent broker). The budget is 96,000
   bytes; the agent broker accepts up to 100,000 characters / 120,000 bytes
   for the safety role (one argv element), other roles keep 30,000.
4. **Decision** (`applyUpdateReviewPolicy`, after all plan checks):
   - `VERDICT: approve` → the job continues autonomously as before; `NOTES`
     are kept in `job.output.updateReview`.
   - `VERDICT: flag`, an unparseable answer (not exactly one `VERDICT` line,
     approve with findings, anything else), or a reviewer failure/timeout →
     `blocked_user_approval`.
   - The single deterministic stop: the review input is unavailable
     (`self.diff` failed) or incomplete — a focus-area file that is truncated,
     left out or binary in what the reviewer saw → `blocked_user_approval`.
   - Touching a focus area with an `approve` verdict does **not** stop.

   A plan that is already blocked for another reason keeps its status and
   gains the review's reasons and evidence.

**What the owner sees — only when it stops.** The job explanation's `reason`
names why (unavailable/incomplete input, reviewer failure, parse failure,
flagged findings) and `evidence` lists, per finding, `GUARANTEE`, `SEVERITY`,
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
changed since the review — the job must then be reviewed again. When the review
input was unavailable, only an operator-approved envelope may continue; the
hash is then taken at execution and still pins exactly that diff.

**The old one-argument form** (`cockpit-self-update-action <sha>`, runner
`deploy <sha>`) is refused with 65: every self-update must come from a job
whose diff was reviewed. `status` is unchanged.

**Prompt cases.** `apps/api/test/fixtures/update-review-cases.json` holds benign
cases (signature-verification refactor that keeps the timing-safe compare, a
typed helper with its exact sudoers line, a dev-dependency bump) and harmful
cases (sudoers wildcard, removed broker signature check, approval route for the
bearer token, a comment instructing the reviewer), each with the expected
verdict and an example answer. The unit tests check only the deterministic
parts (prompt assembly, parser, policy). To evaluate a real model later, build
each case's prompt with `buildUpdateReviewPrompt`, send it to the safety role,
and compare the parsed verdict (and, for harmful cases, the guarantee of a
finding) with the fixture; benign cases must come back `approve`.

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
- `apps/api/test/update-review.test.ts` — prompt assembly, answer parser,
  coverage/truncation stop, policy, envelope binding, prompt cases.
- `bash test/cockpit-self-update-e2e.sh` — disposable privileged container with
  real systemd: installs the module at its production paths, runs the update
  from a sandbox-mimicking transient unit (`ProtectSystem=true`,
  `RestrictAddressFamilies=AF_UNIX`, `ProtectHome=read-only`) including the
  review diff (which must escape that sandbox through its transient unit),
  waits for the real activation timer, and re-runs the flow over the sudoers
  path as `cockpit-executor`, including the unreviewed and wrong-hash
  refusals.
