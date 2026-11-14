// legend-qte35 (UANG): the gateway part of an order.refunded journal when the
// refund is a recovery refund (refundId = order_issues.id, no pos_order_refunds
// row) and NO payment_refunds row carries order_issue_id = refundId.
//
// Contract (brief legend-qte35, derived from the accounting auto-journal rules):
// - The source intent is found through the order's captured gateway tenders.
//   A posted receipt on that intent credits customer_deposit, never
//   gateway_clearing.
// - A gateway part that cannot be attributed to an intent is NOT guessed into
//   gateway_clearing: the refund parks retryable
//   AUTO_JOURNAL_REFUND_SOURCE_PENDING (no journal) and the sweep posts it once
//   the source exists, exactly once.
// - deposit + clearing never exceed refundGatewayIdr; every journal balances.
// - Regressions that stay as before: receipt "none" (money received before the
//   cutover) and a POS refund of a tender without an intent go to
//   gateway_clearing.
//
// Assumption: the "source exists later" case is a completed payment_refunds
// row filed with order_issue_id = the issue (what the recovery payout writes).

import { randomBytes, randomUUID } from "node:crypto";
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
/** 2026-10-15 12:00 in Jakarta. */
const DAY = "2026-10-15T05:00:00.000Z";
const REFUND_DAY = "2026-10-16T05:00:00.000Z";

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
     VALUES ($1, $2, 'Uji Split Refund', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-srf-${id.slice(0, 8)}`,
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
    [entity, tenant.id, `Entity SRF ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet SRF', 'Jl. SRF', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      outletId,
      tenant.id,
      tenant.brandId,
      entity,
      `SRF-${short()}`.toUpperCase(),
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
      `SRF-${linkId.slice(0, 8)}`,
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
      `srf-${intentId}`,
      DAY,
    ],
  );
  return { linkId, intentId };
}

/** A paid-intent receipt (payment.paid) still waiting undelivered in the outbox. */
async function seedUndeliveredReceipt(
  world: World,
  intentId: string,
  receivedIdr: number,
): Promise<void> {
  await owner.query(
    `INSERT INTO domain_event_outbox
       (tenant_id, id, outlet_id, event_id, aggregate_type, aggregate_id, sequence, event, destination)
     VALUES ($1, $2, $3, $4, 'payment', $5, 1, $6, 'cloud-sync')`,
    [
      world.tenant.id,
      randomUUID(),
      world.outletId,
      randomUUID(),
      intentId,
      JSON.stringify(paymentPaid(world, intentId, receivedIdr)),
    ],
  );
}

/**
 * A fired QR pay-first order (100k + 10k PBJT) pinned to the intent through
 * orders.payment_intent_id. It has no pos_order_tenders rows.
 */
