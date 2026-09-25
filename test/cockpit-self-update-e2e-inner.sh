#!/bin/bash
# ============================================================================
# cockpit-self-update-e2e-inner.sh — läuft IM Wegwerf-Container (root, echtes
# systemd). Wird von test/cockpit-self-update-e2e.sh aufgerufen; bitte dort
# starten. Installiert das Modul an seine Produktionspfade, baut Fixtures
# (Repository, Deploy-Skript, Dienste, Sockets, Health-Server) an den echten
# Pfaden auf und fährt echte Selbst-Update-Läufe inklusive Aktivierung.
#
# Solange nichts anderes vermerkt ist, gelten die Produktionspfade — nur der
# erlaubte Remote und die Aktivierungs-/Verify-Zeiten kommen aus
# /etc/wireguard-ops-cockpit/self-update.env (Fixture-Origin statt GitHub).
# ============================================================================
set -u

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
jsonv() { # jsonv <file> <dotted.path>
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
  got="$(jsonv "$2" "$3")"
  check "$1" "$([ "$got" = "$4" ] && echo 0 || echo 1)" "want=$4 got=$got"
}
wait_for_activation() { # wait_for_activation <sha> <expected: ok|failed> [timeout]
  local deadline=$((SECONDS + ${3:-120})) status
  while [ "$SECONDS" -lt "$deadline" ]; do
    status="$(jsonv /var/lib/wireguard-ops-cockpit/self-update/state.json activation.status)"
    [ "$status" = "$2" ] && return 0
    sleep 2
  done
  echo "      (activation status: $(jsonv /var/lib/wireguard-ops-cockpit/self-update/state.json activation.status))" >&2
  return 1
}

echo "python3: $(python3 --version 2>&1)"
echo "systemd: $(systemctl --version | head -n1)"
echo "git:     $(git --version)"

# --------------------------------------------------------------------------
# 1) Modul an die Produktionspfade installieren (wie das Deploy-Skript)
# --------------------------------------------------------------------------
install -d -m 0755 /usr/local/lib/wireguard-ops-cockpit /usr/local/sbin
install -m 0755 /pkg/deploy/helpers/cockpit-self-update-action /usr/local/sbin/cockpit-self-update-action
install -m 0755 /pkg/deploy/helpers/cockpit-self-update-run /usr/local/lib/wireguard-ops-cockpit/cockpit-self-update-run
install -m 0644 /pkg/deploy/systemd/wireguard-ops-cockpit-self-update@.service /etc/systemd/system/
systemctl daemon-reload
check "Unit-Template ist geladen" "$(systemctl cat 'wireguard-ops-cockpit-self-update@.service' >/dev/null 2>&1 && echo 0 || echo 1)" ""

# --------------------------------------------------------------------------
# 2) Fixture-Repository (origin mit gemergten C1..C3, ungemergter C4)
# --------------------------------------------------------------------------
export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@test
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@test
git init --bare -q --initial-branch=main /srv/origin.git
git init -q --initial-branch=main /srv/work
git -C /srv/work remote add origin /srv/origin.git
echo one > /srv/work/a.txt && git -C /srv/work add a.txt && git -C /srv/work commit -qm "C1"
git -C /srv/work push -q origin main
echo two > /srv/work/b.txt && git -C /srv/work add b.txt && git -C /srv/work commit -qm "C2"
git -C /srv/work push -q origin main
echo three > /srv/work/c.txt && git -C /srv/work add c.txt && git -C /srv/work commit -qm "C3"
git -C /srv/work push -q origin main
git -C /srv/work checkout -qb feat && echo x > /srv/work/x.txt && git -C /srv/work add x.txt && git -C /srv/work commit -qm "C4 unmerged"
git -C /srv/work push -q origin feat
git -C /srv/work checkout -q main
C1="$(git -C /srv/work rev-parse main~2)"
C2="$(git -C /srv/work rev-parse main~1)"
C3="$(git -C /srv/work rev-parse main)"
C4="$(git -C /srv/work rev-parse feat)"
echo "C1=$C1 C2=$C2 C3=$C3 C4(unmerged)=$C4"

