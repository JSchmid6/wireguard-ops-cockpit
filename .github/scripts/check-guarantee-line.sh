#!/usr/bin/env bash
# Fails a pull request that changes the approval door (host-run, update review,
# self-update, backup bolt) without naming the guarantees it touches.
#
# Why: the rule "approval only on a finding" and the guarantees G1-G10 live in
# doc/setup/self-update.md. Twice on 11.10.2026 a change drifted from them and
# only the second review caught it. This check makes the author open that file
# before the change is reviewed.
#
# Usage: check-guarantee-line.sh <base-ref>   (PR text in $PR_BODY)
set -euo pipefail

base="${1:?usage: check-guarantee-line.sh <base-ref>}"
guarded='^(deploy/helpers/cockpit-(host-run|backup-guard\.|borg-retention-rules\.|state-steps\.|self-update-|dienste-update-action)|apps/api/src/(update-review|update-review-prompt|host-run|hermes-security)\.ts$|doc/setup/self-update\.md$)'

hits="$(git diff --name-only "${base}...HEAD" | grep -E "${guarded}" || true)"
if [ -z "${hits}" ]; then
  echo "no guarded file changed"
  exit 0
fi

echo "guarded files changed:"
printf '  %s\n' ${hits}

# One line, e.g. "G-Garantien berührt: G1, G10 — bleibt erhalten, weil ..."
# or "G-Garantien berührt: keine — nur Kommentare". Needs a G<n> or "keine".
if printf '%s\n' "${PR_BODY:-}" | tr -d '\r' \
  | grep -Eiq '^[[:space:]*_-]*G-Garantien (berührt|beruehrt):?[*_]*:?[[:space:]]*.*(G[0-9]+|keine)'; then
  echo "guarantee line present"
  exit 0
fi

cat >&2 <<'MSG'
::error::This PR changes the approval door but its description lacks the line
  "G-Garantien berührt: <G1..G10 or keine> — <why each still holds>".
Read doc/setup/self-update.md completely first ("Before you change this
door", "The guarantees and the one door", G1-G10) and doc/setup/host-run.md
(approval matrix), then add the line to the PR description. Editing the
description re-runs this check.
MSG
exit 1
