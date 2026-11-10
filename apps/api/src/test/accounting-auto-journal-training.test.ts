// Training orders never journal (legend-gkc6b). An order made on a training
// device is stamped `pos_orders.is_training = true`; the auto-journal consumer
// (`deliverAutoJournalEvent` for order.paid / order.refunded / order.voided and
// `retryParkedAutoJournals`) must treat it as not-real money: no journal, and
// nothing parked either (a parked SALE_MISSING row would be noise for the
// accountant). The twin case is a normal order with identical data, which must
// journal exactly as before.
//
// Pattern copied from test/accounting-auto-journal.test.ts (helpers are local
// because that file runs its own beforeAll).
//
// Assumptions:
// - The consumer answers `{ status: "ignored" }` for a training order (same
//   shape as the existing ignored outcome of AJ-142-F2b).
// - The sweep counters for a parked row of a (later flagged) training order are
//   not asserted: only "no journal" is the contract.
// - Tenant isolation (case 3): an order id is unique across tenants, so the
//   test proves the flag of tenant A's order does not leak to tenant B's
//   normal order (B still journals, A has nothing).
// - Round 2: an order flagged training AFTER its sale was journaled
//   (legacy journal `aj:sale:<orderId>`) still reverses on refund/void; the
//   reversal keeps its normal shapes (source_type refund / reversal). A
//   malformed (non-ULID) payload orderId is ignored, never a thrown error;
//   the event envelope itself keeps a valid ULID aggregateId.
// - A training order is flagged at insert time. `pos_orders` of a completed
//   order is frozen by a trigger, so the sweep case (flag set after an event
//   was parked) bypasses it with session_replication_role = replica, the same
//   way an operator backfill would.

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  deliverAutoJournalEvent,
  retryParkedAutoJournals,
  type AutoJournalResult,
} from "../services/accounting-auto-journal-consumer.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const short = () => randomUUID().slice(0, 6);
const NOW = new Date("2026-11-08T03:00:00Z");
const SWEEP_AT = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
const DAY = "2026-10-15T05:00:00.000Z";
const REFUND_DAY = "2026-10-16T05:00:00.000Z";

const FLAGS_ON = JSON.stringify({
  modules: ["accounting"],
  integrationProviders: [],
});

type Role =
  | "cash_on_hand"
  | "tax_payable_pbjt"
  | "sales_revenue"
  | "sales_discount"
  | "service_charge"
  | "rounding"
  | "customer_deposit"
  | "gateway_clearing";

const CHART: [Role, string, string, string, string][] = [
  ["cash_on_hand", "1101", "Kas", "asset", "current_asset"],
  [
    "gateway_clearing",
    "1201",
    "Kliring Payment Gateway",
    "asset",
    "current_asset",
  ],
  ["tax_payable_pbjt", "2104", "Utang PBJT", "liability", "current_liability"],
  [
    "customer_deposit",
    "2107",
    "Uang Muka Pelanggan",
    "liability",
    "current_liability",
  ],
  ["sales_revenue", "4101", "Penjualan", "revenue", "revenue"],
  ["sales_discount", "4102", "Diskon Penjualan", "revenue", "revenue"],
  ["service_charge", "4103", "Service Charge", "revenue", "revenue"],
  ["rounding", "4104", "Pembulatan", "revenue", "revenue"],
];

type Tenant = { id: string; brandId: string };
type World = {
  tenant: Tenant;
  entity: string;
  outletId: string;
  accounts: Record<Role, string>;
};

function contextOf(tenant: Tenant): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.id),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

