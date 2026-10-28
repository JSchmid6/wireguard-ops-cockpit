#!/bin/bash
# ============================================================================
# vps-cockpit-deploy.test.sh — offline harness for deploy/vps/vps-cockpit-deploy.sh.
#
# A fixture "origin" repository carries every source file of the script's table
# (dummy contents) and the script itself; a fixture host root holds part of the
# targets (old bytes), lacks the rest, and has the service user's data directory
# (0750); systemctl, visudo, docker and the build are stubs that log and can be
# told to fail. Checks: a clean install, the byte-exact rollback when the install
# fails half-way, the web image tag rollback when the web build fails, a build
# failure before anything is installed, an unmerged commit, the deferred restart,
# the built web image recorded in state.json and checked after a restart (68 when
# the web container still runs the old image),
# the web unit start (only when inactive, before the new image exists), that the
# data directory's mode survives every run, and that the borgmatic.service drop-in
# lands next to a foreign drop-in that stays untouched in both directions (R2).
# The pinned Node runtime: installed from .node-version when the host lacks it
# (real tarball, checksum against a SHASUMS256.txt fixture, before the build),
# not downloaded again when it is there, and 70 + rollback on a checksum mismatch,
# a failed download or a .node-version that is not one clean x.y.z.
#
# Everything lives below one fresh mktemp directory under /tmp; the harness
# refuses to run otherwise. Call as root (install -o root):
#   sudo bash test/vps-cockpit-deploy.test.sh
# In a container the image needs git, python3 (the script edits state.json with
# python3), curl, tar and xz (the runtime fixture and the script's own download):
#   docker --context werkstatt run --rm -v /austausch/<klon>:/w:ro ubuntu:24.04 \
#     bash -c 'apt-get update -qq && apt-get install -y git python3 curl tar xz-utils && bash /w/test/vps-cockpit-deploy.test.sh'
# ============================================================================
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/deploy/vps/vps-cockpit-deploy.sh"
[ "$(id -u)" -eq 0 ] || { echo "FEHLER: bitte als root: sudo bash $0" >&2; exit 2; }
FIX="$(mktemp -d /tmp/vps-deploy-test.XXXXXX)"
case "$FIX" in /tmp/vps-deploy-test.??????) ;; *) echo "FEHLER: unerwartetes Fixture-Verzeichnis '$FIX'" >&2; exit 2 ;; esac
[ -z "$(ls -A "$FIX")" ] || { echo "FEHLER: Fixture nicht leer" >&2; exit 2; }
trap 'rm -rf -- "$FIX"' EXIT

g() { git -c user.name=t -c user.email=t@t "$@"; }
mapfile -t SOURCES < <(grep -oE '^  "[^"|]+\|' "$SCRIPT" | tr -d ' "|')
[ "${#SOURCES[@]}" -ge 20 ] || { echo "FEHLER: Tabelle nicht gelesen (${#SOURCES[@]})" >&2; exit 2; }
NODE_V=22.23.4   # the pin the fixture stands carry; the script reads it from .node-version

# --- origin with commit A (base) and B (new helper bytes) ----------------------
git init -q --bare -b main "$FIX/origin.git"
g clone -q "$FIX/origin.git" "$FIX/work" 2>/dev/null
mkdir -p "$FIX/work/deploy/vps"
for src in "${SOURCES[@]}"; do mkdir -p "$FIX/work/$(dirname "$src")"; echo "A $src" > "$FIX/work/$src"; done
echo "$NODE_V" > "$FIX/work/.node-version"
cp "$SCRIPT" "$FIX/work/deploy/vps/vps-cockpit-deploy.sh"
echo "services: {}" > "$FIX/work/docker-compose.vps.yml"
(cd "$FIX/work" && g add -A && g commit -qm A && g push -q origin HEAD:main)
A=$(git -C "$FIX/work" rev-parse HEAD)
for src in "${SOURCES[@]}"; do [ "$src" = deploy/vps/vps-cockpit-deploy.sh ] || echo "B $src" > "$FIX/work/$src"; done
(cd "$FIX/work" && g commit -qam B && g push -q origin HEAD:main)
B=$(git -C "$FIX/work" rev-parse HEAD)
# C: a .node-version that is not one clean x.y.z (a version pin must never become
# a path or a URL that this root script follows).
printf '%s\n' "$NODE_V/../../evil" > "$FIX/work/.node-version"
(cd "$FIX/work" && g commit -qam C && g push -q origin HEAD:main)
C=$(git -C "$FIX/work" rev-parse HEAD)
git -C "$FIX/work" checkout -q -b seite "$A"; echo x > "$FIX/work/x"; (cd "$FIX/work" && g add x && g commit -qm seite && g push -q origin seite)
SEITE=$(git -C "$FIX/work" rev-parse HEAD)

