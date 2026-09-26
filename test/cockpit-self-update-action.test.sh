#!/bin/bash
# ============================================================================
# cockpit-self-update-action.test.sh — offline simulation harness for the
# typed self-update module:
#   deploy/helpers/cockpit-self-update-action   (outer, sudo target)
#   deploy/helpers/cockpit-self-update-run      (inner deploy/activate runner)
#
# Runs entirely against fixtures: a local bare "origin" repository, a stub
# deploy script, stub systemctl/systemd-run/curl/ip binaries and real unix
# sockets below a mktemp directory. Nothing outside the fixture directory is
# touched. The systemctl stub simulates the one-shot deploy unit by executing
# the runner exactly like wireguard-ops-cockpit-self-update@.service would;
# the systemd-run stub runs `--pipe` commands (the review diff unit) in place.
#
# Call (as root; the helper refuses to run as anything else):
#   sudo bash test/cockpit-self-update-action.test.sh
#
# Exit 0 = all checks green.
# ============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
HELPER="$REPO/deploy/helpers/cockpit-self-update-action"
RUNNER="$REPO/deploy/helpers/cockpit-self-update-run"

if [ "$(id -u)" -ne 0 ]; then
  echo "FEHLER: bitte als root ausführen: sudo bash $0" >&2
  exit 2
fi
for tool in git python3 flock; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FEHLER: $tool fehlt" >&2; exit 2; }
done
[ -f "$HELPER" ] && [ -x "$RUNNER" ] || { echo "FEHLER: Moduldateien fehlen in $REPO/deploy/helpers" >&2; exit 2; }

FIX="$(mktemp -d "${TMPDIR:-/tmp}/cockpit-selfupd-test.XXXXXX")"
SOCK_PID=""
KEEP_FIXTURE="${COCKPIT_SELFUPD_KEEP:-0}"
cleanup() {
  [ -n "$SOCK_PID" ] && kill "$SOCK_PID" 2>/dev/null
  if [ "$KEEP_FIXTURE" != "1" ]; then rm -rf "$FIX"; fi
}
trap cleanup EXIT

PASS=0
FAIL=0
check() { # check <name> <rc:0=ok> [detail]
  if [ "$2" -eq 0 ]; then
    PASS=$((PASS + 1))
    echo "PASS  $1"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL  $1${3:+ — $3}"
  fi
}
json_get() { # json_get <file> <dotted.path>; prints value (strings raw, bools true/false)
  python3 - "$1" "$2" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        value = json.load(handle)
except Exception:
    print("unreadable")
    raise SystemExit
for part in sys.argv[2].split("."):
    value = value.get(part) if isinstance(value, dict) else None
if value is None:
    print("null")
elif value is True:
    print("true")
elif value is False:
    print("false")
else:
    print(value)
PY
}
expect_json() { # expect_json <name> <file> <path> <expected>
  local got
  got="$(json_get "$2" "$3")"
  check "$1" "$([ "$got" = "$4" ] && echo 0 || echo 1)" "want=$4 got=$got"
}

# --------------------------------------------------------------------------
# Fixture repository: origin with merged C1, C2, C4 and unmerged C3
# --------------------------------------------------------------------------
export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@test
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@test
ORIGIN="$FIX/origin.git"
WORK="$FIX/work"
CLONE="$FIX/repo"
git init --bare -q --initial-branch=main "$ORIGIN"
git init -q --initial-branch=main "$WORK"
git -C "$WORK" remote add origin "$ORIGIN"
echo one > "$WORK/a.txt"
# Base versions of the files the pre-install review classifies (S10-S12).
mkdir -p "$WORK/apps/api/src" "$WORK/apps/executor-broker/src" "$WORK/deploy/helpers" "$WORK/deploy/sudoers" \
  "$WORK/.github/workflows" "$WORK/test"
cat > "$WORK/apps/api/src/hermes-security.ts" <<'FIXTURE'
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function signEnvelope(unsigned: Record<string, unknown>, signingSecret: string): string {
  return createHmac("sha256", signingSecret).update(JSON.stringify(unsigned)).digest("hex");
}

export function verifyExecutionEnvelopeSignature(envelope: { digest: string }, signingSecret: string): boolean {
  const { digest, ...unsigned } = envelope;
  const expected = signEnvelope(unsigned, signingSecret);
  if (!/^[a-f0-9]{64}$/.test(digest)) return false;
  return timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(expected, "hex"));
}

