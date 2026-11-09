// Auto-journals F19 slice 1 (docs/design/auto-journals.md sections 1-8;
// legend-9pz9, legend-o9q9). The cloud-only outbox consumer posts the money
// journals of `order.paid` (POS), `order.refunded`, `payment.paid` and
// `payment.refunded` through `deliverAutoJournalEvent`; a failed posting is
// parked in `auto_journal_parked` and posted by `retryParkedAutoJournals`.
//
// Runs the real consumer against the disposable PostgreSQL test database.
// Events are synthetic envelopes (the emitters are other modules); the rows the
// consumer reads besides the payload (payment intents, refunds, POS tenders)
// are seeded with raw SQL. Every test owns a fresh legal entity + outlet +
// chart, so journals never leak between tests. Tests that assert the sweep
// counters (or flip the module flag) use a fresh tenant of their own.
//
// Assumptions (the design fixes the contract, a few details are open):
// - Journals are looked up by the result's `journalEntryId`; idempotency keys
//   (`aj:receipt:<event.id>`, `aj:sale:<orderId>`, ...) are only used to find
//   parked rows (design section 4).
// - A parked row is not retried before its `next_retry_at`; the sweep is run
//   one day after `NOW`, far past any backoff, so tests do not depend on the
//   exact backoff.
// - Money time of `payment.refunded` is `payment_refunds.completed_at` (the
//   payload lacks it); the seeded refund row is completed on 2026-10-16.
// - A rolled-forward entry's description contains the natural date
//   (`... (penyesuaian terlambat dari 2026-10-15)`, design section 5.5) and the
//   audit row of action `accounting.journal.late_adjusted` names the journal id
//   (found by a text search of the audit event, not by a field path).
// - An EDC-linked payment intent posts nothing on `payment.paid` (design
//   risk 2: EDC money settles through `edc_clearing`).
// - Journal lines are compared per role with each side summed, so a rule that
//   splits one role over two lines (customer_deposit on order.paid) still
//   matches.

import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
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
/** Fixed "now" of the consumer; every business instant below is in the past. */
const NOW = new Date("2026-11-08T03:00:00Z");
/** The sweep clock: a day later, past any retry backoff. */
const SWEEP_AT = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
/** 2026-10-15 12:00 in Jakarta: business date 2026-10-15. */
const DAY = "2026-10-15T05:00:00.000Z";
/** Completion instant of seeded refunds: business date 2026-10-16. */
const REFUND_DAY = "2026-10-16T05:00:00.000Z";

const FLAGS_ON = JSON.stringify({
  modules: ["accounting"],
  integrationProviders: [],
});
const FLAGS_OFF = JSON.stringify({ modules: [], integrationProviders: [] });

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
  | "deposit_forfeit_income";

const CHART: [Role, string, string, string, string][] = [
  ["cash_on_hand", "1101", "Kas", "asset", "current_asset"],
  [
    "gateway_clearing",
    "1201",
    "Kliring Payment Gateway",
    "asset",
    "current_asset",
  ],
  ["edc_clearing", "1202", "Kliring EDC", "asset", "current_asset"],
  [
    "loyalty_liability",
    "2105",
    "Liabilitas Poin",
    "liability",
    "current_liability",
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
  [
    "deposit_forfeit_income",
    "4201",
    "Pendapatan DP Hangus",
    "revenue",
    "other_income",
  ],
];

type Tenant = { id: string; brandId: string };

type World = {
  tenant: Tenant;
  entity: string;
  outletId: string;
  accounts: Record<Role, string>;
};

let shared: Tenant;

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

async function makeTenant(flags: string = FLAGS_ON): Promise<Tenant> {
  const id = randomUUID();
  const brandId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Auto Jurnal', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-aj-${id.slice(0, 8)}`,
      flags,
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

async function setModules(tenant: Tenant, flags: string): Promise<void> {
  await owner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [tenant.id, flags],
  );
}

/** Owner connection with the tenant GUCs set, for RLS-protected tables. */
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

/** A legal entity + outlet + CoA with every posting role + open periods. */
async function makeWorld(
  tenant: Tenant = shared,
  options: { unmapped?: Role[] } = {},
): Promise<World> {
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenant.id, `Entity AJ ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet AJ', 'Jl. AJ', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      outletId,
      tenant.id,
      tenant.brandId,
      entity,
      `AJ-${short()}`.toUpperCase(),
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

/** Closes the given months in order (the period-close gate of ACC-02). */
async function closePeriods(world: World, periods: string[]): Promise<void> {
  for (const period of periods)
    await owner.query(
      `UPDATE fiscal_periods SET status = 'closed', closed_by = $3, closed_at = now()
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $4`,
      [world.tenant.id, world.entity, randomUUID(), period],
    );
}

// ---- seeding: payment intents, refunds, POS orders -------------------------

type IntentOptions = {
  amountIdr: number;
  reservationId?: string;
  edcTransactionId?: string;
};

/** A paid gateway (QRIS) intent with its payment link. */
async function seedIntent(
  world: World,
  options: IntentOptions,
): Promise<string> {
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
      `AJ-${linkId.slice(0, 8)}`,
      options.amountIdr,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key,
        status, paid_at, instructions, expires_at, reservation_id, edc_transaction_id)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', $7,
             '{"method":"qris","qrPayload":"test","issuer":null}', now(), $8, $9)`,
    [
      intentId,
      world.tenant.id,
      world.outletId,
      linkId,
      options.amountIdr,
      `aj-${intentId}`,
      DAY,
      options.reservationId ?? null,
      options.edcTransactionId ?? null,
    ],
  );
  return intentId;
}

