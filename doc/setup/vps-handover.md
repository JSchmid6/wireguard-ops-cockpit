# VPS handover

Use this handover when a Copilot instance running on the VPS should bring the cockpit up locally.

## Scope

- the VPS-side Copilot instance builds and runs the repository locally on the host
- this handover does not bypass the existing trust boundary rules
- host privileges stay behind bounded helper scripts, approvals, and narrow `sudoers` rules

## Deployment artifacts

The VPS flow uses these repository files:

- `.env.vps.example` for production-oriented environment defaults
- `docker-compose.vps.yml` for the web container
- `Dockerfile.web` for the static web image
- `config/nginx.vps.conf` for `/api`, `/terminal`, and SPA reverse proxying
- `deploy/systemd/wireguard-ops-cockpit-api.service` for the host API
- `deploy/systemd/wireguard-ops-cockpit-ttyd.service` for the browser terminal bridge
- `deploy/sudoers/wireguard-ops-cockpit` for bounded host helper access
- `bin/*.sh` for the current bounded host helper scripts

## Prerequisites on the VPS

- Docker Engine with Compose support
- `tmux`
- `ttyd`
- local Node.js 20 runtime under `/opt/node-v20.19.1-linux-x64/`
- a checked out copy of this repository
- a WireGuard address that should be the only bind target for the web port
- an explicit admin password before the first start

## First bring-up

1. Copy the deployment env template.
2. Set `COCKPIT_ADMIN_PASSWORD`.
3. Set `COCKPIT_BIND_IP` to the VPS WireGuard IP, not `0.0.0.0`.
4. Set `COCKPIT_TMUX_MODE=auto`.
5. Set `COCKPIT_TTYD_BASE_URL=/terminal` and a unique `COCKPIT_TERMINAL_SIGNING_SECRET`.
6. If you terminate HTTPS in front of the stack, set `COCKPIT_COOKIE_SECURE=true`.
7. Install the systemd units and start the host services.
8. Build and start the web container.

```bash
cp .env.vps.example .env
install -m 644 deploy/systemd/wireguard-ops-cockpit-api.service /etc/systemd/system/
install -m 644 deploy/systemd/wireguard-ops-cockpit-ttyd.service /etc/systemd/system/
install -m 440 deploy/sudoers/wireguard-ops-cockpit /etc/sudoers.d/wireguard-ops-cockpit
systemctl daemon-reload
systemctl enable --now wireguard-ops-cockpit-api wireguard-ops-cockpit-ttyd
docker compose --env-file .env -f docker-compose.vps.yml up -d --build web
```

## Verification

Run these checks on the VPS after startup:

```bash
docker compose --env-file .env -f docker-compose.vps.yml ps
docker compose --env-file .env -f docker-compose.vps.yml logs --tail=100 web
systemctl status wireguard-ops-cockpit-api wireguard-ops-cockpit-ttyd
curl -fsS http://127.0.0.1:7681/terminal/
curl -fsS http://127.0.0.1:3001/api/health
```

Expected result:

- `web` is running and bound only to the configured WireGuard IP and port
- `wireguard-ops-cockpit-api` is healthy on `127.0.0.1:3001`
- `wireguard-ops-cockpit-ttyd` is healthy on `127.0.0.1:7681`
- `/api/health` returns `{"ok":true,...}`

## Update flow

For a later rollout on the same VPS:

```bash
git pull --ff-only
export PATH=/opt/node-v20.19.1-linux-x64/bin:$PATH
npm ci --no-audit --no-fund
npm run build
systemctl restart wireguard-ops-cockpit-api wireguard-ops-cockpit-ttyd
docker compose --env-file .env -f docker-compose.vps.yml up -d --build web
```

SQLite state persists in `/var/lib/wireguard-ops-cockpit/cockpit.sqlite`.

## Operator notes

- the web container is the only network-facing cockpit component and binds only to the WireGuard IP
- the API and ttyd stay on localhost and are reached only through the local reverse proxy
- `COCKPIT_TTYD_BASE_URL=/terminal` is the expected host-runtime setting
- this stack is meant for WireGuard-restricted reachability first; do not widen it to the public Internet as a shortcut

## Prompt for the VPS-side Copilot instance

Use a prompt in this shape on the VPS side:

```text
Read doc/setup/vps-handover.md and bring up the cockpit from this repository.
Use .env.vps.example for the host runtime settings and docker-compose.vps.yml for the web container.
Set COCKPIT_BIND_IP to the VPS WireGuard IP, keep API and ttyd on localhost, and stop after reporting health for web, API, and ttyd.
Do not widen exposure beyond the WireGuard interface.
```