async function makeTenant(): Promise<Tenant> {
  const id = randomUUID();
  const brandId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Auto Jurnal Latihan', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-ajt-${id.slice(0, 8)}`,
      FLAGS_ON,
      JSON.stringify({
        maxOutlets: 50,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [brandId, id],
  );
  return { id, brandId };
}

async function asTenant<T>(
  tenant: Tenant,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function mapRole(
  world: Pick<World, "tenant" | "entity">,
  role: Role,
  accountId: string,
): Promise<void> {
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, $3, $4)`,
    [world.tenant.id, world.entity, role, accountId],
  );
}

async function makeWorld(
  tenant: Tenant,
  options: { unmapped?: Role[] } = {},
): Promise<World> {
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenant.id, `Entity AJT ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet AJT', 'Jl. AJT', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      outletId,
      tenant.id,
      tenant.brandId,
      entity,
      `AJT-${short()}`.toUpperCase(),
    ],
  );
  const accounts = {} as Record<Role, string>;
  const world: World = { tenant, entity, outletId, accounts };
  for (const [role, code, name, type, group] of CHART) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenant.id, entity, code, name, type, group],
    );
    accounts[role] = rows[0]!.id;
    if (options.unmapped?.includes(role)) continue;
    await mapRole(world, role, accounts[role]);
  }
  for (const period of ["2026-09", "2026-10", "2026-11"])
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenant.id, entity, period],
    );
  return world;
}

// ---- seeding ---------------------------------------------------------------

/** Gross 100k, discount 10k, service 5k, PBJT 9.5k, rounding 0.5k = 105k cash. */
const SALE = {
  grossSalesIdr: 100_000,
  discountIdr: 10_000,
  serviceChargeIdr: 5_000,
  pbjtIdr: 9_500,
  roundingIdr: 500,
  totalIdr: 105_000,
};

