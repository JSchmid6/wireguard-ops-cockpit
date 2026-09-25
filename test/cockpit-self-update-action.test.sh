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
# the runner exactly like wireguard-ops-cockpit-self-update@.service would.
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
git -C "$WORK" add a.txt && git -C "$WORK" commit -qm "C1 initial"
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
    sha="\${unit#wireguard-ops-cockpit-self-update@}"
    sha="\${sha%.service}"
    [ -n "\$sha" ] && [ "\$sha" != "\$unit" ] || exit 1
    # like the real unit: the runner's output goes to the journal, not to the
    # caller's stdout; the helper reads the result file afterwards.
    exec "\$COCKPIT_SELF_UPDATE_RUN_PATH" deploy "\$sha" >> "$FIX/unit.log" 2>&1
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

# --------------------------------------------------------------------------
# S1: happy path — update to C2, pre-activation verify, scheduled activation,
# then run the activation (as the timer unit would) and check the outcome.
# --------------------------------------------------------------------------
echo "--- S1: happy path (C2)"
: > "$FIX/record.log"
: > "$FIX/invocations.log"
"$HELPER" "$C2" > "$FIX/s1.out" 2> "$FIX/s1.err"
rc=$?
check "S1 helper rc=0" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)" "rc=$rc stderr=$(head -c 300 "$FIX/s1.err")"
expect_json "S1 stdout ok:true" "$FIX/s1.out" "ok" "true"
expect_json "S1 stdout sha=C2" "$FIX/s1.out" "sha" "$C2"
expect_json "S1 stdout phase=awaiting-activation" "$FIX/s1.out" "phase" "awaiting-activation"
expect_json "S1 stdout activation scheduled" "$FIX/s1.out" "activation.status" "scheduled"
expect_json "S1 result file sha=C2" "$FIX/state/last-result.json" "sha" "$C2"
expect_json "S1 result verification ok" "$FIX/state/last-result.json" "verification.api_health" "ok"
expect_json "S1 result web ok" "$FIX/state/last-result.json" "verification.web" "ok"
expect_json "S1 state deployed=C2" "$FIX/state/state.json" "deployed_commit" "$C2"
expect_json "S1 state previous=C1" "$FIX/state/state.json" "previous_commit" "$C1"
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
# S2: usage refusals (helper argument form)
# --------------------------------------------------------------------------
echo "--- S2: usage refusals"
"$HELPER" > /dev/null 2> "$FIX/s2.err"; rc=$?
check "S2 no argument -> 64" "$([ "$rc" -eq 64 ] && echo 0 || echo 1)" "rc=$rc"
"$HELPER" status extra > /dev/null 2> "$FIX/s2.err"; rc=$?
check "S2 status with extra argument -> 64" "$([ "$rc" -eq 64 ] && echo 0 || echo 1)" "rc=$rc"
"$HELPER" abc123 > /dev/null 2> "$FIX/s2.err"; rc=$?
check "S2 short sha -> 65" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc"
"$HELPER" "$(printf '%s' "$C2" | tr '[:lower:]' '[:upper:]')" > /dev/null 2> "$FIX/s2.err"; rc=$?
check "S2 uppercase sha -> 65" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc"
"$HELPER" --help > /dev/null 2> "$FIX/s2.err"; rc=$?
check "S2 option form -> 64" "$([ "$rc" -eq 64 ] && echo 0 || echo 1)" "rc=$rc"

# --------------------------------------------------------------------------
# S3: unmerged commit refused (merged review chains only)
# --------------------------------------------------------------------------
echo "--- S3: unmerged commit"
"$HELPER" "$C3" > /dev/null 2> "$FIX/s3.err"; rc=$?
check "S3 helper rc=65" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s3.err")"
expect_json "S3 result code=65" "$FIX/state/last-result.json" "code" "65"
expect_json "S3 result phase=check" "$FIX/state/last-result.json" "phase" "check"
expect_json "S3 state deployed unchanged (C2)" "$FIX/state/state.json" "deployed_commit" "$C2"

