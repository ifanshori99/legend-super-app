# Edge status to cloud: hard-stale alarm and back-office node list

Status: design, tier K (cross-outlet access, edge-cloud protocol, migration).
Owner: architect (brief 1060). Date: 2026-11-18. Reviewed once (fresh-context
reviewer, 0 P1; P2 findings folded in below).
Beads: legend-uvnll (hard-stale alarm reaches the owner), legend-ph62j (back-office
"Status edge" screen: cloud API, permission, persisted alert state, node name).
Base: `origin/milestone/m1` 63d467e27. `main` is stale (2026-11-08) and is not
a reference for this design.

Read against: `apps/api/src/edge/{protocol,link-server,link-client,runtime,
device-registry-puller,deferred-event-applier,applier-registry,ports}.ts`,
`apps/api/src/edge/print/{runtime,alert-applier}.ts` (precedent),
`apps/api/src/services/{edge-sync-conflict-alert,edge-device-sync,
edge-queue.service,pos-receipt.service,edge-node.service,
edge-sync-conflict.service}.ts`, `apps/web/src/features/ws02-edge/` (UI approved
by the founder, Q35/Q96), WIP `wip/1041-hard-stale` ab67f9d31 (superseded by
this design).

## 1. Problem in plain words

- The edge (outlet mini PC) raises "device data too old" (`hard_stale`,
  legend-2lgu) when it could not refresh the device list from the cloud for
  72 h. It then refuses NEW device sign-ins. Today that alarm is written only
  into the edge's own notification outbox, which delivers nothing. The owner
  never hears it.
- The back-office "Status edge" screen exists (mock only). The cloud has no
  endpoint that lists edge nodes across outlets with a name, an outlet name and
  the receipt-run alert per node.

## 2. Decisions

### D1. The alarm travels on the existing edge -> cloud event stream, not on the heartbeat

Decision: the edge enqueues an `edge_node_alarm.raised` event (and later
`edge_node_alarm.cleared`) in its outbound queue (`enqueueEdgeEvent`,
direction `edge_to_cloud`, kind `transaction_event`). The cloud applies it in
one transaction with the alert row and the owner notification. The cloud acks
the batch only after that transaction commits.

Why (business words): an alarm about a long outage is born while the link is
down and usually clears minutes after the link returns. It must be delivered
once, even if the cloud or the edge restarts in between. The event stream
already guarantees exactly that for printer and panic alarms; the heartbeat does
not.

Why not the heartbeat flag (WIP ab67f9d31, "catalogStale pattern"):

| Need                        | Heartbeat flag                                                                                                                                                             | Event stream                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Survives edge restart       | No (WIP added a JSON file + 24 h blind replay)                                                                                                                             | Yes, edge DB outbox                                          |
| Cloud confirms after commit | No. `onHeartbeat` is fire-and-forget (`link-server.ts:276-280`); a new ACK frame breaks older edges, whose inbound decoder is a strict discriminated union (`protocol.ts`) | Yes, `ack` after `applyInbound` commits                      |
| Not dropped                 | No. Frames within 10 s of the last write are dropped whole (`LINK_HEARTBEAT_WRITE_INTERVAL_MS`)                                                                            | Yes, ordered per link, resend on gap                         |
| Duplicate-safe              | Needs new episode logic                                                                                                                                                    | `edge_received_events` dedupe by event id                    |
| Cross-tenant safe           | Scope from credential                                                                                                                                                      | Scope from credential, plus `assertEdgeEventScope`           |
| Precedent                   | catalogStale (a live, level signal while the link is up)                                                                                                                   | `print_alert.raised`, panic alert, `edge_link.dead_lettered` |

catalogStale fits the heartbeat because it is a level signal sent while the link
is up. Hard-stale is an episode that mostly happens while the link is down, so
it needs at-least-once delivery. This IS the "ACK after the cloud transaction
succeeds" asked for in Codex 1041.

Consequence: WIP `wip/1041-hard-stale` (heartbeat field
`deviceRegistryHardStale`, header `x-edge-device-registry-hard-stale`,
`device-registry-alarm-queue.ts`, optional payload fields) is NOT merged.
No protocol frame or header changes.