async function seedQrOrder(
  world: World,
  linkId: string,
  intentId: string,
): Promise<string> {
  const orderUlid = createUlid();
  await asTenant(world.tenant, (client) =>
    client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          prices_include_tax, status, business_date, placed_at, fired_at,
          deposit_applied_idr, payment_link_id, payment_link_token_sealed, payment_intent_id)
       VALUES ($1, $2, $3, $4, 'qr', 'takeaway', 'pay_first', 100000, 0, 0, 10000, 0, 110000,
               false, 'sent', '2026-10-15', now(), $5, 0, $6, 'sealed', $7)`,
      [
        ulidToUuid(orderUlid),
        world.tenant.id,
        world.outletId,
        `QR-${short()}`,
        DAY,
        linkId,
        intentId,
      ],
    ),
  );
  return orderUlid;
}

type Tender = { method: "cash" | "qris"; amountIdr: number; intentId?: string };

/** A completed POS order (gross + PBJT = total) with captured tenders. */
async function seedPosOrder(
  world: World,
  orderUlid: string,
  sale: { grossSalesIdr: number; pbjtIdr: number; tenders: Tender[] },
): Promise<void> {
  const orderId = ulidToUuid(orderUlid);
  await asTenant(world.tenant, async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at, deposit_applied_idr)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, $6, 0, $7,
               'completed', '2026-10-15', now(), 0)`,
      [
        orderId,
        world.tenant.id,
        world.outletId,
        `SRF-${short()}`,
        sale.grossSalesIdr,
        sale.pbjtIdr,
        sale.grossSalesIdr + sale.pbjtIdr,
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

/** A resolved failed-item issue of the order (user and menu FKs skipped). */
async function seedIssue(world: World, orderUlid: string): Promise<string> {
  const orderUuid = ulidToUuid(orderUlid);
  const itemId = randomUUID();
  const issueId = randomUUID();
  await asTenant(
    world.tenant,
    async (client) => {
      await client.query(
        `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
           quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
           fire_status, status, reserved_business_date)
         VALUES ($1, $2, $3, $4, $5, NULL, 'Roti Bakar', 1, 40000, 0, 40000, '[]'::jsonb,
           'fired', 'served', '2026-10-15')`,
        [itemId, world.tenant.id, world.outletId, orderUuid, randomUUID()],
      );
      await client.query(
        `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
           reason_note, reported_by, resolution, approved_by, cost_idr, status, idempotency_key, resolved_at)
         VALUES ($1, $2, $3, $4, $5, 'unfulfillable', 'out_of_stock', 'Roti habis, refund manual disetujui',
           $6, 'manual_refund', $7, 0, 'resolved', $8, now())`,
        [
          issueId,
          world.tenant.id,
          world.outletId,
          orderUuid,
          itemId,
          randomUUID(),
          randomUUID(),
          `srf-${randomUUID()}`,
        ],
      );
    },
    { replica: true },
  );
  return issueId;
}

/** A completed recovery payout of the intent, filed for the issue. */
async function seedRecoveryPayout(
  world: World,
  intentId: string,
  issueId: string,
  amountIdr: number,
): Promise<void> {
  await asTenant(world.tenant, (client) =>
    client.query(
      `INSERT INTO payment_refunds
         (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
          requested_by, approved_by, decided_at, completed_at, order_issue_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'Refund item gagal (ORD-09)', 'completed', 'system:recovery',
               'approver', $6, $6, $7, $6::timestamptz - interval '1 minute')`,
      [
        randomUUID(),
        world.tenant.id,
        world.outletId,
        intentId,
        amountIdr,
        REFUND_DAY,
        issueId,
      ],
    ),
  );
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
    idempotencyKey: `srf-test-${id}`,
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

/** order.paid of the QR order made by seedQrOrder (100k + 10k PBJT, all gateway). */
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
      grossSalesIdr: 100_000,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 10_000,
      roundingIdr: 0,
      totalIdr: 110_000,
      paidCashIdr: 0,
      paidGatewayIdr: 110_000,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      paidDepositIdr: 0,
      tenders: [{ method: "qris", amountIdr: 110_000 }],
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

// ============================================================================

const GATEWAY_SALE = { grossSalesIdr: 50_000, pbjtIdr: 5_000 };
const FULL_REFUND = {
  grossSalesIdr: 50_000,
  pbjtIdr: 5_000,
  lines: [{ method: "qris" as const, amountIdr: 55_000 }],
};

describe("legend-qte35 recovery refund without a payment_refunds row", () => {
  it("RSJ-1 a recovery refund whose order has a captured gateway tender with a posted receipt credits customer_deposit, nothing to gateway_clearing", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, 55_000);
    await post(world, paymentPaid(world, intentId, 55_000));
    const sale = {
      ...GATEWAY_SALE,
      tenders: [{ method: "qris" as const, amountIdr: 55_000, intentId }],
    };
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, sale);
    await post(world, orderPaid(world, orderUlid, sale));
    const issueId = await seedIssue(world, orderUlid);
    const clearingBefore = await balanceOf(world, "gateway_clearing");

    const result = await post(
      world,
      orderRefunded(world, orderUlid, issueId, FULL_REFUND),
    );
    const lines = await linesOf(world, result.journalEntryId);
    expect(lines).toEqual([
      { role: "customer_deposit", debit: 0, credit: 55_000 },
      { role: "sales_revenue", debit: 50_000, credit: 0 },
      { role: "tax_payable_pbjt", debit: 5_000, credit: 0 },
    ]);
    expectBalancedLines(lines);
    // The refund journal did not touch gateway_clearing at all.
    expect(await balanceOf(world, "gateway_clearing")).toBe(clearingBefore);
    // Receipt Cr 55k, sale Dr 55k (net 0), refund Cr 55k: the money is owed
    // back to the customer until its payout (Dr customer_deposit) posts.
    expect(await balanceOf(world, "customer_deposit")).toBe(-55_000);
  });

  it("RSJ-2 the gateway part cannot be attributed to an intent: the refund parks retryable AUTO_JOURNAL_REFUND_SOURCE_PENDING, no journal, nothing to gateway_clearing", async () => {
    const world = await makeWorld();
    // A gateway tender without a payment intent (the refund's source is unknown).
    const sale = {
      ...GATEWAY_SALE,
      tenders: [{ method: "qris" as const, amountIdr: 55_000 }],
    };
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, sale);
    await post(world, orderPaid(world, orderUlid, sale));
    const issueId = await seedIssue(world, orderUlid);
    const clearingBefore = await balanceOf(world, "gateway_clearing");
    const journalsBefore = await journalCount(world);

    expect(
      await deliver(
        world.tenant,
        orderRefunded(world, orderUlid, issueId, FULL_REFUND),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_REFUND_SOURCE_PENDING",
      retryable: true,
    });
    expect(await journalCount(world)).toBe(journalsBefore);
    expect(await balanceOf(world, "gateway_clearing")).toBe(clearingBefore);
    expect(
      await parkedOf(world.tenant, `aj:order-refund:${issueId}`),
    ).toMatchObject([{ retryable: true, event_name: "order.refunded" }]);
  });

  it("RSJ-3 once the source exists the sweep posts the parked refund exactly once; more sweeps and a replay add no journal", async () => {
    const world = await makeWorld();
    const sale = {
      ...GATEWAY_SALE,
      tenders: [{ method: "qris" as const, amountIdr: 55_000 }],
    };
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, sale);
    await post(world, orderPaid(world, orderUlid, sale));
    const issueId = await seedIssue(world, orderUlid);
    const key = `aj:order-refund:${issueId}`;
    const event = orderRefunded(world, orderUlid, issueId, FULL_REFUND);

    expect(await deliver(world.tenant, event)).toMatchObject({
      status: "parked",
      code: "AUTO_JOURNAL_REFUND_SOURCE_PENDING",
    });
    // Still no source: the sweep leaves it parked and posts nothing.
    expect(await sweep(world.tenant)).toEqual({
      posted: 0,
      stillParked: 1,
      failed: 0,
    });
    const journalsParked = await journalCount(world);

    // The recovery payout for the issue now exists (its receipt is booked).
    const intentId = await seedIntent(world, 55_000);
    await post(world, paymentPaid(world, intentId, 55_000));
    await seedRecoveryPayout(world, intentId, issueId, 55_000);

    expect(await sweep(world.tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    const entryId = await journalIdOf(world, key);
    const lines = await linesOf(world, entryId);
    expect(creditOf(lines, "customer_deposit")).toBe(55_000);
    expect(creditOf(lines, "gateway_clearing")).toBe(0);
    expectBalancedLines(lines);
    expect(await parkedOf(world.tenant, key)).toHaveLength(0);
    // + the receipt of the new intent + the refund journal
    expect(await journalCount(world)).toBe(journalsParked + 2);

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
  });

  it("RSJ-4 a partial refund of a mixed sale balances and deposit + clearing never exceed refundGatewayIdr", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, 35_000);
    await post(world, paymentPaid(world, intentId, 35_000));
    const sale = {
      grossSalesIdr: 50_000,
      pbjtIdr: 5_000,
      tenders: [
        { method: "cash" as const, amountIdr: 20_000 },
        { method: "qris" as const, amountIdr: 35_000, intentId },
      ],
    };
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, sale);
    await post(world, orderPaid(world, orderUlid, sale));
    const issueId = await seedIssue(world, orderUlid);

    const result = await post(
      world,
      orderRefunded(world, orderUlid, issueId, {
        grossSalesIdr: 15_000,
        pbjtIdr: 0,
        lines: [{ method: "qris", amountIdr: 15_000 }],
      }),
    );
    const lines = await linesOf(world, result.journalEntryId);
    expectBalancedLines(lines);
    expect(
      creditOf(lines, "customer_deposit") + creditOf(lines, "gateway_clearing"),
    ).toBeLessThanOrEqual(15_000);
    expect(creditOf(lines, "customer_deposit")).toBe(15_000);
    expect(creditOf(lines, "gateway_clearing")).toBe(0);
  });
});

