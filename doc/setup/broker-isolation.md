# Broker identity isolation

Production uses three Unix identities and two non-network Unix sockets.

## Identities and groups

- `wgops`: Control API; supplementary member of both client groups
- `cockpit-agent`: primary group `cockpit-agent-client`; no sudo
- `cockpit-executor`: primary group `cockpit-executor-client`; only the static service helper and signed capability sandbox launcher in sudoers

Never add `cockpit-agent` to `cockpit-executor-client` or grant it access to Control storage.

## Secret placement

- `/etc/wireguard-ops-cockpit/api.env`: envelope and executor-client secrets; no provider key
- `/etc/wireguard-ops-cockpit/agent.env`: provider key and model selection only
- `/etc/wireguard-ops-cockpit/executor.env`: executor broker secret only

All three files are `root:root` mode `0600`. systemd reads them before dropping identity.

## Installed files

- `deploy/systemd/wireguard-ops-cockpit-agent.service`
- `deploy/systemd/wireguard-ops-cockpit-executor.service`
- `deploy/systemd/wireguard-ops-cockpit-api-brokers.conf`
- `deploy/helpers/cockpit-service-action`
- `deploy/helpers/cockpit-capability-action` (installed root-owned as `/usr/local/lib/wireguard-ops-cockpit/cockpit-capability-action.mjs` and pinned to the production Node 20 runtime)
- `deploy/sudoers/cockpit-executor`

Helpers must be root-owned and not writable by service identities; the sudoers file must be root-owned and mode `0440`. Run `visudo -cf /etc/sudoers` before restarting the Executor. The dynamic helper independently verifies Control's execution-envelope HMAC, so compromise of the Executor identity alone cannot mint authority.

Pre-change snapshots live under `/var/lib/wireguard-ops-cockpit/capability-snapshots`, a root-only path made writable only inside the Executor service mount namespace. Control retains independently verified manifests separately under `capabilities/`.

## Verification

Verify both isolation flags, distinct socket groups, and secret separation. Test the dynamic path with a signed network-free read-only manifest such as `/usr/bin/true`; never use a mutation merely as a deployment test.
