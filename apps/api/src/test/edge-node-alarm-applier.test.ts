// legend-0cjzz (S2, uvnll), cloud side: `registerNodeAlarmEdgeApplier()` applies
// `edge_node_alarm.raised` / `.cleared` events that an edge sends over the link.
// Written from docs/design/edge-status-cloud.md (D2, D4, D5, tests T9-T13), not
// from the implementation. Cloud tenant, outlet, node always come from the edge
// credential (the node row), never from the payload.
//
// Assumptions (design ambiguities):
// - "Ack sent" = the link store's applyInbound resolves and the inbound cursor
//   moved (link-peer sends the ack only after applyInbound commits); "no ack" =
//   applyInbound rejects and the cursor did not move.
// - A domain refusal (CoreError: wrong scope, invalid envelope or payload) is
//   recorded as an `edge_sync_conflicts` row with reason 'applier_refused' and
//   the batch continues (design D4 step 1). If the link store aborts the batch
//   for scope refusals instead, the scope tests below fail: that is a design
//   question for the architect, not a flake.
// - Table `edge_node_alerts` and its columns come from design D5.
// - A non-domain error is forced by making the owner notification throw a plain
//   Error once (spy on services/edge-sync-conflict-alert.ts), after the alert
//   row was written in the same transaction.
// - The raised notification copy is the cloud copy of design D4; `{jam}` is
//   maxStaleSeconds / 3600.
// - Fixtures: two disposable tenants, one supervisor (outlet scope) and one
//   owner (tenant scope) in tenant 1; removed in afterAll.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import {
  EDGE_NODE_ALARM_AGGREGATE,
  EDGE_NODE_ALARM_CLEARED,
  EDGE_NODE_ALARM_RAISED,
} from "@starter/shared/edge/node-alarm";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { registerNodeAlarmEdgeApplier } from "../edge/node-alarm.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { registerEdgeDeferredFallback } from "../edge/deferred-event-applier.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { edgeEventApplier, type EdgeApplyMeta } from "../edge/ports.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import * as alerts from "../services/edge-sync-conflict-alert.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const actor = randomUUID();
const tenantId = randomUUID();
const tenant2Id = randomUUID();
const outletA = randomUUID();
const outletB = randomUUID();
const outlet2 = randomUUID();
const supervisorUserId = randomUUID();
const ownerUserId = randomUUID();
let node: AuthenticatedEdgeNode; // tenant 1, outlet A

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_STALE_SECONDS = 259_200; // 72 h
const KIND = "device_registry_hard_stale";
const TITLE = "Data perangkat di edge sempat terlalu lama tidak diperbarui";

const scopeFor = (tid: string, outletIds: string[]): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId: tid, brandId: null, source: "session" }),
    {
      kind: "outlets",
      outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
    },
  );

async function createTenantFixture(tid: string, outlets: string[]) {
  const brand = randomUUID();
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Alarm Edge', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tid,
      `alarm-edge-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tid, `alarm-edge-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tid],
  );
  for (const outletId of outlets)
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $5, 'Jl. Uji', '{}', 'active')`,
      [
        outletId,
        tid,
        brand,
        entity,
        `ALM-${randomBytes(3).toString("hex").toUpperCase()}`,
      ],
    );
}

async function addUser(
  userId: string,
  name: string,
  templateKey: "supervisor" | "owner",
  scope: { type: "outlet" | "tenant"; id: string | null },
) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)`,
    [userId, name, `alarm-${randomBytes(4).toString("hex")}@example.test`],
  );
  const role = await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, $2, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $3 AND template_key = $4`,
    [roleId, tenantId, cafeLegendPlatformFixtures.tenant.id, templateKey],
  );
  if (role.rowCount !== 1) throw new Error(`No ${templateKey} role template`);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId, scope.type, scope.id],
  );
}

async function registerNode(tid: string, outletId: string, label: string) {
  const registered = await registerEdgeNode(scopeFor(tid, [outletId]), actor, {
    outletId,
    role: "primary",
    label,
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  return authenticated;
}

// ------------------------------------------------------------------- events

function alarmEvent(input: {
  name?: string;
  tenant?: string;
  outlet?: string;
  occurredAtMs?: number;
  version?: number;
  sequence?: number;
  aggregateId?: string;
  payload?: Record<string, unknown>;
}): EventEnvelope {
  const id = createUlid(Date.now());
  const name = input.name ?? EDGE_NODE_ALARM_RAISED;
  const raised = name === EDGE_NODE_ALARM_RAISED;
  return {
    id,
    tenantId: tenantIdSchema.parse(input.tenant ?? tenantId),
    outletId: outletIdSchema.parse(input.outlet ?? outletA),
    name,
    version: input.version ?? 1,
    aggregateType: EDGE_NODE_ALARM_AGGREGATE,
    aggregateId: input.aggregateId ?? id,
    sequence: input.sequence ?? 1,
    occurredAt: new Date(input.occurredAtMs ?? Date.now()).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${name}:${id}`,
    payloadSchemaRef: `${name}.v1`,
    payload: (input.payload ??
      (raised
        ? {
            kind: KIND,
            lastPulledAt: new Date(Date.now() - 80 * HOUR).toISOString(),
            maxStaleSeconds: MAX_STALE_SECONDS,
          }
        : {
            kind: KIND,
            lastPulledAt: new Date().toISOString(),
          })) as EventEnvelope["payload"],
  };
}

