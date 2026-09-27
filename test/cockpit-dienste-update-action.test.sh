#!/bin/bash
# ============================================================================
# cockpit-dienste-update-action.test.sh — offline harness for the typed
# server-dienste install helper (deploy/helpers/cockpit-dienste-update-action).
#
# Everything happens below one mktemp directory: a fixture repository with a
# stub runner, and a systemd-run stub that logs its arguments and runs the
# command in place. The harness refuses to run unless that directory is a
# fresh one below /tmp or /var/tmp, and it never writes anywhere else.
#
# Call (as root; the owner check needs root-owned fixture files):
#   sudo bash test/cockpit-dienste-update-action.test.sh
# ============================================================================
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$(cd "$HERE/.." && pwd)/deploy/helpers/cockpit-dienste-update-action"
[ "$(id -u)" -eq 0 ] || { echo "FEHLER: bitte als root: sudo bash $0" >&2; exit 2; }
[ -f "$HELPER" ] || { echo "FEHLER: $HELPER fehlt" >&2; exit 2; }

FIX="$(mktemp -d "${TMPDIR:-/tmp}/cockpit-dienste-test.XXXXXX")"
case "$FIX" in
  /tmp/cockpit-dienste-test.*|/var/tmp/cockpit-dienste-test.*) ;;
  *) echo "FEHLER: unerwartetes Fixture-Verzeichnis '$FIX'" >&2; exit 2 ;;
esac
[ -d "$FIX" ] && [ -z "$(ls -A "$FIX")" ] || { echo "FEHLER: Fixture nicht leer" >&2; exit 2; }
trap 'rm -rf -- "$FIX"' EXIT

mkdir -p "$FIX/repo/bin" "$FIX/repo/.git" "$FIX/stub"
chmod 750 "$FIX/repo"
cat > "$FIX/repo/bin/uebernehmen" <<'EOF'
import json, sys
print(json.dumps({"ok": True, "args": sys.argv[1:]}))
sys.exit(7 if sys.argv[1:2] == ["einspielen"] and sys.argv[3] == "f" * 64 else 0)
EOF
chmod 755 "$FIX/repo/bin/uebernehmen"
cat > "$FIX/stub/systemd-run" <<EOF
#!/bin/bash
echo "\$*" >> "$FIX/systemd-run.log"
while [ \$# -gt 0 ]; do case "\$1" in -p) shift 2 ;; --*) shift ;; *) break ;; esac; done
exec "\$@"
EOF
chmod 755 "$FIX/stub/systemd-run"

export COCKPIT_DIENSTE_REPO_DIR="$FIX/repo" COCKPIT_DIENSTE_SYSTEMD_RUN="$FIX/stub/systemd-run"
SHA=0123456789abcdef0123456789abcdef01234567
HASH=$(printf 'e%.0s' $(seq 64))
fails=0
check() { # check <name> <expected-exit> <args...>
  local name="$1" want="$2" got=0; shift 2
  bash "$HELPER" "$@" > "$FIX/out" 2> "$FIX/err" || got=$?
  if [ "$got" -ne "$want" ]; then echo "ROT  $name: exit $got statt $want ($(cat "$FIX/err"))"; fails=$((fails + 1)); else echo "GRÜN $name"; fi
}

check "status läuft den Runner mit stand" 0 status
grep -q '"args": \["stand"\]' "$FIX/out" || { echo "ROT  status-Argumente"; fails=$((fails + 1)); }
check "diff mit voller sha" 0 diff "$SHA"
grep -q "\"args\": \[\"diff\", \"$SHA\"\]" "$FIX/out" || { echo "ROT  diff-Argumente"; fails=$((fails + 1)); }
check "einspielen mit sha und Hash" 0 "$SHA" "$HASH"
grep -q "\"einspielen\", \"$SHA\", \"$HASH\"" "$FIX/out" || { echo "ROT  einspielen-Argumente"; fails=$((fails + 1)); }
check "Exit-Code des Runners kommt durch" 7 "$SHA" "$(printf 'f%.0s' $(seq 64))"
grep -q -- "--wait --collect --pipe" "$FIX/systemd-run.log" || { echo "ROT  systemd-run-Form"; fails=$((fails + 1)); }

check "nackte sha ohne Hash" 65 "$SHA"
check "kurze sha" 65 diff "${SHA:0:12}"
check "Großbuchstaben" 65 "${SHA^^}" "$HASH"
check "Hash zu kurz" 65 "$SHA" "${HASH:1}"
check "Zusatzargument" 64 "$SHA" "$HASH" --force
check "unbekannter Befehl" 64 restart
check "leer" 64

chmod 775 "$FIX/repo/bin"
check "Runner-Ordner gruppen-schreibbar" 67 status
chmod 755 "$FIX/repo/bin"
chown 65534 "$FIX/repo/bin/uebernehmen"
check "Runner gehört nicht root" 67 status
chown 0 "$FIX/repo/bin/uebernehmen"
mv "$FIX/repo/bin/uebernehmen" "$FIX/repo/bin/echt" && ln -s echt "$FIX/repo/bin/uebernehmen"
check "Runner als Symlink" 67 status

echo
[ "$fails" -eq 0 ] && echo "alles grün" || { echo "$fails rot"; exit 1; }
