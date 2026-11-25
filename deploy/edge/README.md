# Edge host (legend-svy91)

An outlet edge host is a mini PC that runs the Legend API with `EDGE_MODE=true`
so attendance keeps working when the internet is down. This folder holds the
host requirements, example configuration and a read-only preflight check. Design
background: `docs/design/hris-edge-replication.md`.

## Files

- `check-edge-host.sh`: read-only preflight; exits 1 on any FAIL. Run it as root or the service user so every selfie folder can be inspected. With `--web-env-file` (and `--web-output`) it also checks the web env file, the web build and, in the API env file, the one-origin settings below.
- `test-check-edge-host.sh`: stubbed test for the preflight (`sh deploy/edge/test-check-edge-host.sh`).
- `check-edge-replication.sh`, `test-check-edge-replication.sh`: read-only preflight for LAN standby replication (see "Standby replication"); the test runs with `sh deploy/edge/test-check-edge-replication.sh`.
- `edge-replication-watchdog.sh`, `legend-edge-replication-watchdog.service`, `test-edge-replication-watchdog.sh`: primary-side switch to async commit when the standby is gone for 10 s.
- `postgresql-edge-primary.conf.example`, `postgresql-edge-standby.conf.example`, `pg_hba-edge-replication.conf.example`: replication settings, without any secret.
- `chrony.conf.example`: NTP client configuration.
- `Caddyfile.edge.example`: HTTPS front for outlet devices.
- `legend-edge.service`: example systemd unit (`Restart=always`), required when `EDC_AGENT_ENABLED=true`.
- `legend-edge-worker.service`: the edge worker (`dist/worker.js`, `EDGE_MODE=true`): print queue and edge sweeps; needs `WORKER_DATABASE_URL` in the env file.
- `legend-edge-web.service`: the web app on loopback port 3000; Caddy serves it and `/api/*` from one HTTPS origin.
- `check-image-version.mjs`: Validates the edge image release version at build time.

Build the web app once for every edge host with
`docker build -f apps/web/Dockerfile --target edge --build-arg VITE_API_URL=same-origin -t legend-edge-web .`.
`same-origin` makes the browser call the origin that served the page (the edge
HTTPS name); the web server calls `API_INTERNAL_URL` (`http://127.0.0.1:4000`,
set by the unit). Links in server-rendered pages stay relative (`/api/...`), so
the loopback address never reaches a device.

Build the edge image from the repository root with
`docker build -f apps/api/Dockerfile --target edge -t legend-edge .`.
The edge target's `EDGE_NODE_VERSION` build argument is the release version
reported to the cloud; its default in the Dockerfile is the source of truth.
Use `--build-arg EDGE_NODE_VERSION=<release>` when building a different
release. The build rejects missing, invalid, prerelease, or pre-0.2.0 versions.
Do not override `EDGE_NODE_VERSION` at runtime with a different value. Run
`sh deploy/edge/test-image-version.sh` to check the validator without Docker.

## Host requirements

| Area      | Requirement                                                                                                                                                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clock     | chrony (or another NTP client) synchronised. The edge and staff phones must agree within one 30 s QR window. Offset above 2 s warns, above 10 s fails.                                                                                         |
| Selfies   | `EDGE_SELFIE_DIR` (default `/var/lib/legend/edge-selfies`, a Docker volume) owned by the service user, mode 0700. Files and tenant folders are never group or other readable.                                                                  |
| Space     | Free space of at least the remaining quota (`EDGE_SELFIE_MAX_BYTES`, default 2 GiB, about 7000 selfies, minus the bytes already stored in `.lss` files) plus a 512 MiB margin. Over the limit the edge answers 507 `EDGE_SELFIE_STORAGE_FULL`. |
| HTTPS     | Outlet devices reach the edge over HTTPS with a certificate from your internal CA, because the camera needs a secure context. The check fails when the certificate expires within 30 days.                                                     |
| Disk      | Full-disk encryption with TPM unlock (Linux: LUKS; macOS: FileVault). The check covers both the selfie volume and the root volume. Defense in depth, mandatory if the AES fallback is used.                                                    |
| Seal keys | The edge env file must NOT set `ATTENDANCE_SELFIE_SEAL_KEYS` or `ATTENDANCE_SELFIE_SEAL_ACTIVE_KID`. These are cloud-only private keys.                                                                                                        |

The edge seals selfies with the cloud public key, which arrives in the people
snapshot; nothing needs to be placed on the edge disk by hand. Production key
steps live in `docs/deployment.md`, section "Attendance selfie seal key".

An outage longer than `EDGE_QR_KEY_DAYS_AHEAD` days (default 3) stops the QR
screen, because the edge only holds today plus that many day keys.

## Setup order