export function normalizeEvidence(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
FIXTURE
cat > "$WORK/apps/executor-broker/src/index.mjs" <<'FIXTURE'
import { createHmac } from "node:crypto";
const secret = process.env.SECRET || "";
function signature(payload) { return createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex"); }
export function validateRequest(value) {
  if (!value || typeof value.signature !== "string") throw new Error("invalid signed request");
  if (value.signature !== signature(value.payload)) throw new Error("invalid request signature");
  return value.payload;
}
// fixture padding so the execute() hunk stays separate
// fixture padding
// fixture padding
// fixture padding
// fixture padding
// fixture padding
// fixture padding
export function execute(payload) {
  return { ok: true, action: payload.action };
}
FIXTURE
cat > "$WORK/deploy/helpers/cockpit-capability-action" <<'FIXTURE'
#!/usr/bin/node
function fail(message) { process.stderr.write(message); process.exit(64); }
function verifyEnvelope(envelope) {
  if (!envelope || typeof envelope.digest !== "string") fail("invalid execution envelope");
  return true;
}
verifyEnvelope(JSON.parse("{}"));
FIXTURE
echo 'echo fixture self-update helper' > "$WORK/deploy/helpers/cockpit-self-update-action"
echo 'cockpit-executor ALL=(root) NOPASSWD: /usr/local/sbin/cockpit-service-action *' > "$WORK/deploy/sudoers/cockpit-executor"
echo 'Defaults:wgops !requiretty' > "$WORK/deploy/sudoers/wireguard-ops-cockpit"
echo 'export const port = 3001;' > "$WORK/apps/api/src/app.ts"
printf '{\n  "name": "fixture",\n  "dependencies": {}\n}\n' > "$WORK/package.json"
cat > "$WORK/package-lock.json" <<'FIXTURE'
{
  "name": "fixture",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "name": "fixture"
    }
  }
}
FIXTURE
printf 'name: ci\non: push\n' > "$WORK/.github/workflows/ci.yml"
echo 'exit 0' > "$WORK/test/example.test.sh"
echo 'fixture readme' > "$WORK/README.md"
git -C "$WORK" add -A && git -C "$WORK" commit -qm "C1 initial"
git -C "$WORK" push -q origin main
echo two > "$WORK/b.txt"
git -C "$WORK" add b.txt && git -C "$WORK" commit -qm "C2 merged"
git -C "$WORK" push -q origin main
git -C "$WORK" checkout -qb feat
echo three > "$WORK/c.txt"
git -C "$WORK" add c.txt && git -C "$WORK" commit -qm "C3 unmerged"
git -C "$WORK" push -q origin feat
git -C "$WORK" checkout -q main
echo four > "$WORK/d.txt"
git -C "$WORK" add d.txt && git -C "$WORK" commit -qm "C4 merged"
git -C "$WORK" push -q origin main
C1="$(git -C "$WORK" rev-parse main~2)"
C2="$(git -C "$WORK" rev-parse main~1)"
C4="$(git -C "$WORK" rev-parse main)"
C3="$(git -C "$WORK" rev-parse feat)"
git clone -q "$ORIGIN" "$CLONE"

# Like a real deployment: the state file already exists (written by the
# reviewed deploy script of the last rollout) before the first self-update.
mkdir -p "$FIX/state"
cat > "$FIX/state/state.json" <<EOF
{"version":1,"deployed_commit":"$C1","previous_commit":null,"updated_at":"2026-09-25T17:00:00Z","updated_by":"manual-rollout","web_url":"https://10.0.0.5:18181","activation":{"status":"synchronous","checked_at":"2026-09-25T17:00:00Z"}}
EOF

# --------------------------------------------------------------------------
# Stub tools and fixture scripts
# --------------------------------------------------------------------------
mkdir -p "$FIX/bin" "$FIX/state" "$FIX/logs"

cat > "$FIX/bin/systemctl" <<EOF
#!/bin/bash
# fixture stub: simulates systemctl for helper + runner. "start" of the
# self-update deploy unit executes the runner like the real unit would.
case "\${1:-}" in
  reset-failed) exit 0 ;;
  start)
    unit="\${2:-}"
    instance="\${unit#wireguard-ops-cockpit-self-update@}"
    instance="\${instance%.service}"
    [ -n "\$instance" ] && [ "\$instance" != "\$unit" ] || exit 1
    echo "start: \$unit" >> "$FIX/record.log"
    # like the real unit: the runner's output goes to the journal, not to the
    # caller's stdout; the helper reads the result file afterwards.
    exec "\$COCKPIT_SELF_UPDATE_RUN_PATH" deploy "\$instance" >> "$FIX/unit.log" 2>&1
    ;;
  restart)
    echo "restart: \$*" >> "$FIX/record.log"
    exit "\${FIX_RESTART_RC:-0}"
    ;;
  is-active) exit "\${FIX_ISACTIVE_RC:-0}" ;;
  show) echo "Thu 2026-09-25 18:00:00 UTC"; exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod 755 "$FIX/bin/systemctl"

cat > "$FIX/bin/systemd-run" <<EOF
#!/bin/bash
echo "systemd-run: \$*" >> "$FIX/record.log"
# --pipe (the review diff unit): run the command in place like the transient
# unit would, output and exit code included. Otherwise (activation timer):
# record only.
for arg in "\$@"; do
  if [ "\$arg" = "--pipe" ]; then
    while [ "\$#" -gt 0 ] && [ "\${1#--}" != "\$1" ]; do shift; done
    exec "\$@"
  fi
done
exit "\${FIX_SYSTEMDRUN_RC:-0}"
EOF
chmod 755 "$FIX/bin/systemd-run"

cat > "$FIX/bin/curl" <<'EOF'
#!/bin/bash
# fixture stub: canned answers for the health checks; "-w %{http_code}" mode
# prints a status code, body mode prints the payload for health URLs.
url=""
want_code="no"
for a in "$@"; do
  case "$a" in
    '%{http_code}') want_code="yes" ;;
    http://*|https://*) url="$a" ;;
  esac
done
code="${FIX_CURL_CODE:-200}"
body='{"ok":true}'
case "$url" in
  *badapi*) body='{"ok":false}' ;;
  *badweb*) code=500 ;;
esac
if [ "$want_code" = "yes" ]; then echo "$code"; exit 0; fi
[ "$code" = "200" ] || exit 22
printf '%s' "$body"
EOF
chmod 755 "$FIX/bin/curl"

cat > "$FIX/bin/ip" <<'EOF'
#!/bin/bash
# fixture stub: reports a WireGuard address unless the test hides it.
echo "1: lo    inet 127.0.0.1/8 scope host lo"
if [ "${FIX_WG_PRESENT:-1}" = "1" ]; then
  echo "2: wg0   inet ${FIX_WG_IP:-10.0.0.5}/24 scope global wg0"
fi
EOF
chmod 755 "$FIX/bin/ip"

cat > "$FIX/write-state.py" <<'EOF'
import json
import os
import sys

