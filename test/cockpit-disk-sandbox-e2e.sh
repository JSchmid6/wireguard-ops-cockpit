#!/bin/bash
# ============================================================================
# cockpit-disk-sandbox-e2e.sh — End-to-End-Prüfung des Disk-Helfer-Pfads im
# echten Capability-Sandbox-Runner (Wegwerf-Container mit echtem systemd).
#
# Geprüft wird der AUSGELIEFERTE deploy/helpers/cockpit-capability-action:
#   1. Helfer-status läuft im Sandbox (statt exit 67 "/proc/mdstat is not readable")
#   2. remove/add/smart/smarttest werden VOR der Ausführung verweigert (nur der
#      typisierte Executor-Pfad darf mutieren bzw. direkt aufs Gerät zugreifen)
#   3. fremde Schritte bekommen weder COCKPIT_DISK_ACTION_MDSTAT noch /run/mdstat
#   4. ein deklariertes /proc/mdstat wird auf den neutralen Pfad normalisiert
#
# Aufruf (auf dem VPS-Host ODER in der Hermes-Shell):
#   bash test/cockpit-disk-sandbox-e2e.sh [out-dir]
#
# Ergebnis: Log unter <out-dir>/e2e-<zeitstempel>.log mit 9 PASS-Zeilen;
# Exit 0 = grün.
# Nichts am VPS oder an der Kiste wird verändert; der Container wird entfernt.
# ============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OUT="${1:-/opt/data/out/cockpit-disk-sandbox-e2e}"
TS="$(date +%Y%m%d-%H%M%S)"
NAME="wgoc-disksbx-$TS"
LOG="$OUT/e2e-$TS.log"

command -v docker >/dev/null 2>&1 || { echo "FEHLER: docker fehlt"; exit 2; }
[ -f "$HERE/cockpit-disk-sandbox-e2e-inner.sh" ] || { echo "FEHLER: $HERE/cockpit-disk-sandbox-e2e-inner.sh fehlt"; exit 2; }

# Container-Sicht -> Host-Sicht (auf dem VPS: /opt/data = /home/hermes/.hermes).
hostpath() {
  case "$1" in
    /opt/data)   printf '%s' "/home/hermes/.hermes" ;;
    /opt/data/*) printf '%s' "/home/hermes/.hermes${1#/opt/data}" ;;
    *)           printf '%s' "$1" ;;
  esac
}
OUT_HOST="$(hostpath "$OUT")"
REPO_HOST="$(hostpath "$REPO")"
mkdir -p "$OUT" "$OUT_HOST"

echo "== cockpit disk sandbox — E2E (Wegwerf-Container, echtes systemd) =="
echo "Repo:    $REPO"
echo "Ausgabe: $LOG"

docker rm -f "$NAME" >/dev/null 2>&1 || true
# Ubuntu 24.04 = systemd 255 wie auf Lab0/VPS; systemd-sysv + nodejs kommen nach.
# Der Entrypoint installiert zuerst und übergibt dann an systemd als PID 1.
docker run -d --name "$NAME" \
  --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /tmp \
  --mount "type=bind,source=$REPO_HOST,target=/pkg,readonly" \
  --mount "type=bind,source=$OUT_HOST,target=/out" \
  ubuntu:24.04 /bin/bash -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd-sysv nodejs >/dev/null 2>&1; exec /sbin/init' >>"$LOG" 2>&1
if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
  echo "FEHLER: Container $NAME startet nicht." | tee -a "$LOG"
  docker logs "$NAME" >>"$LOG" 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  exit 2
fi

# systemd bereit? (max ~2 Minuten; 'degraded' zählt als bereit)
state=""
for _ in $(seq 1 60); do
  state="$(docker exec "$NAME" systemctl is-system-running 2>/dev/null || true)"
  case "$state" in running|degraded) break ;; esac
  sleep 2
done
if [ "$state" != "running" ] && [ "$state" != "degraded" ]; then
  echo "FEHLER: systemd im Container nicht bereit (state=$state)." | tee -a "$LOG"
  docker logs "$NAME" >>"$LOG" 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  exit 2
fi

docker exec "$NAME" bash /pkg/test/cockpit-disk-sandbox-e2e-inner.sh >"$LOG" 2>&1
rc=$?
docker rm -f "$NAME" >/dev/null 2>&1 || true

echo "--- letzte 45 Zeilen ---"
tail -n 45 "$LOG"
echo "------------------------------------------------------------"
if [ "$rc" -eq 0 ]; then
  echo "E2E ERGEBNIS: GRUEN (rc=0) — Log: $LOG"
else
  echo "E2E ERGEBNIS: ROT (rc=$rc) — Log: $LOG"
fi
exit "$rc"
