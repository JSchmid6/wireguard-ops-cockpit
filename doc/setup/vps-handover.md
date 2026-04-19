# VPS handover

Use this handover when a Copilot instance running on the VPS should bring the cockpit up locally.

## Scope

- the VPS-side Copilot instance builds and runs the repository locally on the host
- this handover does not bypass the existing trust boundary rules
- host privileges remain outside the app until a separate bounded helper path exists

## Deployment artifacts

The VPS flow uses these repository files:

- `.env.vps.example` for production-oriented environment defaults
- `docker-compose.vps.yml` for the app stack
- `Dockerfile.api` for the Fastify API image
- `Dockerfile.web` for the static web image
- `config/nginx.vps.conf` for `/api` reverse proxying and SPA fallback

## Prerequisites on the VPS

- Docker Engine with Compose support
- a checked out copy of this repository
- a WireGuard address that should be the only bind target for the web port
- an explicit admin password before the first start

## First bring-up

1. Copy the deployment env template.
2. Set `COCKPIT_ADMIN_PASSWORD`.
3. Set `COCKPIT_BIND_IP` to the VPS WireGuard IP, not `0.0.0.0`.
4. Leave `COCKPIT_TMUX_MODE=disabled` unless you have a separate local integration path ready.
5. If you terminate HTTPS in front of the stack, set `COCKPIT_COOKIE_SECURE=true`.
6. Build and start the stack.

```bash
cp .env.vps.example .env
docker compose --env-file .env -f docker-compose.vps.yml build --pull
docker compose --env-file .env -f docker-compose.vps.yml up -d
```

## Verification

Run these checks on the VPS after startup:

```bash
docker compose --env-file .env -f docker-compose.vps.yml ps
docker compose --env-file .env -f docker-compose.vps.yml logs --tail=100 api web
curl -fsS http://127.0.0.1:3001/api/health
```

Expected result:

- `api` is healthy
- `web` is running and bound only to the configured WireGuard IP and port
- `/api/health` returns `{"ok":true,...}`

## Update flow

For a later rollout on the same VPS:

```bash
git pull --ff-only
docker compose --env-file .env -f docker-compose.vps.yml build --pull
docker compose --env-file .env -f docker-compose.vps.yml up -d
```

SQLite state persists in the named Docker volume `cockpit-data`.

## Operator notes

- the web container is the only published port in this stack
- the API stays on the internal Compose network behind the web proxy
- `COCKPIT_TTYD_BASE_URL` stays optional and should point at a separately managed terminal bridge if you have one
- this stack is meant for WireGuard-restricted reachability first; do not widen it to the public Internet as a shortcut

## Prompt for the VPS-side Copilot instance

Use a prompt in this shape on the VPS side:

```text
Read doc/setup/vps-handover.md and bring up the cockpit from this repository.
Use docker-compose.vps.yml with a local .env copied from .env.vps.example.
Set COCKPIT_BIND_IP to the VPS WireGuard IP, keep COCKPIT_TMUX_MODE=disabled, and stop after reporting container health plus the final bound address.
Do not widen exposure beyond the WireGuard interface.
```
