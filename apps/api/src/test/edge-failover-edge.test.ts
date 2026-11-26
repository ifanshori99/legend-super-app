// 1271 F4 (docs/briefs/1271-edge-failover-cards.md D2, D4, F1 ralat): the
// edge side of a failover window. Money rule: every rupiah in exactly one
// shift, a replay closes nothing twice, in doubt the edge stays blocked.
//
// - While the window copy is open the edge refuses order, shift, cash and
//   parked writes (FAILOVER_ACTIVE).
// - Worked example: edge shift expected E1 = 1,000,000, switchover count
//   C1 = 990,000 -> edge shift variance -10,000; failover shift float C1,
//   cash sales S = 300,000, count C2 = 1,290,000 (variance 0); the next edge
//   shift opens with float C2.
// - Split brain (edge activity after C1): nothing closed, copy stays open,
//   conflict kept, the cloud alerts the managers.
// - The E3 mirror accepts the forced close; a replay is one close.
//
// The test database plays both sides: the window events arrive through the
// real edge link receive path (cloud_to_edge), the edge's events go up
// through the real cloud receive path (edge_to_cloud). Failover rows of the
// cloud are seeded with owner SQL, as F3 writes them.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/edge-failover-edge.test.ts" pnpm test
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
} from "vitest";
import {
  createUlid,
  outletIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import {
  registerEdgeDeferredFallback,
  registerPosDeferredEdgeApplier,
} from "../edge/deferred-event-applier.ts";
import {
  registerFailoverEdgeApplier,
  registerFailoverRefusalCloudApplier,
} from "../edge/failover-applier.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { registerShiftDayEdgeApplier } from "../edge/shift-day-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import {
  posWriteFailoverWindowId,
  setPosWriteGateEdgeModeForTests,
  type PosWriteGateOptions,
} from "../services/pos-edge-outlet.ts";
import { listEdgeNodeStatus } from "../services/edge-node-status.service.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const actor = randomUUID();
const tenantId = randomUUID();
const outletA = randomUUID();
const brandId = randomUUID();
const cashierId = randomUUID();
const supervisorId = randomUUID();
const ownerUserId = randomUUID();
const ownerRoleId = randomUUID();
let node: AuthenticatedEdgeNode;

const scopeOf = (outletIds: string[]): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    {
      kind: "outlets",
      outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
    },
  );
const jobScope = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );

async function q<T extends object>(
  text: string,
  params: unknown[] = [],
  options: { replica?: boolean } = {},
): Promise<T[]> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (options.replica)
      await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await client.query<T>(text, params);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createFixture() {
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Failover Edge', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `fo-edge-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brandId, tenantId, `fo-edge-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'FOE-01', 'FOE-01', 'Jl. Uji', '{}', 'active')`,
    [outletA, tenantId, brandId, entity],
  );
  for (const [id, name] of [
    [cashierId, "Kasir Failover"],
    [supervisorId, "Manajer Failover"],
    [ownerUserId, "Pemilik Failover"],
  ] as const)
    await owner.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
      [id, name, `${id}@example.test`],
    );
  // The owner receives the refusal alert.
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Owner', true, 'owner', '[]'::jsonb, false, '["tenant"]')`,
    [ownerRoleId, tenantId],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId, ownerUserId, ownerRoleId],
  );
}

let clock = Date.parse("2025-04-01T09:00:00.000Z");
type Payload = Record<string, unknown>;

function envelope(
  name: string,
  aggregateId: string,
  sequence: number,
  payload: Payload,
  actorId: string | null = null,
): EventEnvelope {
  clock += 1_000;
  return {
    id: createUlid(clock),
    tenantId: tenantId as EventEnvelope["tenantId"],
    outletId: outletA as EventEnvelope["outletId"],
    name,
    version: 1,
    aggregateType: name.split(".")[0]!,
    aggregateId,
    sequence,
    occurredAt: new Date(clock).toISOString(),
    actor: actorId ? { type: "user", id: actorId } : { type: "system" },
    deviceId: null,
    idempotencyKey: `${name}:${aggregateId}:${sequence}:${clock}`,
    payloadSchemaRef: `${name}.v1`,
    payload: payload as EventEnvelope["payload"],
  } as EventEnvelope;
}

let dateSeq = 0;
function freshDate(): string {
  const day = new Date(Date.UTC(2025, 1, 2 + dateSeq * 3));
  dateSeq += 1;
  return day.toISOString().slice(0, 10);
}
const at = (date: string, hhmm: string) => `${date}T${hhmm}:00.000Z`;