/** A completed gateway refund (payout done) of an intent. */
async function seedRefund(
  world: World,
  intentId: string,
  amountIdr: number,
): Promise<string> {
  const refundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian dana', 'completed', 'requester', 'approver', $6, $6)`,
    [
      refundId,
      world.tenant.id,
      world.outletId,
      intentId,
      amountIdr,
      REFUND_DAY,
    ],
  );
  return refundId;
}

type TenderMethod = "cash" | "qris" | "edc_card";
type Tender = {
  method: TenderMethod;
  amountIdr: number;
  /** qris only: the payment intent that backs the tender (absent = no intent). */
  intentId?: string;
};

type SaleAmounts = {
  grossSalesIdr: number;
  discountIdr?: number;
  serviceChargeIdr?: number;
  pbjtIdr?: number;
  roundingIdr?: number;
  tenders: Tender[];
};

const bucketOf = (method: TenderMethod) =>
  method === "cash"
    ? "paidCashIdr"
    : method === "qris"
      ? "paidGatewayIdr"
      : "paidEdcIdr";

function totalOf(sale: SaleAmounts): number {
  return (
    sale.grossSalesIdr -
    (sale.discountIdr ?? 0) +
    (sale.serviceChargeIdr ?? 0) +
    (sale.pbjtIdr ?? 0) +
    (sale.roundingIdr ?? 0)
  );
}

/** The POS order, its tenders (gateway rows carry the intent id). */
async function seedPosOrder(
  world: World,
  orderUlid: string,
  sale: SaleAmounts,
): Promise<void> {
  const orderId = ulidToUuid(orderUlid);
  await asTenant(world.tenant, async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, $6, $7, $8, $9, $10,
               'completed', '2026-10-15', now())`,
      [
        orderId,
        world.tenant.id,
        world.outletId,
        `AJ-${short()}`,
        sale.grossSalesIdr,
        sale.discountIdr ?? 0,
        sale.serviceChargeIdr ?? 0,
        sale.pbjtIdr ?? 0,
        sale.roundingIdr ?? 0,
        totalOf(sale),
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
            received_idr, change_idr, status, requested_at, resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'captured', now(), now())`,
        [
          world.tenant.id,
          world.outletId,
          orderId,
          tender.method,
          cash ? "manual" : tender.method === "edc_card" ? "edc" : "doit",
          tender.intentId ?? null,
          tender.amountIdr,
          cash ? tender.amountIdr : null,
          cash ? 0 : null,
        ],
      );
    }
  });
}

// ---- synthetic events -------------------------------------------------------

function envelope(
  world: World,
  input: {
    id?: string;
    name: string;
    aggregateType: string;
    aggregateId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  },
): EventEnvelope {
  const id = input.id ?? createUlid();
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
    idempotencyKey: `aj-test-${id}`,
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload,
  });
}

function paymentPaid(
  world: World,
  intentId: string,
  receivedIdr: number,
  extra: {
    id?: string;
    paidAt?: string;
    late?: boolean;
    payload?: object;
  } = {},
): EventEnvelope {
  const paidAt = extra.paidAt ?? DAY;
  return envelope(world, {
    ...(extra.id === undefined ? {} : { id: extra.id }),
    name: "payment.paid",
    aggregateType: "payment",
    aggregateId: intentId,
    occurredAt: paidAt,
    payload: {
      intentId,
      method: "qris",
      provider: "doit",
      receivedIdr,
      paidAt,
      late: extra.late ?? false,
      ...extra.payload,
    },
  });
}

function paymentRefunded(
  world: World,
  refundId: string,
  intentId: string,
  amountIdr: number,
): EventEnvelope {
  return envelope(world, {
    name: "payment.refunded",
    aggregateType: "payment",
    aggregateId: refundId,
    occurredAt: REFUND_DAY,
    payload: { refundId, paymentIntentId: intentId, amountIdr },
  });
}

