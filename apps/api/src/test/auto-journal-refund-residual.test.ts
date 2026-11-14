// legend-ljs6i (UANG): the residual gateway part of an order.refunded journal.
//
// Contract (brief legend-ljs6i, same rule as legend-qte35):
// - A POS refund (pos_order_refunds row) or a payload-only refund (no row, no
//   payment_refunds link) whose gateway part (refundGatewayIdr) has NO source
//   evidence on the order (no captured gateway tender, no linked payment
//   refund) is NOT guessed into gateway_clearing: it parks retryable
//   AUTO_JOURNAL_REFUND_SOURCE_PENDING (no journal), and the sweep posts it
//   once the source exists, exactly once.
// - A legitimate cash POS refund posts to cash_on_hand and never parks.
// - The first park of a refund logs console.error once (no personal data);
//   re-delivery, sweeps and the final post do not repeat the log.
// - Every journal balances; deposit + clearing never exceed refundGatewayIdr.
//
// Assumptions:
// - Evidence = a captured gateway tender of the order, or a payment_refunds row
//   linked to the refund (pos-refund-gateway key). An order paid only in cash
//   has no gateway evidence at all.
// - Unchanged regressions (kept by AJ-2JYR-02 and RSJ-5b): a gateway tender
//   WITHOUT an intent is still evidence and credits gateway_clearing.
// - The park log is console.error and its text carries the error code; the
//   spy counts every console.error call during the test.
// - A cash refund line credits cash_on_hand.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { format } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
/** 2026-10-15 12:00 in Jakarta. */
const DAY = "2026-10-15T05:00:00.000Z";

type Role =
  | "cash_on_hand"
  | "gateway_clearing"
  | "edc_clearing"
  | "loyalty_liability"
  | "tax_payable_pbjt"
  | "customer_deposit"
  | "sales_revenue"
  | "sales_discount"
  | "service_charge"
  | "rounding"
  | "deposit_forfeit_income"
  | "cash_over_short"
  | "bank"
  | "gateway_fee_expense";

const CHART: [Role, string, string, string, string][] = [
  ["cash_on_hand", "1101", "Kas", "asset", "current_asset"],
  ["gateway_clearing", "1201", "Kliring PG", "asset", "current_asset"],
  ["edc_clearing", "1202", "Kliring EDC", "asset", "current_asset"],
  ["loyalty_liability", "2105", "Poin", "liability", "current_liability"],
  ["tax_payable_pbjt", "2104", "Utang PBJT", "liability", "current_liability"],
  ["customer_deposit", "2107", "Uang Muka", "liability", "current_liability"],
  ["sales_revenue", "4101", "Penjualan", "revenue", "revenue"],
  ["sales_discount", "4102", "Diskon", "revenue", "revenue"],
  ["service_charge", "4103", "Service Charge", "revenue", "revenue"],
  ["rounding", "4104", "Pembulatan", "revenue", "revenue"],
  ["deposit_forfeit_income", "4201", "DP Hangus", "revenue", "other_income"],
  ["cash_over_short", "6108", "Selisih Kas", "expense", "operating_expense"],
  ["bank", "1103", "Bank", "asset", "current_asset"],
  ["gateway_fee_expense", "6109", "MDR", "expense", "operating_expense"],
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
     VALUES ($1, $2, 'Uji Refund Residual', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-arr-${id.slice(0, 8)}`,
      JSON.stringify({ modules: ["accounting"], integrationProviders: [] }),
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
  { replica = false }: { replica?: boolean } = {},
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (replica)
      await client.query("SET LOCAL session_replication_role = replica");
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

async function makeWorld(): Promise<World> {
  const tenant = await makeTenant();
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenant.id, `Entity ARR ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet ARR', 'Jl. ARR', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      outletId,
      tenant.id,
      tenant.brandId,
      entity,
      `ARR-${short()}`.toUpperCase(),
    ],
  );
  const accounts = {} as Record<Role, string>;
  for (const [role, code, name, type, group] of CHART) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenant.id, entity, code, name, type, group],
    );
    accounts[role] = rows[0]!.id;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenant.id, entity, role, accounts[role]],
    );
  }
  for (const period of ["2026-09", "2026-10", "2026-11"])
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenant.id, entity, period],
    );
  return { tenant, entity, outletId, accounts };
}

// ---- seeding ----------------------------------------------------------------

async function seedIntent(world: World, amountIdr: number): Promise<string> {
  return (await seedLinkedIntent(world, amountIdr)).intentId;
}

async function seedLinkedIntent(
  world: World,
  amountIdr: number,
): Promise<{ linkId: string; intentId: string }> {
  const linkId = randomUUID();
  const intentId = randomUUID();
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'seed')`,
    [
      linkId,
      world.tenant.id,
      world.outletId,
      randomBytes(32).toString("hex"),
      `ARR-${linkId.slice(0, 8)}`,
      amountIdr,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key,
        status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', $7,
             '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [
      intentId,
      world.tenant.id,
      world.outletId,
      linkId,
      amountIdr,
      `arr-${intentId}`,
      DAY,
    ],
  );
  return { linkId, intentId };
}

type Tender = {
  method: "cash" | "qris";
  amountIdr: number;
  intentId?: string;
};

/**
 * A completed POS order (gross + PBJT = total) with captured tenders. `pin`
 * sets orders.payment_link_id / payment_intent_id at INSERT: a completed order
 * is final (POS-04), so the pin can never be added by a later UPDATE.
 */
async function seedPosOrder(
  world: World,
  orderUlid: string,
  sale: { grossSalesIdr: number; pbjtIdr: number; tenders: Tender[] },
  pin?: { linkId: string; intentId: string },
): Promise<void> {
  const orderId = ulidToUuid(orderUlid);
  await asTenant(world.tenant, async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at, deposit_applied_idr,
          payment_link_id, payment_link_token_sealed, payment_intent_id)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, $6, 0, $7,
               'completed', '2026-10-15', now(), 0, $8, $9, $10)`,
      [
        orderId,
        world.tenant.id,
        world.outletId,
        `ARR-${short()}`,
        sale.grossSalesIdr,
        sale.pbjtIdr,
        sale.grossSalesIdr + sale.pbjtIdr,
        pin?.linkId ?? null,
        pin ? "sealed" : null,
        pin?.intentId ?? null,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', now(), now())`,
      [orderId, world.tenant.id, world.outletId],
    );
    for (const tender of sale.tenders) {
      const cash = tender.method === "cash";
      await client.query(
        `INSERT INTO pos_order_tenders
           (tenant_id, outlet_id, order_id, method, provider, payment_intent_id, amount_idr,
            received_idr, change_idr, points_used, status, requested_at, resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, 'captured', now(), now())`,
        [
          world.tenant.id,
          world.outletId,
          orderId,
          tender.method,
          cash ? "manual" : "doit",
          tender.intentId ?? null,
          tender.amountIdr,
          cash ? tender.amountIdr : null,
          cash ? 0 : null,
        ],
      );
    }
  });
}