/** The edge side: receives cloud -> edge events. */
const edgeStore = () =>
  createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "edge_to_cloud",
  });
/** The cloud side: receives edge -> cloud events. */
const cloudStore = () =>
  createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "cloud_to_edge",
  });

async function deliver(
  store: ReturnType<typeof createDbLinkStore>,
  events: EventEnvelope[],
) {
  const from = await store.lastReceivedInbound();
  await store.applyInbound({
    fromSeq: from,
    toSeq: from + events.length,
    events: events.map((event, index) => ({
      linkSeq: from + index + 1,
      event,
    })),
  });
}

/** The same events again, as if the link replayed them from scratch. */
async function redeliverToEdge(events: EventEnvelope[]) {
  const ids = events.map((event) => ulidToUuid(event.id));
  for (const table of ["edge_link_slots", "edge_inbound_events"])
    await q(
      `DELETE FROM ${table} WHERE tenant_id = $1 AND direction = 'cloud_to_edge' AND event_id = ANY($2::uuid[])`,
      [tenantId, ids],
      { replica: true },
    );
  await deliver(edgeStore(), events);
}

async function asEdge<T>(run: () => Promise<T>): Promise<T> {
  const saved = getEdgeRuntimeState();
  setEdgeRuntimeStateForTests({ ...saved, edgeMode: true });
  setPosWriteGateEdgeModeForTests(() => true);
  try {
    return await run();
  } finally {
    setPosWriteGateEdgeModeForTests(null);
    setEdgeRuntimeStateForTests(saved);
  }
}

/** The window as the cloud sends it. */
function windowDto(
  id: string,
  date: string,
  status: "active" | "returning" | "cancelled",
): Payload {
  return {
    id,
    outletId: outletA,
    edgeNodeId: node.scope.edgeNodeId,
    status,
    reason: "Mini PC mati",
    override: false,
    activatedBy: supervisorId,
    activatedAt: at(date, "05:00"),
    edgeHeartbeatAt: null,
    businessDateFrom: date,
    businessDateTo: status === "active" ? null : date,
    returnStartedAt: status === "returning" ? at(date, "09:00") : null,
    returnStartedBy: status === "returning" ? supervisorId : null,
    closedAt: null,
    cancelledAt: status === "cancelled" ? at(date, "06:00") : null,
    cancelledBy: status === "cancelled" ? supervisorId : null,
  };
}

const stateEvent = (
  id: string,
  date: string,
  status: "active" | "returning" | "cancelled",
  sequence: number,
) =>
  envelope(
    "pos_failover_window.state",
    id,
    sequence,
    { window: windowDto(id, date, status) },
    supervisorId,
  );

/** C1 = 990,000: 9 x 100,000 + 1 x 50,000 + 2 x 20,000. */
const C1_COUNTS = [
  { denominationIdr: 100000, quantity: 9 },
  { denominationIdr: 50000, quantity: 1 },
  { denominationIdr: 20000, quantity: 2 },
];

function closedEvent(
  id: string,
  date: string,
  deviceId: string,
  sequence: number,
): EventEnvelope {
  return envelope(
    "pos_failover_window.closed",
    id,
    sequence,
    {
      windowId: id,
      status: "closed",
      businessDates: [date],
      shifts: [
        {
          deviceId,
          cashierId,
          countedAt: at(date, "06:00"),
          counts: C1_COUNTS,
          totalIdr: 990000,
        },
      ],
    },
    supervisorId,
  );
}

/** The interrupted edge shift: float 1,000,000, nothing else (E1). */
async function edgeShift(date: string, deviceId: string): Promise<string> {
  const shiftId = randomUUID();
  await q(
    `INSERT INTO pos_shifts
       (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status, opened_at,
        opening_float_idr, open_key, open_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, 1000000, $8, $9)`,
    [
      shiftId,
      tenantId,
      outletA,
      deviceId,
      cashierId,
      date,
      at(date, "01:00"),
      `open-${shiftId}`,
      "0".repeat(64),
    ],
    { replica: true },
  );
  return shiftId;
}

