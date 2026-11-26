// 1271 F5 (docs/briefs/1271-edge-failover-cards.md, D5 + review K F1 ralat):
// the day recap of an edge outlet that ran a failover window in the cloud.
// Money rule: every sale counted once, none lost.
//
// - The edge's `day.closed` of a date with failover rows is compared with the
//   cloud's figures WITHOUT those rows (the edge never had them), then the
//   cloud's full recap (edge + failover) is stored.
// - A date an open window still touches waits (more failover sales may come).
// - Edge Tutup Hari is refused (FAILOVER_ACTIVE) while the window is open.
// - A day the cloud closed during the window stays closed; an edge sale of
//   that day arriving later is a late adjustment.
// - An F-run number is never written off; its gap is reported at Tutup Hari.
//
// Edge rows arrive through the real link receive path (as in
// edge-shift-day-applier.test.ts, whose helpers are copied, that file is not
// edited). Failover rows are seeded with owner SQL, as F3 writes them.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/edge-failover-day.test.ts" pnpm test
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  ulidToUuid,
  userIdSchema,
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
import {
  closePosDay,
  computeEdgeComparableRecap,
} from "../services/pos-day.service.ts";
import { receiptGapsForOutletFast } from "../services/pos-receipt.service.ts";
import { writeOffReceiptNumber } from "../services/pos-receipt-writeoff.service.ts";
import { setPosOutletReceiptGapsPort } from "../services/pos-shift-ports.ts";
import { redriveEdgeOrderRefusalsForTenant } from "../worker/edge-order-redrive.job.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const actor = randomUUID();
const tenantId = randomUUID();
const outletA = randomUUID();
const outletB = randomUUID();
const brandId = randomUUID();
const categoryId = randomUUID();
const menuItemId = randomUUID();
const cashierId = randomUUID();
const supervisorId = randomUUID();
const closerRoleId = randomUUID();
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
     SELECT $1, $2, 'Tenant Failover Hari', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `fo-day-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brandId, tenantId, `fo-day-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tenantId],
  );
  for (const [id, code] of [
    [outletA, "FOD-01"],
    [outletB, "FOD-02"],
  ] as const)
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $5, 'Jl. Uji', '{}', 'active')`,
      [id, tenantId, brandId, entity, code],
    );
  await q(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
     VALUES ($1, $2, $3, 'Failover Uji', 0)`,
    [categoryId, tenantId, brandId],
  );
  await q(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
     VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
    [menuItemId, tenantId, brandId, categoryId, randomUUID()],
  );
  for (const [id, name] of [
    [cashierId, "Kasir Failover"],
    [supervisorId, "Manajer Failover"],
  ] as const)
    await owner.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
      [id, name, `${id}@example.test`],
    );
  // The manager closes the business day (pos.day.close).
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Penutup Hari Failover', false, NULL, $3, false, '["tenant"]')`,
    [closerRoleId, tenantId, JSON.stringify(["pos.day.close"])],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId, supervisorId, closerRoleId],
  );
}

let clock = Date.parse("2025-03-01T09:00:00.000Z");
type Payload = Record<string, unknown>;