// ---- events -----------------------------------------------------------------

function envelope(
  world: World,
  input: {
    name: string;
    aggregateType: "payment" | "order";
    aggregateId: string;
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
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    sequence: 1,
    occurredAt: input.occurredAt,
    actor: { type: "system" },
    idempotencyKey: `arr-test-${id}`,
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload,
  });
}

function paymentPaid(world: World, intentId: string, receivedIdr: number) {
  return envelope(world, {
    name: "payment.paid",
    aggregateType: "payment",
    aggregateId: intentId,
    occurredAt: DAY,
    payload: {
      intentId,
      method: "qris",
      provider: "doit",
      receivedIdr,
      paidAt: DAY,
      late: false,
    },
  });
}

function orderPaid(
  world: World,
  orderUlid: string,
  sale: { grossSalesIdr: number; pbjtIdr: number; tenders: Tender[] },
) {
  const sum = (method: Tender["method"]) =>
    sale.tenders
      .filter((tender) => tender.method === method)
      .reduce((total, tender) => total + tender.amountIdr, 0);
  return envelope(world, {
    name: "order.paid",
    aggregateType: "order",
    aggregateId: orderUlid,
    occurredAt: DAY,
    payload: {
      orderId: orderUlid,
      outletId: world.outletId,
      businessDate: "2026-10-15",
      channel: "pos",
      serviceType: "takeaway",
      grossSalesIdr: sale.grossSalesIdr,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: sale.pbjtIdr,
      roundingIdr: 0,
      totalIdr: sale.grossSalesIdr + sale.pbjtIdr,
      paidCashIdr: sum("cash"),
      paidGatewayIdr: sum("qris"),
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      tenders: sale.tenders.map((tender) => ({
        method: tender.method,
        amountIdr: tender.amountIdr,
      })),
      shiftId: null,
      cashierId: null,
      deviceId: null,
      paidAt: DAY,
    },
  });
}

/** order.paid of the QR order made by seedQrOrder (50k + 5k PBJT, all gateway). */
function qrOrderPaid(world: World, orderUlid: string) {
  return envelope(world, {
    name: "order.paid",
    aggregateType: "order",
    aggregateId: orderUlid,
    occurredAt: DAY,
    payload: {
      orderId: orderUlid,
      outletId: world.outletId,
      businessDate: "2026-10-15",
      channel: "qr",
      serviceType: "takeaway",
      grossSalesIdr: 50_000,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 5_000,
      roundingIdr: 0,
      totalIdr: 55_000,
      paidCashIdr: 0,
      paidGatewayIdr: 55_000,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      paidDepositIdr: 0,
      tenders: [{ method: "qris", amountIdr: 55_000 }],
      shiftId: null,
      cashierId: null,
      deviceId: null,
      paidAt: DAY,
    },
  });
}

/** order.refunded; refundId is a recovery issue id (UUID) or any POS id. */
function orderRefunded(
  world: World,
  orderUlid: string,
  refundId: string,
  refund: {
    grossSalesIdr: number;
    pbjtIdr: number;
    lines: { method: "cash" | "qris"; amountIdr: number }[];
  },
) {
  const sum = (method: "cash" | "qris") =>
    refund.lines
      .filter((line) => line.method === method)
      .reduce((total, line) => total + line.amountIdr, 0);
  return envelope(world, {
    name: "order.refunded",
    aggregateType: "order",
    aggregateId: orderUlid,
    occurredAt: DAY,
    payload: {
      orderId: orderUlid,
      outletId: world.outletId,
      businessDate: "2026-10-15",
      refundId,
      amountIdr: refund.grossSalesIdr + refund.pbjtIdr,
      reason: "other",
      reasonNote: "Roti habis, refund manual disetujui",
      approvedBy: randomUUID(),
      overrideId: null,
      approvalRequestId: null,
      grossSalesIdr: refund.grossSalesIdr,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: refund.pbjtIdr,
      refundCashIdr: sum("cash"),
      refundGatewayIdr: sum("qris"),
      refundEdcIdr: 0,
      refundPointsIdr: 0,
      lines: refund.lines,
      refundedAt: DAY,
    },
  });
}

function deliver(
  tenant: Tenant,
  event: EventEnvelope,
): Promise<AutoJournalResult> {
  const context = contextOf(tenant);
  return withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(context, event, tx, NOW),
  );
}

async function post(world: World, event: EventEnvelope) {
  const result = await deliver(world.tenant, event);
  expect(result.status).toBe("posted");
  if (result.status !== "posted") throw new Error("not posted");
  return result;
}

let sweepCount = 0;
function sweep(tenant: Tenant) {
  sweepCount += 1;
  return retryParkedAutoJournals(
    contextOf(tenant),
    new Date(SWEEP_AT.getTime() + sweepCount * 60 * 60 * 1000),
  );
}

// ---- reads ------------------------------------------------------------------

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

function creditOf(lines: Line[], role: Role): number {
  return lines.find((line) => line.role === role)?.credit ?? 0;
}

function expectBalancedLines(lines: Line[]): void {
  const debit = lines.reduce((total, line) => total + line.debit, 0);
  const credit = lines.reduce((total, line) => total + line.credit, 0);
  expect(debit).toBeGreaterThan(0);
  expect(debit).toBe(credit);
}

async function balanceOf(world: World, role: Role): Promise<number> {
  const { rows } = await owner.query<{ balance: string | null }>(
    `SELECT sum(debit_idr - credit_idr)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [world.tenant.id, world.accounts[role]],
  );
  return Number(rows[0]!.balance ?? 0);
}

async function journalCount(world: World): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1",
    [world.tenant.id],
  );
  return Number(rows[0]!.n);
}

async function journalIdOf(world: World, key: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2",
    [world.tenant.id, key],
  );
  expect(rows, key).toHaveLength(1);
  return rows[0]!.id;
}

async function parkedOf(tenant: Tenant, key: string) {
  return asTenant(tenant, async (client) => {
    const { rows } = await client.query<{
      error_code: string;
      retryable: boolean;
      event_name: string;
    }>(
      `SELECT error_code, retryable, event_name
         FROM auto_journal_parked WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenant.id, key],
    );
    return rows;
  });
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.end();
});