/** A completed cash POS order; `isTraining` is stamped at creation. */
async function seedPosOrder(
  world: World,
  orderUlid: string,
  isTraining: boolean,
): Promise<void> {
  const orderId = ulidToUuid(orderUlid);
  await asTenant(world.tenant, async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at, deposit_applied_idr, table_session_id)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, $6, $7, $8, $9, $10,
               'completed', '2026-10-15', now(), 0, NULL)`,
      [
        orderId,
        world.tenant.id,
        world.outletId,
        `AJT-${short()}`,
        SALE.grossSalesIdr,
        SALE.discountIdr,
        SALE.serviceChargeIdr,
        SALE.pbjtIdr,
        SALE.roundingIdr,
        SALE.totalIdr,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at, is_training)
       VALUES ($1, $2, $3, 'pos', now(), now(), $4)`,
      [orderId, world.tenant.id, world.outletId, isTraining],
    );
    await client.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, payment_intent_id, amount_idr,
          received_idr, change_idr, points_used, status, requested_at, resolved_at)
       VALUES ($1, $2, $3, 'cash', 'manual', NULL, $4, $4, 0, NULL, 'captured', now(), now())`,
      [world.tenant.id, world.outletId, orderId, SALE.totalIdr],
    );
  });
}

/** UPDATE pos_orders SET is_training = true on a frozen (completed) order. */
async function markTraining(world: World, orderUlid: string): Promise<void> {
  await asTenant(world.tenant, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "UPDATE pos_orders SET is_training = true WHERE tenant_id = $1 AND order_id = $2",
      [world.tenant.id, ulidToUuid(orderUlid)],
    );
  });
}

/** The pos_order_voids row of a completed-sale void. */
async function seedVoid(world: World, orderUlid: string): Promise<string> {
  const voidId = randomUUID();
  await asTenant(world.tenant, (client) =>
    client.query(
      `INSERT INTO pos_order_voids
         (id, tenant_id, outlet_id, order_id, receipt_number, amount_idr, reason, reason_note,
          requested_by, approved_by, approval_request_id, voided_at)
       VALUES ($1, $2, $3, $4, 'AJT-0001', $7, 'wrong_order', 'Pesanan salah',
               'requester', 'approver', $6, $5)`,
      [
        voidId,
        world.tenant.id,
        world.outletId,
        ulidToUuid(orderUlid),
        REFUND_DAY,
        randomUUID(),
        SALE.totalIdr,
      ],
    ),
  );
  return voidId;
}

// ---- synthetic events -------------------------------------------------------

function envelope(
  world: World,
  input: {
    name: string;
    orderUlid: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  },
): EventEnvelope {
  const id = createUlid();
  return eventEnvelopeSchema.parse({
    id,
    tenantId: world.tenant.id,
    outletId: world.outletId,
    name: input.name,
    version: 1,
    aggregateType: "order",
    aggregateId: input.orderUlid,
    sequence: 1,
    occurredAt: input.occurredAt,
    actor: { type: "system" },
    idempotencyKey: `ajt-test-${id}`,
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload,
  });
}

function orderPaid(world: World, orderUlid: string): EventEnvelope {
  return envelope(world, {
    name: "order.paid",
    orderUlid,
    occurredAt: DAY,
    payload: {
      orderId: orderUlid,
      outletId: world.outletId,
      businessDate: "2026-10-15",
      channel: "pos",
      serviceType: "takeaway",
      grossSalesIdr: SALE.grossSalesIdr,
      discountIdr: SALE.discountIdr,
      serviceChargeIdr: SALE.serviceChargeIdr,
      pbjtIdr: SALE.pbjtIdr,
      roundingIdr: SALE.roundingIdr,
      totalIdr: SALE.totalIdr,
      paidCashIdr: SALE.totalIdr,
      paidGatewayIdr: 0,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      tenders: [{ method: "cash", amountIdr: SALE.totalIdr }],
      shiftId: null,
      cashierId: null,
      deviceId: null,
      paidAt: DAY,
    },
  });
}

function orderRefunded(world: World, orderUlid: string): EventEnvelope {
  return envelope(world, {
    name: "order.refunded",
    orderUlid,
    occurredAt: REFUND_DAY,
    payload: {
      orderId: orderUlid,
      outletId: world.outletId,
      businessDate: "2026-10-15",
      refundId: createUlid(),
      amountIdr: 55_000,
      reason: "customer_request",
      reasonNote: "Pesanan salah",
      approvedBy: randomUUID(),
      overrideId: null,
      approvalRequestId: null,
      grossSalesIdr: 50_000,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 5_000,
      refundCashIdr: 55_000,
      refundGatewayIdr: 0,
      refundEdcIdr: 0,
      refundPointsIdr: 0,
      lines: [{ method: "cash", amountIdr: 55_000 }],
      refundedAt: REFUND_DAY,
    },
  });
}

function orderVoided(
  world: World,
  orderUlid: string,
  voidId: string,
): EventEnvelope {
  return envelope(world, {
    name: "order.voided",
    orderUlid,
    occurredAt: REFUND_DAY,
    payload: {
      orderId: orderUlid,
      outletId: world.outletId,
      businessDate: "2026-10-15",
      amountIdr: SALE.totalIdr,
      reason: "wrong_order",
      reasonNote: "Pesanan salah",
      approvedBy: randomUUID(),
      overrideId: null,
      approvalRequestId: null,
      voidedFinalOrder: true,
      voidId,
      receiptNumber: "AJT-0001",
      voidedAt: REFUND_DAY,
    },
  });
}

// ---- act / read -------------------------------------------------------------

function deliver(
  tenant: Tenant,
  event: EventEnvelope,
): Promise<AutoJournalResult> {
  const context = contextOf(tenant);
  return withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(context, event, tx, NOW),
  );
}

let sweepCount = 0;
function sweep(tenant: Tenant) {
  sweepCount += 1;
  return retryParkedAutoJournals(
    contextOf(tenant),
    new Date(SWEEP_AT.getTime() + sweepCount * 60 * 60 * 1000),
  );
}

async function journalCount(world: World): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [world.tenant.id, world.entity],
  );
  return Number(rows[0]!.n);
}

async function parkedCount(world: World): Promise<number> {
  return asTenant(world.tenant, async (client) => {
    const { rows } = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM auto_journal_parked WHERE tenant_id = $1 AND outlet_id = $2",
      [world.tenant.id, world.outletId],
    );
    return Number(rows[0]!.n);
  });
}

async function entryMeta(
  world: World,
  entryId: string,
): Promise<{ source_type: string; reversal_of: string | null }> {
  const { rows } = await owner.query<{
    source_type: string;
    reversal_of: string | null;
  }>(
    "SELECT source_type, reversal_of FROM journal_entries WHERE tenant_id = $1 AND id = $2",
    [world.tenant.id, entryId],
  );
  return rows[0]!;
}

type Line = { role: Role; debit: number; credit: number };

async function linesOf(world: World, entryId: string): Promise<Line[]> {
  const { rows } = await owner.query<{
    account_id: string;
    debit: string;
    credit: string;
  }>(
    `SELECT account_id, sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 GROUP BY account_id`,
    [world.tenant.id, entryId],
  );
  const roleOf = new Map(
    (Object.entries(world.accounts) as [Role, string][]).map(([role, id]) => [
      id,
      role,
    ]),
  );
  return rows
    .map((row) => ({
      role: roleOf.get(row.account_id)!,
      debit: Number(row.debit),
      credit: Number(row.credit),
    }))
    .sort((a, b) => a.role.localeCompare(b.role));
}

const SALE_LINES: Line[] = [
  { role: "cash_on_hand", debit: 105_000, credit: 0 },
  { role: "rounding", debit: 0, credit: 500 },
  { role: "sales_discount", debit: 10_000, credit: 0 },
  { role: "sales_revenue", debit: 0, credit: 100_000 },
  { role: "service_charge", debit: 0, credit: 5_000 },
  { role: "tax_payable_pbjt", debit: 0, credit: 9_500 },
];

let shared: Tenant;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  shared = await makeTenant();
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.end();
});

// ============================================================================

describe("training orders never journal (legend-gkc6b)", () => {
  it("AJ-TRAIN-01 a paid training order posts no journal and parks nothing; a normal order with identical data journals as before", async () => {
    const training = await makeWorld(shared);
    const trainingUlid = createUlid();
    await seedPosOrder(training, trainingUlid, true);

    const ignored = await deliver(
      training.tenant,
      orderPaid(training, trainingUlid),
    );
    expect(await journalCount(training)).toBe(0);
    expect(await parkedCount(training)).toBe(0);
    expect(ignored).toEqual({ status: "ignored" });

    const normal = await makeWorld(shared);
    const normalUlid = createUlid();
    await seedPosOrder(normal, normalUlid, false);
    const posted = await deliver(normal.tenant, orderPaid(normal, normalUlid));
    expect(posted.status).toBe("posted");
    if (posted.status !== "posted") throw new Error("not posted");
    expect(await journalCount(normal)).toBe(1);
    expect(await linesOf(normal, posted.journalEntryId)).toEqual(SALE_LINES);
    expect(await parkedCount(normal)).toBe(0);
  });

  it("AJ-TRAIN-02a the void of a training order that was never journaled books nothing and does not park AUTO_JOURNAL_SALE_MISSING; a normal order does park it", async () => {
    const training = await makeWorld(shared);
    const trainingUlid = createUlid();
    await seedPosOrder(training, trainingUlid, true);
    const trainingVoid = await seedVoid(training, trainingUlid);

    const ignored = await deliver(
      training.tenant,
      orderVoided(training, trainingUlid, trainingVoid),
    );
    expect(await journalCount(training)).toBe(0);
    expect(await parkedCount(training)).toBe(0);
    expect(ignored).toEqual({ status: "ignored" });

    // Control: the same void of a normal order parks SALE_MISSING.
    const normal = await makeWorld(shared);
    const normalUlid = createUlid();
    await seedPosOrder(normal, normalUlid, false);
    const normalVoid = await seedVoid(normal, normalUlid);
    expect(
      await deliver(normal.tenant, orderVoided(normal, normalUlid, normalVoid)),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_SALE_MISSING",
      retryable: false,
    });
    expect(await parkedCount(normal)).toBe(1);
  });

  it("AJ-TRAIN-02b the refund of a training order that was never journaled books nothing and parks nothing; a normal order parks", async () => {
    const training = await makeWorld(shared);
    const trainingUlid = createUlid();
    await seedPosOrder(training, trainingUlid, true);

    const ignored = await deliver(
      training.tenant,
      orderRefunded(training, trainingUlid),
    );
    expect(await journalCount(training)).toBe(0);
    expect(await parkedCount(training)).toBe(0);
    expect(ignored).toEqual({ status: "ignored" });

    // Control: the same refund of a normal order (no sale journal) parks.
    const normal = await makeWorld(shared);
    const normalUlid = createUlid();
    await seedPosOrder(normal, normalUlid, false);
    const parked = await deliver(
      normal.tenant,
      orderRefunded(normal, normalUlid),
    );
    expect(parked.status).toBe("parked");
    expect(await parkedCount(normal)).toBe(1);
  });

  it("AJ-TRAIN-02c the whole life of a training order (paid, refunded, voided) leaves no journal and no parked row, also after a sweep", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, true);
    const voidId = await seedVoid(world, orderUlid);

    const results = [
      await deliver(tenant, orderPaid(world, orderUlid)),
      await deliver(tenant, orderRefunded(world, orderUlid)),
      await deliver(tenant, orderVoided(world, orderUlid, voidId)),
    ];
    await sweep(tenant);

    expect(await journalCount(world)).toBe(0);
    expect(await parkedCount(world)).toBe(0);
    expect(results).toEqual([
      { status: "ignored" },
      { status: "ignored" },
      { status: "ignored" },
    ]);
  });

  it("AJ-TRAIN-03 tenant isolation: a training order of tenant A does not change the journals of a normal order of tenant B", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const worldA = await makeWorld(tenantA);
    const worldB = await makeWorld(tenantB);
    const ulidA = createUlid();
    const ulidB = createUlid();
    await seedPosOrder(worldA, ulidA, true);
    await seedPosOrder(worldB, ulidB, false);

    await deliver(tenantA, orderPaid(worldA, ulidA));
    const posted = await deliver(tenantB, orderPaid(worldB, ulidB));

    expect(await journalCount(worldA)).toBe(0);
    expect(await parkedCount(worldA)).toBe(0);
    expect(posted.status).toBe("posted");
    if (posted.status !== "posted") throw new Error("not posted");
    expect(await journalCount(worldB)).toBe(1);
    expect(await linesOf(worldB, posted.journalEntryId)).toEqual(SALE_LINES);
    expect(await parkedCount(worldB)).toBe(0);
  });

  it("AJ-TRAIN-04 a parked row of an order later found to be a training order does not make a journal when the sweep retries it", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant, { unmapped: ["sales_revenue"] });
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, false);

    // Precondition: the normal order parks for the missing mapping.
    expect(await deliver(tenant, orderPaid(world, orderUlid))).toEqual({
      status: "parked",
      code: "ACCOUNT_MAPPING_MISSING",
      retryable: true,
    });
    expect(await parkedCount(world)).toBe(1);

    await markTraining(world, orderUlid);
    await mapRole(world, "sales_revenue", world.accounts.sales_revenue);
    await sweep(tenant);

    expect(await journalCount(world)).toBe(0);
  });

  // ---- round 2: legacy journals and malformed ids -----------------------------

  it("AJ-TRAIN-05a a sale journaled before the order was flagged training: the refund still posts its journal (not ignored)", async () => {
    const world = await makeWorld(await makeTenant());
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, false);
    const sale = await deliver(world.tenant, orderPaid(world, orderUlid));
    expect(sale.status).toBe("posted");
    if (sale.status !== "posted") throw new Error("not posted");

    await markTraining(world, orderUlid);
    const refund = await deliver(world.tenant, orderRefunded(world, orderUlid));

    expect(refund.status).toBe("posted");
    if (refund.status !== "posted") throw new Error("not posted");
    expect(await entryMeta(world, refund.journalEntryId)).toEqual({
      source_type: "refund",
      reversal_of: null,
    });
    expect(await linesOf(world, refund.journalEntryId)).toEqual([
      { role: "cash_on_hand", debit: 0, credit: 55_000 },
      { role: "sales_revenue", debit: 50_000, credit: 0 },
      { role: "tax_payable_pbjt", debit: 5_000, credit: 0 },
    ]);
    expect(await parkedCount(world)).toBe(0);
    // sale + refund
    expect(await journalCount(world)).toBe(2);
  });

  it("AJ-TRAIN-05b a sale journaled before the order was flagged training: the void still posts a reversal of the sale journal", async () => {
    const world = await makeWorld(await makeTenant());
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, false);
    const sale = await deliver(world.tenant, orderPaid(world, orderUlid));
    expect(sale.status).toBe("posted");
    if (sale.status !== "posted") throw new Error("not posted");
    const voidId = await seedVoid(world, orderUlid);

    await markTraining(world, orderUlid);
    const reversal = await deliver(
      world.tenant,
      orderVoided(world, orderUlid, voidId),
    );

    expect(reversal.status).toBe("posted");
    if (reversal.status !== "posted") throw new Error("not posted");
    expect(await entryMeta(world, reversal.journalEntryId)).toEqual({
      source_type: "reversal",
      reversal_of: sale.journalEntryId,
    });
    expect(await linesOf(world, reversal.journalEntryId)).toEqual([
      { role: "cash_on_hand", debit: 0, credit: 105_000 },
      { role: "rounding", debit: 500, credit: 0 },
      { role: "sales_discount", debit: 0, credit: 10_000 },
      { role: "sales_revenue", debit: 100_000, credit: 0 },
      { role: "service_charge", debit: 5_000, credit: 0 },
      { role: "tax_payable_pbjt", debit: 9_500, credit: 0 },
    ]);
    expect(await parkedCount(world)).toBe(0);
    // sale + reversal
    expect(await journalCount(world)).toBe(2);
  });

  it("AJ-TRAIN-06a a zero-rupiah order.paid whose orderId is not a ULID does not throw and is ignored", async () => {
    const world = await makeWorld(await makeTenant());
    const orderUlid = createUlid();
    const event = orderPaid(world, orderUlid);
    const zero = {
      ...event,
      payload: {
        ...event.payload,
        orderId: "not-a-ulid",
        grossSalesIdr: 0,
        discountIdr: 0,
        serviceChargeIdr: 0,
        pbjtIdr: 0,
        roundingIdr: 0,
        totalIdr: 0,
        paidCashIdr: 0,
        tenders: [],
      },
    } as EventEnvelope;

    await expect(deliver(world.tenant, zero)).resolves.toEqual({
      status: "ignored",
    });
    expect(await journalCount(world)).toBe(0);
    expect(await parkedCount(world)).toBe(0);
  });

  it("AJ-TRAIN-06b an open-order order.voided whose orderId is not a ULID does not throw and is ignored", async () => {
    const world = await makeWorld(await makeTenant());
    const orderUlid = createUlid();
    const event = orderVoided(world, orderUlid, randomUUID());
    const malformed = {
      ...event,
      payload: {
        ...event.payload,
        orderId: "not-a-ulid",
        voidedFinalOrder: false,
        voidId: null,
      },
    } as EventEnvelope;

    await expect(deliver(world.tenant, malformed)).resolves.toEqual({
      status: "ignored",
    });
    expect(await journalCount(world)).toBe(0);
    expect(await parkedCount(world)).toBe(0);
  });
});
