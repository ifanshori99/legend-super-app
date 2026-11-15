// legend-132mw: a transient ingest refusal of an edge `order.paid` / `order.voided`
// (lock_failed, SQLSTATE 40P01 / 55P03 / 40001) is redriven by the operator sweep
// (worker/edge-order-redrive.job.ts); any other refusal (db_error:23505, ...) is
// final. A retry that fails again records its new reason on the ledger row.
//
// A lock_failed is induced for real: another connection holds the order's
// advisory lock while the ingest runs under a short `lock_timeout`.
// pbjtIdr is 0 on purpose so the test does not depend on the PBJT/GL contract.
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { applyEdgeDeferredEvent } from "../edge/deferred-event-applier.ts";
import {
  ingestEdgeOrderPaid,
  ingestEdgeOrderVoided,
  isTransientReason,
} from "../edge/order-ingest.ts";
import type { EdgeApplyMeta } from "../edge/ports.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import {
  EDGE_ORDER_REDRIVE_BATCH,
  redriveEdgeOrderRefusals,
  redriveEdgeOrderRefusalsForTenant,
} from "../worker/edge-order-redrive.job.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const actor = randomUUID();
const tenantId = randomUUID();
const outletA = randomUUID();
const brandId = randomUUID();
const categoryId = randomUUID();
const menuItemId = randomUUID();
const cashierId = randomUUID();
const supervisorId = randomUUID();
const deviceId = randomUUID();
const BUSINESS_DATE = "2034-01-02";
let node: AuthenticatedEdgeNode;

const scopeOf = (outletIds: string[]): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    {
      kind: "outlets",
      outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
    },
  );

const jobContext = (): ScopedTenantContext =>
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

async function createFixture() {
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Order Redrive', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `order-redrive-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brandId, tenantId, `order-redrive-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'RDV-01', 'RDV-01', 'Jl. Uji', '{}', 'active')`,
    [outletA, tenantId, brandId, entity],
  );
  await q(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
     VALUES ($1, $2, $3, 'Redrive Uji', 0)`,
    [categoryId, tenantId, brandId],
  );
  await q(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
     VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
    [menuItemId, tenantId, brandId, categoryId, randomUUID()],
  );
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Kasir Redrive', $2)`,
    [cashierId, `${cashierId}@example.test`],
  );
}