// ---- seeding of POS refunds -------------------------------------------------

type RefundLine = {
  method: "cash" | "qris";
  amountIdr: number;
  tenderId?: string;
  paymentIntentId?: string | null;
};

/** The pos_order_refunds row of a POS refund of the order; its id. */
async function seedPosRefund(
  world: World,
  orderUlid: string,
  lines: RefundLine[],
): Promise<string> {
  return asTenant(world.tenant, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO pos_order_refunds (tenant_id, outlet_id, order_id, amount_idr, reason, reason_note,
          lines, requested_by, approved_by, approval_request_id, refunded_at)
       VALUES ($1, $2, $3, $4, 'customer_cancelled', 'Uji', $5::jsonb,
               'kasir-uji', 'supervisor-uji', $6, $7)
       RETURNING id`,
      [
        world.tenant.id,
        world.outletId,
        ulidToUuid(orderUlid),
        lines.reduce((total, line) => total + line.amountIdr, 0),
        JSON.stringify(lines.map((line) => ({ ...line, reference: null }))),
        randomUUID(),
        DAY,
      ],
    );
    return rows[0]!.id;
  });
}

async function journalsWithKey(world: World, key: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2",
    [world.tenant.id, key],
  );
  return Number(rows[0]!.n);
}

/** A QR pay-first order (no tender rows): the paid intent is pinned on the order. */
async function seedQrOrder(
  world: World,
  orderUlid: string,
  linkId: string,
  intentId: string,
  status: "sent" | "completed" = "sent",
): Promise<void> {
  await asTenant(world.tenant, (client) =>
    client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          prices_include_tax, status, business_date, placed_at, fired_at,
          deposit_applied_idr, payment_link_id, payment_link_token_sealed, payment_intent_id)
       VALUES ($1, $2, $3, $4, 'qr', 'takeaway', 'pay_first', 50000, 0, 0, 5000, 0, 55000,
               false, $8, '2026-10-15', now(), $5, 0, $6, 'sealed', $7)`,
      [
        ulidToUuid(orderUlid),
        world.tenant.id,
        world.outletId,
        `QR-${short()}`,
        DAY,
        linkId,
        intentId,
        status,
      ],
    ),
  );
}

/**
 * A gateway payment refund of an intent (default 'completed'), mapped to a POS
 * refund. A 'failed' one has no completed_at and carries a failure reason.
 */