fix = os.environ["DEPLOY_FIX"]
sha = sys.argv[1]
path = os.path.join(fix, "state", "state.json")
try:
    with open(path, "r", encoding="utf-8") as handle:
        old = json.load(handle)
except Exception:
    old = {}
previous = old.get("previous_commit")
if old.get("deployed_commit") and old.get("deployed_commit") != sha:
    previous = old.get("deployed_commit")
state = {
    "version": 1, "deployed_commit": sha, "previous_commit": previous,
    "updated_at": "2026-09-25T18:00:00Z", "updated_by": "self-update",
    "web_url": "https://10.0.0.5:18181", "activation": {"status": "pending"},
}
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as handle:
    json.dump(state, handle, sort_keys=True)
os.replace(tmp, path)
EOF
chmod 644 "$FIX/write-state.py"

make_deploy() { # make_deploy <path> <mode: ok|bad|slow>
  cat > "$1" <<EOF
#!/bin/bash
# fixture deploy script (mode=$2): mimics the reviewed deploy script contract.
set -euo pipefail
echo "deploy-call commit=\${REPO_COMMIT:-} restart_mode=\${COCKPIT_RESTART_MODE:-} source=\${COCKPIT_SELF_UPDATE_SOURCE:-}" >> "$FIX/invocations.log"
if [ "\${COCKPIT_RESTART_MODE:-}" != "defer" ] && [ "$2" = "ok" ]; then
  echo "deploy-call without deferred restarts" >> "$FIX/invocations.log"
fi
EOF
  case "$2" in
    ok)
      cat >> "$1" <<EOF
git -C "$CLONE" checkout --quiet --detach "\${REPO_COMMIT}"
DEPLOY_FIX="$FIX" python3 "$FIX/write-state.py" "\${REPO_COMMIT}"
exit 0
EOF
      ;;
    slow)
      cat >> "$1" <<EOF
sleep "\${DEPLOY_SLEEP:-2}"
git -C "$CLONE" checkout --quiet --detach "\${REPO_COMMIT}"
DEPLOY_FIX="$FIX" python3 "$FIX/write-state.py" "\${REPO_COMMIT}"
exit 0
EOF
      ;;
    bad)
      cat >> "$1" <<'EOF'
exit 7
EOF
      ;;
  esac
  chmod 755 "$1"
}
make_deploy "$FIX/deploy-ok.sh" ok
make_deploy "$FIX/deploy-bad.sh" bad
make_deploy "$FIX/deploy-slow.sh" slow

# Real unix sockets for the sockets check (bound by a sleeper process).
cat > "$FIX/mksock.py" <<'EOF'
import socket
import sys
import time

for path in sys.argv[2:]:
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    server.listen(1)
time.sleep(int(sys.argv[1]))
EOF
python3 "$FIX/mksock.py" 600 "$FIX/sock-a.sock" "$FIX/sock-b.sock" &
SOCK_PID=$!
sleep 0.5

# --------------------------------------------------------------------------
# Module environment (all hooks; production defaults are never touched)
# --------------------------------------------------------------------------
export COCKPIT_SELF_UPDATE_REPO_DIR="$CLONE"
export COCKPIT_SELF_UPDATE_DEPLOY_SH="$FIX/deploy-ok.sh"
export COCKPIT_SELF_UPDATE_STATE_DIR="$FIX/state"
export COCKPIT_SELF_UPDATE_LOG_DIR="$FIX/logs"
export COCKPIT_SELF_UPDATE_SYSTEMCTL="$FIX/bin/systemctl"
export COCKPIT_SELF_UPDATE_SYSTEMD_RUN="$FIX/bin/systemd-run"
export COCKPIT_SELF_UPDATE_CURL="$FIX/bin/curl"
export COCKPIT_SELF_UPDATE_IP="$FIX/bin/ip"
export COCKPIT_SELF_UPDATE_ALLOWED_REMOTE="$ORIGIN"
export COCKPIT_SELF_UPDATE_ACTIVATION_DELAY="1"
export COCKPIT_SELF_UPDATE_VERIFY_RETRIES="2"
export COCKPIT_SELF_UPDATE_VERIFY_DELAY="1"
export COCKPIT_SELF_UPDATE_SERVICES="fixture-svc-a fixture-svc-b"
export COCKPIT_SELF_UPDATE_SOCKETS="$FIX/sock-a.sock $FIX/sock-b.sock"
export COCKPIT_SELF_UPDATE_RUN_PATH="$RUNNER"
export COCKPIT_SELF_UPDATE_WG_IP="10.0.0.5"
export COCKPIT_SELF_UPDATE_API_HEALTH_URL="http://127.0.0.1:3001/api/health"
export COCKPIT_SELF_UPDATE_TTYD_URL="http://127.0.0.1:7681/terminal/"
export DEPLOY_FIX="$FIX"
export FIX

echo "== cockpit self-update — Offline-Simulation =="
echo "Helper: $HELPER"
echo "Runner: $RUNNER"
echo "Fixture: $FIX"
echo

review_hash() { # review_hash <sha> <out-file>; runs the helper's diff form, prints diffSha256
  "$HELPER" diff "$1" > "$2" 2> "$2.err" || true
  json_get "$2" diffSha256
}
file_sum() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }
ZERO_HASH="$(printf '0%.0s' $(seq 1 64))"

