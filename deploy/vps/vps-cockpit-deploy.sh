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
#     allowlisted repository (the runner verified it and the reviewed diff hash
#     before calling; this script checks the merge again).
#   * Checks the commit out on main, builds on the pinned Node runtime, installs
#     the helpers, the sudoers file (validated with visudo first), the self-update
#     unit template and this script itself, rebuilds the web container only when
#     its sources changed, and records state.json (deployed_commit, web_url).
#   * With COCKPIT_RESTART_MODE=defer the four services are NOT restarted: the
#     runner verifies and schedules the activation. Otherwise they restart now.
#   * Any failure before the state is written rolls the checkout, the build and
#     the installed helpers back to the previous commit and exits non-zero, so a
#     later restart never picks up a half-installed stand.
set -Eeuo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

readonly REPO=/opt/wireguard-ops-cockpit
readonly ORIGIN=https://github.com/JSchmid6/wireguard-ops-cockpit.git
readonly LIB=/usr/local/lib/wireguard-ops-cockpit
readonly SBIN=/usr/local/sbin
readonly STATE_DIR=/var/lib/wireguard-ops-cockpit/self-update
readonly CONFIG=/etc/wireguard-ops-cockpit/self-update.env
readonly WEB_URL=http://10.0.0.1:8080
readonly SERVICES=(wireguard-ops-cockpit-api wireguard-ops-cockpit-agent wireguard-ops-cockpit-executor wireguard-ops-cockpit-ttyd)

log() { echo "[vps-cockpit-deploy $(date -u +%H:%M:%S)] $*"; }
[ "$(id -u)" -eq 0 ] || { log "needs root"; exit 67; }
[[ "${REPO_COMMIT:-}" =~ ^[a-f0-9]{40}$ ]] || { log "REPO_COMMIT must be a full lowercase 40-hex sha"; exit 64; }
cd "$REPO"
[ "$(git remote get-url origin)" = "$ORIGIN" ] || { log "origin is not the allowlisted repository"; exit 65; }
git fetch --quiet origin
git merge-base --is-ancestor "$REPO_COMMIT" refs/remotes/origin/main || { log "$REPO_COMMIT is not merged into origin/main"; exit 65; }
readonly OLD="$(git rev-parse HEAD)"

build() {
  bin/with-runtime npm ci --no-audit --no-fund
  bin/with-runtime npm run build
}

install_helpers() {
  visudo -cf deploy/sudoers/cockpit-executor >/dev/null
  install -d -m 0700 -o root -g root "$STATE_DIR"
  install -d -m 0750 -o root -g root /var/log/wireguard-ops-cockpit-self-update
  install -o root -g root -m 440 deploy/sudoers/cockpit-executor /etc/sudoers.d/cockpit-executor
  visudo -c >/dev/null
  install -o root -g root -m 755 deploy/helpers/cockpit-capability-action "$LIB/cockpit-capability-action.mjs"
  install -o root -g root -m 644 deploy/helpers/cockpit-capability-action "$LIB/cockpit-capability-action"
  install -o root -g root -m 755 deploy/helpers/cockpit-service-action "$SBIN/cockpit-service-action"
  install -o root -g root -m 755 deploy/helpers/cockpit-dienste-update-action "$SBIN/cockpit-dienste-update-action"
  install -o root -g root -m 755 deploy/helpers/cockpit-self-update-action "$SBIN/cockpit-self-update-action"
  install -o root -g root -m 755 deploy/helpers/cockpit-self-update-run "$LIB/cockpit-self-update-run"
  install -o root -g root -m 755 deploy/vps/vps-cockpit-deploy.sh "$LIB/vps-cockpit-deploy.sh"
  install -o root -g root -m 644 deploy/systemd/wireguard-ops-cockpit-self-update@.service /etc/systemd/system/wireguard-ops-cockpit-self-update@.service
  if [ ! -e "$CONFIG" ]; then
    install -o root -g root -m 644 /dev/null "$CONFIG"
    printf '%s\n' "# VPS: the runner uses this deploy script and checks the web over WireGuard." \
      "COCKPIT_SELF_UPDATE_DEPLOY_SH=$LIB/vps-cockpit-deploy.sh" "COCKPIT_SELF_UPDATE_WG_IP=10.0.0.1" > "$CONFIG"
  fi
  systemctl daemon-reload
}

rollback() {
  local code=$?
  trap - ERR
  log "FAILED (exit $code) — rolling back to $OLD"
  git checkout -q -B main "$OLD" || true
  build >/dev/null 2>&1 || log "rollback build failed"
  install_helpers || log "rollback helper install failed"
  exit "$code"
}
trap rollback ERR

log "deploying $REPO_COMMIT over $OLD (restart mode: ${COCKPIT_RESTART_MODE:-now})"
git checkout -q -B main "$REPO_COMMIT"
build
install_helpers
if git diff --quiet "$OLD" "$REPO_COMMIT" -- apps/web docker-compose.vps.yml deploy/docker 2>/dev/null; then
  log "web unchanged, container kept"
else
  docker compose --env-file .env -f docker-compose.vps.yml up -d --build web
fi

python3 - "$STATE_DIR/state.json" "$REPO_COMMIT" "$OLD" "$WEB_URL" "${COCKPIT_SELF_UPDATE_SOURCE:-manual}" <<'PY'
import json, os, sys, datetime
path, sha, old, web, source = sys.argv[1:6]
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

if [ "${COCKPIT_RESTART_MODE:-now}" = "defer" ]; then
  log "services not restarted (defer): the self-update runner verifies and schedules the activation"
else
  systemctl restart "${SERVICES[@]}"
  log "services restarted"
fi
log "done: $REPO_COMMIT"
