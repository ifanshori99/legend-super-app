# Design: emergency button on the outlet edge (legend-bod)

Status: design, 13 Nov 2026. Owner: architect (access, xhigh). Branch
`design/qris-dp-edge-emergency` (base `milestone/m1` 5cbe2a1e).
Tier K (access + migrations): every card gets one architect review; Codex
second opinion once for the access area before the release gate.

Inputs: PRD v1.7 §3 F25 (Keselamatan), §4 Alur V, FAC-08 (alert reaches
on-duty staff within 5 seconds, also offline); bead `legend-bod` and its
follow-ups `legend-m47qh` (closed, allowlist on the old branch),
`legend-kmjax` (cloud sync + web push), `legend-kpzmi` (staff banner),
`legend-oc3` (offline drill e2e); draft branches `origin/ws/bod-emergency-relay`
(f46b2cd4..a4e37183, slice 1, migration 0238) and `origin/ws/edge-emergency`
(d823c1fd, NOT FOR MERGE, migration 0400, with
`docs/design/edge-emergency-open-questions.md`); CTO decisions on duty
(active shift or clock-in at the edge; clock-out does not end a still-active
shift; no recipient → store and retry); `docs/design/hris-edge-replication.md`
(staff PIN and people snapshot on the edge).

Points marked **TBD-verify** were not confirmed in code; the implementer checks
them first and reports a mismatch before coding around it.

## 1. In business words

A guest or staff member presses a panic button in a room. Within 5 seconds the
phones and POS tablets of the staff on duty in that outlet ring, even when the
outlet internet is down. One staff member confirms "saya tangani"; the
manager later closes the incident with a note. When the internet comes back,
every incident reaches the cloud exactly once, for reports.

Staff prove who they are on the edge with their existing 6-digit staff PIN on
a registered outlet device. That PIN gives them one narrow right: receive and
confirm emergency alerts for their outlet while they are on duty.

## 2. What exists (milestone/m1)

| Fact                                                                                                                                                                                                                        | Where                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Device type `panic_button`; device token `dv1` (HMAC, 90 days), registry check per request                                                                                                                                  | `db/schema/device.ts:36`, `lib/device-token.ts:24`, `routes/device-id.ts` (`registeredDeviceIdOf`)                                    |
| Room → panic device: `facility_units.panic_device_id` (nullable, no FK), label `code varchar(20)`                                                                                                                           | `db/schema/facility.ts:173-175`                                                                                                       |
| Staff PIN: 6 digits, `scrypt-hmac-sha256-v1` (N=16384, r=8, p=1), pepper per tenant+outlet v≥2, sealed on edge                                                                                                              | `packages/shared/src/identity/limits.ts:74`, `services/device-pin-hash.ts`, `device-pin-pepper.ts:8-46`, `db/schema/edge-node.ts:488` |
| PIN proof (purpose `attendance_clock` only), TTL 120 s; device throttle 10 wrong per 5 min; staff locks after 5 wrong (`MAX_STAFF_PIN_ATTEMPTS`) for 15 min; the per-staff 10-in-5-min window applies only to approver PINs | `services/staff-pin-proof.service.ts:56-63`, `:579`; `limits.ts:82`                                                                   |
| PIN generations win by `pinGenerationAt`; edge pulls PIN and device registry every 60 s                                                                                                                                     | `services/staff-pin-sync.ts:87`; `edge/config.ts:42-47`, `edge/runtime.ts:1051,1088`                                                  |
| Password sign-in cannot succeed on the edge (no password hashes replicated)                                                                                                                                                 | `docs/design/hris-edge-replication.md` §12, `edge/mode.ts:59-68`                                                                      |
| Outbox edge → cloud, dedupe by `(tenant, edge node, direction, event_id)` and aggregate sequence; cloud receive guard; conflicts table                                                                                      | `db/schema/edge-node.ts:213,250,256` (`edge_outbound_queue`), `:362` (`edge_received_events`), `:383` (`edge_sync_conflicts`)         |
| Link reconnect 1-30 s, heartbeat 15 s                                                                                                                                                                                       | `edge/link-client.ts:28-30`                                                                                                           |
| On-duty sources: `shift_assignments` (businessDate + template), `attendance_logs` (offline flag, unique client event)                                                                                                       | `db/schema/hris-scheduling.ts:116`, `hris-attendance.ts:283,341`                                                                      |
| Permissions `facility.booth.operate`, `facility.access.assist`                                                                                                                                                              | `packages/shared/src/access/permissions.ts:208-209`, roles `roles.ts:208-419`                                                         |
| RLS helpers                                                                                                                                                                                                                 | `db/tenant.ts:14,43` (`withTenant`, `app.tenant_id`, `app.outlet_ids`), `drizzle/0001_tenant_rls.sql`, `0032_outlet_rls.sql`          |