git clone -q /srv/origin.git /opt/wireguard-ops-cockpit
# Kein Netz im Container: der erlaubte Remote ist das lokale Fixture-Origin.
git -C /opt/wireguard-ops-cockpit remote set-url origin /srv/origin.git
git -C /opt/wireguard-ops-cockpit fetch -q origin
RU="$(git -C /opt/wireguard-ops-cockpit remote get-url origin)"
check "Fixture-Checkout mit erlaubtem Remote" "$([ "$RU" = "/srv/origin.git" ] && echo 0 || echo 1)" "get-url=$RU"

# Wie eine echte Installation: Zustandsverzeichnis und letzter Stand existieren
# bereits (das reviewed Deploy-Skript legt sie beim ersten Rollout an).
install -d -m 0750 /var/lib/wireguard-ops-cockpit/self-update
cat > /var/lib/wireguard-ops-cockpit/self-update/state.json <<EOF
{"version":1,"deployed_commit":"$C1","previous_commit":null,"updated_at":"2026-09-25T17:00:00Z","updated_by":"manual-rollout","web_url":"http://127.0.0.1:18181","activation":{"status":"synchronous","checked_at":"2026-09-25T17:00:00Z"}}
EOF

# --------------------------------------------------------------------------
# 3) Fixture-Deploy-Skript + Fixture-Config + Dienste + Sockets + Server
# --------------------------------------------------------------------------
cat > /usr/local/lib/wireguard-ops-cockpit/homeserver-cockpit-deploy.sh <<'EOF'
#!/bin/bash
# Fixture-Deploy (E2E): mimt das reviewed Deploy-Skript (Checkout-auf-Pin,
# Zustands-Schreiben, defer-Modus) ohne apt/npm/Build.
set -euo pipefail
echo "deploy-call commit=${REPO_COMMIT:-} restart_mode=${COCKPIT_RESTART_MODE:-} source=${COCKPIT_SELF_UPDATE_SOURCE:-}" >> /var/log/e2e-deploycalls.log
git -C /opt/wireguard-ops-cockpit checkout --quiet --detach "${REPO_COMMIT}"
python3 /usr/local/lib/wireguard-ops-cockpit/e2e-write-state.py "${REPO_COMMIT}"
exit 0
EOF
chmod 755 /usr/local/lib/wireguard-ops-cockpit/homeserver-cockpit-deploy.sh

cat > /usr/local/lib/wireguard-ops-cockpit/e2e-write-state.py <<'EOF'
import json
import os
import sys

sha = sys.argv[1]
path = "/var/lib/wireguard-ops-cockpit/self-update/state.json"
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
    "web_url": "http://127.0.0.1:18181", "activation": {"status": "pending"},
}
os.makedirs(os.path.dirname(path), mode=0o750, exist_ok=True)
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as handle:
    json.dump(state, handle, sort_keys=True)
os.replace(tmp, path)
EOF
chmod 644 /usr/local/lib/wireguard-ops-cockpit/e2e-write-state.py

install -d -m 0700 /etc/wireguard-ops-cockpit
cat > /etc/wireguard-ops-cockpit/self-update.env <<'EOF'
# E2E-Fixture: erlaubter Remote ist das lokale Origin; sonst Produktionspfade.
COCKPIT_SELF_UPDATE_ALLOWED_REMOTE=/srv/origin.git
COCKPIT_SELF_UPDATE_ACTIVATION_DELAY=5
COCKPIT_SELF_UPDATE_VERIFY_RETRIES=6
COCKPIT_SELF_UPDATE_VERIFY_DELAY=2
EOF

for svc in api agent executor ttyd; do
  cat > "/etc/systemd/system/wireguard-ops-cockpit-$svc.service" <<EOF