/** The cloud failover shift: float C1, cash sales S, counted C2, variance 0. */
async function failoverShift(
  windowId: string,
  date: string,
  deviceId: string,
): Promise<string> {
  const shiftId = randomUUID();
  await q(
    `INSERT INTO pos_shifts
       (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status, opened_at,
        opening_float_idr, cash_sales_idr, expected_idr, counted_idr, variance_idr,
        difference_idr, counts, count_id, approved_by, approval_request_id,
        approval_override_id, approved_at, closed_at, closed_by, open_key,
        open_fingerprint, close_key, close_fingerprint, failover_window_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'closed', $7, 990000, 300000, 1290000, 1290000, 0, 0,
        '[]'::jsonb, $8, $9, $10, $11, $12, $12, $9, $13, $14, $15, $14, $16)`,
    [
      shiftId,
      tenantId,
      outletA,
      deviceId,
      cashierId,
      date,
      at(date, "06:01"),
      randomUUID(),
      supervisorId,
      randomUUID(),
      randomUUID(),
      at(date, "08:30"),
      `open-${shiftId}`,
      "0".repeat(64),
      `close-${shiftId}`,
      windowId,
    ],
    { replica: true },
  );
  return shiftId;
}

type ShiftRow = {
  status: string;
  opening_float_idr: string;
  cash_sales_idr: string;
  expected_idr: string | null;
  counted_idr: string | null;
  variance_idr: string | null;
  approved_by: string | null;
  close_key: string | null;
};
const shiftOf = async (id: string) =>
  (
    await q<ShiftRow>(
      `SELECT status, opening_float_idr::text, cash_sales_idr::text, expected_idr::text,
              counted_idr::text, variance_idr::text, approved_by, close_key
         FROM pos_shifts WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    )
  )[0]!;
const copyStatus = async (id: string) =>
  (
    await q<{ status: string; idempotency_key: string }>(
      `SELECT status, idempotency_key FROM outlet_failover_windows WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    )
  )[0];
