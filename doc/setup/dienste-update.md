# dienste.update — reviewed installs of server-dienste

server-dienste (GitLab `Jochen/server-dienste`, host `/opt/server-dienste`) is
the repository behind the root **supervisor**: the only way the agent (James,
in a container without root and — after its rebuild — without the Docker
socket) operates the host's Docker services, reads host state and runs fixed
jobs. The agent extends it itself (new services, diagnoses, jobs). This module
lets it install such a change **without an operator click**, but only after the
running Cockpit had the diff reviewed by an isolated reviewer — the same
machinery as the self-update, with the supervisor's own guarantees.

## Flow

1. The agent commits to `main` of server-dienste and orders a Cockpit job whose
   plan is the single line `/usr/local/sbin/cockpit-dienste-update-action <sha>`
   (authorized capability: `dienste.update`).
2. The API asks the executor for `dienste.diff <sha>`. The helper starts
   `<repo>/bin/uebernehmen diff <sha>` in a transient unit (the executor has no
   network; the runner needs `git fetch`). The runner answers with the review
   material: base (installed HEAD), diff sha256, changed files, focus areas,
   excerpt, and the commit messages (the author's reasons, as data).
3. The reviewer judges the diff against `DIENSTE_REVIEW_INSTRUCTIONS`
   (`apps/api/src/update-review-prompt.ts`, D1-D8). approve → the job runs;
   flag, an unparseable answer, a reviewer failure or an incomplete focus area
   → the job stops for the operator with the findings and the quoted code.
4. The executor calls `cockpit-dienste-update-action <sha> <diff-sha256>`. The
   runner re-fetches, re-verifies (allowlisted origin, merged into
   `origin/main`, fast-forward from HEAD, identical diff hash), runs the new
   stand's tests **as nobody** in a throw-away worktree, fast-forwards,
   reloads/restarts `hermes-supervisor` when the supervisor changed, and checks
   its socket. A failed check resets to the old stand.

## Host installation

```bash
install -m 755 -o root -g root deploy/helpers/cockpit-dienste-update-action /usr/local/sbin/cockpit-dienste-update-action
install -m 440 -o root -g root deploy/sudoers/cockpit-executor /etc/sudoers.d/cockpit-executor   # gains the dienste line
install -d -m 755 /etc/server-dienste
# GitLab runs on this host's sshd (port 50867): pin its host key from /etc/ssh, not from a scan.
printf '[gitlab.wejos.de]:50867 %s\n' "$(awk '{print $1" "$2}' /etc/ssh/ssh_host_ed25519_key.pub)" > /etc/server-dienste/known_hosts
```

`/opt/server-dienste` stays root-owned (0750; `bin/`, `bin/uebernehmen` and
`.git` not writable by group or others) — the helper refuses otherwise. State
and history: `/var/lib/server-dienste/verlauf.jsonl`.

## Tests

- `apps/api/test/update-review.test.ts` (server-dienste block): targets,
  strict diff reading per repository, D-guarantees in the prompt, bindings that
  never cross repositories, stop reasons naming the repository.
- `apps/api/test/hermes-security.test.ts`: typed forms and classification.
- `apps/executor-broker/test/index.test.mjs`: allowlisted actions and hash rule.
- `sudo bash test/cockpit-dienste-update-action.test.sh`: helper form and owner check.
- server-dienste `tests/test_uebernehmen.py`: the runner against a real git fixture.