const raisedEvent = (input: Parameters<typeof alarmEvent>[0] = {}) =>
  alarmEvent({ ...input, name: EDGE_NODE_ALARM_RAISED });
const clearedEvent = (input: Parameters<typeof alarmEvent>[0] = {}) =>
  alarmEvent({ ...input, name: EDGE_NODE_ALARM_CLEARED });

// --------------------------------------------------------------- link + SQL

function store(n = node) {
  return createDbLinkStore({
    database: db,
    context: n.context,
    node: n.scope,
    outboundDirection: "cloud_to_edge",
  });
}

async function cursor(n = node) {
  return store(n).lastReceivedInbound();
}

/** One link batch: the events get the next link sequences. */
async function deliver(events: EventEnvelope[], n = node) {
  const link = store(n);
  const from = await link.lastReceivedInbound();
  await link.applyInbound({
    fromSeq: from,
    toSeq: from + events.length,
    events: events.map((event, index) => ({
      linkSeq: from + index + 1,
      event,
    })),
  });
}

const meta = (
  context: ScopedTenantContext = node.context,
  edgeNodeId: string = node.scope.edgeNodeId,
): EdgeApplyMeta => ({
  edgeNodeId,
  direction: "edge_to_cloud",
  kind: "transaction_event",
  context,
});

function applyDirect(event: EventEnvelope, m: EdgeApplyMeta = meta()) {
  return withTenant(db, m.context, (tx) =>
    edgeEventApplier("edge_to_cloud").apply(tx, event, m),
  );
}

type AlertRow = {
  tenant_id: string;
  outlet_id: string;
  edge_node_id: string;
  kind: string;
  raised_at: Date;
  last_seen_at: Date;
  resolved_at: Date | null;
  detail: Record<string, unknown>;
  source_event_id: string | null;
};

async function alertRows(tid = tenantId): Promise<AlertRow[]> {
  const { rows } = await owner.query<AlertRow>(
    `SELECT tenant_id, outlet_id, edge_node_id, kind, raised_at, last_seen_at, resolved_at, detail, source_event_id
       FROM edge_node_alerts WHERE tenant_id = $1 ORDER BY raised_at, created_at`,
    [tid],
  );
  return rows;
}

async function notificationRows() {
  const { rows } = await owner.query<{
    user_id: string;
    title: string;
    body: string;
  }>(
    "SELECT user_id, title, body FROM notifications WHERE tenant_id = $1 ORDER BY user_id",
    [tenantId],
  );
  return rows;
}

const conflictsOf = async (eventId: string) =>
  (
    await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM edge_sync_conflicts WHERE tenant_id = $1 AND event_id = $2::uuid AND reason = 'applier_refused'",
      [tenantId, ulidToUuid(eventId)],
    )
  ).rows[0]!.n;

async function resetState() {
  await owner.query("DELETE FROM edge_node_alerts WHERE tenant_id = ANY($1)", [
    [tenantId, tenant2Id],
  ]);
  await owner.query("DELETE FROM delivery_attempts WHERE tenant_id = $1", [
    tenantId,
  ]);
  await owner.query("DELETE FROM notifications WHERE tenant_id = $1", [
    tenantId,
  ]);
  // The notification id is stable per outlet and day; the consumer dedupes on
  // its outbox row, so a row of an earlier test would hide the next one.
  await owner.query("DELETE FROM notification_outbox WHERE tenant_id = $1", [
    tenantId,
  ]);
}