# --------------------------------------------------------------------------
# S4: deploy script failure (rc=7) -> 69, state of the last good stand stays
# --------------------------------------------------------------------------
echo "--- S4: deploy failure"
: > "$FIX/record.log"
COCKPIT_SELF_UPDATE_DEPLOY_SH="$FIX/deploy-bad.sh" "$HELPER" "$C4" > /dev/null 2> "$FIX/s4.err"; rc=$?
check "S4 helper rc=69" "$([ "$rc" -eq 69 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s4.err")"
expect_json "S4 result phase=deploy" "$FIX/state/last-result.json" "phase" "deploy"
expect_json "S4 result deploy exit_code=7" "$FIX/state/last-result.json" "deploy.exit_code" "7"
expect_json "S4 state deployed unchanged (C2)" "$FIX/state/state.json" "deployed_commit" "$C2"
expect_json "S4 rollback reference = C2" "$FIX/state/last-result.json" "previous_commit" "$C2"
check "S4 no activation scheduled" "$(grep -q "systemd-run:" "$FIX/record.log" && echo 1 || echo 0)" ""

# --------------------------------------------------------------------------
# S5: pre-activation verification failure -> 68, activation stays unscheduled
# --------------------------------------------------------------------------
echo "--- S5: verification failure"
: > "$FIX/record.log"
COCKPIT_SELF_UPDATE_API_HEALTH_URL="http://127.0.0.1:3001/api/health-badapi" "$HELPER" "$C4" > /dev/null 2> "$FIX/s5.err"; rc=$?
check "S5 helper rc=68" "$([ "$rc" -eq 68 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s5.err")"
expect_json "S5 result phase=verify" "$FIX/state/last-result.json" "phase" "verify"
expect_json "S5 state activation not-activated" "$FIX/state/state.json" "activation.status" "not-activated"
expect_json "S5 rollback reference = C2" "$FIX/state/last-result.json" "previous_commit" "$C2"
check "S5 no activation scheduled" "$(grep -q "systemd-run:" "$FIX/record.log" && echo 1 || echo 0)" ""

# --------------------------------------------------------------------------
# S6: concurrency — second attempt while one is running -> 66
# --------------------------------------------------------------------------
echo "--- S6: concurrency"
: > "$FIX/invocations.log"
DEPLOY_SLEEP=3 COCKPIT_SELF_UPDATE_DEPLOY_SH="$FIX/deploy-slow.sh" "$HELPER" "$C4" > "$FIX/s6a.out" 2>&1 &
BG=$!
sleep 1
COCKPIT_SELF_UPDATE_DEPLOY_SH="$FIX/deploy-slow.sh" "$HELPER" "$C1" > /dev/null 2> "$FIX/s6b.err"; rc=$?
wait "$BG"
check "S6 second attempt -> 66" "$([ "$rc" -eq 66 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s6b.err")"
expect_json "S6 first attempt completed ok" "$FIX/s6a.out" "ok" "true"

# --------------------------------------------------------------------------
# S7: deploy script permission refusal -> 67
# --------------------------------------------------------------------------
echo "--- S7: deploy script permissions"
chmod 777 "$FIX/deploy-ok.sh"
"$HELPER" "$C4" > /dev/null 2> "$FIX/s7.err"; rc=$?
chmod 755 "$FIX/deploy-ok.sh"
check "S7 world-writable deploy script -> 67" "$([ "$rc" -eq 67 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s7.err")"

# --------------------------------------------------------------------------
# S8: origin mismatch (allowlisted repository only) -> 65
# --------------------------------------------------------------------------
echo "--- S8: origin mismatch"
COCKPIT_SELF_UPDATE_ALLOWED_REMOTE="$FIX/other.git" "$HELPER" "$C4" > /dev/null 2> "$FIX/s8.err"; rc=$?
check "S8 foreign origin -> 65" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s8.err")"

# --------------------------------------------------------------------------
# S9: status (read-only) after the runs above
# --------------------------------------------------------------------------
echo "--- S9: status"
"$HELPER" status > "$FIX/s9.out" 2> "$FIX/s9.err"; rc=$?
check "S9 status rc=0" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 "$FIX/s9.err")"
expect_json "S9 status ok:true" "$FIX/s9.out" "ok" "true"
expect_json "S9 status has deployed_commit" "$FIX/s9.out" "deployed_commit" "$C4"
expect_json "S9 status lock=free" "$FIX/s9.out" "lock" "free"

echo
echo "Gerüst: $FIX (wird beim Beenden entfernt)"
if [ "$FAIL" -eq 0 ]; then
  echo "ERGEBNIS: GRÜN — $PASS Prüfungen bestanden."
  exit 0
fi
echo "ERGEBNIS: ROT — $FAIL von $((PASS + FAIL)) Prüfungen fehlgeschlagen, $PASS bestanden."
exit 1