Risk: an edge released before the cloud handler: the cloud parks the unknown
event (`edge_deferred_events`, `parked_reason='unclassified'`) and notifies
supervisors that an event was parked; it does not block the stream, and it does
not replay parked rows later. Plan: release order cloud first, then edge (same
rule as print alerts and catalogStale). Fallback if a mis-order happens: a
one-off drain of parked `edge_node_alarm` rows (pattern
`drainParkedAccessEvents`), filed only if needed.

### D2. Event contract (shared, `packages/shared/src/edge/node-alarm.ts`)

```ts
export const EDGE_NODE_ALARM_AGGREGATE = "edge_node_alarm";
export const EDGE_NODE_ALARM_RAISED = "edge_node_alarm.raised";
export const EDGE_NODE_ALARM_CLEARED = "edge_node_alarm.cleared";

// v1 carries one kind; the cloud refuses others (strict).
export const edgeNodeAlarmRaisedPayloadSchema = z.strictObject({
  kind: z.literal("device_registry_hard_stale"),
  /** Last successful registry pull; null when the replica never pulled. */
  lastPulledAt: isoDateTimeSchema.nullable(),
  // Same bounds as EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS (edge/config.ts).
  maxStaleSeconds: z.number().int().min(3600).max(2_592_000),
});
export const edgeNodeAlarmClearedPayloadSchema = z.strictObject({
  kind: z.literal("device_registry_hard_stale"),
  /** Null only when a reboot reset the age base before any pull succeeded. */
  lastPulledAt: isoDateTimeSchema.nullable(),
});
```

Envelope rules (same as `print_alert.raised`): `version: 1`,
`aggregateType: "edge_node_alarm"`, `aggregateId === id`, `sequence: 1`,
`idempotencyKey: "<name>:<id>"`, `occurredAt` = edge time of the transition.
The payload carries NO tenant, outlet or node id; the cloud takes them from the
credential (`meta.edgeNodeId`, `meta.context`) and `assertEdgeEventScope`.

Deterministic ids (ULID from SHA-256, same helper style as
`edgeDeviceRegistryHardStaleAlertId`):

- raised: `sha256("edge_node_alarm.raised\0" + edgeNodeId + "\0" + kind + "\0" + basis + "\0" + previousId)`,
  `basis` = `lastPulledAt ?? "boot:" + startedAt` (the base `isHardStale`
  measures from, `device-registry-puller.ts:152-159`). `previousId` = id of
  the node's latest `edge_node_alarm` outbox row (any status), empty when there
  is none. Chained ids make every transition unique even when the basis repeats
  (raised, cleared with no pull, raised again), while a retry of one transition
  (same previous id) keeps its id, so a repeated enqueue is a no-op
  (`enqueueEdgeEvent` is idempotent per node, direction and event id).
- cleared: same formula with `"edge_node_alarm.cleared"` and the basis at the
  moment of clearing.

### D3. Edge side (emitter): one ordered reconcile loop, durable state = the outbox

Problem the reviewer found: two independent "raised" and "cleared" calls can
reorder (a raised held in memory for retry while the cleared succeeds), and a
crash between "hard stale ended" and the cleared enqueue loses the cleared: the
puller boots with `reportedHardStale = false` (`device-registry-puller.ts:140`)
and never fires the change again.

Decision: new `apps/api/src/edge/node-alarm.ts` exports
`createNodeAlarmEmitter(deps)` with a single serialized `reconcile()`:

1. Wanted state = the puller's current `hardStale` (the status it already
   exposes to `getEdgeStatus`).
2. Last emitted state = the latest `edge_node_alarm` row of this node in the
   edge's `edge_outbound_queue` (any status; its name and event id), read once
   at boot and then kept in memory after each successful enqueue. No row =
   "cleared". The event id feeds the next transition's id (D2).
3. If wanted differs from last emitted, enqueue exactly one transition (raised
   or cleared) in its own edge-DB transaction under the edge's tenant context.
   On error, keep the last emitted state unchanged; the next call retries.
4. Calls are serialized (one in flight; a call during a run sets "run again").