// ------------------------------------------------------------------- set up

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await createTenantFixture(tenantId, [outletA, outletB]);
  await createTenantFixture(tenant2Id, [outlet2]);
  await addUser(supervisorUserId, "Supervisor Alarm", "supervisor", {
    type: "outlet",
    id: outletA,
  });
  await addUser(ownerUserId, "Owner Alarm", "owner", {
    type: "tenant",
    id: null,
  });
  node = await registerNode(tenantId, outletA, "Utama Alarm A");
});

beforeEach(async () => {
  await resetState();
  resetEdgeApplierRegistryForTests();
  registerNodeAlarmEdgeApplier();
  registerEdgeDeferredFallback();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  setAuditWriter(null);
  resetEdgeApplierRegistryForTests();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "edge_node_alerts",
      "edge_deferred_events",
      "delivery_attempts",
      "notifications",
      "notification_outbox",
      "domain_event_outbox",
      "edge_link_slots",
      "edge_inbound_events",
      "edge_received_events",
      "edge_sync_conflicts",
      "edge_outbound_queue",
      "sync_cursors",
      "edge_nodes",
      "audit_logs",
      "role_assignments",
      "roles",
      "outlets",
      "legal_entities",
      "brands",
    ])
      for (const tid of [tenantId, tenant2Id])
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tid]);
    for (const tid of [tenantId, tenant2Id])
      await client.query("DELETE FROM tenants WHERE id = $1", [tid]);
    await client.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
      [supervisorUserId, ownerUserId],
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
});

// ---------------------------------------------------------------- T9 raised

describe("legend-0cjzz cloud applier: raised", () => {
  it("T9 opens one alert for the credential's node and notifies supervisors and owners once", async () => {
    const lastPulledAt = new Date(Date.now() - 80 * HOUR);
    const event = raisedEvent({
      payload: {
        kind: KIND,
        lastPulledAt: lastPulledAt.toISOString(),
        maxStaleSeconds: MAX_STALE_SECONDS,
      },
    });
    await deliver([event]);

    const rows = await alertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: tenantId,
      outlet_id: outletA,
      edge_node_id: node.scope.edgeNodeId,
      kind: KIND,
      resolved_at: null,
      source_event_id: ulidToUuid(event.id),
      detail: {
        lastPulledAt: lastPulledAt.toISOString(),
        maxStaleSeconds: MAX_STALE_SECONDS,
      },
    });
    // Details are counts and times only.
    expect(Object.keys(rows[0]!.detail).sort()).toEqual([
      "lastPulledAt",
      "maxStaleSeconds",
    ]);

    const notifications = await notificationRows();
    expect(notifications.map((row) => row.user_id).sort()).toEqual(
      [supervisorUserId, ownerUserId].sort(),
    );
    for (const row of notifications) {
      expect(row.title).toBe(TITLE);
      expect(row.body).toContain("72 jam");
      expect(row.body).toContain("Status edge");
    }
  });

  it("T9 a replay of the same event adds no alert and no notification, and still acks", async () => {
    const event = raisedEvent();
    await deliver([event]);
    const afterFirst = await cursor();

    // The edge did not see the ack and sends the same event again.
    await expect(deliver([event])).resolves.toBeUndefined();

    expect(await cursor()).toBeGreaterThan(afterFirst); // acked (cursor moved)
    expect(await alertRows()).toHaveLength(1);
    expect(await notificationRows()).toHaveLength(2);
  });

  it("T9 a repeated raised for the same open node and kind keeps one open alert", async () => {
    await deliver([raisedEvent()]);
    await deliver([raisedEvent()]);
    const rows = await alertRows();
    expect(rows.filter((row) => row.resolved_at === null)).toHaveLength(1);
  });

  it("T9 two episodes on the same day give two alert rows but one notification per recipient", async () => {
    await deliver([raisedEvent()]);
    await deliver([clearedEvent()]);
    await deliver([raisedEvent()]);
    const rows = await alertRows();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.resolved_at === null)).toHaveLength(1);
    expect(await notificationRows()).toHaveLength(2);
  });

  it("T10 a non-domain failure after the alert insert: no ack, nothing committed; the resend applies exactly once", async () => {
    const event = raisedEvent();
    const before = await cursor();
    const notify = vi
      .spyOn(alerts, "notifyEdgeDeviceRegistryHardStale")
      .mockRejectedValueOnce(new Error("database connection lost"));

    await expect(deliver([event])).rejects.toThrow();
    expect(notify).toHaveBeenCalledOnce();
    expect(await cursor()).toBe(before); // no ack
    expect(await alertRows()).toHaveLength(0);
    expect(await notificationRows()).toHaveLength(0);

    // The edge resends the same event; the second attempt is not forced to fail.
    await deliver([event]);
    expect(await cursor()).toBe(before + 1);
    expect(await alertRows()).toHaveLength(1);
    expect(await notificationRows()).toHaveLength(2);
  });
});