# --- stubs ------------------------------------------------------------------
mkdir -p "$FIX/stub"
cat > "$FIX/stub/systemctl" <<EOF
#!/bin/bash
echo "systemctl \$*" >> "$FIX/calls.log"
if [ "\$1" = "is-active" ]; then [ -e "$FIX/web-active" ] && exit 0; exit 3; fi
# a restart of the web unit swaps the container onto the tagged image — unless the
# test simulates a web unit that leaves the old container running (web-stale)
if [ "\$1" = "restart" ] && [[ " \$* " == *" wireguard-ops-cockpit-web "* ]] && [ ! -e "$FIX/web-stale" ]; then
  : > "$FIX/web-swapped"
fi
exit 0
EOF
cat > "$FIX/stub/docker" <<EOF
#!/bin/bash
echo "docker \$*" >> "$FIX/calls.log"
case "\$*" in
  *"config --images web"*) echo "wireguard-ops-cockpit-web" ;;
  "image inspect --format {{.Id}} wireguard-ops-cockpit-web") [ -e "$FIX/web-built" ] && echo "sha256:neu" || echo "sha256:alt" ;;
  *"compose"*"build web"*) [ -e "$FIX/fail-webbuild" ] && exit 1; : > "$FIX/web-built" ;;
  *"compose"*"ps -a -q web"*) [ -e "$FIX/fail-webps" ] && exit 1; echo "c0ffee" ;;
  "inspect --format {{.Name}} c0ffee") echo "/wireguard-ops-cockpit-web-1" ;;
  "inspect --format {{.Image}} wireguard-ops-cockpit-web-1") [ -e "$FIX/web-swapped" ] && echo "sha256:neu" || echo "sha256:alt" ;;
esac
exit 0
EOF
cat > "$FIX/stub/visudo" <<EOF
#!/bin/bash
echo "visudo \$*" >> "$FIX/calls.log"
# fail the check after the install once, then behave (the restored sudoers is valid)
[ "\$1" = "-c" ] && [ -e "$FIX/fail-visudo" ] && rm -f "$FIX/fail-visudo" && exit 1
exit 0
EOF
chmod 755 "$FIX/stub/"*

# --- the pinned Node runtime: fixture host tree and a nodejs.org-like release ---
fake_runtime() { # fake_runtime <host root> — a runtime whose node reports v<NODE_V>
  local d="$1/opt/node-v$NODE_V-linux-x64"
  install -d -m 0755 "$1/opt" "$d/bin"
  printf '#!/bin/sh\necho v%s\n' "$NODE_V" > "$d/bin/node"
  chmod 755 "$d/bin/node"
}
make_dist() { # make_dist [kaputt] — v<ver>/ with the tarball and SHASUMS256.txt
  # The tarball is real (tar -xJf in the deploy unpacks it), the checksum is
  # computed here the way nodejs.org computes it, and the list carries a decoy
  # entry of another architecture so a sloppy selection cannot pass.
  rm -rf "$FIX/dist" "$FIX/pkg"
  install -d "$FIX/dist/v$NODE_V" "$FIX/pkg/node-v$NODE_V-linux-x64/bin"
  printf '#!/bin/sh\necho v%s\n' "$NODE_V" > "$FIX/pkg/node-v$NODE_V-linux-x64/bin/node"
  chmod 755 "$FIX/pkg/node-v$NODE_V-linux-x64/bin/node"
  tar -cJf "$FIX/dist/v$NODE_V/node-v$NODE_V-linux-x64.tar.xz" -C "$FIX/pkg" "node-v$NODE_V-linux-x64"
  {
    printf '%064d  %s\n' 0 "node-v$NODE_V-aix-ppc64.tar.gz"
    printf '%s  %s\n' "$(sha256sum "$FIX/dist/v$NODE_V/node-v$NODE_V-linux-x64.tar.xz" | cut -d' ' -f1)" \
      "node-v$NODE_V-linux-x64.tar.xz"
  } > "$FIX/dist/v$NODE_V/SHASUMS256.txt"
  # after the list was written: the bytes no longer match what it promises
  [ "${1:-}" != kaputt ] || printf 'x' >> "$FIX/dist/v$NODE_V/node-v$NODE_V-linux-x64.tar.xz"
}

