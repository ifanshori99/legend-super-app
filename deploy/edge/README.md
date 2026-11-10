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
3. Create the service user and the selfie volume directory with mode 0700 owned by that user.
4. Issue a certificate for the edge name from the internal CA, install it where `Caddyfile.edge.example` expects it, and trust the CA on every outlet device.
5. Write the edge env file (`EDGE_MODE=true`, `EDGE_CLOUD_URL`, `EDGE_NODE_CREDENTIAL`; see `.env.example`). Do not set the seal private key variables.
6. Run the preflight and fix every FAIL:

   ```sh
   sh deploy/edge/check-edge-host.sh --env-file /etc/legend/edge/api.env \
     --service-user legend --cert /etc/legend/edge/tls/edge.crt
   ```

7. Start the API and Caddy, then confirm `GET /api/edge/health` over HTTPS.

## Checklist

- [ ] Preflight prints no FAIL.
- [ ] Phone and edge show the same time (QR scans succeed).
- [ ] A phone opens the edge URL with no certificate warning and the camera starts.
- [ ] Env file has no seal private key and is readable only by the service user.
- [ ] Theft or loss: follow `docs/runbooks/edge-hilang-dicuri.md`.
