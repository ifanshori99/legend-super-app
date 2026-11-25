// 1269 E3 (legend-8yqik, legend-k0i8): cashier shifts, cash movements and
// Tutup Hari an outlet runs on its edge are mirrored in the cloud through the
// real link receive path, exactly once, whatever the arrival order. Money rule:
// in doubt refuse or wait, never count a drawer twice.
//
// Assumptions (also reported):
//  - a shift is written only when its close, opening and every listed cash
//    movement are parked; until then nothing of it exists in the cloud and the
//    ledger row `edge_pos_ingests` (kind 'shift') is `pending`.
//  - the edge recap of `day.closed` is built in the test from the cloud's own
//    comparable recap of the same data (the edge computes it from identical
//    rows); a mismatch is simulated by changing its figures.
//  - journals are not asserted here (no chart of accounts in this fixture).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { PosError } from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import {
  registerEdgeDeferredFallback,
  registerPosDeferredEdgeApplier,
} from "../edge/deferred-event-applier.ts";
import { registerOrderEdgeApplier } from "../edge/order-edge-applier.ts";
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
import { computeEdgeComparableRecap } from "../services/pos-day.service.ts";
import { assertPosWriteNotOnEdge } from "../services/pos-edge-outlet.ts";
import { redriveEdgeOrderRefusalsForTenant } from "../worker/edge-order-redrive.job.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const actor = randomUUID();
const tenantId = randomUUID();
const otherTenantId = randomUUID();
const outletA = randomUUID();
const outletB = randomUUID();
const brandId = randomUUID();
const categoryId = randomUUID();
const menuItemId = randomUUID();
const cashierId = randomUUID();
const cashier2Id = randomUUID();
const supervisorId = randomUUID();
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
): Promise<T[]> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
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

async function n(text: string, params: unknown[] = []): Promise<number> {
  const rows = await q<{ n: number }>(text, params);
  return Number(rows[0]!.n);
}

async function createFixture() {
  const entity = randomUUID();
  for (const [id, name] of [
    [tenantId, "Tenant Shift Edge"],
    [otherTenantId, "Tenant Shift Edge Lain"],
  ] as const)
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, $5, plan, 'active', deployment_mode, feature_flags, limits, $3
         FROM tenants WHERE id = $4`,
      [
        id,
        `shift-edge-${randomBytes(4).toString("hex")}`,
        actor,
        cafeLegendPlatformFixtures.tenant.id,
        name,
      ],
    );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brandId, tenantId, `shift-edge-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tenantId],
  );
  for (const [id, code] of [
    [outletA, "SHE-01"],
    [outletB, "SHE-02"],
  ] as const)
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $5, 'Jl. Uji', '{}', 'active')`,
      [id, tenantId, brandId, entity, code],
    );
  await q(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
     VALUES ($1, $2, $3, 'Shift Uji', 0)`,
    [categoryId, tenantId, brandId],
  );
  await q(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
     VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
    [menuItemId, tenantId, brandId, categoryId, randomUUID()],
  );
  for (const [id, name] of [
    [cashierId, "Kasir Shift"],
    [cashier2Id, "Kasir Shift Dua"],
    [supervisorId, "Supervisor Shift"],
  ] as const)
    await owner.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
      [id, name, `${id}@example.test`],
    );
}

let clock = Date.parse("2026-11-20T09:00:00.000Z");
type Payload = Record<string, unknown>;
type Where = { tenant?: string; outlet?: string };