targets() { grep -oE '^  "[^"|]+\|[^"|]+\|' "$SCRIPT" | cut -d'|' -f2 | sed -E \
  -e 's#\$LIB#/usr/local/lib/wireguard-ops-cockpit#' -e 's#\$SBIN#/usr/local/sbin#' \
  -e 's#\$UNITS#/etc/systemd/system#' -e 's#\$SUDOERS#/etc/sudoers.d/cockpit-executor#' -e 's#^\$ROOT##'; }
fresh_host() { # fresh_host [ohne-runtime] — half the targets with old bytes, the other half absent; repo at A
  rm -rf "$FIX/root" "$FIX/repo" "$FIX/calls.log" "$FIX/fail-visudo" "$FIX/fail-build" "$FIX/fail-webbuild" "$FIX/web-active" \
    "$FIX/web-built" "$FIX/web-swapped" "$FIX/web-stale" "$FIX/fail-webps"
  mkdir -p "$FIX/root/var/lib/wireguard-ops-cockpit"; chmod 750 "$FIX/root/var/lib/wireguard-ops-cockpit"
  # A host that already carries the pinned runtime (the normal case) unless the
  # case is about installing it.
  [ "${1:-}" = ohne-runtime ] || fake_runtime "$FIX/root"
  # Fremdes Drop-in in dem Verzeichnis, in das unser neues Drop-in kommt (der
  # Host hat dort z. B. nach-gitlab-backup.conf): es gehört nicht zu diesem
  # Repository und darf weder beim Installieren noch beim Rückfall angefasst
  # werden.
  mkdir -p "$FIX/root/etc/systemd/system/borgmatic.service.d"
  printf '%s\n' "FREMD nach-gitlab-backup.conf" > "$FIX/root/etc/systemd/system/borgmatic.service.d/nach-gitlab-backup.conf"
  g clone -q "$FIX/origin.git" "$FIX/repo" 2>/dev/null; git -C "$FIX/repo" checkout -q -B main "$A"
  local i=0 target
  while IFS= read -r target; do
    if [ $((i % 2)) = 0 ]; then mkdir -p "$(dirname "$FIX/root$target")"; echo "ALT $target" > "$FIX/root$target"; fi
    i=$((i + 1))
  done < <(targets)
  (cd "$FIX/root" && find . -type f -exec sha256sum {} + | sort) > "$FIX/vorher.sums"
}
deploy() { # deploy <sha> [mode]
  env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root REPO_COMMIT="$1" COCKPIT_RESTART_MODE="${2:-now}" \
    VPS_DEPLOY_ROOT="$FIX/root" VPS_DEPLOY_REPO="$FIX/repo" VPS_DEPLOY_ORIGIN="$FIX/origin.git" \
    VPS_DEPLOY_SYSTEMCTL="$FIX/stub/systemctl" VPS_DEPLOY_VISUDO="$FIX/stub/visudo" VPS_DEPLOY_DOCKER="$FIX/stub/docker" \
    VPS_DEPLOY_NODE_DIST="file://$FIX/dist" \
    VPS_DEPLOY_BUILD="[ -x $FIX/root/opt/node-v$NODE_V-linux-x64/bin/node ] || { echo 'build: the pinned runtime is missing (bin/with-runtime would exit 69)' >&2; exit 69; }; [ ! -e $FIX/fail-build ] || [ \"\$(git rev-parse HEAD)\" != $B ]" \
    bash "$FIX/repo/deploy/vps/vps-cockpit-deploy.sh" > "$FIX/out.log" 2>&1
}
fails=0
check() { if eval "$2"; then echo "GRÜN $1"; else echo "ROT  $1"; sed 's/^/     | /' "$FIX/out.log" | tail -8; fails=$((fails + 1)); fi; }
after_sums() { (cd "$FIX/root" && find . -type f -not -path './var/lib/wireguard-ops-cockpit/*' -exec sha256sum {} + | sort); }
count_B() { local n=0 t; while IFS= read -r t; do grep -q '^B ' "$FIX/root$t" 2>/dev/null && n=$((n + 1)); done < <(targets); echo "$n"; }
parent_mode() { stat -c %a "$FIX/root/var/lib/wireguard-ops-cockpit"; }
start_before_build() { awk '/systemctl start wireguard-ops-cockpit-web/{s=NR} /compose.*build web/{b=NR} END{exit !(s && b && s < b)}' "$FIX/calls.log"; }