Checkpoint gate: `reconcile()` does not run while the puller's local
checkpoint is not loaded (`isCheckpointLoaded()` is false). Before that the
puller cannot judge its age and reads as fresh, which would queue a false
"cleared" for an alarm that is still on. The retry tick picks it up once the
checkpoint is loaded.

Wiring in `runtime.ts`: `onHardStaleChange` (~~:1208) calls `reconcile()`
immediately (the existing local `reportDeviceRegistryHardStale` call stays for
the edge panel); the existing `catalogAlarmRetry` interval (~~:1424) also calls
`reconcile()`, which covers retries and the post-crash cleared. No JSON state
file, no heartbeat counter.

Accepted gap: if the raised row was acked AND pruned
(`EDGE_QUEUE_ACKED_RETENTION_DAYS`) AND the edge crashed before the cleared,
the cloud row stays open. It needs three rare events together; the screen still
shows the live link state.

### D4. Cloud side (applier)

Same module, `registerNodeAlarmEdgeApplier()` called next to
`registerPrintAlertEdgeApplier()` (`runtime.ts:1612`):
`registerEdgeEventHandler("edge_to_cloud", <name>, apply)` for both names and
`registerEdgeAggregateKind("edge_node_alarm", "transaction_event")`.

`applyNodeAlarmRaised(tx, event, meta)`:

1. `outletId = await assertEdgeEventScope(tx, event, meta)` (tenant, outlet and
   node checked against the credential). Through the link a foreign tenant or
   outlet never reaches the applier: `db-link-store.ts` aborts the batch first
   (T11). A `CoreError` from step 2 below rolls back only the handler's
   savepoint and is recorded as an `applier_refused` conflict, and the stream
   continues (`db-link-store.ts` ~:817-834).
2. Validate envelope rules (D2) and the strict payload; else `CoreError`
   `VALIDATION_ERROR` (same as print alert).
3. `at = min(occurredAt, cloud now)` (the edge clock is not trusted to move
   times forward).
   `raiseEdgeNodeAlert(tx, { tenantId, outletId, edgeNodeId: meta.edgeNodeId,
kind, at, detail: { lastPulledAt, maxStaleSeconds }, sourceEventId: event.id })`.
4. `notifyEdgeDeviceRegistryHardStale(tx, ctx, {...}, <cloud now>, "cloud")`.
   Recipients unchanged: outlet supervisors and owners (`alsoOwners: true`).
   The notification id stays one per outlet per UTC day, now taken from the
   cloud clock (exactly-once is already guaranteed by `edge_received_events`;
   the day id only limits noise). Known limit, accepted: a primary and a
   standby of one outlet, or two episodes on one day, give one notification
   that day; the alert table still records each node and episode.
   `maxStaleSeconds` and `lastPulledAt` stay required (revert the WIP
   "optional" change).

`applyNodeAlarmCleared(tx, event, meta)`: steps 1-2, then
`resolveEdgeNodeAlerts(tx, { tenantId, edgeNodeId: meta.edgeNodeId, kind,
at: min(occurredAt, cloud now) })`. No notification. A cleared event with no
open row is a no-op. Ordering per link plus the serialized emitter (D3) means a
raised never arrives after its own cleared.

Cloud copy (inline, like the edge copy):

- title: "Data perangkat di edge sempat terlalu lama tidak diperbarui"
- body: "Server lokal outlet ini lebih dari {jam} jam tidak menerima data
  perangkat dari cloud, jadi perangkat baru tidak dapat masuk. Peringatan ini
  bisa tiba setelah sambungan pulih. Lihat Kelola > Status edge."

Idempotency chain: edge outbox id (D2) -> cloud `edge_received_events` dedupe ->
open-alert partial unique index (D5) -> notification id per outlet and day.
Cloud transaction fails -> no ack -> the edge resends -> applied once.

### D5. Alert state is persisted in a new table `edge_node_alerts` (migration 0678)

Migration number: 0678 is the working number the CTO assigned (range
0678-0679; 0679 unused). As with other threads, the file is generated on m1
and renamed to the working number; the merge train renumbers and rebuilds
`meta/` at merge. S1 is serial with other migration cards in the same batch.

