#!/bin/bash
# vps-cockpit-deploy.sh — the reviewed deploy script of the Cockpit on the VPS
# (Contabo vmd61162, WireGuard 10.0.0.1). Counterpart of Lab0's
# homeserver-cockpit-deploy.sh for the self-update runner.
#
# Called by cockpit-self-update-run (via /etc/wireguard-ops-cockpit/self-update.env,
# COCKPIT_SELF_UPDATE_DEPLOY_SH) with REPO_COMMIT=<sha> and
# COCKPIT_RESTART_MODE=defer, or once by hand as root to install the module.
#
# Contract:
#   * REPO_COMMIT is a full lowercase sha merged into origin/main of the
#     allowlisted repository (the runner verified it and the reviewed diff hash;
#     this script checks the merge again).
#   * It checks the commit out on main, builds on the pinned Node runtime, builds
#     the web image (always; the Docker cache makes an unchanged build cheap, and a
#     trigger list would silently miss build inputs), and installs EVERY file of
#     the table below — the complete set of root helpers the executor and the
#     capability sandbox dispatch to, the sudoers file (visudo-checked), the four
#     service units, the web unit, the self-update unit template, self-update.env
#     and this script. Besides the table it writes only state.json, the web image,
#     the web unit's enable link and a backup directory that it removes on success.
#   * It never switches the running web container: the web unit does that when it
#     is restarted, which the runner does together with the four services at the
#     activation (defer), or this script does at the end (mode now).
#   * Before installing, every target is saved (or recorded as absent). Any
#     failure until state.json is written restores exactly those bytes, checks the
#     old commit out again and rebuilds it; each step of that rollback is logged,
#     and the script exits non-zero with the original error code.
#
# Harness hooks (VPS_DEPLOY_ROOT, _REPO, _ORIGIN, _SYSTEMCTL, _VISUDO, _DOCKER,
# _BUILD) redirect host paths and tools for test/vps-cockpit-deploy.test.sh. The
# self-update runner starts this script with a fixed, clean environment (PATH,
# HOME, REPO_COMMIT, COCKPIT_RESTART_MODE), so they never apply on that path.
set -Eeuo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

readonly ROOT="${VPS_DEPLOY_ROOT:-}"
readonly REPO="${VPS_DEPLOY_REPO:-/opt/wireguard-ops-cockpit}"
readonly ORIGIN="${VPS_DEPLOY_ORIGIN:-https://github.com/JSchmid6/wireguard-ops-cockpit.git}"
readonly SYSTEMCTL="${VPS_DEPLOY_SYSTEMCTL:-systemctl}"
readonly VISUDO="${VPS_DEPLOY_VISUDO:-visudo}"
readonly DOCKER="${VPS_DEPLOY_DOCKER:-docker}"
readonly LIB="$ROOT/usr/local/lib/wireguard-ops-cockpit"
readonly SBIN="$ROOT/usr/local/sbin"
readonly UNITS="$ROOT/etc/systemd/system"
readonly SUDOERS="$ROOT/etc/sudoers.d/cockpit-executor"
readonly STATE_DIR="$ROOT/var/lib/wireguard-ops-cockpit/self-update"
readonly CONFIG="$ROOT/etc/wireguard-ops-cockpit/self-update.env"
readonly WEB_URL=http://10.0.0.1:8080
readonly SERVICES=(wireguard-ops-cockpit-api wireguard-ops-cockpit-agent wireguard-ops-cockpit-executor wireguard-ops-cockpit-ttyd wireguard-ops-cockpit-web)
readonly COMPOSE=("$DOCKER" compose --env-file .env -f docker-compose.vps.yml)