# --------------------------------------------------------------------------
# S1: happy path — review diff C1..C2, update to C2 with the reviewed hash,
# pre-activation verify, scheduled activation, then run the activation (as
# the timer unit would) and check the outcome.
# --------------------------------------------------------------------------
echo "--- S1: happy path (C2)"
: > "$FIX/record.log"
"$HELPER" diff "$C2" > "$FIX/s1-diff.out" 2> "$FIX/s1-diff.err"
rc=$?
check "S1 diff rc=0" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)" "rc=$rc stderr=$(head -c 300 "$FIX/s1-diff.err")"
expect_json "S1 diff base=C1 (state)" "$FIX/s1-diff.out" "base" "$C1"
expect_json "S1 diff sha=C2" "$FIX/s1-diff.out" "sha" "$C2"
check "S1 diff ran as a transient piped unit" \
  "$(grep -q -- "systemd-run: --wait --pipe --collect --quiet --unit=wireguard-ops-cockpit-self-update-diff-" "$FIX/record.log" && echo 0 || echo 1)" \
  "$(cat "$FIX/record.log" 2>/dev/null)"
H2="$(json_get "$FIX/s1-diff.out" diffSha256)"
: > "$FIX/record.log"
: > "$FIX/invocations.log"
"$HELPER" "$C2" "$H2" > "$FIX/s1.out" 2> "$FIX/s1.err"
rc=$?
check "S1 helper rc=0" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)" "rc=$rc stderr=$(head -c 300 "$FIX/s1.err")"
expect_json "S1 stdout ok:true" "$FIX/s1.out" "ok" "true"
expect_json "S1 stdout sha=C2" "$FIX/s1.out" "sha" "$C2"
expect_json "S1 stdout phase=awaiting-activation" "$FIX/s1.out" "phase" "awaiting-activation"
expect_json "S1 stdout activation scheduled" "$FIX/s1.out" "activation.status" "scheduled"
expect_json "S1 result file sha=C2" "$FIX/state/last-result.json" "sha" "$C2"
expect_json "S1 result verification ok" "$FIX/state/last-result.json" "verification.api_health" "ok"
expect_json "S1 result web ok" "$FIX/state/last-result.json" "verification.web" "ok"
expect_json "S1 result review matched" "$FIX/state/last-result.json" "review.match" "true"
expect_json "S1 result review base=C1" "$FIX/state/last-result.json" "review.base" "$C1"
expect_json "S1 state deployed=C2" "$FIX/state/state.json" "deployed_commit" "$C2"
expect_json "S1 state previous=C1" "$FIX/state/state.json" "previous_commit" "$C1"
check "S1 unit instance carries the reviewed hash" \
  "$(grep -q "start: wireguard-ops-cockpit-self-update@$C2-$H2.service" "$FIX/record.log" && echo 0 || echo 1)" \
  "$(cat "$FIX/record.log" 2>/dev/null)"
check "S1 deploy ran with REPO_COMMIT=C2 and defer" \
  "$(grep -q "deploy-call commit=$C2 restart_mode=defer source=self-update" "$FIX/invocations.log" && echo 0 || echo 1)" \
  "$(cat "$FIX/invocations.log" 2>/dev/null)"
check "S1 activation scheduled via systemd-run" \
  "$(grep -q "systemd-run:.*activate $C2" "$FIX/record.log" && echo 0 || echo 1)" \
  "$(cat "$FIX/record.log" 2>/dev/null)"
check "S1 no service restart before activation" \
  "$(grep -q "restart:" "$FIX/record.log" && echo 1 || echo 0)" ""

"$RUNNER" activate "$C2" > "$FIX/s1-act.out" 2>&1
arc=$?
check "S1 activate rc=0" "$([ "$arc" -eq 0 ] && echo 0 || echo 1)" "rc=$arc $(head -c 300 "$FIX/s1-act.out")"
check "S1 activate restarted the services" \
  "$(grep -q "restart: restart fixture-svc-a fixture-svc-b" "$FIX/record.log" && echo 0 || echo 1)" \
  "$(cat "$FIX/record.log" 2>/dev/null)"
expect_json "S1 state activation ok" "$FIX/state/state.json" "activation.status" "ok"
expect_json "S1 result activation ok" "$FIX/state/last-result.json" "activation.status" "ok"
expect_json "S1 result phase=activated" "$FIX/state/last-result.json" "phase" "activated"

# --------------------------------------------------------------------------
# S2: usage refusals (helper argument form); nothing reaches the deploy script
# --------------------------------------------------------------------------
echo "--- S2: usage refusals"
: > "$FIX/invocations.log"
"$HELPER" > /dev/null 2> "$FIX/s2.err"; rc=$?
check "S2 no argument -> 64" "$([ "$rc" -eq 64 ] && echo 0 || echo 1)" "rc=$rc"
"$HELPER" status extra > /dev/null 2> "$FIX/s2.err"; rc=$?
check "S2 status with extra argument -> 64" "$([ "$rc" -eq 64 ] && echo 0 || echo 1)" "rc=$rc"
"$HELPER" abc123 > /dev/null 2> "$FIX/s2.err"; rc=$?
check "S2 short sha -> 65" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc"
"$HELPER" "$(printf '%s' "$C2" | tr '[:lower:]' '[:upper:]')" "$H2" > /dev/null 2> "$FIX/s2.err"; rc=$?
check "S2 uppercase sha -> 65" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc"
"$HELPER" --help > /dev/null 2> "$FIX/s2.err"; rc=$?
check "S2 option form -> 64" "$([ "$rc" -eq 64 ] && echo 0 || echo 1)" "rc=$rc"
"$HELPER" "$C4" > /dev/null 2> "$FIX/s2.err"; rc=$?
check "S2 bare sha (unreviewed update) -> 65" \
  "$([ "$rc" -eq 65 ] && grep -q "unreviewed update refused" "$FIX/s2.err" && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s2.err")"