function envelope(
  name: string,
  aggregateId: string,
  sequence: number,
  payload: Payload,
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
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${name}:${aggregateId}:${sequence}:${clock}`,
    payloadSchemaRef: `${name}.v1`,
    payload: payload as EventEnvelope["payload"],
  } as EventEnvelope;
}

let dateSeq = 0;
/** Past business dates (the cloud close refuses a day not yet started). */
function freshDate(): string {
  const day = new Date(Date.UTC(2025, 0, 2 + dateSeq * 5));
  dateSeq += 1;
  return day.toISOString().slice(0, 10);
}
const at = (date: string, hhmm: string) => `${date}T${hhmm}:00.000Z`;

/** One closed edge shift (opening 100000, cash sales 50000, counted 120000). */
function edgeShift(date: string, deviceId: string) {
  const shiftId = randomUUID();
  const base = {
    shiftId,
    outletId: outletA,
    deviceId,
    cashierId,
    businessDate: date,
    openingFloatIdr: 100000,
  };
  const openedAt = at(date, "01:00");
  const opened = envelope("cashier_shift.opened", shiftId, 1, {
    ...base,
    openedAt,
  });
  const expectedIdr = 150000;
  const countedIdr = 120000;
  const closed = envelope("cashier_shift.closed", shiftId, 2, {
    ...base,
    cashSalesIdr: 50000,
    cashRefundsIdr: 0,
    cashInIdr: 0,
    cashOutIdr: 0,
    cashDropIdr: 0,
    expectedIdr,
    countedIdr,
    differenceIdr: countedIdr - expectedIdr,
    heldCashOutIdr: 0,
    varianceNote: "Selisih dicatat",
    approvedBy: supervisorId,
    approvalRequestId: randomUUID(),
    closedAt: at(date, "03:00"),
    close: {
      openedAt,
      closedBy: supervisorId,
      approvalOverrideId: randomUUID(),
      approvedAt: at(date, "02:59"),
      heldTotalIdr: 0,
      count: {
        id: randomUUID(),
        sequence: 1,
        counts: [
          { denominationIdr: 100000, quantity: 1 },
          { denominationIdr: 20000, quantity: 1 },
        ],
        heldCorrectionIdr: null,
        cashWatermark: null,
        submittedBy: cashierId,
        submittedAt: at(date, "02:50"),
        forced: false,
      },
      movements: [],
    },
  });
  return [opened, closed];
}

/** An edge cash sale of 50000 (order.paid, the E1 ingest). */
function edgeSale(date: string, deviceId: string): EventEnvelope {
  const orderId = createUlid(++clock);
  return envelope("order.paid", orderId, 1, {
    orderId,
    outletId: outletA,
    businessDate: date,
    channel: "pos",
    serviceType: "takeaway",
    orderNumber: `EDGE-${clock}`,
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
    deviceId,
    paidAt: at(date, "02:00"),
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
  });
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
  await q(
    `DELETE FROM edge_link_slots WHERE tenant_id = $1 AND event_id = ANY($2::uuid[])`,
    [tenantId, events.map((event) => ulidToUuid(event.id))],
    { replica: true },
  );
  for (const table of ["edge_inbound_events", "edge_received_events"])
    await q(
      `DELETE FROM ${table} WHERE tenant_id = $1 AND event_id = ANY($2::uuid[])`,
      [tenantId, events.map((event) => ulidToUuid(event.id))],
      { replica: true },
    );
  await deliver(events);
}

async function ledger(kind: string, aggregateId: string) {
  const [row] = await q<{ state: string; reason: string | null }>(
    `SELECT state, reason FROM edge_pos_ingests
      WHERE tenant_id = $1 AND kind = $2 AND aggregate_id = $3`,
    [tenantId, kind, aggregateId],
  );
  return row;
}

type CloseRow = {
  id: string;
  order_count: number;
  total_sales_idr: string;
  total_variance_idr: string;
  recap: {
    totalSalesIdr: number;
    unsyncedReceiptCount: number;
    devices: { deviceId: string; orderCount: number; shiftCount: number }[];
    tenders: { method: string; capturedIdr: number }[];
  };
};
const closesOf = (date: string) =>
  q<CloseRow>(
    `SELECT id, order_count, total_sales_idr::text, total_variance_idr::text, recap
       FROM pos_daily_closes WHERE tenant_id = $1 AND outlet_id = $2 AND business_date = $3`,
    [tenantId, outletA, date],
  );

/** A failover window of outletA (as F3 writes it); `closed` once ended. */
async function openWindow(date: string): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO outlet_failover_windows
       (id, tenant_id, outlet_id, edge_node_id, status, reason, idempotency_key,
        activated_by, business_date_from)
     VALUES ($1, $2, $3, $4, 'active', 'Mini PC mati', $5, $6, $7)`,
    [id, tenantId, outletA, node.scope.edgeNodeId, `fo-${id}`, supervisorId, date],
  );
  return id;
}