describe("legend-qte35 regressions: clearing stays where it is legitimate", () => {
  it("RSJ-5a receipt none (money received before the cutover, no receipt journal) still credits gateway_clearing", async () => {
    const world = await makeWorld();
    // The intent is paid but no payment.paid was ever journaled (pre-cutover).
    const intentId = await seedIntent(world, 55_000);
    const sale = {
      ...GATEWAY_SALE,
      tenders: [{ method: "qris" as const, amountIdr: 55_000, intentId }],
    };
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, sale);
    await post(world, orderPaid(world, orderUlid, sale));
    const issueId = await seedIssue(world, orderUlid);

    const result = await post(
      world,
      orderRefunded(world, orderUlid, issueId, FULL_REFUND),
    );
    const lines = await linesOf(world, result.journalEntryId);
    expect(creditOf(lines, "gateway_clearing")).toBe(55_000);
    expect(creditOf(lines, "customer_deposit")).toBe(0);
    expectBalancedLines(lines);
  });

  it("RSJ-5b a POS refund (not a recovery issue) of a gateway tender without an intent still credits gateway_clearing", async () => {
    const world = await makeWorld();
    const sale = {
      ...GATEWAY_SALE,
      tenders: [{ method: "qris" as const, amountIdr: 55_000 }],
    };
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, sale);
    await post(world, orderPaid(world, orderUlid, sale));

    const result = await post(
      world,
      orderRefunded(world, orderUlid, createUlid(), FULL_REFUND),
    );
    const lines = await linesOf(world, result.journalEntryId);
    expect(lines).toEqual([
      { role: "gateway_clearing", debit: 0, credit: 55_000 },
      { role: "sales_revenue", debit: 50_000, credit: 0 },
      { role: "tax_payable_pbjt", debit: 5_000, credit: 0 },
    ]);
    expectBalancedLines(lines);
  });
});