# source (repo) | target (host) | mode — the whole footprint of this script.
readonly TABLE=(
  "deploy/helpers/cockpit-capability-action|$LIB/cockpit-capability-action.mjs|755"
  "deploy/helpers/cockpit-hermes-skill-action|$LIB/cockpit-hermes-skill-action|644"
  "deploy/helpers/cockpit-email-archive-deploy|$LIB/cockpit-email-archive-deploy|644"
  "deploy/helpers/nextcloud-context-test-file.php|$LIB/nextcloud-context-test-file.php|644"
  "deploy/helpers/nextcloud-exapp-catalog-refresh.php|$LIB/nextcloud-exapp-catalog-refresh.php|644"
  "deploy/helpers/nextcloud-exapp-reinitialize.php|$LIB/nextcloud-exapp-reinitialize.php|644"
  "deploy/helpers/cockpit-self-update-run|$LIB/cockpit-self-update-run|755"
  "ops/cockpit-vps-snapshot|$LIB/cockpit-vps-snapshot|644"
  "deploy/vps/vps-cockpit-deploy.sh|$LIB/vps-cockpit-deploy.sh|755"
  "deploy/helpers/cockpit-service-action|$SBIN/cockpit-service-action|755"
  "deploy/helpers/cockpit-disk-action|$SBIN/cockpit-disk-action|755"
  "deploy/helpers/cockpit-exact-file-replace|$SBIN/cockpit-exact-file-replace|755"
  "deploy/helpers/cockpit-nextcloud-app-action|$SBIN/cockpit-nextcloud-app-action|755"
  "deploy/helpers/cockpit-nextcloud-context-action|$SBIN/cockpit-nextcloud-context-action|755"
  "deploy/helpers/cockpit-email-archive-auto-deploy|$SBIN/cockpit-email-archive-auto-deploy|755"
  "deploy/helpers/cockpit-dienste-update-action|$SBIN/cockpit-dienste-update-action|755"
  "deploy/helpers/cockpit-self-update-action|$SBIN/cockpit-self-update-action|755"
  "ops/cockpit-wordpress-update|$SBIN/cockpit-wordpress-update|755"
  "deploy/sudoers/cockpit-executor|$SUDOERS|440"
  "deploy/systemd/wireguard-ops-cockpit-api.service|$UNITS/wireguard-ops-cockpit-api.service|644"
  "deploy/systemd/wireguard-ops-cockpit-agent.service|$UNITS/wireguard-ops-cockpit-agent.service|644"
  "deploy/systemd/wireguard-ops-cockpit-executor.service|$UNITS/wireguard-ops-cockpit-executor.service|644"
  "deploy/systemd/wireguard-ops-cockpit-ttyd.service|$UNITS/wireguard-ops-cockpit-ttyd.service|644"
  "deploy/systemd/wireguard-ops-cockpit-self-update@.service|$UNITS/wireguard-ops-cockpit-self-update@.service|644"
  "deploy/systemd/email-archive-auto-deploy.service|$UNITS/email-archive-auto-deploy.service|644"
  "deploy/systemd/email-archive-auto-deploy.timer|$UNITS/email-archive-auto-deploy.timer|644"
  "deploy/vps/wireguard-ops-cockpit-web.service|$UNITS/wireguard-ops-cockpit-web.service|644"
)

log() { echo "[vps-cockpit-deploy $(date -u +%H:%M:%S)] $*"; }
[ "$(id -u)" -eq 0 ] || { log "needs root"; exit 67; }
[[ "${REPO_COMMIT:-}" =~ ^[a-f0-9]{40}$ ]] || { log "REPO_COMMIT must be a full lowercase 40-hex sha"; exit 64; }
cd "$REPO"
[ "$(git remote get-url origin)" = "$ORIGIN" ] || { log "origin is not the allowlisted repository"; exit 65; }
git fetch --quiet origin
git merge-base --is-ancestor "$REPO_COMMIT" refs/remotes/origin/main || { log "$REPO_COMMIT is not merged into origin/main"; exit 65; }
readonly OLD="$(git rev-parse HEAD)"
install -d -m 0700 "$ROOT/var/lib/wireguard-ops-cockpit"
BACKUP="$(mktemp -d "$ROOT/var/lib/wireguard-ops-cockpit/deploy-backup.XXXXXX")"
readonly BACKUP
INSTALLED=0

build() {
  # Explicit status: a bare `return` in a function called from the ERR-trap rollback
  # returns the status of the command that fired the trap, not of the last command.
  if [ -n "${VPS_DEPLOY_BUILD:-}" ]; then bash -c "$VPS_DEPLOY_BUILD"; return $?; fi
  bin/with-runtime npm ci --no-audit --no-fund
  bin/with-runtime npm run build
}

self_update_env() { # the runner's configuration on this host
  printf '%s\n' "# Managed by vps-cockpit-deploy.sh — the runner's settings on the VPS." \
    "COCKPIT_SELF_UPDATE_DEPLOY_SH=/usr/local/lib/wireguard-ops-cockpit/vps-cockpit-deploy.sh" \
    "COCKPIT_SELF_UPDATE_WG_IP=10.0.0.1" \
    "COCKPIT_SELF_UPDATE_SERVICES=${SERVICES[*]}"
}