[Unit]
Description=e2e dummy $svc
[Service]
ExecStart=/usr/bin/sleep infinity
[Install]
WantedBy=multi-user.target
EOF
done
systemctl daemon-reload
systemctl enable --now wireguard-ops-cockpit-api wireguard-ops-cockpit-agent wireguard-ops-cockpit-executor wireguard-ops-cockpit-ttyd >/dev/null 2>&1
sleep 1
check "Fixture-Dienste aktiv" "$(systemctl is-active --quiet wireguard-ops-cockpit-api && echo 0 || echo 1)" ""

install -d -m 0755 /run/cockpit-agent /run/cockpit-executor
cat > /root/mksock.py <<'EOF'
import socket
import sys
import time

for path in sys.argv[2:]:
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    server.listen(1)
time.sleep(int(sys.argv[1]))
EOF
python3 /root/mksock.py 3600 /run/cockpit-agent/agent.sock /run/cockpit-executor/executor.sock &
echo $! > /root/mksock.pid
sleep 0.5
check "Fixture-Broker-Sockets vorhanden" "$([ -S /run/cockpit-agent/agent.sock ] && [ -S /run/cockpit-executor/executor.sock ] && echo 0 || echo 1)" ""

cat > /root/e2e-servers.py <<'EOF'
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def serve(port, body):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            data = body.encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


threading.Thread(target=serve, args=(3001, '{"ok":true}'), daemon=True).start()
threading.Thread(target=serve, args=(7681, 'ttyd'), daemon=True).start()
threading.Thread(target=serve, args=(18181, '{"ok":true}'), daemon=True).start()
threading.Event().wait()
EOF
python3 /root/e2e-servers.py &
echo $! > /root/e2e-servers.pid
sleep 1
check "Fixture-Health-Server antworten" "$(curl -fsS http://127.0.0.1:3001/api/health | grep -q '"ok":true' && echo 0 || echo 1)" ""

ip addr add 10.0.0.5/32 dev lo 2>/dev/null || true
systemctl start network-online.target >/dev/null 2>&1 || true

# --------------------------------------------------------------------------
# 4) sudoers-Strecke (User cockpit-executor -> root, nur dieser Helfer)
# --------------------------------------------------------------------------
useradd -r -M -s /usr/sbin/nologin cockpit-executor 2>/dev/null || true
echo 'cockpit-executor ALL=(root) NOPASSWD: /usr/local/sbin/cockpit-self-update-action *' > /etc/sudoers.d/cockpit-executor
chmod 440 /etc/sudoers.d/cockpit-executor
if visudo -cf /etc/sudoers >/dev/null 2>&1; then VS=0; else VS=1; fi
check "sudoers-Datei gültig" "$VS" ""

echo
echo "--- S1: Update C2 im Sandbox-Nachbau des Executor-Dienstes (bis Aktivierung)"
TS_BEFORE="$(systemctl show -p ActiveEnterTimestamp --value wireguard-ops-cockpit-api)"
systemd-run --wait --pipe --collect --unit=e2e-selfupd-sandboxed \
  -p ProtectSystem=true -p ProtectHome=read-only -p RestrictAddressFamilies=AF_UNIX \
  -- /usr/local/sbin/cockpit-self-update-action "$C2" > /out/s1.out 2> /out/s1.err
rc=$?
check "S1 Sandbox-Lauf rc=0" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 /out/s1.err)"
expect_json "S1 Ergebnis ok:true" /out/s1.out "ok" "true"
expect_json "S1 Ergebnis sha=C2" /out/s1.out "sha" "$C2"
check "S1 Aktivierung wird ok" "$(wait_for_activation "$C2" ok && echo 0 || echo 1)" ""
expect_json "S1 Zustand deployed=C2" /var/lib/wireguard-ops-cockpit/self-update/state.json "deployed_commit" "$C2"
expect_json "S1 Zustand activation=ok" /var/lib/wireguard-ops-cockpit/self-update/state.json "activation.status" "ok"
expect_json "S1 Ergebnis phase=activated" /var/lib/wireguard-ops-cockpit/self-update/last-result.json "phase" "activated"
TS_AFTER="$(systemctl show -p ActiveEnterTimestamp --value wireguard-ops-cockpit-api)"
check "S1 Dienst wurde neu gestartet" "$([ -n "$TS_BEFORE" ] && [ "$TS_BEFORE" != "$TS_AFTER" ] && echo 0 || echo 1)" "before=$TS_BEFORE after=$TS_AFTER"
check "S1 Deploy lief mit defer" "$(grep -q "deploy-call commit=$C2 restart_mode=defer" /var/log/e2e-deploycalls.log && echo 0 || echo 1)" "$(tail -n 2 /var/log/e2e-deploycalls.log 2>/dev/null)"