| Column                     | Type                               | Note                                                             |
| -------------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| `id`                       | uuid pk                            | ULID as uuid, like other edge tables                             |
| `tenant_id`                | uuid not null                      | RLS                                                              |
| `outlet_id`                | uuid not null                      | RLS outlet scope, FK outlets                                     |
| `edge_node_id`             | uuid not null                      | FK `edge_nodes(id)`, no cascade (nodes are revoked, not deleted) |
| `kind`                     | text not null                      | CHECK in (`device_registry_hard_stale`, `receipt_run_alert`)     |
| `raised_at`                | timestamptz not null               | first seen in this episode                                       |
| `last_seen_at`             | timestamptz not null               | latest confirmation                                              |
| `resolved_at`              | timestamptz null                   | null = open; CHECK `resolved_at >= raised_at`                    |
| `detail`                   | jsonb not null default `'{}'`      | counts and times only; no device ids, no secrets                 |
| `source_event_id`          | uuid null                          | edge event that opened it                                        |
| `created_at`, `updated_at` | timestamptz not null default now() |                                                                  |

Indexes: unique `(tenant_id, edge_node_id, kind) WHERE resolved_at IS NULL`
(one open alert per node and kind; pattern `inventory_stock_alerts`), and
`(tenant_id, outlet_id) WHERE resolved_at IS NULL`.
RLS: copy the tenant and outlet policies of `edge-node.custom.sql`.
If `edge_nodes` already has a unique key on `(tenant_id, outlet_id, id)`, use a
composite FK on those three columns; otherwise the single FK, since every
writer takes the three ids from the credential.

Service `apps/api/src/services/edge-node-alert.service.ts` (callers pass ids
from the credential or the verified session, never from a request body):

```ts
raiseEdgeNodeAlert(tx, input: {
  tenantId; outletId; edgeNodeId; kind: EdgeNodeAlertKind; at: Date;
  detail: Record<string, string | number | null>; sourceEventId?: string;
}): Promise<{ opened: boolean }>
// INSERT ... ON CONFLICT (tenant_id, edge_node_id, kind) WHERE resolved_at IS NULL
// DO UPDATE SET last_seen_at = GREATEST(old, new), detail = EXCLUDED.detail, updated_at = now()

resolveEdgeNodeAlerts(tx, input: {
  tenantId; edgeNodeId; kind; at: Date; quietSince?: Date;
}): Promise<number>
// UPDATE ... SET resolved_at = GREATEST(at, raised_at)
// WHERE ... AND resolved_at IS NULL [AND last_seen_at <= quietSince]
```

No "acknowledged" column: the approved screen has no "mark as seen" action
(only "Perbarui status" and "Coba lagi"). An alert closes when its condition
clears.

### D6. Receipt-run alert is persisted where the cloud computes it

The cloud computes `alert` while serving an edge's device-registry pull
(`edge-device-sync.ts` ~:262-345, from `pos-receipt.service.ts` ~:1206: cloned
DB, repeated regressions, or throttled refusals). Today it is only logged and
sent to the edge in the page. The claim runs only for the active PRIMARY node
that sends `edgeInstance`; a standby never claims, so it never has this alert.

Decision: in the same pull transaction, inside a SAVEPOINT (nested
`tx.transaction`), only when the claim ran with a decoded `receiptRuns` report:

- `alert === true` -> `raiseEdgeNodeAlert(kind "receipt_run_alert", at: now)`.
- `alert === false` AND `claim.stale === 0` (the report was really processed,
  not skipped) -> `resolveEdgeNodeAlerts(kind "receipt_run_alert", at: now,
quietSince: now - 24 h)`. The alert closes only after 24 h without a new
  alert, so a clone and the real edge pulling in turn cannot make it flap.
- Any other pull changes nothing.

A failure in the savepoint is logged (counts only, node id) and never refuses
the page (legend-yd0h8 rule). `edgeNodeId` = `verified.edgeNodeId`. This is
more conservative than the POS panel (which clears on the next pull); the
back-office view is for the owner. No new owner notification (not requested;
see suggestions).

### D7. Node name = existing `edge_nodes.label`