Nothing of the relay is on m1. The two drafts:

- `ws/bod-emergency-relay`: `panic_alerts` with device event dedupe, ingest by
  device token, in-process hub with WS protocol `legend.panic.v1`, staff socket
  by Better Auth session cookie + `facility.booth.operate`, first-ack-wins,
  response time, about 25 tests. On-duty = latest attendance log only.
- `ws/edge-emergency`: `edge_emergency_deliveries`, ingest creates a
  `facility_incidents` row, duty = published shift **or** local clock-in,
  retry while nobody is connected, facility snapshot pull; no ack.

## 3. Decisions

### D-01 Base: port the bod draft, add the good parts of the other

Port `ws/bod-emergency-relay` (schema, ingest, hub, ack, tests) onto m1 with
new migration numbers, then add from `ws/edge-emergency`: duty union, resend
loop, label snapshot. The staff socket auth is replaced by D-03 (the draft's
Better Auth cookie cannot work offline). The draft table
`edge_emergency_deliveries` is replaced by `panic_alert_deliveries` (D-08).
Neither branch is merged; both are reading material.

### D-02 Who receives

All of these, checked at fan-out time and again on every resend:

1. Same tenant and outlet as the alert.
2. Has permission `facility.emergency.respond` (new; roles in QE2).
3. On duty (D-04).
4. Holds a live receiver session (D-03) with an open socket.

### D-03 Local auth: receiver session = registered device + staff PIN

Flow on the edge:

1. The device is a registered outlet device of type `pos` or `waiter_phone`,
   with a valid `dv1` token (`registeredDeviceIdOf`: active, not rotated out,
   this edge's outlet). Unknown devices get 401 before any PIN check, so a
   stranger on the outlet Wi-Fi cannot guess PINs.
2. Staff picks their name on that device and types the PIN. The edge verifies
   the PIN directly (same hash, pepper, device throttle, staff lock) and issues
   the session in the same transaction. It writes no `staff_pin_proofs` row:
   `consumePinProof` / `assertLivePinProof` do not check the purpose and
   `issuePinProof` ends the device's live proof of any purpose, so an emergency
   proof could clock attendance (`hris-attendance.service.ts:1297`). A new
   function next to `issuePinProof` in `staff-pin-proof.service.ts` shares its
   verify + throttle code.
3. If the staff is on duty (D-04) and has the permission, the edge creates a
   receiver session. The cookie value is `<tenantId>.<base64url of 32 random bytes>`,
   returned once as an HttpOnly, SameSite=Strict cookie `legend_emergency`
   (Secure when the edge serves HTTPS), path `/api/emergency`. Stored only as
   SHA-256 (the token is random and long; a slow hash adds nothing). The lookup
   is a named `findReceiverSessionAny` that takes the tenant from the prefix,
   then matches the SHA-256 under that tenant (cloud sockets have no tenant
   context at upgrade; tenant RLS).
4. The WebSocket `/api/emergency/ws` (subprotocol `legend.emergency.v1`)
   authenticates with that cookie on upgrade. `guardEdgeUpgrades` only applies
   the route split, so the upgrade handler adds an explicit Origin check against
   the web origin (`WEB_URL` + `TRUSTED_ORIGINS`; on the edge, its own web
   origin, **TBD-verify** the value). Session and acknowledge routes use
   `requireTrustedOrigin`. The token never appears in a URL or a log.

Scope: the session allows only: open the socket, send delivery receipts,
acknowledge an alert, end its own session (no resolve). Nothing else on the
edge accepts it.

Lifetime: until the end of the duty window from D-04, at most 14 hours.
One live session per device (a new one replaces the old: `replaced`); at most
3 live sessions per staff.

Revocation (session closed, socket closed with code 4401). One rule: at every
send and every request the edge re-checks the session's `pin_generation_at`
against the current `staff_pins` generation, the device registry status, the
permission and the duty. The existing pulls update those rows; there is no hook
in `pullStaffPins`.

| Event                                          | Delay         |
| ---------------------------------------------- | ------------- |
| Staff logs out on the device                   | immediate     |
| PIN changed or reset (newer `pinGenerationAt`) | ≤ 60 s online |
| Staff deactivated or permission removed        | next pull     |
| Device revoked or token rotated                | ≤ 60 s online |
| Duty window ends                               | ≤ 60 s        |

While offline, cloud-side revocations wait for the link. Accepted: the session
can only receive alerts and confirm them, and it dies with the duty window.

Rotation: pepper rotation does not touch sessions (the PIN did not change).
PIN rotation ends them (above).

Why not Better Auth on the edge: password sign-in cannot succeed there by
design, and the PIN path is already replicated, peppered per outlet and
throttled. Why device + PIN, not PIN alone: a 6-digit PIN has a million values;
binding guesses to registered devices plus the throttles makes guessing
from the Wi-Fi impossible.

### D-04 On duty, computed from edge data

Staff is on duty at outlet O at time t when either:

- (a) a published `shift_assignments` row for O covers t with a grace of
  30 minutes before start and 30 minutes after end (overnight shifts handled
  from `businessDate` + template times; **TBD-verify** the template time
  columns), or
- (b) the latest clock-in at O (edge-local or replicated) has no later
  clock-out and is less than 14 hours old.

Clock-out ends (b) but not (a) (CTO decision). A session is refused with 403
`NOT_ON_DUTY` when neither holds. This answers open question 4 of the draft:
clock-in alone counts for at most 14 hours.

### D-05 Fan-out within 5 seconds

- Ingest commits the alert, then the in-process hub (keyed by tenant + outlet)
  sends it to every eligible socket. The phone answers with a `received`
  frame; the edge records it per recipient.
- Resend every 3 seconds to eligible sockets that have not sent `received`,
  until someone acknowledges or 10 minutes pass. A socket that connects later
  gets every open alert of its outlet at once.
- Heartbeat: ping every 10 s; a socket without pong for 25 s is dropped.
- No recipient has sent `received` within 15 seconds (this also covers
  half-open sockets of locked phones): the alert triggers the fallback in QE1.
  While nobody is connected, the alert records `unrouted_since` and keeps
  retrying. Web limit: a phone with a locked screen or the browser in the
  background may not ring while offline; the QE1 fallback covers it.
- Proof of FAC-08 (draft open question 5, option A): per alert,
  `first_delivered_at - received_at` from client receipts, measured on the edge
  clock when the `received` frame arrives, and per recipient. The acceptance
  test asserts under 5 s with the cloud link down.
- Budget: device → edge on LAN under 0.5 s, insert + commit under 0.2 s, hub
  send + receipt under 1 s. The 3-second resend leaves one retry inside 5 s.

On a cloud-only outlet (no edge), the same ingest and hub run in the cloud
API. **TBD-verify** that the cloud API runs as one instance; if not, cloud
fan-out needs a shared bus and moves to `legend-kmjax` (web push).

### D-06 Ingest from the button

`POST /api/emergency/press`, device token only (registry check per request),
`device.type = 'panic_button'`, device outlet = this edge's outlet. Body
(strict Zod): `eventId` (1-64 chars, unique per press, made by the device),
`triggeredAt` (ISO, optional; the device clock may be wrong), `kind`
(`press` | `test`).

- Every press is stored in `panic_press_events`, PK `(tenant_id, device_id,
device_event_id)`, with `alert_id` and `received_at`.
- Alert id is deterministic: UUID from SHA-256 of (tenant_id, device_id, first
  press `device_event_id`), version bits set like v5. A standby replaying the
  same first press makes the same id.
- Same `(device, eventId)` again, even after acknowledgement: finds its press
  row and returns the same alert (200). While the alert is not acknowledged it
  is re-published.
- Another press from the same device within 60 seconds while the alert is not
  acknowledged is folded: its press row points to the same alert, and
  `press_count + 1` (a stuck button cannot flood).
- More than 30 requests per minute from one device: 429, but the alert already
  stored stays live.
- Room from `facility_units.panic_device_id`; unknown room still raises an
  alert with the device label.
- `test` presses ring with a "UJI" flag and are left out of incident reports.

### D-07 Acknowledge and resolve

- Acknowledge: on the edge by any recipient with a live session, and in the
  cloud by normal cloud auth. First wins (row lock); a later one gets 409 with
  who acknowledged. Response time = `acknowledged_at - received_at`.
- Resolve (close with a note, at most 500 characters, no guest personal data):
  cloud only, by managers with new permission `facility.emergency.resolve`
  (outlet_manager, general_manager), normal cloud auth. Not available on the
  edge. Resolve sets acknowledge too when it was empty.

### D-08 Data and migrations 0400-0402

Numbers are provisional; the merge train renumbers. All four tables exist in
both databases (same image); sessions and deliveries are used only where the
hub runs. Every table: `tenant_id` and `outlet_id` NOT NULL, tenant + outlet
RLS (`app.enforce_tenant_rls` / `app.enforce_outlet_rls`), unique keys include
`tenant_id`.

**0400 `panic_alerts`**: PK `(tenant_id, id)`, id = deterministic UUID made at
ingest (D-06; the same id in the cloud). `outlet_id`; `device_id` and `unit_id`
uuid **without FK** (a safety record is never refused because the cloud deleted
the room while offline); `first_device_event_id` text; snapshots
`unit_code_snapshot`, `facility_name_snapshot`, `device_label_snapshot` (labels
as they were at the press, draft open question 3, option A); `kind`
(`press`,`test`); `triggered_at` (device clock, nullable), `received_at` (edge
clock, NOT NULL); `press_count`; `origin` (`edge`,`cloud`),
`origin_edge_node_id`; `link_offline` boolean; `first_delivered_at`,
`delivered_count`; `unrouted_since`, `fallback_shown_at`; `acknowledged_at`,
`acknowledged_by`, `ack_device_id`; `resolved_at`, `resolved_by`,
`resolution_note` varchar(500); `created_at`. No unique key on the device event:
press dedupe lives in `panic_press_events`. Index
`(tenant_id, outlet_id, received_at DESC)` and
`(tenant_id, outlet_id) WHERE acknowledged_at IS NULL`.
Trigger: identity, snapshot and `received_at` columns immutable;
`acknowledged_*` and `resolved_*` set once; no DELETE.

**0400 `panic_press_events`**: PK `(tenant_id, device_id, device_event_id)`;
`outlet_id`; `device_id` uuid without FK (as above); `device_event_id` text;
`alert_id` (same tenant, the alert this press belongs to); `received_at` (edge
clock, NOT NULL).

**0401 `panic_receiver_sessions`**: PK `(tenant_id, id)`; `outlet_id`,
`device_id`, `user_id`; `token_hash` bytea(32), unique `(tenant_id, token_hash)`
(the tenant comes from the cookie prefix, D-03); `pin_generation_at` (the PIN
generation used); `issued_at`, `expires_at`, `last_seen_at`; `revoked_at`,
`revoke_reason` IN (`logout`,`replaced`,`pin_changed`,`staff_inactive`,
`permission_removed`,`device_revoked`,`off_duty`,`expired`). Unique
`(tenant_id, device_id) WHERE revoked_at IS NULL`.

**0402 `panic_alert_deliveries`**: PK `(tenant_id, alert_id, session_id)`;
`outlet_id`, `user_id`; `first_sent_at`, `sent_count`, `received_at`.

### D-09 Sync to the cloud without duplicates

- In the same transaction as each state change, the edge writes an outbox row
  in `edge_outbound_queue`: aggregate `panic_alert`, aggregate id = alert id,
  sequence 1 `panic_alert.raised` (includes the first press), then
  `panic_alert.pressed` (folded press), `panic_alert.delivered` (batched every
  5 s while new receipts arrive), `panic_alert.acknowledged`. The event id
  (ULID) is fixed at enqueue; retries resend the same row. Resolve is cloud-only
  and never sent to the edge, so the edge aggregate has one writer and no
  sequence collision.
- Offline: rows wait; on reconnect they drain in order. The cloud dedupes by
  `edge_received_events` and the aggregate sequence (existing). Applier:
  `raised` → insert `ON CONFLICT (tenant_id, id) DO NOTHING`; `pressed` → press
  insert `ON CONFLICT DO NOTHING`, and a press already mapped to another alert
  id in the cloud → conflict row, keep both alerts; later events → set-once and
  monotonic updates (`delivered_count = GREATEST(...)`, `press_count =
GREATEST(...)`).
- Cloud changed while offline (room deleted, device revoked, labels renamed):
  the alert is stored as sent, with its label snapshots; an
  `edge_sync_conflicts` row with reason `panic_alert_unknown_ref` asks a
  manager to review (draft open question 2, option B). Nothing is rejected.

### D-10 Isolation

Hub keyed by (tenant, outlet). Session bound to tenant + outlet + device +
staff. Every query under `withTenant`. Ingest refuses a device of another
outlet or tenant (401, no hint). Tests add the four tables to the RLS
allowlists (`db/rls.test.ts:85`, `db/outlet-rls.test.ts:157`).

### D-11 Edge allowlist

Add to `edge/mode.ts` the narrow prefixes: `/api/emergency/press`,
`/api/emergency/sessions` (`POST`, and `DELETE /api/emergency/sessions/current`),
`/api/emergency/alerts` (acknowledge only on the edge:
`POST /api/emergency/alerts/:id/ack`), and the upgrade path `/api/emergency/ws`
in the upgrade allowlist (`EDGE_API_EXACT_ROUTES` rejects `:id` and needs a
method). The manager list and resolve live in the cloud under
`/api/outlets/:outletId/emergency-alerts`, not in the edge prefixes. Press,
sessions, alerts and ws are not edge-only: cloud-only outlets use them too
(D-05).

## 4. Answers to the draft's open questions

| #   | Question                     | Answer                                                                                             |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | Local PIN identity           | Option A variant: PIN verified directly on a registered device; session without a PIN proof (D-03) |
| 2   | Recovery after cloud changes | Option B: store, then reconcile via `edge_sync_conflicts` (D-09)                                   |
| 3   | Historical labels            | Option A: label snapshot per alert (D-08)                                                          |
| 4   | Clock-in expiry              | 14 hours, plus shift window ± 30 min (D-04)                                                        |
| 5   | FAC-08 proof                 | Option A: client receipt per recipient (D-05)                                                      |

## 5. Acceptance tests (write first, see them fail)

Files: `apps/api/src/test/panic-relay.test.ts` (ported, extended),
`apps/api/src/test/panic-receiver-session.test.ts` (new),
`apps/api/src/test/panic-sync.test.ts` (new), plus the RLS allowlists.

- EM-01 Press with the cloud link down → an on-duty receiver gets it; receipt
  minus `received_at` under 5 s (real in-process WebSocket).
- EM-02 Off-duty staff: session refused `NOT_ON_DUTY`; an existing session
  stops receiving when the window ends.
- EM-03 Staff without `facility.emergency.respond` cannot open a session.
- EM-04 Outlet B socket never sees outlet A alerts; tenant B device token →
  401; RLS tests for the four tables.
- EM-05 Unregistered device → 401 before PIN check; 10 wrong PINs per device
  in 5 min → 429; staff locked after 5 wrong for 15 min.
- EM-06 Revocation: newer PIN generation, staff inactive, permission removed,
  device revoked → session revoked and socket closed 4401.
- EM-07 Same device event twice → one alert; the replay re-publishes while
  not acknowledged.
- EM-08 Second press within 60 s → same alert, `press_count = 2`.
- EM-09 Resend every 3 s until receipt; a late socket gets the open alert.
- EM-10 Two acknowledgements → first wins, second 409; response time stored.
- EM-11 Offline: 3 alerts + 1 acknowledgement; reconnect → cloud has exactly
  3 alerts and one acknowledgement; replaying the whole queue changes nothing.
- EM-12 Room deleted in the cloud while offline → alert stored, conflict row
  written.
- EM-13 The token is never in a URL; logs redact the cookie.
- EM-14 Nobody connected → `unrouted_since` set; after 15 s the fallback fires
  (only if QE1 = yes).
- EM-15 Test press flagged "UJI" and excluded from the incident report query.
- EM-16 An emergency session login leaves no PIN proof and cannot clock
  attendance.
- EM-17 WS upgrade from another Origin refused; acknowledge without a trusted
  origin refused.
- EM-18 Button retry after acknowledgement → same alert; replay of the same
  first press on a second database → same alert id.
- EM-19 A socket that never sends `received` → fallback at 15 s (only if
  QE1 = yes).
- EM-20 Resolve on the edge → 404; cloud resolve needs
  `facility.emergency.resolve`.

Red proof: EM-01, EM-05, EM-06, EM-11 fail on m1 before the work; EM-16, EM-17,
EM-18 fail before the work as well.

## 6. Cards (children of `legend-bod`)

All tier K (access). Order: ET, then E1; E2, E3, E4 in parallel after E1.
Existing follow-ups re-pointed: `legend-kpzmi` (staff banner UI) after E2 and
E3; `legend-kmjax` (cloud web push fallback) after E4; `legend-oc3` (offline
drill e2e) already depends on `legend-bod`.

| Card | Who         | Scope                                                                                                                                                                               | Main files                                                                                                                                                                                      | Depends on |
| ---- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| ET   | test-writer | §5 tests, red on m1, port draft tests                                                                                                                                               | `test/panic-relay.test.ts`, `test/panic-receiver-session.test.ts`, `test/panic-sync.test.ts`, RLS allowlists                                                                                    | —          |
| E1   | engineer    | Port draft schema, incl. `panic_press_events`; deterministic alert id; migrations 0400-0402; shared Zod (press body, session issue, WS frames, sync event payloads, enqueue helper) | `drizzle/0400_*.sql`..`0402_*.sql`, `db/schema/panic-alert.ts`, `packages/shared/src/facility/emergency.ts` (new)                                                                               | ET         |
| E2   | engineer    | Receiver sessions: direct PIN verify without proof, cookie with tenant prefix, Origin check, re-check at every send/request                                                         | `services/staff-pin-proof.service.ts` (new verify function), `services/panic-receiver-session.ts` (new), `edge/staff-pin-pull.ts`, `edge/access-applier.ts`, `routes/emergency.routes.ts` (new) | E1         |
| E3   | engineer    | Ingest, duty resolver, hub, receipts, resend, acknowledge, fallback hook, edge allowlist; narrow prefixes, fallback on no receipt                                                   | `services/panic-relay.service.ts`, `edge/panic-relay-hub.ts`, `services/on-duty.ts` (new), `edge/mode.ts`                                                                                       | E1         |
| E4   | engineer    | Outbox events, cloud applier, conflict rows, cloud list + resolve routes (no cloud → edge resolve)                                                                                  | `edge/panic-alert-applier.ts` (new), `routes/emergency.routes.ts` (cloud list), applier registry                                                                                                | E1         |

## 7. Questions for CTO (founder decisions, with recommendation)

- **QE1 Bila tidak ada staf yang menjawab.** Bila dalam 15 detik tidak ada
  staf on-duty yang mengonfirmasi, alarm juga tampil di semua layar POS outlet
  itu, termasuk yang tidak sedang login PIN. Pelanggan di depan kasir mungkin
  melihat tulisan "DARURAT: Kamar 5". **Rekomendasi:** ya, tampilkan di layar
  POS dengan teks singkat (nama ruangan dan jam saja). Alternatif: tidak;
  alarm hanya ke staf on-duty dan terus diulang.
  Catatan: HP yang layarnya terkunci atau browsernya di latar belakang bisa
  tidak berbunyi saat internet mati; layar POS menjadi cadangan.
- **QE2 Siapa yang menerima alarm.** **Rekomendasi:** staf on-duty dengan peran
  facility attendant, supervisor, outlet manager, dan general manager. Kasir
  dan dapur tidak menerima (mereka tetap melihat lewat layar POS bila QE1 = ya).
  Alternatif: semua staf on-duty di outlet.
  Menutup insiden hanya manajer outlet dan general manager, di cloud.

Technical choices taken by the architect: PIN on a registered device as the
only local credential (D-03), 14-hour cap on clock-in duty (D-04), alerts
never rejected by the cloud (D-09).

## 8. Outside this design

- Button hardware and how it signs requests (device token on the button or a
  small bridge on the LAN): provisioning card `legend-16s`.
- Web push to staff off the LAN while the cloud is reachable: `legend-kmjax`.
- Staff banner and confirm screen: `legend-kpzmi` (UI, founder review).