let clock = Date.parse("2026-11-14T10:00:00.000Z");
let numberSeq = 0;
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
    aggregateType: "order",
    aggregateId,
    sequence,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${name}:${aggregateId}:${sequence}`,
    payloadSchemaRef: `${name}.v1`,
    payload: payload as EventEnvelope["payload"],
  };
}

/** Sale of 70000: subtotal 75000 - discount 5000, no tax, cash 50000 + EDC 20000. */
function paidEvent(orderId: string, orderNumber?: string): EventEnvelope {
  numberSeq += 1;
  return envelope("order.paid", orderId, 1, {
    orderId,
    outletId: outletA,
    businessDate: BUSINESS_DATE,
    channel: "pos",
    serviceType: "takeaway",
    orderNumber: orderNumber ?? `RDV-${String(numberSeq).padStart(5, "0")}`,
    subtotalIdr: 75000,
    pricesIncludeTax: false,
    paymentMode: "pay_first",
    isTraining: false,
    grossSalesIdr: 75000,
    discountIdr: 5000,
    serviceChargeIdr: 0,
    pbjtIdr: 0,
    roundingIdr: 0,
    totalIdr: 70000,
    paidCashIdr: 50000,
    paidGatewayIdr: 0,
    paidEdcIdr: 20000,
    paidPointsIdr: 0,
    paidDepositIdr: 0,
    tenders: [
      { method: "cash", amountIdr: 50000, receivedIdr: 100000 },
      { method: "edc_card", amountIdr: 20000 },
    ],
    shiftId: null,
    cashierId,
    deviceId,
    paidAt: "2034-01-02T03:04:05.000Z",
    lines: [
      {
        menuItemId,
        name: "Kopi Susu",
        quantity: 2,
        unitPriceIdr: 25000,
        modifiersTotalIdr: 0,
        lineTotalIdr: 50000,
        fireStatus: "fired",
        reservedBusinessDate: BUSINESS_DATE,
        status: "served",
      },
      {
        menuItemId,
        name: "Roti Bakar",
        quantity: 1,
        unitPriceIdr: 20000,
        modifiersTotalIdr: 5000,
        lineTotalIdr: 25000,
        fireStatus: "fired",
        reservedBusinessDate: BUSINESS_DATE,
        status: "served",
      },
    ],
  });
}

function voidedEvent(orderId: string): EventEnvelope {
  return envelope("order.voided", orderId, 2, {
    orderId,
    outletId: outletA,
    businessDate: BUSINESS_DATE,
    amountIdr: 70000,
    reason: "customer_cancelled",
    reasonNote: "Pelanggan batal",
    requestedBy: cashierId,
    approvedBy: supervisorId,
    overrideId: createUlid(++clock),
    approvalRequestId: null,
    voidedFinalOrder: true,
    voidId: randomUUID(),
    receiptNumber: "RDV-000042",
    voidedAt: "2034-01-02T04:00:00.000Z",
  });
}

const dbId = (orderId: string) => ulidToUuid(orderId);

const meta = (): EdgeApplyMeta => ({
  edgeNodeId: node.scope.edgeNodeId,
  direction: "edge_to_cloud",
  kind: "transaction_event",
  context: node.context,
});

/** Park the event, then run the ingest, in one tenant transaction. */
async function receive(
  event: EventEnvelope,
  opts: { lockTimeoutMs?: number } = {},
) {
  await withTenant(db, node.context, async (tx) => {
    if (opts.lockTimeoutMs)
      await tx.execute(
        sql`SELECT set_config('lock_timeout', ${`${opts.lockTimeoutMs}ms`}, true)`,
      );
    await applyEdgeDeferredEvent(tx, event, meta());
    if (event.name === "order.paid")
      await ingestEdgeOrderPaid(tx, event, meta());
    else await ingestEdgeOrderVoided(tx, event, meta());
  });
}

/** Holds the order's ingest advisory lock on another connection. */
async function holdOrderLock(orderId: string) {
  const key = `stock-source:${tenantId}:order:${dbId(orderId)}`.toLowerCase();
  const client = await owner.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    key,
  ]);
  return async () => {
    await client.query("ROLLBACK");
    client.release();
  };
}

async function receiveWhileLocked(event: EventEnvelope) {
  const release = await holdOrderLock(
    (event.payload as { orderId: string }).orderId,
  );
  try {
    await receive(event, { lockTimeoutMs: 300 });
  } finally {
    await release();
  }
}

async function ingestOf(orderId: string) {
  const rows = await q<{ state: string; reason: string | null }>(
    `SELECT state, reason FROM edge_order_ingests
      WHERE tenant_id = $1 AND order_id = $2::uuid`,
    [tenantId, dbId(orderId)],
  );
  return rows[0];
}

async function count(table: string, orderId: string): Promise<number> {
  const rows = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND ${
      table === "orders" ? "id" : "order_id"
    } = $2::uuid`,
    [tenantId, dbId(orderId)],
  );
  return rows[0]!.n;
}

const quiet = { error: () => undefined };
const sweep = () =>
  redriveEdgeOrderRefusalsForTenant(jobContext(), {
    log: quiet,
    lockTimeoutMs: 300,
  });

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await createFixture();
  const registered = await registerEdgeNode(scopeOf([outletA]), actor, {
    outletId: outletA,
    role: "primary",
    label: "Utama Order Redrive",
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  node = authenticated;
});

afterAll(async () => {
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
      "edge_order_ingests",
      "pos_order_voids",
      "pos_order_tenders",
      "pos_order_items",
      "order_items",
      "order_events",
      "pos_orders",
      "orders",
      "menu_items",
      "menu_categories",
      "edge_deferred_events",
      "domain_event_outbox",
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
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await owner.end();
});