"$HELPER" "$C4" "$(printf '%s' "$H2" | tr '[:lower:]' '[:upper:]')" > /dev/null 2> "$FIX/s2.err"; rc=$?
check "S2 uppercase diff hash -> 65" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc"
"$HELPER" "$C4" "${H2:0:63}" > /dev/null 2> "$FIX/s2.err"; rc=$?
check "S2 short diff hash -> 65" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc"
"$HELPER" "$C4" "$H2" extra > /dev/null 2> "$FIX/s2.err"; rc=$?
check "S2 update with extra argument -> 64" "$([ "$rc" -eq 64 ] && echo 0 || echo 1)" "rc=$rc"
"$HELPER" diff > /dev/null 2> "$FIX/s2.err"; rc=$?
check "S2 diff without sha -> 64" "$([ "$rc" -eq 64 ] && echo 0 || echo 1)" "rc=$rc"
"$HELPER" diff "$C4" extra > /dev/null 2> "$FIX/s2.err"; rc=$?
check "S2 diff with extra argument -> 64" "$([ "$rc" -eq 64 ] && echo 0 || echo 1)" "rc=$rc"
"$HELPER" diff abc123 > /dev/null 2> "$FIX/s2.err"; rc=$?
check "S2 diff short sha -> 65" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc"
check "S2 no deploy script call" "$([ -s "$FIX/invocations.log" ] && echo 1 || echo 0)" "$(cat "$FIX/invocations.log")"

# --------------------------------------------------------------------------
# S3: unmerged commit refused (merged review chains only), also for diff
# --------------------------------------------------------------------------
echo "--- S3: unmerged commit"
"$HELPER" "$C3" "$ZERO_HASH" > /dev/null 2> "$FIX/s3.err"; rc=$?
check "S3 helper rc=65" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s3.err")"
expect_json "S3 result code=65" "$FIX/state/last-result.json" "code" "65"
expect_json "S3 result phase=check" "$FIX/state/last-result.json" "phase" "check"
expect_json "S3 state deployed unchanged (C2)" "$FIX/state/state.json" "deployed_commit" "$C2"
before="$(file_sum "$FIX/state/last-result.json")"
"$HELPER" diff "$C3" > /dev/null 2> "$FIX/s3-diff.err"; rc=$?
check "S3 diff of unmerged commit -> 65" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s3-diff.err")"
check "S3 refused diff leaves last-result untouched" "$([ "$before" = "$(file_sum "$FIX/state/last-result.json")" ] && echo 0 || echo 1)" ""

# --------------------------------------------------------------------------
# S4: deploy script failure (rc=7) -> 69, state of the last good stand stays
# --------------------------------------------------------------------------
echo "--- S4: deploy failure"
H4="$(review_hash "$C4" "$FIX/s4-diff.out")"
: > "$FIX/record.log"
COCKPIT_SELF_UPDATE_DEPLOY_SH="$FIX/deploy-bad.sh" "$HELPER" "$C4" "$H4" > /dev/null 2> "$FIX/s4.err"; rc=$?
check "S4 helper rc=69" "$([ "$rc" -eq 69 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s4.err")"
expect_json "S4 result phase=deploy" "$FIX/state/last-result.json" "phase" "deploy"
expect_json "S4 result deploy exit_code=7" "$FIX/state/last-result.json" "deploy.exit_code" "7"
expect_json "S4 state deployed unchanged (C2)" "$FIX/state/state.json" "deployed_commit" "$C2"
expect_json "S4 rollback reference = C2" "$FIX/state/last-result.json" "previous_commit" "$C2"
check "S4 no activation scheduled" "$(grep -q "systemd-run:.*activate" "$FIX/record.log" && echo 1 || echo 0)" ""

# --------------------------------------------------------------------------
# S5: pre-activation verification failure -> 68, activation stays unscheduled
# --------------------------------------------------------------------------
echo "--- S5: verification failure"
: > "$FIX/record.log"
COCKPIT_SELF_UPDATE_API_HEALTH_URL="http://127.0.0.1:3001/api/health-badapi" "$HELPER" "$C4" "$H4" > /dev/null 2> "$FIX/s5.err"; rc=$?
check "S5 helper rc=68" "$([ "$rc" -eq 68 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s5.err")"
expect_json "S5 result phase=verify" "$FIX/state/last-result.json" "phase" "verify"
expect_json "S5 state activation not-activated" "$FIX/state/state.json" "activation.status" "not-activated"
expect_json "S5 rollback reference = C2" "$FIX/state/last-result.json" "previous_commit" "$C2"
check "S5 no activation scheduled" "$(grep -q "systemd-run:.*activate" "$FIX/record.log" && echo 1 || echo 0)" ""

# --------------------------------------------------------------------------
# S6: concurrency — second attempt while one is running -> 66
# (S5's deploy script already recorded C4, so the reviewed diff is C4..C4.)
# --------------------------------------------------------------------------
echo "--- S6: concurrency"
H6="$(review_hash "$C4" "$FIX/s6-diff.out")"
: > "$FIX/invocations.log"
DEPLOY_SLEEP=3 COCKPIT_SELF_UPDATE_DEPLOY_SH="$FIX/deploy-slow.sh" "$HELPER" "$C4" "$H6" > "$FIX/s6a.out" 2>&1 &
BG=$!
sleep 1
COCKPIT_SELF_UPDATE_DEPLOY_SH="$FIX/deploy-slow.sh" "$HELPER" "$C1" "$ZERO_HASH" > /dev/null 2> "$FIX/s6b.err"; rc=$?
wait "$BG"
check "S6 second attempt -> 66" "$([ "$rc" -eq 66 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s6b.err")"
expect_json "S6 first attempt completed ok" "$FIX/s6a.out" "ok" "true"

# --------------------------------------------------------------------------
# S7: deploy script permission refusal -> 67
# --------------------------------------------------------------------------
echo "--- S7: deploy script permissions"
chmod 777 "$FIX/deploy-ok.sh"
"$HELPER" "$C4" "$H6" > /dev/null 2> "$FIX/s7.err"; rc=$?
chmod 755 "$FIX/deploy-ok.sh"
check "S7 world-writable deploy script -> 67" "$([ "$rc" -eq 67 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s7.err")"