// -------------------------------------------------------------- T11 scope

describe("legend-0cjzz cloud applier: scope comes from the credential", () => {
  it("T11 the applier refuses another tenant's ids on a valid credential", async () => {
    const event = raisedEvent({ tenant: tenant2Id, outlet: outlet2 });
    await expect(applyDirect(event)).rejects.toThrow();
    expect(await alertRows(tenantId)).toHaveLength(0);
    expect(await alertRows(tenant2Id)).toHaveLength(0);
  });

  it("T11 the applier refuses another outlet of the same tenant", async () => {
    const event = raisedEvent({ outlet: outletB });
    await expect(applyDirect(event)).rejects.toThrow();
    expect(await alertRows()).toHaveLength(0);
  });

  it.each([
    ["another tenant", { tenant: tenant2Id, outlet: outlet2 }],
    ["another outlet of the tenant", { outlet: outletB }],
  ] as const)(
    "T11 through the link, an event for %s aborts the batch: no ack, nothing applied",
    async (_label, ids) => {
      // db-link-store refuses a foreign scope before any applier runs (a
      // plain Error, not an applier_refused conflict), so the good event
      // behind it is not applied either.
      const before = await cursor();
      await expect(
        deliver([raisedEvent(ids), raisedEvent()]),
      ).rejects.toThrow();
      expect(await cursor()).toBe(before);
      expect(await alertRows(tenantId)).toHaveLength(0);
      expect(await alertRows(tenant2Id)).toHaveLength(0);
    },
  );

  it("T11 a node id inside the payload is ignored: the alert belongs to the credential's node", async () => {
    // Extra fields are refused (T12), so a smuggled node id never lands anywhere.
    const event = raisedEvent({
      payload: {
        kind: KIND,
        lastPulledAt: null,
        maxStaleSeconds: MAX_STALE_SECONDS,
        edgeNodeId: randomUUID(),
      },
    });
    await deliver([event]);
    expect(await conflictsOf(event.id)).toBe(1);
    expect(await alertRows()).toHaveLength(0);
  });
});

// --------------------------------------------------------- T12 validation

describe("legend-0cjzz cloud applier: invalid events are refused, the stream continues", () => {
  const invalid: [string, Parameters<typeof raisedEvent>[0]][] = [
    [
      "an extra payload field",
      {
        payload: {
          kind: KIND,
          lastPulledAt: null,
          maxStaleSeconds: MAX_STALE_SECONDS,
          extra: 1,
        },
      },
    ],
    [
      "an unknown kind",
      {
        payload: {
          kind: "receipt_run_alert",
          lastPulledAt: null,
          maxStaleSeconds: MAX_STALE_SECONDS,
        },
      },
    ],
    [
      "a missing maxStaleSeconds",
      {
        payload: { kind: KIND, lastPulledAt: null },
      },
    ],
    [
      "maxStaleSeconds below one hour",
      {
        payload: { kind: KIND, lastPulledAt: null, maxStaleSeconds: 3599 },
      },
    ],
    [
      "maxStaleSeconds above 30 days",
      {
        payload: { kind: KIND, lastPulledAt: null, maxStaleSeconds: 2_592_001 },
      },
    ],
    [
      "a lastPulledAt that is not a date",
      {
        payload: {
          kind: KIND,
          lastPulledAt: "yesterday",
          maxStaleSeconds: MAX_STALE_SECONDS,
        },
      },
    ],
    [
      "an aggregateId different from the event id",
      {
        aggregateId: createUlid(Date.now() + 1),
      },
    ],
    ["version 2", { version: 2 }],
  ];

  it.each(invalid)("T12 refuses %s", async (_label, input) => {
    const bad = raisedEvent(input);
    const good = raisedEvent();
    await deliver([bad, good]);
    expect(await conflictsOf(bad.id)).toBe(1);
    const rows = await alertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_event_id).toBe(ulidToUuid(good.id));
  });

  it("T12 the applier throws for sequence 2 and writes nothing", async () => {
    await expect(applyDirect(raisedEvent({ sequence: 2 }))).rejects.toThrow();
    expect(await alertRows()).toHaveLength(0);
    expect(await notificationRows()).toHaveLength(0);
  });

  it("T12 a refused raised event sends no notification", async () => {
    await deliver([raisedEvent({ aggregateId: createUlid(Date.now() + 1) })]);
    // The refusal itself notifies supervisors as a sync conflict; the hard
    // stale notice must not go out.
    expect(
      (await notificationRows()).filter((row) => row.title === TITLE),
    ).toHaveLength(0);
  });

  it("T12 a cleared event with an extra payload field is refused and resolves nothing", async () => {
    await deliver([raisedEvent()]);
    const bad = clearedEvent({
      payload: { kind: KIND, lastPulledAt: null, maxStaleSeconds: 3600 },
    });
    await deliver([bad]);
    expect(await conflictsOf(bad.id)).toBe(1);
    expect((await alertRows())[0]!.resolved_at).toBeNull();
  });
});