describe("legend-132mw isTransientReason", () => {
  it("is true only for lock_failed and db_error 40P01 / 55P03 / 40001", () => {
    for (const reason of [
      "lock_failed",
      "db_error:40P01",
      "db_error:55P03",
      "db_error:40001",
    ])
      expect(isTransientReason(reason)).toBe(true);
    for (const reason of [
      null,
      "",
      "error",
      "db_error:23505",
      "db_error:23503",
      "db_error:42P01",
      "legacy_payload",
      "money_mismatch",
    ])
      expect(isTransientReason(reason)).toBe(false);
  });
});

describe("legend-132mw redrive sweep of transient ingest refusals", () => {
  it("a lock_failed order.paid is redriven into a cloud order exactly once", async () => {
    const orderId = createUlid(++clock);
    const event = paidEvent(orderId);

    await receiveWhileLocked(event);
    expect(await ingestOf(orderId)).toMatchObject({
      state: "refused",
      reason: "lock_failed",
    });
    expect(await count("orders", orderId)).toBe(0);

    expect(await sweep()).toMatchObject({
      attempted: 1,
      recovered: 1,
      failed: 0,
    });
    expect(await ingestOf(orderId)).toMatchObject({
      state: "ingested",
      reason: null,
    });
    expect(await count("orders", orderId)).toBe(1);
    expect(await count("pos_order_tenders", orderId)).toBe(2);

    // Nothing left to redrive; a second run writes nothing again.
    expect(await sweep()).toMatchObject({ attempted: 0, recovered: 0 });
    expect(await count("orders", orderId)).toBe(1);
    expect(await count("pos_order_tenders", orderId)).toBe(2);
  });

  it("a lock that is still held stays refused as lock_failed and is retried next run", async () => {
    const orderId = createUlid(++clock);
    await receiveWhileLocked(paidEvent(orderId));

    const release = await holdOrderLock(orderId);
    try {
      expect(await sweep()).toMatchObject({ attempted: 1, recovered: 0 });
    } finally {
      await release();
    }
    expect(await ingestOf(orderId)).toMatchObject({
      state: "refused",
      reason: "lock_failed",
    });
    expect(await count("orders", orderId)).toBe(0);

    expect(await sweep()).toMatchObject({ attempted: 1, recovered: 1 });
    expect(await count("orders", orderId)).toBe(1);
  });

  it("db_error:23505 is final: never redriven, even once the cause is gone", async () => {
    const clashing = `RDV-CLASH-${randomBytes(3).toString("hex")}`;
    const clashId = randomUUID();
    await q(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
                           subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
                           total_idr, status, business_date, placed_at)
       VALUES ($1::uuid, $2, $3, $4, 'qr', 'takeaway', 'pay_first',
               1000, 0, 0, 0, 0, 1000, 'sent', $5, now())`,
      [clashId, tenantId, outletA, clashing, BUSINESS_DATE],
    );
    const orderId = createUlid(++clock);
    await receive(paidEvent(orderId, clashing));
    expect(await ingestOf(orderId)).toMatchObject({
      state: "refused",
      reason: "db_error:23505",
    });

    await q(
      "UPDATE orders SET number = $3 WHERE tenant_id = $1 AND id = $2::uuid",
      [tenantId, clashId, `${clashing}-MOVED`],
    );
    expect(await sweep()).toMatchObject({ attempted: 0, recovered: 0 });
    expect(await ingestOf(orderId)).toMatchObject({
      state: "refused",
      reason: "db_error:23505",
    });
    expect(await count("orders", orderId)).toBe(0);
  });

  it("a retry that fails for a new reason records the new reason and stops being redriven", async () => {
    const clashing = `RDV-NEW-${randomBytes(3).toString("hex")}`;
    const orderId = createUlid(++clock);
    await receiveWhileLocked(paidEvent(orderId, clashing));
    expect(await ingestOf(orderId)).toMatchObject({ reason: "lock_failed" });

    // The lock is free now, but the number is taken: the retry fails for good.
    await q(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
                           subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
                           total_idr, status, business_date, placed_at)
       VALUES ($1::uuid, $2, $3, $4, 'qr', 'takeaway', 'pay_first',
               1000, 0, 0, 0, 0, 1000, 'sent', $5, now())`,
      [randomUUID(), tenantId, outletA, clashing, BUSINESS_DATE],
    );
    expect(await sweep()).toMatchObject({ attempted: 1, recovered: 0 });
    expect(await ingestOf(orderId)).toMatchObject({
      state: "refused",
      reason: "db_error:23505",
    });
    expect(await count("orders", orderId)).toBe(0);

    expect(await sweep()).toMatchObject({ attempted: 0 });
  });

  it("a lock_failed order.voided is redriven and voids the order once", async () => {
    const orderId = createUlid(++clock);
    await receive(paidEvent(orderId));
    expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });

    await receiveWhileLocked(voidedEvent(orderId));
    expect(await ingestOf(orderId)).toMatchObject({
      state: "ingested",
      reason: "void_refused:lock_failed",
    });
    expect(await count("pos_order_voids", orderId)).toBe(0);

    expect(await sweep()).toMatchObject({
      attempted: 1,
      recovered: 1,
      failed: 0,
    });
    expect(await ingestOf(orderId)).toMatchObject({
      state: "voided",
      reason: null,
    });
    expect(await count("pos_order_voids", orderId)).toBe(1);

    expect(await sweep()).toMatchObject({ attempted: 0 });
    expect(await count("pos_order_voids", orderId)).toBe(1);
  });

  it("a void that hit order_not_ingested is ingested once the redrive recovers the paid order", async () => {
    const orderId = createUlid(++clock);
    await receiveWhileLocked(paidEvent(orderId));
    expect(await ingestOf(orderId)).toMatchObject({ reason: "lock_failed" });

    // The void arrives while the sale is still refused: it parks, nothing else.
    await receive(voidedEvent(orderId));
    expect(await ingestOf(orderId)).toMatchObject({
      state: "refused",
      reason: "lock_failed",
    });
    expect(await count("pos_order_voids", orderId)).toBe(0);

    expect(await sweep()).toMatchObject({
      attempted: 1,
      recovered: 1,
      failed: 0,
    });
    expect(await ingestOf(orderId)).toMatchObject({
      state: "voided",
      reason: null,
    });
    expect(await count("orders", orderId)).toBe(1);
    expect(await count("pos_order_voids", orderId)).toBe(1);

    expect(await sweep()).toMatchObject({ attempted: 0 });
    expect(await count("pos_order_voids", orderId)).toBe(1);
  });

  it("old final void_refused rows never starve a transient void behind them", async () => {
    // A full batch of older final rows, then one transient row newer than all.
    await q(
      `INSERT INTO edge_order_ingests
         (tenant_id, order_id, outlet_id, paid_event_id, state, reason, updated_at)
       SELECT $1, gen_random_uuid(), $2, gen_random_uuid(), 'ingested',
              'void_refused:already_voided', now() - interval '1 day'
         FROM generate_series(1, $3::int)`,
      [tenantId, outletA, EDGE_ORDER_REDRIVE_BATCH],
    );
    const orderId = createUlid(++clock);
    await receive(paidEvent(orderId));
    await receiveWhileLocked(voidedEvent(orderId));
    expect(await ingestOf(orderId)).toMatchObject({
      reason: "void_refused:lock_failed",
    });

    expect(await sweep()).toMatchObject({
      attempted: 1,
      recovered: 1,
      failed: 0,
    });
    expect(await ingestOf(orderId)).toMatchObject({
      state: "voided",
      reason: null,
    });
    expect(await count("pos_order_voids", orderId)).toBe(1);
  });

  it("the all-tenants entry point redrives through the tenant registry list", async () => {
    const orderId = createUlid(++clock);
    await receiveWhileLocked(paidEvent(orderId));

    const result = await redriveEdgeOrderRefusals({
      log: quiet,
      lockTimeoutMs: 300,
      listTenantIds: async () => [tenantId],
    });
    expect(result).toMatchObject({ attempted: 1, recovered: 1, failed: 0 });
    expect(await count("orders", orderId)).toBe(1);
  });
});