# --------------------------------------------------------------------------
# S8: origin mismatch (allowlisted repository only) -> 65
# --------------------------------------------------------------------------
echo "--- S8: origin mismatch"
COCKPIT_SELF_UPDATE_ALLOWED_REMOTE="$FIX/other.git" "$HELPER" "$C4" "$H6" > /dev/null 2> "$FIX/s8.err"; rc=$?
check "S8 foreign origin -> 65" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s8.err")"
COCKPIT_SELF_UPDATE_ALLOWED_REMOTE="$FIX/other.git" "$HELPER" diff "$C4" > /dev/null 2> "$FIX/s8-diff.err"; rc=$?
check "S8 diff with foreign origin -> 65" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s8-diff.err")"

# --------------------------------------------------------------------------
# S9: status (read-only) after the runs above
# --------------------------------------------------------------------------
echo "--- S9: status"
"$HELPER" status > "$FIX/s9.out" 2> "$FIX/s9.err"; rc=$?
check "S9 status rc=0" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s9.err")"
expect_json "S9 status ok:true" "$FIX/s9.out" "ok" "true"
expect_json "S9 status has deployed_commit" "$FIX/s9.out" "deployed_commit" "$C4"
expect_json "S9 status lock=free" "$FIX/s9.out" "lock" "free"

# --------------------------------------------------------------------------
# Review fixture commits on origin/main:
#   C5 touches every focus-area kind except the update mechanism and the
#      broker validation, plus a large plain file (excerpt truncation);
#   C6 changes the update mechanism, validateRequest and verifyEnvelope.
# --------------------------------------------------------------------------
json_expr() { # json_expr <file> <python expression over d>; prints true/false
  python3 - "$1" "$2" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        d = json.load(handle)
    print("true" if eval(sys.argv[2], {"d": d}) else "false")
except Exception as exc:
    print("error: %s" % exc)
PY
}
expect_true() { # expect_true <name> <file> <python expression over d>
  local got
  got="$(json_expr "$2" "$3")"
  check "$1" "$([ "$got" = "true" ] && echo 0 || echo 1)" "$3 -> $got"
}
area() { printf "[a for a in d['focusAreas'] if a['kind'] == '%s']" "$1"; }

sed -i 's/JSON.stringify(value)).digest/JSON.stringify(value ?? null)).digest/' "$WORK/apps/api/src/hermes-security.ts"
sed -i 's/if (!\/^\[a-f0-9\]{64}\$\/.test(digest)) return false;/if (!\/^[a-f0-9]{64}$\/.test(digest)) return true;/' "$WORK/apps/api/src/hermes-security.ts"
sed -i 's/return { ok: true, action: payload.action };/return { ok: true, action: payload.action, via: "fixture" };/' "$WORK/apps/executor-broker/src/index.mjs"
echo '#includedir /tmp/evil' >> "$WORK/deploy/sudoers/cockpit-executor"
echo '# comment only' >> "$WORK/deploy/sudoers/wireguard-ops-cockpit"
echo 'export const host = "127.0.0.1";' >> "$WORK/apps/api/src/app.ts"
printf '{\n  "name": "fixture",\n  "dependencies": {\n    "left-pad": "^1.3.0"\n  }\n}\n' > "$WORK/package.json"
cat > "$WORK/package-lock.json" <<'FIXTURE'
{
  "name": "fixture",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "name": "fixture"
    },
    "node_modules/evil-pkg": {
      "version": "0.0.1",
      "resolved": "git+https://example.invalid/evil.git",
      "hasInstallScript": true
    },
    "node_modules/left-pad": {
      "version": "1.3.0",
      "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz"
    }
  }
}
FIXTURE
printf 'name: ci\non: [push, pull_request]\n' > "$WORK/.github/workflows/ci.yml"
git -C "$WORK" rm -q test/example.test.sh
echo 'fixture readme, second edition' > "$WORK/README.md"
mkdir -p "$WORK/docs"
python3 -c "print('\n'.join('line %06d of the large plain fixture document' % i for i in range(6000)))" > "$WORK/docs/big.txt"
git -C "$WORK" add -A && git -C "$WORK" commit -qm "C5 review fixture"
git -C "$WORK" push -q origin main
C5="$(git -C "$WORK" rev-parse main)"
echo 'echo fixture self-update helper, changed' > "$WORK/deploy/helpers/cockpit-self-update-action"
sed -i '/if (value.signature !== signature(value.payload))/d' "$WORK/apps/executor-broker/src/index.mjs"
sed -i 's/fail("invalid execution envelope");/fail("invalid envelope");/' "$WORK/deploy/helpers/cockpit-capability-action"
git -C "$WORK" add -A && git -C "$WORK" commit -qm "C6 mechanism fixture"
git -C "$WORK" push -q origin main
C6="$(git -C "$WORK" rev-parse main)"