/** active -> returning -> closed, ending on `date`. */
async function closeWindow(windowId: string, date: string): Promise<void> {
  await q(
    `UPDATE outlet_failover_windows
        SET status = 'returning', business_date_to = $2, return_started_at = now(),
            return_started_by = $3, closing_event_id = $4
      WHERE id = $1`,
    [windowId, date, supervisorId, randomUUID()],
  );
  await q(
    `UPDATE outlet_failover_windows SET status = 'closed', closed_at = now() WHERE id = $1`,
    [windowId],
  );
}

/**
 * The failover shift of a device (float C1 = 120000, one cash sale 30000,
 * counted C2 = 150000, variance 0) and its sale, both stamped with the window.
 */
async function failoverSale(
  windowId: string,
  date: string,
  deviceId: string,
): Promise<string> {
  const shiftId = randomUUID();
  const orderId = randomUUID();
  await q(
    `INSERT INTO pos_shifts
       (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status, opened_at,
        opening_float_idr, cash_sales_idr, expected_idr, counted_idr, variance_idr,
        difference_idr, counts, count_id, approved_by, approval_request_id,
        approval_override_id, approved_at, closed_at, closed_by, open_key,
        open_fingerprint, close_key, close_fingerprint, failover_window_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'closed', $7, 120000, 30000, 150000, 150000, 0, 0,
        '[]'::jsonb, $8, $9, $10, $11, $12, $12, $9, $13, $14, $15, $14, $16)`,
    [
      shiftId,
      tenantId,
      outletA,
      deviceId,
      cashierId,
      date,
      at(date, "04:00"),
      randomUUID(),
      supervisorId,
      randomUUID(),
      randomUUID(),
      at(date, "08:00"),
      `open-${shiftId}`,
      "0".repeat(64),
      `close-${shiftId}`,
      windowId,
    ],
    { replica: true },
  );
  await q(
    `INSERT INTO orders
       (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
        subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
        status, business_date, placed_at)
     VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', 30000, 0, 0, 0, 0, 30000,
             'completed', $5, $6)`,
    [orderId, tenantId, outletA, `F-${orderId.slice(0, 8)}`, date, at(date, "05:00")],
    { replica: true },
  );
  await q(
    `INSERT INTO pos_orders
       (order_id, tenant_id, outlet_id, channel, shift_id, device_id, cashier_id,
        submitted_at, completed_at, failover_window_id)
     VALUES ($1, $2, $3, 'pos', $4, $5, $6, $7, $7, $8)`,
    [
      orderId,
      tenantId,
      outletA,
      shiftId,
      deviceId,
      cashierId,
      at(date, "05:00"),
      windowId,
    ],
    { replica: true },
  );
  await q(
    `INSERT INTO pos_order_tenders
       (tenant_id, outlet_id, order_id, method, provider, amount_idr, received_idr, change_idr,
        status, requested_at, resolved_at, captured_by, shift_id)
     VALUES ($1, $2, $3, 'cash', 'manual', 30000, 30000, 0, 'captured', $4, $4, $5, $6)`,
    [tenantId, outletA, orderId, at(date, "05:00"), cashierId, shiftId],
    { replica: true },
  );
  return orderId;
}

/** The edge's frozen recap: the cloud's comparable figures before failover rows existed. */
async function edgeRecap(date: string): Promise<Payload> {
  return withTenant(db, jobScope(), async (tx) => {
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
      new Date(at(date, "15:00")),
    ) as unknown as Promise<Payload>;
  });
}