`label` is NOT NULL, 1-255 chars, required by `POST /api/edge-nodes`; the local
bootstrap writes `"local"` (`edge-node.service.ts:662`). The contract exposes
it as `label`; the screen shows it as the node name, `"local"` included.
No new column, no migration for the name.

### D8. Permission: `report.operational.view`, outlet-scoped

The screen is read-only operational status, and the approved nav item already
uses `report.operational.view` (`packages/shared/src/access/permissions.ts:271`;
roles `general_manager`, `outlet_manager`, `supervisor`, `finance` in
`roles.ts:224/305/353/542`, plus owner). Reuse it; no new permission, no role
change.

- No `outletId`: `requireMenuPermission("report.operational.view")` -> scope is
  tenant-wide or the union of reachable outlets (`outletReachOf`); the service
  filters `outlet_id = ANY(scope.outletIds)` in SQL (pattern
  `listEdgeSyncConflicts`, `edge-sync-conflict.service.ts:167-209`) and runs
  under `withTenant` (RLS).
- With `outletId`: `requireOutletPermission("report.operational.view", outletId)`
  (pattern `edge-sync-conflicts.routes.ts:90-110`).
- The DTO never exposes `credential_hash`, `previous_credential_*`,
  `instance_id`, `last_sync_cursor`, `registered_by`, or revoke data.

Gap (question for the CTO, not blocking): `tenant_admin` has
`device.registry.manage` but not `report.operational.view`, so the technical
admin cannot open the screen. Default: keep as is (founder-approved nav).

## 3. API contract (ph62j)

### 3.1 Endpoint

`GET /api/edge-node-status?outletId=<id>` (new router
`routes/edge-node-status.routes.ts`, `requireAuth` + `requireTrustedOrigin`,
query `edgeNodeStatusQuerySchema` strict). Refusals per the existing permission
middleware. Active nodes only (`status = 'active'`).

### 3.2 DTO (`packages/shared/src/edge/node-status.ts`)

```ts
export const EDGE_NODE_ALERT_KINDS = ["device_registry_hard_stale", "receipt_run_alert"] as const;
export const edgeNodeAlertKindSchema = z.enum(EDGE_NODE_ALERT_KINDS);

export const edgeNodeStatusQuerySchema = z.strictObject({
  outletId: <outlet id schema used by edge-sync-conflicts>.optional(),
});

export const edgeNodeStatusAlertSchema = z.strictObject({
  kind: edgeNodeAlertKindSchema,
  raisedAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
});

export const edgeNodeStatusSchema = z.strictObject({
  id: <same id schema as edgeNodeSchema.id>,
  label: z.string().min(1).max(255),      // "local" allowed
  role: z.enum(["primary", "standby"]),
  outlet: z.strictObject({ id: <outlet id>, name: z.string().min(1).max(150) }),
  version: z.string().max(255).nullable(), // column default "unknown" -> null
  link: z.enum(["connected", "disconnected"]),
  lastHeartbeatAt: isoDateTimeSchema.nullable(),
  alerts: z.array(edgeNodeStatusAlertSchema).max(2), // open alerts only
});

export const edgeNodeStatusListSchema = z.strictObject({
  data: z.array(edgeNodeStatusSchema).max(500),
  meta: z.strictObject({ generatedAt: isoDateTimeSchema, truncated: z.boolean() }),
});
```

### 3.3 Rules

- `link = "connected"` iff `lastHeartbeatAt` exists and
  `now - lastHeartbeatAt <= EDGE_LINK_STALE_SECONDS` (default 45 s, already used
  by `qr-order-forwarding.ts:40-53`). Move `staleSeconds()` to
  `apps/api/src/edge/link-freshness.ts` and import it in both places, so the
  cloud has one definition of "edge reachable".
- `version`: the column is NOT NULL with default `"unknown"`
  (`edge-node.ts:79`); map `"unknown"` to `null`.
- Order: outlet name, role (primary first), label, id. Limit 500; fetch 501 and
  set `truncated`. (A tenant has about 1-2 nodes per outlet.)
- Alerts: one query `WHERE tenant_id AND resolved_at IS NULL AND edge_node_id =
ANY(<page ids>)`.

### 3.4 Web mapping (`features/ws02-edge`)