function envelope(
  name: string,
  aggregateId: string,
  sequence: number,
  payload: Payload,
  where: Where = {},
): EventEnvelope {
  clock += 1_000;
  return {
    id: createUlid(clock),
    tenantId: (where.tenant ?? tenantId) as EventEnvelope["tenantId"],
    outletId: (where.outlet ?? outletA) as EventEnvelope["outletId"],
    name,
    version: 1,
    aggregateType: name.split(".")[0]!,
    aggregateId,
    sequence,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${name}:${aggregateId}:${sequence}:${clock}`,
    payloadSchemaRef: `${name}.v1`,
    payload: payload as EventEnvelope["payload"],
  } as EventEnvelope;
}

let dateSeq = 0;
/** Each test gets its own business date: days and late posts never collide. */
function freshDate(): string {
  const day = new Date(Date.UTC(2034, 0, 2 + dateSeq * 5));
  dateSeq += 1;
  return day.toISOString().slice(0, 10);
}
const at = (date: string, hhmm: string) => `${date}T${hhmm}:00.000Z`;

type ShiftSpec = {
  date: string;
  deviceId?: string;
  cashier?: string;
  /** Cash out 20000 (plain) and a held drop 10000 the supervisor approved. */
  movements?: boolean;
  expectedDelta?: number;
};

/** The four kinds of event of one edge shift (opening 100000, sales 50000). */
function shiftEvents(spec: ShiftSpec) {
  const shiftId = randomUUID();
  const deviceId = spec.deviceId ?? randomUUID();
  const cashier = spec.cashier ?? cashierId;
  const base = {
    shiftId,
    outletId: outletA,
    deviceId,
    cashierId: cashier,
    businessDate: spec.date,
    openingFloatIdr: 100000,
  };
  const openedAt = at(spec.date, "01:00");
  const opened = envelope("cashier_shift.opened", shiftId, 1, {
    ...base,
    openedAt,
  });
  const cashOut = randomUUID();
  const drop = randomUUID();
  const recorded: EventEnvelope[] = [];
  const approved: EventEnvelope[] = [];
  const manifest: Payload[] = [];
  if (spec.movements) {
    const common = {
      shiftId,
      outletId: outletA,
      deviceId,
      recordedBy: cashier,
    };
    const out = {
      ...common,
      movementId: cashOut,
      type: "cash_out",
      amountIdr: 20000,
      reasonNote: "Beli es batu",
      recordedAt: at(spec.date, "02:00"),
    };
    const dropped = {
      ...common,
      movementId: drop,
      type: "drop",
      amountIdr: 10000,
      reasonNote: "Setor ke brankas",
      recordedAt: at(spec.date, "03:00"),
    };
    recorded.push(
      envelope("cash_movement.recorded", cashOut, 1, out),
      envelope("cash_movement.recorded", drop, 1, dropped),
    );
    approved.push(
      envelope("cash_movement.approved", drop, 2, {
        ...dropped,
        approvedBy: supervisorId,
        approvedAt: at(spec.date, "03:10"),
      }),
    );
    manifest.push(
      {
        movementId: cashOut,
        needsApproval: false,
        outcome: null,
        decidedBy: null,
        decidedAt: null,
      },
      {
        movementId: drop,
        needsApproval: true,
        outcome: "approved",
        decidedBy: supervisorId,
        decidedAt: at(spec.date, "03:10"),
      },
    );
  }
  const cashOutIdr = spec.movements ? 20000 : 0;
  const cashDropIdr = spec.movements ? 10000 : 0;
  const expectedIdr =
    100000 + 50000 - cashOutIdr - cashDropIdr + (spec.expectedDelta ?? 0);
  // Counted: 1 x 100000 + 1 x 20000 = 120000 (variance vs expected).
  const counts = [
    { denominationIdr: 100000, quantity: 1 },
    { denominationIdr: 20000, quantity: 1 },
  ];
  const countedIdr = 120000;
  const closedPayload = {
    ...base,
    cashSalesIdr: 50000,
    cashRefundsIdr: 0,
    cashInIdr: 0,
    cashOutIdr,
    cashDropIdr,
    expectedIdr,
    countedIdr,
    differenceIdr: countedIdr - expectedIdr,
    heldCashOutIdr: 0,
    varianceNote: countedIdr === expectedIdr ? null : "Selisih dicatat",
    approvedBy: supervisorId,
    approvalRequestId: randomUUID(),
    closedAt: at(spec.date, "10:00"),
    close: {
      openedAt,
      closedBy: supervisorId,
      approvalOverrideId: randomUUID(),
      approvedAt: at(spec.date, "09:59"),
      heldTotalIdr: 0,
      count: {
        id: randomUUID(),
        sequence: 1,
        counts,
        heldCorrectionIdr: null,
        cashWatermark: null,
        submittedBy: cashier,
        submittedAt: at(spec.date, "09:50"),
        forced: false,
      },
      movements: manifest,
    },
  };
  const closed = envelope("cashier_shift.closed", shiftId, 2, closedPayload);
  return {
    shiftId,
    deviceId,
    opened,
    recorded,
    approved,
    closed,
    closedPayload,
  };
}

function store() {
  return createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "cloud_to_edge",
  });
}

async function deliver(events: EventEnvelope[]) {
  const link = store();
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

/** The same events again, as if the link replayed them from scratch. */
async function redeliver(events: EventEnvelope[]) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    for (const table of [
      "edge_link_slots",
      "edge_inbound_events",
      "edge_received_events",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND event_id = ANY($2::uuid[])`,
        [tenantId, events.map((event) => ulidToUuid(event.id))],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await deliver(events);
}

type ShiftRow = {
  status: string;
  business_date: string;
  cash_out_idr: string;
  cash_drop_idr: string;
  expected_idr: string;
  counted_idr: string;
  variance_idr: string;
  difference_idr: string;
  opening_float_idr: string;
};

async function shiftRows(shiftId: string): Promise<ShiftRow[]> {
  return q<ShiftRow>(
    `SELECT status, business_date::text AS business_date, cash_out_idr::text, cash_drop_idr::text,
            expected_idr::text, counted_idr::text, variance_idr::text, difference_idr::text,
            opening_float_idr::text
       FROM pos_shifts WHERE tenant_id = $1 AND id = $2`,
    [tenantId, shiftId],
  );
}

async function drawerCounts(shiftId: string) {
  return {
    shifts: await n(
      "SELECT count(*)::int AS n FROM pos_shifts WHERE tenant_id = $1 AND id = $2",
      [tenantId, shiftId],
    ),
    movements: await n(
      "SELECT count(*)::int AS n FROM cash_movements WHERE tenant_id = $1 AND shift_id = $2",
      [tenantId, shiftId],
    ),
    outcomes: await n(
      "SELECT count(*)::int AS n FROM cash_movement_outcomes WHERE tenant_id = $1 AND shift_id = $2",
      [tenantId, shiftId],
    ),
    counts: await n(
      "SELECT count(*)::int AS n FROM pos_shift_counts WHERE tenant_id = $1 AND shift_id = $2",
      [tenantId, shiftId],
    ),
  };
}
const NO_DRAWER = { shifts: 0, movements: 0, outcomes: 0, counts: 0 };

async function ledger(kind: string, aggregateId: string) {
  const [row] = await q<{
    state: string;
    reason: string | null;
    late_business_date: string | null;
  }>(
    `SELECT state, reason, late_business_date::text AS late_business_date
       FROM edge_pos_ingests WHERE tenant_id = $1 AND kind = $2 AND aggregate_id = $3`,
    [tenantId, kind, aggregateId],
  );
  return row;
}

async function closeDayInCloud(date: string, outlet = outletA) {
  await q(
    `INSERT INTO pos_daily_closes
       (id, tenant_id, outlet_id, business_date, order_count, total_sales_idr, total_refunds_idr,
        total_voids_idr, total_variance_idr, inventory_deduction_applied, recap, closed_by, closed_at,
        idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4, 0, 0, 0, 0, 0, false, '{}', $5, now(), $6, $7)`,
    [
      randomUUID(),
      tenantId,
      outlet,
      date,
      supervisorId,
      randomUUID(),
      "f".repeat(64),
    ],
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await createFixture();
  const registered = await registerEdgeNode(scopeOf([outletA]), actor, {
    outletId: outletA,
    role: "primary",
    label: "Utama Shift Edge",
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  node = authenticated;
});

beforeEach(() => {
  resetEdgeApplierRegistryForTests();
  registerPosDeferredEdgeApplier();
  registerOrderEdgeApplier();
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
      "pos_daily_closes",
      "cash_movement_outcomes",
      "cash_movements",
      "pos_shift_counts",
      "edge_order_ingests",
      "pos_order_voids",
      "pos_order_tenders",
      "pos_order_items",
      "order_items",
      "order_events",
      "pos_orders",
      "tax_snapshots",
      "orders",
      "pos_shifts",
      "menu_items",
      "menu_categories",
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
      "outlets",
      "legal_entities",
      "brands",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      [tenantId, otherTenantId],
    ]);
    await client.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      [cashierId, cashier2Id, supervisorId],
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

describe("1269 E3 edge shift mirrored in the cloud", () => {
  it("a closed edge shift with its movements becomes one closed cloud drawer with the edge's figures", async () => {
    const s = shiftEvents({ date: freshDate(), movements: true });
    await deliver([s.opened, ...s.recorded, ...s.approved, s.closed]);
    expect(await drawerCounts(s.shiftId)).toEqual({
      shifts: 1,
      movements: 2,
      outcomes: 1,
      counts: 1,
    });
    expect(await shiftRows(s.shiftId)).toEqual([
      expect.objectContaining({
        status: "closed",
        cash_out_idr: "20000",
        cash_drop_idr: "10000",
        expected_idr: "120000",
        counted_idr: "120000",
        variance_idr: "0",
        difference_idr: "0",
        opening_float_idr: "100000",
      }),
    ]);
    expect(await ledger("shift", s.shiftId)).toMatchObject({
      state: "ingested",
    });
  });

  it("replaying every event adds no drawer, movement or count", async () => {
    const s = shiftEvents({ date: freshDate(), movements: true });
    const all = [s.opened, ...s.recorded, ...s.approved, s.closed];
    await deliver(all);
    await redeliver(all);
    await redeliver([s.closed, s.closed]);
    expect(await drawerCounts(s.shiftId)).toEqual({
      shifts: 1,
      movements: 2,
      outcomes: 1,
      counts: 1,
    });
  });

  it("reversed order: the close waits for its movements, then writes the drawer once", async () => {
    const s = shiftEvents({ date: freshDate(), movements: true });
    // The link holds an aggregate's later event until its earlier one is in.
    await deliver([...s.approved]);
    await deliver([s.closed]);
    expect(await drawerCounts(s.shiftId)).toEqual(NO_DRAWER);
    await deliver([s.opened]);
    expect(await drawerCounts(s.shiftId)).toEqual(NO_DRAWER);
    expect(await ledger("shift", s.shiftId)).toMatchObject({
      state: "pending",
      reason: "movement_missing",
    });
    await deliver([...s.recorded].reverse());
    expect(await drawerCounts(s.shiftId)).toEqual({
      shifts: 1,
      movements: 2,
      outcomes: 1,
      counts: 1,
    });
    expect(await ledger("shift", s.shiftId)).toMatchObject({
      state: "ingested",
    });
    await redeliver([s.opened, s.closed, ...s.recorded, ...s.approved]);
    expect(await drawerCounts(s.shiftId)).toEqual({
      shifts: 1,
      movements: 2,
      outcomes: 1,
      counts: 1,
    });
  });

  it("a second, different close of a mirrored shift is refused and changes nothing", async () => {
    const s = shiftEvents({ date: freshDate() });
    await deliver([s.opened, s.closed]);
    const other = envelope("cashier_shift.closed", s.shiftId, 3, {
      ...s.closedPayload,
      countedIdr: 220000,
      differenceIdr: 220000 - Number(s.closedPayload.expectedIdr),
      varianceNote: "Selisih dicatat",
    });
    await deliver([other]);
    const [row] = await shiftRows(s.shiftId);
    expect(row?.counted_idr).toBe("120000");
    expect((await drawerCounts(s.shiftId)).counts).toBe(1);
  });

  it("figures that do not add up are refused: no drawer is written", async () => {
    const s = shiftEvents({ date: freshDate(), expectedDelta: 5000 });
    // expected = 155000 but opening + sales = 150000.
    await deliver([s.opened, s.closed]);
    expect(await drawerCounts(s.shiftId)).toEqual(NO_DRAWER);
    expect(await ledger("shift", s.shiftId)).toMatchObject({
      state: "refused",
      reason: "expected_mismatch",
    });
  });

  it("two devices: each drawer is its own; a movement from another device is refused", async () => {
    const date = freshDate();
    const one = shiftEvents({ date });
    const two = shiftEvents({ date, cashier: cashier2Id });
    await deliver([one.opened, two.opened, two.closed, one.closed]);
    expect((await drawerCounts(one.shiftId)).shifts).toBe(1);
    expect((await drawerCounts(two.shiftId)).shifts).toBe(1);

    const s = shiftEvents({ date: freshDate(), movements: true });
    const foreign = s.recorded.map((event) =>
      envelope(event.name, event.aggregateId, 1, {
        ...(event.payload as Payload),
        deviceId: randomUUID(),
      }),
    );
    await deliver([s.opened, ...foreign, ...s.approved, s.closed]);
    expect(await drawerCounts(s.shiftId)).toEqual(NO_DRAWER);
    expect(await ledger("shift", s.shiftId)).toMatchObject({
      state: "refused",
      reason: "movement_mismatch",
    });
  });

  it("other outlet: a shift for another outlet writes nothing at either outlet", async () => {
    const s = shiftEvents({ date: freshDate() });
    const stamped = envelope(
      "cashier_shift.closed",
      s.shiftId,
      2,
      s.closedPayload,
      {
        outlet: outletB,
      },
    );
    const crossed = envelope("cashier_shift.closed", s.shiftId, 2, {
      ...s.closedPayload,
      outletId: outletB,
    });
    await deliver([s.opened]);
    // The link refuses an event stamped for an outlet the node does not serve.
    await expect(deliver([stamped])).rejects.toThrow(/outside the node scope/);
    await deliver([crossed]);
    expect(await drawerCounts(s.shiftId)).toEqual(NO_DRAWER);
    expect(
      await n(
        "SELECT count(*)::int AS n FROM pos_shifts WHERE tenant_id = $1 AND outlet_id = $2",
        [tenantId, outletB],
      ),
    ).toBe(0);
  });

  it("a movement arriving after its shift was mirrored is never booked into the closed drawer", async () => {
    const s = shiftEvents({ date: freshDate() });
    await deliver([s.opened, s.closed]);
    const stray = randomUUID();
    await deliver([
      envelope("cash_movement.recorded", stray, 1, {
        movementId: stray,
        shiftId: s.shiftId,
        outletId: outletA,
        deviceId: s.deviceId,
        type: "cash_in",
        amountIdr: 50000,
        reasonNote: "Tambah modal",
        recordedBy: cashierId,
        recordedAt: at(String(s.closedPayload.businessDate), "11:00"),
      }),
    ]);
    expect((await drawerCounts(s.shiftId)).movements).toBe(0);
    expect(await ledger("movement", stray)).toMatchObject({
      state: "refused",
      reason: "shift_closed",
    });
  });

  it("a shift id the cloud already has is refused, never merged", async () => {
    const s = shiftEvents({ date: freshDate() });
    await q(
      `INSERT INTO pos_shifts
         (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
          opened_at, opening_float_idr, open_key, open_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', now(), 100000, $7, $8)`,
      [
        s.shiftId,
        tenantId,
        outletB,
        randomUUID(),
        cashier2Id,
        s.closedPayload.businessDate,
        randomUUID(),
        "a".repeat(64),
      ],
    );
    await deliver([s.opened, s.closed]);
    expect(await ledger("shift", s.shiftId)).toMatchObject({
      state: "refused",
      reason: "shift_exists",
    });
    expect((await shiftRows(s.shiftId))[0]?.status).toBe("open");
    expect((await drawerCounts(s.shiftId)).counts).toBe(0);
  });
});

describe("1269 E3 late adjustment (legend-k0i8)", () => {
  it("a shift of a day the cloud already closed is posted to the next open day, flagged and audited", async () => {
    const date = freshDate();
    await closeDayInCloud(date);
    const s = shiftEvents({ date });
    await deliver([s.opened, s.closed]);
    const [row] = await shiftRows(s.shiftId);
    expect(row?.status).toBe("closed");
    expect(row?.business_date).not.toBe(date);
    expect(row?.business_date > date).toBe(true);
    expect(await ledger("shift", s.shiftId)).toMatchObject({
      state: "ingested",
      late_business_date: row?.business_date,
    });
    expect(
      await n(
        `SELECT count(*)::int AS n FROM audit_logs
          WHERE tenant_id = $1 AND event->>'action' = 'pos_shift.late_adjusted'`,
        [tenantId],
      ),
    ).toBeGreaterThanOrEqual(1);
  });

  it("a sale of a closed day goes to the next open day; the frozen close is not changed", async () => {
    const date = freshDate();
    await closeDayInCloud(date);
    const before = await q<{ recap: unknown; total_sales_idr: string }>(
      `SELECT recap, total_sales_idr::text FROM pos_daily_closes
        WHERE tenant_id = $1 AND outlet_id = $2 AND business_date = $3`,
      [tenantId, outletA, date],
    );
    const orderId = createUlid(++clock);
    await deliver([
      envelope("order.paid", orderId, 1, {
        orderId,
        outletId: outletA,
        businessDate: date,
        channel: "pos",
        serviceType: "takeaway",
        orderNumber: `LATE-${dateSeq}`,
        subtotalIdr: 50000,
        pricesIncludeTax: false,
        paymentMode: "pay_first",
        isTraining: false,
        grossSalesIdr: 50000,
        discountIdr: 0,
        serviceChargeIdr: 0,
        pbjtIdr: 0,
        taxes: [],
        roundingIdr: 0,
        totalIdr: 50000,
        paidCashIdr: 50000,
        paidGatewayIdr: 0,
        paidEdcIdr: 0,
        paidPointsIdr: 0,
        paidDepositIdr: 0,
        tenders: [{ method: "cash", amountIdr: 50000, receivedIdr: 50000 }],
        shiftId: null,
        cashierId,
        deviceId: randomUUID(),
        paidAt: at(date, "05:00"),
        lines: [
          {
            menuItemId,
            name: "Kopi Susu",
            quantity: 2,
            unitPriceIdr: 25000,
            modifiersTotalIdr: 0,
            lineTotalIdr: 50000,
            fireStatus: "fired",
            reservedBusinessDate: date,
            status: "served",
          },
        ],
      }),
    ]);
    const [ingest] = await q<{
      state: string;
      original_business_date: string | null;
      late_business_date: string | null;
    }>(
      `SELECT state, original_business_date::text, late_business_date::text
         FROM edge_order_ingests WHERE tenant_id = $1 AND reason IS NULL
          AND original_business_date = $2`,
      [tenantId, date],
    );
    expect(ingest).toMatchObject({
      state: "ingested",
      original_business_date: date,
    });
    const [order] = await q<{ business_date: string }>(
      `SELECT business_date::text FROM orders
        WHERE tenant_id = $1 AND number = $2`,
      [tenantId, `LATE-${dateSeq}`],
    );
    expect(order?.business_date).toBe(ingest?.late_business_date);
    expect(order!.business_date > date).toBe(true);
    const after = await q<{ recap: unknown; total_sales_idr: string }>(
      `SELECT recap, total_sales_idr::text FROM pos_daily_closes
        WHERE tenant_id = $1 AND outlet_id = $2 AND business_date = $3`,
      [tenantId, outletA, date],
    );
    expect(after).toEqual(before);
  });
});

describe("1269 E3 day.closed mirrored into pos_daily_closes (legend-8yqik)", () => {
  async function dayEvent(date: string, over: (recap: Payload) => Payload) {
    const id = randomUUID();
    const closedAt = at(date, "15:00");
    const [outlet] = await q<Record<string, unknown>>(
      "SELECT id FROM outlets WHERE tenant_id = $1 AND id = $2",
      [tenantId, outletA],
    );
    expect(outlet).toBeDefined();
    const cloud = await withTenant(db, jobScope(), async (tx) => {
      const { outlets } = await import("../db/schema/platform-org.ts");
      const { and, eq } = await import("drizzle-orm");
      const [row] = await tx
        .select()
        .from(outlets)
        .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletA)));
      return computeEdgeComparableRecap(
        tx,
        jobScope(),
        row!,
        outletIdSchema.parse(outletA),
        date,
        new Date(closedAt),
      );
    });
    const recap = over({
      ...(cloud as unknown as Payload),
      id,
      status: "closed",
      closedAt,
      closedBy: supervisorId,
    });
    const orderCount = (recap.devices as { orderCount: number }[]).reduce(
      (sum, d) => sum + d.orderCount,
      0,
    );
    return envelope("day.closed", id, 1, {
      outletId: outletA,
      businessDate: date,
      orderCount,
      totalSalesIdr: recap.totalSalesIdr,
      totalRefundsIdr: recap.totalRefundsIdr,
      totalVoidsIdr: recap.totalVoidsIdr,
      totalVarianceIdr: recap.totalVarianceIdr,
      inventoryDeductionApplied: recap.inventoryDeductionApplied,
      accountingSyncStatus: "pending",
      closedBy: supervisorId,
      closedAt,
      recap,
    });
  }

  const closesOf = (date: string) =>
    q<{ id: string }>(
      "SELECT id FROM pos_daily_closes WHERE tenant_id = $1 AND outlet_id = $2 AND business_date = $3",
      [tenantId, outletA, date],
    );

  it("an edge close whose recap equals the cloud's figures is mirrored once, a replay is a no-op", async () => {
    const date = freshDate();
    const s = shiftEvents({ date });
    await deliver([s.opened, s.closed]);
    const event = await dayEvent(date, (recap) => recap);
    await deliver([event]);
    expect((await closesOf(date)).map((row) => row.id)).toEqual([
      event.aggregateId,
    ]);
    await redeliver([event]);
    expect(await closesOf(date)).toHaveLength(1);
    expect(
      await n(
        "SELECT count(*)::int AS n FROM domain_event_outbox WHERE tenant_id = $1 AND event->>'name' = 'day.closed'",
        [tenantId],
      ),
    ).toBe(0);
  });

  it("a recap the cloud cannot match yet waits, and closes nothing", async () => {
    const date = freshDate();
    const event = await dayEvent(date, (recap) => ({
      ...recap,
      totalVarianceIdr: 1000,
      devices: (recap.devices as Payload[]).map((d) => ({
        ...d,
        varianceIdr: 1000,
      })),
    }));
    await deliver([event]);
    expect(await closesOf(date)).toHaveLength(0);
    expect((await ledger("day", event.aggregateId))?.state).not.toBe(
      "ingested",
    );
    await redriveEdgeOrderRefusalsForTenant(jobScope());
    expect(await closesOf(date)).toHaveLength(0);
  });

  it("a day the cloud already closed is never closed again by the edge", async () => {
    const date = freshDate();
    await closeDayInCloud(date);
    const event = await dayEvent(date, (recap) => recap);
    await deliver([event]);
    expect(await closesOf(date)).toHaveLength(1);
    expect(await ledger("day", event.aggregateId)).toMatchObject({
      state: "refused",
      reason: "day_already_closed",
    });
  });

  it("an older day.closed without a recap is refused, not mirrored", async () => {
    const date = freshDate();
    const event = await dayEvent(date, (recap) => recap);
    const { recap: _recap, ...legacy } = event.payload as Payload;
    await deliver([envelope("day.closed", event.aggregateId, 1, legacy)]);
    expect(await closesOf(date)).toHaveLength(0);
    expect(await ledger("day", event.aggregateId)).toMatchObject({
      state: "refused",
      reason: "legacy_payload",
    });
  });
});

describe("1269 E3 cloud write gate", () => {
  it("refuses a cloud POS write on an outlet its edge serves, and only there", async () => {
    await expect(
      withTenant(db, jobScope(), (tx) =>
        assertPosWriteNotOnEdge(
          tx,
          jobScope().tenant.tenantId,
          outletIdSchema.parse(outletA),
        ),
      ),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof PosError && error.code === "POS_WRITE_ON_EDGE",
    );
    await expect(
      withTenant(db, jobScope(), (tx) =>
        assertPosWriteNotOnEdge(
          tx,
          jobScope().tenant.tenantId,
          outletIdSchema.parse(outletB),
        ),
      ),
    ).resolves.toBeUndefined();
    const before = getEdgeRuntimeState();
    setEdgeRuntimeStateForTests({ ...before, edgeMode: true });
    try {
      await expect(
        withTenant(db, jobScope(), (tx) =>
          assertPosWriteNotOnEdge(
            tx,
            jobScope().tenant.tenantId,
            outletIdSchema.parse(outletA),
          ),
        ),
      ).resolves.toBeUndefined();
    } finally {
      setEdgeRuntimeStateForTests(before);
    }
  });
});