1. Install the OS with full-disk encryption and TPM unlock.
2. Install chrony, copy `chrony.conf.example` to `/etc/chrony/chrony.conf`, adjust the pool, restart chrony.
3. Create the service user and the selfie volume directory with mode 0700 owned by that user. Also create `EDGE_STATE_DIR` (default `/var/lib/legend/edge-state`, owned by the service user, mode 0700, a volume of its own) for the owner alarm queue; `check-edge-host.sh` fails when it is missing, not 0700 or not owned by the service user.
4. Issue a certificate for the edge name from the internal CA, install it where `Caddyfile.edge.example` expects it, and trust the CA on every outlet device.
5. Write the edge env file (`EDGE_MODE=true`, `EDGE_CLOUD_URL`, `EDGE_NODE_CREDENTIAL`; see `.env.example`). Do not set the seal private key variables. Set `TRUST_PROXY=1` (Caddy is the one proxy in front of the API; without it every outlet device shares one per-IP rate-limit bucket). Set `WEB_URL` and `BETTER_AUTH_URL` to the edge origin and leave `TRUSTED_ORIGINS` and `COOKIE_DOMAIN` empty. Write `/etc/legend/edge/web.env` and place the web build (see "Web app, origin and env files").
6. Run the preflight and fix every FAIL:

   ```sh
   sh deploy/edge/check-edge-host.sh --env-file /etc/legend/edge/api.env \
     --service-user legend --cert /etc/legend/edge/tls/edge.crt \
     --web-env-file /etc/legend/edge/web.env
   ```

7. Start the API, worker, web app and Caddy (`systemctl enable --now legend-edge legend-edge-worker legend-edge-web`), then confirm `GET /api/edge/health` over HTTPS.

## Web app, origin and env files

The web app is the `.output` folder of the edge web image. The unit runs it with
the host's Node (use the image's Node major, 22), so put the folder where the
unit expects it, next to the API build under `/opt/legend`:

```sh
id=$(docker create legend-edge-web)
docker cp "$id":/app/.output /opt/legend/apps/web/.output
docker rm "$id"
chown -R legend:legend /opt/legend/apps/web/.output
```

Replace the folder on every web release, then `systemctl restart legend-edge-web`.

`/etc/legend/edge/web.env` (mode 0600, owner the service user) is read by
`legend-edge-web.service`. It holds only:

- `DEPLOYMENT_MODE` and `DATA_CLASSIFICATION` (same values as the API; the web server refuses to start without them; `EDGE_MODE=true` comes from the unit).
- `SSR_SHARED_SECRET`, only if the API env file sets the same value (it lets the API rate-limit each device, not the web server).

Never put `DATABASE_URL`, `BETTER_AUTH_SECRET`, `EDGE_NODE_CREDENTIAL` or the seal
keys in it; the preflight fails when it finds one.

One origin: in the API env file (`api.env`) set `WEB_URL` and `BETTER_AUTH_URL`
to the same edge HTTPS origin (the name in the Caddyfile and certificate), and
leave `TRUSTED_ORIGINS` and `COOKIE_DOMAIN` empty. The session cookie then
stays on the edge host and no other origin may call the API with cookies. The
defaults point at localhost, so a missing value is a FAIL in the preflight.

## Database migrations

Run the migrator (`node dist/migrate.js`) on the edge database with
`EDGE_MODE=true` in its environment, never with a copy of the cloud
environment file. Edge mode skips the `modifiers.recipe_id` foreign key
(migration 0374): modifiers are tenant-level but an edge only receives the
recipes of its own brand, so the key would refuse the modifiers page of any
modifier that points at another brand's recipe.

## Local audit retention login

The edge API runs audit retention against its own PostgreSQL database. After
applying the database migrations, provision a dedicated
`legend_maint_<16 hex>` login on that local database, with a separate password
and membership only in `legend_maintenance`. The login must inherit that role,
own no objects, have no table or sequence privileges, and have neither superuser
nor `BYPASSRLS`. Its only maintenance operations are
`app.audit_retention_due_tenants()` and `app.purge_audit_retention_batch()`.
Do not reuse the application, queue, migration-owner, or cloud database login.

Set `MAINTENANCE_DATABASE_URL` in the private edge API env file, pointing to
the same local host, port and database as the edge application connection, with
that maintenance login. Keep its value readable only by the service user and
never print it in logs or commit it. The cloud single-VM provisioning wrapper
has a different env-file contract: it forbids this key in the cloud API env
file. Do not run that wrapper against the edge API env file.

The edge validates a configured URL before starting runtime components, then
probes the connection and maintenance identity at the end of initialization.
An invalid URL, connection, or role refuses startup; a failed probe shuts down
the components already started. If the key is absent or blank, startup
continues so offline POS remains available. Audit purge is skipped, an error
is logged locally, and the heartbeat reports the missing configuration for an
owner alarm once it reaches the cloud. During an outage, the local operator
must act on the startup error; a cloud alarm cannot arrive while offline.
Provision the login and restart the edge API to restore the daily purge.
Until then, expired audit rows stay in the local database.

The host preflight warns without failing when this key is missing. Its
configured check confirms presence only; the runtime probe verifies the
connection and restricted permissions.

### Rollout order for maintenance alarms