describe("legend-qte35 QR pay-first order pinned to its intent (orders.payment_intent_id)", () => {
  it("RSJ-6 a QR order without tenders or payment_refunds credits customer_deposit through its pinned intent, nothing to gateway_clearing, and balances", async () => {
    const world = await makeWorld();
    const { linkId, intentId } = await seedLinkedIntent(world, 110_000);
    await post(world, paymentPaid(world, intentId, 110_000));
    const orderUlid = await seedQrOrder(world, linkId, intentId);
    await post(world, qrOrderPaid(world, orderUlid));
    const issueId = await seedIssue(world, orderUlid);
    const clearingBefore = await balanceOf(world, "gateway_clearing");

    const result = await post(
      world,
      orderRefunded(world, orderUlid, issueId, {
        grossSalesIdr: 100_000,
        pbjtIdr: 10_000,
        lines: [{ method: "qris", amountIdr: 110_000 }],
      }),
    );
    const lines = await linesOf(world, result.journalEntryId);
    expect(lines).toEqual([
      { role: "customer_deposit", debit: 0, credit: 110_000 },
      { role: "sales_revenue", debit: 100_000, credit: 0 },
      { role: "tax_payable_pbjt", debit: 10_000, credit: 0 },
    ]);
    expectBalancedLines(lines);
    expect(await balanceOf(world, "gateway_clearing")).toBe(clearingBefore);
  });

  it("RSJ-7 a refund larger than the pinned intent's amount parks AUTO_JOURNAL_REFUND_SOURCE_PENDING: no journal, nothing to gateway_clearing", async () => {
    const world = await makeWorld();
    const { linkId, intentId } = await seedLinkedIntent(world, 110_000);
    await post(world, paymentPaid(world, intentId, 110_000));
    const orderUlid = await seedQrOrder(world, linkId, intentId);
    await post(world, qrOrderPaid(world, orderUlid));
    // Assumption: the intent is worth only 55k (e.g. a partly voided charge);
    // refunding 66k through it would pay out more than the intent received.
    await owner.query(
      "UPDATE payment_intents SET amount_idr = 55000 WHERE tenant_id = $1 AND id = $2",
      [world.tenant.id, intentId],
    );
    const issueId = await seedIssue(world, orderUlid);
    const journalsBefore = await journalCount(world);
    const clearingBefore = await balanceOf(world, "gateway_clearing");

    expect(
      await deliver(
        world.tenant,
        orderRefunded(world, orderUlid, issueId, {
          grossSalesIdr: 60_000,
          pbjtIdr: 6_000,
          lines: [{ method: "qris", amountIdr: 66_000 }],
        }),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_REFUND_SOURCE_PENDING",
      retryable: true,
    });
    expect(await journalCount(world)).toBe(journalsBefore);
    expect(await balanceOf(world, "gateway_clearing")).toBe(clearingBefore);
    expect(
      await parkedOf(world.tenant, `aj:order-refund:${issueId}`),
    ).toMatchObject([
      {
        error_code: "AUTO_JOURNAL_REFUND_SOURCE_PENDING",
        retryable: true,
        event_name: "order.refunded",
      },
    ]);
  });

  it("RSJ-8 the pinned intent's receipt is not posted yet (still in the outbox): the refund parks AUTO_JOURNAL_RECEIPT_PENDING with no journal and nothing to gateway_clearing", async () => {
    const world = await makeWorld();
    const { linkId, intentId } = await seedLinkedIntent(world, 110_000);
    const orderUlid = await seedQrOrder(world, linkId, intentId);
    // The sale is booked while the intent has no receipt anywhere (money
    // received before the cutover: receipt "none"); only then the receipt shows
    // up undelivered in the outbox, so the refund must wait for it.
    await post(world, qrOrderPaid(world, orderUlid));
    await seedUndeliveredReceipt(world, intentId, 110_000);
    const issueId = await seedIssue(world, orderUlid);
    const key = `aj:order-refund:${issueId}`;
    const journalsBefore = await journalCount(world);
    const clearingBefore = await balanceOf(world, "gateway_clearing");

    expect(
      await deliver(
        world.tenant,
        orderRefunded(world, orderUlid, issueId, {
          grossSalesIdr: 100_000,
          pbjtIdr: 10_000,
          lines: [{ method: "qris", amountIdr: 110_000 }],
        }),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_PENDING",
      retryable: true,
    });
    expect(await journalCount(world)).toBe(journalsBefore);
    expect(await balanceOf(world, "gateway_clearing")).toBe(clearingBefore);
    expect(await parkedOf(world.tenant, key)).toMatchObject([
      {
        error_code: "AUTO_JOURNAL_RECEIPT_PENDING",
        retryable: true,
        event_name: "order.refunded",
      },
    ]);
  });

  // ---- legend-qte35 update 3: the pin is only trusted for a settled, whole intent
  // Assumption: every guard failure parks like RSJ-7 (retryable
  // AUTO_JOURNAL_REFUND_SOURCE_PENDING), never falls back to gateway_clearing.

  async function expectParkedSourcePending(
    world: World,
    orderUlid: string,
    issueId: string,
    refund: Parameters<typeof orderRefunded>[3],
  ): Promise<void> {
    const journalsBefore = await journalCount(world);
    const clearingBefore = await balanceOf(world, "gateway_clearing");
    const depositBefore = await balanceOf(world, "customer_deposit");

    expect(
      await deliver(
        world.tenant,
        orderRefunded(world, orderUlid, issueId, refund),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_REFUND_SOURCE_PENDING",
      retryable: true,
    });
    expect(await journalCount(world)).toBe(journalsBefore);
    expect(await balanceOf(world, "gateway_clearing")).toBe(clearingBefore);
    expect(await balanceOf(world, "customer_deposit")).toBe(depositBefore);
    expect(
      await parkedOf(world.tenant, `aj:order-refund:${issueId}`),
    ).toMatchObject([
      {
        error_code: "AUTO_JOURNAL_REFUND_SOURCE_PENDING",
        retryable: true,
        event_name: "order.refunded",
      },
    ]);
  }

  const FULL_QR_REFUND = {
    grossSalesIdr: 100_000,
    pbjtIdr: 10_000,
    lines: [{ method: "qris" as const, amountIdr: 110_000 }],
  };

  it("RSJ-9 the pinned intent was never paid (status expired, no paid_at): the refund parks AUTO_JOURNAL_REFUND_SOURCE_PENDING, no journal, nothing to gateway_clearing", async () => {
    const world = await makeWorld();
    const { linkId, intentId } = await seedLinkedIntent(world, 110_000);
    const orderUlid = await seedQrOrder(world, linkId, intentId);
    await post(world, qrOrderPaid(world, orderUlid));
    await owner.query(
      "UPDATE payment_intents SET status = 'expired', paid_at = NULL WHERE tenant_id = $1 AND id = $2",
      [world.tenant.id, intentId],
    );
    const issueId = await seedIssue(world, orderUlid);

    await expectParkedSourcePending(world, orderUlid, issueId, FULL_QR_REFUND);
  });

  it("RSJ-10 the order is paid through bill splits (a bill_splits row exists): the refund parks AUTO_JOURNAL_REFUND_SOURCE_PENDING, no journal, nothing to gateway_clearing", async () => {
    const world = await makeWorld();
    const { linkId, intentId } = await seedLinkedIntent(world, 110_000);
    await post(world, paymentPaid(world, intentId, 110_000));
    const orderUlid = await seedQrOrder(world, linkId, intentId);
    await post(world, qrOrderPaid(world, orderUlid));
    await asTenant(
      world.tenant,
      (client) =>
        client.query(
          `INSERT INTO bill_splits
             (id, tenant_id, outlet_id, table_session_id, order_id, split_set_id,
              method, share_index, amount_idr, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'equal', 0, 55000, 'pending')`,
          [
            randomUUID(),
            world.tenant.id,
            world.outletId,
            randomUUID(),
            ulidToUuid(orderUlid),
            randomUUID(),
          ],
        ),
      { replica: true },
    );
    const issueId = await seedIssue(world, orderUlid);

    await expectParkedSourcePending(world, orderUlid, issueId, FULL_QR_REFUND);
  });

  it("RSJ-11 cumulative refunds on the same intent (another payment_refunds row + this refund) exceed the intent amount: the refund parks AUTO_JOURNAL_REFUND_SOURCE_PENDING, no journal, nothing to gateway_clearing", async () => {
    const world = await makeWorld();
    const { linkId, intentId } = await seedLinkedIntent(world, 110_000);
    await post(world, paymentPaid(world, intentId, 110_000));
    const orderUlid = await seedQrOrder(world, linkId, intentId);
    await post(world, qrOrderPaid(world, orderUlid));
    // An earlier, unrelated refund already paid 60k out of this 110k intent
    // (not filed for this issue, so it does not attribute this refund).
    await asTenant(world.tenant, (client) =>
      client.query(
        `INSERT INTO payment_refunds
           (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
            requested_by, approved_by, decided_at, completed_at, created_at)
         VALUES ($1, $2, $3, $4, 60000, 'Refund sebelumnya', 'completed', 'system:test',
                 'approver', $5, $5, $5::timestamptz - interval '1 minute')`,
        [randomUUID(), world.tenant.id, world.outletId, intentId, REFUND_DAY],
      ),
    );
    const issueId = await seedIssue(world, orderUlid);

    // 60k already refunded + 66k now = 126k > 110k received on the intent.
    await expectParkedSourcePending(world, orderUlid, issueId, {
      grossSalesIdr: 60_000,
      pbjtIdr: 6_000,
      lines: [{ method: "qris", amountIdr: 66_000 }],
    });
  });
});