save_targets() { # every target: its bytes, or the fact that it did not exist
  local entry target index=0
  for entry in "${TABLE[@]}" "self-update.env|$CONFIG|644"; do
    target="${entry#*|}"; target="${target%|*}"
    if [ -e "$target" ]; then cp -a -- "$target" "$BACKUP/$index"; else : > "$BACKUP/$index.absent"; fi
    index=$((index + 1))
  done
}

install_table() {
  local entry source rest target mode
  "$VISUDO" -cf deploy/sudoers/cockpit-executor >/dev/null
  for entry in "${TABLE[@]}"; do
    source="${entry%%|*}"; rest="${entry#*|}"; target="${rest%|*}"; mode="${rest##*|}"
    install -D -o root -g root -m "$mode" "$source" "$target"
  done
  install -d -m 0755 -o root -g root "$(dirname "$CONFIG")"
  self_update_env > "$BACKUP/self-update.env.new"
  install -o root -g root -m 644 "$BACKUP/self-update.env.new" "$CONFIG"
  "$VISUDO" -c >/dev/null
  "$SYSTEMCTL" daemon-reload
  "$SYSTEMCTL" enable --quiet wireguard-ops-cockpit-web.service
}

restore_targets() { # exactly the saved bytes back; files that did not exist go away
  local entry target index=0 failures=0
  for entry in "${TABLE[@]}" "self-update.env|$CONFIG|644"; do
    target="${entry#*|}"; target="${target%|*}"
    if [ -e "$BACKUP/$index.absent" ]; then
      rm -f -- "$target" || { log "rollback: could not remove $target"; failures=$((failures + 1)); }
    elif [ -e "$BACKUP/$index" ]; then
      cp -a -- "$BACKUP/$index" "$target" || { log "rollback: could not restore $target"; failures=$((failures + 1)); }
    fi
    index=$((index + 1))
  done
  return "$failures"
}

rollback() {
  local code=$? step_failed=0
  trap - ERR
  set +e
  log "FAILED (exit $code) — rolling back to $OLD"
  if [ "$INSTALLED" = 1 ]; then
    if restore_targets; then log "rollback: installed files restored"; else log "rollback: restoring installed files FAILED"; step_failed=1; fi
    "$VISUDO" -c >/dev/null 2>&1 || { log "rollback: sudoers check FAILED after restore"; step_failed=1; }
    if [ ! -e "$UNITS/wireguard-ops-cockpit-web.service" ]; then
      rm -f -- "$UNITS/multi-user.target.wants/wireguard-ops-cockpit-web.service" || step_failed=1
    fi
    "$SYSTEMCTL" daemon-reload || { log "rollback: daemon-reload FAILED"; step_failed=1; }
  fi
  if git checkout -q -B main "$OLD"; then log "rollback: checkout back at $OLD"; else log "rollback: checkout of $OLD FAILED"; step_failed=1; fi
  if build >/dev/null 2>&1; then log "rollback: old build ok"; else log "rollback: old build FAILED"; step_failed=1; fi
  [ "$step_failed" = 0 ] && log "rollback complete; running services were not restarted" || log "rollback INCOMPLETE — see the lines above"
  exit "$code"
}
trap rollback ERR

log "deploying $REPO_COMMIT over $OLD (restart mode: ${COCKPIT_RESTART_MODE:-now}, backup $BACKUP)"
git checkout -q -B main "$REPO_COMMIT"
build
"${COMPOSE[@]}" build web
save_targets
INSTALLED=1
install_table

python3 - "$STATE_DIR/state.json" "$REPO_COMMIT" "$OLD" "$WEB_URL" "${COCKPIT_SELF_UPDATE_SOURCE:-manual}" <<'PY'
import json, os, sys, datetime
path, sha, old, web, source = sys.argv[1:6]
os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
try:
    with open(path, encoding="utf-8") as handle:
        state = json.load(handle)
except (FileNotFoundError, ValueError):
    state = {}
state.update({"version": 1, "deployed_commit": sha, "previous_commit": old if old != sha else state.get("previous_commit"),
              "web_url": web, "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
              "updated_by": source})
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as handle:
    json.dump(state, handle, indent=1)
os.chmod(tmp, 0o600)
os.replace(tmp, path)
PY
trap - ERR
rm -rf -- "$BACKUP"

if [ "${COCKPIT_RESTART_MODE:-now}" = "defer" ]; then
  log "services and web not restarted (defer): the runner verifies, then restarts ${SERVICES[*]}"
else
  "$SYSTEMCTL" restart "${SERVICES[@]}"
  log "services and web restarted"
fi
log "done: $REPO_COMMIT"