# --------------------------------------------------------------------------
# S10: review diff C4..C5 — hash, focus areas, excerpt order and bounds;
# read-only (no state, result or deploy change)
# --------------------------------------------------------------------------
echo "--- S10: review diff (focus areas)"
: > "$FIX/record.log"
: > "$FIX/invocations.log"
state_before="$(file_sum "$FIX/state/state.json")"
result_before="$(file_sum "$FIX/state/last-result.json")"
"$HELPER" diff "$C5" > "$FIX/s10.out" 2> "$FIX/s10.err"; rc=$?
check "S10 diff rc=0" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s10.err")"
expect_json "S10 action=self.diff" "$FIX/s10.out" "action" "self.diff"
expect_json "S10 base=C4 (deployed)" "$FIX/s10.out" "base" "$C4"
expect_json "S10 baseSource=state" "$FIX/s10.out" "baseSource" "state"
expect_json "S10 sha=C5" "$FIX/s10.out" "sha" "$C5"
expect_json "S10 commit subject" "$FIX/s10.out" "commitSubject" "C5 review fixture"
want_hash="$(git -C "$CLONE" -c core.quotePath=true diff --no-color --no-ext-diff --no-textconv --no-renames --no-relative \
  --full-index --src-prefix=a/ --dst-prefix=b/ --unified=3 --inter-hunk-context=0 --diff-algorithm=myers \
  --indent-heuristic --submodule=short -O/dev/null "$C4" "$C5" -- | sha256sum | cut -d' ' -f1)"
expect_json "S10 diffSha256 = sha256 of the full diff" "$FIX/s10.out" "diffSha256" "$want_hash"
H5="$(json_get "$FIX/s10.out" diffSha256)"
check "S10 diff hash is stable" "$([ "$(review_hash "$C5" "$FIX/s10b.out")" = "$H5" ] && echo 0 || echo 1)" ""
expect_true "S10 sudoers addition (#includedir is a directive)" "$FIX/s10.out" \
  "[a['files'] for a in $(area sudoers-additions)] == [['deploy/sudoers/cockpit-executor']] and '#includedir /tmp/evil' in $(area sudoers-additions)[0]['hunks'][0]"
expect_true "S10 envelope signing hunk is precise" "$FIX/s10.out" \
  "len($(area envelope-signing)) == 1 and 'verifyExecutionEnvelopeSignature' in $(area envelope-signing)[0]['reason'] and len($(area envelope-signing)[0]['hunks']) == 1 and 'return true' in $(area envelope-signing)[0]['hunks'][0] and 'value ?? null' not in $(area envelope-signing)[0]['hunks'][0]"
expect_true "S10 no update-mechanism / broker-validation area" "$FIX/s10.out" \
  "not $(area update-mechanism) and not $(area broker-validation)"
expect_true "S10 file-level areas" "$FIX/s10.out" \
  "'apps/api/src/app.ts' in $(area approval-and-auth)[0]['files'] and 'apps/executor-broker/src/index.mjs' in $(area brokers-and-agents)[0]['files'] and 'deploy/sudoers/wireguard-ops-cockpit' in $(area root-helpers)[0]['files'] and $(area ci)[0]['files'] == ['.github/workflows/ci.yml'] and $(area tests-deleted)[0]['files'] == ['test/example.test.sh']"
expect_true "S10 dependencies: risky package first, lockfile summarized" "$FIX/s10.out" \
  "$(area dependencies)[0]['files'] == ['package.json'] and $(area dependencies)[0]['lockfiles'] == ['package-lock.json'] and $(area dependencies)[0]['packages'][0].startswith('+evil-pkg@0.0.1 (install script; source: git+https://example.invalid/evil.git') and '+left-pad@1.3.0' in $(area dependencies)[0]['packages']"
expect_true "S10 file classes" "$FIX/s10.out" \
  "{f['path']: (f['status'], f['class']) for f in d['files']}['test/example.test.sh'] == ('D', 'test-deleted') and {f['path']: f['class'] for f in d['files']}['package-lock.json'] == 'lockfile' and {f['path']: f['class'] for f in d['files']}['README.md'] == 'other' and {f['path']: f['class'] for f in d['files']}['apps/api/src/hermes-security.ts'] == 'focus-hunks'"
expect_true "S10 excerpt starts with a hunk-precise focus file" "$FIX/s10.out" \
  "d['excerpt'][0]['path'] == 'apps/api/src/hermes-security.ts' and d['excerpt'][0]['text'].startswith('diff --git a/apps/api/src/hermes-security.ts')"
expect_true "S10 excerpt bounded; big plain file cut, lockfile omitted" "$FIX/s10.out" \
  "d['truncated'] is True and d['partialFiles'] == ['docs/big.txt'] and d['omittedFiles'] == ['package-lock.json'] and d['excerpt'][-1]['path'] == 'docs/big.txt' and sum(len(x['text'].encode('utf-8')) for x in d['excerpt']) <= 200200"
check "S10 diff is read-only (state, result unchanged; no deploy)" \
  "$([ "$state_before" = "$(file_sum "$FIX/state/state.json")" ] && [ "$result_before" = "$(file_sum "$FIX/state/last-result.json")" ] && [ ! -s "$FIX/invocations.log" ] && echo 0 || echo 1)" ""
check "S10 diff unit is hardened" \
  "$(grep -q -- "--property=ProtectSystem=full --property=ProtectHome=read-only" "$FIX/record.log" && echo 0 || echo 1)" "$(head -c 300 "$FIX/record.log")"

# --------------------------------------------------------------------------
# S11: review diff C4..C6 — update mechanism, broker validation, verifyEnvelope
# --------------------------------------------------------------------------
echo "--- S11: review diff (mechanism and validation)"
"$HELPER" diff "$C6" > "$FIX/s11.out" 2> "$FIX/s11.err"; rc=$?
check "S11 diff rc=0" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s11.err")"
expect_true "S11 update-mechanism area" "$FIX/s11.out" \
  "[a['files'] for a in $(area update-mechanism)] == [['deploy/helpers/cockpit-self-update-action']] and 'changed' in $(area update-mechanism)[0]['hunks'][0]"
expect_true "S11 broker-validation area names validateRequest" "$FIX/s11.out" \
  "len($(area broker-validation)) == 1 and 'validateRequest' in $(area broker-validation)[0]['reason'] and 'value.signature !== signature' in $(area broker-validation)[0]['hunks'][0] and 'via: \"fixture\"' not in $(area broker-validation)[0]['hunks'][0]"
