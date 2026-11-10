# Design: HRIS master replication to edge + offline selfie (legend-shrlc)

Status: design, 10 Nov 2026. Owner: architect. Branch `ws/hris-edge-design`
(base `ws/storage-wire` 62ef1e11). Unblocks `legend-j6cyb`.
Tier K (personal data, QR secret, edge migrations): every implementation card
gets one architect review; Codex second opinion once for the whole area before
the release gate.

Inputs: PRD lines 517-518 (employees and roles copied cloud to edge), 907-910
(F25 attendance, P0 "absensi di outlet tetap tercatat melalui edge node saat
internet putus"), 186/194/275/1375 (selfie privacy, 90-day retention), R09,
R16 (UU PDP breach notice 3x24h), EDG-03; founder Q81 (offline = flag, not
reject); CTO decision on j6cyb (selfie stored on edge, uploaded later,
`requireSelfie` not relaxed); code on `ws/storage-wire`.

Points marked **TBD-verify** were not confirmed in code; the implementer checks
them first and reports a mismatch before coding around it.

## 1. What exists and what is missing

Exists (paths under `apps/api/src`):

- Edge = same Docker image in edge mode, local Postgres, same migrations
  (`apps/api/drizzle/`, latest `0217_hris_attendance.sql`), primary + standby
  mini PC per outlet.
- Cloud to edge is **pull only**: bootstrap (`edge/bootstrap.ts`: tenant,
  legal entity, brand, outlet), masters full snapshot every 5 min
  (`edge/master-sync.ts`), keyset streams for device registry
  (`services/edge-device-sync.ts`) and staff PINs (`services/staff-pin-sync.ts`,
  `edge/staff-pin-pull.ts`), all authenticated with the edge credential
  (`edge/credential.ts`, `verifyEdgeCredential`), tenant and outlet taken from
  the credential, never from the query.
- Edge to cloud: outbox destination `cloud-sync`, `edge_outbound_queue`, edge
  link WebSocket, applier registry, `edge_received_events` (append-only,
  PK `(tenant_id, event_id)`).
- `clockAttendance` (`services/hris-attendance.service.ts:737`) already appends
  `attendance.logged` to `cloud-sync`; the cloud applier
  (`edge/attendance-logged-applier.ts`) stores the row as flagged
  `offline_unverified`, review pending, `photoKey: null`.
- Selfie upload (`services/core-storage.ts:45`) is S3 only; on an edge (no S3
  env) it answers 503. `processImage` re-encodes to webp (strips EXIF/GPS).

Missing (the reason `j6cyb` stopped):

1. **No identity on the edge.** Nothing replicates `user`, `roles` or
   `role_assignments`. `applyStaffPinRecords` inserts `staff_pins.user_id`
   (FK to `user.id`) without a user row, so on a real, separate edge database
   the staff PIN pull fails on the FK. Tests never catch it because cloud and
   edge share one test database (`test/edge-staff-pin-pull.test.ts:4`).
   This gap also affects POS staff sign-in on the edge, not only HRIS.
2. No employees, shift assignments, attendance policies on the edge.
3. The QR seed (`attendance_qr_secrets.seed`) is a plain 32-byte secret; the
   QR display (`GET /api/hris/attendance/qr`, permission `hr.attendance.manage`)
   creates a seed lazily when none exists, which on an edge would invent a
   second, divergent seed.
4. No local object storage on the edge, no deferred selfie upload, and the
   `attendance.logged` payload has no selfie field.
5. Employee phones never reach the edge today: the edge serves web only for
   `EDGE_WEB_PREFIXES` (`/pos`, `/kds`, `/operasional`, ...) on the operational
   VLAN behind Caddy (`edge/mode.ts:25-37`), and phone camera and GPS need a
   secure (HTTPS) origin the phone trusts.

## 2. Who clocks on the edge (D-01)

**Decision.** During an outlet internet outage there are two paths, and neither
needs an employee phone to talk to the edge:

- **Path A, phone + outlet QR.** Phones keep clocking against the cloud over
  mobile data, exactly as today. The outlet screen that shows the rotating QR
  gets its token from the edge instead of the cloud. The cloud can verify an
  edge-made token (section 4), so the QR method keeps working when the outlet
  line is down.
- **Path B, outlet attendance screen ("layar absen outlet").** On a registered
  outlet device on the operational VLAN (the same device as the QR screen, or a
  POS tablet with a front camera), the employee signs in with their staff PIN,
  the device takes the selfie, and the edge stores the clock with the new
  method `outlet_device`. This covers staff without mobile data or without a
  phone.

The edge never accepts `selfie_geo` or `rotating_qr` clocks (it answers 400
`ATTENDANCE_METHOD_NOT_ON_EDGE`). Phone-to-edge over outlet Wi-Fi is phase 2,
only if the founder asks for it (section 11, Q1).

**Why (business).** Indonesian outlet staff almost always have mobile data, so
a dead outlet line rarely stops a phone. What actually breaks is the QR screen
and staff without data. Path A fixes the screen with no new hardware. Path B
reuses the POS device, PIN and edge web that outlets already have. Phone to
edge would need a publicly trusted HTTPS certificate on every edge and an
offline sign-in token on every phone: weeks of infrastructure for a rare case.

**Risk.** Staff who use path B need a staff PIN at that outlet (kitchen staff
may not have one). Every path B clock is flagged `offline_unverified` (Q81), so
if many staff use the screen daily, the supervisor review queue grows.
The device camera needs a secure context: **TBD-verify** that the edge origin
on managed outlet devices is HTTPS with a trusted (internal CA) certificate;
if not, card `C9` adds it.

**Fallback.** If the founder wants phones on the edge, phase 2 adds
`attendance_devices` to the snapshot, QR verification on the edge (the day keys
in section 4 already allow it), and a cloud-signed offline clock pass on the
phone. Nothing in phase 1 has to be undone.

## 3. What is replicated, and how (D-02, D-03)

### 3.1 Transport (D-02)

**Decision.** One new cloud endpoint, `GET /api/edge-sync/people-snapshot`,
returns a **full snapshot for the credential's outlet**, and the edge applies
it in one transaction. It is pulled at boot, then every
`EDGE_PEOPLE_SYNC_INTERVAL_SECONDS` (default 60), by both primary and standby,
using the scheduler from `edge/device-registry-puller.ts` (capped backoff with
jitter). The response carries `ETag` = SHA-256 of the canonical data sections
only (sorted keys, rows sorted by id); `generatedAt` and any other per-request
value go in a header and are never hashed. The edge sends `If-None-Match` and
gets 304 when nothing changed. The day keys change the ETag once a day.

**Why.** The scope moves (an employee changes home outlet, a shift moves to
another outlet, a role is withdrawn). A full snapshot handles leaving the scope
without tombstones, which the keyset streams do not have (staff PINs has no
tombstone path). The data is small: at most a few hundred people and about two
thousand shift rows per outlet, so a snapshot is cheaper to build and test than
three more `sync_xid` triggers and cursors. The masters sync already works this
way.

**Risk.** Changes reach the edge within about 60 s while the link is up; during
an outage the edge keeps the last snapshot (a person terminated during the
outage can still clock on the edge; the row is flagged, see 3.4 and 6.2).
Cloud load: the cloud builds the full body on every request to compute the
ETag, so it is one full query set (seven small indexed queries, under 2 MB)
per edge node per minute; 304 only saves bandwidth. At 100 nodes that is about
2 requests per second.

**Fallback.** If cloud load matters, raise the interval to 120 s; if a tenant
grows past what one snapshot carries comfortably (over about 2 MB), split
shifts into a keyset stream copying `staff-pin-sync`.

### 3.2 Scope and columns (D-03, data minimization)

Scope is always `tenant_id` and `outlet_id` from the verified credential
(outlet O). "Today" is the outlet's business date in the outlet time zone.

| Data                   | Rows sent                                                                                                                                                                                                                          | Columns sent                                                                                                                                                                                                 | Never sent                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`                 | Users holding a `staff_pins` row at O, plus `user_id` of every employee row sent                                                                                                                                                   | `id`, `name`, `banned`, `created_at`, `updated_at`; `email` is replaced by `<id>@edge.invalid`, `email_verified=false`                                                                                       | real email, `image`, every `account` row (password hashes), sessions                                                                                                                                    |
| `roles`                | Roles referenced by the assignments sent                                                                                                                                                                                           | every column (`id`, `tenant_id`, `name`, `is_template`, `template_key`, `permissions`, `mfa_required`, `allowed_scope_types`, timestamps); none is personal                                                  | —                                                                                                                                                                                                       |
| `role_assignments`     | Active assignments (`valid_until` null or future) of the users sent that the cloud permission resolver would use for a request at outlet O: scope tenant, the brand of O, or O                                                     | every column, except `assigned_by` is replaced by the assignee's own `user_id` (NOT NULL FK to `user`; the assigning admin is not shipped)                                                                   | assignments scoped to other outlets; scope types the edge cannot resolve (**TBD-verify** the `scope_type` values in the schema; `permission-resolver.ts:81-84` passes any type through)                 |
| `employees`            | Status `onboarding` or `active`, `user_id` not null (no user, no sign-in, no clock), and (`home_outlet_id = O` or a `published`/`swapped` shift at O between today-1 and today+7)                                                  | `id`, `tenant_id`, `user_id`, `employee_no`, `full_name`, `home_outlet_id` (**rewritten to O**, see below), `employment_type`, `join_date`, `end_date`, `status`                                             | `legal_entity_id`, `position_id`, `org_unit_id`, `manager_id`, `ptkp_status`, every `*_encrypted`/`*_hmac` column, emergency contact. On the edge they stay NULL; `pii_key_version` takes its default 1 |
| `shift_assignments`    | Outlet O, status `published` or `swapped`, `business_date` today-1 to today+7, **and `employee_id` in the employees sent** (FK `shift_assignments_employee_fk`; a shift of a suspended employee or one without a user is not sent) | `id`, `tenant_id`, `outlet_id`, `employee_id`, `business_date`, `segments`, `break_minutes`, `status`, `source`, `published_at`, `created_by` (an opaque user id, no FK, `db/schema/hris-scheduling.ts:138`) | `shift_template_id` and `station_id` (nullable, sent as NULL so the edge needs no templates or stations)                                                                                                |
| `attendance_policies`  | Tenant default (`outlet_id` null) and the override for O                                                                                                                                                                           | all columns                                                                                                                                                                                                  | —                                                                                                                                                                                                       |
| QR day keys            | Section 4                                                                                                                                                                                                                          | —                                                                                                                                                                                                            | the seed                                                                                                                                                                                                |
| Selfie seal public key | Section 5                                                                                                                                                                                                                          | `kid`, SPKI PEM                                                                                                                                                                                              | private key                                                                                                                                                                                             |

**Edge projection.** The edge copy is a read-only projection for clocking at O,
never sent back (cloud wins, PRD 518). Three columns are rewritten on purpose
so the edge needs no rows it has no business holding:

- `employees.home_outlet_id = O` for every employee sent. The FK
  `employees_home_outlet_fk` (`db/schema/hris.ts:246-251`) would otherwise need
  other outlets (bootstrap seeds only O), and `clockAttendance` calls
  `loadOutletTimeZone(homeOutletId)` (`hris-attendance.service.ts:765`).
  On the edge every clock is at O anyway.
- `role_assignments.assigned_by` = the assignee (above).
- Out-of-scope rows are detached (section 3.3).

Why `full_name` is sent: it is NOT NULL, and the edge already holds the same
name in `user.name`, so it adds no new exposure. Password hashes are never sent:
sign-in on the edge is by staff PIN only (AUTH-06). `/api/auth/sign-in/email`
stays in `EDGE_API_PREFIXES` but cannot succeed on the edge; see section 12.

`attendance_devices` and `attendance_qr_secrets` are **not** replicated in
phase 1: the edge never verifies phone device binding or QR tokens.

The response is validated on both sides with a strict Zod schema
(`packages/shared/src/edge/people-snapshot.ts`), so an extra column cannot slip
through.

### 3.3 Apply on the edge

One transaction, `pg_advisory_xact_lock(hashtextextended('edge-people-snapshot:<tenant>:<outlet>', 0))`
(repo pattern, `services/staff-pin-sync.ts:498`), FK order `user`, `roles`,
`role_assignments`, `employees`, `shift_assignments`, `attendance_policies`,
`edge_attendance_qr_keys`, `edge_people_sync_state`. The apply runs in **two
passes** so no unique key can clash with older edge state (none of these keys
is deferrable):

1. **Free keys.** Every edge row that is absent from the snapshot, **or** whose
   unique-key columns differ from its snapshot row, is deleted or detached
   (table below). This covers a cloud swap of two `employee_no` values, a
   `user_id` moved between employees, and a role renamed onto a name an edge
   role still holds.
2. **Upsert** by id in FK order; the cloud always wins (PRD 518).

After pass 1 a clash can only come from two rows of the same snapshot, which
the cloud's own unique keys rule out; if it still happens the apply aborts with
`LOCAL_CONFLICT`, like `master-sync.ts`. A failed apply keeps the previous
state and does not move the ETag.

Leaving the scope or freeing keys. The edge cannot tell "terminated" from
"moved away" (both are simply absent), so there is one rule per table:

| Table                 | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`                | absent: `banned = true`, delete their sessions on the edge. The email placeholder `<id>@edge.invalid` is unique per id, so users never need freeing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `role_assignments`    | delete (absent or key changed; the upsert re-inserts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `roles`               | absent and no longer referenced: delete. Key changed (`roles_tenant_name_key`, `roles_tenant_template_key`): set `name = '~detached-' \|\| id`, `template_key = NULL` (**TBD-verify** the CHECK on `is_template`/`template_key` allows it; else set `is_template = false` too); the upsert restores it                                                                                                                                                                                                                                                                                                                                                        |
| `employees`           | **detach**: `status = 'suspended'`, `user_id = NULL`, `employee_no = 'X' \|\| upper(left(replace(id::text, '-', ''), 29))`. The placeholder is 30 characters, matches `employees_employee_no_check` (`^[A-Z0-9][A-Z0-9-]{1,29}$`, `varchar(30)`, `db/schema/hris.ts`) and is unique per id (116 bits of the id). Detaching frees `employees_tenant_employee_no_key` and `employees_tenant_user_key` (`db/schema/hris.ts:220-227`), so a re-hire under a new id never collides. The row stays for FK from local `attendance_logs`; the edge retention sweep deletes it once nothing references it. If the same id comes back, the upsert restores every column |
| `shift_assignments`   | delete when no local `attendance_logs.shift_assignment_id` points at it, else `status = 'cancelled'` (**TBD-verify** its unique keys; a key change follows the same two-pass rule)                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `attendance_policies` | delete the outlet override; the tenant default always comes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| QR day keys           | replace the whole set for O                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Runtime order: the people snapshot runs before the staff PIN pull at boot
(`edge/runtime.ts:735-815`), and `applyStaffPinRecords` skips a record whose
user is absent (leave the watermark, retry next cycle) instead of failing on
the FK. This fixes gap 1 for POS too.

### 3.4 Clocking with the local copy

`clockAttendance` in `EDGE_MODE` with method `outlet_device`:

1. `loadHrisAccess` unchanged (it works because of the projection in 3.2):
   needs the employee row and `self.attendance.clock` through the replicated
   roles. **TBD-verify** that a role with `mfa_required` does not drop the
   permission for a staff-PIN session.
2. The request must carry a valid signed device token (`deviceIdOf(req)`,
   `X-Device-Token`, `routes/device-id.ts`, as POS routes do) whose device is
   in the device registry replica, active, at outlet O (EDG-03). No token or a
   revoked device: 403.
3. Employee status `onboarding`/`active`, else 403 as on the cloud.
4. Selfie required by policy: `assertSelfieUsable` unchanged (object on the
   edge, purpose `selfie`, owner = actor, outlet O, at most 24 h old).
5. No geofence, device binding or QR check (presence is proven by the outlet
   device and the PIN).
6. Shift match only among shifts of O; log outlet = O.
7. Validity at most `flagged`. Reasons always include `offline_unverified`,
   plus `edge_roster_stale` when `edge_people_sync_state.last_checked_at` (moved
   by every 200 **and** 304) is older than 24 h, which means the edge could not
   reach the cloud for a day.
8. In the same transaction: `appendAttendanceLogged` (payload v2, section 6)
   and, if a selfie is attached, a row in `edge_selfie_uploads`.

A rejected clock (missing selfie) is shown on the screen and never sent,
as today.

## 4. QR secret on the edge (D-04)

**Decision.** The edge never stores the seed. The cloud derives a **per-outlet,
per-day key** from the seed and sends only the keys for UTC days today-1 to
today+3 in the snapshot. The QR token algorithm becomes v2 everywhere, so a
token shown by the edge is verified by the cloud with the same day key.

```
dayIndex(window) = floor(window * 30_000 / 86_400_000)      // UTC day of the 30 s window
dayKey           = HMAC-SHA256(seed, "legend/attendance-qr/v2|" + tenantId + "|" + outletId + "|" + dayIndex)
token(window)    = "2." + base64url(HMAC-SHA256(dayKey, String(window)))
```

Verification stays: current or previous window, constant-time compare. On the
cloud a `QrKeySource` derives the day key from the seed; on the edge it reads
`edge_attendance_qr_keys`. In `EDGE_MODE` the QR display never calls the lazy
seed generator: no key for the current day means 503 `QR_KEY_UNAVAILABLE`, and
the screen offers path B. `attendance_qr_secrets` must stay empty on an edge
(test), enforced twice:

- Route guard: `matchesPrefix` (`edge/mode.ts:97-107`) is method-blind and
  admits everything below a prefix, so a prefix `/api/hris/attendance/qr` would
  also serve `POST .../qr/rotate` on the edge. The HRIS entries therefore go in
  a new **exact, method-aware** list (`EDGE_API_EXACT_ROUTES`: method + full
  path), never in `EDGE_API_PREFIXES`.
- Service: in `EDGE_MODE`, `rotateAttendanceQrSecret` and the lazy seed
  generator in `getAttendanceQr` throw before touching the table.

There is no dual-algorithm period: the token is computed by the server at
display time, old edges cannot display a QR (they have no seed), and a token on
screen during the deploy is invalid for at most 60 s.

**Why.** If an edge is stolen, the thief can make valid QR tokens for at most
about four days, and only until someone presses "rotate" (existing
`rotateAttendanceQrSecret`), which changes every day key at once. Keeping the
seed itself on the edge would allow forging forever until rotation. No new
encryption keys to manage.

**Risk.** An outage longer than three days stops the QR screen (path B still
works). Edge and phone clocks must be within one 30 s window: edges need NTP
(card C9).

**Fallback.** Raise the look-ahead with `EDGE_QR_KEY_DAYS_AHEAD` (cloud env,
default 3) per tenant if outages are longer in practice.

## 5. Selfie on the edge (D-05)

**Decision.** The edge **seals** each selfie to a cloud public key, keeps only
the sealed file on local disk, uploads it when the link is up, and deletes it
after the cloud confirms.

Pipeline on the edge (selfie upload route, purpose `selfie` only; every other
purpose answers 503 on the edge as today):

1. Same checks as the cloud: magic bytes jpeg/png/webp, 5 MiB input cap (413),
   scanner, re-encode to webp (EXIF/GPS stripped). No thumbnail on the edge.
2. Seal (format below) with the public key from the snapshot. No public key
   yet: 503 `SELFIE_SEAL_KEY_MISSING`, so the clock is rejected for a missing
   selfie: `requireSelfie` is not relaxed.
3. Write `<EDGE_SELFIE_DIR>/<tenantId>/<objectId>.lss` (temp file, fsync,
   rename, mode 0600). `EDGE_SELFIE_DIR` default `/var/lib/legend/edge-selfies`,
   a Docker volume.
4. Insert `core_storage_objects` on the edge (purpose `selfie`, private,
   `object_key = 'edge-sealed:<tenantId>/<objectId>.lss'`, `content_type
image/webp`, width, height, `thumbnail_key` null, owner = actor). From here
   `clockAttendance` works unchanged.
5. Disk budget `EDGE_SELFIE_MAX_BYTES` (default 2 GiB, about 7 000 selfies,
   about a month of a large outlet): above it, 507
   `EDGE_SELFIE_STORAGE_FULL` and a health alert.

Sealed format `LSS1` (all lengths big-endian):

```
"LSS1" | u32 headerLen | header (UTF-8 JSON) | u16 wrappedKeyLen | wrappedKey | iv(12) | ciphertext | tag(16)
header    = {"v":1,"kid","alg":"RSA-OAEP-256+A256GCM","tenantId","objectId"}      // plaintext, routing only
plaintext = u32 metaLen | meta (UTF-8 JSON) | webp bytes
meta      = {"outletId","ownerUserId","contentType":"image/webp",
             "width","height","plainSha256","createdAt"}                          // encrypted
```

A fresh 32-byte AES-256-GCM key per file, wrapped with RSA-OAEP-SHA256
(3072-bit cloud key). AAD = `"LSS1" | headerLen | header`, so the header
cannot be edited without breaking the tag. Who, where and when sit inside the
ciphertext, so the sealed file alone does not say whose selfie it is.
Node `crypto` only, no new dependency.

Keys: the cloud holds `ATTENDANCE_SELFIE_SEAL_KEYS` (JSON `{kid: PKCS#8 PEM}`,
production secret) and `ATTENDANCE_SELFIE_SEAL_ACTIVE_KID`. The snapshot carries
the active public key. Rotation: add a new kid, switch the active kid, keep the
old private key for **90 days** after the switch. An edge cut off from the
cloud keeps sealing with the old kid until its next snapshot, and uploads those
files on reconnect, so the old key is needed until the longest outage that
started before the switch ends. 90 days covers any outage the business still
cares about (pending files older than `EDGE_SELFIE_MAX_AGE_DAYS` are expired on
the edge anyway). The key retires on a date, not on a report the edge does not
send. An emergency retirement (key leaked) knowingly loses the old-kid backlog.

Upload (edge worker `edge/selfie-uploader.ts`, scheduler as the puller,
interval 30 s, backoff with jitter, one file at a time):
`PUT /api/edge-sync/attendance-selfies/:objectId`, `Authorization: Bearer
<edge credential>`, body `application/octet-stream` (max 6 MiB), header
`X-Legend-Sealed-Sha256`.

| Cloud answer                                                                            | Edge action                                                                                                                                                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 201 stored, 200 already stored with the same hash                                       | commit state `uploaded`, then delete the file (the hourly sweep removes a file left by a crash in between; a `pending` row whose file is gone is marked `expired`, not retried) |
| 409 same object id, different hash; 403 scope; 413; 422 cannot decrypt or hash mismatch | state `rejected`, keep file 7 days for investigation, alert                                                                                                                     |
| 5xx, 503 storage, network                                                               | retry with backoff                                                                                                                                                              |

Local retention on the edge (sweep every hour):

- `uploaded`: file already gone; row kept with the log, purged with it.
- Selfie object with no `edge_selfie_uploads` row (clock never made or
  rejected) older than 24 h: delete file and row (same rule as
  `PHOTO_MAX_AGE_MS`).
- `pending` older than `EDGE_SELFIE_MAX_AGE_DAYS` (default 30): delete file,
  state `expired`, alert. The cloud row keeps `photo_key`; the review screen
  shows "selfie tidak terkirim dari edge".
- `rejected` older than 7 days: delete file.
- Edge `attendance_logs` whose outbox event is acked and older than 35 days:
  delete (together with `legend-gzwhg`), then orphan employees and selfie rows.

**Why.** Sealing means a stolen edge yields no readable selfie at all, without
relying on disk encryption or a TPM, and the edge never needs to read selfies
(review happens in the cloud). Selfies normally leave the edge within a minute;
only an outage backlog sits on disk, and it is ciphertext.

**Risk.** The production private key is a new secret: lose it and every pending
edge selfie is unreadable. Store it in the production secret store with a
backup (founder action, section 11). Primary edge dies during an outage with
pending files: those selfies are lost (the clock itself is in the outbox of the
same node). Double re-encode (edge, then cloud) lowers quality slightly.

**Fallback.** If key handling is too heavy, encrypt with a per-edge AES key in
the edge env: weaker (the key sits on the same disk), so only together with
full-disk encryption.

## 6. Cloud side

### 6.1 Selfie receive endpoint

`PUT /api/edge-sync/attendance-selfies/:objectId` (cloud only, edge credential,
pre-auth limiter like `routes/staff-pin-sync.routes.ts`):

1. Credential gives tenant T, outlet O, node N. Header `tenantId` must equal T
   and `objectId` the path, else 403.
2. The cloud hashes the body itself; `X-Legend-Sealed-Sha256` only guards
   transport (mismatch 400).
3. One transaction, first statement
   `pg_advisory_xact_lock(hashtextextended('edge-selfie:<T>:<objectId>', 0))`,
   so two concurrent PUTs of the same object run one after the other.
4. Receipt `edge_received_selfies (tenant_id, object_id)` exists: same sealed
   hash gives 200, different gives 409. A `core_storage_objects` row with that
   id but **no receipt** (a phone upload, or a guessed id) gives 409
   `OBJECT_ID_TAKEN`: the edge can never overwrite an object it did not create.
5. Unwrap with `kid`, decrypt, check `plainSha256`; any failure 422.
6. Encrypted `outletId` must equal O; `ownerUserId` must be the `user_id` of an
   employee of T (403 otherwise).
7. `processImage` (scan, re-encode, thumbnail), put to S3 under
   `${objectId}/original.webp` and `${objectId}/thumbnail.webp` (the normal key
   builder, `services/core-storage.ts:103-104`, with id = objectId), insert
   `core_storage_objects` with `id = objectId`, insert the receipt, commit.
   A crash after the S3 put leaves an object no row points at; the retry
   overwrites the same key.
8. Link (6.3).

If the cloud log already has `photo_purged_at` set (retention ran first), store
the receipt with state `discarded`, do not write S3, answer 200.

### 6.2 `attendance.logged` payload v2 and applier

New optional fields (old edges keep working): `method` may be `outlet_device`;
`selfieObjectId` (uuid or null); `edgeFlagReasons` (subset of the reason enum);
`edgeDeviceId` (outlet device id). The applier:

- stores `photo_key = selfieObjectId`, `flag_reasons = union(offline_unverified,
edgeFlagReasons)`, review pending, `occurred_at` from the edge;
- accepts `outlet_device`, still rejects `rejected` validity and
  `manual_correction`;
- an employee that is not `onboarding`/`active` in the cloud at `occurredAt`
  gets the flag `employee_inactive` (new reason) instead of a rejection (Q81).
  Today the applier only checks that the employee belongs to the tenant
  (`attendance-logged-applier.ts:~102`);
- the payload carries no late/early/overtime; the cloud computes them from its
  own shift. **TBD-verify** that `recordAttendanceLog` already does this for
  applier calls; if not, C6 adds it.

### 6.3 Linking selfie and log in either order

Both the receive endpoint and the applier take
`pg_advisory_xact_lock(hashtextextended('attendance-selfie-link:<tenant>:<objectId>', 0))`,
then, if both the object and a log with `photo_key = objectId` exist, link.
Whichever arrives second links.

Linking is **best effort** and never refuses the event or the upload:

- Already linked to this log: no-op (a replay).
- `linkStorageObjectSource` (`services/core-storage.ts:262-284`) throws
  `VALIDATION_ERROR` unless the object is unlinked, at the log's outlet and
  owned by the actor. Call it in a savepoint with actor = the log employee's
  `user_id`. On any failure (owner is not the log's employee, outlet differs,
  object linked elsewhere) roll back the savepoint, set the log's
  `photo_key = NULL`, add the flag `selfie_unlinked` (new reason), and write a
  warning log with ids only. The attendance row is never lost.
  Review screen: `photo_key` set and object missing means "selfie menunggu dari
  edge" (FE note for `legend-0z5k`).

Cloud orphan sweep: a receipt older than 14 days whose object no log points at:
delete the object and thumbnail.

The existing purge job (`worker/attendance-selfie-purge.job.ts`) needs no change:
uploaded edge selfies are ordinary rows once linked.

## 7. Theft of an edge (D-06)

What a thief gets, and the response:

| On the stolen edge                                                                 | Impact                                                                                                                                                                                                | Response                                                    |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Edge credential (plain env)                                                        | Can call edge-sync as that outlet                                                                                                                                                                     | Revoke the node (existing)                                  |
| QR day keys (5 days)                                                               | Fake QR tokens for those days                                                                                                                                                                         | Rotate the outlet QR seed (existing button)                 |
| Names, `employee_no`, employment type, join/end date, roles, next 8 days of shifts | Personal data (UU PDP)                                                                                                                                                                                | Breach assessment within 3x24 h (R16)                       |
| Staff PIN hashes + root `STAFF_PIN_PEPPER` in env                                  | Short PINs brute-forced offline; the root pepper derives **every tenant's** pepper (`services/staff-pin-sync.ts` header), so the exposure is cross-tenant. Existing risk, but path B leans on the PIN | Force PIN reset; rotate the pepper version (`legend-ideif`) |
| Sealed selfies                                                                     | Image and meta (who, outlet, time) unreadable; plaintext header shows only tenant and object id                                                                                                       | —                                                           |
| `edge_selfie_uploads` metadata, local `attendance_logs` (35 days)                  | Who clocked when                                                                                                                                                                                      | Part of the breach assessment                               |
| No password hashes, no NIK/NPWP/bank/BPJS                                          | —                                                                                                                                                                                                     | —                                                           |

Recommendation (card C9, ops): full-disk encryption with TPM unlock on the edge
mini PC as defense in depth, and a written runbook "edge hilang".

## 8. Migrations

One migration, owned by card C1, so later cards do not fight over numbers (take
the next free number at merge, currently after `0217`). RLS through
`app.enforce_tenant_rls` / `app.enforce_outlet_rls`, unique keys include
`tenant_id`.

| Object                         | Where used | Shape                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edge_people_sync_state`       | edge       | PK `(tenant_id, outlet_id)`; `snapshot_etag` text, `snapshot_generated_at`, `applied_at` (moves on 200), `last_checked_at` (moves on 200 and 304) timestamptz, `selfie_seal_kid` text, `selfie_seal_public_key` text. Tenant + outlet RLS                                                                                                                                                     |
| `edge_attendance_qr_keys`      | edge       | PK `(tenant_id, outlet_id, day_index)`; `day_index` integer, `key` bytea CHECK `octet_length(key) = 32`, `received_at`. FK outlets. Tenant + outlet RLS                                                                                                                                                                                                                                       |
| `edge_selfie_uploads`          | edge       | PK `(tenant_id, object_id)`; `outlet_id`, `attendance_log_id` uuid, `file_path` text, `sealed_sha256` bytea, `sealed_bytes` integer, `seal_kid` text, `state` CHECK IN (`pending`,`uploaded`,`rejected`,`expired`), `attempts` integer default 0, `next_attempt_at`, `last_error` text (no personal data), `created_at`, `uploaded_at`. Index `(state, next_attempt_at)`. Tenant + outlet RLS |
| `edge_received_selfies`        | cloud      | PK `(tenant_id, object_id)`; `outlet_id`, `edge_node_id`, `sealed_sha256` bytea, `state` CHECK IN (`stored`,`discarded`), `received_at`. Append-only trigger like `edge_received_events`. Tenant RLS                                                                                                                                                                                          |
| `attendance_logs_method_check` | both       | add `'outlet_device'`                                                                                                                                                                                                                                                                                                                                                                         |

Reason enums (existing `offline_unverified`; new `edge_roster_stale`,
`employee_inactive`, `selfie_unlinked`) live in Zod and `flag_reasons` jsonb:
no DDL. `edge_pull_checkpoints` is not
touched (the snapshot keeps its ETag in `edge_people_sync_state`).

## 9. Acceptance tests (write first, see them fail)

Real Postgres (`STARTER_TEST_DATABASE_URL`). Because cloud and edge share one
test database today, the people-snapshot and staff-PIN tests must use a
**second database** for the edge (create it in the test setup), otherwise gap 1
stays invisible.

- **T1 snapshot scope** (C2): only outlet O; employees by home outlet or shift
  in window; terminated excluded; other tenant and other outlet excluded; JSON
  keys equal the whitelist exactly (no `*_encrypted`, no `*_hmac`, no real
  email, no `account`, `assigned_by` equals the assignee); employee without
  `user_id` excluded; employee with a shift at O and home outlet P is sent with
  `home_outlet_id = O`; 304 on unchanged ETag; 401 without credential;
  revoked node 401.
- **T2 apply** (C3): fresh second database: apply succeeds in FK order;
  sealed PII columns NULL on the edge; repeat apply is a no-op; employee moved
  to another outlet is detached (`suspended`, `user_id` NULL, `employee_no`
  placeholder passes `employees_employee_no_check`), its user `banned` and
  sessions gone; a re-hire with a new id and the old `employee_no` and
  `user_id` applies cleanly; two employees that swap `employee_no` (or a
  `user_id` moved between them) apply cleanly; a role renamed onto a name a
  stale edge role holds applies cleanly; the same id coming back is restored;
  a published shift of a suspended employee is not sent (T1) and never breaks
  the FK; shift referenced by a local log becomes `cancelled`,
  unreferenced is deleted; failed apply leaves the previous state; a 304 moves
  `last_checked_at` only; staff PIN pull for a user not yet present skips,
  then succeeds after the snapshot.
- **T3 QR** (C4): token from the edge with a day key verifies on the cloud;
  previous window accepted, two windows back rejected; seed rotation on the
  cloud makes the edge token invalid; edge QR display with no key gives 503 and
  `attendance_qr_secrets` stays empty on the edge; day-boundary window uses
  its own day key.
- **T4 edge clock** (j6cyb): edge mode, replicated data, PIN session on a
  registered device, sealed selfie: log flagged with `offline_unverified`,
  `attendance.logged` v2 queued with `selfieObjectId`, `edge_selfie_uploads`
  row pending. Without a selfie: rejected `selfie_missing`, nothing queued.
  Revoked device or unknown device: 403. `selfie_geo`/`rotating_qr` on the
  edge: 400. Roster older than 24 h: `edge_roster_stale`.
- **T5 sealing** (C5): sealed file has no webp/jpeg magic bytes and does not
  contain the plain bytes; round trip with the private key gives the same
  `plainSha256`; edited header fails the tag; no public key gives 503; disk
  budget gives 507; other purposes on the edge give 503.
- **T6 receive** (C6): 201 then 200 on retry with the same hash; 409 with a
  different hash; two concurrent PUTs of one object give one 201 and one 200,
  never a 500; 409 `OBJECT_ID_TAKEN` for the id of an existing phone selfie
  (S3 object untouched); 403 for another tenant, or an encrypted `outletId`
  other than O; 422 for a broken tag; event-then-selfie and selfie-then-event
  both end linked; owner not the log's employee gives `photo_key` NULL +
  `selfie_unlinked` and the log is kept; replayed event is a no-op; selfie
  after purge is discarded; S3 key `${objectId}/original.webp`; inactive
  employee flagged `employee_inactive`, not rejected.
- **T7 uploader and retention** (C7): 2xx commits `uploaded` then deletes the
  file; crash between the two leaves no endless retry; 5xx retries with
  backoff; 409 goes to `rejected`; orphan older than 24 h deleted; pending older
  than 30 days goes to `expired`; acked logs older than 35 days deleted.
- **T8 route guard** (j6cyb; the WIP test is on `ws/j6cyb-edge-attendance`
  de141264, `test/edge-mode-guard.test.ts`): `edge_and_cloud` only for
  `POST /api/hris/attendance/clock`, `GET /api/hris/attendance/qr` and the
  selfie upload route under `/api/storage` (`routes/storage-api.routes.ts`,
  **TBD-verify** exact path), each matched by method and exact path;
  `POST /api/hris/attendance/qr/rotate`, `POST /api/hris/attendance/clock/x`
  and every other `/api/hris` path `cloud_only`. The WIP test lists `/qr` as
  cloud only: change it. Service test: `rotateAttendanceQrSecret` in edge mode
  throws and writes nothing.

## 10. Cards

All K tier except C8 (UI, founder review) and C9 (ops docs). `legend-j6cyb`
depends on C1 to C7. Order: C1 and C4 start at once; then C2, C5 in parallel;
then C3, C6, C7; then j6cyb; C8 after the founder answers Q1.

| Card              | Scope                                                                                                                                                        | Main files                                                                                                                                                                                                                            | Depends on                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| C1 `legend-hwn02` | Migration + Drizzle schema + shared contracts (people snapshot Zod, payload v2, `outlet_device`, new reasons, `LSS1` header type, receive endpoint contract) | `apps/api/drizzle/<next>.sql`, `db/schema/edge-hris.ts` (new), `db/schema/hris-attendance.ts`, `packages/shared/src/edge/people-snapshot.ts` (new), `packages/shared/src/hris/attendance.ts`, `packages/shared/src/hris/endpoints.ts` | —                         |
| C2 `legend-ye4j1` | Cloud `GET /api/edge-sync/people-snapshot`: scope, column whitelist, ETag/304, credential auth, QR day keys, seal public key                                 | `services/edge-people-snapshot.ts` (new), `routes/edge-people-snapshot.routes.ts` (new), `routes/index.ts`                                                                                                                            | C1, C4                    |
| C3 `legend-tkycp` | Edge puller + transactional apply + leave-scope rules + runtime order + staff PIN skip-missing-user; second-DB test harness                                  | `edge/people-snapshot-pull.ts` (new), `edge/cloud-http.ts`, `edge/runtime.ts`, `services/staff-pin-sync.ts`, `config/env.ts`                                                                                                          | C1, C2                    |
| C4 `legend-cku1m` | QR v2 day keys, `QrKeySource` (seed on cloud, table on edge), no lazy seed in edge mode                                                                      | `services/hris-attendance-logic.ts`, `services/hris-attendance.service.ts` (QR functions only)                                                                                                                                        | — (edge reader needs C1)  |
| C5 `legend-we0yc` | Selfie sealing + edge sealed storage runtime + disk budget + enqueue in clock tx                                                                             | `services/selfie-seal.ts` (new), `services/edge-selfie-storage.ts` (new), `services/core-storage-runtime.ts`, `config/env.ts`                                                                                                         | C1                        |
| C6 `legend-0wvoz` | Cloud receive endpoint + receipt + link in either order + applier v2 + cloud orphan sweep                                                                    | `routes/edge-selfie-receive.routes.ts` (new), `services/edge-selfie-receive.ts` (new), `edge/attendance-logged-applier.ts`, `worker/`                                                                                                 | C1, C5                    |
| C7 `legend-hubzo` | Edge selfie uploader worker + edge retention sweeps                                                                                                          | `edge/selfie-uploader.ts` (new), `worker/edge-selfie-retention.job.ts` (new), `edge/runtime.ts`                                                                                                                                       | C1, C5 (tests against C6) |
| j6cyb             | Edge clock path `outlet_device`, `EDGE_API_PREFIXES`, T4/T8, end-to-end edge test                                                                            | `services/hris-attendance.service.ts` (clock only), `edge/mode.ts`, `test/edge-mode-guard.test.ts`                                                                                                                                    | C1 to C7                  |
| C8 `legend-tvkuz` | UI "layar absen outlet" on the edge web (QR + PIN + camera selfie + sign-out after clock): mockup, founder review, build                                     | `apps/web` new edge route under `EDGE_WEB_PREFIXES`                                                                                                                                                                                   | founder Q1, j6cyb         |
| C9 `legend-svy91` | Ops: edge volume `EDGE_SELFIE_DIR`, NTP, HTTPS for camera on outlet devices, full-disk encryption, seal key provisioning and backup, runbook "edge hilang"   | `docs/deployment.md`, edge provisioning (`legend-16s`)                                                                                                                                                                                | —                         |

## 11. Questions for the founder

- **Q1** Saat internet outlet putus, absen lewat apa? Rekomendasi: HP karyawan
  tetap absen ke cloud lewat data seluler (QR di layar outlet tetap jalan
  dari edge), dan karyawan tanpa kuota absen di "layar absen outlet" dengan
  PIN staf + selfie. Dampak: tiap karyawan yang memakai layar outlet butuh
  PIN staf, dan outlet butuh satu perangkat berkamera (tablet POS yang ada bisa
  dipakai). Alternatif: HP lewat Wi-Fi outlet ke edge, kerja infrastruktur
  beberapa minggu, tidak disarankan sekarang.
- **Q2** Layar absen outlet boleh dipakai setiap hari, atau hanya saat internet
  putus? Rekomendasi: setiap hari boleh, tetapi tiap absen dari layar ini
  ditandai untuk ditinjau supervisor (sesuai Q81). Dampak: antrean tinjauan
  supervisor bertambah sebanyak pemakai layar.
- **Q3** (kunci production) Kunci segel selfie dibuat tim, disimpan di
  penyimpanan rahasia production dan punya cadangan. Founder hanya perlu
  menyetujui tempat penyimpanan dan cadangannya.

## 12. Outside this design (noted, not solved)

- `/api/auth/sign-in/email` is in `EDGE_API_PREFIXES` but can never succeed on
  the edge (no `account` rows). WS-02 should remove it or document it.
- The edge holds the root `STAFF_PIN_PEPPER`, from which every tenant's pepper
  derives, so one stolen edge weakens PINs of all tenants (existing; new card
  filed: `legend-ideif`). The edge should hold only its tenant's derived
  pepper.
- Phone-to-edge clocking (phase 2, section 2 fallback).