- `EdgeNodeRow`: `name = label`, `outletName = outlet.name`, `link`,
  `lastUpdatedAt = lastHeartbeatAt`.
- `EdgeNodesOverview.receiptRunAlert` becomes `receiptRunAlerts:
EdgeReceiptRunAlert[]` (`nodeName = label`, `alertAt = lastSeenAt`), one
  banner per alerting node with the approved banner and copy (no new text).
- `device_registry_hard_stale` is returned but not shown yet; showing it is new
  UI and needs a mockup (legend-qhymx).
- Remove the `API_MOCK` condition in `nav.ts`; remove the `CONTRACT_PENDING`
  path in `api.ts`/`hooks.ts`; delete `CONTRACT-GAPS.md`; mock mode keeps
  working via `nodes-mock.ts` shaped like the DTO.

## 4. Slices (cards)

Order: S1 first; then S2, S3, S4 in parallel (no shared files); S5 after S3.
All engineer Sonnet 5.5. One architect review per K branch; Codex second opinion
once for the area "edge status" before the release gate.

| Card         | Slice                                    | Tier                       | Base                  | Files (only these)                                                                                                                                                                                                                                                                                                                                                                          |
| ------------ | ---------------------------------------- | -------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| legend-uux9k | S1 table + shared contract               | K (migration)              | `origin/milestone/m1` | `apps/api/src/db/schema/edge-node-alert.ts` (new), `apps/api/src/db/schema/index.ts`, `apps/api/drizzle/0678_edge_node_alerts.sql` + `meta/`, RLS custom SQL next to the schema, `apps/api/src/services/edge-node-alert.service.ts` (new), `packages/shared/src/edge/node-status.ts` (new), `packages/shared/src/edge/node-alarm.ts` (new), `packages/shared/package.json` (exports), tests |
| legend-0cjzz | S2 uvnll alarm via event stream          | K (protocol, cross-tenant) | S1 branch             | `apps/api/src/edge/node-alarm.ts` (new), `apps/api/src/edge/runtime.ts` (only ~:1208 hard-stale hook, ~:1424 retry tick, ~:1612 register), `apps/api/src/services/edge-sync-conflict-alert.ts` (cloud copy variant), tests                                                                                                                                                                  |
| legend-eo3lc | S3 ph62j cloud list API                  | K (access)                 | S1 branch             | `apps/api/src/routes/edge-node-status.routes.ts` (new), `apps/api/src/routes/index.ts`, `apps/api/src/services/edge-node-status.service.ts` (new), `apps/api/src/edge/link-freshness.ts` (new), `apps/api/src/edge/qr-order-forwarding.ts` (import only), tests                                                                                                                             |
| legend-m8vf0 | S4 ph62j receipt-run alert persisted     | K (receipt-number pull tx) | S1 branch             | `apps/api/src/services/edge-device-sync.ts` (one hunk after the claim), tests                                                                                                                                                                                                                                                                                                               |
| legend-n5u8w | S5 ph62j web wired to API                | S                          | S3 branch             | `apps/web/src/features/ws02-edge/{api,types,nav,hooks,queries,nodes-mock}.ts`, `components/*` (banner list), delete `CONTRACT-GAPS.md`, tests                                                                                                                                                                                                                                               |
| legend-qhymx | Follow-up: show hard-stale on the screen | S (mockup first)           | after S3              | designer mockup, founder review                                                                                                                                                                                                                                                                                                                                                             |
| legend-5ab0l | Follow-up: cloud "edge offline" alarm    | needs founder threshold    | later                 | see R3                                                                                                                                                                                                                                                                                                                                                                                      |

### Ordering with legend-e3k4p (shares `runtime.ts`)

e3k4p (periodic reconciliation digest sender) is blocked: `buildEdgeTxnDigest`
and `POST /api/edge-nodes/:id/reconciliation` exist only on
`origin/ws/kai-edge-upsync` (legend-kai, e52264d4a), not in m1. Order: S2 first
(small hunks at ~:1208, ~:1424, ~:1612); bd dependency e3k4p -> legend-0cjzz is
set. e3k4p later puts its job in its own module
(`apps/api/src/edge/reconciliation-sender.ts`) with a two-line start/stop in
`startEdgeRuntime`, in a separate block from the `catalogAlarmRetry` interval,
based on a branch that already has S2 and kai.

