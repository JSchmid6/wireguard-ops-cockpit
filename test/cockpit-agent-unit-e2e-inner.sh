#!/bin/bash
# Innenteil von test/cockpit-agent-unit-e2e.sh — läuft als root im systemd-Container.
#
# 1. Identitäten und Verzeichnisse wie homeserver-cockpit-deploy.sh (Schritte 3/4),
#    dazu der Stand vor dem Fix (Konfiguration gehört cockpit-agent, 0600), dann
#    die Blöcke agent-opencode-config und runner-opencode-config, aus dem
#    Deploy-Skript gelesen, nicht kopiert.
# 2. Die echten Units (Agent und Runner) mit einem Drop-in, das nur ExecStart durch
#    eine Probe ersetzt. Die Probe versucht als die Unit, was die Bash eines Laufs
#    könnte: die eigene Konfiguration ändern, und — beim Runner — die Konfiguration,
#    die Arbeitsordner, den Socket und die Prozesse der Plan-Rollen erreichen
#    (Karte t_cb81637b). opencodes Zustand liegt seit t_cb81637b je Lauf im
#    Arbeitsordner; die alten Zustandsordner im Home sind nicht mehr beschreibbar.
# 3. Gegenprobe mit der alten Schreibgrenze (ReadWritePaths=<Agent-Home>): Dort
#    reicht root als Besitzer nicht, der Ordner .config lässt sich umbenennen und
#    ersetzen — das zeigt, dass die Probe die Lücke erkennt.
set -u
PKG=/pkg
A=/var/lib/wireguard-ops-agent
R=/var/lib/wireguard-ops-runner
FAIL=0
check() { if eval "$2"; then echo "OK    $1"; else echo "FEHLER $1"; FAIL=1; fi; }

groupadd --system cockpit-agent-client
useradd --system -m -d "$A" -s /usr/sbin/nologin -g cockpit-agent-client cockpit-agent
groupadd --system cockpit-runner-client
useradd --system -m -d "$R" -s /usr/sbin/nologin -g cockpit-runner-client cockpit-runner
install -d -m 0750 -o cockpit-agent -g cockpit-agent-client "$A"
install -d -m 0700 -o cockpit-agent -g cockpit-agent-client "$A/sessions"
install -d -m 0750 -o cockpit-runner -g cockpit-runner-client "$R"
install -d -m 0700 -o cockpit-runner -g cockpit-runner-client "$R/sessions"
install -d -m 0750 -o cockpit-agent -g cockpit-agent-client "$A/.config/opencode"
install -m 600 -o cockpit-agent -g cockpit-agent-client "$PKG/deploy/config/opencode-agent.jsonc" "$A/.config/opencode/opencode.jsonc"
# Altbestand von opencode im Agent-Home (Releases vor t_cb81637b schrieben dorthin).
install -d -m 0750 -o cockpit-agent -g cockpit-agent-client "$A/.local/share/opencode" "$A/.cache/opencode"
for name in agent runner; do
  BLOCK="$(sed -n "/^# BEGIN $name-opencode-config/,/^# END $name-opencode-config/p" "$PKG/deploy/lab0/homeserver-cockpit-deploy.sh")"
  check "Deploy-Block $name-opencode-config gefunden" '[ -n "$BLOCK" ]'
  COCKPIT_DIR="$PKG" AGENT_DIR="$A" RUNNER_DIR="$R" eval "$BLOCK"
