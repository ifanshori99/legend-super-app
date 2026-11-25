# Edge host (legend-svy91)

An outlet edge host is a mini PC that runs the Legend API with `EDGE_MODE=true`
so attendance keeps working when the internet is down. This folder holds the
host requirements, example configuration and a read-only preflight check. Design
background: `docs/design/hris-edge-replication.md`.

## Files

- `check-edge-host.sh`: read-only preflight; exits 1 on any FAIL. Run it as root or the service user so every selfie folder can be inspected.
- `test-check-edge-host.sh`: stubbed test for the preflight (`sh deploy/edge/test-check-edge-host.sh`).
- `chrony.conf.example`: NTP client configuration.
- `Caddyfile.edge.example`: HTTPS front for outlet devices.
- `legend-edge.service`: example systemd unit (`Restart=always`), required when `EDC_AGENT_ENABLED=true`.
- `check-image-version.mjs`: Validates the edge image release version at build time.

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
5. Write the edge env file (`EDGE_MODE=true`, `EDGE_CLOUD_URL`, `EDGE_NODE_CREDENTIAL`; see `.env.example`). Do not set the seal private key variables. Set `TRUST_PROXY=1` (Caddy is the one proxy in front of the API; without it every outlet device shares one per-IP rate-limit bucket).
6. Run the preflight and fix every FAIL:

   ```sh
   sh deploy/edge/check-edge-host.sh --env-file /etc/legend/edge/api.env \
     --service-user legend --cert /etc/legend/edge/tls/edge.crt
   ```

7. Start the API and Caddy, then confirm `GET /api/edge/health` over HTTPS.

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

## Checklist

- [ ] Preflight prints no FAIL.
- [ ] Phone and edge show the same time (QR scans succeed).
- [ ] A phone opens the edge URL with no certificate warning and the camera starts.
- [ ] Env file has no seal private key and is readable only by the service user.
- [ ] Local audit maintenance login is configured, or its missing-login warning has an owner assigned to restore audit purge.
- [ ] Theft or loss: follow `docs/runbooks/edge-hilang-dicuri.md`.
