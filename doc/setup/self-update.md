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
script's own contract.

## Files

| Path (host) | Source | Purpose |
| --- | --- | --- |
| `/usr/local/sbin/cockpit-self-update-action` | `deploy/helpers/cockpit-self-update-action` | The only sudo-exposed entry point. Pinned usage: one full lowercase 40-hex commit sha, or `status`. |
| `/usr/local/lib/wireguard-ops-cockpit/cockpit-self-update-run` | `deploy/helpers/cockpit-self-update-run` | The runner. Deliberately **not** a sudo target; started only by the one-shot unit. |
| `/etc/systemd/system/wireguard-ops-cockpit-self-update@.service` | `deploy/systemd/wireguard-ops-cockpit-self-update@.service` | One-shot deploy unit, instance = commit sha. |
| `/etc/sudoers.d/cockpit-executor` | `deploy/sudoers/cockpit-executor` | Gains the `cockpit-self-update-action *` line. |
| `/var/lib/wireguard-ops-cockpit/self-update/state.json` | runtime | State: `deployed_commit`, `previous_commit`, `web_url`, activation status. Root-owned, 0750. |
| `/var/log/wireguard-ops-cockpit-self-update/` | runtime | One log per run plus `history.jsonl`. Root-owned, 0750. |

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

1. A typed job runs `/usr/local/sbin/cockpit-self-update-action <sha>` (as
   `sudo -n`, pinned by sudoers). The helper validates the form, refuses while
   another update holds `/var/lib/wireguard-ops-cockpit/self-update/action.lock`,
   and starts `wireguard-ops-cockpit-self-update@<sha>.service`; it waits for
   that unit and prints the structured result JSON.
2. The unit runs `cockpit-self-update-run deploy <sha>` (as root). The runner
   verifies: repo directory exists, `origin` remote equals the allowlisted
   URL, and `<sha>` is merged into `refs/remotes/origin/main`. Only then does
   it run the deploy script with `REPO_COMMIT=<sha>`,
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
any other stand).

## Refusal codes

| Code | Meaning |
| --- | --- |
| 64 | usage: not exactly one sha / `status`, bad argument form |
| 65 | commit refused: repo/origin mismatch, sha not merged, unexpected form |
| 66 | another self-update holds the lock |
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
  mismatch, status.
- `bash test/cockpit-self-update-e2e.sh` — disposable privileged container with
  real systemd: installs the module at its production paths, runs the update
  from a sandbox-mimicking transient unit (`ProtectSystem=true`,
  `RestrictAddressFamilies=AF_UNIX`, `ProtectHome=read-only`), waits for the
  real activation timer, and re-runs the flow over the sudoers path as
  `cockpit-executor`.