function orderPaid(
  world: World,
  orderUlid: string,
  sale: SaleAmounts,
  paidAt: string = DAY,
): EventEnvelope {
  const sum = (key: string) =>
    sale.tenders
      .filter((tender) => bucketOf(tender.method) === key)
      .reduce((total, tender) => total + tender.amountIdr, 0);
  return envelope(world, {
    name: "order.paid",
    aggregateType: "order",
    aggregateId: orderUlid,
    occurredAt: paidAt,
    payload: {
      orderId: orderUlid,
      outletId: world.outletId,
      businessDate: "2026-10-15",
      channel: "pos",
      serviceType: "takeaway",
      grossSalesIdr: sale.grossSalesIdr,
      discountIdr: sale.discountIdr ?? 0,
      serviceChargeIdr: sale.serviceChargeIdr ?? 0,
      pbjtIdr: sale.pbjtIdr ?? 0,
      roundingIdr: sale.roundingIdr ?? 0,
      totalIdr: totalOf(sale),
      paidCashIdr: sum("paidCashIdr"),
      paidGatewayIdr: sum("paidGatewayIdr"),
      paidEdcIdr: sum("paidEdcIdr"),
      paidPointsIdr: 0,
      tenders: sale.tenders.map((tender) => ({
        method: tender.method,
        amountIdr: tender.amountIdr,
      })),
      shiftId: null,
      cashierId: null,
      deviceId: null,
      paidAt,
    },
  });
}

function orderRefunded(
  world: World,
  orderUlid: string,
  refundId: string,
  refund: {
    grossSalesIdr: number;
    pbjtIdr: number;
    lines: { method: TenderMethod; amountIdr: number }[];
  },
  refundedAt: string = DAY,
): EventEnvelope {
  const sum = (key: string) =>
    refund.lines
      .filter((line) => bucketOf(line.method) === key)
      .reduce((total, line) => total + line.amountIdr, 0);
  return envelope(world, {
    name: "order.refunded",
    aggregateType: "order",
    aggregateId: orderUlid,
    occurredAt: refundedAt,
    payload: {
      orderId: orderUlid,
      outletId: world.outletId,
      businessDate: "2026-10-15",
      refundId,
      amountIdr: refund.grossSalesIdr + refund.pbjtIdr,
      reason: "customer_request",
      reasonNote: "Pesanan salah",
      approvedBy: randomUUID(),
      overrideId: null,
      approvalRequestId: null,
      grossSalesIdr: refund.grossSalesIdr,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: refund.pbjtIdr,
      refundCashIdr: sum("paidCashIdr"),
      refundGatewayIdr: sum("paidGatewayIdr"),
      refundEdcIdr: sum("paidEdcIdr"),
      refundPointsIdr: 0,
      lines: refund.lines,
      refundedAt,
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

function sweep(tenant: Tenant) {
  return retryParkedAutoJournals(contextOf(tenant), SWEEP_AT);
}

/** Delivers and asserts the posting happened; returns the posted result. */
async function post(world: World, event: EventEnvelope) {
  const result = await deliver(world.tenant, event);
  expect(result.status).toBe("posted");
  if (result.status !== "posted") throw new Error("not posted");
  return result;
}

// ---- reads ------------------------------------------------------------------

type Entry = {
  id: string;
  entry_date: string;
  late_adjustment_from: string | null;
  source_type: string;
  description: string;
  outlet_id: string | null;
};

async function entryOf(world: World, entryId: string): Promise<Entry> {
  const { rows } = await owner.query<Entry>(
    `SELECT id, entry_date::text AS entry_date, late_adjustment_from::text AS late_adjustment_from,
            source_type, description, outlet_id
       FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2 AND id = $3`,
    [world.tenant.id, world.entity, entryId],
  );
  expect(rows, `journal ${entryId}`).toHaveLength(1);
  return rows[0]!;
}

async function journalCount(world: World): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [world.tenant.id, world.entity],
  );
  return Number(rows[0]!.n);
}

type Line = { role: Role; debit: number; credit: number };

/** Lines of one journal summed per role, sorted by role. */
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

/** Total debits and credits of a journal: a posted journal always balances. */
async function expectBalanced(world: World, entryId: string): Promise<void> {
  const lines = await linesOf(world, entryId);
  const debit = lines.reduce((total, line) => total + line.debit, 0);
  const credit = lines.reduce((total, line) => total + line.credit, 0);
  expect(debit).toBeGreaterThan(0);
  expect(debit).toBe(credit);
}

/** Debit minus credit over every journal of the world, per role. */
async function balanceOf(world: World, role: Role): Promise<number> {
  const { rows } = await owner.query<{ balance: string | null }>(
    `SELECT sum(debit_idr - credit_idr)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [world.tenant.id, world.accounts[role]],
  );
  return Number(rows[0]!.balance ?? 0);
}

type Parked = {
  error_code: string;
  retryable: boolean;
  attempts: number;
  event_name: string;
  outlet_id: string;
};

async function parkedOf(tenant: Tenant, key: string): Promise<Parked[]> {
  return asTenant(tenant, async (client) => {
    const { rows } = await client.query<Parked>(
      `SELECT error_code, retryable, attempts, event_name, outlet_id
         FROM auto_journal_parked WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenant.id, key],
    );
    return rows;
  });
}

