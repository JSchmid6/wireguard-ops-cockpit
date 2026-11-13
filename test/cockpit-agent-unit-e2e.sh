#!/bin/bash
# ============================================================================
# cockpit-agent-unit-e2e.sh — Schreibgrenzen der Agent- und der Runner-Unit auf echtem systemd
# (Wegwerf-Container).
#
# Geprüft wird der AUSGELIEFERTE Stand:
#   deploy/systemd/wireguard-ops-cockpit-agent.service (Härtung, Schreibpfade)
#   deploy/systemd/wireguard-ops-cockpit-runner.service (eigene Identität, t_cb81637b)
#   deploy/lab0/homeserver-cockpit-deploy.sh, Blöcke agent-/runner-opencode-config
#
# In der Agent-Unit laufen die Plan-Rollen als cockpit-agent, der Runner mit den
# build-Werkzeugen als cockpit-runner in seiner eigenen Unit. Was eine Identität
# schreiben kann, lädt ihr nächster Lauf (opencode-Konfiguration, Agenten-
# Definitionen, AGENTS.md, .opencode); was der Runner von der Agent-Unit erreicht
# (Home, Arbeitsordner, Socket, Prozesse), lesen oder glauben Türsteher und Verifier.
# Der Test ersetzt nur ExecStart durch eine Probe und versucht als die Unit
# genau diese Schreibwege (Einzelheiten im Innenteil).
#
# Aufruf (auf dem VPS-Host ODER in der Hermes-Shell):
#   bash test/cockpit-agent-unit-e2e.sh [out-dir]
#
# Ergebnis: Log unter <out-dir>/e2e-agent-unit-<zeitstempel>.log; Exit 0 = grün.
# Nichts am VPS oder an Lab0 wird verändert; der Container wird entfernt.
# ============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OUT="${1:-/opt/data/out/cockpit-agent-unit-e2e}"
TS="$(date +%Y%m%d-%H%M%S)"
NAME="wgoc-agent-unit-$TS"
LOG="$OUT/e2e-agent-unit-$TS.log"

command -v docker >/dev/null 2>&1 || { echo "FEHLER: docker fehlt"; exit 2; }
[ -f "$HERE/cockpit-agent-unit-e2e-inner.sh" ] || { echo "FEHLER: $HERE/cockpit-agent-unit-e2e-inner.sh fehlt"; exit 2; }

# Container-Sicht -> Host-Sicht (auf dem VPS: /opt/data = /home/hermes/.hermes).
hostpath() {
  case "$1" in
    /opt/data)   printf '%s' "/home/hermes/.hermes" ;;
    /opt/data/*) printf '%s' "/home/hermes/.hermes${1#/opt/data}" ;;
    *)           printf '%s' "$1" ;;
  esac
}
# Ein anderer Daemon (Werkstatt) sieht den Klon unter einem eigenen Pfad, z. B. /austausch/<klon>.
REPO_HOST="${COCKPIT_E2E_REPO_HOST:-$(hostpath "$REPO")}"
mkdir -p "$OUT"

echo "== cockpit agent unit — E2E (Wegwerf-Container, echtes systemd) =="
echo "Repo:    $REPO"
echo "Ausgabe: $LOG"

docker rm -f "$NAME" >/dev/null 2>&1 || true
# Ubuntu 24.04 = systemd 255 wie auf Lab0/VPS.
docker run -d --name "$NAME" \
  --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /tmp \
  --mount "type=bind,source=$REPO_HOST,target=/pkg,readonly" \
  ubuntu:24.04 /bin/bash -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd-sysv util-linux python3 >/dev/null 2>&1; exec /sbin/init' >>"$LOG" 2>&1
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

docker exec "$NAME" bash /pkg/test/cockpit-agent-unit-e2e-inner.sh >"$LOG" 2>&1
rc=$?
docker rm -f "$NAME" >/dev/null 2>&1 || true

cat "$LOG"
echo "------------------------------------------------------------"
if [ "$rc" -eq 0 ]; then
  echo "E2E ERGEBNIS: GRUEN (rc=0) — Log: $LOG"
else
  echo "E2E ERGEBNIS: ROT (rc=$rc) — Log: $LOG"
fi
exit "$rc"