# 1: clean install, restart now (web unit inactive: first install)
fresh_host; code=0; deploy "$B" now || code=$?
check "Erfolg: Exit 0" '[ "$code" = 0 ]'
check "Erfolg: alle Ziele mit neuen Bytes (außer dem Skript selbst)" '[ "$(count_B)" = "$(( $(targets | wc -l) - 1 ))" ]'
check "Erfolg: Instanzrolle der Tür installiert (root, 0600)" '[ "$(stat -c "%a %U" "$FIX/root/etc/wireguard-ops-cockpit/instance-role.env")" = "600 root" ] && grep -q "^B deploy/vps/instance-role.env" "$FIX/root/etc/wireguard-ops-cockpit/instance-role.env"'
check "Erfolg: self-update.env mit Web-Unit in der Dienstliste" 'grep -q "COCKPIT_SELF_UPDATE_SERVICES=.*wireguard-ops-cockpit-web" "$FIX/root/etc/wireguard-ops-cockpit/self-update.env"'
check "Erfolg: state.json verbucht B" 'grep -q "\"deployed_commit\": \"$B\"" "$FIX/root/var/lib/wireguard-ops-cockpit/self-update/state.json"'
check "Erfolg: Web-Abbild gebaut, nicht per up umgeschaltet" 'grep -q "^docker compose .* build web" "$FIX/calls.log" && ! grep -q "^docker compose .* up" "$FIX/calls.log"'
check "Erfolg: inaktive Web-Unit vor dem Web-Bau gestartet" 'start_before_build'
check "Erfolg: Neustart inkl. Web-Unit" 'grep -q "^systemctl restart .*wireguard-ops-cockpit-web" "$FIX/calls.log"'
check "Erfolg: state.json verbucht das gebaute Web-Abbild und den Container" '[ "$(python3 -c "import json,sys; w=json.load(open(sys.argv[1]))[\"web_image\"]; print(w[\"name\"], w[\"id\"], w[\"container\"])" "$FIX/root/var/lib/wireguard-ops-cockpit/self-update/state.json")" = "wireguard-ops-cockpit-web sha256:neu wireguard-ops-cockpit-web-1" ]'
check "Erfolg: nach dem Neustart läuft das gebaute Abbild (geprüft)" 'grep -q "web runs sha256:neu" "$FIX/out.log"'
check "Erfolg: Sicherungsordner entfernt" '[ -z "$(ls -d "$FIX"/root/var/lib/wireguard-ops-cockpit/self-update/deploy-backup.* 2>/dev/null)" ]'
check "Erfolg: Datenordner des Dienstes bleibt 750" '[ "$(parent_mode)" = 750 ]'
check "Erfolg: Wiederaufnahme der Host-Läufe beim Hochfahren aktiviert" 'grep -q "^systemctl enable --quiet wireguard-ops-cockpit-host-run-resume.service" "$FIX/calls.log"'
# R2: das Drop-in für borgmatic.service. Das Verzeichnis gehört dem Paket, nicht
# uns: hier wird nur die eigene Datei geschrieben.
check "R2: Drop-in borgmatic.service.d/cockpit-borg-lock.conf installiert" '[ "$(cat "$FIX/root/etc/systemd/system/borgmatic.service.d/cockpit-borg-lock.conf")" = "B deploy/systemd/borgmatic-cockpit-borg-lock.conf" ]'
check "R2: fremdes Drop-in unberührt" '[ "$(cat "$FIX/root/etc/systemd/system/borgmatic.service.d/nach-gitlab-backup.conf")" = "FREMD nach-gitlab-backup.conf" ]'
check "R2: Drop-in lässt das Backup auf die Sperre warten" 'grep -qx "ExecStartPre=/usr/bin/flock /run/lock/cockpit-borg.lock /bin/true" "$HERE/../deploy/systemd/borgmatic-cockpit-borg-lock.conf"'
check "R2: Drop-in hat keine andere aktive Zeile (ändert nichts an borgmatic.service)" '[ "$(grep -vE "^[[:space:]]*(#|$)" "$HERE/../deploy/systemd/borgmatic-cockpit-borg-lock.conf" | tr "\n" "|")" = "[Service]|ExecStartPre=/usr/bin/flock /run/lock/cockpit-borg.lock /bin/true|" ]'

