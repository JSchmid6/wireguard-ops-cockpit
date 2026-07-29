## Authoritative Hermes VPS context

This is a bare-metal Ubuntu VPS. Nextcloud 34 is installed at `/var/www/nextcloud` with data below `/opt/nextcloud`; its primary MariaDB and Redis are host services. App-specific Nextcloud configuration commonly lives in the database and is not expected in `config.php`. Absence from `config.php` is not evidence that an app or deploy daemon is unconfigured.

Nextcloud AppAPI `app_api` has a configured HaRP `docker-install` deploy daemon named `appapi_harp`. Its bundled Docker-socket FRP proxy uses port `24000` on the private AppAPI network; historical port `24001`, manual-install, Socat, and direct-proxy workarounds are incorrect. AppAPI-managed ExApps use direct private networking and must not publish unnecessary host ports.

The bare-metal Nextcloud TLS hostname `nextcloud.wejos.de` resolves locally to the private `nextcloud-appapi_default` bridge gateway `172.22.0.1`, not loopback. ExApps in direct HaRP mode must reach the host Apache virtual host through that private gateway; resolving the hostname to `127.0.0.1` makes every ExApp call its own container loopback. The bridge is an internal route and does not publish an additional host port.

Context Chat 5.4 uses pull-based continuous indexing; `context_chat:scan` no longer exists. Its initial queue is processed by ascending queue id, so a newly created E2E marker is not immediately searchable while a large historical queue is draining. Do not manipulate queue ids or query the Nextcloud database to make a test appear complete. Use `context_chat:stats`, preserve the marker for human inspection, and verify retrieval after normal indexing reaches it.

The Email Archive ExApp is AppAPI-managed as `nc_app_email_archive` with no published host port. This proves that the HaRP/AppAPI lifecycle is operational; do not infer otherwise from PHP app directories or `config.php`. The archive source of record is `/home/hermes/.hermes/email-archive`.

ExApps are AppAPI-managed containers and need not appear below a local `apps-external` directory. An empty or absent directory is not evidence that no ExApps are installed or operational.

Hermes runs separately in a container with host networking. Cockpit is the administration control plane. Its planner runs as a read-only systemd-sandboxed identity; signed mutations run through a separate executor sandbox. Visible Docker processes can belong to unrelated services.

For inventory claims, distinguish direct observation, authoritative context, and unverified inference. If they conflict, report the conflict and request a focused live check; never silently replace authoritative deployment facts with an inference from a missing file entry.

Direct MariaDB/MySQL queries are forbidden for every role, including read-only verification. Never read database credentials from Nextcloud `config.php`. Verify Nextcloud lifecycle state through TLS APIs or the semantic `cockpit-nextcloud-app-action` status modes.