Deploy the G5b cloud build that accepts the optional maintenance-alarm
heartbeat field before this edge build. The new cloud accepts older edge
heartbeats. An edge without `MAINTENANCE_DATABASE_URL` sends the new field;
an older cloud rejects that heartbeat because its schema is strict. Edges
with a valid maintenance URL omit the field. Keep local startup-error
monitoring in place, including during the upgrade and offline operation.

### Image version and the queue placeholder (legend-3k41y)

Set `EDGE_NODE_VERSION` to the image's semver tag when the image is built or
deployed (for example `0.2.0`). It defaults to `dev`, and a version that is
not plain semver never triggers the cloud's warning. Edge images must be
`>= EDGE_LINK_PLACEHOLDER_MIN_VERSION` (`packages/shared/src/edge/link-dead-letter.ts`)
before a cloud that replaces stale catalog rows with the
`edge_link.dead_lettered` no-op is released; an older edge cannot classify it
and its batches stall. See `docs/deployment.md`, section "Edge host".

## Standby replication (1269 F11a)

A second mini PC on the outlet LAN keeps a streaming copy of the edge database
so a failure of the primary loses no sale. The standby runs PostgreSQL only;
promotion is manual and is not part of this folder (card F11b).

1. Primary: include `postgresql-edge-primary.conf.example` and add the line of `pg_hba-edge-replication.conf.example` with the standby address (one `/32`). Create a login that is only for replication (`CREATE ROLE edge_replicator LOGIN REPLICATION PASSWORD ...` typed on the host, never in a file in the repository) and a physical slot (`SELECT pg_create_physical_replication_slot('edge_standby_slot')`).
2. TLS: the primary server certificate comes from the internal CA and its name or address must match `host=` in `primary_conninfo` (`sslmode=verify-full`). Copy only the CA certificate to the standby.
3. Standby: take the base copy over TLS (`pg_basebackup -R -S edge_standby_slot` with the same `sslmode` and `passfile`), keep the settings of `postgresql-edge-standby.conf.example`, and put the password only in the passfile (mode 0600, owned by postgres). Leave `legend-edge`, `legend-edge-worker` and `legend-edge-web` stopped and disabled.
4. Primary: install `legend-edge-replication-watchdog.service` (adapt `postgresql@16-main` to the cluster name on Debian and Ubuntu; systemd creates its state directory). Commits wait for the standby (synchronous). When no synchronous standby has streamed for 10 s the watchdog writes the async flag and the value to restore to disk (fsync) and only then switches to async, logging `ALARM`. It restores synchronous commit when a standby named in the saved value has caught up, but the flag is never deleted automatically: it moves to `status=recovered-awaiting-reconcile`. Open bills stay locked until they are matched with the cloud (F11b), which then runs `edge-replication-watchdog.sh --state-dir ... --ack-reconciled`. Async mode that the watchdog did not start is `async-unknown`: it alarms, writes the flag and is never restored automatically. A restart of the watchdog restarts the 10 s clock.
5. `max_slot_wal_keep_size` (20GB in the example) stops a long outage from filling the primary disk; the preflight requires it. The watchdog raises `ALARM` when the slot becomes `unreserved` or `lost`: the standby then needs a new base copy.
6. Run the preflight on each host and fix every FAIL (it fails closed, and never prints a setting value):

   ```sh
   sh deploy/edge/check-edge-replication.sh --role primary --conf /etc/postgresql/edge-primary.conf \
     --hba /etc/postgresql/pg_hba.conf --replication-role edge_replicator --app-env-file /etc/legend/edge/api.env
   sh deploy/edge/check-edge-replication.sh --role standby --conf /etc/postgresql/edge-standby.conf \
     --data-dir /var/lib/postgresql/data --replication-role edge_replicator --app-env-file /etc/legend/edge/api.env
   ```

Prerequisite for promotion (F11b, not built here): the old primary must be proven
stopped or fenced before the standby is promoted, or both hosts accept sales
(split-brain). Nothing in this folder promotes a standby or fences a host.

The 15 minute snapshot stays as a second copy; it is not changed here. The
`ALARM` line reaches the owner only through the journal until F11b wires it into
the owner alarm queue.

## Checklist

- [ ] Preflight prints no FAIL.
- [ ] Phone and edge show the same time (QR scans succeed).
- [ ] A phone opens the edge URL with no certificate warning and the camera starts.
- [ ] `WEB_URL` and `BETTER_AUTH_URL` are the edge origin; `TRUSTED_ORIGINS` and `COOKIE_DOMAIN` are empty.
- [ ] `web.env` exists with the deployment settings and the web build is in `/opt/legend/apps/web/.output`.
- [ ] Env file has no seal private key and is readable only by the service user.
- [ ] Local audit maintenance login is configured, or its missing-login warning has an owner assigned to restore audit purge.
- [ ] Standby: `check-edge-replication.sh` prints no FAIL on both hosts, the watchdog unit runs on the primary, and the application units are stopped on the standby.
- [ ] Theft or loss: follow `docs/runbooks/edge-hilang-dicuri.md`.