## 5. Rollout

1. Cloud: S1 + S2 (applier) + S3 + S4 deploy. Old edges keep working (no frame
   change; `receiptRuns` logic unchanged for old edges).
2. Edge: release with S2's emitter after the cloud is live.
3. Web: S5 with or after S3.

Rollback: the web can return to mock; the cloud applier can stay (idle without
events); the edge emitter can be disabled by reverting S2 on the edge only.

## 6. Required tests (fail-first, targeted)

S1 (`edge-node-alert.service`):

- T1 `raiseEdgeNodeAlert` twice for one node and kind -> one open row,
  `last_seen_at` = later time, `opened` true then false.
- T2 resolve then raise -> two rows (one resolved, one open).
- T3 resolve with no open row -> 0; `resolved_at` never before `raised_at`;
  `quietSince` keeps a recently seen row open.
- T4 RLS: tenant B context cannot read or update tenant A rows; outlet-scoped
  context sees only its outlets.

S2 (uvnll):

- T5 Edge: hard-stale transition enqueues exactly one `edge_node_alarm.raised`
  in `edge_outbound_queue`; calling `reconcile()` again keeps one row.
- T6 Edge: clearing enqueues one `cleared` event after the raised (order kept).
- T7 Edge: raised enqueue fails, then hard stale ends before the retry ->
  queue ends with raised then cleared, in that order (or nothing), never
  cleared alone followed by raised.
- T8 Edge: last outbox row is raised, process restarts, puller is fresh ->
  first `reconcile()` enqueues cleared.
- T9 Cloud: apply raised -> one open alert + one notification to supervisors
  and owners; replay of the same batch -> no new row, no new notification, ack
  sent.
- T10 Cloud: transaction fails after the alert insert (forced, non-domain
  error) -> no ack, nothing committed; resend -> exactly one alert and one
  notification.
- T11 Cloud: event with another tenant's or outlet's ids on a valid credential
  -> the whole link batch is aborted and rolled back (fail-closed:
  `db-link-store.ts` refuses a foreign scope with a plain error before any
  applier runs): no ack, no row in either tenant, and events behind it in the
  batch are not applied. Called directly, the applier throws `CoreError`
  (`assertEdgeEventScope`). It is NOT an `applier_refused` conflict.
- T12 Cloud: invalid payload or envelope (sequence 2, aggregateId != id, extra
  field) -> refused, stream continues.
- T13 Cloud: cleared resolves the open row; cleared with no open row is a
  no-op; `occurredAt` in the future is clamped to cloud time.

S3 (ph62j API):

- T14 Owner (tenant-wide) sees all active nodes of all outlets with label,
  outlet name, role, version (`"unknown"` -> null); revoked nodes are absent.
- T15 Outlet manager assigned to outlet X sees only X; `outletId=Y` outside the
  scope is refused.