expect_true "S11 verifyEnvelope counts as envelope signing" "$FIX/s11.out" \
  "any(a['files'] == ['deploy/helpers/cockpit-capability-action'] and 'verifyEnvelope' in a['reason'] for a in $(area envelope-signing)) and 'deploy/helpers/cockpit-capability-action' in $(area capability-sandbox)[0]['files']"
H6="$(json_get "$FIX/s11.out" diffSha256)"

# --------------------------------------------------------------------------
# S12: reviewed-hash binding — mismatch refused before the deploy script,
# match deploys, a moved base invalidates an older review
# --------------------------------------------------------------------------
echo "--- S12: reviewed-hash binding"
: > "$FIX/invocations.log"
"$HELPER" "$C5" "$(printf 'f%.0s' $(seq 1 64))" > /dev/null 2> "$FIX/s12a.err"; rc=$?
check "S12 wrong hash -> 65" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s12a.err")"
expect_json "S12 wrong hash: phase=review" "$FIX/state/last-result.json" "phase" "review"
check "S12 wrong hash: clear mismatch error" "$(grep -q "reviewed diff mismatch" "$FIX/state/last-result.json" && echo 0 || echo 1)" "$(head -c 300 "$FIX/state/last-result.json")"
check "S12 wrong hash: deploy script not run" "$([ -s "$FIX/invocations.log" ] && echo 1 || echo 0)" "$(cat "$FIX/invocations.log")"
expect_json "S12 wrong hash: state unchanged (C4)" "$FIX/state/state.json" "deployed_commit" "$C4"
"$HELPER" "$C5" "$H5" > "$FIX/s12b.out" 2> "$FIX/s12b.err"; rc=$?
check "S12 reviewed hash -> deploy rc=0" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s12b.err")"
expect_json "S12 state deployed=C5" "$FIX/state/state.json" "deployed_commit" "$C5"
expect_json "S12 result review hash" "$FIX/state/last-result.json" "review.diff_sha256" "$H5"
: > "$FIX/invocations.log"
"$HELPER" "$C6" "$H6" > /dev/null 2> "$FIX/s12c.err"; rc=$?
check "S12 review from the old base (C4..C6) -> 65 after C5 landed" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s12c.err")"
check "S12 moved base: deploy script not run" "$([ -s "$FIX/invocations.log" ] && echo 1 || echo 0)" "$(cat "$FIX/invocations.log")"
H6B="$(review_hash "$C6" "$FIX/s12-diff.out")"
expect_json "S12 fresh review base=C5" "$FIX/s12-diff.out" "base" "$C5"
check "S12 fresh review hash differs" "$([ -n "$H6B" ] && [ "$H6B" != "$H6" ] && echo 0 || echo 1)" "old=$H6 new=$H6B"
"$HELPER" "$C6" "$H6B" > /dev/null 2> "$FIX/s12d.err"; rc=$?
check "S12 fresh review -> deploy rc=0" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s12d.err")"
expect_json "S12 state deployed=C6" "$FIX/state/state.json" "deployed_commit" "$C6"

# --------------------------------------------------------------------------
# S13: the runner itself refuses unreviewed or malformed targets
# --------------------------------------------------------------------------
echo "--- S13: runner refusals"
before="$(file_sum "$FIX/state/last-result.json")"
"$RUNNER" deploy "$C6" > /dev/null 2> "$FIX/s13.err"; rc=$?
check "S13 runner deploy <sha> (unreviewed) -> 65" \
  "$([ "$rc" -eq 65 ] && grep -q "unreviewed deploy refused" "$FIX/s13.err" && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s13.err")"
"$RUNNER" deploy "$C6-zz" > /dev/null 2> "$FIX/s13.err"; rc=$?
check "S13 runner deploy malformed instance -> 65" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc"
"$RUNNER" diff "$C3" > /dev/null 2> "$FIX/s13.err"; rc=$?
check "S13 runner diff unmerged -> 65" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s13.err")"
"$RUNNER" frobnicate "$C6" > /dev/null 2> "$FIX/s13.err"; rc=$?
check "S13 runner unknown command -> 64" "$([ "$rc" -eq 64 ] && echo 0 || echo 1)" "rc=$rc"
check "S13 refusals leave last-result untouched" "$([ "$before" = "$(file_sum "$FIX/state/last-result.json")" ] && echo 0 || echo 1)" ""

# --------------------------------------------------------------------------
# S14: no review diff while a deployment holds the run lock -> 66
# --------------------------------------------------------------------------
echo "--- S14: diff during a deployment"
flock -x "$FIX/state/run.lock" -c 'sleep 3' &
LOCKER=$!
sleep 0.5
"$HELPER" diff "$C6" > /dev/null 2> "$FIX/s14.err"; rc=$?
wait "$LOCKER"
check "S14 diff while run.lock is held -> 66" "$([ "$rc" -eq 66 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s14.err")"

# --------------------------------------------------------------------------
# S15: status reports the review of the last attempt
# --------------------------------------------------------------------------
echo "--- S15: status with review"
"$HELPER" status > "$FIX/s15.out" 2> "$FIX/s15.err"; rc=$?
check "S15 status rc=0" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)" "rc=$rc"
expect_json "S15 last attempt review hash" "$FIX/s15.out" "last_attempt.review.diff_sha256" "$H6B"

echo
echo "Gerüst: $FIX (wird beim Beenden entfernt)"
if [ "$FAIL" -eq 0 ]; then
  echo "ERGEBNIS: GRÜN — $PASS Prüfungen bestanden."
  exit 0
fi
echo "ERGEBNIS: ROT — $FAIL von $((PASS + FAIL)) Prüfungen fehlgeschlagen, $PASS bestanden."
exit 1
