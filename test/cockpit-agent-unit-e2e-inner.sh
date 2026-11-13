#!/bin/bash
# Innenteil von test/cockpit-agent-unit-e2e.sh — läuft als root im systemd-Container.
#
# 1. Identität und Verzeichnisse wie homeserver-cockpit-deploy.sh (Schritte 3/4),
#    dazu der Stand vor dem Fix (Konfiguration gehört cockpit-agent, 0600), dann
#    der Block agent-opencode-config, aus dem Deploy-Skript gelesen, nicht kopiert.
# 2. Die echte Unit mit einem Drop-in, das nur ExecStart durch eine Probe ersetzt.
#    Die Probe versucht als die Unit, was die Bash eines Runner-Laufs könnte.
#    Ein fehlender opencode-Zustandsordner (VPS ohne Cache) legt die Unit selbst an.
# 3. Gegenprobe mit der alten Schreibgrenze (ReadWritePaths=<Agent-Home>): Dort
#    reicht root als Besitzer nicht, der Ordner .config lässt sich umbenennen und
#    ersetzen — das zeigt, dass die Probe die Lücke erkennt.
set -u
PKG=/pkg
A=/var/lib/wireguard-ops-agent
UNIT=wireguard-ops-cockpit-agent
FAIL=0
check() { if eval "$2"; then echo "OK    $1"; else echo "FEHLER $1"; FAIL=1; fi; }

groupadd --system cockpit-agent-client
useradd --system -m -d "$A" -s /usr/sbin/nologin -g cockpit-agent-client cockpit-agent
install -d -m 0750 -o cockpit-agent -g cockpit-agent-client "$A"
install -d -m 0700 -o cockpit-agent -g cockpit-agent-client "$A/sessions"
install -d -m 0750 -o cockpit-agent -g cockpit-agent-client "$A/.config/opencode"
install -m 600 -o cockpit-agent -g cockpit-agent-client "$PKG/deploy/config/opencode-agent.jsonc" "$A/.config/opencode/opencode.jsonc"
BLOCK="$(sed -n '/^# BEGIN agent-opencode-config/,/^# END agent-opencode-config/p' "$PKG/deploy/lab0/homeserver-cockpit-deploy.sh")"
check "Deploy-Block agent-opencode-config gefunden" '[ -n "$BLOCK" ]'
COCKPIT_DIR="$PKG" AGENT_DIR="$A" eval "$BLOCK"
check "Konfiguration: root:cockpit-agent-client 0640" '[ "$(stat -c "%U:%G %a" "$A/.config/opencode/opencode.jsonc")" = "root:cockpit-agent-client 640" ]'
check "Konfigurationsordner: root:cockpit-agent-client 0750" '[ "$(stat -c "%U:%G %a" "$A/.config/opencode")" = "root:cockpit-agent-client 750" ]'
check ".gitignore liegt im Konfigurationsordner" '[ -f "$A/.config/opencode/.gitignore" ]'
check "cockpit-agent liest die Konfiguration" 'runuser -u cockpit-agent -- cat "$A/.config/opencode/opencode.jsonc" >/dev/null'