# 2: install fails half-way (sudoers check after install) -> byte-exact rollback
fresh_host; : > "$FIX/fail-visudo"; code=0; deploy "$B" now || code=$?
check "Rückfall: Exit ungleich 0" '[ "$code" != 0 ]'
check "Rückfall: Host-Dateien bytegenau wie vorher (fehlende wieder weg)" '[ "$(after_sums)" = "$(cat "$FIX/vorher.sums")" ]'
check "Rückfall: Checkout wieder auf A" '[ "$(git -C "$FIX/repo" rev-parse HEAD)" = "$A" ]'
check "Rückfall: vollständig gemeldet, kein Neustart" 'grep -q "rollback: pinned runtime ok" "$FIX/out.log" && grep -q "rollback complete" "$FIX/out.log" && ! grep -q "^systemctl restart" "$FIX/calls.log"'
check "Rückfall: kein state.json geschrieben" '[ ! -e "$FIX/root/var/lib/wireguard-ops-cockpit/self-update/state.json" ]'
check "Rückfall: Datenordner des Dienstes bleibt 750" '[ "$(parent_mode)" = 750 ]'
check "Rückfall: Drop-in wieder weg (lag vorher nicht da)" '[ ! -e "$FIX/root/etc/systemd/system/borgmatic.service.d/cockpit-borg-lock.conf" ]'
check "Rückfall: fremdes Drop-in unberührt" '[ "$(cat "$FIX/root/etc/systemd/system/borgmatic.service.d/nach-gitlab-backup.conf")" = "FREMD nach-gitlab-backup.conf" ]'

# 3: the web build fails after the install -> files restored, web tag back on the old image
fresh_host; : > "$FIX/fail-webbuild"; code=0; deploy "$B" now || code=$?
check "Web-Bau scheitert: Exit ungleich 0, Dateien bytegenau zurück" '[ "$code" != 0 ] && [ "$(after_sums)" = "$(cat "$FIX/vorher.sums")" ]'
check "Web-Bau scheitert: Abbild-Tag zurück auf das alte Abbild" 'grep -q "^docker image tag sha256:alt wireguard-ops-cockpit-web" "$FIX/calls.log" && grep -q "rollback complete" "$FIX/out.log"'

# 4: build of B fails before anything is installed
fresh_host; : > "$FIX/fail-build"; code=0; deploy "$B" now || code=$?
check "Build-Fehler: Exit ungleich 0, nichts installiert" '[ "$code" != 0 ] && [ "$(after_sums)" = "$(cat "$FIX/vorher.sums")" ]'
check "Build-Fehler: Checkout wieder auf A" '[ "$(git -C "$FIX/repo" rev-parse HEAD)" = "$A" ]'

# 5: commit not merged into origin/main
fresh_host; code=0; deploy "$SEITE" now || code=$?
check "Nicht gemergt: Exit 65, nichts angefasst" '[ "$code" = 65 ] && [ "$(after_sums)" = "$(cat "$FIX/vorher.sums")" ] && [ "$(git -C "$FIX/repo" rev-parse HEAD)" = "$A" ]'

# 6: deferred restart (the runner activates later), web unit already active
fresh_host; : > "$FIX/web-active"; code=0; deploy "$B" defer || code=$?
check "Defer: Exit 0, installiert, kein Neustart" '[ "$code" = 0 ] && [ "$(count_B)" -gt 20 ] && ! grep -q "^systemctl restart" "$FIX/calls.log"'
check "Defer: aktive Web-Unit nicht erneut gestartet (nichts schaltet vor der Aktivierung)" '! grep -q "^systemctl start" "$FIX/calls.log"'
check "Defer: state.json verbucht das gebaute Web-Abbild für die Aktivierung" 'grep -q "\"id\": \"sha256:neu\"" "$FIX/root/var/lib/wireguard-ops-cockpit/self-update/state.json"'

# 7: restart now, but the web unit leaves the old container running -> exit 68, said so
fresh_host; : > "$FIX/web-active"; : > "$FIX/web-stale"; code=0; deploy "$B" now || code=$?
check "Web nicht umgeschaltet: Exit 68 mit Grund" '[ "$code" = 68 ] && grep -q "runs sha256:alt, not the built sha256:neu" "$FIX/out.log"'