- T16 User without `report.operational.view` -> refused.
- T17 Tenant B session never sees tenant A nodes (also with A's `outletId`).
- T18 `link`: heartbeat 44 s ago -> connected; 46 s ago or null ->
  disconnected (default 45 s).
- T19 Only open alerts appear; resolved ones do not.
- T20 Response parses with `edgeNodeStatusListSchema` and contains no
  credential, instance or cursor fields (strict schema + explicit key check).
- T21 501 nodes -> 500 returned, `truncated: true`.

S4 (receipt-run):

- T22 Primary pull with `receiptRuns` and `alert` true -> open
  `receipt_run_alert` for that node; a standby pull never creates one.
- T23 Clean processed pull (`alert` false, `stale` 0) less than 24 h after the
  last alert -> still open; after 24 h quiet -> resolved.
- T24 Stale or skipped report, or a pull without `receiptRuns` -> no change.
- T25 Forced failure in the alert savepoint -> page still served, receipt claim
  committed.

S5 (web):

- T26 Adapter maps the DTO to the view model (name, outlet, link, time,
  banners).
- T27 Two alerting nodes -> two banners; none -> no banner.
- T28 Nav item visible outside mock for a user with the permission. ui-auditor
  at 390 and 1280 px.

## 7. Risks

- R1 Release order (D1): edge before cloud parks the alarm; visible through the
  existing "event parked" notice. Mitigation: cloud first.
- R2 After a long outage the alarm queues behind the backlog of edge events
  (FIFO per link), so it arrives minutes after reconnection. Accepted.
- R3 The owner is still not told DURING an outage: a disconnected edge cannot
  report, and the cloud has no "edge offline" alarm at all (no sweep on
  `edge_nodes.last_heartbeat_at`). This design tells the owner after the link
  returns, and the screen shows "Terputus" live. Telling the owner during the
  outage needs a cloud sweep (legend-5ab0l) and a business threshold (how many
  minutes offline during opening hours).
- R4 S4 writes inside the device-registry pull; isolated by a savepoint (T25).
- R5 Heartbeat throttle can drop catalogStale frames (existing, not changed).
- R6 Bootstrap nodes show the name "local". Accepted (brief).
- R7 `edge_node_alerts` grows slowly (a few rows per node per month); no prune
  in v1.
- R8 Standby promotion (EDG-04, not built): when it lands it must resolve the
  demoted node's open `receipt_run_alert`, since a standby never pulls with a
  claim.
- R9 One owner notification per outlet per day (D4), even for two nodes or two
  episodes; the alert rows keep the detail.

## 8. Addendum: cloud "edge offline" alarm (legend-5ab0l, S6)

Founder Q44 (18 Nov 2026): threshold = 30 minutes offline while the outlet is open. Closes R3.

- D9 Sweep: a cloud worker (`startEdgeOfflineSweepWorker`, pattern `startCatalogPublisherWorker`, `setInterval` + `unref` + `pending` guard, wired next to it in `server.ts`, interval 60 s, env `EDGE_OFFLINE_SWEEP_SECONDS`, threshold env `EDGE_OFFLINE_ALARM_MINUTES` default 30, min 5).
- D10 Rule per active node with a heartbeat: `openSince` = start of the outlet's current open window (outlet `openingHours` in `outlets.timezone`, past-midnight `closes < opens` handled, `null` day = closed). Outlet closed by schedule: no new alert. An outlet whose status is `closed` gets no new alert and its existing offline alert resolves, even if its saved schedule still says open. Local schedule boundaries use the offset at each boundary: a repeated time uses its first occurrence, and a nonexistent time shifts forward by the DST gap. Elapsed open time is measured between UTC instants. Offline when `now - max(lastHeartbeatAt, openSince) >= threshold` (so an overnight gap alone does not alarm at opening; the clock counts open time only). Node with `last_heartbeat_at` null (never connected) is skipped. Only the active node is considered; a revoked node resolves its open alert.
- D11 Persistence: kind `edge_offline` added to `edge_node_alerts` (migration 0679: replace the CHECK; `EDGE_NODE_ALERT_KINDS` and the DTO `alerts.max(3)` follow). `raiseEdgeNodeAlert` on offline; owner and supervisors notified only when the call returns `opened: true` (one notification per episode, notification id from the alert id; `alsoOwners: true`). Resolve (`resolveEdgeNodeAlerts`) as soon as a heartbeat is within the threshold of now, the node is revoked, or the outlet status is `closed`. A heartbeat later than an open alert’s `raised_at` also ends that episode at the heartbeat time, even when the heartbeat is already older than the threshold at the next sweep; that sweep may open a new episode and send a new notification. Episode recovery is derived from persisted rows, so it survives worker restarts. The screen already shows "Terputus" live; it does not render the new alert (no new UI).
- D12 Safety: each sweep runs per tenant under `withTenant`, node-by-node savepoint, a failure is logged (counts and node id) and never stops the sweep; no money touched. Notification copy: "Edge outlet tidak terhubung lebih dari {menit} menit saat jam buka" with the outlet name and link to Kelola > Status edge.
- Tests T29-T34: closed outlet no alert; open outlet offline >= 30 min raises one alert and one notification; sweep twice keeps one alert and one notification; heartbeat returns resolves; past-midnight window and timezone; null heartbeat skipped, revoked node resolves; failure in one tenant does not stop others; tenant isolation.