install -d -m 0700 /etc/wireguard-ops-cockpit
: > /etc/wireguard-ops-cockpit/agent.env
install -d -m 0755 /opt/wireguard-ops-cockpit
cat > /usr/local/lib/agent-unit-probe.sh <<'PROBE'
#!/bin/bash
A=/var/lib/wireguard-ops-agent
echo "HOME=$HOME USER=$(id -un)"
try() { if (eval "$2") 2>/dev/null; then echo "WRITABLE $1"; else echo "REFUSED $1"; fi; }
try config "printf x >> $A/.config/opencode/opencode.jsonc"
try config-replace "mv $A/.config/opencode/opencode.jsonc $A/.config/opencode/x"
try config-dir-rename "mv $A/.config $A/.config-old && mkdir -p $A/.config/opencode"
try global-config "printf '{}' > $A/.config/opencode/opencode.json"
try agent-definition "mkdir -p $A/.config/opencode/agent && printf x > $A/.config/opencode/agent/plan.md"
try global-agents-md "printf x > $A/.config/opencode/AGENTS.md"
try home-dot-opencode "mkdir $A/.opencode"
try home-project-config "printf '{}' > $A/opencode.json"
try home-agents-md "printf x > $A/AGENTS.md"
try claude-md "mkdir -p $A/.claude"
try sessions "mkdir $A/sessions/agent-probe && rmdir $A/sessions/agent-probe"
try opencode-data "printf x > $A/.local/share/opencode/probe && rm $A/.local/share/opencode/probe"
try opencode-state "printf x > $A/.local/state/opencode/probe && rm $A/.local/state/opencode/probe"
try opencode-cache "printf x > $A/.cache/opencode/probe && rm $A/.cache/opencode/probe"
try runtime-dir "printf x > /run/cockpit-agent/probe && rm /run/cockpit-agent/probe"
PROBE
chmod 755 /usr/local/lib/agent-unit-probe.sh

install -m 644 "$PKG/deploy/systemd/$UNIT.service" /etc/systemd/system/
install -d /etc/systemd/system/$UNIT.service.d
cat > /etc/systemd/system/$UNIT.service.d/probe.conf <<'EOF'
[Service]
Type=oneshot
Restart=no
ExecStart=
ExecStart=/bin/bash /usr/local/lib/agent-unit-probe.sh
EOF
rm -rf "$A/.cache"   # wie ein Host, auf dem opencode noch keinen Cache angelegt hat

probe() { # probe <label>: Unit einmal laufen lassen, Ausgabe nach $PROBE_OUT
  systemctl daemon-reload
  local since; since="$(date '+%Y-%m-%d %H:%M:%S')"; sleep 1
  systemctl start "$UNIT.service"; local rc=$?
  PROBE_OUT="$(journalctl -u "$UNIT.service" --since "$since" -o cat --no-pager | grep -E '^(HOME=|WRITABLE|REFUSED)')"
  echo "--- $1 (start rc=$rc)"; echo "$PROBE_OUT"
  return $rc
}
has() { printf '%s\n' "$PROBE_OUT" | grep -qx "$1"; }

check "Unit startet mit der neuen Schreibgrenze" 'probe neu'
check "HOME ist das Agent-Home" 'has "HOME=$A USER=cockpit-agent"'
for k in config config-replace config-dir-rename global-config agent-definition global-agents-md home-dot-opencode home-project-config home-agents-md claude-md; do
  check "verweigert: $k" "has 'REFUSED $k'"
done
for k in sessions opencode-data opencode-state opencode-cache runtime-dir; do
  check "beschreibbar: $k" "has 'WRITABLE $k'"
done
check "fehlender Cache-Ordner von der Unit angelegt (cockpit-agent)" '[ "$(stat -c %U "$A/.cache/opencode")" = cockpit-agent ]'
check "Konfiguration unverändert" 'cmp -s "$PKG/deploy/config/opencode-agent.jsonc" "$A/.config/opencode/opencode.jsonc"'

printf '[Service]\nReadWritePaths=%s\n' "$A" > /etc/systemd/system/$UNIT.service.d/old-boundary.conf
probe "Gegenprobe alte Schreibgrenze" >/dev/null
echo "--- Gegenprobe alte Schreibgrenze"; echo "$PROBE_OUT"
check "Gegenprobe: alte Grenze lässt .config ersetzen" "has 'WRITABLE config-dir-rename'"
rm -f /etc/systemd/system/$UNIT.service.d/old-boundary.conf

echo
[ "$FAIL" -eq 0 ] && echo "ALLE PRUEFUNGEN GRUEN" || echo "PRUEFUNGEN ROT"
exit "$FAIL"