done
check "Konfiguration: root:cockpit-agent-client 0640" '[ "$(stat -c "%U:%G %a" "$A/.config/opencode/opencode.jsonc")" = "root:cockpit-agent-client 640" ]'
check "Konfigurationsordner: root:cockpit-agent-client 0750" '[ "$(stat -c "%U:%G %a" "$A/.config/opencode")" = "root:cockpit-agent-client 750" ]'
check "Runner-Konfiguration: root:cockpit-runner-client 0640" '[ "$(stat -c "%U:%G %a" "$R/.config/opencode/opencode.jsonc")" = "root:cockpit-runner-client 640" ]'
check ".gitignore liegt in beiden Konfigurationsordnern" '[ -f "$A/.config/opencode/.gitignore" ] && [ -f "$R/.config/opencode/.gitignore" ]'
check "cockpit-agent liest seine Konfiguration" 'runuser -u cockpit-agent -- cat "$A/.config/opencode/opencode.jsonc" >/dev/null'
check "cockpit-runner liest seine Konfiguration" 'runuser -u cockpit-runner -- cat "$R/.config/opencode/opencode.jsonc" >/dev/null'
check "cockpit-runner ist in keiner Gruppe der Plan-Rollen" '[ "$(id -Gn cockpit-runner)" = cockpit-runner-client ]'

install -d -m 0700 /etc/wireguard-ops-cockpit
: > /etc/wireguard-ops-cockpit/agent.env
install -d -m 0755 /opt/wireguard-ops-cockpit
cat > /usr/local/lib/agent-unit-probe.sh <<'PROBE'
#!/bin/bash
A=/var/lib/wireguard-ops-agent
R=/var/lib/wireguard-ops-runner
H=$HOME
echo "HOME=$HOME USER=$(id -un)"
try() { if (eval "$2") 2>/dev/null; then echo "WRITABLE $1"; else echo "REFUSED $1"; fi; }
try config "printf x >> $H/.config/opencode/opencode.jsonc"
try config-replace "mv $H/.config/opencode/opencode.jsonc $H/.config/opencode/x"
try config-dir-rename "mv $H/.config $H/.config-old && mkdir -p $H/.config/opencode"
try global-config "printf '{}' > $H/.config/opencode/opencode.json"
try agent-definition "mkdir -p $H/.config/opencode/agent && printf x > $H/.config/opencode/agent/plan.md"
try global-agents-md "printf x > $H/.config/opencode/AGENTS.md"
try home-dot-opencode "mkdir $H/.opencode"
try home-project-config "printf '{}' > $H/opencode.json"
try home-agents-md "printf x > $H/AGENTS.md"
try claude-md "mkdir -p $H/.claude"
try sessions "mkdir $H/sessions/agent-probe && rmdir $H/sessions/agent-probe"
try old-opencode-data "mkdir -p $H/.local/share/opencode && printf x > $H/.local/share/opencode/auth.json"
try old-opencode-cache "mkdir -p $H/.cache/opencode && printf x > $H/.cache/opencode/models.json"
try runtime-dir "printf x > $RUNTIME_DIRECTORY/probe && rm $RUNTIME_DIRECTORY/probe"
# What the runner must not reach of the plan roles (and the other way round).
if [ "$H" = "$R" ]; then O=$A; OS=/run/cockpit-agent/agent.sock; OU=cockpit-agent; else O=$R; OS=/run/cockpit-runner/runner.sock; OU=cockpit-runner; fi
try other-home-read "ls $O >/dev/null"
try other-config-read "cat $O/.config/opencode/opencode.jsonc >/dev/null"
try other-workspace "printf x > $O/sessions/agent-fixture/AGENTS.md"
try other-session-root "printf x > $O/sessions/AGENTS.md"
try other-socket "test -e $OS"
try other-socket-dir "printf x > $(dirname "$OS")/probe"
try other-process-visible "for p in /proc/[0-9]*; do [ \"\$(stat -c %U \$p 2>/dev/null)\" = $OU ] && exit 0; done; exit 1"
try other-process-signal "kill -0 \$(cat /run/e2e-other-pid-$OU)"
PROBE
chmod 755 /usr/local/lib/agent-unit-probe.sh