echo
echo "--- S2: status über die sudoers-Strecke (User cockpit-executor)"
runuser -u cockpit-executor -- sudo -n /usr/local/sbin/cockpit-self-update-action status > /out/s2.out 2> /out/s2.err
rc=$?
check "S2 status rc=0" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 /out/s2.err)"
expect_json "S2 status deployed=C2" /out/s2.out "deployed_commit" "$C2"

echo
echo "--- S3: Update C3 über die sudoers-Strecke (bis Aktivierung)"
runuser -u cockpit-executor -- sudo -n /usr/local/sbin/cockpit-self-update-action "$C3" > /out/s3.out 2> /out/s3.err
rc=$?
check "S3 Update rc=0" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 /out/s3.err)"
check "S3 Aktivierung wird ok" "$(wait_for_activation "$C3" ok && echo 0 || echo 1)" ""
expect_json "S3 Zustand deployed=C3" /var/lib/wireguard-ops-cockpit/self-update/state.json "deployed_commit" "$C3"
expect_json "S3 Zustand previous=C2" /var/lib/wireguard-ops-cockpit/self-update/state.json "previous_commit" "$C2"

echo
echo "--- S4: Refusal — nicht gemergter Commit"
runuser -u cockpit-executor -- sudo -n /usr/local/sbin/cockpit-self-update-action "$C4" > /out/s4.out 2> /out/s4.err
rc=$?
check "S4 nicht gemergt -> 65" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 /out/s4.err)"
expect_json "S4 Ergebnis code=65" /var/lib/wireguard-ops-cockpit/self-update/last-result.json "code" "65"

echo
echo "--- S5: Aktivierungs-Fehlschlag wird berichtet (Health-Server aus)"
kill "$(cat /root/e2e-servers.pid)" 2>/dev/null || true
/usr/local/lib/wireguard-ops-cockpit/cockpit-self-update-run activate "$C3" > /out/s5.out 2>&1
rc=$?
check "S5 Aktivierung rc=68" "$([ "$rc" -eq 68 ] && echo 0 || echo 1)" "rc=$rc $(head -c 300 /out/s5.out)"
expect_json "S5 Zustand activation=failed" /var/lib/wireguard-ops-cockpit/self-update/state.json "activation.status" "failed"
expect_json "S5 deployed bleibt C3" /var/lib/wireguard-ops-cockpit/self-update/state.json "deployed_commit" "$C3"

echo
echo "--- Nachweise"
python3 - <<'PY'
import json
count = 0
with open("/var/lib/wireguard-ops-cockpit/self-update/history.jsonl", "r", encoding="utf-8") as handle:
    for line in handle:
        if line.strip():
            json.loads(line)
            count += 1
print("history entries:", count)
PY
check "history.jsonl lesbar" "$([ $? -eq 0 ] && echo 0 || echo 1)" ""
check "Logdateien geschrieben" "$(ls /var/log/wireguard-ops-cockpit-self-update/*.log >/dev/null 2>&1 && echo 0 || echo 1)" ""

echo
if [ "$FAIL" -eq 0 ]; then
  echo "INNEN-ERGEBNIS: GRUEN — $PASS Prüfungen bestanden."
  exit 0
fi
echo "INNEN-ERGEBNIS: ROT — $FAIL von $((PASS + FAIL)) Prüfungen fehlgeschlagen."
exit 1
