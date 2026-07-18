# Broker identity isolation

Production uses three Unix identities and two non-network Unix sockets.

## Identities and groups

- `wgops`: Control API; supplementary member of both client groups
- `cockpit-agent`: primary group `cockpit-agent-client`; no sudo
- `cockpit-executor`: primary group `cockpit-executor-client`; only the static service helper in sudoers

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
- `deploy/sudoers/cockpit-executor`

The helper must be root-owned and mode `0755`; its sudoers file must be root-owned and mode `0440`. Run `visudo -cf /etc/sudoers` before restarting the Executor.

## Verification

Verify that health reports both isolation flags, sockets have distinct groups, the Agent cannot read SQLite or the Executor socket, Control has no provider key, and the Executor has no provider key. A safe end-to-end test uses `service.status`; never use `service.restart` merely as a deployment test.