# Fixtures of the other side: a concurrent workspace, a socket, a running process.
install -d -m 0700 -o cockpit-agent -g cockpit-agent-client "$A/sessions/agent-fixture"
install -d -m 0700 -o cockpit-runner -g cockpit-runner-client "$R/sessions/agent-fixture"
for side in agent runner; do
  install -d -m 0770 -o cockpit-$side -g cockpit-$side-client /run/cockpit-$side
  runuser -u cockpit-$side -- python3 -c "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])" "/run/cockpit-$side/$side.sock"
  runuser -u cockpit-$side -- bash -c 'setsid sleep 3600 </dev/null >/dev/null 2>&1 & echo $!' > /run/e2e-other-pid-cockpit-$side
done
chmod 0644 /run/e2e-other-pid-*

probe() { # probe <unit> <label>: Unit einmal laufen lassen, Ausgabe nach $PROBE_OUT
  systemctl daemon-reload
  local since; since="$(date '+%Y-%m-%d %H:%M:%S')"; sleep 1
  systemctl start "$1.service"; local rc=$?
  PROBE_OUT="$(journalctl -u "$1.service" --since "$since" -o cat --no-pager | grep -E '^(HOME=|WRITABLE|REFUSED)')"
  echo "--- $2 (start rc=$rc)"; echo "$PROBE_OUT"
  return $rc
}
has() { printf '%s\n' "$PROBE_OUT" | grep -qx "$1"; }

for side in agent runner; do
  UNIT=wireguard-ops-cockpit-$side
  install -m 644 "$PKG/deploy/systemd/$UNIT.service" /etc/systemd/system/
  install -d /etc/systemd/system/$UNIT.service.d
  # RuntimeDirectory= replaces the fixture socket directory at start: keep it
  # (the probe still finds the other side's socket through its own fixture).
  cat > /etc/systemd/system/$UNIT.service.d/probe.conf <<'EOF'
[Service]
Type=oneshot
Restart=no
RuntimeDirectoryPreserve=yes
ExecStart=
ExecStart=/bin/bash /usr/local/lib/agent-unit-probe.sh
EOF
done

for side in agent runner; do
  UNIT=wireguard-ops-cockpit-$side
  H=$A; [ $side = runner ] && H=$R
  check "$side: Unit startet mit der neuen Schreibgrenze" "probe $UNIT $side"
  check "$side: HOME ist das eigene Home" "has 'HOME=$H USER=cockpit-$side'"
  for k in config config-replace config-dir-rename global-config agent-definition global-agents-md home-dot-opencode home-project-config home-agents-md claude-md old-opencode-data old-opencode-cache; do
    check "$side verweigert: $k" "has 'REFUSED $k'"
  done
  for k in sessions runtime-dir; do
    check "$side beschreibbar: $k" "has 'WRITABLE $k'"
  done
  for k in other-home-read other-config-read other-workspace other-session-root other-socket other-socket-dir other-process-visible other-process-signal; do
    check "$side erreicht die andere Seite nicht: $k" "has 'REFUSED $k'"
  done
done
check "Konfiguration unverändert" 'cmp -s "$PKG/deploy/config/opencode-agent.jsonc" "$A/.config/opencode/opencode.jsonc" && cmp -s "$PKG/deploy/config/opencode-agent.jsonc" "$R/.config/opencode/opencode.jsonc"'

UNIT=wireguard-ops-cockpit-agent
printf '[Service]\nReadWritePaths=%s\n' "$A" > /etc/systemd/system/$UNIT.service.d/old-boundary.conf
probe $UNIT "Gegenprobe alte Schreibgrenze" >/dev/null
echo "--- Gegenprobe alte Schreibgrenze"; echo "$PROBE_OUT"
check "Gegenprobe: alte Grenze lässt .config ersetzen" "has 'WRITABLE config-dir-rename'"
rm -f /etc/systemd/system/$UNIT.service.d/old-boundary.conf

echo
[ "$FAIL" -eq 0 ] && echo "ALLE PRUEFUNGEN GRUEN" || echo "PRUEFUNGEN ROT"
exit "$FAIL"