# 8: the web container cannot be found after the build -> one rollback, completely logged
fresh_host; : > "$FIX/web-active"; : > "$FIX/fail-webps"; code=0; deploy "$B" defer || code=$?
check "Web-Container nicht auffindbar: Exit ungleich 0, Dateien bytegenau zurück" '[ "$code" != 0 ] && [ "$(after_sums)" = "$(cat "$FIX/vorher.sums")" ]'
# (a second, swallowed rollback in the $(...) subshell would show up as a second tag reset)
check "Web-Container nicht auffindbar: genau ein Rückfall, vollständig im Log" '[ "$(grep -c "^docker image tag " "$FIX/calls.log")" = 1 ] && grep -q "rollback complete" "$FIX/out.log"'

# 9: the host lacks the pinned runtime -> installed from .node-version before the build
# (the build stub below fails with 69 without it, exactly like bin/with-runtime)
fresh_host ohne-runtime; make_dist; code=0; deploy "$B" now || code=$?
check "Runtime fehlt: Exit 0" '[ "$code" = 0 ]'
check "Runtime fehlt: aus .node-version installiert (root, meldet v$NODE_V)" '[ "$(stat -c %U "$FIX/root/opt/node-v$NODE_V-linux-x64/bin/node" 2>/dev/null)" = root ] && [ "$("$FIX/root/opt/node-v$NODE_V-linux-x64/bin/node" --version 2>/dev/null)" = "v$NODE_V" ]'
check "Runtime fehlt: Prüfsumme gegen die SHASUMS256.txt der Verteilung geprüft" 'grep -q "node-v$NODE_V-linux-x64.tar.xz: OK" "$FIX/out.log"'
check "Runtime fehlt: der Bau lief erst danach (er braucht die Laufzeit)" 'grep -q "pinned Node v$NODE_V installed at" "$FIX/out.log"'
check "Runtime fehlt: nur die Laufzeit unter opt, kein Rest der Entpackung" '[ "$(ls -A "$FIX/root/opt")" = "node-v$NODE_V-linux-x64" ]'

# 10: second run (runtime present) -> no download at all (the release is gone)
mv "$FIX/dist" "$FIX/dist.weg"; code=0; deploy "$B" now || code=$?
check "Runtime da: zweiter Lauf braucht keinen Download (Exit 0)" '[ "$code" = 0 ] && grep -q "pinned Node v$NODE_V is already installed" "$FIX/out.log"'

# 11: the published checksum does not match the tarball -> 70, nothing unpacked, rollback
fresh_host ohne-runtime; make_dist kaputt; code=0; deploy "$B" now || code=$?
check "Prüfsumme falsch: Exit 70" '[ "$code" = 70 ]'
check "Prüfsumme falsch: nichts entpackt, Host-Dateien bytegenau" '[ ! -e "$FIX/root/opt" ] && [ "$(after_sums)" = "$(cat "$FIX/vorher.sums")" ] && grep -q "does not match nodejs.org" "$FIX/out.log"'
check "Prüfsumme falsch: Rückfall auf A, Schritt nicht wiederholt" '[ "$(git -C "$FIX/repo" rev-parse HEAD)" = "$A" ] && grep -q "rollback: pinned runtime step skipped" "$FIX/out.log"'

# 12: no release to download from -> 70, nothing written below /opt
fresh_host ohne-runtime; rm -rf "$FIX/dist"; code=0; deploy "$B" now || code=$?
check "Download scheitert: Exit 70, kein /opt angelegt" '[ "$code" = 70 ] && [ ! -e "$FIX/root/opt" ] && grep -q "could not download node-v$NODE_V-linux-x64.tar.xz" "$FIX/out.log"'
# The host never had a runtime, so the old build cannot run either: the rollback must
# say so instead of claiming success.
check "Download scheitert: Rückfall ehrlich als unvollständig gemeldet" '[ "$(git -C "$FIX/repo" rev-parse HEAD)" = "$A" ] && grep -q "rollback: pinned runtime step skipped" "$FIX/out.log" && grep -q "rollback INCOMPLETE" "$FIX/out.log"'

# 13: .node-version is not one clean x.y.z -> refused before anything is fetched
fresh_host ohne-runtime; make_dist; code=0; deploy "$C" now || code=$?
check ".node-version unsauber: Exit 70, kein Pfad/URL daraus gebaut" '[ "$code" = 70 ] && [ ! -e "$FIX/root/opt" ] && grep -q "does not name one Node version" "$FIX/out.log"'
check ".node-version unsauber: Rückfall auf A" '[ "$(git -C "$FIX/repo" rev-parse HEAD)" = "$A" ]'

echo
[ "$fails" = 0 ] && echo "alles grün" || { echo "$fails rot"; exit 1; }