async function seedLinkedPaymentRefund(
  world: World,
  posRefundId: string,
  intentId: string,
  amountIdr: number,
  status: "completed" | "failed" = "completed",
): Promise<void> {
  const paymentRefundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, completed_at, failure_reason)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian dana', $7, 'requester', 'approver', $6, $8, $9)`,
    [
      paymentRefundId,
      world.tenant.id,
      world.outletId,
      intentId,
      amountIdr,
      DAY,
      status,
      status === "completed" ? DAY : null,
      status === "failed" ? "provider_declined" : null,
    ],
  );
  await owner.query(
    `INSERT INTO payment_admin_idempotency (tenant_id, key, fingerprint, response)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [
      world.tenant.id,
      `pos-refund-gateway:${posRefundId}:${intentId}`,
      "0".repeat(64),
      JSON.stringify({ refundId: paymentRefundId }),
    ],
  );
}

// ============================================================================

const SOURCE_PENDING = "AUTO_JOURNAL_REFUND_SOURCE_PENDING";
const SALE = { grossSalesIdr: 50_000, pbjtIdr: 5_000 };
const GATEWAY_REFUND = {
  grossSalesIdr: 50_000,
  pbjtIdr: 5_000,
  lines: [{ method: "qris" as const, amountIdr: 55_000 }],
};

/** A completed POS order paid only in cash (55k): it has no gateway evidence. */
async function sellCashOnly(world: World): Promise<string> {
  const sale = {
    ...SALE,
    tenders: [{ method: "cash" as const, amountIdr: 55_000 }],
  };
  const orderUlid = createUlid();
  await seedPosOrder(world, orderUlid, sale);
  await post(world, orderPaid(world, orderUlid, sale));
  return orderUlid;
}

async function expectParkedNoJournal(
  world: World,
  event: EventEnvelope,
  refundId: string,
): Promise<void> {
  const journalsBefore = await journalCount(world);
  const clearingBefore = await balanceOf(world, "gateway_clearing");
  const depositBefore = await balanceOf(world, "customer_deposit");
  const cashBefore = await balanceOf(world, "cash_on_hand");

  expect(await deliver(world.tenant, event)).toEqual({
    status: "parked",
    code: SOURCE_PENDING,
    retryable: true,
  });
  expect(await journalCount(world)).toBe(journalsBefore);
  expect(await balanceOf(world, "gateway_clearing")).toBe(clearingBefore);
  expect(await balanceOf(world, "customer_deposit")).toBe(depositBefore);
  expect(await balanceOf(world, "cash_on_hand")).toBe(cashBefore);
  expect(
    await parkedOf(world.tenant, `aj:order-refund:${refundId}`),
  ).toMatchObject([
    {
      error_code: SOURCE_PENDING,
      retryable: true,
      event_name: "order.refunded",
    },
  ]);
}

describe("legend-ljs6i residual gateway part of a refund without source evidence", () => {
  const errorSpy = vi.spyOn(console, "error");

  afterEach(() => {
    errorSpy.mockReset();
  });

  const loggedText = () => errorSpy.mock.calls.map((args) => format(...args));

  it("ARR-1 a POS refund (pos_order_refunds row) whose gateway part has no tender or payment refund behind it parks AUTO_JOURNAL_REFUND_SOURCE_PENDING: no journal, nothing to gateway_clearing", async () => {
    errorSpy.mockImplementation(() => {});
    const world = await makeWorld();
    const orderUlid = await sellCashOnly(world);
    const refundId = await seedPosRefund(world, orderUlid, [
      { method: "qris", amountIdr: 55_000 },
    ]);

    await expectParkedNoJournal(
      world,
      orderRefunded(world, orderUlid, refundId, GATEWAY_REFUND),
      refundId,
    );
  });

  it("ARR-2 a payload-only refund (no pos_order_refunds row, no payment refund) with a gateway part and no gateway tender on the order parks, no journal, nothing to gateway_clearing", async () => {
    errorSpy.mockImplementation(() => {});
    const world = await makeWorld();
    const orderUlid = await sellCashOnly(world);
    const refundId = createUlid();

    await expectParkedNoJournal(
      world,
      orderRefunded(world, orderUlid, refundId, GATEWAY_REFUND),
      refundId,
    );
  });

  it("ARR-3 a legitimate cash POS refund posts to cash_on_hand, is not parked and does not log an error", async () => {
    errorSpy.mockImplementation(() => {});
    const world = await makeWorld();
    const orderUlid = await sellCashOnly(world);
    const refundId = await seedPosRefund(world, orderUlid, [
      { method: "cash", amountIdr: 55_000 },
    ]);
    const clearingBefore = await balanceOf(world, "gateway_clearing");

    const result = await post(
      world,
      orderRefunded(world, orderUlid, refundId, {
        ...SALE,
        lines: [{ method: "cash", amountIdr: 55_000 }],
      }),
    );
    const lines = await linesOf(world, result.journalEntryId);
    expect(lines).toEqual([
      { role: "cash_on_hand", debit: 0, credit: 55_000 },
      { role: "sales_revenue", debit: 50_000, credit: 0 },
      { role: "tax_payable_pbjt", debit: 5_000, credit: 0 },
    ]);
    expectBalancedLines(lines);
    expect(await balanceOf(world, "gateway_clearing")).toBe(clearingBefore);
    expect(
      await parkedOf(world.tenant, `aj:order-refund:${refundId}`),
    ).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("ARR-4 a legitimate mixed POS refund (cash + gateway tender with a posted receipt) posts without parking; deposit + clearing never exceed refundGatewayIdr; it balances", async () => {
    errorSpy.mockImplementation(() => {});
    const world = await makeWorld();
    const intentId = await seedIntent(world, 35_000);
    await post(world, paymentPaid(world, intentId, 35_000));
    const sale = {
      ...SALE,
      tenders: [
        { method: "cash" as const, amountIdr: 20_000 },
        { method: "qris" as const, amountIdr: 35_000, intentId },
      ],
    };
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, sale);
    await post(world, orderPaid(world, orderUlid, sale));
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM pos_order_tenders WHERE tenant_id = $1 AND order_id = $2 AND method = 'qris'",
      [world.tenant.id, ulidToUuid(orderUlid)],
    );
    const refundId = await seedPosRefund(world, orderUlid, [
      { method: "cash", amountIdr: 10_000 },
      {
        method: "qris",
        amountIdr: 15_000,
        tenderId: rows[0]!.id,
        paymentIntentId: intentId,
      },
    ]);

    const result = await post(
      world,
      orderRefunded(world, orderUlid, refundId, {
        grossSalesIdr: 25_000,
        pbjtIdr: 0,
        lines: [
          { method: "cash", amountIdr: 10_000 },
          { method: "qris", amountIdr: 15_000 },
        ],
      }),
    );
    const lines = await linesOf(world, result.journalEntryId);
    expectBalancedLines(lines);
    expect(creditOf(lines, "cash_on_hand")).toBe(10_000);
    expect(
      creditOf(lines, "customer_deposit") + creditOf(lines, "gateway_clearing"),
    ).toBeLessThanOrEqual(15_000);
    expect(creditOf(lines, "customer_deposit")).toBe(15_000);
    expect(
      await parkedOf(world.tenant, `aj:order-refund:${refundId}`),
    ).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("ARR-5 the first park logs one error (carries the code, no personal data); re-delivery and sweeps that find it still parked do not repeat the log", async () => {
    errorSpy.mockImplementation(() => {});
    const world = await makeWorld();
    const orderUlid = await sellCashOnly(world);
    const refundId = await seedPosRefund(world, orderUlid, [
      { method: "qris", amountIdr: 55_000 },
    ]);
    const event = orderRefunded(world, orderUlid, refundId, GATEWAY_REFUND);
    errorSpy.mockClear();

    expect(await deliver(world.tenant, event)).toMatchObject({
      status: "parked",
      code: SOURCE_PENDING,
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [text] = loggedText();
    expect(text).toContain(SOURCE_PENDING);
    // No personal data: neither the free-text reason nor the approver.
    expect(text).not.toContain("Roti habis");
    expect(text).not.toContain(event.payload.approvedBy as string);

    // Parked again (same refund, still no source): no second log.
    expect(await deliver(world.tenant, event)).toMatchObject({
      status: "parked",
      code: SOURCE_PENDING,
    });
    expect(await sweep(world.tenant)).toEqual({
      posted: 0,
      stillParked: 1,
      failed: 0,
    });
    expect(await sweep(world.tenant)).toEqual({
      posted: 0,
      stillParked: 1,
      failed: 0,
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("ARR-6 once the source exists the sweep posts the parked refund exactly once (balanced, customer_deposit); further sweeps and a replay add no journal and no log", async () => {
    errorSpy.mockImplementation(() => {});
    const world = await makeWorld();
    const orderUlid = await sellCashOnly(world);
    const refundId = await seedPosRefund(world, orderUlid, [
      { method: "qris", amountIdr: 55_000 },
    ]);
    const key = `aj:order-refund:${refundId}`;
    const event = orderRefunded(world, orderUlid, refundId, GATEWAY_REFUND);

    expect(await deliver(world.tenant, event)).toMatchObject({
      status: "parked",
      code: SOURCE_PENDING,
    });
    expect(await journalsWithKey(world, key)).toBe(0);
    const logsAfterPark = errorSpy.mock.calls.length;
    expect(logsAfterPark).toBe(1);

    // The source now exists: a captured gateway tender of the order carries
    // the settled intent (receipt booked), which proves who paid the part.
    const intentId = await seedIntent(world, 55_000);
    await post(world, paymentPaid(world, intentId, 55_000));
    await owner.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, payment_intent_id, amount_idr,
          status, requested_at, resolved_at)
       VALUES ($1, $2, $3, 'qris', 'doit', $4, 55000, 'captured', now(), now())`,
      [world.tenant.id, world.outletId, ulidToUuid(orderUlid), intentId],
    );

    expect(await sweep(world.tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    const entryId = await journalIdOf(world, key);
    const lines = await linesOf(world, entryId);
    expectBalancedLines(lines);
    expect(creditOf(lines, "customer_deposit")).toBe(55_000);
    expect(creditOf(lines, "gateway_clearing")).toBe(0);
    expect(
      creditOf(lines, "customer_deposit") + creditOf(lines, "gateway_clearing"),
    ).toBeLessThanOrEqual(55_000);
    expect(await parkedOf(world.tenant, key)).toHaveLength(0);

    const journalsAfter = await journalCount(world);
    expect(await sweep(world.tenant)).toEqual({
      posted: 0,
      stillParked: 0,
      failed: 0,
    });
    expect(await deliver(world.tenant, event)).toEqual({
      status: "already_posted",
      journalEntryId: entryId,
    });
    expect(await journalCount(world)).toBe(journalsAfter);
    expect(await journalsWithKey(world, key)).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(logsAfterPark);
  });

  it("ARR-7 a gateway part larger than the evidence (intentless tender 30k, refund claims 55k) is not split into a guessed clearing credit: it parks, no journal", async () => {
    errorSpy.mockImplementation(() => {});
    const world = await makeWorld();
    const sale = {
      ...SALE,
      tenders: [
        { method: "cash" as const, amountIdr: 25_000 },
        { method: "qris" as const, amountIdr: 30_000 },
      ],
    };
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, sale);
    await post(world, orderPaid(world, orderUlid, sale));
    const refundId = createUlid();

    await expectParkedNoJournal(
      world,
      orderRefunded(world, orderUlid, refundId, GATEWAY_REFUND),
      refundId,
    );
  });

  it("ARR-8 a payload-only refund of a QR pay-first order whose pinned intent is paid and received (no tender rows, plain UUID refundId) posts to customer_deposit: no park, no error log", async () => {
    // Assumption: the pin (orders.payment_intent_id) with a paid intent and a
    // posted receipt is source evidence on its own. The order.paid journal is
    // posted first only because a refund journal needs the sale journal
    // (otherwise it parks AUTO_JOURNAL_SALE_MISSING).
    errorSpy.mockImplementation(() => {});
    const world = await makeWorld();
    const { linkId, intentId } = await seedLinkedIntent(world, 55_000);
    await post(world, paymentPaid(world, intentId, 55_000));
    const orderUlid = createUlid();
    await seedQrOrder(world, orderUlid, linkId, intentId);
    await post(world, qrOrderPaid(world, orderUlid));
    const refundId = randomUUID();
    const clearingBefore = await balanceOf(world, "gateway_clearing");

    const result = await post(
      world,
      orderRefunded(world, orderUlid, refundId, GATEWAY_REFUND),
    );
    const lines = await linesOf(world, result.journalEntryId);
    expectBalancedLines(lines);
    expect(creditOf(lines, "customer_deposit")).toBe(55_000);
    expect(creditOf(lines, "gateway_clearing")).toBe(0);
    expect(await balanceOf(world, "gateway_clearing")).toBe(clearingBefore);
    expect(
      await parkedOf(world.tenant, `aj:order-refund:${refundId}`),
    ).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("ARR-9 double count: with 30k already refunded through the intent (POS refund line with the intent + linked payment refund), a second payload-only refund of 10k pinned to the 55k intent posts (30k + 10k <= 55k)", async () => {
    errorSpy.mockImplementation(() => {});
    const world = await makeWorld();
    const { linkId, intentId } = await seedLinkedIntent(world, 55_000);
    await post(world, paymentPaid(world, intentId, 55_000));
    const orderUlid = createUlid();
    // The order was paid in cash but is pinned to the settled intent (an
    // earlier gateway deposit): no gateway tender row backs the refunds.
    const sale = {
      ...SALE,
      tenders: [{ method: "cash" as const, amountIdr: 55_000 }],
    };
    await seedPosOrder(world, orderUlid, sale, { linkId, intentId });
    await post(world, orderPaid(world, orderUlid, sale));

    const firstId = await seedPosRefund(world, orderUlid, [
      {
        method: "qris",
        amountIdr: 30_000,
        paymentIntentId: intentId,
        tenderId: randomUUID(),
      },
    ]);
    await seedLinkedPaymentRefund(world, firstId, intentId, 30_000);
    const first = await post(
      world,
      orderRefunded(world, orderUlid, firstId, {
        grossSalesIdr: 30_000,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: 30_000 }],
      }),
    );
    const firstLines = await linesOf(world, first.journalEntryId);
    expectBalancedLines(firstLines);
    expect(creditOf(firstLines, "customer_deposit")).toBe(30_000);

    const secondId = randomUUID();
    const second = await post(
      world,
      orderRefunded(world, orderUlid, secondId, {
        grossSalesIdr: 10_000,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: 10_000 }],
      }),
    );
    const secondLines = await linesOf(world, second.journalEntryId);
    expectBalancedLines(secondLines);
    expect(
      creditOf(secondLines, "customer_deposit") +
        creditOf(secondLines, "gateway_clearing"),
    ).toBeLessThanOrEqual(10_000);
    expect(creditOf(secondLines, "customer_deposit")).toBe(10_000);
    expect(
      await parkedOf(world.tenant, `aj:order-refund:${secondId}`),
    ).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("ARR-11 a legacy POS refund line pinned to the intent whose linked payment refund is 'failed' (money released, key spent) still counts as approved: after 30k, a second payload-only refund of 20k (30k + 20k > 40k intent, while the 55k order still has 25k left) parks, no journal", async () => {
    errorSpy.mockImplementation(() => {});
    const world = await makeWorld();
    const { linkId, intentId } = await seedLinkedIntent(world, 40_000);
    await post(world, paymentPaid(world, intentId, 40_000));
    const orderUlid = createUlid();
    const sale = {
      ...SALE,
      tenders: [{ method: "cash" as const, amountIdr: 55_000 }],
    };
    await seedPosOrder(world, orderUlid, sale, { linkId, intentId });
    await post(world, orderPaid(world, orderUlid, sale));

    const firstId = await seedPosRefund(world, orderUlid, [
      {
        method: "qris",
        amountIdr: 30_000,
        paymentIntentId: intentId,
        tenderId: randomUUID(),
      },
    ]);
    await seedLinkedPaymentRefund(world, firstId, intentId, 30_000, "failed");
    const first = await post(
      world,
      orderRefunded(world, orderUlid, firstId, {
        grossSalesIdr: 30_000,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: 30_000 }],
      }),
    );
    expectBalancedLines(await linesOf(world, first.journalEntryId));

    const secondId = randomUUID();
    await expectParkedNoJournal(
      world,
      orderRefunded(world, orderUlid, secondId, {
        grossSalesIdr: 20_000,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: 20_000 }],
      }),
      secondId,
    );
  });

  it("ARR-12 a linked payment refund smaller than its POS refund line (30k line, 10k filed and completed) only covers 10k: after it, a second payload-only refund of 20k on the 40k intent (20k + 10k + 20k > 40k) parks, no journal", async () => {
    errorSpy.mockImplementation(() => {});
    const world = await makeWorld();
    const { linkId, intentId } = await seedLinkedIntent(world, 40_000);
    await post(world, paymentPaid(world, intentId, 40_000));
    const orderUlid = createUlid();
    const sale = {
      ...SALE,
      tenders: [{ method: "cash" as const, amountIdr: 55_000 }],
    };
    await seedPosOrder(world, orderUlid, sale, { linkId, intentId });
    await post(world, orderPaid(world, orderUlid, sale));

    const firstId = await seedPosRefund(world, orderUlid, [
      {
        method: "qris",
        amountIdr: 30_000,
        paymentIntentId: intentId,
        tenderId: randomUUID(),
      },
    ]);
    // The gateway refund was clamped to the remaining cap: only 10k was filed.
    await seedLinkedPaymentRefund(world, firstId, intentId, 10_000);
    const first = await post(
      world,
      orderRefunded(world, orderUlid, firstId, {
        grossSalesIdr: 30_000,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: 30_000 }],
      }),
    );
    expectBalancedLines(await linesOf(world, first.journalEntryId));

    const secondId = randomUUID();
    await expectParkedNoJournal(
      world,
      orderRefunded(world, orderUlid, secondId, {
        grossSalesIdr: 20_000,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: 20_000 }],
      }),
      secondId,
    );
  });

  // legend-fpy9s: a deposit part (pos_deposit_refunds row) of the same POS refund
  // and intent shares the gateway key with the POS refund line. The filed
  // payment refund covers line + deposit part together, so a shortfall of the
  // line part must not be hidden by the deposit part.
  async function seedEarlierLinePlusDeposit(
    lineIdr: number,
    depositIdr: number,
    filedIdr: number,
  ) {
    const world = await makeWorld();
    const { linkId, intentId } = await seedLinkedIntent(world, 40_000);
    await post(world, paymentPaid(world, intentId, 40_000));
    const orderUlid = createUlid();
    const sale = {
      ...SALE,
      tenders: [{ method: "cash" as const, amountIdr: 55_000 }],
    };
    await seedPosOrder(world, orderUlid, sale, { linkId, intentId });
    await post(world, orderPaid(world, orderUlid, sale));

    const firstId = await seedPosRefund(world, orderUlid, [
      {
        method: "qris",
        amountIdr: lineIdr,
        paymentIntentId: intentId,
        tenderId: randomUUID(),
      },
    ]);
    // The deposit part is inserted directly: the service guard refuses a line
    // and a deposit part on one intent, but rows can exist at function level.
    await owner.query(
      `INSERT INTO pos_deposit_refunds
         (tenant_id, outlet_id, order_id, pos_refund_id, payment_intent_id, amount_idr, released_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        world.tenant.id,
        world.outletId,
        ulidToUuid(orderUlid),
        firstId,
        intentId,
        depositIdr,
        DAY,
      ],
    );
    await seedLinkedPaymentRefund(world, firstId, intentId, filedIdr);
    const first = await post(
      world,
      orderRefunded(world, orderUlid, firstId, {
        grossSalesIdr: lineIdr + depositIdr,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: lineIdr + depositIdr }],
      }),
    );
    expectBalancedLines(await linesOf(world, first.journalEntryId));
    return { world, orderUlid };
  }

  it("ARR-13 a deposit part on the same key does not cover a shortfall of the POS refund line (line 20k + deposit 15k, only 20k filed): the 15k unfiled stays counted, so a second payload-only refund of 20k on the 40k intent (15k + 20k + 20k > 40k) parks, no journal", async () => {
    errorSpy.mockImplementation(() => {});
    const { world, orderUlid } = await seedEarlierLinePlusDeposit(
      20_000,
      15_000,
      20_000,
    );

    const secondId = randomUUID();
    await expectParkedNoJournal(
      world,
      orderRefunded(world, orderUlid, secondId, {
        grossSalesIdr: 20_000,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: 20_000 }],
      }),
      secondId,
    );
  });

  it("ARR-14 control: line 20k + deposit 15k fully filed (35k) is counted once, not twice: a second payload-only refund of 5k on the 40k intent (35k + 5k <= 40k) posts to customer_deposit, no park", async () => {
    errorSpy.mockImplementation(() => {});
    const { world, orderUlid } = await seedEarlierLinePlusDeposit(
      20_000,
      15_000,
      35_000,
    );

    const secondId = randomUUID();
    const second = await post(
      world,
      orderRefunded(world, orderUlid, secondId, {
        grossSalesIdr: 5_000,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: 5_000 }],
      }),
    );
    const secondLines = await linesOf(world, second.journalEntryId);
    expectBalancedLines(secondLines);
    expect(creditOf(secondLines, "customer_deposit")).toBe(5_000);
    expect(creditOf(secondLines, "gateway_clearing")).toBe(0);
    expect(
      await parkedOf(world.tenant, `aj:order-refund:${secondId}`),
    ).toHaveLength(0);
  });

  // Every posted case: balanced, the whole gateway part goes to customer_deposit
  // (never gateway_clearing), and it never exceeds the pinned 40k intent minus
  // the earlier amounts that count against it.
  async function expectPostedToDeposit(
    world: World,
    entryId: string,
    refundId: string,
    gatewayIdr: number,
    countedEarlierIdr = 0,
    pinnedIdr = 40_000,
  ) {
    const lines = await linesOf(world, entryId);
    expectBalancedLines(lines);
    expect(creditOf(lines, "customer_deposit")).toBe(gatewayIdr);
    expect(creditOf(lines, "gateway_clearing")).toBe(0);
    expect(creditOf(lines, "customer_deposit")).toBeLessThanOrEqual(
      pinnedIdr - countedEarlierIdr,
    );
    expect(
      await parkedOf(world.tenant, `aj:order-refund:${refundId}`),
    ).toHaveLength(0);
  }

  // legend-xiz1p: an earlier POS refund has a deposit part D on ANOTHER intent
  // X whose linked payment refund at the shared key is 'failed' (money released,
  // key spent). The key is pos-refund-gateway:<refund>:<intent>, one payment
  // refund per refund + intent, so D only ever draws on X's capacity. It does
  // NOT count against the pinned intent: a later refund on the pinned intent
  // posts whenever it fits the pinned intent alone. `target: "pinned"` puts D on
  // the pinned intent itself (control: that one still counts).
  async function seedEarlierDepositOnOtherIntent(
    depositIdr: number,
    target: "other" | "pinned" = "other",
  ) {
    const world = await makeWorld();
    const { linkId, intentId } = await seedLinkedIntent(world, 40_000);
    await post(world, paymentPaid(world, intentId, 40_000));
    const other =
      target === "pinned"
        ? { linkId, intentId }
        : await seedLinkedIntent(world, depositIdr);
    const orderUlid = createUlid();
    const sale = {
      ...SALE,
      tenders: [{ method: "cash" as const, amountIdr: 55_000 }],
    };
    await seedPosOrder(world, orderUlid, sale, { linkId, intentId });
    await post(world, orderPaid(world, orderUlid, sale));

    const firstId = await seedPosRefund(world, orderUlid, [
      { method: "cash", amountIdr: depositIdr },
    ]);
    await owner.query(
      `INSERT INTO pos_deposit_refunds
         (tenant_id, outlet_id, order_id, pos_refund_id, payment_intent_id, amount_idr, released_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        world.tenant.id,
        world.outletId,
        ulidToUuid(orderUlid),
        firstId,
        other.intentId,
        depositIdr,
        DAY,
      ],
    );
    await seedLinkedPaymentRefund(
      world,
      firstId,
      other.intentId,
      depositIdr,
      "failed",
    );
    const first = await post(
      world,
      orderRefunded(world, orderUlid, firstId, {
        grossSalesIdr: depositIdr,
        pbjtIdr: 0,
        lines: [{ method: "cash", amountIdr: depositIdr }],
      }),
    );
    expectBalancedLines(await linesOf(world, first.journalEntryId));
    return { world, orderUlid, other, firstId };
  }

  it("ARR-15a deposit part D (15k) of an earlier refund on ANOTHER intent, linked payment refund 'failed', does not draw on the pinned 40k intent: a later payload-only refund of 30k posts to customer_deposit 30k, no gateway_clearing, no park", async () => {
    errorSpy.mockImplementation(() => {});
    const { world, orderUlid } = await seedEarlierDepositOnOtherIntent(15_000);

    const secondId = randomUUID();
    const second = await post(
      world,
      orderRefunded(world, orderUlid, secondId, {
        grossSalesIdr: 30_000,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: 30_000 }],
      }),
    );
    await expectPostedToDeposit(world, second.journalEntryId, secondId, 30_000);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("ARR-15b same setup, D (15k) still fits: a later payload-only refund of 20k on the pinned 40k intent (15k + 20k <= 40k) posts to customer_deposit, no park", async () => {
    errorSpy.mockImplementation(() => {});
    const { world, orderUlid } = await seedEarlierDepositOnOtherIntent(15_000);

    const secondId = randomUUID();
    const second = await post(
      world,
      orderRefunded(world, orderUlid, secondId, {
        grossSalesIdr: 20_000,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: 20_000 }],
      }),
    );
    await expectPostedToDeposit(world, second.journalEntryId, secondId, 20_000);
  });

  // legend-xiz1p: an earlier POS refund LINE (not a deposit) on another intent X
  // with a failed linked refund. Same key rule: it draws on X, not the pinned one.
  async function seedEarlierLineOnOtherIntent(lineIdr: number) {
    const world = await makeWorld();
    const { linkId, intentId } = await seedLinkedIntent(world, 40_000);
    await post(world, paymentPaid(world, intentId, 40_000));
    const other = await seedLinkedIntent(world, lineIdr);
    await post(world, paymentPaid(world, other.intentId, lineIdr));
    const orderUlid = createUlid();
    const sale = {
      ...SALE,
      tenders: [{ method: "cash" as const, amountIdr: 55_000 }],
    };
    await seedPosOrder(world, orderUlid, sale, { linkId, intentId });
    await post(world, orderPaid(world, orderUlid, sale));

    const firstId = await seedPosRefund(world, orderUlid, [
      {
        method: "qris",
        amountIdr: lineIdr,
        paymentIntentId: other.intentId,
        tenderId: randomUUID(),
      },
    ]);
    await seedLinkedPaymentRefund(
      world,
      firstId,
      other.intentId,
      lineIdr,
      "failed",
    );
    const first = await post(
      world,
      orderRefunded(world, orderUlid, firstId, {
        grossSalesIdr: lineIdr,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: lineIdr }],
      }),
    );
    expectBalancedLines(await linesOf(world, first.journalEntryId));
    return { world, orderUlid };
  }

  it("ARR-16 an earlier POS refund LINE (15k) on ANOTHER intent with a failed linked refund does not draw on the pinned 40k intent: a later payload-only refund of 30k (fits the pinned intent alone) posts to customer_deposit, no park", async () => {
    errorSpy.mockImplementation(() => {});
    const { world, orderUlid } = await seedEarlierLineOnOtherIntent(15_000);

    const secondId = randomUUID();
    const second = await post(
      world,
      orderRefunded(world, orderUlid, secondId, {
        grossSalesIdr: 30_000,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: 30_000 }],
      }),
    );
    await expectPostedToDeposit(world, second.journalEntryId, secondId, 30_000);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // legend-xiz1p: ARR-15 setup plus an admin re-file: a second, non-failed
  // payment refund on X under ANOTHER idempotency key (K2).
  async function seedEarlierDepositOnOtherIntentWithRefile() {
    const seeded = await seedEarlierDepositOnOtherIntent(15_000);
    const refilePaymentRefundId = randomUUID();
    await owner.query(
      `INSERT INTO payment_refunds
         (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
          requested_by, approved_by, decided_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'Pengembalian dana', 'completed', 'requester', 'approver', $6, $6)`,
      [
        refilePaymentRefundId,
        seeded.world.tenant.id,
        seeded.world.outletId,
        seeded.other.intentId,
        15_000,
        DAY,
      ],
    );
    await owner.query(
      `INSERT INTO payment_admin_idempotency (tenant_id, key, fingerprint, response)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        seeded.world.tenant.id,
        `pos-refund-gateway-refile:${seeded.firstId}:${seeded.other.intentId}:2`,
        "1".repeat(64),
        JSON.stringify({ refundId: refilePaymentRefundId }),
      ],
    );
    return seeded;
  }

  it("ARR-17 re-file under ANOTHER key: failed deposit D (15k) on other intent X at key K1 plus a second non-failed payment refund on X under key K2 (admin re-file) still do not draw on the pinned 40k intent: a later payload-only refund of 30k posts, customer_deposit not above the pinned intent", async () => {
    errorSpy.mockImplementation(() => {});
    const { world, orderUlid } =
      await seedEarlierDepositOnOtherIntentWithRefile();

    const secondId = randomUUID();
    const second = await post(
      world,
      orderRefunded(world, orderUlid, secondId, {
        grossSalesIdr: 30_000,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: 30_000 }],
      }),
    );
    await expectPostedToDeposit(world, second.journalEntryId, secondId, 30_000);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("ARR-18a control, no overpay: deposit D (15k) of an earlier refund on the PINNED intent itself, linked refund 'failed': a later payload-only refund of 30k (15k + 30k > 40k) still parks, no journal", async () => {
    errorSpy.mockImplementation(() => {});
    const { world, orderUlid } = await seedEarlierDepositOnOtherIntent(
      15_000,
      "pinned",
    );

    const secondId = randomUUID();
    await expectParkedNoJournal(
      world,
      orderRefunded(world, orderUlid, secondId, {
        grossSalesIdr: 30_000,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: 30_000 }],
      }),
      secondId,
    );
  });

  it("ARR-18b same pinned intent, D (15k) still fits: a later payload-only refund of 20k (15k + 20k <= 40k) posts to customer_deposit", async () => {
    errorSpy.mockImplementation(() => {});
    const { world, orderUlid } = await seedEarlierDepositOnOtherIntent(
      15_000,
      "pinned",
    );

    const secondId = randomUUID();
    const second = await post(
      world,
      orderRefunded(world, orderUlid, secondId, {
        grossSalesIdr: 20_000,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: 20_000 }],
      }),
    );
    await expectPostedToDeposit(
      world,
      second.journalEntryId,
      secondId,
      20_000,
      15_000,
    );
  });

  // legend-xiz1p: line 20k on the PINNED intent + deposit 15k on other intent X,
  // both linked refunds 'failed'. Only the 20k counts against the pinned 40k.
  async function seedLinePinnedPlusDepositOther() {
    const world = await makeWorld();
    const { linkId, intentId } = await seedLinkedIntent(world, 40_000);
    await post(world, paymentPaid(world, intentId, 40_000));
    const other = await seedLinkedIntent(world, 15_000);
    await post(world, paymentPaid(world, other.intentId, 15_000));
    const orderUlid = createUlid();
    // A 70k order: after the earlier 35k, the order itself still has room for
    // the later 25k, so only the pinned-intent bound can park it.
    const sale = {
      grossSalesIdr: 70_000,
      pbjtIdr: 0,
      tenders: [{ method: "cash" as const, amountIdr: 70_000 }],
    };
    await seedPosOrder(world, orderUlid, sale, { linkId, intentId });
    await post(world, orderPaid(world, orderUlid, sale));

    const firstId = await seedPosRefund(world, orderUlid, [
      {
        method: "qris",
        amountIdr: 20_000,
        paymentIntentId: intentId,
        tenderId: randomUUID(),
      },
    ]);
    await owner.query(
      `INSERT INTO pos_deposit_refunds
         (tenant_id, outlet_id, order_id, pos_refund_id, payment_intent_id, amount_idr, released_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        world.tenant.id,
        world.outletId,
        ulidToUuid(orderUlid),
        firstId,
        other.intentId,
        15_000,
        DAY,
      ],
    );
    await seedLinkedPaymentRefund(world, firstId, intentId, 20_000, "failed");
    await seedLinkedPaymentRefund(
      world,
      firstId,
      other.intentId,
      15_000,
      "failed",
    );
    const first = await post(
      world,
      orderRefunded(world, orderUlid, firstId, {
        grossSalesIdr: 35_000,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: 35_000 }],
      }),
    );
    expectBalancedLines(await linesOf(world, first.journalEntryId));
    return { world, orderUlid };
  }

  it("ARR-19a line 20k on the pinned 40k intent + deposit 15k on another intent (both failed): only the 20k counts, a later payload-only refund of 20k (20k + 20k <= 40k) posts to customer_deposit", async () => {
    errorSpy.mockImplementation(() => {});
    const { world, orderUlid } = await seedLinePinnedPlusDepositOther();

    const secondId = randomUUID();
    const second = await post(
      world,
      orderRefunded(world, orderUlid, secondId, {
        grossSalesIdr: 20_000,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: 20_000 }],
      }),
    );
    await expectPostedToDeposit(
      world,
      second.journalEntryId,
      secondId,
      20_000,
      20_000,
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("ARR-19b same setup: a later payload-only refund of 25k (20k + 25k > 40k) parks, no journal", async () => {
    errorSpy.mockImplementation(() => {});
    const { world, orderUlid } = await seedLinePinnedPlusDepositOther();

    const secondId = randomUUID();
    await expectParkedNoJournal(
      world,
      orderRefunded(world, orderUlid, secondId, {
        grossSalesIdr: 25_000,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: 25_000 }],
      }),
      secondId,
    );
  });

  it("ARR-10 an order with an intentless gateway tender (30k) pinned to a paid 55k intent: a refund claiming 55k gateway is not covered by the pin, it parks with no journal", async () => {
    errorSpy.mockImplementation(() => {});
    const world = await makeWorld();
    const { linkId, intentId } = await seedLinkedIntent(world, 55_000);
    await post(world, paymentPaid(world, intentId, 55_000));
    const sale = {
      ...SALE,
      tenders: [
        { method: "cash" as const, amountIdr: 25_000 },
        { method: "qris" as const, amountIdr: 30_000 },
      ],
    };
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, sale, { linkId, intentId });
    await post(world, orderPaid(world, orderUlid, sale));
    const refundId = createUlid();

    await expectParkedNoJournal(
      world,
      orderRefunded(world, orderUlid, refundId, GATEWAY_REFUND),
      refundId,
    );
  });
});