async function lateAuditCount(
  tenant: Tenant,
  journalId: string,
): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs
      WHERE tenant_id = $1
        AND event->>'action' LIKE '%accounting.journal.late_adjusted'
        AND event::text LIKE '%' || $2 || '%'`,
    [tenant.id, journalId],
  );
  return Number(rows[0]!.n);
}

async function markerExists(tenant: Tenant, code: string): Promise<boolean> {
  const { rowCount } = await owner.query(
    "SELECT 1 FROM uoms WHERE tenant_id = $1 AND code = $2",
    [tenant.id, code],
  );
  return (rowCount ?? 0) === 1;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  shared = await makeTenant();
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  // Journals, parked rows and tenants stay (append-only, random names).
  await owner.end();
});

// ============================================================================

describe("F19 order.paid posts the sale per tender", () => {
  const cashSale: SaleAmounts = {
    grossSalesIdr: 100_000,
    discountIdr: 10_000,
    serviceChargeIdr: 5_000,
    pbjtIdr: 9_500,
    roundingIdr: 500,
    tenders: [{ method: "cash", amountIdr: 105_000 }],
  };

  it("AJ-ORDER-01 a cash sale posts Dr cash + discount / Cr revenue, service charge, tax, rounding, balanced", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    const result = await post(world, orderPaid(world, orderUlid, cashSale));

    expect(result.entryDate).toBe("2026-10-15");
    expect(result.lateAdjustmentFrom).toBeNull();
    const entry = await entryOf(world, result.journalEntryId);
    expect(entry.outlet_id).toBe(world.outletId);
    expect(entry.late_adjustment_from).toBeNull();
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "cash_on_hand", debit: 105_000, credit: 0 },
      { role: "rounding", debit: 0, credit: 500 },
      { role: "sales_discount", debit: 10_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "service_charge", debit: 0, credit: 5_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 9_500 },
    ]);
    await expectBalanced(world, result.journalEntryId);
  });

  it("AJ-ORDER-02 a mixed sale: cash, EDC, gateway with an intent (customer_deposit) and gateway without an intent (gateway_clearing)", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    const intentId = await seedIntent(world, { amountIdr: 40_000 });
    const sale: SaleAmounts = {
      grossSalesIdr: 100_000,
      discountIdr: 10_000,
      serviceChargeIdr: 5_000,
      pbjtIdr: 10_000,
      tenders: [
        { method: "cash", amountIdr: 20_000 },
        { method: "edc_card", amountIdr: 25_000 },
        { method: "qris", amountIdr: 40_000, intentId },
        { method: "qris", amountIdr: 20_000 },
      ],
    };
    await seedPosOrder(world, orderUlid, sale);

    const result = await post(world, orderPaid(world, orderUlid, sale));
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "cash_on_hand", debit: 20_000, credit: 0 },
      { role: "customer_deposit", debit: 40_000, credit: 0 },
      { role: "edc_clearing", debit: 25_000, credit: 0 },
      { role: "gateway_clearing", debit: 20_000, credit: 0 },
      { role: "sales_discount", debit: 10_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "service_charge", debit: 0, credit: 5_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
    ]);
    await expectBalanced(world, result.journalEntryId);
  });

  it("AJ-ORDER-03 a gateway sale: the receipt (payment.paid) then the sale net customer_deposit to 0 and leave the money in gateway_clearing", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    const intentId = await seedIntent(world, { amountIdr: 110_000 });
    const sale: SaleAmounts = {
      grossSalesIdr: 100_000,
      pbjtIdr: 10_000,
      tenders: [{ method: "qris", amountIdr: 110_000, intentId }],
    };
    await seedPosOrder(world, orderUlid, sale);

    await post(world, paymentPaid(world, intentId, 110_000));
    await post(world, orderPaid(world, orderUlid, sale));

    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await balanceOf(world, "gateway_clearing")).toBe(110_000);
    expect(await balanceOf(world, "sales_revenue")).toBe(-100_000);
    expect(await balanceOf(world, "tax_payable_pbjt")).toBe(-10_000);
  });

  it("AJ-ORDER-04 replaying order.paid posts nothing more", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    const event = orderPaid(world, orderUlid, cashSale);

    const first = await post(world, event);
    expect(await deliver(world.tenant, event)).toEqual({
      status: "already_posted",
      journalEntryId: first.journalEntryId,
    });
    // A re-sent envelope of the same sale (new event id) is the same business fact.
    expect(
      await deliver(world.tenant, orderPaid(world, orderUlid, cashSale)),
    ).toEqual({
      status: "already_posted",
      journalEntryId: first.journalEntryId,
    });
    expect(await journalCount(world)).toBe(1);
  });
});

describe("F19 order.refunded mirrors the sale", () => {
  it("AJ-REFUND-01 a refund of cash + gateway: Dr revenue, tax / Cr cash and customer_deposit (owed until payout), balanced; replay no-op", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    const event = orderRefunded(world, orderUlid, createUlid(), {
      grossSalesIdr: 50_000,
      pbjtIdr: 5_000,
      lines: [
        { method: "cash", amountIdr: 20_000 },
        { method: "qris", amountIdr: 35_000 },
      ],
    });

    const result = await post(world, event);
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "cash_on_hand", debit: 0, credit: 20_000 },
      { role: "customer_deposit", debit: 0, credit: 35_000 },
      { role: "sales_revenue", debit: 50_000, credit: 0 },
      { role: "tax_payable_pbjt", debit: 5_000, credit: 0 },
    ]);
    await expectBalanced(world, result.journalEntryId);
    expect((await entryOf(world, result.journalEntryId)).source_type).toBe(
      "refund",
    );

    expect(await deliver(world.tenant, event)).toEqual({
      status: "already_posted",
      journalEntryId: result.journalEntryId,
    });
    expect(await journalCount(world)).toBe(1);
  });
});

describe("F19 payment.paid books the gateway receipt", () => {
  it("AJ-PAY-01 posts Dr gateway_clearing / Cr customer_deposit (source customer_deposit) on the paid day", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, { amountIdr: 144_375 });

    const result = await post(world, paymentPaid(world, intentId, 144_375));
    expect(result.entryDate).toBe("2026-10-15");
    expect(result.lateAdjustmentFrom).toBeNull();
    const entry = await entryOf(world, result.journalEntryId);
    expect(entry.source_type).toBe("customer_deposit");
    expect(entry.outlet_id).toBe(world.outletId);
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 0, credit: 144_375 },
      { role: "gateway_clearing", debit: 144_375, credit: 0 },
    ]);
  });

  it("AJ-PAY-02 replaying the same event is a no-op; a second payment of the same intent is a new money arrival and posts again", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, { amountIdr: 50_000 });
    const event = paymentPaid(world, intentId, 50_000);

    const first = await post(world, event);
    expect(await deliver(world.tenant, event)).toEqual({
      status: "already_posted",
      journalEntryId: first.journalEntryId,
    });
    expect(await journalCount(world)).toBe(1);

    // Double payment: another payment.paid event for the same intent.
    const second = await post(world, paymentPaid(world, intentId, 50_000));
    expect(second.journalEntryId).not.toBe(first.journalEntryId);
    expect(await journalCount(world)).toBe(2);
    expect(await balanceOf(world, "customer_deposit")).toBe(-100_000);
  });

  it("AJ-PAY-03 an EDC-linked intent posts nothing (EDC money settles through edc_clearing)", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, {
      amountIdr: 75_000,
      edcTransactionId: randomUUID(),
    });

    expect(
      await deliver(world.tenant, paymentPaid(world, intentId, 75_000)),
    ).toEqual({ status: "ignored" });
    expect(await journalCount(world)).toBe(0);
  });
});

describe("F19 down payment (DP) money", () => {
  it("AJ-DP-01 a DP payment (intent of a reservation) credits customer_deposit", async () => {
    const world = await makeWorld();
    const reservationId = randomUUID();
    const intentId = await seedIntent(world, {
      amountIdr: 200_000,
      reservationId,
    });

    const result = await post(
      world,
      paymentPaid(world, intentId, 200_000, { payload: { reservationId } }),
    );
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 0, credit: 200_000 },
      { role: "gateway_clearing", debit: 200_000, credit: 0 },
    ]);
    expect(await balanceOf(world, "customer_deposit")).toBe(-200_000);
  });

  it("AJ-DP-02 a DP refund payout pays customer_deposit back out of gateway_clearing; partial then rest bring both to 0", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, {
      amountIdr: 200_000,
      reservationId: randomUUID(),
    });
    await post(world, paymentPaid(world, intentId, 200_000));

    const firstRefund = await seedRefund(world, intentId, 80_000);
    const payout = await post(
      world,
      paymentRefunded(world, firstRefund, intentId, 80_000),
    );
    expect(await linesOf(world, payout.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 80_000, credit: 0 },
      { role: "gateway_clearing", debit: 0, credit: 80_000 },
    ]);
    expect((await entryOf(world, payout.journalEntryId)).source_type).toBe(
      "refund",
    );
    expect(await balanceOf(world, "customer_deposit")).toBe(-120_000);

    const secondRefund = await seedRefund(world, intentId, 120_000);
    const event = paymentRefunded(world, secondRefund, intentId, 120_000);
    const rest = await post(world, event);
    expect(await balanceOf(world, "gateway_clearing")).toBe(0);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);

    // Replay of a payout is a no-op.
    expect(await deliver(world.tenant, event)).toEqual({
      status: "already_posted",
      journalEntryId: rest.journalEntryId,
    });
    expect(await journalCount(world)).toBe(3);
  });

  it("AJ-VOID-01 a late payment on a voided order: the receipt and its payout net gateway_clearing and customer_deposit to 0", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, { amountIdr: 90_000 });
    const receipt = paymentPaid(world, intentId, 90_000, {
      late: true,
      payload: { orderId: createUlid() },
    });

    await post(world, receipt);
    expect(await balanceOf(world, "customer_deposit")).toBe(-90_000);
    expect(await balanceOf(world, "gateway_clearing")).toBe(90_000);

    const refundId = await seedRefund(world, intentId, 90_000);
    await post(world, paymentRefunded(world, refundId, intentId, 90_000));
    expect(await balanceOf(world, "gateway_clearing")).toBe(0);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    // No sale was ever booked for the voided order.
    expect(await balanceOf(world, "sales_revenue")).toBe(0);
  });
});

describe("F19 a fact in a closed month rolls to the first open day (late adjustment)", () => {
  it("AJ-LATE-01 a late payment into a closed month posts on 2026-11-01, flagged with its real date, with an audit row; replay stays a no-op", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, { amountIdr: 60_000 });
    await closePeriods(world, ["2026-10"]);
    const event = paymentPaid(world, intentId, 60_000, { late: true });

    const result = await post(world, event);
    expect(result.entryDate).toBe("2026-11-01");
    expect(result.lateAdjustmentFrom).toBe("2026-10-15");
    const entry = await entryOf(world, result.journalEntryId);
    expect(entry.entry_date).toBe("2026-11-01");
    expect(entry.late_adjustment_from).toBe("2026-10-15");
    expect(entry.description).toContain("2026-10-15");
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 0, credit: 60_000 },
      { role: "gateway_clearing", debit: 60_000, credit: 0 },
    ]);
    expect(await lateAuditCount(world.tenant, result.journalEntryId)).toBe(1);

    // The replay does not recompute a different date and does not collide.
    expect(await deliver(world.tenant, event)).toEqual({
      status: "already_posted",
      journalEntryId: result.journalEntryId,
    });
    expect(await journalCount(world)).toBe(1);
    expect(await lateAuditCount(world.tenant, result.journalEntryId)).toBe(1);
  });

  it("AJ-LATE-02 an on-time fact (open month) keeps its own date, no flag, no audit row", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, { amountIdr: 60_000 });
    await closePeriods(world, ["2026-09"]);

    const result = await post(world, paymentPaid(world, intentId, 60_000));
    expect(result.entryDate).toBe("2026-10-15");
    expect(result.lateAdjustmentFrom).toBeNull();
    const entry = await entryOf(world, result.journalEntryId);
    expect(entry.late_adjustment_from).toBeNull();
    expect(await lateAuditCount(world.tenant, result.journalEntryId)).toBe(0);
  });

  it("AJ-LATE-03 several closed months: the entry lands on the first day after the latest closed month, even if that month does not exist yet", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, { amountIdr: 60_000 });
    await closePeriods(world, ["2026-09", "2026-10", "2026-11"]);

    const result = await post(world, paymentPaid(world, intentId, 60_000));
    expect(result.entryDate).toBe("2026-12-01");
    expect(result.lateAdjustmentFrom).toBe("2026-10-15");
    expect((await entryOf(world, result.journalEntryId)).entry_date).toBe(
      "2026-12-01",
    );
  });

  it("AJ-LATE-04 the rule holds for every event of the consumer: a sale paid into a closed month rolls forward too", async () => {
    const world = await makeWorld();
    await closePeriods(world, ["2026-10"]);
    const sale: SaleAmounts = {
      grossSalesIdr: 20_000,
      tenders: [{ method: "cash", amountIdr: 20_000 }],
    };

    const result = await post(world, orderPaid(world, createUlid(), sale));
    expect(result.entryDate).toBe("2026-11-01");
    expect(result.lateAdjustmentFrom).toBe("2026-10-15");
    expect(await lateAuditCount(world.tenant, result.journalEntryId)).toBe(1);
    await expectBalanced(world, result.journalEntryId);
  });
});

describe("F19 a posting that cannot happen is parked, not lost", () => {
  it("AJ-PARK-01 a missing customer_deposit mapping parks the event without throwing; after mapping the sweep posts once and clears the row", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant, { unmapped: ["customer_deposit"] });
    const intentId = await seedIntent(world, { amountIdr: 70_000 });
    const event = paymentPaid(world, intentId, 70_000);

    // The consumer must not poison the surrounding transaction: work before
    // and after it in the same transaction still commits.
    const [before, after] = [`m${short()}`, `m${short()}`];
    const context = contextOf(tenant);
    const result = await withTenant(db, context, async (tx) => {
      await tx.execute(
        sql`INSERT INTO uoms (tenant_id, code, name) VALUES (${tenant.id}, ${before}, ${before})`,
      );
      const outcome = await deliverAutoJournalEvent(context, event, tx, NOW);
      await tx.execute(
        sql`INSERT INTO uoms (tenant_id, code, name) VALUES (${tenant.id}, ${after}, ${after})`,
      );
      return outcome;
    });
    expect(result).toEqual({
      status: "parked",
      code: "ACCOUNT_MAPPING_MISSING",
      retryable: true,
    });
    expect(await markerExists(tenant, before)).toBe(true);
    expect(await markerExists(tenant, after)).toBe(true);
    expect(await journalCount(world)).toBe(0);
    const parked = await parkedOf(tenant, `aj:receipt:${event.id}`);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      error_code: "ACCOUNT_MAPPING_MISSING",
      retryable: true,
      event_name: "payment.paid",
      outlet_id: world.outletId,
    });

    // Still unmapped: the sweep keeps it parked and counts the attempt.
    expect(await sweep(tenant)).toEqual({
      posted: 0,
      stillParked: 1,
      failed: 0,
    });
    expect(await journalCount(world)).toBe(0);
    expect(
      (await parkedOf(tenant, `aj:receipt:${event.id}`))[0]!.attempts,
    ).toBeGreaterThan(1);

    await mapRole(world, "customer_deposit", world.accounts.customer_deposit);
    expect(await sweep(tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    expect(await journalCount(world)).toBe(1);
    expect(await parkedOf(tenant, `aj:receipt:${event.id}`)).toHaveLength(0);
    expect(await balanceOf(world, "customer_deposit")).toBe(-70_000);

    // The event delivered again finds the journal; nothing is re-parked.
    const again = await deliver(tenant, event);
    expect(again.status).toBe("already_posted");
    expect(await journalCount(world)).toBe(1);
    // A second sweep has nothing left.
    expect(await sweep(tenant)).toEqual({
      posted: 0,
      stillParked: 0,
      failed: 0,
    });
  });

  it("AJ-PARK-02 a parked event is posted by its own redelivery once the cause is gone, and its parked row is cleared", async () => {
    const world = await makeWorld(shared, { unmapped: ["gateway_clearing"] });
    const intentId = await seedIntent(world, { amountIdr: 33_000 });
    const event = paymentPaid(world, intentId, 33_000);

    const parked = await deliver(world.tenant, event);
    expect(parked).toEqual({
      status: "parked",
      code: "ACCOUNT_MAPPING_MISSING",
      retryable: true,
    });
    expect(await parkedOf(world.tenant, `aj:receipt:${event.id}`)).toHaveLength(
      1,
    );

    await mapRole(world, "gateway_clearing", world.accounts.gateway_clearing);
    expect((await deliver(world.tenant, event)).status).toBe("posted");
    expect(await journalCount(world)).toBe(1);
    expect(await parkedOf(world.tenant, `aj:receipt:${event.id}`)).toHaveLength(
      0,
    );
  });

  it("AJ-PARK-03 a late fact that is also unmappable keeps its natural date: after mapping, the sweep posts it rolled forward and flagged", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant, { unmapped: ["customer_deposit"] });
    const intentId = await seedIntent(world, { amountIdr: 45_000 });
    await closePeriods(world, ["2026-10"]);
    const event = paymentPaid(world, intentId, 45_000, { late: true });

    expect((await deliver(tenant, event)).status).toBe("parked");
    await mapRole(world, "customer_deposit", world.accounts.customer_deposit);
    expect(await sweep(tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });

    const again = await deliver(tenant, event);
    expect(again.status).toBe("already_posted");
    if (again.status !== "already_posted") return;
    const entry = await entryOf(world, again.journalEntryId);
    expect(entry.entry_date).toBe("2026-11-01");
    expect(entry.late_adjustment_from).toBe("2026-10-15");
    expect(await lateAuditCount(tenant, entry.id)).toBe(1);
  });
});

describe("F19 tenant isolation", () => {
  it("AJ-TENANT-01 the same event id in two tenants posts independently; parked rows and journals are invisible across tenants", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const worldA = await makeWorld(tenantA, { unmapped: ["customer_deposit"] });
    const worldB = await makeWorld(tenantB);
    const intentA = await seedIntent(worldA, { amountIdr: 10_000 });
    const intentB = await seedIntent(worldB, { amountIdr: 10_000 });
    const sharedEventId = createUlid();
    const eventA = paymentPaid(worldA, intentA, 10_000, { id: sharedEventId });
    const eventB = paymentPaid(worldB, intentB, 10_000, { id: sharedEventId });
    const key = `aj:receipt:${sharedEventId}`;

    // A parks (no mapping), B posts: same business key, different tenants.
    expect((await deliver(tenantA, eventA)).status).toBe("parked");
    const postedB = await post(worldB, eventB);

    // Parked table through RLS: A sees its row, B sees none.
    const countParked = (tenant: Tenant) =>
      withTenant(db, contextOf(tenant), async (tx) => {
        const result = await tx.execute(
          sql`SELECT count(*)::int AS n FROM auto_journal_parked WHERE idempotency_key = ${key}`,
        );
        return Number((result.rows[0] as { n: number }).n);
      });
    expect(await countParked(tenantA)).toBe(1);
    expect(await countParked(tenantB)).toBe(0);

    // Journals through RLS: B's journal is invisible to A and the reverse.
    const journalVisible = (tenant: Tenant, entryId: string) =>
      withTenant(db, contextOf(tenant), async (tx) => {
        const result = await tx.execute(
          sql`SELECT count(*)::int AS n FROM journal_entries WHERE id = ${entryId}`,
        );
        return Number((result.rows[0] as { n: number }).n);
      });
    expect(await journalVisible(tenantB, postedB.journalEntryId)).toBe(1);
    expect(await journalVisible(tenantA, postedB.journalEntryId)).toBe(0);

    // A's mapping appears. B's sweep must not touch A's parked row.
    await mapRole(worldA, "customer_deposit", worldA.accounts.customer_deposit);
    expect(await sweep(tenantB)).toEqual({
      posted: 0,
      stillParked: 0,
      failed: 0,
    });
    expect(await journalCount(worldA)).toBe(0);
    expect(await parkedOf(tenantA, key)).toHaveLength(1);

    // A's own sweep posts it; B's journal count is unchanged.
    expect(await sweep(tenantA)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    expect(await journalCount(worldA)).toBe(1);
    expect(await journalCount(worldB)).toBe(1);
    expect(await parkedOf(tenantA, key)).toHaveLength(0);
  });

  it("AJ-TENANT-02 an event naming another tenant's outlet posts nothing in the delivering tenant", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const worldB = await makeWorld(tenantB);
    const intentB = await seedIntent(worldB, { amountIdr: 12_000 });
    const foreign = paymentPaid(worldB, intentB, 12_000);

    // Delivered under tenant A's context: tenant B's outlet is not visible,
    // so nothing is posted in either tenant (parked or errored is fine).
    const outcome = await deliver(tenantA, foreign).catch(() => null);
    if (outcome !== null) expect(outcome.status).not.toBe("posted");
    expect(await journalCount(worldB)).toBe(0);
  });
});

describe("F19 the accounting module gate and unhandled events", () => {
  it("AJ-MODULE-01 with accounting off the delivery and the sweep ignore the tenant and write nothing; switched on again they post", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant, { unmapped: ["customer_deposit"] });
    const intentParked = await seedIntent(world, { amountIdr: 11_000 });
    const parkedEvent = paymentPaid(world, intentParked, 11_000);
    expect((await deliver(tenant, parkedEvent)).status).toBe("parked");
    await mapRole(world, "customer_deposit", world.accounts.customer_deposit);
    const intentFresh = await seedIntent(world, { amountIdr: 22_000 });
    const freshEvent = paymentPaid(world, intentFresh, 22_000);
    const parkedKey = `aj:receipt:${parkedEvent.id}`;
    const attempts = (await parkedOf(tenant, parkedKey))[0]!.attempts;

    await setModules(tenant, FLAGS_OFF);
    try {
      expect(await deliver(tenant, freshEvent)).toEqual({ status: "ignored" });
      expect(await sweep(tenant)).toEqual({
        posted: 0,
        stillParked: 0,
        failed: 0,
      });
      expect(await journalCount(world)).toBe(0);
      expect(
        await parkedOf(tenant, `aj:receipt:${freshEvent.id}`),
      ).toHaveLength(0);
      // The sweep skipped the tenant: the parked row is untouched.
      const untouched = await parkedOf(tenant, parkedKey);
      expect(untouched).toHaveLength(1);
      expect(untouched[0]!.attempts).toBe(attempts);
    } finally {
      await setModules(tenant, FLAGS_ON);
    }

    expect((await deliver(tenant, freshEvent)).status).toBe("posted");
    expect(await sweep(tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    expect(await journalCount(world)).toBe(2);
    expect(await parkedOf(tenant, parkedKey)).toHaveLength(0);
  });

  it("AJ-IGNORE-01 events outside slice 1 are ignored and write nothing", async () => {
    const world = await makeWorld();
    const voided = envelope(world, {
      name: "order.voided",
      aggregateType: "order",
      aggregateId: createUlid(),
      occurredAt: DAY,
      payload: {},
    });
    const dayClosed = envelope(world, {
      name: "day.closed",
      aggregateType: "day",
      aggregateId: randomUUID(),
      occurredAt: DAY,
      payload: {},
    });

    expect(await deliver(world.tenant, voided)).toEqual({ status: "ignored" });
    expect(await deliver(world.tenant, dayClosed)).toEqual({
      status: "ignored",
    });
    expect(await journalCount(world)).toBe(0);
  });
});