// ---------------------------------------------------------- T13 cleared

describe("legend-0cjzz cloud applier: cleared", () => {
  it("T13 cleared resolves the open alert and sends no notification", async () => {
    await deliver([raisedEvent()]);
    const notificationsBefore = (await notificationRows()).length;

    await deliver([clearedEvent()]);

    const rows = await alertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolved_at).toBeInstanceOf(Date);
    expect(rows[0]!.resolved_at!.getTime()).toBeGreaterThanOrEqual(
      rows[0]!.raised_at.getTime(),
    );
    expect(await notificationRows()).toHaveLength(notificationsBefore);
  });

  it("T13 cleared with no open alert is a no-op and still acks", async () => {
    const before = await cursor();
    await expect(deliver([clearedEvent()])).resolves.toBeUndefined();
    expect(await cursor()).toBe(before + 1);
    expect(await alertRows()).toHaveLength(0);
    expect(await notificationRows()).toHaveLength(0);
  });

  it("T13 cleared twice resolves once and keeps the first resolved time", async () => {
    await deliver([raisedEvent()]);
    await deliver([clearedEvent()]);
    const first = (await alertRows())[0]!.resolved_at!;
    await deliver([clearedEvent()]);
    const rows = await alertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolved_at!.getTime()).toBe(first.getTime());
  });

  it("T13 an occurredAt in the future is clamped to cloud time (raised and cleared)", async () => {
    const future = Date.now() + 2 * DAY;
    await deliver([raisedEvent({ occurredAtMs: future })]);
    const slack = Date.now() + 5_000;
    let row = (await alertRows())[0]!;
    expect(row.raised_at.getTime()).toBeLessThanOrEqual(slack);
    expect(row.last_seen_at.getTime()).toBeLessThanOrEqual(slack);

    await deliver([clearedEvent({ occurredAtMs: future })]);
    row = (await alertRows())[0]!;
    expect(row.resolved_at).toBeInstanceOf(Date);
    expect(row.resolved_at!.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it("T13 a past occurredAt is kept as the time the episode began", async () => {
    const past = Date.now() - 3 * DAY;
    await deliver([raisedEvent({ occurredAtMs: past })]);
    expect((await alertRows())[0]!.raised_at.getTime()).toBe(past);
  });

  it("T13 cleared only resolves the credential's node, not another tenant's open alert", async () => {
    await deliver([raisedEvent()]);
    // Tenant 2 has its own open alert for a node of its own.
    const node2 = await registerNode(tenant2Id, outlet2, "Utama Alarm 2");
    await deliver([raisedEvent({ tenant: tenant2Id, outlet: outlet2 })], node2);
    expect(await alertRows(tenant2Id)).toHaveLength(1);

    await deliver([clearedEvent()]); // node (tenant 1)

    expect((await alertRows(tenantId))[0]!.resolved_at).toBeInstanceOf(Date);
    expect((await alertRows(tenant2Id))[0]!.resolved_at).toBeNull();
  });
});