const closedEventsOf = (shiftId: string) =>
  q<{ event: EventEnvelope }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'cashier_shift.closed'`,
    [tenantId, shiftId],
  );

const gate = (options: PosWriteGateOptions) =>
  withTenant(db, jobScope(), (tx) =>
    posWriteFailoverWindowId(
      tx,
      jobScope().tenant.tenantId,
      outletIdSchema.parse(outletA),
      options,
    ),
  );

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await createFixture();
  const registered = await registerEdgeNode(scopeOf([outletA]), actor, {
    outletId: outletA,
    role: "primary",
    label: "Utama Failover Edge",
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  node = authenticated;
});

afterEach(async () => {
  // A failed test must not leave the outlet's one open window behind.
  await q(
    `UPDATE outlet_failover_windows
        SET status = 'closed', business_date_to = coalesce(business_date_to, business_date_from),
            return_started_at = coalesce(return_started_at, now()),
            return_started_by = coalesce(return_started_by, activated_by), closed_at = now()
      WHERE tenant_id = $1 AND status IN ('active', 'returning')`,
    [tenantId],
    { replica: true },
  );
  // One open shift per cashier: the next test seeds its own.
  await q(
    `DELETE FROM cash_movements WHERE tenant_id = $1 AND shift_id IN
       (SELECT id FROM pos_shifts WHERE tenant_id = $1 AND status = 'open')`,
    [tenantId],
    { replica: true },
  );
  await q(
    `DELETE FROM pos_shifts WHERE tenant_id = $1 AND status = 'open'`,
    [tenantId],
    { replica: true },
  );
  setPosWriteGateEdgeModeForTests(null);
});

beforeEach(() => {
  resetEdgeApplierRegistryForTests();
  registerFailoverEdgeApplier();
  registerFailoverRefusalCloudApplier();
  registerPosDeferredEdgeApplier();
  registerShiftDayEdgeApplier();
  registerEdgeDeferredFallback();
});

afterAll(async () => {
  resetEdgeApplierRegistryForTests();
  setAuditWriter(null);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    for (const table of [
      "edge_pos_ingests",
      "notifications",
      "cash_movement_outcomes",
      "cash_movements",
      "pos_shift_counts",
      "pos_shifts",
      "outlet_failover_windows",
      "edge_deferred_events",
      "domain_event_outbox",
      "notification_outbox",
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
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await client.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      [cashierId, supervisorId, ownerUserId],
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

describe("1271 F4 edge failover", () => {
  it("refuses order, shift, cash and parked writes on the edge while the copy is open", async () => {
    const date = freshDate();
    const windowId = randomUUID();
    await deliver(edgeStore(), [stateEvent(windowId, date, "active", 1)]);
    expect(await copyStatus(windowId)).toEqual({
      status: "active",
      idempotency_key: windowId,
    });
    const shiftId = await edgeShift(date, randomUUID());
    await asEdge(async () => {
      // Order create, payment, shift/drawer (core and finish) and parked
      // carts (plain gate) all pass through the one gate.
      for (const options of [
        {},
        { failover: "core" },
        { failover: "finish" },
        { failover: "core", target: { kind: "shift", id: shiftId } },
      ] as PosWriteGateOptions[])
        await expect(gate(options)).rejects.toMatchObject({
          code: "FAILOVER_ACTIVE",
        });
    });
    // The back office sees the open window on the node.
    const status = await listEdgeNodeStatus(scopeOf([outletA]), {});
    expect(status.data[0]?.failover).toMatchObject({
      windowId,
      status: "active",
    });

    // Returning still blocks; cancel lifts the block.
    await deliver(edgeStore(), [stateEvent(windowId, date, "cancelled", 2)]);
    expect((await copyStatus(windowId))?.status).toBe("cancelled");
    await asEdge(async () => expect(await gate({})).toBeNull());
    expect(
      (await listEdgeNodeStatus(scopeOf([outletA]), {})).data[0]?.failover,
    ).toBeNull();
  });

  it("worked example: closes the edge shift with C1 once, the E3 mirror accepts it", async () => {
    const date = freshDate();
    const deviceId = randomUUID();
    const windowId = randomUUID();
    const edgeShiftId = await edgeShift(date, deviceId);
    await deliver(edgeStore(), [stateEvent(windowId, date, "active", 1)]);
    const failoverShiftId = await failoverShift(windowId, date, deviceId);

    const returning = stateEvent(windowId, date, "returning", 2);
    await asEdge(async () => {
      await deliver(edgeStore(), [returning]);
      await expect(gate({ failover: "finish" })).rejects.toMatchObject({
        code: "FAILOVER_ACTIVE",
      });
    });
    const closing = closedEvent(windowId, date, deviceId, 3);
    await asEdge(() => deliver(edgeStore(), [closing]));

    // Edge shift: expected E1 = 1,000,000, counted C1 = 990,000.
    expect(await shiftOf(edgeShiftId)).toMatchObject({
      status: "closed",
      expected_idr: "1000000",
      counted_idr: "990000",
      variance_idr: "-10000",
      cash_sales_idr: "0",
      approved_by: supervisorId,
      close_key: `failover:${windowId}`,
    });
    // Failover shift: float C1, S = 300,000, C2 = 1,290,000, variance 0.
    const failover = await shiftOf(failoverShiftId);
    expect(failover).toMatchObject({
      opening_float_idr: "990000",
      cash_sales_idr: "300000",
      counted_idr: "1290000",
      variance_idr: "0",
    });
    // Every rupiah in one shift: the edge's counted cash is the failover
    // float, the edge books no failover sale.
    expect(failover.opening_float_idr).toBe(
      (await shiftOf(edgeShiftId)).counted_idr,
    );
    expect((await copyStatus(windowId))?.status).toBe("closed");

    // Block lifted: the next edge shift opens with float C2 = 1,290,000.
    await asEdge(async () => expect(await gate({})).toBeNull());
    const nextShiftId = randomUUID();
    await q(
      `INSERT INTO pos_shifts
         (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status, opened_at,
          opening_float_idr, open_key, open_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, $10)`,
      [
        nextShiftId,
        tenantId,
        outletA,
        deviceId,
        cashierId,
        date,
        at(date, "09:30"),
        failover.counted_idr,
        `open-${nextShiftId}`,
        "0".repeat(64),
      ],
      { replica: true },
    );
    expect((await shiftOf(nextShiftId)).opening_float_idr).toBe("1290000");

    // Replay twice: still one count, one close event.
    await asEdge(async () => {
      await redeliverToEdge([returning, closing]);
      await redeliverToEdge([closing]);
    });
    const counts = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM pos_shift_counts WHERE tenant_id = $1 AND shift_id = $2`,
      [tenantId, edgeShiftId],
    );
    expect(counts[0]?.n).toBe(1);
    const closes = await closedEventsOf(edgeShiftId);
    expect(closes).toHaveLength(1);
    expect((await shiftOf(nextShiftId)).status).toBe("open");

    // E3 mirror: the cloud accepts the forced close. The test database is
    // also the cloud, so the edge rows are moved out of the way first; the
    // seeded shift had no opening event, so it is built here (sequence 1)
    // and the close follows it.
    const closeEvent = closes[0]!.event;
    expect(closeEvent.payload).toMatchObject({
      countedIdr: 990000,
      expectedIdr: 1000000,
      close: { count: { forced: false, submittedBy: cashierId } },
    });
    await q(
      `DELETE FROM pos_shift_counts WHERE tenant_id = $1 AND shift_id = $2`,
      [tenantId, edgeShiftId],
      { replica: true },
    );
    await q(
      `DELETE FROM pos_shifts WHERE tenant_id = $1 AND id = $2`,
      [tenantId, nextShiftId],
      { replica: true },
    );
    await q(
      `DELETE FROM pos_shifts WHERE tenant_id = $1 AND id = $2`,
      [tenantId, edgeShiftId],
      { replica: true },
    );
    const opened = envelope("cashier_shift.opened", edgeShiftId, 1, {
      shiftId: edgeShiftId,
      outletId: outletA,
      deviceId,
      cashierId,
      businessDate: date,
      openingFloatIdr: 1000000,
      openedAt: at(date, "01:00"),
    });
    await deliver(cloudStore(), [opened, { ...closeEvent, sequence: 2 }]);
    const [ingest] = await q<{ state: string; reason: string | null }>(
      `SELECT state, reason FROM edge_pos_ingests WHERE tenant_id = $1 AND kind = 'shift' AND aggregate_id = $2`,
      [tenantId, edgeShiftId],
    );
    expect(ingest).toEqual({ state: "ingested", reason: null });
    expect(await shiftOf(edgeShiftId)).toMatchObject({
      status: "closed",
      counted_idr: "990000",
      variance_idr: "-10000",
    });
  });

  it("split brain: edge activity after C1 keeps the shift and the block, and alerts", async () => {
    const date = freshDate();
    const deviceId = randomUUID();
    const windowId = randomUUID();
    const edgeShiftId = await edgeShift(date, deviceId);
    await deliver(edgeStore(), [stateEvent(windowId, date, "active", 1)]);
    await failoverShift(windowId, date, deviceId);
    // A cash in on the edge after the switchover count (06:00).
    await q(
      `INSERT INTO cash_movements
         (id, tenant_id, outlet_id, shift_id, type, amount_idr, reason_note, recorded_by,
          recorded_at, needs_approval, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, 'cash_in', 50000, 'Tambah modal', $5, $6, false, $7, $8)`,
      [
        randomUUID(),
        tenantId,
        outletA,
        edgeShiftId,
        cashierId,
        at(date, "07:00"),
        `cm-${randomUUID()}`,
        "0".repeat(64),
      ],
      { replica: true },
    );
    const closing = closedEvent(windowId, date, deviceId, 3);
    await asEdge(() =>
      deliver(edgeStore(), [
        stateEvent(windowId, date, "returning", 2),
        closing,
      ]),
    );
    expect((await shiftOf(edgeShiftId)).status).toBe("open");
    expect((await copyStatus(windowId))?.status).toBe("returning");
    await asEdge(async () =>
      expect(gate({})).rejects.toMatchObject({ code: "FAILOVER_ACTIVE" }),
    );
    const conflicts = await q<{ detail: string }>(
      `SELECT detail FROM edge_sync_conflicts WHERE tenant_id = $1 AND event_id = $2`,
      [tenantId, ulidToUuid(closing.id)],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.detail).toContain(`shift_activity:${edgeShiftId}`);

    // The notice goes up; the cloud alerts the managers once.
    const queued = await q<{ event: EventEnvelope }>(
      `SELECT event FROM edge_outbound_queue
        WHERE tenant_id = $1 AND direction = 'edge_to_cloud' AND aggregate_type = 'pos_failover_edge_refusal'`,
      [tenantId],
    );
    expect(queued).toHaveLength(1);
    // Same database as the cloud: the edge's queue row would read as the
    // aggregate's sequence 1 already held on the receiving side.
    await q(
      `DELETE FROM edge_outbound_queue WHERE tenant_id = $1 AND aggregate_type = 'pos_failover_edge_refusal'`,
      [tenantId],
      { replica: true },
    );
    await deliver(cloudStore(), [queued[0]!.event]);
    const alerts = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications
        WHERE tenant_id = $1 AND user_id = $2 AND title = 'Server lokal menolak penutupan mode cloud'`,
      [tenantId, ownerUserId],
    );
    expect(alerts[0]?.n).toBe(1);
  });
});