function dayClosed(date: string, frozen: Payload): EventEnvelope {
  const id = randomUUID();
  const closedAt = at(date, "15:00");
  const recap = {
    ...frozen,
    id,
    businessDate: date,
    status: "closed",
    closedAt,
    closedBy: supervisorId,
  };
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

const closeInput = (businessDate: string) =>
  ({
    businessDate,
    inventoryDeduction: false,
    idempotencyKey: randomUUID(),
  }) as Parameters<typeof closePosDay>[3];

async function asEdge<T>(run: () => Promise<T>): Promise<T> {
  const saved = getEdgeRuntimeState();
  setEdgeRuntimeStateForTests({ ...saved, edgeMode: true });
  try {
    return await run();
  } finally {
    setEdgeRuntimeStateForTests(saved);
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await createFixture();
  const registered = await registerEdgeNode(scopeOf([outletA]), actor, {
    outletId: outletA,
    role: "primary",
    label: "Utama Failover Hari",
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
  setPosOutletReceiptGapsPort(null);
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
      "receipt_number_writeoffs",
      "receipt_sequences",
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
      "outlet_failover_windows",
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
      [cashierId, supervisorId],
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

describe("1271 F5 edge day close of a date with failover rows", () => {
  it("is compared without the failover rows and stored with edge + failover totals, once", async () => {
    const date = freshDate();
    const deviceId = randomUUID();
    await deliver([...edgeShift(date, deviceId), edgeSale(date, deviceId)]);
    const frozen = await edgeRecap(date);
    expect(frozen.totalSalesIdr).toBe(50000);
    const windowId = await openWindow(date);
    await failoverSale(windowId, date, deviceId);
    await closeWindow(windowId, date);

    const event = dayClosed(date, frozen);
    await deliver([event]);
    expect(await ledger("day", event.aggregateId)).toMatchObject({
      state: "ingested",
    });
    const closes = await closesOf(date);
    expect(closes).toHaveLength(1);
    const [close] = closes;
    // Edge 50000 + failover 30000: nothing doubled, nothing missing.
    expect(close).toMatchObject({
      id: event.aggregateId,
      order_count: 2,
      total_sales_idr: "80000",
      // The edge shift's -30000; the failover shift balanced.
      total_variance_idr: "-30000",
    });
    expect(close!.recap.totalSalesIdr).toBe(80000);
    expect(
      close!.recap.tenders.find((t) => t.method === "cash")?.capturedIdr,
    ).toBe(80000);
    expect(close!.recap.devices).toEqual([
      expect.objectContaining({
        deviceId: deviceId.toLowerCase(),
        orderCount: 2,
        shiftCount: 2,
      }),
    ]);

    await redeliver([event]);
    expect(await closesOf(date)).toHaveLength(1);
    expect((await closesOf(date))[0]!.total_sales_idr).toBe("80000");
  });

  it("a date an open window still touches waits; after the window closes the redrive stores the full recap", async () => {
    const date = freshDate();
    const deviceId = randomUUID();
    await deliver([...edgeShift(date, deviceId), edgeSale(date, deviceId)]);
    const frozen = await edgeRecap(date);
    const windowId = await openWindow(date);
    await failoverSale(windowId, date, deviceId);

    // D5: the edge's own Tutup Hari is refused while the window is open.
    await expect(
      asEdge(() =>
        closePosDay(
          scopeOf([outletA]),
          { userId: userIdSchema.parse(supervisorId) },
          outletIdSchema.parse(outletA),
          closeInput(date),
        ),
      ),
    ).rejects.toMatchObject({ code: "FAILOVER_ACTIVE" });
    expect(await closesOf(date)).toHaveLength(0);

    const event = dayClosed(date, frozen);
    await deliver([event]);
    expect(await closesOf(date)).toHaveLength(0);
    expect(await ledger("day", event.aggregateId)).toMatchObject({
      state: "pending",
      reason: "failover_open",
    });

    await closeWindow(windowId, date);
    await redriveEdgeOrderRefusalsForTenant(jobScope());
    const closes = await closesOf(date);
    expect(closes.map((row) => row.id)).toEqual([event.aggregateId]);
    expect(closes[0]).toMatchObject({
      order_count: 2,
      total_sales_idr: "80000",
    });
  });

  it("refuses the edge's Tutup Hari also while the window is returning", async () => {
    const date = freshDate();
    const windowId = await openWindow(date);
    await q(
      `UPDATE outlet_failover_windows
          SET status = 'returning', business_date_to = $2, return_started_at = now(),
              return_started_by = $3
        WHERE id = $1`,
      [windowId, date, supervisorId],
    );
    await expect(
      asEdge(() =>
        closePosDay(
          scopeOf([outletA]),
          { userId: userIdSchema.parse(supervisorId) },
          outletIdSchema.parse(outletA),
          closeInput(date),
        ),
      ),
    ).rejects.toMatchObject({ code: "FAILOVER_ACTIVE" });
    expect(await closesOf(date)).toHaveLength(0);
    await q(
      `UPDATE outlet_failover_windows SET status = 'closed', closed_at = now() WHERE id = $1`,
      [windowId],
    );
  });
});

describe("1271 F5 cloud close during the window", () => {
  it("the cloud's stale close stays; a later edge close is day_already_closed and a pre-outage edge sale is a late adjustment", async () => {
    const date = freshDate();
    const deviceId = randomUUID();
    await q(
      `UPDATE edge_nodes SET last_heartbeat_at = now() - interval '2 hours'
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, node.scope.edgeNodeId],
    );
    const windowId = await openWindow(date);
    await failoverSale(windowId, date, deviceId);
    const cloud = await closePosDay(
      scopeOf([outletA]),
      { userId: userIdSchema.parse(supervisorId) },
      outletIdSchema.parse(outletA),
      closeInput(date),
    );
    expect(Number(cloud.totalSalesIdr)).toBe(30000);
    const before = await closesOf(date);
    expect(before).toHaveLength(1);

    // An edge sale of that day, made before the outage, arrives later.
    const sale = edgeSale(date, deviceId);
    await deliver([sale]);
    const [ingest] = await q<{
      state: string;
      late_business_date: string | null;
    }>(
      `SELECT state, late_business_date::text FROM edge_order_ingests
        WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [tenantId, ulidToUuid(sale.aggregateId)],
    );
    expect(ingest?.state).toBe("ingested");
    expect(ingest?.late_business_date).not.toBeNull();
    expect(ingest!.late_business_date! > date).toBe(true);

    await closeWindow(windowId, date);
    const event = dayClosed(date, {
      ...(await edgeRecap(date)),
      totalSalesIdr: 50000,
    });
    await deliver([event]);
    expect(await ledger("day", event.aggregateId)).toMatchObject({
      state: "refused",
      reason: "day_already_closed",
    });
    expect(await closesOf(date)).toEqual(before);
  });
});

describe("1271 F5 F-run numbers (review K F1)", () => {
  it("an F-run number is never written off; its gap is reported at Tutup Hari", async () => {
    await q(
      `INSERT INTO receipt_sequences
         (tenant_id, outlet_id, device_id, prefix, series, last_number)
       VALUES ($1, $2, $3, 'F1', 'failover', 1)`,
      [tenantId, outletB, randomUUID()],
      { replica: true },
    );
    await expect(
      writeOffReceiptNumber(
        scopeOf([outletB]),
        { userId: userIdSchema.parse(supervisorId) },
        outletIdSchema.parse(outletB),
        {
          prefix: "F1",
          sequenceNumber: 1,
          reason: "Struk hilang saat mode cloud",
        },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (
        await q<{ n: number }>(
          "SELECT count(*)::int AS n FROM receipt_number_writeoffs WHERE tenant_id = $1",
          [tenantId],
        )
      )[0]!.n,
    ).toBe(0);

    setPosOutletReceiptGapsPort((tx, context, { outletId }) =>
      receiptGapsForOutletFast(tx, context, outletId),
    );
    try {
      const gaps = await withTenant(db, scopeOf([outletB]), (tx) =>
        receiptGapsForOutletFast(tx, scopeOf([outletB]), outletB),
      );
      expect(gaps).toEqual([
        expect.objectContaining({ prefix: "F1", missing: [1] }),
      ]);
      await expect(
        closePosDay(
          scopeOf([outletB]),
          { userId: userIdSchema.parse(supervisorId) },
          outletIdSchema.parse(outletB),
          closeInput(freshDate()),
        ),
      ).rejects.toMatchObject({
        code: "RECEIPT_SEQUENCE_GAP",
        message: expect.stringContaining("F1-000001"),
      });
    } finally {
      setPosOutletReceiptGapsPort(null);
    }
  });
});
