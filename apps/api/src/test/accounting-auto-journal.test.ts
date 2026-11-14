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
//   (`aj:receipt:<intentId>`, `aj:receipt-fund:<unallocatedFundId>`,
//   `aj:sale:<orderId>`, ...) are only used to find parked rows (design
//   section 4, fix wave F2: receipts are keyed by the money, not by the event).
// - A deterministic non-accounting failure (bad payload, EDC-linked gateway
//   tender) parks as non-retryable `AUTO_JOURNAL_PAYLOAD_INVALID` and never
//   throws; those parked rows are found by tenant + error code (+ outlet).
// - A gateway tender counts as customer_deposit (Dr) on order.paid only when
//   its intent's receipt exists (journal) or is parked; otherwise it is
//   gateway_clearing (cutover: pre-cutover intents never booked a receipt).
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
// - Slice 4 (settlement + MDR): the payloads are synthetic
//   (`settlement.reconciled` {settlementId, provider, outletId, settledOn,
//   grossIdr, feeIdr, netSettledIdr}; `edc_transaction.settled` with
//   settlementBatchId + terminalId). The journal's entry date is `settledOn`
//   exactly (a business date, never derived from the event instant, so the
//   envelope's occurredAt is deliberately a different day/instant). A
//   gross != net + fee payload parks non-retryable AUTO_JOURNAL_PAYLOAD_INVALID
//   and is found by error code (+ outlet), not by key. The parked key of a
//   mapping failure is `aj:settlement:<settlementId>`.
// - Slice 2: order.paid carries `paidDepositIdr` (the reservation DP applied,
//   equal to `orders.deposit_applied_idr`); the DP is found through
//   `reservation_deposit_allocations` of the order's table session and its
//   intents (`payment_intents.reservation_id`). reservation.cancelled /
//   reservation.no_show read the closed reservation row, cashier_shift.closed
//   the closed shift row; those rows are seeded with raw SQL.

import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createUlid,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  edcTransactionSettledPayloadSchema,
  settlementReconciledPayloadSchema,
} from "@starter/shared/payment";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { lockIntentsForFact } from "../services/payment-refund-fact-time.ts";
import { reverseJournal } from "../services/accounting-journal.service.ts";
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
  | "deposit_forfeit_income"
  | "cash_over_short"
  | "bank"
  | "gateway_fee_expense";

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
  ["cash_over_short", "6108", "Selisih Kas", "expense", "operating_expense"],
  ["bank", "1103", "Bank Operasional", "asset", "current_asset"],
  [
    "gateway_fee_expense",
    "6109",
    "Biaya Gateway (MDR)",
    "expense",
    "operating_expense",
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
  options: { unmapped?: Role[]; cutoff?: string } = {},
): Promise<World> {
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenant.id, `Entity AJ ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet AJ', 'Jl. AJ', 'Asia/Jakarta', $6, '{}', 'active')`,
    [
      outletId,
      tenant.id,
      tenant.brandId,
      entity,
      `AJ-${short()}`.toUpperCase(),
      options.cutoff ?? "04:00",
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
      `UPDATE fiscal_periods SET status = 'closed', closed_by = $3, closed_at = now(), version = version + 1
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $4`,
      [world.tenant.id, world.entity, randomUUID(), period],
    );
}

// ---- seeding: payment intents, refunds, POS orders -------------------------

type IntentOptions = {
  amountIdr: number;
  reservationId?: string;
  edcTransactionId?: string;
  /** Default "paid". An "expired" intent has no paid_at (money may still arrive). */
  status?: "paid" | "expired" | "refunded";
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
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, $10, $7,
             '{"method":"qris","qrPayload":"test","issuer":null}', now(), $8, $9)`,
    [
      intentId,
      world.tenant.id,
      world.outletId,
      linkId,
      options.amountIdr,
      `aj-${intentId}`,
      options.status === "expired" ? null : DAY,
      options.reservationId ?? null,
      options.edcTransactionId ?? null,
      options.status ?? "paid",
    ],
  );
  return intentId;
}

/** Money that arrived on an intent but belongs to no bill (PAY-04). */
async function seedFund(
  world: World,
  intentId: string,
  amountIdr: number,
  reason: "overpayment" | "double_payment" = "double_payment",
): Promise<string> {
  const fundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [fundId, world.tenant.id, world.outletId, intentId, amountIdr, reason],
  );
  return fundId;
}

/** A completed gateway refund (payout done) of an intent or of one of its funds. */
async function seedRefund(
  world: World,
  intentId: string,
  amountIdr: number,
  unallocatedFundId?: string,
  completedAt: string = REFUND_DAY,
  fixedId?: string,
): Promise<string> {
  const refundId = fixedId ?? randomUUID();
  await owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, completed_at, unallocated_fund_id)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian dana', 'completed', 'requester', 'approver', $6, $6, $7)`,
    [
      refundId,
      world.tenant.id,
      world.outletId,
      intentId,
      amountIdr,
      completedAt,
      unallocatedFundId ?? null,
    ],
  );
  return refundId;
}

type TenderMethod = "cash" | "qris" | "edc_card" | "points";
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
  /** Reservation DP applied (order.paid paidDepositIdr); tenders pay the rest. */
  depositIdr?: number;
  /** Table session the DP is credited to. */
  tableSessionId?: string;
  /** Loyalty points redeemed (order.paid paidPointsIdr); tenders pay the rest. */
  pointsIdr?: number;
  /** pos_orders.completed_at (default now()); the row is immutable afterwards. */
  completedAt?: string;
  tenders: Tender[];
};

const bucketOf = (method: TenderMethod) =>
  method === "cash"
    ? "paidCashIdr"
    : method === "qris"
      ? "paidGatewayIdr"
      : method === "points"
        ? "paidPointsIdr"
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
          status, business_date, placed_at, deposit_applied_idr, table_session_id)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, $6, $7, $8, $9, $10,
               'completed', '2026-10-15', now(), $11, $12)`,
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
        sale.depositIdr ?? 0,
        sale.tableSessionId ?? null,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', now(), COALESCE($4::timestamptz, now()))`,
      [orderId, world.tenant.id, world.outletId, sale.completedAt ?? null],
    );
    for (const tender of sale.tenders) {
      const cash = tender.method === "cash";
      await client.query(
        `INSERT INTO pos_order_tenders
           (tenant_id, outlet_id, order_id, method, provider, payment_intent_id, amount_idr,
            received_idr, change_idr, points_used, status, requested_at, resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'captured', now(), now())`,
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
          tender.method === "points" ? tender.amountIdr : null,
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

/**
 * `payment.funds_unallocated`: money that arrived with no payment.paid (an
 * expired/failed/cancelled intent, or a second payment on a paid intent).
 * The aggregate is the fund (design fix wave F1).
 */
function fundsUnallocated(
  world: World,
  fundId: string,
  intentId: string,
  receivedIdr: number,
  extra: { id?: string; receivedAt?: string; reason?: string } = {},
): EventEnvelope {
  const receivedAt = extra.receivedAt ?? DAY;
  return envelope(world, {
    ...(extra.id === undefined ? {} : { id: extra.id }),
    name: "payment.funds_unallocated",
    aggregateType: "payment",
    aggregateId: fundId,
    occurredAt: receivedAt,
    payload: {
      unallocatedFundId: fundId,
      intentId,
      method: "qris",
      provider: "doit",
      receivedIdr,
      receivedAt,
      reason: extra.reason ?? "double_payment",
    },
  });
}

function paymentRefunded(
  world: World,
  refundId: string,
  intentId: string,
  amountIdr: number,
  unallocatedFundId?: string,
): EventEnvelope {
  return envelope(world, {
    name: "payment.refunded",
    aggregateType: "payment",
    aggregateId: refundId,
    occurredAt: REFUND_DAY,
    payload: {
      refundId,
      paymentIntentId: intentId,
      amountIdr,
      ...(unallocatedFundId === undefined ? {} : { unallocatedFundId }),
    },
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
      paidPointsIdr: sale.pointsIdr ?? 0,
      ...(sale.depositIdr === undefined
        ? {}
        : { paidDepositIdr: sale.depositIdr }),
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

// ---- slice 2 seeding: reservation DP, table session, cashier shift ---------

/** An open table session (zone + table) the DP of a reservation is credited to. */
async function seedSession(world: World): Promise<string> {
  const zoneId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();
  await asTenant(world.tenant, async (client) => {
    await client.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours)
       VALUES ($1, $2, $3, $4, 'pay_first', '[]')`,
      [zoneId, world.tenant.id, world.outletId, `Zona AJ ${short()}`],
    );
    await client.query(
      `INSERT INTO tables (id, tenant_id, outlet_id, zone_id, code, capacity, type, layout)
       VALUES ($1, $2, $3, $4, $5, 4, 'regular', '{}')`,
      [
        tableId,
        world.tenant.id,
        world.outletId,
        zoneId,
        `T${short()}`.toUpperCase(),
      ],
    );
    await client.query(
      `INSERT INTO table_sessions (id, tenant_id, outlet_id, table_id, pax, payment_mode, status,
         session_token_hash, session_token_sealed)
       VALUES ($1, $2, $3, $4, 2, 'pay_first', 'open', $5, 'sealed')`,
      [
        sessionId,
        world.tenant.id,
        world.outletId,
        tableId,
        randomBytes(32).toString("hex"),
      ],
    );
  });
  return sessionId;
}

type ReservationRow = {
  id: string;
  status: "seated" | "cancelled" | "no_show";
  depositIdr: number;
  depositPaymentId: string;
  tableSessionId?: string;
  refundIdr?: number;
  forfeitedIdr?: number;
};

async function seedReservation(
  world: World,
  row: ReservationRow,
): Promise<void> {
  const closed = row.status !== "seated";
  await asTenant(world.tenant, (client) =>
    client.query(
      `INSERT INTO reservations
         (id, tenant_id, outlet_id, guest_name, reserved_for, duration_minutes, pax, deposit_idr,
          deposit_payment_id, policy_snapshot, status, source, seated_at, table_session_id,
          closed_at, deposit_refund_idr, deposit_forfeited_idr)
       VALUES ($1, $2, $3, 'Tamu AJ', $4, 90, 2, $5, $6, '{}', $7, 'staff', $8, $9, $10, $11, $12)`,
      [
        row.id,
        world.tenant.id,
        world.outletId,
        DAY,
        row.depositIdr,
        row.depositPaymentId,
        row.status,
        closed ? null : DAY,
        row.tableSessionId ?? null,
        closed ? DAY : null,
        closed ? (row.refundIdr ?? 0) : null,
        closed ? (row.forfeitedIdr ?? 0) : null,
      ],
    ),
  );
}

/**
 * A seated reservation whose paid DP is credited to a table session (RSV-02
 * allocation): a fresh one, or `sharedSessionId` for a second reservation on
 * the same bill. Extra DP intents of the same reservation are optional.
 */
async function seedSeatedDeposit(
  world: World,
  depositIdr: number,
  sharedSessionId?: string,
): Promise<{ reservationId: string; sessionId: string; intentId: string }> {
  const reservationId = randomUUID();
  const intentId = await seedIntent(world, {
    amountIdr: depositIdr,
    reservationId,
  });
  const sessionId = sharedSessionId ?? (await seedSession(world));
  await seedReservation(world, {
    id: reservationId,
    status: "seated",
    depositIdr,
    depositPaymentId: intentId,
    tableSessionId: sessionId,
  });
  await asTenant(world.tenant, (client) =>
    client.query(
      `INSERT INTO reservation_deposit_allocations
         (tenant_id, outlet_id, reservation_id, table_session_id, payment_intent_id, amount_idr)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        world.tenant.id,
        world.outletId,
        reservationId,
        sessionId,
        intentId,
        depositIdr,
      ],
    ),
  );
  return { reservationId, sessionId, intentId };
}

/** A cancelled / no-show reservation with its DP intent and stored split. */
async function seedClosedReservation(
  world: World,
  input: {
    kind: "cancelled" | "no_show";
    paidIdr: number;
    forfeitedIdr: number;
  },
): Promise<{ reservationId: string; intentId: string }> {
  const reservationId = randomUUID();
  const intentId = await seedIntent(world, {
    amountIdr: input.paidIdr,
    reservationId,
  });
  await seedReservation(world, {
    id: reservationId,
    status: input.kind,
    depositIdr: input.paidIdr,
    depositPaymentId: intentId,
    refundIdr: input.paidIdr - input.forfeitedIdr,
    forfeitedIdr: input.forfeitedIdr,
  });
  return { reservationId, intentId };
}

function reservationClosed(
  world: World,
  reservationId: string,
  kind: "cancelled" | "no_show",
  deposit: { paidIdr: number; forfeitedIdr: number },
  extra: { id?: string; occurredAt?: string } = {},
): EventEnvelope {
  return envelope(world, {
    ...(extra.id === undefined ? {} : { id: extra.id }),
    name: `reservation.${kind}`,
    aggregateType: "reservation",
    aggregateId: reservationId,
    occurredAt: extra.occurredAt ?? DAY,
    payload: {
      reservationId,
      closedBy: "staff",
      reason: "Tamu tidak datang.",
      depositPaidIdr: deposit.paidIdr,
      depositRefundIdr: deposit.paidIdr - deposit.forfeitedIdr,
      depositForfeitedIdr: deposit.forfeitedIdr,
      policyVersion: "v1",
    },
  });
}

const SHIFT_FLOAT_IDR = 500_000;

async function seedUser(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [id, "Kasir AJ", `${id}@example.com`],
  );
  return id;
}

/**
 * A closed shift with no movement: expected = opening float, variance =
 * counted - expected (the closed-check and the count guard of 0089 hold).
 */
async function seedClosedShift(
  world: World,
  countedIdr: number,
): Promise<string> {
  const cashierId = await seedUser();
  const approverId = await seedUser();
  const shiftId = randomUUID();
  const countId = randomUUID();
  const varianceIdr = countedIdr - SHIFT_FLOAT_IDR;
  await asTenant(world.tenant, async (client) => {
    await client.query(
      `INSERT INTO pos_shifts
         (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
          opened_at, opening_float_idr, open_key, open_fingerprint)
       VALUES ($1, $2, $3, $4, $5, '2026-10-15', 'open', $6, $7, $8, $9)`,
      [
        shiftId,
        world.tenant.id,
        world.outletId,
        randomUUID(),
        cashierId,
        DAY,
        SHIFT_FLOAT_IDR,
        randomUUID(),
        "a".repeat(64),
      ],
    );
    await client.query(
      `INSERT INTO pos_shift_counts
         (id, tenant_id, outlet_id, shift_id, sequence, counts, counts_fingerprint,
          counted_idr, expected_idr, variance_idr, submitted_by, submitted_at, forced,
          idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, 1, '[]'::jsonb, $5, $6, $7, $8, $9, now(), false, $10, $5)`,
      [
        countId,
        world.tenant.id,
        world.outletId,
        shiftId,
        "b".repeat(64),
        countedIdr,
        SHIFT_FLOAT_IDR,
        varianceIdr,
        cashierId,
        randomUUID(),
      ],
    );
    await client.query(
      `UPDATE pos_shifts SET status = 'closed', expected_idr = $3, counted_idr = $4,
          variance_idr = $5, variance_note = $6, counts = '[]'::jsonb, count_id = $7,
          approved_by = $8, approval_request_id = $9, approval_override_id = $10,
          approved_at = $11, closed_at = $11, closed_by = $12, close_key = $13,
          close_fingerprint = $14, version = version + 1
        WHERE tenant_id = $1 AND id = $2`,
      [
        world.tenant.id,
        shiftId,
        SHIFT_FLOAT_IDR,
        countedIdr,
        varianceIdr,
        varianceIdr === 0 ? null : "Selisih hitung",
        countId,
        approverId,
        randomUUID(),
        randomUUID(),
        DAY,
        cashierId,
        randomUUID(),
        "c".repeat(64),
      ],
    );
  });
  return shiftId;
}

function shiftClosed(
  world: World,
  shiftId: string,
  differenceIdr: number,
  extra: { id?: string; closedAt?: string } = {},
): EventEnvelope {
  const closedAt = extra.closedAt ?? DAY;
  return envelope(world, {
    ...(extra.id === undefined ? {} : { id: extra.id }),
    name: "cashier_shift.closed",
    aggregateType: "cashier_shift",
    aggregateId: shiftId,
    occurredAt: closedAt,
    payload: {
      shiftId,
      outletId: world.outletId,
      deviceId: randomUUID(),
      cashierId: randomUUID(),
      businessDate: "2026-10-15",
      openingFloatIdr: SHIFT_FLOAT_IDR,
      cashSalesIdr: 0,
      cashRefundsIdr: 0,
      cashInIdr: 0,
      cashOutIdr: 0,
      cashDropIdr: 0,
      expectedIdr: SHIFT_FLOAT_IDR,
      countedIdr: SHIFT_FLOAT_IDR + differenceIdr,
      differenceIdr,
      varianceNote: differenceIdr === 0 ? null : "Selisih hitung",
      approvedBy: randomUUID(),
      approvalRequestId: randomUUID(),
      closedAt,
    },
  });
}

/** payment.paid emitted to cloud-sync but not consumed yet (receipt pending). */
async function seedUndeliveredReceipt(
  world: World,
  intentId: string,
  receivedIdr: number,
): Promise<string> {
  const outboxId = randomUUID();
  await owner.query(
    `INSERT INTO domain_event_outbox
       (tenant_id, id, outlet_id, event_id, aggregate_type, aggregate_id, sequence, event, destination)
     VALUES ($1, $2, $3, $4, 'payment', $5, 1, $6, 'cloud-sync')`,
    [
      world.tenant.id,
      outboxId,
      world.outletId,
      randomUUID(),
      intentId,
      JSON.stringify(paymentPaid(world, intentId, receivedIdr)),
    ],
  );
  return outboxId;
}

/**
 * An event of the outbox (the consumer reads it to tell "not consumed yet" from
 * "never emitted"). `aggregateUuid` is the aggregate id as a uuid (ULIDs via
 * ulidToUuid). A "delivered" row stands for an event that was already consumed.
 */
async function seedOutboxEvent(
  world: World,
  event: EventEnvelope,
  aggregateUuid: string,
  status: "pending" | "delivered" = "pending",
): Promise<string> {
  const outboxId = randomUUID();
  await owner.query(
    `INSERT INTO domain_event_outbox
       (tenant_id, id, outlet_id, event_id, aggregate_type, aggregate_id, sequence, event, destination,
        status, delivered_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7, 'cloud-sync', $8, $9)`,
    [
      world.tenant.id,
      outboxId,
      world.outletId,
      randomUUID(),
      event.aggregateType,
      aggregateUuid,
      JSON.stringify(event),
      status,
      status === "delivered" ? DAY : null,
    ],
  );
  return outboxId;
}

async function markDelivered(world: World, outboxId: string): Promise<void> {
  await owner.query(
    "UPDATE domain_event_outbox SET status = 'delivered', delivered_at = now() WHERE tenant_id = $1 AND id = $2",
    [world.tenant.id, outboxId],
  );
}

async function journalIdOf(world: World, key: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2",
    [world.tenant.id, key],
  );
  expect(rows, key).toHaveLength(1);
  return rows[0]!.id;
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

// Each sweep runs an hour after the previous one, past the 10-minute backoff a
// still-parked row gets, so consecutive sweeps in one test see it as due.
let sweepCount = 0;
function sweep(tenant: Tenant) {
  sweepCount += 1;
  return retryParkedAutoJournals(
    contextOf(tenant),
    new Date(SWEEP_AT.getTime() + sweepCount * 60 * 60 * 1000),
  );
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

/** Parked rows of a tenant by error code (optionally one outlet). */
async function parkedByCode(
  tenant: Tenant,
  code: string,
  outletId?: string,
): Promise<Parked[]> {
  return asTenant(tenant, async (client) => {
    const { rows } = await client.query<Parked>(
      `SELECT error_code, retryable, attempts, event_name, outlet_id
         FROM auto_journal_parked
        WHERE tenant_id = $1 AND error_code = $2 AND ($3::uuid IS NULL OR outlet_id = $3)`,
      [tenant.id, code, outletId ?? null],
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
    // The intent's receipt is booked first (cutover guard: only then does the
    // tender settle customer_deposit instead of gateway_clearing).
    await post(world, paymentPaid(world, intentId, 40_000));

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

describe("F19 order.paid cutover guard for gateway tenders with an intent", () => {
  const gatewaySale = (intentId: string): SaleAmounts => ({
    grossSalesIdr: 100_000,
    pbjtIdr: 10_000,
    tenders: [{ method: "qris", amountIdr: 110_000, intentId }],
  });

  it("AJ-CUTOVER-01 a gateway tender whose intent has no receipt (pre-cutover) debits gateway_clearing, not customer_deposit", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    const intentId = await seedIntent(world, { amountIdr: 110_000 });
    const sale = gatewaySale(intentId);
    await seedPosOrder(world, orderUlid, sale);

    // No payment.paid was ever booked for this intent.
    const result = await post(world, orderPaid(world, orderUlid, sale));
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "gateway_clearing", debit: 110_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
    ]);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-CUTOVER-02 a gateway tender whose receipt is parked retryable waits (AUTO_JOURNAL_RECEIPT_PENDING); after mapping the sweep posts the receipt then the sale via customer_deposit", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant, { unmapped: ["gateway_clearing"] });
    const orderUlid = createUlid();
    const intentId = await seedIntent(world, { amountIdr: 110_000 });
    const sale = gatewaySale(intentId);
    await seedPosOrder(world, orderUlid, sale);

    // The receipt cannot post (gateway_clearing unmapped) and is parked.
    expect(
      (await deliver(tenant, paymentPaid(world, intentId, 110_000))).status,
    ).toBe("parked");
    expect(await parkedOf(tenant, `aj:receipt:${intentId}`)).toHaveLength(1);

    // The receipt can still post: the sale waits instead of guessing.
    expect(await deliver(tenant, orderPaid(world, orderUlid, sale))).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_PENDING",
      retryable: true,
    });
    expect(await journalCount(world)).toBe(0);

    await mapRole(world, "gateway_clearing", world.accounts.gateway_clearing);
    // Oldest first, then by key: aj:receipt:... sweeps before aj:sale:...
    expect(await sweep(tenant)).toEqual({
      posted: 2,
      stillParked: 0,
      failed: 0,
    });
    expect(await journalCount(world)).toBe(2);
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2",
      [tenant.id, `aj:sale:${orderUlid}`],
    );
    expect(rows).toHaveLength(1);
    expect(await linesOf(world, rows[0]!.id)).toEqual([
      { role: "customer_deposit", debit: 110_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
    ]);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await balanceOf(world, "gateway_clearing")).toBe(110_000);
  });

  it("AJ-CUTOVER-03 a gateway tender whose intent is EDC-linked fails closed: parked non-retryable AUTO_JOURNAL_PAYLOAD_INVALID, nothing posted, no throw", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const orderUlid = createUlid();
    const intentId = await seedIntent(world, {
      amountIdr: 110_000,
      edcTransactionId: randomUUID(),
    });
    const sale = gatewaySale(intentId);
    await seedPosOrder(world, orderUlid, sale);

    expect(await deliver(tenant, orderPaid(world, orderUlid, sale))).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(0);
    const parked = await parkedByCode(
      tenant,
      "AUTO_JOURNAL_PAYLOAD_INVALID",
      world.outletId,
    );
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      retryable: false,
      event_name: "order.paid",
    });
  });

  it("AJ-CUTOVER-04 order.paid before payment.paid (outbox pending) parks RECEIPT_PENDING, then books the money once", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const orderUlid = createUlid();
    const intentId = await seedIntent(world, { amountIdr: 110_000 });
    const sale = gatewaySale(intentId);
    await seedPosOrder(world, orderUlid, sale);
    // payment.paid is emitted but not consumed yet.
    const outboxId = randomUUID();
    await owner.query(
      `INSERT INTO domain_event_outbox
         (tenant_id, id, outlet_id, event_id, aggregate_type, aggregate_id, sequence, event, destination)
       VALUES ($1, $2, $3, $4, 'payment', $5, 1, $6, 'cloud-sync')`,
      [
        tenant.id,
        outboxId,
        world.outletId,
        randomUUID(),
        intentId,
        JSON.stringify(paymentPaid(world, intentId, 110_000)),
      ],
    );

    expect(await deliver(tenant, orderPaid(world, orderUlid, sale))).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_PENDING",
      retryable: true,
    });
    expect(await journalCount(world)).toBe(0);

    // The receipt is consumed (journal and delivered status commit together).
    await owner.query(
      "UPDATE domain_event_outbox SET status = 'delivered', delivered_at = now() WHERE tenant_id = $1 AND id = $2",
      [tenant.id, outboxId],
    );
    await post(world, paymentPaid(world, intentId, 110_000));

    expect(await sweep(tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2",
      [tenant.id, `aj:sale:${orderUlid}`],
    );
    expect(rows).toHaveLength(1);
    expect(await linesOf(world, rows[0]!.id)).toEqual([
      { role: "customer_deposit", debit: 110_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
    ]);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await balanceOf(world, "gateway_clearing")).toBe(110_000);
  });

  // legend-3r6r: a dead-lettered payment.paid must not park the sale for ever.
  async function deadLetterReceipt(
    world: World,
    outboxId: string,
    ageDays: number,
  ): Promise<void> {
    await owner.query(
      `UPDATE domain_event_outbox
          SET dispatch_state = 'dead',
              dead_lettered_at = now() - make_interval(days => $3)
        WHERE tenant_id = $1 AND id = $2`,
      [world.tenant.id, outboxId, ageDays],
    );
  }

  // Sweeps at a fixed offset from the delivery clock (NOW), independent of the
  // shared hourly sweep counter.
  const sweepAfter = (tenant: Tenant, hours: number) =>
    retryParkedAutoJournals(
      contextOf(tenant),
      new Date(NOW.getTime() + hours * 60 * 60 * 1000),
    );

  it("AJ-3R6R-01 a sale behind a receipt dead-lettered past the bound parks non-retryable AUTO_JOURNAL_RECEIPT_DEAD_LETTERED, books nothing and the sweep leaves it", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const orderUlid = createUlid();
    const intentId = await seedIntent(world, { amountIdr: 110_000 });
    const sale = gatewaySale(intentId);
    await seedPosOrder(world, orderUlid, sale);
    const outboxId = await seedUndeliveredReceipt(world, intentId, 110_000);
    await deadLetterReceipt(world, outboxId, 30);

    expect(await deliver(tenant, orderPaid(world, orderUlid, sale))).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_DEAD_LETTERED",
      retryable: false,
    });
    expect(
      await parkedByCode(
        tenant,
        "AUTO_JOURNAL_RECEIPT_DEAD_LETTERED",
        world.outletId,
      ),
    ).toMatchObject([{ retryable: false, event_name: "order.paid" }]);
    expect(await sweepAfter(tenant, 1)).toEqual({
      posted: 0,
      stillParked: 0,
      failed: 0,
    });
    // No fallback to gateway_clearing: the receipt may still be replayed.
    expect(await journalCount(world)).toBe(0);
    expect(await balanceOf(world, "gateway_clearing")).toBe(0);
  });

  it("AJ-3R6R-02 a receipt dead-lettered only recently still parks RECEIPT_PENDING (retryable)", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const orderUlid = createUlid();
    const intentId = await seedIntent(world, { amountIdr: 110_000 });
    const sale = gatewaySale(intentId);
    await seedPosOrder(world, orderUlid, sale);
    const outboxId = await seedUndeliveredReceipt(world, intentId, 110_000);
    await deadLetterReceipt(world, outboxId, 0);

    expect(await deliver(tenant, orderPaid(world, orderUlid, sale))).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_PENDING",
      retryable: true,
    });
  });

  it("AJ-3R6R-03 once the dead-lettered receipt is replayed and booked, the parked sale is released and books the money once", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const orderUlid = createUlid();
    const intentId = await seedIntent(world, { amountIdr: 110_000 });
    const sale = gatewaySale(intentId);
    await seedPosOrder(world, orderUlid, sale);
    const outboxId = await seedUndeliveredReceipt(world, intentId, 110_000);
    await deadLetterReceipt(world, outboxId, 30);
    expect(await deliver(tenant, orderPaid(world, orderUlid, sale))).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_DEAD_LETTERED",
      retryable: false,
    });

    // Replay: the receipt is consumed (journal and delivered status commit together).
    await markDelivered(world, outboxId);
    await post(world, paymentPaid(world, intentId, 110_000));

    expect(await sweep(tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await balanceOf(world, "gateway_clearing")).toBe(110_000);
  });

  it("AJ-3R6R-04 a dead-lettered event ahead of a ready payment.paid (sequence gate) bounds the sale too", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const orderUlid = createUlid();
    const intentId = await seedIntent(world, { amountIdr: 110_000 });
    const sale = gatewaySale(intentId);
    await seedPosOrder(world, orderUlid, sale);
    // sequence 1: payment.expired, dead for 30 days; sequence 2: payment.paid, ready.
    const paid = paymentPaid(world, intentId, 110_000);
    for (const [sequence, name, state, age] of [
      [1, "payment.expired", "dead", 30],
      [2, "payment.paid", "ready", 0],
    ] as const)
      await owner.query(
        `INSERT INTO domain_event_outbox
           (tenant_id, id, outlet_id, event_id, aggregate_type, aggregate_id, sequence, event, destination,
            dispatch_state, dead_lettered_at)
         VALUES ($1, $2, $3, $4, 'payment', $5, $6, $7, 'cloud-sync', $8::varchar,
                 CASE WHEN $8::text = 'dead' THEN now() - make_interval(days => $9::int) END)`,
        [
          world.tenant.id,
          randomUUID(),
          world.outletId,
          randomUUID(),
          intentId,
          sequence,
          JSON.stringify({ ...paid, name, sequence }),
          state,
          age,
        ],
      );

    expect(await deliver(tenant, orderPaid(world, orderUlid, sale))).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_DEAD_LETTERED",
      retryable: false,
    });
  });

  it("AJ-3R6R-05 the daily recheck of a DEAD_LETTERED row books the sale the plain way when the receipt will never post", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const orderUlid = createUlid();
    const intentId = await seedIntent(world, { amountIdr: 110_000 });
    const sale = gatewaySale(intentId);
    await seedPosOrder(world, orderUlid, sale);
    const outboxId = await seedUndeliveredReceipt(world, intentId, 110_000);
    await deadLetterReceipt(world, outboxId, 30);
    await deliver(tenant, orderPaid(world, orderUlid, sale));
    // Not due yet: the sweep leaves the row.
    expect(await sweepAfter(tenant, 1)).toEqual({
      posted: 0,
      stillParked: 0,
      failed: 0,
    });

    // The replayed receipt was consumed without booking (it will never post).
    await markDelivered(world, outboxId);
    // Past the daily recheck.
    expect(await sweepAfter(tenant, 25)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    expect(await balanceOf(world, "gateway_clearing")).toBe(110_000);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-CUTOVER-05 a receipt parked non-retryable does not hold the sale", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    const intentId = await seedIntent(world, { amountIdr: 110_000 });
    const sale = gatewaySale(intentId);
    await seedPosOrder(world, orderUlid, sale);
    await owner.query(
      `INSERT INTO auto_journal_parked
         (tenant_id, outlet_id, idempotency_key, event_id, event_name, payload, error_code,
          retryable, first_failed_at, last_failed_at, next_retry_at)
       VALUES ($1, $2, $3, $4, 'payment.paid', '{}', 'AUTO_JOURNAL_PAYLOAD_INVALID',
               false, now(), now(), NULL)`,
      [world.tenant.id, world.outletId, `aj:receipt:${intentId}`, createUlid()],
    );

    // The receipt never posts by itself: the sale books the money once.
    const result = await post(world, orderPaid(world, orderUlid, sale));
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "gateway_clearing", debit: 110_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
    ]);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });
});

describe("F19 a deterministic bad event parks instead of throwing", () => {
  it("AJ-INVALID-01 a payload that fails validation parks non-retryable AUTO_JOURNAL_PAYLOAD_INVALID, does not throw and leaves the surrounding transaction usable", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const bad = paymentPaid(world, randomUUID(), 10_000, {
      payload: { receivedIdr: "bukan angka", intentId: "bukan-uuid" },
    });

    // A throw here would roll back the caller's transaction (the POS capture).
    const marker = `m${short()}`;
    const context = contextOf(tenant);
    const result = await withTenant(db, context, async (tx) => {
      const outcome = await deliverAutoJournalEvent(context, bad, tx, NOW);
      await tx.execute(
        sql`INSERT INTO uoms (tenant_id, code, name) VALUES (${tenant.id}, ${marker}, ${marker})`,
      );
      return outcome;
    });
    expect(result).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      retryable: false,
    });
    expect(await markerExists(tenant, marker)).toBe(true);
    expect(await journalCount(world)).toBe(0);
    expect(
      await parkedByCode(tenant, "AUTO_JOURNAL_PAYLOAD_INVALID"),
    ).toMatchObject([{ retryable: false, event_name: "payment.paid" }]);
  });
});

describe("F19 order.refunded mirrors the sale", () => {
  // legend-ni6o: the refund mirrors a sale journal, so the sale journal
  // (`aj:sale:<orderId>`) has to be posted first; the tests below deliver it.
  const refundedSale: SaleAmounts = {
    grossSalesIdr: 50_000,
    pbjtIdr: 5_000,
    tenders: [
      { method: "cash", amountIdr: 20_000 },
      { method: "qris", amountIdr: 35_000 },
    ],
  };
  const refundedLines = {
    grossSalesIdr: 50_000,
    pbjtIdr: 5_000,
    lines: [
      { method: "cash" as const, amountIdr: 20_000 },
      { method: "qris" as const, amountIdr: 35_000 },
    ],
  };

  it("AJ-REFUND-01 a refund of cash + gateway: Dr revenue, tax / Cr cash and gateway_clearing (no payment refund row: nothing to pay out later), balanced; replay no-op", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, refundedSale);
    await post(world, orderPaid(world, orderUlid, refundedSale));
    const event = orderRefunded(world, orderUlid, createUlid(), refundedLines);

    const result = await post(world, event);
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "cash_on_hand", debit: 0, credit: 20_000 },
      { role: "gateway_clearing", debit: 0, credit: 35_000 },
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
    // sale + refund
    expect(await journalCount(world)).toBe(2);
  });

  it("AJ-REFUND-N1 a refund that arrives before its sale was consumed parks AUTO_JOURNAL_SALE_PENDING (retryable, no journal); after order.paid the sweep posts it and the parked row is gone", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, refundedSale);
    const saleEvent = orderPaid(world, orderUlid, refundedSale);
    const outboxId = await seedOutboxEvent(
      world,
      saleEvent,
      ulidToUuid(orderUlid),
      "pending",
    );
    const refundId = createUlid();
    const refundKey = `aj:order-refund:${refundId}`;

    expect(
      await deliver(
        tenant,
        orderRefunded(world, orderUlid, refundId, refundedLines),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_SALE_PENDING",
      retryable: true,
    });
    expect(await journalCount(world)).toBe(0);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await parkedOf(tenant, refundKey)).toMatchObject([
      { retryable: true, event_name: "order.refunded" },
    ]);

    await markDelivered(world, outboxId);
    await post(world, saleEvent);
    expect(await sweep(tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    const refundEntryId = await journalIdOf(world, refundKey);
    expect(await linesOf(world, refundEntryId)).toEqual([
      { role: "cash_on_hand", debit: 0, credit: 20_000 },
      { role: "gateway_clearing", debit: 0, credit: 35_000 },
      { role: "sales_revenue", debit: 50_000, credit: 0 },
      { role: "tax_payable_pbjt", debit: 5_000, credit: 0 },
    ]);
    expect(await parkedOf(tenant, refundKey)).toHaveLength(0);
    // sale + refund
    expect(await journalCount(world)).toBe(2);
  });

  it("AJ-REFUND-N2 a gateway refund of a sale parked POSTING_AMOUNTS_MISMATCH parks non-retryable AUTO_JOURNAL_SALE_MISSING; no refund journal, customer_deposit unchanged, the sweep leaves it", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const intentId = await seedIntent(world, { amountIdr: 50_000 });
    await post(world, paymentPaid(world, intentId, 50_000));
    const orderUlid = createUlid();
    const sale: SaleAmounts = {
      grossSalesIdr: 100_000,
      tenders: [
        { method: "cash", amountIdr: 50_000 },
        { method: "qris", amountIdr: 50_000, intentId },
      ],
    };
    await seedPosOrder(world, orderUlid, sale);
    // The event claims 60k cash + 40k gateway; the tender rows hold 50k + 50k.
    expect(
      await deliver(
        tenant,
        orderPaid(world, orderUlid, {
          ...sale,
          tenders: [
            { method: "cash", amountIdr: 60_000 },
            { method: "qris", amountIdr: 40_000, intentId },
          ],
        }),
      ),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    // only the receipt is booked
    expect(await journalCount(world)).toBe(1);
    const depositBefore = await balanceOf(world, "customer_deposit");
    const refundId = createUlid();

    expect(
      await deliver(
        tenant,
        orderRefunded(world, orderUlid, refundId, {
          grossSalesIdr: 25_000,
          pbjtIdr: 0,
          lines: [{ method: "qris", amountIdr: 25_000 }],
        }),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_SALE_MISSING",
      retryable: false,
    });
    expect(await parkedOf(tenant, `aj:order-refund:${refundId}`)).toMatchObject(
      [{ retryable: false, event_name: "order.refunded" }],
    );
    expect(await journalCount(world)).toBe(1);
    expect(await balanceOf(world, "customer_deposit")).toBe(depositBefore);

    await sweep(tenant);
    expect(await journalCount(world)).toBe(1);
    expect(await balanceOf(world, "customer_deposit")).toBe(depositBefore);
  });

  it("AJ-REFUND-N3 a refund of a posted sale posts as before: Dr revenue / Cr cash, balanced", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    const sale: SaleAmounts = {
      grossSalesIdr: 100_000,
      pbjtIdr: 10_000,
      tenders: [{ method: "cash", amountIdr: 110_000 }],
    };
    await seedPosOrder(world, orderUlid, sale);
    const saleEntry = await post(world, orderPaid(world, orderUlid, sale));

    const refund = await post(
      world,
      orderRefunded(world, orderUlid, createUlid(), {
        grossSalesIdr: 40_000,
        pbjtIdr: 4_000,
        lines: [{ method: "cash", amountIdr: 44_000 }],
      }),
    );
    expect(refund.journalEntryId).not.toBe(saleEntry.journalEntryId);
    expect(await linesOf(world, refund.journalEntryId)).toEqual([
      { role: "cash_on_hand", debit: 0, credit: 44_000 },
      { role: "sales_revenue", debit: 40_000, credit: 0 },
      { role: "tax_payable_pbjt", debit: 4_000, credit: 0 },
    ]);
    await expectBalanced(world, refund.journalEntryId);
    expect(await balanceOf(world, "cash_on_hand")).toBe(66_000);
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

  it("AJ-PAY-02 the receipt is keyed by the intent: the same event, or the same intent under a different event id, posts once", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, { amountIdr: 50_000 });
    const event = paymentPaid(world, intentId, 50_000);

    const first = await post(world, event);
    expect(await deliver(world.tenant, event)).toEqual({
      status: "already_posted",
      journalEntryId: first.journalEntryId,
    });
    // Same intent, new event id (a re-emitted fact): still one receipt.
    expect(
      await deliver(world.tenant, paymentPaid(world, intentId, 50_000)),
    ).toEqual({
      status: "already_posted",
      journalEntryId: first.journalEntryId,
    });
    expect(await journalCount(world)).toBe(1);
    expect(await balanceOf(world, "customer_deposit")).toBe(-50_000);
    expect(await balanceOf(world, "gateway_clearing")).toBe(50_000);
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

describe("F19 payment.funds_unallocated books money that has no payment.paid", () => {
  it("AJ-FUNDS-01 a double payment: the fund receipt then its refund payout net gateway_clearing and customer_deposit to 0", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, { amountIdr: 80_000 });
    await post(world, paymentPaid(world, intentId, 80_000));

    // The guest pays the same bill again: a fund, not a second receipt.
    const fundId = await seedFund(world, intentId, 80_000, "double_payment");
    const receiptEvent = fundsUnallocated(world, fundId, intentId, 80_000);
    // The fund event travelled through the outbox (it is how the payout finds
    // its own receipt, see "Codex 142 repro").
    await seedOutboxEvent(world, receiptEvent, fundId, "delivered");
    const receipt = await post(world, receiptEvent);
    const entry = await entryOf(world, receipt.journalEntryId);
    expect(entry.source_type).toBe("customer_deposit");
    expect(entry.outlet_id).toBe(world.outletId);
    expect(await linesOf(world, receipt.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 0, credit: 80_000 },
      { role: "gateway_clearing", debit: 80_000, credit: 0 },
    ]);
    // Bill receipt + fund receipt: the money is owed twice until paid out.
    expect(await balanceOf(world, "customer_deposit")).toBe(-160_000);
    expect(await balanceOf(world, "gateway_clearing")).toBe(160_000);

    // Replay of the fund event posts nothing more.
    expect(await deliver(world.tenant, receiptEvent)).toEqual({
      status: "already_posted",
      journalEntryId: receipt.journalEntryId,
    });
    expect(await journalCount(world)).toBe(2);

    // The extra payment is refunded: the payout pays the fund back out.
    const refundId = await seedRefund(world, intentId, 80_000, fundId);
    const payout = await post(
      world,
      paymentRefunded(world, refundId, intentId, 80_000, fundId),
    );
    expect(await linesOf(world, payout.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 80_000, credit: 0 },
      { role: "gateway_clearing", debit: 0, credit: 80_000 },
    ]);
    // Only the first (bill) receipt remains: the double payment nets to 0.
    expect(await balanceOf(world, "customer_deposit")).toBe(-80_000);
    expect(await balanceOf(world, "gateway_clearing")).toBe(80_000);
  });

  it("AJ-FUNDS-02 money on an expired intent (no payment.paid ever) is booked as a receipt and paid out to 0", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, {
      amountIdr: 65_000,
      status: "expired",
    });
    const fundId = await seedFund(world, intentId, 65_000, "overpayment");

    const fundEvent = fundsUnallocated(world, fundId, intentId, 65_000, {
      reason: "intent_expired",
    });
    await seedOutboxEvent(world, fundEvent, fundId, "delivered");
    const receipt = await post(world, fundEvent);
    expect(receipt.entryDate).toBe("2026-10-15");
    expect(await linesOf(world, receipt.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 0, credit: 65_000 },
      { role: "gateway_clearing", debit: 65_000, credit: 0 },
    ]);

    const refundId = await seedRefund(world, intentId, 65_000, fundId);
    await post(
      world,
      paymentRefunded(world, refundId, intentId, 65_000, fundId),
    );
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await balanceOf(world, "gateway_clearing")).toBe(0);
  });

  it("AJ-FUNDS-03 two funds of one intent are two receipts (keyed by fund); a fund event under a new event id posts once", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, {
      amountIdr: 30_000,
      status: "expired",
    });
    const fundA = await seedFund(world, intentId, 30_000);
    const fundB = await seedFund(world, intentId, 30_000);

    const first = await post(
      world,
      fundsUnallocated(world, fundA, intentId, 30_000),
    );
    const second = await post(
      world,
      fundsUnallocated(world, fundB, intentId, 30_000),
    );
    expect(second.journalEntryId).not.toBe(first.journalEntryId);
    expect(
      await deliver(
        world.tenant,
        fundsUnallocated(world, fundA, intentId, 30_000),
      ),
    ).toEqual({
      status: "already_posted",
      journalEntryId: first.journalEntryId,
    });
    expect(await journalCount(world)).toBe(2);
    expect(await balanceOf(world, "customer_deposit")).toBe(-60_000);
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
    const parked = await parkedOf(tenant, `aj:receipt:${intentId}`);
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
      (await parkedOf(tenant, `aj:receipt:${intentId}`))[0]!.attempts,
    ).toBeGreaterThan(1);

    await mapRole(world, "customer_deposit", world.accounts.customer_deposit);
    expect(await sweep(tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    expect(await journalCount(world)).toBe(1);
    expect(await parkedOf(tenant, `aj:receipt:${intentId}`)).toHaveLength(0);
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
    expect(await parkedOf(world.tenant, `aj:receipt:${intentId}`)).toHaveLength(
      1,
    );

    await mapRole(world, "gateway_clearing", world.accounts.gateway_clearing);
    expect((await deliver(world.tenant, event)).status).toBe("posted");
    expect(await journalCount(world)).toBe(1);
    expect(await parkedOf(world.tenant, `aj:receipt:${intentId}`)).toHaveLength(
      0,
    );
  });

  it("AJ-PARK-04 an unparkable event (no tenant outlet) never throws: the delivery commits and a tenant-wide unparkable audit row records the lost fact", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const bad: EventEnvelope = {
      ...paymentPaid(world, randomUUID(), 10_000, {
        payload: { receivedIdr: "bukan angka", intentId: "bukan-uuid" },
      }),
      outletId: randomUUID() as EventEnvelope["outletId"],
    };

    // Throwing would roll back the whole cloud-sync delivery on every retry.
    const outcome = await deliver(tenant, bad);
    expect(outcome).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(0);
    expect(
      await parkedByCode(tenant, "AUTO_JOURNAL_PAYLOAD_INVALID"),
    ).toHaveLength(0);
    const { rows } = await owner.query<{
      outlet_id: string | null;
      after: Record<string, unknown>;
    }>(
      `SELECT outlet_id, event->'maskedChanges'->'after' AS after FROM audit_logs
        WHERE tenant_id = $1
          AND event->>'action' = 'accounting.auto_journal.unparkable'`,
      [tenant.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outlet_id).toBeNull();
    expect(rows[0]!.after).toMatchObject({
      eventId: bad.id,
      trigger: "payment.paid",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
    });
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
    const key = `aj:receipt:${intentA}`;

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
    const parkedKey = `aj:receipt:${intentParked}`;
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
      expect(await parkedOf(tenant, `aj:receipt:${intentFresh}`)).toHaveLength(
        0,
      );
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

  // order.voided is no longer ignored (Codex 142 F2): see AJ-142-F2*.
  it("AJ-IGNORE-01 events outside the consumer's event list are ignored and write nothing", async () => {
    const world = await makeWorld();
    const dayClosed = envelope(world, {
      name: "day.closed",
      aggregateType: "day",
      aggregateId: randomUUID(),
      occurredAt: DAY,
      payload: {},
    });

    expect(await deliver(world.tenant, dayClosed)).toEqual({
      status: "ignored",
    });
    expect(await journalCount(world)).toBe(0);
  });
});

describe("F19 slice 2 order.paid applies the reservation DP", () => {
  /** 100k + 10% PBJT = 110k, fully covered by the DP (no tender). */
  const dpSale = (
    sessionId: string,
    depositIdr = 110_000,
    completedAt?: string,
  ): SaleAmounts => ({
    grossSalesIdr: 100_000,
    pbjtIdr: 10_000,
    depositIdr,
    tableSessionId: sessionId,
    ...(completedAt === undefined ? {} : { completedAt }),
    tenders:
      depositIdr < 110_000
        ? [{ method: "cash", amountIdr: 110_000 - depositIdr }]
        : [],
  });

  it("AJ-DPA-01 a DP whose receipt is booked: the sale debits customer_deposit, the DP nets to 0 after receipt + sale", async () => {
    const world = await makeWorld();
    const { sessionId, intentId } = await seedSeatedDeposit(world, 110_000);
    await post(world, paymentPaid(world, intentId, 110_000));
    const orderUlid = createUlid();
    const sale = dpSale(sessionId);
    await seedPosOrder(world, orderUlid, sale);

    const result = await post(world, orderPaid(world, orderUlid, sale));
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 110_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
    ]);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await balanceOf(world, "gateway_clearing")).toBe(110_000);
  });

  it("AJ-DPA-02 a DP paid before the cutover (no receipt, no outbox row) books the DP part as gateway_clearing; the cash part stays cash", async () => {
    const world = await makeWorld();
    const { sessionId } = await seedSeatedDeposit(world, 60_000);
    const orderUlid = createUlid();
    const sale = dpSale(sessionId, 60_000);
    await seedPosOrder(world, orderUlid, sale);

    const result = await post(world, orderPaid(world, orderUlid, sale));
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "cash_on_hand", debit: 50_000, credit: 0 },
      { role: "gateway_clearing", debit: 60_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
    ]);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-DPA-03 a DP receipt still in the outbox parks the sale RECEIPT_PENDING; after the receipt the sweep posts it via customer_deposit", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const { sessionId, intentId } = await seedSeatedDeposit(world, 110_000);
    const outboxId = await seedUndeliveredReceipt(world, intentId, 110_000);
    const orderUlid = createUlid();
    const sale = dpSale(sessionId);
    await seedPosOrder(world, orderUlid, sale);

    expect(await deliver(tenant, orderPaid(world, orderUlid, sale))).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_PENDING",
      retryable: true,
    });
    expect(await journalCount(world)).toBe(0);

    await markDelivered(world, outboxId);
    await post(world, paymentPaid(world, intentId, 110_000));
    expect(await sweep(tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    const saleId = await journalIdOf(world, `aj:sale:${orderUlid}`);
    expect(await linesOf(world, saleId)).toEqual([
      { role: "customer_deposit", debit: 110_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
    ]);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await parkedOf(tenant, `aj:sale:${orderUlid}`)).toHaveLength(0);
  });

  it("AJ-DPA-04 paidDepositIdr different from the order's DP applied parks non-retryable POSTING_AMOUNTS_MISMATCH, nothing posted", async () => {
    const world = await makeWorld();
    const { sessionId, intentId } = await seedSeatedDeposit(world, 110_000);
    await post(world, paymentPaid(world, intentId, 110_000));
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, dpSale(sessionId));

    // The event claims 100k DP + 10k cash; the order row applied 110k.
    expect(
      await deliver(
        world.tenant,
        orderPaid(world, orderUlid, dpSale(sessionId, 100_000)),
      ),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(1);
    expect(await parkedOf(world.tenant, `aj:sale:${orderUlid}`)).toMatchObject([
      { retryable: false, event_name: "order.paid" },
    ]);
  });

  it("AJ-DPA-05 a session with one booked and one pre-cutover DP allocation parks non-retryable AUTO_JOURNAL_DEPOSIT_CUTOVER_MIXED", async () => {
    const world = await makeWorld();
    const { sessionId, intentId } = await seedSeatedDeposit(world, 60_000);
    await post(world, paymentPaid(world, intentId, 60_000));
    // A second reservation seated on the same bill, its DP paid before the
    // cutover.
    await seedSeatedDeposit(world, 50_000, sessionId);
    const orderUlid = createUlid();
    const sale = dpSale(sessionId);
    await seedPosOrder(world, orderUlid, sale);

    expect(
      await deliver(world.tenant, orderPaid(world, orderUlid, sale)),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_DEPOSIT_CUTOVER_MIXED",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(1);
    expect(await parkedOf(world.tenant, `aj:sale:${orderUlid}`)).toMatchObject([
      { retryable: false },
    ]);
  });

  it("AJ-DPA-06 only the allocated DP intent decides: a duplicate pre-cutover intent of the reservation (refunded or paid) does not hold the sale", async () => {
    const world = await makeWorld();
    const { reservationId, sessionId, intentId } = await seedSeatedDeposit(
      world,
      110_000,
    );
    await post(world, paymentPaid(world, intentId, 110_000));
    // Duplicate intents of the same reservation without a receipt (the other
    // cutover side), one refunded and one still paid: neither is allocated.
    await seedIntent(world, {
      amountIdr: 110_000,
      reservationId,
      status: "refunded",
    });
    await seedIntent(world, { amountIdr: 50_000, reservationId });
    const orderUlid = createUlid();
    const sale = dpSale(sessionId);
    await seedPosOrder(world, orderUlid, sale);

    const result = await post(world, orderPaid(world, orderUlid, sale));
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 110_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
    ]);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-DPA-07 a DP refunded after seating and then applied to the sale parks non-retryable POSTING_AMOUNTS_MISMATCH (customer_deposit is never debited twice)", async () => {
    const world = await makeWorld();
    const { sessionId, intentId } = await seedSeatedDeposit(world, 110_000);
    await post(world, paymentPaid(world, intentId, 110_000));
    const refundId = await seedRefund(world, intentId, 110_000);
    await post(world, paymentRefunded(world, refundId, intentId, 110_000));
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    const orderUlid = createUlid();
    const sale = dpSale(sessionId);
    await seedPosOrder(world, orderUlid, sale);

    expect(
      await deliver(world.tenant, orderPaid(world, orderUlid, sale)),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(2);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await parkedOf(world.tenant, `aj:sale:${orderUlid}`)).toMatchObject([
      { retryable: false, event_name: "order.paid" },
    ]);
  });

  it("AJ-DPA-08 a DP refunded after a completed sale applied it parks the refund non-retryable POSTING_AMOUNTS_MISMATCH; a refund of the unapplied rest still posts", async () => {
    const world = await makeWorld();
    const { sessionId, intentId } = await seedSeatedDeposit(world, 160_000);
    await post(world, paymentPaid(world, intentId, 160_000));
    const orderUlid = createUlid();
    // Completed (DAY) before the refunds below (REFUND_DAY): guards are bounded
    // by time, so the sale only counts against refunds completed after it.
    const sale = dpSale(sessionId, 110_000, DAY);
    await seedPosOrder(world, orderUlid, sale);
    await post(world, orderPaid(world, orderUlid, sale));
    expect(await balanceOf(world, "customer_deposit")).toBe(-50_000);

    // The unapplied 50_000 may go back to the guest. A later refund still
    // pending when the first one is journaled does not count against it.
    const restId = await seedRefund(world, intentId, 50_000);
    const overId = await seedRefund(world, intentId, 110_000);
    await owner.query(
      `UPDATE payment_refunds SET status = 'pending', completed_at = NULL WHERE id = $1`,
      [overId],
    );
    await post(world, paymentRefunded(world, restId, intentId, 50_000));
    expect(await balanceOf(world, "customer_deposit")).toBe(0);

    // Any more would take back DP the sale already used.
    await owner.query(
      `UPDATE payment_refunds SET status = 'completed', completed_at = $2 WHERE id = $1`,
      [overId, "2026-10-16T06:00:00.000Z"],
    );
    const over = paymentRefunded(world, overId, intentId, 110_000);
    expect(await deliver(world.tenant, over)).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(3);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    await owner.query(
      `UPDATE payment_intents SET status = 'refunded' WHERE id = $1`,
      [intentId],
    );

    // Replaying the first refund after the second completed and emptied the
    // intent is still judged as it stood then.
    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, restId, intentId, 50_000),
      ),
    ).toMatchObject({ status: "already_posted" });
  });

  it("AJ-DPA-09 a payout of an unallocated fund on an over-applied DP intent still posts (it never takes DP)", async () => {
    const world = await makeWorld();
    const { sessionId, intentId } = await seedSeatedDeposit(world, 110_000);
    await post(world, paymentPaid(world, intentId, 110_000));
    const orderUlid = createUlid();
    // Completed (DAY) before the refund at REFUND_DAY, so the sale counts.
    const sale = dpSale(sessionId, 110_000, DAY);
    await seedPosOrder(world, orderUlid, sale);
    await post(world, orderPaid(world, orderUlid, sale));
    // A bad DP refund leaves the session over-applied.
    const badId = await seedRefund(world, intentId, 110_000);
    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, badId, intentId, 110_000),
      ),
    ).toMatchObject({ status: "parked", code: "POSTING_AMOUNTS_MISMATCH" });

    const fundId = await seedFund(world, intentId, 25_000);
    const fundEvent = fundsUnallocated(world, fundId, intentId, 25_000);
    await seedOutboxEvent(world, fundEvent, fundId, "delivered");
    await post(world, fundEvent);
    const payoutId = await seedRefund(world, intentId, 25_000, fundId);
    const payout = await post(
      world,
      paymentRefunded(world, payoutId, intentId, 25_000, fundId),
    );
    expect(payout.journalEntryId).toBeTruthy();
  });
});

describe("F19 slice 2 a forfeited DP moves to deposit_forfeit_income", () => {
  it("AJ-FORFEIT-01 a no-show forfeits the whole DP: Dr customer_deposit / Cr deposit_forfeit_income (source customer_deposit); replay and a new event id post once", async () => {
    const world = await makeWorld();
    const deposit = { paidIdr: 200_000, forfeitedIdr: 200_000 };
    const { reservationId, intentId } = await seedClosedReservation(world, {
      kind: "no_show",
      ...deposit,
    });
    await post(world, paymentPaid(world, intentId, 200_000));

    const event = reservationClosed(world, reservationId, "no_show", deposit);
    const result = await post(world, event);
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 200_000, credit: 0 },
      { role: "deposit_forfeit_income", debit: 0, credit: 200_000 },
    ]);
    const entry = await entryOf(world, result.journalEntryId);
    expect(entry.source_type).toBe("customer_deposit");
    expect(entry.entry_date).toBe("2026-10-15");
    expect(entry.outlet_id).toBe(world.outletId);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await balanceOf(world, "gateway_clearing")).toBe(200_000);

    expect(await deliver(world.tenant, event)).toEqual({
      status: "already_posted",
      journalEntryId: result.journalEntryId,
    });
    expect(
      await deliver(
        world.tenant,
        reservationClosed(world, reservationId, "no_show", deposit),
      ),
    ).toEqual({
      status: "already_posted",
      journalEntryId: result.journalEntryId,
    });
    expect(await journalCount(world)).toBe(2);
  });

  it("AJ-FORFEIT-02 a late cancel forfeits part: the forfeit and the refund payout (payment.refunded) book separately and customer_deposit ends at 0", async () => {
    const world = await makeWorld();
    const deposit = { paidIdr: 200_000, forfeitedIdr: 80_000 };
    const { reservationId, intentId } = await seedClosedReservation(world, {
      kind: "cancelled",
      ...deposit,
    });
    await post(world, paymentPaid(world, intentId, 200_000));

    const forfeit = await post(
      world,
      reservationClosed(world, reservationId, "cancelled", deposit),
    );
    expect(await linesOf(world, forfeit.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 80_000, credit: 0 },
      { role: "deposit_forfeit_income", debit: 0, credit: 80_000 },
    ]);
    const refundId = await seedRefund(world, intentId, 120_000);
    await post(world, paymentRefunded(world, refundId, intentId, 120_000));

    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await balanceOf(world, "gateway_clearing")).toBe(80_000);
    expect(await balanceOf(world, "deposit_forfeit_income")).toBe(-80_000);
    expect(await journalCount(world)).toBe(3);
  });

  it("AJ-FORFEIT-03 a close with nothing forfeited (full refund or unpaid DP) is ignored", async () => {
    const world = await makeWorld();
    const deposit = { paidIdr: 200_000, forfeitedIdr: 0 };
    const { reservationId } = await seedClosedReservation(world, {
      kind: "cancelled",
      ...deposit,
    });

    expect(
      await deliver(
        world.tenant,
        reservationClosed(world, reservationId, "cancelled", deposit),
      ),
    ).toEqual({ status: "ignored" });
    expect(await journalCount(world)).toBe(0);
  });

  it("AJ-FORFEIT-04 a DP paid before the cutover (no receipt) forfeits out of gateway_clearing", async () => {
    const world = await makeWorld();
    const deposit = { paidIdr: 150_000, forfeitedIdr: 150_000 };
    const { reservationId } = await seedClosedReservation(world, {
      kind: "no_show",
      ...deposit,
    });

    const result = await post(
      world,
      reservationClosed(world, reservationId, "no_show", deposit),
    );
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "deposit_forfeit_income", debit: 0, credit: 150_000 },
      { role: "gateway_clearing", debit: 150_000, credit: 0 },
    ]);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-FORFEIT-05 only deposit_payment_id decides: a second, pre-cutover DP intent of the reservation does not mix the cutover; the forfeit posts via customer_deposit", async () => {
    const world = await makeWorld();
    const deposit = { paidIdr: 200_000, forfeitedIdr: 200_000 };
    const { reservationId, intentId } = await seedClosedReservation(world, {
      kind: "no_show",
      ...deposit,
    });
    await post(world, paymentPaid(world, intentId, 200_000));
    await seedIntent(world, { amountIdr: 50_000, reservationId });

    const result = await post(
      world,
      reservationClosed(world, reservationId, "no_show", deposit),
    );
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 200_000, credit: 0 },
      { role: "deposit_forfeit_income", debit: 0, credit: 200_000 },
    ]);
    expect(
      await parkedOf(world.tenant, `aj:dp-forfeit:${reservationId}`),
    ).toHaveLength(0);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-FORFEIT-06 a forfeit different from the stored reservation split parks non-retryable POSTING_AMOUNTS_MISMATCH", async () => {
    const world = await makeWorld();
    const { reservationId, intentId } = await seedClosedReservation(world, {
      kind: "cancelled",
      paidIdr: 200_000,
      forfeitedIdr: 80_000,
    });
    await post(world, paymentPaid(world, intentId, 200_000));

    expect(
      await deliver(
        world.tenant,
        reservationClosed(world, reservationId, "cancelled", {
          paidIdr: 200_000,
          forfeitedIdr: 100_000,
        }),
      ),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(1);
  });
});

describe("F19 slice 2 cashier_shift.closed books the drawer difference", () => {
  it("AJ-SHIFT-01 cash over (+): Dr cash_on_hand / Cr cash_over_short, source cashier_shift, on the close day", async () => {
    const world = await makeWorld();
    const shiftId = await seedClosedShift(world, SHIFT_FLOAT_IDR + 20_000);

    const result = await post(world, shiftClosed(world, shiftId, 20_000));
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "cash_on_hand", debit: 20_000, credit: 0 },
      { role: "cash_over_short", debit: 0, credit: 20_000 },
    ]);
    const entry = await entryOf(world, result.journalEntryId);
    expect(entry.source_type).toBe("cashier_shift");
    expect(entry.entry_date).toBe("2026-10-15");
  });

  it("AJ-SHIFT-02 cash short (-): Dr cash_over_short / Cr cash_on_hand", async () => {
    const world = await makeWorld();
    const shiftId = await seedClosedShift(world, SHIFT_FLOAT_IDR - 15_000);

    const result = await post(world, shiftClosed(world, shiftId, -15_000));
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "cash_on_hand", debit: 0, credit: 15_000 },
      { role: "cash_over_short", debit: 15_000, credit: 0 },
    ]);
  });

  it("AJ-SHIFT-03 a shift that closes exact (difference 0) is ignored", async () => {
    const world = await makeWorld();
    const shiftId = await seedClosedShift(world, SHIFT_FLOAT_IDR);

    expect(await deliver(world.tenant, shiftClosed(world, shiftId, 0))).toEqual(
      { status: "ignored" },
    );
    expect(await journalCount(world)).toBe(0);
  });

  it("AJ-SHIFT-04 replaying the close, or the close under a new event id, posts once", async () => {
    const world = await makeWorld();
    const shiftId = await seedClosedShift(world, SHIFT_FLOAT_IDR + 5_000);
    const event = shiftClosed(world, shiftId, 5_000);
    const result = await post(world, event);

    for (const again of [event, shiftClosed(world, shiftId, 5_000)])
      expect(await deliver(world.tenant, again)).toEqual({
        status: "already_posted",
        journalEntryId: result.journalEntryId,
      });
    expect(await journalCount(world)).toBe(1);
  });

  it("AJ-SHIFT-05 a close in a closed month rolls to the first open day, flagged, with an audit row", async () => {
    const world = await makeWorld();
    await closePeriods(world, ["2026-10"]);
    const shiftId = await seedClosedShift(world, SHIFT_FLOAT_IDR - 7_000);

    const result = await post(world, shiftClosed(world, shiftId, -7_000));
    expect(result.entryDate).toBe("2026-11-01");
    expect(result.lateAdjustmentFrom).toBe("2026-10-15");
    expect(
      (await entryOf(world, result.journalEntryId)).late_adjustment_from,
    ).toBe("2026-10-15");
    expect(await lateAuditCount(world.tenant, result.journalEntryId)).toBe(1);
    await expectBalanced(world, result.journalEntryId);
  });

  it("AJ-SHIFT-06 a difference that disagrees with the stored variance parks non-retryable POSTING_AMOUNTS_MISMATCH", async () => {
    const world = await makeWorld();
    const shiftId = await seedClosedShift(world, SHIFT_FLOAT_IDR + 20_000);

    expect(
      await deliver(world.tenant, shiftClosed(world, shiftId, 25_000)),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    expect(await parkedOf(world.tenant, `aj:shift:${shiftId}`)).toHaveLength(1);
    expect(await journalCount(world)).toBe(0);
  });
});

// ============================================================================
// Codex 142 fixes (legend-9pz9, docs/briefs/142-second-opinion-auto-journals.result.md;
// design: docs/design/auto-journals.md, "Codex 142 fixes").
// Each test asserts the CORRECT outcome for one finding and its fix.
//
// Assumptions:
// - F1: a payout must be backed by a posted customer_deposit credit. Backing is
//   the fund receipt `aj:receipt-fund:<fundId>` when a payment.funds_unallocated
//   event of that fund is in the outbox, else the intent receipt
//   `aj:receipt:<intentId>`. Backing still in the outbox: retryable
//   AUTO_JOURNAL_RECEIPT_PENDING. No backing anywhere: non-retryable
//   AUTO_JOURNAL_RECEIPT_MISSING. Credit exceeded: POSTING_AMOUNTS_MISMATCH.
//   A refund row that is not completed, or differs from the payload:
//   AUTO_JOURNAL_PAYLOAD_INVALID.
// - F2: a completed-sale void reverses `aj:sale:<orderId>` (key
//   `aj:sale-void:<orderId>`, reversal_of = the sale entry). Sale not yet
//   consumed: retryable AUTO_JOURNAL_SALE_PENDING; never journaled:
//   AUTO_JOURNAL_SALE_MISSING; sale with EDC/points money, or gateway money
//   outside customer_deposit (no intent, or no posted receipt):
//   AUTO_JOURNAL_VOID_UNSUPPORTED (legend-x1i1h: gateway money of an intent
//   whose receipt posted goes back to customer_deposit). The retryable flag
//   of JOURNAL_ALREADY_REVERSED is not asserted.
// - F3/F4: time order decides, never delivery order. Time of a refund =
//   payment_refunds.completed_at, of a sale = pos_orders.completed_at, of a
//   forfeit = reservations.closed_at. On equal time the sale counts as earlier
//   than a refund. Tests that need distinct refunds use distinct completed_at
//   (equal times fall back to an id order the test cannot control).
// - A points sale (cash + points) posts on order.paid like any sale.

describe("Codex 142 fixes", () => {
  const T_SALE_EARLY = "2026-10-15T05:00:00.000Z"; // before REFUND_DAY
  const T_SALE_LATE = "2026-10-17T05:00:00.000Z"; // after REFUND_DAY
  const T_REFUND_BEFORE_FORFEIT = "2026-10-14T05:00:00.000Z"; // before DAY
  const hoursAfter = (instant: string, hours: number) =>
    new Date(new Date(instant).getTime() + hours * 3_600_000).toISOString();

  const MISMATCH = {
    status: "parked",
    code: "POSTING_AMOUNTS_MISMATCH",
    retryable: false,
  } as const;

  const dpSale142 = (sessionId: string, completedAt: string): SaleAmounts => ({
    grossSalesIdr: 100_000,
    pbjtIdr: 10_000,
    depositIdr: 110_000,
    tableSessionId: sessionId,
    completedAt,
    tenders: [],
  });

  /** Gross 100k, discount 10k, service 5k, PBJT 9.5k, rounding 0.5k = 105k cash. */
  const cashSale142: SaleAmounts = {
    grossSalesIdr: 100_000,
    discountIdr: 10_000,
    serviceChargeIdr: 5_000,
    pbjtIdr: 9_500,
    roundingIdr: 500,
    tenders: [{ method: "cash", amountIdr: 105_000 }],
  };

  type Order = "first-first" | "second-first";

  /** Delivers `first` and `second` in the given order; results keep their names. */
  async function deliverBoth(
    tenant: Tenant,
    order: Order,
    first: EventEnvelope,
    second: EventEnvelope,
  ) {
    const results = {} as {
      first: AutoJournalResult;
      second: AutoJournalResult;
    };
    if (order === "first-first") {
      results.first = await deliver(tenant, first);
      results.second = await deliver(tenant, second);
    } else {
      results.second = await deliver(tenant, second);
      results.first = await deliver(tenant, first);
    }
    return results;
  }

  function orderVoided(
    world: World,
    orderUlid: string,
    amountIdr: number,
    voidId: string | null,
    voidedFinalOrder: boolean,
    voidedAt: string = REFUND_DAY,
    payload: Record<string, unknown> = {},
  ): EventEnvelope {
    return envelope(world, {
      name: "order.voided",
      aggregateType: "order",
      aggregateId: orderUlid,
      occurredAt: voidedAt,
      payload: {
        orderId: orderUlid,
        outletId: world.outletId,
        businessDate: "2026-10-15",
        amountIdr,
        reason: "wrong_order",
        reasonNote: "Pesanan salah",
        approvedBy: randomUUID(),
        overrideId: null,
        approvalRequestId: null,
        voidedFinalOrder,
        voidId,
        receiptNumber: voidedFinalOrder ? "AJ-0001" : null,
        voidedAt,
        ...payload,
      },
    });
  }

  /** The pos_order_voids row of a completed-sale void. */
  async function seedVoid(
    world: World,
    orderUlid: string,
    amountIdr: number,
    voidedAt: string = REFUND_DAY,
  ): Promise<string> {
    const voidId = randomUUID();
    await asTenant(world.tenant, (client) =>
      client.query(
        `INSERT INTO pos_order_voids
           (id, tenant_id, outlet_id, order_id, receipt_number, amount_idr, reason, reason_note,
            requested_by, approved_by, approval_request_id, voided_at)
         VALUES ($1, $2, $3, $4, 'AJ-0001', $7, 'wrong_order', 'Pesanan salah',
                 'requester', 'approver', $6, $5)`,
        [
          voidId,
          world.tenant.id,
          world.outletId,
          ulidToUuid(orderUlid),
          voidedAt,
          randomUUID(),
          amountIdr,
        ],
      ),
    );
    return voidId;
  }

  /** A completed sale, seeded and journaled; returns its order id and journal. */
  async function postedSale(world: World, sale: SaleAmounts) {
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, sale);
    const result = await post(world, orderPaid(world, orderUlid, sale));
    return { orderUlid, saleEntryId: result.journalEntryId };
  }

  async function reversalOf(
    world: World,
    entryId: string,
  ): Promise<{ reversal_of: string | null; source_type: string }> {
    const { rows } = await owner.query<{
      reversal_of: string | null;
      source_type: string;
    }>(
      "SELECT reversal_of, source_type FROM journal_entries WHERE tenant_id = $1 AND id = $2",
      [world.tenant.id, entryId],
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  // ---- F1: a payout needs a customer_deposit credit behind it ---------------

  it("AJ-142-F1a a refund whose receipt is still in the outbox parks AUTO_JOURNAL_RECEIPT_PENDING (retryable, no debit without a credit); the sweep posts it after the receipt", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const intentId = await seedIntent(world, { amountIdr: 200_000 });
    const outboxId = await seedUndeliveredReceipt(world, intentId, 200_000);
    const refundId = await seedRefund(world, intentId, 200_000);

    expect(
      await deliver(
        tenant,
        paymentRefunded(world, refundId, intentId, 200_000),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_PENDING",
      retryable: true,
    });
    expect(await journalCount(world)).toBe(0);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);

    await markDelivered(world, outboxId);
    await post(world, paymentPaid(world, intentId, 200_000));
    expect(await sweep(tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await balanceOf(world, "gateway_clearing")).toBe(0);
  });

  it("AJ-142-F1b a refund of an intent whose receipt never existed (paid before the wiring) parks non-retryable AUTO_JOURNAL_RECEIPT_MISSING; the sweep leaves it and customer_deposit is never debited", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const intentId = await seedIntent(world, { amountIdr: 200_000 });
    const refundId = await seedRefund(world, intentId, 200_000);

    expect(
      await deliver(
        tenant,
        paymentRefunded(world, refundId, intentId, 200_000),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_MISSING",
      retryable: false,
    });
    expect(
      await parkedByCode(
        tenant,
        "AUTO_JOURNAL_RECEIPT_MISSING",
        world.outletId,
      ),
    ).toMatchObject([{ retryable: false, event_name: "payment.refunded" }]);

    await sweep(tenant);
    expect(await journalCount(world)).toBe(0);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-142-F1c a payout of an unallocated fund with no fund receipt and no intent receipt parks non-retryable AUTO_JOURNAL_RECEIPT_MISSING", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, { amountIdr: 80_000 });
    const fundId = await seedFund(world, intentId, 25_000);
    const payoutId = await seedRefund(world, intentId, 25_000, fundId);

    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, payoutId, intentId, 25_000, fundId),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_MISSING",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(0);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-142-F1d a fund payout whose own fund receipt is posted posts; paying out more than the fund received parks POSTING_AMOUNTS_MISMATCH", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, {
      amountIdr: 80_000,
      status: "expired",
    });
    const fundId = await seedFund(world, intentId, 25_000);
    const fundEvent = fundsUnallocated(world, fundId, intentId, 25_000);
    await seedOutboxEvent(world, fundEvent, fundId, "delivered");
    await post(world, fundEvent);
    expect(await balanceOf(world, "customer_deposit")).toBe(-25_000);

    const payoutId = await seedRefund(world, intentId, 25_000, fundId);
    const payout = await post(
      world,
      paymentRefunded(world, payoutId, intentId, 25_000, fundId),
    );
    expect(await linesOf(world, payout.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 25_000, credit: 0 },
      { role: "gateway_clearing", debit: 0, credit: 25_000 },
    ]);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);

    // One live payout per fund (payment_refunds_unallocated_fund_live_uq), so a
    // payout of more than the fund received sits on a second fund: it would debit
    // money never received.
    const otherFundId = await seedFund(world, intentId, 25_000);
    const otherEvent = fundsUnallocated(world, otherFundId, intentId, 25_000);
    await seedOutboxEvent(world, otherEvent, otherFundId, "delivered");
    await post(world, otherEvent);
    const extraId = await seedRefund(
      world,
      intentId,
      30_000,
      otherFundId,
      hoursAfter(REFUND_DAY, 1),
    );
    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, extraId, intentId, 30_000, otherFundId),
      ),
    ).toEqual(MISMATCH);
    expect(await journalCount(world)).toBe(3);
    expect(await balanceOf(world, "customer_deposit")).toBe(-25_000);
  });

  it("AJ-142-F1e a fund payout whose fund receipt is still in the outbox parks AUTO_JOURNAL_RECEIPT_PENDING; the sweep posts it after the fund receipt", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const intentId = await seedIntent(world, {
      amountIdr: 80_000,
      status: "expired",
    });
    const fundId = await seedFund(world, intentId, 25_000);
    const fundEvent = fundsUnallocated(world, fundId, intentId, 25_000);
    const outboxId = await seedOutboxEvent(world, fundEvent, fundId, "pending");
    const payoutId = await seedRefund(world, intentId, 25_000, fundId);

    expect(
      await deliver(
        tenant,
        paymentRefunded(world, payoutId, intentId, 25_000, fundId),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_PENDING",
      retryable: true,
    });
    expect(await journalCount(world)).toBe(0);

    await markDelivered(world, outboxId);
    await post(world, fundEvent);
    expect(await sweep(tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await journalCount(world)).toBe(2);
  });

  it("AJ-142-F1f an overpayment fund counted inside payment.paid is backed by the intent receipt: its payout and the bill refund post, one rupiah more parks POSTING_AMOUNTS_MISMATCH", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, { amountIdr: 80_000 });
    // The guest paid 105k on an 80k bill: the receipt holds all of it and no
    // payment.funds_unallocated event exists for the 25k overpayment.
    await post(world, paymentPaid(world, intentId, 105_000));
    const fundId = await seedFund(world, intentId, 25_000, "overpayment");
    expect(await balanceOf(world, "customer_deposit")).toBe(-105_000);

    const fundPayoutId = await seedRefund(world, intentId, 25_000, fundId);
    await post(
      world,
      paymentRefunded(world, fundPayoutId, intentId, 25_000, fundId),
    );
    const billRefundId = await seedRefund(
      world,
      intentId,
      80_000,
      undefined,
      hoursAfter(REFUND_DAY, 1),
    );
    await post(world, paymentRefunded(world, billRefundId, intentId, 80_000));
    expect(await balanceOf(world, "customer_deposit")).toBe(0);

    const extraId = await seedRefund(
      world,
      intentId,
      1,
      undefined,
      hoursAfter(REFUND_DAY, 2),
    );
    expect(
      await deliver(world.tenant, paymentRefunded(world, extraId, intentId, 1)),
    ).toEqual(MISMATCH);
    expect(await journalCount(world)).toBe(3);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-142-F1h an intent receipt that finance reversed no longer backs a refund: payment.refunded parks non-retryable POSTING_AMOUNTS_MISMATCH", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, { amountIdr: 200_000 });
    const receipt = await post(world, paymentPaid(world, intentId, 200_000));
    expect(await balanceOf(world, "customer_deposit")).toBe(-200_000);

    await reverseJournal(
      contextOf(world.tenant),
      receipt.journalEntryId,
      {
        entryDate: "2026-10-15",
        reason: "Koreksi keuangan",
        idempotencyKey: `fin-${randomUUID()}`,
      },
      userIdSchema.parse(await seedUser()),
    );
    expect(await journalCount(world)).toBe(2);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);

    const refundId = await seedRefund(world, intentId, 200_000);
    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, intentId, 200_000),
      ),
    ).toEqual(MISMATCH);
    expect(await journalCount(world)).toBe(2);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-142-F1g a refund event whose refund row is not completed, or whose amount differs from the row, parks non-retryable AUTO_JOURNAL_PAYLOAD_INVALID", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, { amountIdr: 200_000 });
    await post(world, paymentPaid(world, intentId, 200_000));

    const pendingId = await seedRefund(world, intentId, 50_000);
    await owner.query(
      "UPDATE payment_refunds SET status = 'pending', completed_at = NULL WHERE id = $1",
      [pendingId],
    );
    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, pendingId, intentId, 50_000),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      retryable: false,
    });

    const wrongAmountId = await seedRefund(world, intentId, 50_000);
    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, wrongAmountId, intentId, 60_000),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(1);
    expect(await balanceOf(world, "customer_deposit")).toBe(-200_000);
  });

  // ---- F2: void of a completed sale -----------------------------------------

  it("AJ-142-F2a the void of a completed cash sale posts a reversal of the sale journal (reversal_of = the sale entry, every line mirrored); replay books nothing more", async () => {
    const world = await makeWorld();
    const { orderUlid, saleEntryId } = await postedSale(world, cashSale142);
    expect(await balanceOf(world, "cash_on_hand")).toBe(105_000);

    const voidId = await seedVoid(world, orderUlid, 105_000);
    const event = orderVoided(world, orderUlid, 105_000, voidId, true);
    const result = await deliver(world.tenant, event);
    expect(result.status).toBe("posted");
    if (result.status !== "posted") throw new Error("not posted");

    expect(await reversalOf(world, result.journalEntryId)).toEqual({
      reversal_of: saleEntryId,
      source_type: "reversal",
    });
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "cash_on_hand", debit: 0, credit: 105_000 },
      { role: "rounding", debit: 500, credit: 0 },
      { role: "sales_discount", debit: 0, credit: 10_000 },
      { role: "sales_revenue", debit: 100_000, credit: 0 },
      { role: "service_charge", debit: 5_000, credit: 0 },
      { role: "tax_payable_pbjt", debit: 9_500, credit: 0 },
    ]);
    await expectBalanced(world, result.journalEntryId);
    for (const role of [
      "cash_on_hand",
      "sales_revenue",
      "sales_discount",
      "service_charge",
      "tax_payable_pbjt",
      "rounding",
    ] as const)
      expect(await balanceOf(world, role), role).toBe(0);

    expect(await deliver(world.tenant, event)).toMatchObject({
      status: "already_posted",
    });
    expect(await journalCount(world)).toBe(2);
  });

  it("AJ-142-F2b the void of an open order (voidedFinalOrder false) books nothing", async () => {
    const world = await makeWorld();

    expect(
      await deliver(
        world.tenant,
        orderVoided(world, createUlid(), 50_000, null, false),
      ),
    ).toEqual({ status: "ignored" });
    expect(await journalCount(world)).toBe(0);
  });

  it("AJ-142-F2c a void that arrives before the sale was consumed parks AUTO_JOURNAL_SALE_PENDING (retryable); after order.paid the sweep posts the reversal", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, cashSale142);
    const saleEvent = orderPaid(world, orderUlid, cashSale142);
    const outboxId = await seedOutboxEvent(
      world,
      saleEvent,
      ulidToUuid(orderUlid),
      "pending",
    );
    const voidId = await seedVoid(world, orderUlid, 105_000);

    expect(
      await deliver(
        tenant,
        orderVoided(world, orderUlid, 105_000, voidId, true),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_SALE_PENDING",
      retryable: true,
    });
    expect(await journalCount(world)).toBe(0);
    expect(await parkedOf(tenant, `aj:sale-void:${orderUlid}`)).toMatchObject([
      { retryable: true, event_name: "order.voided" },
    ]);

    await markDelivered(world, outboxId);
    const sale = await post(world, saleEvent);
    expect(await sweep(tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    const reversalId = await journalIdOf(world, `aj:sale-void:${orderUlid}`);
    expect((await reversalOf(world, reversalId)).reversal_of).toBe(
      sale.journalEntryId,
    );
    expect(await balanceOf(world, "cash_on_hand")).toBe(0);
    expect(await balanceOf(world, "sales_revenue")).toBe(0);
    expect(await parkedOf(tenant, `aj:sale-void:${orderUlid}`)).toHaveLength(0);
  });

  it("AJ-142-F2d a void of a sale that was never journaled parks non-retryable AUTO_JOURNAL_SALE_MISSING and posts nothing", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, cashSale142);
    const voidId = await seedVoid(world, orderUlid, 105_000);

    expect(
      await deliver(
        world.tenant,
        orderVoided(world, orderUlid, 105_000, voidId, true),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_SALE_MISSING",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(0);
    expect(
      await parkedOf(world.tenant, `aj:sale-void:${orderUlid}`),
    ).toMatchObject([{ retryable: false, event_name: "order.voided" }]);
  });

  for (const kind of ["gateway", "edc", "points"] as const) {
    it(`AJ-142-F2e the void of a sale with ${kind} money parks non-retryable AUTO_JOURNAL_VOID_UNSUPPORTED (the void returns cash only); the sale journal stays`, async () => {
      const world = await makeWorld();
      const sale: SaleAmounts =
        kind === "points"
          ? {
              grossSalesIdr: 100_000,
              pointsIdr: 20_000,
              // Points are a captured tender (pos-order.service.ts bucket "points").
              tenders: [
                { method: "cash", amountIdr: 80_000 },
                { method: "points", amountIdr: 20_000 },
              ],
            }
          : {
              grossSalesIdr: 100_000,
              tenders: [
                { method: "cash", amountIdr: 30_000 },
                {
                  method: kind === "edc" ? "edc_card" : "qris",
                  amountIdr: 70_000,
                },
              ],
            };
      const { orderUlid } = await postedSale(world, sale);
      const voidId = await seedVoid(world, orderUlid, 100_000);

      expect(
        await deliver(
          world.tenant,
          orderVoided(world, orderUlid, 100_000, voidId, true),
        ),
      ).toEqual({
        status: "parked",
        code: "AUTO_JOURNAL_VOID_UNSUPPORTED",
        retryable: false,
      });
      expect(await journalCount(world)).toBe(1);
      expect(
        await parkedOf(world.tenant, `aj:sale-void:${orderUlid}`),
      ).toMatchObject([{ retryable: false }]);
    });
  }

  it("AJ-142-F2f a sale that finance already reversed parks JOURNAL_ALREADY_REVERSED instead of a second reversal", async () => {
    const world = await makeWorld();
    const { orderUlid, saleEntryId } = await postedSale(world, cashSale142);
    await reverseJournal(
      contextOf(world.tenant),
      saleEntryId,
      {
        entryDate: "2026-10-15",
        reason: "Koreksi keuangan",
        idempotencyKey: `fin-${randomUUID()}`,
      },
      userIdSchema.parse(await seedUser()),
    );
    expect(await journalCount(world)).toBe(2);
    const voidId = await seedVoid(world, orderUlid, 105_000);

    expect(
      await deliver(
        world.tenant,
        orderVoided(world, orderUlid, 105_000, voidId, true),
      ),
    ).toMatchObject({ status: "parked", code: "JOURNAL_ALREADY_REVERSED" });
    expect(await journalCount(world)).toBe(2);
    expect(await balanceOf(world, "cash_on_hand")).toBe(0);
  });

  it("AJ-142-F2g a void in a closed month posts the reversal on the first open day, flagged with its real date, with an audit row", async () => {
    const world = await makeWorld();
    const { orderUlid, saleEntryId } = await postedSale(world, cashSale142);
    await closePeriods(world, ["2026-10"]);
    const voidId = await seedVoid(world, orderUlid, 105_000);

    const result = await post(
      world,
      orderVoided(world, orderUlid, 105_000, voidId, true),
    );
    // Void instant REFUND_DAY = business date 2026-10-16, in the closed month.
    expect(result.entryDate).toBe("2026-11-01");
    expect(result.lateAdjustmentFrom).toBe("2026-10-16");
    const entry = await entryOf(world, result.journalEntryId);
    expect(entry.entry_date).toBe("2026-11-01");
    expect(entry.late_adjustment_from).toBe("2026-10-16");
    expect(entry.description).toContain("2026-10-16");
    expect((await reversalOf(world, result.journalEntryId)).reversal_of).toBe(
      saleEntryId,
    );
    expect(await lateAuditCount(world.tenant, result.journalEntryId)).toBe(1);
    expect(await balanceOf(world, "cash_on_hand")).toBe(0);
  });

  it("AJ-142-F2h a void whose voidId has no pos_order_voids row, or whose amount differs from the order total, parks non-retryable AUTO_JOURNAL_PAYLOAD_INVALID", async () => {
    const world = await makeWorld();
    const { orderUlid } = await postedSale(world, cashSale142);

    expect(
      await deliver(
        world.tenant,
        orderVoided(world, orderUlid, 105_000, randomUUID(), true),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      retryable: false,
    });

    const voidId = await seedVoid(world, orderUlid, 105_000);
    expect(
      await deliver(
        world.tenant,
        orderVoided(world, orderUlid, 100_000, voidId, true),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(1);
  });

  it("AJ-142-F2i an order.voided event with an invalid payload parks non-retryable AUTO_JOURNAL_PAYLOAD_INVALID and never throws", async () => {
    const world = await makeWorld();
    const bad = orderVoided(world, createUlid(), 1, null, true, REFUND_DAY, {
      amountIdr: "bukan angka",
    });

    expect(await deliver(world.tenant, bad)).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(0);
  });

  // ---- F3: forfeited DP, then an ordinary refund of the same intent ---------

  for (const order of ["first-first", "second-first"] as const) {
    const label =
      order === "first-first" ? "forfeit then refund" : "refund then forfeit";

    it(`AJ-142-F3a (${label}) a DP forfeited in full cannot also be refunded: the refund parks non-retryable POSTING_AMOUNTS_MISMATCH, the forfeit posts, customer_deposit stays 0`, async () => {
      const world = await makeWorld();
      const deposit = { paidIdr: 100_000, forfeitedIdr: 100_000 };
      const { reservationId, intentId } = await seedClosedReservation(world, {
        kind: "no_show",
        ...deposit,
      });
      await post(world, paymentPaid(world, intentId, 100_000));
      const refundId = await seedRefund(world, intentId, 100_000);

      const { first: forfeit, second: refund } = await deliverBoth(
        world.tenant,
        order,
        reservationClosed(world, reservationId, "no_show", deposit),
        paymentRefunded(world, refundId, intentId, 100_000),
      );
      expect(forfeit).toMatchObject({ status: "posted" });
      expect(refund).toEqual(MISMATCH);
      // receipt + forfeit only
      expect(await journalCount(world)).toBe(2);
      expect(await balanceOf(world, "customer_deposit")).toBe(0);
    });

    it(`AJ-142-F3b (${label}) forfeit 60k plus refund 40k of a 100k DP both post and customer_deposit ends at 0`, async () => {
      const world = await makeWorld();
      const deposit = { paidIdr: 100_000, forfeitedIdr: 60_000 };
      const { reservationId, intentId } = await seedClosedReservation(world, {
        kind: "cancelled",
        ...deposit,
      });
      await post(world, paymentPaid(world, intentId, 100_000));
      const refundId = await seedRefund(world, intentId, 40_000);

      const { first: forfeit, second: refund } = await deliverBoth(
        world.tenant,
        order,
        reservationClosed(world, reservationId, "cancelled", deposit),
        paymentRefunded(world, refundId, intentId, 40_000),
      );
      expect(forfeit).toMatchObject({ status: "posted" });
      expect(refund).toMatchObject({ status: "posted" });
      expect(await journalCount(world)).toBe(3);
      expect(await balanceOf(world, "customer_deposit")).toBe(0);
      expect(await balanceOf(world, "deposit_forfeit_income")).toBe(-60_000);
    });

    it(`AJ-142-F3c (${label}) a refund completed before the forfeit leaves less to forfeit: the refund posts, a forfeit above the rest parks non-retryable POSTING_AMOUNTS_MISMATCH`, async () => {
      const world = await makeWorld();
      // Forfeit 60k of 100k at closed_at = DAY, but 60k was already refunded
      // the day before: only 40k was left to forfeit.
      const deposit = { paidIdr: 100_000, forfeitedIdr: 60_000 };
      const { reservationId, intentId } = await seedClosedReservation(world, {
        kind: "cancelled",
        ...deposit,
      });
      await post(world, paymentPaid(world, intentId, 100_000));
      const refundId = await seedRefund(
        world,
        intentId,
        60_000,
        undefined,
        T_REFUND_BEFORE_FORFEIT,
      );

      const { first: forfeit, second: refund } = await deliverBoth(
        world.tenant,
        order,
        reservationClosed(world, reservationId, "cancelled", deposit),
        paymentRefunded(world, refundId, intentId, 60_000),
      );
      expect(refund).toMatchObject({ status: "posted" });
      expect(forfeit).toEqual(MISMATCH);
      // receipt + refund only
      expect(await journalCount(world)).toBe(2);
      expect(await balanceOf(world, "customer_deposit")).toBe(-40_000);
    });
  }

  // ---- F4: guards bound by time, not by delivery order ----------------------

  /**
   * Seated 110k DP, receipt booked. Refund of the whole DP completes at
   * REFUND_DAY; the sale that applied the DP completed at `saleAt`. "first"
   * is the sale, "second" the refund.
   */
  async function deliverDpPair(order: Order, saleAt: string) {
    const world = await makeWorld();
    const { sessionId, intentId } = await seedSeatedDeposit(world, 110_000);
    await post(world, paymentPaid(world, intentId, 110_000));
    const orderUlid = createUlid();
    const sale = dpSale142(sessionId, saleAt);
    await seedPosOrder(world, orderUlid, sale);
    const refundId = await seedRefund(world, intentId, 110_000);

    const { first, second } = await deliverBoth(
      world.tenant,
      order,
      orderPaid(world, orderUlid, sale, saleAt),
      paymentRefunded(world, refundId, intentId, 110_000),
    );
    return { world, sale: first, refund: second };
  }

  for (const order of ["first-first", "second-first"] as const) {
    const label = order === "first-first" ? "sale first" : "refund first";

    it(`AJ-142-F4a (${label}) a refund completed before the DP sale posts; only the later offending sale parks`, async () => {
      const { world, sale, refund } = await deliverDpPair(order, T_SALE_LATE);

      expect(refund).toMatchObject({ status: "posted" });
      expect(sale).toEqual(MISMATCH);
      // receipt + refund only
      expect(await journalCount(world)).toBe(2);
      expect(await balanceOf(world, "customer_deposit")).toBe(0);
    });

    it(`AJ-142-F4b (${label}) a DP sale completed before the refund posts; only the later offending refund parks`, async () => {
      const { world, sale, refund } = await deliverDpPair(order, T_SALE_EARLY);

      expect(sale).toMatchObject({ status: "posted" });
      expect(refund).toEqual(MISMATCH);
      // receipt + sale only
      expect(await journalCount(world)).toBe(2);
      expect(await balanceOf(world, "customer_deposit")).toBe(0);
    });

    it(`AJ-142-F4c (${label}) a sale and a refund completed at the same instant: the sale counts as earlier, so it posts and the refund parks`, async () => {
      const { world, sale, refund } = await deliverDpPair(order, REFUND_DAY);

      expect(sale).toMatchObject({ status: "posted" });
      expect(refund).toEqual(MISMATCH);
      expect(await journalCount(world)).toBe(2);
      expect(await balanceOf(world, "customer_deposit")).toBe(0);
    });

    it(`AJ-142-F4d (${label}) a gateway tender of a completed sale uses up the intent receipt: a refund completed after the sale parks non-retryable POSTING_AMOUNTS_MISMATCH`, async () => {
      const world = await makeWorld();
      const intentId = await seedIntent(world, { amountIdr: 50_000 });
      await post(world, paymentPaid(world, intentId, 50_000));
      const orderUlid = createUlid();
      const sale: SaleAmounts = {
        grossSalesIdr: 50_000,
        completedAt: T_SALE_EARLY,
        tenders: [{ method: "qris", amountIdr: 50_000, intentId }],
      };
      await seedPosOrder(world, orderUlid, sale);
      const refundId = await seedRefund(world, intentId, 50_000);

      const { first, second } = await deliverBoth(
        world.tenant,
        order,
        orderPaid(world, orderUlid, sale, T_SALE_EARLY),
        paymentRefunded(world, refundId, intentId, 50_000),
      );
      expect(first).toMatchObject({ status: "posted" });
      expect(second).toEqual(MISMATCH);
      // receipt + sale: the 50k receipt is consumed once, by the sale
      expect(await journalCount(world)).toBe(2);
      expect(await balanceOf(world, "customer_deposit")).toBe(0);
    });
  }
});

// ============================================================================
// Slice 4: settlement + MDR (legend-9pz9; design: docs/design/auto-journals.md).
// settlement.reconciled -> gateway_settlement: Dr bank net, Dr gateway_fee_expense
// fee, Cr gateway_clearing gross. edc_transaction.settled -> edc_settlement: the
// same with edc_clearing. No backing guard: the bank statement is the fact.

describe("F19 slice 4 settlement", () => {
  type SettlementOptions = {
    id?: string;
    settlementId?: string;
    settledOn?: string;
    provider?: string;
    occurredAt?: string;
    grossIdr?: number;
    feeIdr?: number;
    netSettledIdr?: number;
    outletId?: string;
    envelopeOutletId?: string;
  };

  function amountsOf(options: SettlementOptions) {
    const grossIdr = options.grossIdr ?? 100_000;
    const feeIdr = options.feeIdr ?? 700;
    return {
      grossIdr,
      feeIdr,
      netSettledIdr: options.netSettledIdr ?? grossIdr - feeIdr,
    };
  }

  // occurredAt defaults to another day than settledOn on purpose.
  function settlementReconciled(
    world: World,
    options: SettlementOptions = {},
  ): EventEnvelope {
    const settlementId = options.settlementId ?? randomUUID();
    const event = envelope(world, {
      ...(options.id === undefined ? {} : { id: options.id }),
      name: "settlement.reconciled",
      aggregateType: "settlement",
      aggregateId: settlementId,
      occurredAt: options.occurredAt ?? "2026-10-17T05:00:00.000Z",
      payload: {
        settlementId,
        provider: options.provider ?? "doit",
        outletId: options.outletId ?? world.outletId,
        settledOn: options.settledOn ?? "2026-10-15",
        ...amountsOf(options),
      },
    });
    return options.envelopeOutletId === undefined
      ? event
      : {
          ...event,
          outletId: options.envelopeOutletId as EventEnvelope["outletId"],
        };
  }

  function edcSettled(
    world: World,
    options: SettlementOptions = {},
  ): EventEnvelope {
    const settlementBatchId = options.settlementId ?? randomUUID();
    return envelope(world, {
      ...(options.id === undefined ? {} : { id: options.id }),
      name: "edc_transaction.settled",
      aggregateType: "edc_transaction",
      aggregateId: settlementBatchId,
      occurredAt: options.occurredAt ?? "2026-10-17T05:00:00.000Z",
      payload: {
        settlementBatchId,
        terminalId: randomUUID(),
        outletId: options.outletId ?? world.outletId,
        settledOn: options.settledOn ?? "2026-10-15",
        ...amountsOf(options),
      },
    });
  }

  it("AJ-SET-01 gateway settlement: Dr bank net, Dr gateway_fee_expense fee, Cr gateway_clearing gross, on settledOn", async () => {
    const world = await makeWorld();

    const result = await post(
      world,
      settlementReconciled(world, {
        grossIdr: 100_000,
        feeIdr: 700,
        netSettledIdr: 99_300,
      }),
    );
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "bank", debit: 99_300, credit: 0 },
      { role: "gateway_clearing", debit: 0, credit: 100_000 },
      { role: "gateway_fee_expense", debit: 700, credit: 0 },
    ]);
    const entry = await entryOf(world, result.journalEntryId);
    expect(entry.entry_date).toBe("2026-10-15");
    expect(entry.late_adjustment_from).toBeNull();
    expect(result.entryDate).toBe("2026-10-15");
    await expectBalanced(world, result.journalEntryId);
  });

  it("AJ-SET-02 EDC settlement: same shape against edc_clearing, on settledOn", async () => {
    const world = await makeWorld();

    const result = await post(
      world,
      edcSettled(world, { grossIdr: 250_000, feeIdr: 1_750 }),
    );
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "bank", debit: 248_250, credit: 0 },
      { role: "edc_clearing", debit: 0, credit: 250_000 },
      { role: "gateway_fee_expense", debit: 1_750, credit: 0 },
    ]);
    expect((await entryOf(world, result.journalEntryId)).entry_date).toBe(
      "2026-10-15",
    );
    await expectBalanced(world, result.journalEntryId);
  });

  it("AJ-SET-03 a zero fee posts two lines only: Dr bank / Cr clearing (gateway and EDC)", async () => {
    const world = await makeWorld();

    const gateway = await post(
      world,
      settlementReconciled(world, { grossIdr: 40_000, feeIdr: 0 }),
    );
    expect(await linesOf(world, gateway.journalEntryId)).toEqual([
      { role: "bank", debit: 40_000, credit: 0 },
      { role: "gateway_clearing", debit: 0, credit: 40_000 },
    ]);
    const edc = await post(
      world,
      edcSettled(world, { grossIdr: 60_000, feeIdr: 0 }),
    );
    expect(await linesOf(world, edc.journalEntryId)).toEqual([
      { role: "bank", debit: 60_000, credit: 0 },
      { role: "edc_clearing", debit: 0, credit: 60_000 },
    ]);
  });

  it("AJ-SET-04 the entry date is the settledOn business date, not the event instant", async () => {
    // Outlet cutoff 08:00 Asia/Jakarta. Every case below has an event instant
    // whose own business date (or calendar date) differs from settledOn, so
    // only the payload's settledOn can produce the expected entry date.
    const world = await makeWorld(shared, { cutoff: "08:00" });

    // settledOn month-end 2026-10-31; the event instant 2026-11-01T02:00Z is
    // 09:00 Jakarta, past the cutoff: business date 2026-11-01.
    const result = await post(
      world,
      settlementReconciled(world, {
        settledOn: "2026-10-31",
        occurredAt: "2026-11-01T02:00:00.000Z",
      }),
    );
    expect(result.entryDate).toBe("2026-10-31");
    expect((await entryOf(world, result.journalEntryId)).entry_date).toBe(
      "2026-10-31",
    );
    expect(result.lateAdjustmentFrom).toBeNull();

    // settledOn 2026-10-30; the event instant 2026-11-01T00:00Z is 07:00
    // Jakarta, before the 08:00 cutoff: business date 2026-10-31 (calendar
    // date 2026-11-01). Neither equals settledOn.
    const cutoff = await post(
      world,
      edcSettled(world, {
        settledOn: "2026-10-30",
        occurredAt: "2026-11-01T00:00:00.000Z",
      }),
    );
    expect((await entryOf(world, cutoff.journalEntryId)).entry_date).toBe(
      "2026-10-30",
    );

    // settledOn 2026-09-30; the event instant 2026-10-01T02:00Z is 09:00
    // Jakarta: business date 2026-10-01. 2026-09 is open in this world.
    const early = await post(
      world,
      edcSettled(world, {
        settledOn: "2026-09-30",
        occurredAt: "2026-10-01T02:00:00.000Z",
      }),
    );
    expect((await entryOf(world, early.journalEntryId)).entry_date).toBe(
      "2026-09-30",
    );
  });

  it("AJ-SET-05 the same settlement under another event id (or replayed) posts once", async () => {
    const world = await makeWorld();
    const settlementId = randomUUID();
    const first = settlementReconciled(world, { settlementId });
    const result = await post(world, first);

    for (const again of [first, settlementReconciled(world, { settlementId })])
      expect(await deliver(world.tenant, again)).toEqual({
        status: "already_posted",
        journalEntryId: result.journalEntryId,
      });
    expect(await journalCount(world)).toBe(1);

    const batchId = randomUUID();
    const edc = await post(world, edcSettled(world, { settlementId: batchId }));
    expect(
      await deliver(world.tenant, edcSettled(world, { settlementId: batchId })),
    ).toEqual({ status: "already_posted", journalEntryId: edc.journalEntryId });
    expect(await journalCount(world)).toBe(2);
  });

  it("AJ-SET-06 gross != net + fee parks non-retryable AUTO_JOURNAL_PAYLOAD_INVALID and is not retried", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);

    for (const event of [
      settlementReconciled(world, {
        grossIdr: 100_000,
        feeIdr: 700,
        netSettledIdr: 99_000,
      }),
      edcSettled(world, {
        grossIdr: 100_000,
        feeIdr: 700,
        netSettledIdr: 100_000,
      }),
    ])
      expect(await deliver(tenant, event)).toEqual({
        status: "parked",
        code: "AUTO_JOURNAL_PAYLOAD_INVALID",
        retryable: false,
      });
    expect(await journalCount(world)).toBe(0);
    const parked = await parkedByCode(
      tenant,
      "AUTO_JOURNAL_PAYLOAD_INVALID",
      world.outletId,
    );
    expect(parked.map((row) => row.event_name).sort()).toEqual([
      "edc_transaction.settled",
      "settlement.reconciled",
    ]);
    expect(parked.every((row) => row.retryable === false)).toBe(true);

    // The sweep never retries a non-retryable row.
    expect(await sweep(tenant)).toEqual({
      posted: 0,
      stillParked: 0,
      failed: 0,
    });
    expect(await journalCount(world)).toBe(0);
  });

  it("AJ-SET-07 an envelope outlet that differs from the payload outlet parks non-retryable AUTO_JOURNAL_PAYLOAD_INVALID", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    // A real second outlet of the same tenant, in another legal entity: the
    // mismatch is about the two ids differing, not about an unknown outlet.
    const other = await makeWorld(tenant);
    expect(other.outletId).not.toBe(world.outletId);

    const event = settlementReconciled(world, { outletId: other.outletId });
    expect(event.outletId).toBe(world.outletId);
    const outcome = await deliver(tenant, event);
    expect(outcome).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(0);
    expect(await journalCount(other)).toBe(0);
    const parked = await parkedByCode(
      tenant,
      "AUTO_JOURNAL_PAYLOAD_INVALID",
      world.outletId,
    );
    expect(parked.map((row) => row.event_name)).toEqual([
      "settlement.reconciled",
    ]);
    expect(parked.every((row) => row.retryable === false)).toBe(true);

    // Not retried by the sweep.
    expect(await sweep(tenant)).toEqual({
      posted: 0,
      stillParked: 0,
      failed: 0,
    });
    expect(await journalCount(world)).toBe(0);
    expect(await journalCount(other)).toBe(0);
  });

  it("AJ-SET-08 settledOn in a closed month rolls to the first open day, flagged with settledOn, with an audit row", async () => {
    const world = await makeWorld();
    await closePeriods(world, ["2026-10"]);

    const result = await post(
      world,
      settlementReconciled(world, { settledOn: "2026-10-15" }),
    );
    expect(result.entryDate).toBe("2026-11-01");
    expect(result.lateAdjustmentFrom).toBe("2026-10-15");
    const entry = await entryOf(world, result.journalEntryId);
    expect(entry.entry_date).toBe("2026-11-01");
    expect(entry.late_adjustment_from).toBe("2026-10-15");
    expect(await lateAuditCount(world.tenant, result.journalEntryId)).toBe(1);
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "bank", debit: 99_300, credit: 0 },
      { role: "gateway_clearing", debit: 0, credit: 100_000 },
      { role: "gateway_fee_expense", debit: 700, credit: 0 },
    ]);

    const edc = await post(
      world,
      edcSettled(world, { settledOn: "2026-10-20" }),
    );
    expect(edc.entryDate).toBe("2026-11-01");
    expect(edc.lateAdjustmentFrom).toBe("2026-10-20");
  });

  it("AJ-SET-09 a missing bank or fee-expense mapping parks retryable ACCOUNT_MAPPING_MISSING; after mapping the sweep posts once", async () => {
    for (const role of ["bank", "gateway_fee_expense"] as const) {
      const tenant = await makeTenant();
      const world = await makeWorld(tenant, { unmapped: [role] });
      const settlementId = randomUUID();
      const event = settlementReconciled(world, { settlementId });

      expect(await deliver(tenant, event)).toEqual({
        status: "parked",
        code: "ACCOUNT_MAPPING_MISSING",
        retryable: true,
      });
      expect(await journalCount(world)).toBe(0);
      const parked = await parkedOf(tenant, `aj:settlement:${settlementId}`);
      expect(parked).toHaveLength(1);
      expect(parked[0]).toMatchObject({
        error_code: "ACCOUNT_MAPPING_MISSING",
        retryable: true,
        event_name: "settlement.reconciled",
        outlet_id: world.outletId,
      });

      await mapRole(world, role, world.accounts[role]);
      expect(await sweep(tenant)).toEqual({
        posted: 1,
        stillParked: 0,
        failed: 0,
      });
      expect(await journalCount(world)).toBe(1);
      expect(
        await parkedOf(tenant, `aj:settlement:${settlementId}`),
      ).toHaveLength(0);
      expect(await balanceOf(world, "bank")).toBe(99_300);
      expect(await balanceOf(world, "gateway_clearing")).toBe(-100_000);
      expect((await deliver(tenant, event)).status).toBe("already_posted");
    }
  });

  it("AJ-SET-10 an EDC mapping failure parks under the batch key aj:edc-settlement:<batchId>", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant, { unmapped: ["edc_clearing"] });
    const batchId = randomUUID();

    expect(
      await deliver(tenant, edcSettled(world, { settlementId: batchId })),
    ).toEqual({
      status: "parked",
      code: "ACCOUNT_MAPPING_MISSING",
      retryable: true,
    });
    const parked = await parkedOf(tenant, `aj:edc-settlement:${batchId}`);
    expect(parked).toHaveLength(1);
    expect(parked[0]!.event_name).toBe("edc_transaction.settled");

    await mapRole(world, "edc_clearing", world.accounts.edc_clearing);
    expect(await sweep(tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    expect(await balanceOf(world, "edc_clearing")).toBe(-100_000);
  });

  it("AJ-SET-11 no backing guard: a settlement with no prior receipt or clearing balance still posts", async () => {
    const world = await makeWorld();
    expect(await balanceOf(world, "gateway_clearing")).toBe(0);

    await post(world, settlementReconciled(world));
    expect(await balanceOf(world, "gateway_clearing")).toBe(-100_000);
  });

  it("AJ-SET-17 settlement.reconciled with an edc_ provider parks non-retryable AUTO_JOURNAL_PAYLOAD_INVALID: EDC payouts use edc_transaction.settled", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);

    expect(
      await deliver(
        tenant,
        settlementReconciled(world, { provider: "edc_bca" }),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(0);
    const parked = await parkedByCode(
      tenant,
      "AUTO_JOURNAL_PAYLOAD_INVALID",
      world.outletId,
    );
    expect(parked.map((row) => row.event_name)).toEqual([
      "settlement.reconciled",
    ]);
    expect(parked.every((row) => row.retryable === false)).toBe(true);
    expect(await sweep(tenant)).toEqual({
      posted: 0,
      stillParked: 0,
      failed: 0,
    });
    expect(await journalCount(world)).toBe(0);

    // The same payout through its own event posts.
    const edc = await post(world, edcSettled(world));
    expect(await journalCount(world)).toBe(1);
    expect(edc.entryDate).toBe("2026-10-15");
  });

  describe("shared payload schemas", () => {
    const base = {
      settlementId: randomUUID(),
      provider: "doit",
      outletId: randomUUID(),
      settledOn: "2026-10-15",
      grossIdr: 100_000,
      feeIdr: 700,
      netSettledIdr: 99_300,
    };
    const edcBase = {
      settlementBatchId: randomUUID(),
      terminalId: randomUUID(),
      outletId: randomUUID(),
      settledOn: "2026-10-15",
      grossIdr: 100_000,
      feeIdr: 700,
      netSettledIdr: 99_300,
    };

    it("AJ-SET-12 a valid payload parses; a zero fee is allowed", () => {
      expect(settlementReconciledPayloadSchema.safeParse(base).success).toBe(
        true,
      );
      expect(
        edcTransactionSettledPayloadSchema.safeParse(edcBase).success,
      ).toBe(true);
      expect(
        settlementReconciledPayloadSchema.safeParse({
          ...base,
          feeIdr: 0,
          netSettledIdr: 100_000,
        }).success,
      ).toBe(true);
    });

    it("AJ-SET-13 strict: an unknown key is rejected", () => {
      expect(
        settlementReconciledPayloadSchema.safeParse({ ...base, extra: 1 })
          .success,
      ).toBe(false);
      expect(
        edcTransactionSettledPayloadSchema.safeParse({ ...edcBase, extra: 1 })
          .success,
      ).toBe(false);
    });

    it("AJ-SET-14 a negative fee or net, a zero gross, or a fractional amount is rejected", () => {
      for (const bad of [
        { feeIdr: -1, netSettledIdr: 100_001 },
        { grossIdr: 0, feeIdr: 0, netSettledIdr: 0 },
        { grossIdr: 100_000.5, feeIdr: 0.5, netSettledIdr: 100_000 },
        { grossIdr: 100, feeIdr: 200, netSettledIdr: -100 },
      ]) {
        expect(
          settlementReconciledPayloadSchema.safeParse({ ...base, ...bad })
            .success,
        ).toBe(false);
        expect(
          edcTransactionSettledPayloadSchema.safeParse({ ...edcBase, ...bad })
            .success,
        ).toBe(false);
      }
    });

    it("AJ-SET-15 gross != net + fee is rejected with a message naming the fields", () => {
      for (const result of [
        settlementReconciledPayloadSchema.safeParse({
          ...base,
          netSettledIdr: 99_000,
        }),
        edcTransactionSettledPayloadSchema.safeParse({
          ...edcBase,
          netSettledIdr: 99_000,
        }),
      ]) {
        expect(result.success).toBe(false);
        if (result.success) continue;
        const message = result.error.issues
          .map((issue) => issue.message)
          .join(" ");
        expect(message).toContain("grossIdr");
        expect(message).toContain("netSettledIdr");
        expect(message).toContain("feeIdr");
      }
    });

    it("AJ-SET-16 a malformed id, provider or settledOn is rejected", () => {
      for (const bad of [
        { settlementId: "bukan-uuid" },
        { provider: "" },
        { provider: "x".repeat(65) },
        { settledOn: "2026-10-15T05:00:00Z" },
        { settledOn: "15-10-2026" },
      ])
        expect(
          settlementReconciledPayloadSchema.safeParse({ ...base, ...bad })
            .success,
        ).toBe(false);
      expect(
        edcTransactionSettledPayloadSchema.safeParse({
          ...edcBase,
          terminalId: "bukan-uuid",
        }).success,
      ).toBe(false);
    });

    it("AJ-SET-17b an edc_ provider is rejected with the pointer to edc_transaction.settled", () => {
      for (const provider of ["edc_bca", "edc_mandiri", "edc_"]) {
        const result = settlementReconciledPayloadSchema.safeParse({
          ...base,
          provider,
        });
        expect(result.success).toBe(false);
        if (result.success) continue;
        expect(
          result.error.issues.map((issue) => issue.message).join(" "),
        ).toContain("EDC payouts use edc_transaction.settled");
      }
      // legend-x9w2: provider is an allow-list; only listed gateway
      // providers are valid, so EDC bank codes and unknown names fail too.
      for (const provider of ["doit", "duitku"])
        expect(
          settlementReconciledPayloadSchema.safeParse({ ...base, provider })
            .success,
        ).toBe(true);
      for (const provider of [
        "bca",
        "mandiri",
        "bni",
        "bjb",
        "xendit",
        "medc_x",
      ])
        expect(
          settlementReconciledPayloadSchema.safeParse({ ...base, provider })
            .success,
        ).toBe(false);
    });
  });
});

// ============================================================================
// Slice 3: QR sale, revenue split, total-0 order.paid (legend-9pz9,
// legend-kej3, legend-fbms; design: docs/design/auto-journals.md sections 1, 6,
// 10). A QR pay-first sale is an `orders` row (channel qr, payment_mode
// pay_first, fired_at set, payment_intent_id pinned to the intent that paid,
// null when nothing was left to pay) with no pos_orders row; its order.paid
// carries the split of the row, paidDepositIdr = deposit_applied_idr and one
// gateway tender of total - DP (none when that is 0).
//
// Assumptions (the contract between the emitter and the consumer):
// - The sale time of a QR sale is orders.fired_at; a sale at the same instant
//   as a payout counts as earlier (as for POS).
// - An order.paid whose order is a QR order that is not pay-first, has no
//   fired_at, whose pinned intent is not paid on the order's payment link, or
//   whose payload differs from the split of the row parks non-retryable; the
//   exact error code is not asserted except for the amounts mismatch of the
//   F4 ordering tests (POSTING_AMOUNTS_MISMATCH, as for POS).
// - A QR pay-first order never has a final void row (pos_order_voids has an
//   FK to pos_orders), so an order.voided of one parks non-retryable
//   AUTO_JOURNAL_PAYLOAD_INVALID; the QR void is not supported (design).

describe("F19 slice 3 QR sale and total-0 order.paid", () => {
  const T_EARLY = "2026-10-15T05:00:00.000Z"; // before REFUND_DAY
  const T_LATE = "2026-10-17T05:00:00.000Z"; // after REFUND_DAY
  const AMOUNTS_MISMATCH = {
    status: "parked",
    code: "POSTING_AMOUNTS_MISMATCH",
    retryable: false,
  } as const;

  type QrSale = {
    subtotalIdr: number;
    discountIdr?: number;
    serviceChargeIdr?: number;
    taxIdr?: number;
    roundingIdr?: number;
    pricesIncludeTax?: boolean;
    depositIdr?: number;
    tableSessionId?: string;
    /** orders.fired_at; null = never fired. */
    firedAt: string | null;
    /** The intent pinned on the order (null = nothing left to pay). */
    intentId?: string | null;
    /** Whose payment link the order carries (default: the pinned intent's). */
    linkOfIntentId?: string | null;
    paymentMode?: "pay_first" | "open_bill";
  };

  function qrTotal(sale: QrSale): number {
    const base = sale.subtotalIdr - (sale.discountIdr ?? 0);
    return sale.pricesIncludeTax
      ? base + (sale.roundingIdr ?? 0)
      : base +
          (sale.serviceChargeIdr ?? 0) +
          (sale.taxIdr ?? 0) +
          (sale.roundingIdr ?? 0);
  }

  /** The revenue split of the row, from the spec identities. */
  function qrSplit(sale: QrSale) {
    return {
      grossSalesIdr: sale.pricesIncludeTax
        ? sale.subtotalIdr - (sale.serviceChargeIdr ?? 0) - (sale.taxIdr ?? 0)
        : sale.subtotalIdr,
      discountIdr: sale.discountIdr ?? 0,
      serviceChargeIdr: sale.serviceChargeIdr ?? 0,
      pbjtIdr: sale.taxIdr ?? 0,
      roundingIdr: sale.roundingIdr ?? 0,
      totalIdr: qrTotal(sale),
    };
  }

  async function linkOfIntent(world: World, intentId: string): Promise<string> {
    return asTenant(world.tenant, async (client) => {
      const { rows } = await client.query<{ payment_link_id: string }>(
        "SELECT payment_link_id FROM payment_intents WHERE tenant_id = $1 AND id = $2",
        [world.tenant.id, intentId],
      );
      return rows[0]!.payment_link_id;
    });
  }

  async function seedQrOrder(
    world: World,
    orderUlid: string,
    sale: QrSale,
  ): Promise<void> {
    const linkId =
      (sale.linkOfIntentId ?? sale.intentId) == null
        ? null
        : await linkOfIntent(world, (sale.linkOfIntentId ?? sale.intentId)!);
    await asTenant(world.tenant, (client) =>
      client.query(
        `INSERT INTO orders
           (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
            subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
            prices_include_tax, status, business_date, placed_at, fired_at,
            deposit_applied_idr, table_session_id, payment_link_id, payment_link_token_sealed,
            payment_intent_id)
         VALUES ($1, $2, $3, $4, 'qr', 'takeaway', $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, '2026-10-15', now(), $14, $15, $16, $17, $18, $19)`,
        [
          ulidToUuid(orderUlid),
          world.tenant.id,
          world.outletId,
          `QR-${short()}`,
          sale.paymentMode ?? "pay_first",
          sale.subtotalIdr,
          sale.discountIdr ?? 0,
          sale.serviceChargeIdr ?? 0,
          sale.taxIdr ?? 0,
          sale.roundingIdr ?? 0,
          qrTotal(sale),
          sale.pricesIncludeTax ?? false,
          sale.firedAt === null ? "awaiting_payment" : "sent",
          sale.firedAt,
          sale.depositIdr ?? 0,
          sale.tableSessionId ?? null,
          linkId,
          linkId === null ? null : "sealed",
          sale.intentId ?? null,
        ],
      ),
    );
  }

  /** The order.paid a fired QR order emits (design G1). */
  function qrOrderPaid(
    world: World,
    orderUlid: string,
    sale: QrSale,
    override: Record<string, unknown> = {},
  ): EventEnvelope {
    const split = qrSplit(sale);
    const depositIdr = sale.depositIdr ?? 0;
    const dueIdr = split.totalIdr - depositIdr;
    const paidAt = sale.firedAt ?? DAY;
    return envelope(world, {
      name: "order.paid",
      aggregateType: "order",
      aggregateId: orderUlid,
      occurredAt: paidAt,
      payload: {
        orderId: orderUlid,
        outletId: world.outletId,
        businessDate: "2026-10-15",
        channel: "qr",
        serviceType: "takeaway",
        ...split,
        paidCashIdr: 0,
        paidGatewayIdr: dueIdr,
        paidEdcIdr: 0,
        paidPointsIdr: 0,
        paidDepositIdr: depositIdr,
        tenders: dueIdr > 0 ? [{ method: "qris", amountIdr: dueIdr }] : [],
        shiftId: null,
        cashierId: null,
        deviceId: null,
        paidAt,
        ...override,
      },
    });
  }

  /** A paid gateway intent whose receipt is booked. */
  async function bookedIntent(world: World, amountIdr: number) {
    const intentId = await seedIntent(world, { amountIdr });
    await post(world, paymentPaid(world, intentId, amountIdr));
    return intentId;
  }

  async function parkedCountOfOutlet(world: World): Promise<number> {
    return asTenant(world.tenant, async (client) => {
      const { rows } = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM auto_journal_parked WHERE tenant_id = $1 AND outlet_id = $2",
        [world.tenant.id, world.outletId],
      );
      return Number(rows[0]!.n);
    });
  }

  /** 100k + 10% PBJT, paid by one QRIS/VA intent. */
  const gatewayQr = (intentId: string, firedAt: string = DAY): QrSale => ({
    subtotalIdr: 100_000,
    taxIdr: 10_000,
    intentId,
    firedAt,
  });

  // ---- G1/G2: the QR sale journal -------------------------------------------

  it("AJ-QR-01 a QR sale paid by a gateway intent with a booked receipt debits customer_deposit and nets it to 0", async () => {
    const world = await makeWorld();
    const intentId = await bookedIntent(world, 110_000);
    const orderUlid = createUlid();
    const sale = gatewayQr(intentId);
    await seedQrOrder(world, orderUlid, sale);

    const result = await post(world, qrOrderPaid(world, orderUlid, sale));
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 110_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
    ]);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await balanceOf(world, "gateway_clearing")).toBe(110_000);
    expect(await parkedCountOfOutlet(world)).toBe(0);
  });

  it("AJ-QR-02 a QR sale at exclusive prices books discount, service charge, PBJT and rounding from the order row", async () => {
    const world = await makeWorld();
    const intentId = await bookedIntent(world, 105_000);
    const orderUlid = createUlid();
    const sale: QrSale = {
      subtotalIdr: 100_000,
      discountIdr: 10_000,
      serviceChargeIdr: 5_000,
      taxIdr: 9_500,
      roundingIdr: 500,
      intentId,
      firedAt: DAY,
    };
    await seedQrOrder(world, orderUlid, sale);

    const result = await post(world, qrOrderPaid(world, orderUlid, sale));
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 105_000, credit: 0 },
      { role: "rounding", debit: 0, credit: 500 },
      { role: "sales_discount", debit: 10_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "service_charge", debit: 0, credit: 5_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 9_500 },
    ]);
    await expectBalanced(world, result.journalEntryId);
  });

  it("AJ-QR-03 a QR sale at inclusive prices (harga nett) books gross sales as subtotal less service charge and tax", async () => {
    const world = await makeWorld();
    const intentId = await bookedIntent(world, 110_000);
    const orderUlid = createUlid();
    const sale: QrSale = {
      pricesIncludeTax: true,
      subtotalIdr: 110_000,
      serviceChargeIdr: 5_000,
      taxIdr: 10_000,
      intentId,
      firedAt: DAY,
    };
    await seedQrOrder(world, orderUlid, sale);

    const result = await post(world, qrOrderPaid(world, orderUlid, sale));
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 110_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 95_000 },
      { role: "service_charge", debit: 0, credit: 5_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
    ]);
    await expectBalanced(world, result.journalEntryId);
  });

  it("AJ-QR-04 a QR sale whose intent has no receipt (pre-cutover) debits gateway_clearing, not customer_deposit", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, { amountIdr: 110_000 });
    const orderUlid = createUlid();
    const sale = gatewayQr(intentId);
    await seedQrOrder(world, orderUlid, sale);

    const result = await post(world, qrOrderPaid(world, orderUlid, sale));
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "gateway_clearing", debit: 110_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
    ]);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-QR-05 a QR sale whose receipt is still in the outbox parks AUTO_JOURNAL_RECEIPT_PENDING; after the receipt the sweep posts it via customer_deposit", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const intentId = await seedIntent(world, { amountIdr: 110_000 });
    const outboxId = await seedUndeliveredReceipt(world, intentId, 110_000);
    const orderUlid = createUlid();
    const sale = gatewayQr(intentId);
    await seedQrOrder(world, orderUlid, sale);

    expect(await deliver(tenant, qrOrderPaid(world, orderUlid, sale))).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_PENDING",
      retryable: true,
    });
    expect(await journalCount(world)).toBe(0);

    await markDelivered(world, outboxId);
    await post(world, paymentPaid(world, intentId, 110_000));
    expect(await sweep(tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    const saleId = await journalIdOf(world, `aj:sale:${orderUlid}`);
    expect(await linesOf(world, saleId)).toEqual([
      { role: "customer_deposit", debit: 110_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
    ]);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await parkedOf(tenant, `aj:sale:${orderUlid}`)).toHaveLength(0);
  });

  it("AJ-QR-06 a QR sale fully covered by the reservation DP (no tender, no intent) moves the money out of customer_deposit", async () => {
    const world = await makeWorld();
    const { sessionId, intentId } = await seedSeatedDeposit(world, 110_000);
    await post(world, paymentPaid(world, intentId, 110_000));
    expect(await balanceOf(world, "customer_deposit")).toBe(-110_000);
    const orderUlid = createUlid();
    const sale: QrSale = {
      subtotalIdr: 100_000,
      taxIdr: 10_000,
      depositIdr: 110_000,
      tableSessionId: sessionId,
      intentId: null,
      firedAt: DAY,
    };
    await seedQrOrder(world, orderUlid, sale);
    const event = qrOrderPaid(world, orderUlid, sale);
    expect(event.payload).toMatchObject({
      tenders: [],
      paidGatewayIdr: 0,
      paidDepositIdr: 110_000,
    });

    const result = await post(world, event);
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 110_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
    ]);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-QR-07 a QR sale paid by DP 60k plus a gateway intent 50k debits customer_deposit for both", async () => {
    const world = await makeWorld();
    const { sessionId, intentId: dpIntent } = await seedSeatedDeposit(
      world,
      60_000,
    );
    await post(world, paymentPaid(world, dpIntent, 60_000));
    const gatewayIntent = await bookedIntent(world, 50_000);
    const orderUlid = createUlid();
    const sale: QrSale = {
      subtotalIdr: 100_000,
      taxIdr: 10_000,
      depositIdr: 60_000,
      tableSessionId: sessionId,
      intentId: gatewayIntent,
      firedAt: DAY,
    };
    await seedQrOrder(world, orderUlid, sale);

    const result = await post(world, qrOrderPaid(world, orderUlid, sale));
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 110_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
    ]);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-QR-08 a QR order.paid whose payload differs from the split of the order row parks non-retryable and posts nothing", async () => {
    const world = await makeWorld();
    const intentId = await bookedIntent(world, 110_000);
    const orderUlid = createUlid();
    const sale = gatewayQr(intentId);
    await seedQrOrder(world, orderUlid, sale);

    // Self-consistent payload, but 1k less gross sales than the row.
    const result = await deliver(
      world.tenant,
      qrOrderPaid(world, orderUlid, sale, {
        grossSalesIdr: 99_000,
        totalIdr: 109_000,
        paidGatewayIdr: 109_000,
        tenders: [{ method: "qris", amountIdr: 109_000 }],
      }),
    );
    expect(result).toMatchObject({ status: "parked", retryable: false });
    expect(await journalCount(world)).toBe(1); // the receipt only
    expect(await parkedOf(world.tenant, `aj:sale:${orderUlid}`)).toHaveLength(
      1,
    );
  });

  it("AJ-QR-09 a QR sale whose pinned intent is not paid on the order's payment link parks non-retryable and posts nothing", async () => {
    const world = await makeWorld();
    const intentId = await bookedIntent(world, 110_000);
    const otherIntent = await bookedIntent(world, 110_000);
    const orderUlid = createUlid();
    // Pinned to one intent, but the order's link belongs to another.
    const sale: QrSale = {
      ...gatewayQr(intentId),
      linkOfIntentId: otherIntent,
    };
    await seedQrOrder(world, orderUlid, sale);

    const result = await deliver(
      world.tenant,
      qrOrderPaid(world, orderUlid, sale),
    );
    expect(result).toMatchObject({ status: "parked", retryable: false });
    expect(await journalCount(world)).toBe(2); // the two receipts only
  });

  it("AJ-QR-10 a QR sale with money due but no pinned intent parks non-retryable and posts nothing", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    const sale: QrSale = {
      subtotalIdr: 100_000,
      taxIdr: 10_000,
      intentId: null,
      firedAt: DAY,
    };
    await seedQrOrder(world, orderUlid, sale);

    const result = await deliver(
      world.tenant,
      qrOrderPaid(world, orderUlid, sale),
    );
    expect(result).toMatchObject({ status: "parked", retryable: false });
    expect(await journalCount(world)).toBe(0);
  });

  for (const kind of ["never fired", "open bill"] as const) {
    it(`AJ-QR-11 an order.paid of a QR order that is ${kind} is not a sale: parked non-retryable, nothing posted`, async () => {
      const world = await makeWorld();
      const intentId = await bookedIntent(world, 110_000);
      const orderUlid = createUlid();
      const sale: QrSale =
        kind === "never fired"
          ? { ...gatewayQr(intentId), firedAt: null }
          : { ...gatewayQr(intentId), paymentMode: "open_bill" };
      await seedQrOrder(world, orderUlid, sale);

      const result = await deliver(
        world.tenant,
        qrOrderPaid(world, orderUlid, sale),
      );
      expect(result).toMatchObject({ status: "parked", retryable: false });
      expect(await journalCount(world)).toBe(1); // the receipt only
    });
  }

  // ---- G3: total-0 order.paid ----------------------------------------------

  it("AJ-QR-12 an order.paid with total 0 and every amount 0 (POS) is ignored: no journal, nothing parked", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    const sale: SaleAmounts = { grossSalesIdr: 0, tenders: [] };
    await seedPosOrder(world, orderUlid, sale);

    expect(
      await deliver(world.tenant, orderPaid(world, orderUlid, sale)),
    ).toEqual({ status: "ignored" });
    expect(await journalCount(world)).toBe(0);
    expect(await parkedOf(world.tenant, `aj:sale:${orderUlid}`)).toHaveLength(
      0,
    );
    expect(await parkedCountOfOutlet(world)).toBe(0);
  });

  it("AJ-QR-13 an order.paid with total 0 and every amount 0 (QR) is ignored: no journal, nothing parked", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    const sale: QrSale = { subtotalIdr: 0, intentId: null, firedAt: DAY };
    await seedQrOrder(world, orderUlid, sale);
    const event = qrOrderPaid(world, orderUlid, sale);
    expect(event.payload).toMatchObject({ totalIdr: 0, tenders: [] });

    expect(await deliver(world.tenant, event)).toEqual({ status: "ignored" });
    expect(await journalCount(world)).toBe(0);
    expect(await parkedCountOfOutlet(world)).toBe(0);
  });

  it("AJ-QR-14 a full comp (gross 100k, discount 100k, total 0) still posts the discount against sales (POS)", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    const sale: SaleAmounts = {
      grossSalesIdr: 100_000,
      discountIdr: 100_000,
      tenders: [],
    };
    await seedPosOrder(world, orderUlid, sale);

    const result = await post(world, orderPaid(world, orderUlid, sale));
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "sales_discount", debit: 100_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
    ]);
    await expectBalanced(world, result.journalEntryId);
  });

  it("AJ-QR-15 a full comp (gross 100k, discount 100k, total 0) still posts the discount against sales (QR)", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    const sale: QrSale = {
      subtotalIdr: 100_000,
      discountIdr: 100_000,
      intentId: null,
      firedAt: DAY,
    };
    await seedQrOrder(world, orderUlid, sale);

    const result = await post(world, qrOrderPaid(world, orderUlid, sale));
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "sales_discount", debit: 100_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
    ]);
  });

  // ---- G4: guards bound by the QR sale time (fired_at) ---------------------

  type Order = "first-first" | "second-first";

  async function deliverBoth(
    tenant: Tenant,
    order: Order,
    first: EventEnvelope,
    second: EventEnvelope,
  ) {
    const results = {} as {
      first: AutoJournalResult;
      second: AutoJournalResult;
    };
    if (order === "first-first") {
      results.first = await deliver(tenant, first);
      results.second = await deliver(tenant, second);
    } else {
      results.second = await deliver(tenant, second);
      results.first = await deliver(tenant, first);
    }
    return results;
  }

  /**
   * A 110k receipt backs one QR sale (`kind` gateway: the pinned intent paid it;
   * `dp`: a seated reservation DP covered it) and a refund of the whole 110k
   * completed at REFUND_DAY. "first" is the sale, "second" the refund.
   */
  async function deliverQrPair(
    kind: "gateway" | "dp",
    order: Order,
    firedAt: string,
  ) {
    const world = await makeWorld();
    let sale: QrSale;
    let intentId: string;
    if (kind === "gateway") {
      intentId = await bookedIntent(world, 110_000);
      sale = gatewayQr(intentId, firedAt);
    } else {
      const seated = await seedSeatedDeposit(world, 110_000);
      intentId = seated.intentId;
      await post(world, paymentPaid(world, intentId, 110_000));
      sale = {
        subtotalIdr: 100_000,
        taxIdr: 10_000,
        depositIdr: 110_000,
        tableSessionId: seated.sessionId,
        intentId: null,
        firedAt,
      };
    }
    const orderUlid = createUlid();
    await seedQrOrder(world, orderUlid, sale);
    const refundId = await seedRefund(world, intentId, 110_000);
    const { first, second } = await deliverBoth(
      world.tenant,
      order,
      qrOrderPaid(world, orderUlid, sale),
      paymentRefunded(world, refundId, intentId, 110_000),
    );
    return { world, sale: first, refund: second };
  }

  for (const kind of ["gateway", "dp"] as const)
    for (const order of ["first-first", "second-first"] as const) {
      const label = `${kind}, ${order === "first-first" ? "sale first" : "refund first"}`;

      it(`AJ-QR-16 (${label}) a QR sale fired before the refund posts; only the later refund parks`, async () => {
        const { world, sale, refund } = await deliverQrPair(
          kind,
          order,
          T_EARLY,
        );
        expect(sale).toMatchObject({ status: "posted" });
        expect(refund).toEqual(AMOUNTS_MISMATCH);
        // receipt + sale only
        expect(await journalCount(world)).toBe(2);
        expect(await balanceOf(world, "customer_deposit")).toBe(0);
      });

      // A sale fired after a refund of its intent is guarded for the DP kind
      // here; the gateway kind is covered by AJ-QR-22 (sale-side receipt
      // guard on a "posted" receipt).
      if (kind === "dp")
        it(`AJ-QR-17 (${label}) a QR sale fired after the refund parks; the refund posts`, async () => {
          const { world, sale, refund } = await deliverQrPair(
            kind,
            order,
            T_LATE,
          );
          expect(refund).toMatchObject({ status: "posted" });
          expect(sale).toEqual(AMOUNTS_MISMATCH);
          // receipt + refund only
          expect(await journalCount(world)).toBe(2);
          expect(await balanceOf(world, "customer_deposit")).toBe(0);
        });

      it(`AJ-QR-18 (${label}) a QR sale fired at the same instant as the refund counts as earlier: it posts, the refund parks`, async () => {
        const { world, sale, refund } = await deliverQrPair(
          kind,
          order,
          REFUND_DAY,
        );
        expect(sale).toMatchObject({ status: "posted" });
        expect(refund).toEqual(AMOUNTS_MISMATCH);
        expect(await journalCount(world)).toBe(2);
        expect(await balanceOf(world, "customer_deposit")).toBe(0);
      });
    }

  it("AJ-QR-19 a QR order that is not a pay-first sale (open bill) does not use up the receipt: the refund of the intent posts", async () => {
    const world = await makeWorld();
    const intentId = await bookedIntent(world, 110_000);
    const orderUlid = createUlid();
    await seedQrOrder(world, orderUlid, {
      ...gatewayQr(intentId, T_EARLY),
      paymentMode: "open_bill",
    });
    const refundId = await seedRefund(world, intentId, 110_000);

    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, intentId, 110_000),
      ),
    ).toMatchObject({ status: "posted" });
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-QR-20 a QR order that never fired does not use up the receipt: the refund of the intent posts", async () => {
    const world = await makeWorld();
    const intentId = await bookedIntent(world, 110_000);
    const orderUlid = createUlid();
    await seedQrOrder(world, orderUlid, {
      ...gatewayQr(intentId),
      firedAt: null,
    });
    const refundId = await seedRefund(world, intentId, 110_000);

    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, intentId, 110_000),
      ),
    ).toMatchObject({ status: "posted" });
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  // ---- G4: a gateway QR sale never spends more than its receipt left -----

  /**
   * A 100k gateway intent with a booked receipt, one QR sale pinned to it
   * (no tax, so total = subtotal = `saleIdr`) and a completed refund of
   * `refundIdr` at REFUND_DAY. "first" is the sale, "second" the refund.
   */
  async function deliverGatewaySaleAndRefund(
    order: Order,
    firedAt: string,
    saleIdr: number,
    refundIdr: number,
  ) {
    const world = await makeWorld();
    const intentId = await bookedIntent(world, 100_000);
    const sale: QrSale = { subtotalIdr: saleIdr, intentId, firedAt };
    const orderUlid = createUlid();
    await seedQrOrder(world, orderUlid, sale);
    const refundId = await seedRefund(world, intentId, refundIdr);
    const { first, second } = await deliverBoth(
      world.tenant,
      order,
      qrOrderPaid(world, orderUlid, sale),
      paymentRefunded(world, refundId, intentId, refundIdr),
    );
    return { world, orderUlid, sale: first, refund: second };
  }

  for (const order of ["first-first", "second-first"] as const) {
    const label = order === "first-first" ? "sale first" : "refund first";

    it(`AJ-QR-22 (${label}) a gateway QR sale fired after a full refund of its intent parks POSTING_AMOUNTS_MISMATCH and is not retried; the refund posts and customer_deposit never goes negative`, async () => {
      const { world, orderUlid, sale, refund } =
        await deliverGatewaySaleAndRefund(order, T_LATE, 100_000, 100_000);
      expect(refund).toMatchObject({ status: "posted" });
      expect(sale).toEqual(AMOUNTS_MISMATCH);
      expect(await parkedOf(world.tenant, `aj:sale:${orderUlid}`)).toEqual([
        expect.objectContaining({
          error_code: "POSTING_AMOUNTS_MISMATCH",
          retryable: false,
        }),
      ]);
      // receipt + refund only
      expect(await journalCount(world)).toBe(2);
      // customer_deposit is a liability: a positive debit-credit balance
      // would mean the deposit was spent twice.
      expect(await balanceOf(world, "customer_deposit")).toBe(0);
    });

    it(`AJ-QR-22 (${label}) a gateway QR sale fired at the same instant as the full refund counts as earlier: the sale posts, the refund parks`, async () => {
      const { world, sale, refund } = await deliverGatewaySaleAndRefund(
        order,
        REFUND_DAY,
        100_000,
        100_000,
      );
      expect(sale).toMatchObject({ status: "posted" });
      expect(refund).toEqual(AMOUNTS_MISMATCH);
      // receipt + sale only
      expect(await journalCount(world)).toBe(2);
      expect(await balanceOf(world, "customer_deposit")).toBe(0);
    });

    it(`AJ-QR-23 (${label}) after a 40k partial refund of a 100k intent, a 100k gateway QR sale parks POSTING_AMOUNTS_MISMATCH`, async () => {
      const { world, sale, refund } = await deliverGatewaySaleAndRefund(
        order,
        T_LATE,
        100_000,
        40_000,
      );
      expect(refund).toMatchObject({ status: "posted" });
      expect(sale).toEqual(AMOUNTS_MISMATCH);
      // receipt + refund only: 60k of the deposit is left, none was spent
      expect(await journalCount(world)).toBe(2);
      expect(await balanceOf(world, "customer_deposit")).toBe(-60_000);
    });

    // Assumption: a sale below the intent amount can be pinned to that intent
    // (the order carries the payment link of the intent and its total is
    // within the intent amount).
    it(`AJ-QR-23 (${label}) after a 40k partial refund of a 100k intent, a 60k gateway QR sale pinned to it posts and the deposit nets to 0`, async () => {
      const { world, sale, refund } = await deliverGatewaySaleAndRefund(
        order,
        T_LATE,
        60_000,
        40_000,
      );
      expect(refund).toMatchObject({ status: "posted" });
      expect(sale).toMatchObject({ status: "posted" });
      expect(await journalCount(world)).toBe(3);
      expect(await balanceOf(world, "customer_deposit")).toBe(0);
    });
  }

  it("AJ-QR-24 a QR sale whose pinned intent amount is below total minus the reservation DP parks non-retryable AUTO_JOURNAL_PAYLOAD_INVALID and posts nothing", async () => {
    const world = await makeWorld();
    // Total 110k, nothing from a DP, but the pinned intent only paid 50k.
    const intentId = await bookedIntent(world, 50_000);
    const orderUlid = createUlid();
    const sale = gatewayQr(intentId);
    await seedQrOrder(world, orderUlid, sale);

    expect(
      await deliver(world.tenant, qrOrderPaid(world, orderUlid, sale)),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(1); // the receipt only
    expect(await parkedOf(world.tenant, `aj:sale:${orderUlid}`)).toHaveLength(
      1,
    );
  });

  // ---- G4: void ------------------------------------------------------------

  function qrVoided(
    world: World,
    orderUlid: string,
    amountIdr: number,
  ): EventEnvelope {
    return envelope(world, {
      name: "order.voided",
      aggregateType: "order",
      aggregateId: orderUlid,
      occurredAt: REFUND_DAY,
      payload: {
        orderId: orderUlid,
        outletId: world.outletId,
        businessDate: "2026-10-15",
        amountIdr,
        reason: "wrong_order",
        reasonNote: "Pesanan salah",
        approvedBy: randomUUID(),
        overrideId: null,
        approvalRequestId: null,
        voidedFinalOrder: true,
        voidId: randomUUID(),
        receiptNumber: "AJ-0001",
        voidedAt: REFUND_DAY,
      },
    });
  }

  it("AJ-QR-21 an order.voided (voidedFinalOrder true) of a QR pay-first order whose voidId has no void row parks non-retryable AUTO_JOURNAL_PAYLOAD_INVALID and posts nothing", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    // A QR pay-first order never has a pos_order_voids row (no pos_orders row).
    await seedQrOrder(world, orderUlid, {
      subtotalIdr: 100_000,
      taxIdr: 10_000,
      intentId: null,
      depositIdr: 0,
      firedAt: DAY,
    });

    expect(
      await deliver(world.tenant, qrVoided(world, orderUlid, 110_000)),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(0);
  });
});

describe("legend-6bq2 POS intent sale check", () => {
  const T_EARLY = "2026-10-15T05:00:00.000Z"; // before REFUND_DAY
  const T_LATE = "2026-10-17T05:00:00.000Z"; // after REFUND_DAY
  const AMOUNTS_MISMATCH = {
    status: "parked",
    code: "POSTING_AMOUNTS_MISMATCH",
    retryable: false,
  } as const;

  type DeliveryOrder = "sale-first" | "refund-first";
  const ORDERS = ["sale-first", "refund-first"] as const;

  // A POS sale of `amountIdr` (no tax) paid by one gateway tender on `intentId`.
  const posSale = (
    intentId: string,
    amountIdr: number,
    completedAt: string,
  ): SaleAmounts => ({
    grossSalesIdr: amountIdr,
    completedAt,
    tenders: [{ method: "qris", amountIdr, intentId }],
  });

  /** A paid intent whose receipt is booked (posted). */
  async function bookedIntent(world: World, amountIdr: number) {
    const intentId = await seedIntent(world, { amountIdr });
    await post(world, paymentPaid(world, intentId, amountIdr));
    return intentId;
  }

  /**
   * A 100k intent with a posted receipt, one POS sale of `saleIdr` completed at
   * `completedAt`, and a completed refund of `refundIdr` at REFUND_DAY.
   */
  async function deliverSaleAndRefund(
    order: DeliveryOrder,
    completedAt: string,
    saleIdr: number,
    refundIdr: number,
  ) {
    const world = await makeWorld();
    const intentId = await bookedIntent(world, 100_000);
    const sale = posSale(intentId, saleIdr, completedAt);
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, sale);
    const refundId = await seedRefund(world, intentId, refundIdr);
    const saleEvent = orderPaid(world, orderUlid, sale);
    const refundEvent = paymentRefunded(world, refundId, intentId, refundIdr);
    let saleResult: AutoJournalResult;
    let refundResult: AutoJournalResult;
    if (order === "sale-first") {
      saleResult = await deliver(world.tenant, saleEvent);
      refundResult = await deliver(world.tenant, refundEvent);
    } else {
      refundResult = await deliver(world.tenant, refundEvent);
      saleResult = await deliver(world.tenant, saleEvent);
    }
    return { world, orderUlid, sale: saleResult, refund: refundResult };
  }

  for (const order of ORDERS) {
    const label = order === "sale-first" ? "sale first" : "refund first";

    it(`AJ-POSI-01 (${label}) a POS sale completed after the full refund of its intent parks POSTING_AMOUNTS_MISMATCH and is not retried; the refund posts; customer_deposit never goes below 0`, async () => {
      const { world, orderUlid, sale, refund } = await deliverSaleAndRefund(
        order,
        T_LATE,
        100_000,
        100_000,
      );
      expect(refund).toMatchObject({ status: "posted" });
      expect(sale).toEqual(AMOUNTS_MISMATCH);
      expect(await parkedOf(world.tenant, `aj:sale:${orderUlid}`)).toEqual([
        expect.objectContaining({
          error_code: "POSTING_AMOUNTS_MISMATCH",
          retryable: false,
        }),
      ]);
      // receipt + refund only
      expect(await journalCount(world)).toBe(2);
      // customer_deposit is a liability: a positive debit-credit balance
      // would mean the deposit was spent twice.
      expect(await balanceOf(world, "customer_deposit")).toBe(0);
    });

    // Assumption: a sale completed at the same instant as the refund counts as
    // earlier (same rule as QR AJ-QR-18 / AJ-QR-22).
    it(`AJ-POSI-02 (${label}) a POS sale completed at the same instant as the full refund counts as earlier: the sale posts, the refund parks`, async () => {
      const { world, sale, refund } = await deliverSaleAndRefund(
        order,
        REFUND_DAY,
        100_000,
        100_000,
      );
      expect(sale).toMatchObject({ status: "posted" });
      expect(refund).toEqual(AMOUNTS_MISMATCH);
      // receipt + sale only
      expect(await journalCount(world)).toBe(2);
      expect(await balanceOf(world, "customer_deposit")).toBe(0);
    });

    it(`AJ-POSI-03 (${label}) after a 40k partial refund of a 100k intent, a 100k POS sale tender parks POSTING_AMOUNTS_MISMATCH`, async () => {
      const { world, sale, refund } = await deliverSaleAndRefund(
        order,
        T_LATE,
        100_000,
        40_000,
      );
      expect(refund).toMatchObject({ status: "posted" });
      expect(sale).toEqual(AMOUNTS_MISMATCH);
      // receipt + refund only: 60k of the deposit is left, none was spent
      expect(await journalCount(world)).toBe(2);
      expect(await balanceOf(world, "customer_deposit")).toBe(-60_000);
    });

    it(`AJ-POSI-03 (${label}) after a 40k partial refund of a 100k intent, a 60k POS sale tender posts and the deposit nets to 0`, async () => {
      const { world, sale, refund } = await deliverSaleAndRefund(
        order,
        T_LATE,
        60_000,
        40_000,
      );
      expect(refund).toMatchObject({ status: "posted" });
      expect(sale).toMatchObject({ status: "posted" });
      expect(await journalCount(world)).toBe(3);
      expect(await balanceOf(world, "customer_deposit")).toBe(0);
    });

    // Two 60k sales on one 100k intent: only 100k exists, so the sale with the
    // later completed_at parks whatever the delivery order.
    it(`AJ-POSI-04 (${order === "sale-first" ? "earlier sale first" : "later sale first"}) two 60k POS sales on one 100k intent: the later one by completed_at parks, the earlier posts`, async () => {
      const world = await makeWorld();
      const intentId = await bookedIntent(world, 100_000);
      const earlyUlid = createUlid();
      const lateUlid = createUlid();
      const early = posSale(intentId, 60_000, T_EARLY);
      const late = posSale(intentId, 60_000, T_LATE);
      await seedPosOrder(world, earlyUlid, early);
      await seedPosOrder(world, lateUlid, late);
      const earlyEvent = orderPaid(world, earlyUlid, early);
      const lateEvent = orderPaid(world, lateUlid, late);
      let earlyResult: AutoJournalResult;
      let lateResult: AutoJournalResult;
      if (order === "sale-first") {
        earlyResult = await deliver(world.tenant, earlyEvent);
        lateResult = await deliver(world.tenant, lateEvent);
      } else {
        lateResult = await deliver(world.tenant, lateEvent);
        earlyResult = await deliver(world.tenant, earlyEvent);
      }
      expect(earlyResult).toMatchObject({ status: "posted" });
      expect(lateResult).toEqual(AMOUNTS_MISMATCH);
      expect(await parkedOf(world.tenant, `aj:sale:${lateUlid}`)).toEqual([
        expect.objectContaining({
          error_code: "POSTING_AMOUNTS_MISMATCH",
          retryable: false,
        }),
      ]);
      // receipt + the earlier sale only
      expect(await journalCount(world)).toBe(2);
      expect(await balanceOf(world, "customer_deposit")).toBe(-40_000);
    });
  }

  it("AJ-POSI-05 a POS sale with an intent tender and no refund still posts through customer_deposit", async () => {
    const world = await makeWorld();
    const intentId = await bookedIntent(world, 100_000);
    const orderUlid = createUlid();
    const sale = posSale(intentId, 100_000, T_LATE);
    await seedPosOrder(world, orderUlid, sale);

    const result = await post(world, orderPaid(world, orderUlid, sale));
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 100_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 100_000 },
    ]);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-POSI-05 a POS sale whose receipt is not consumed yet still parks AUTO_JOURNAL_RECEIPT_PENDING (retryable)", async () => {
    const world = await makeWorld();
    const orderUlid = createUlid();
    const intentId = await seedIntent(world, { amountIdr: 100_000 });
    const sale = posSale(intentId, 100_000, T_LATE);
    await seedPosOrder(world, orderUlid, sale);
    await seedUndeliveredReceipt(world, intentId, 100_000);

    expect(
      await deliver(world.tenant, orderPaid(world, orderUlid, sale)),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_PENDING",
      retryable: true,
    });
    expect(await journalCount(world)).toBe(0);
    expect(await parkedOf(world.tenant, `aj:sale:${orderUlid}`)).toEqual([
      expect.objectContaining({
        error_code: "AUTO_JOURNAL_RECEIPT_PENDING",
        retryable: true,
      }),
    ]);
  });
});

/** The pos_order_refunds row of a POS refund (POS-03) of the order; its id. */
async function seedPosRefund(
  world: World,
  orderUlid: string,
  lines: {
    method: TenderMethod;
    amountIdr: number;
    /** Per-tender line (ws/pos-refund-promo); absent = legacy per-method line. */
    tenderId?: string;
    paymentIntentId?: string | null;
  }[],
  refundedAt: string,
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
        refundedAt,
      ],
    );
    return rows[0]!.id;
  });
}

describe("legend-hxpd5 a payout after a POS refund of the intent's sale", () => {
  const T_SALE = "2026-10-15T05:00:00.000Z";
  const T_POS_REFUND = "2026-10-15T08:00:00.000Z"; // before REFUND_DAY

  /**
   * A 100k intent with a posted receipt, a posted 100k QRIS POS sale on it and
   * a POS refund that returned 30k over QRIS at `refundedAt`. Its
   * order.refunded journal (Cr customer_deposit 30k):
   * - posted: delivered and posted;
   * - parked: delivered with a gross that does not balance the lines, parked
   *   non-retryable (it will never post);
   * - undelivered: its event still waits in the outbox (it can still post).
   */
  async function soldAndPosRefunded(
    refundJournal: "posted" | "parked" | "undelivered" = "posted",
    refundedAt: string = T_POS_REFUND,
    tenant: Tenant = shared,
  ) {
    const world = await makeWorld(tenant);
    const intentId = await seedIntent(world, { amountIdr: 100_000 });
    await post(world, paymentPaid(world, intentId, 100_000));
    const orderUlid = createUlid();
    const sale: SaleAmounts = {
      grossSalesIdr: 100_000,
      completedAt: T_SALE,
      tenders: [{ method: "qris", amountIdr: 100_000, intentId }],
    };
    await seedPosOrder(world, orderUlid, sale);
    await post(world, orderPaid(world, orderUlid, sale));
    const lines = [{ method: "qris" as const, amountIdr: 30_000 }];
    const posRefundId = await seedPosRefund(
      world,
      orderUlid,
      lines,
      refundedAt,
    );
    const refundEvent = orderRefunded(
      world,
      orderUlid,
      posRefundId,
      {
        grossSalesIdr: refundJournal === "parked" ? 31_000 : 30_000,
        pbjtIdr: 0,
        lines,
      },
      refundedAt,
    );
    let outboxId: string | null = null;
    if (refundJournal === "posted") await post(world, refundEvent);
    else if (refundJournal === "parked")
      expect(await deliver(world.tenant, refundEvent)).toMatchObject({
        status: "parked",
        retryable: false,
      });
    else
      outboxId = await seedOutboxEvent(
        world,
        refundEvent,
        ulidToUuid(orderUlid),
        "pending",
      );
    return { world, intentId, refundEvent, outboxId };
  }

  it("AJ-HXPD5-01 intent 100k, QRIS sale 100k, POS refund qris 30k, then a 30k payout of the intent posts; customer_deposit nets to 0", async () => {
    const { world, intentId } = await soldAndPosRefunded();
    const refundId = await seedRefund(world, intentId, 30_000);

    const result = await deliver(
      world.tenant,
      paymentRefunded(world, refundId, intentId, 30_000),
    );

    expect(result).toMatchObject({ status: "posted" });
    // receipt + sale + POS refund + payout
    expect(await journalCount(world)).toBe(4);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-HXPD5-02 the same intent paying out 30001 (more than the POS refund returned) parks POSTING_AMOUNTS_MISMATCH", async () => {
    const { world, intentId } = await soldAndPosRefunded();
    const refundId = await seedRefund(world, intentId, 30_001);

    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, intentId, 30_001),
      ),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    expect(await parkedOf(world.tenant, `aj:payout:${refundId}`)).toEqual([
      expect.objectContaining({ error_code: "POSTING_AMOUNTS_MISMATCH" }),
    ]);
    expect(await journalCount(world)).toBe(3);
    expect(await balanceOf(world, "customer_deposit")).toBe(-30_000);
  });

  it("AJ-HXPD5-03 the POS refund journal parked non-retryable (never books its 30k credit): a 30k payout parks POSTING_AMOUNTS_MISMATCH and customer_deposit never goes above 0", async () => {
    const { world, intentId } = await soldAndPosRefunded("parked");
    const refundId = await seedRefund(world, intentId, 30_000);

    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, intentId, 30_000),
      ),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    // receipt + sale only
    expect(await journalCount(world)).toBe(2);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-HXPD5-04 the POS refund journal not delivered yet: a 30k payout parks retryable; once the refund posts the sweep posts the payout", async () => {
    const tenant = await makeTenant();
    const { world, intentId, refundEvent, outboxId } = await soldAndPosRefunded(
      "undelivered",
      T_POS_REFUND,
      tenant,
    );
    const refundId = await seedRefund(world, intentId, 30_000);
    const payoutKey = `aj:payout:${refundId}`;

    expect(
      await deliver(tenant, paymentRefunded(world, refundId, intentId, 30_000)),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_PENDING",
      retryable: true,
    });
    expect(await journalCount(world)).toBe(2);
    expect(await parkedOf(tenant, payoutKey)).toEqual([
      expect.objectContaining({ retryable: true }),
    ]);

    await markDelivered(world, outboxId!);
    await post(world, refundEvent);
    expect(await sweep(tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    expect(await parkedOf(tenant, payoutKey)).toHaveLength(0);
    // receipt + sale + POS refund + payout
    expect(await journalCount(world)).toBe(4);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-HXPD5-05 a POS refund dated after the payout completed does not count for it: the 30k payout parks POSTING_AMOUNTS_MISMATCH", async () => {
    const { world, intentId } = await soldAndPosRefunded(
      "posted",
      "2026-10-17T05:00:00.000Z", // after REFUND_DAY
    );
    const refundId = await seedRefund(world, intentId, 30_000);

    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, intentId, 30_000),
      ),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    // receipt + sale + POS refund
    expect(await journalCount(world)).toBe(3);
  });

  it("AJ-HXPD5-06 the sale parked mismatch, its POS refund parked SALE_MISSING: a 30k payout parks retryable, not mismatch; once the sale is fixed the sweeps post the refund, then the payout", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const intentId = await seedIntent(world, { amountIdr: 100_000 });
    await post(world, paymentPaid(world, intentId, 100_000));
    const orderUlid = createUlid();
    const sale: SaleAmounts = {
      grossSalesIdr: 100_000,
      completedAt: T_SALE,
      tenders: [{ method: "qris", amountIdr: 100_000, intentId }],
    };
    await seedPosOrder(world, orderUlid, sale);
    // The event claims cash; the tender row holds QRIS on the intent.
    const wrongClaim: SaleAmounts = {
      grossSalesIdr: 100_000,
      completedAt: T_SALE,
      tenders: [{ method: "cash", amountIdr: 100_000 }],
    };
    expect(
      await deliver(tenant, orderPaid(world, orderUlid, wrongClaim)),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    const lines = [{ method: "qris" as const, amountIdr: 30_000 }];
    const posRefundId = await seedPosRefund(
      world,
      orderUlid,
      lines,
      T_POS_REFUND,
    );
    const refundKey = `aj:order-refund:${posRefundId}`;
    expect(
      await deliver(
        tenant,
        orderRefunded(
          world,
          orderUlid,
          posRefundId,
          { grossSalesIdr: 30_000, pbjtIdr: 0, lines },
          T_POS_REFUND,
        ),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_SALE_MISSING",
      retryable: false,
    });
    const refundId = await seedRefund(world, intentId, 30_000);
    const payoutKey = `aj:payout:${refundId}`;

    expect(
      await deliver(tenant, paymentRefunded(world, refundId, intentId, 30_000)),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_PENDING",
      retryable: true,
    });

    // Data corrected: the replay of order.paid matches the tender rows.
    await post(world, orderPaid(world, orderUlid, sale));
    await sweep(tenant);
    await journalIdOf(world, refundKey);
    expect(await parkedOf(tenant, refundKey)).toHaveLength(0);
    await sweep(tenant);
    await journalIdOf(world, payoutKey);
    expect(await parkedOf(tenant, payoutKey)).toHaveLength(0);
    // receipt + sale + POS refund + payout
    expect(await journalCount(world)).toBe(4);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });
});

describe("legend-9z1vm a payout after a per-tender POS refund line of a two-intent order", () => {
  const T_SALE = "2026-10-15T05:00:00.000Z";
  const T_POS_REFUND = "2026-10-15T08:00:00.000Z"; // before REFUND_DAY
  const MISMATCH = {
    status: "parked",
    code: "POSTING_AMOUNTS_MISMATCH",
    retryable: false,
  } as const;

  /**
   * One POS order of 100k paid by two QRIS tenders on two intents (first 60k,
   * second 40k), both receipts and the sale posted.
   */
  async function twoIntentOrder() {
    const world = await makeWorld();
    const first = await seedIntent(world, { amountIdr: 60_000 });
    const second = await seedIntent(world, { amountIdr: 40_000 });
    await post(world, paymentPaid(world, first, 60_000));
    await post(world, paymentPaid(world, second, 40_000));
    const orderUlid = createUlid();
    const sale: SaleAmounts = {
      grossSalesIdr: 100_000,
      completedAt: T_SALE,
      tenders: [
        { method: "qris", amountIdr: 60_000, intentId: first },
        { method: "qris", amountIdr: 40_000, intentId: second },
      ],
    };
    await seedPosOrder(world, orderUlid, sale);
    await post(world, orderPaid(world, orderUlid, sale));
    const tenderOf = (intentId: string) =>
      asTenant(world.tenant, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM pos_order_tenders WHERE order_id = $1 AND payment_intent_id = $2`,
          [ulidToUuid(orderUlid), intentId],
        );
        return rows[0]!.id;
      });
    return {
      world,
      orderUlid,
      first,
      second,
      firstTender: await tenderOf(first),
      secondTender: await tenderOf(second),
    };
  }

  /** The POS refund row and its posted order.refunded journal (Cr customer_deposit). */
  async function posRefundWith(
    world: World,
    orderUlid: string,
    lines: Parameters<typeof seedPosRefund>[2],
  ) {
    const posRefundId = await seedPosRefund(
      world,
      orderUlid,
      lines,
      T_POS_REFUND,
    );
    const eventLines = lines.map(({ method, amountIdr }) => ({
      method,
      amountIdr,
    }));
    await post(
      world,
      orderRefunded(
        world,
        orderUlid,
        posRefundId,
        {
          grossSalesIdr: eventLines.reduce((t, l) => t + l.amountIdr, 0),
          pbjtIdr: 0,
          lines: eventLines,
        },
        T_POS_REFUND,
      ),
    );
  }

  // The guard orders payouts by (completedAt, id). An over-amount payout must
  // complete AFTER the exact ones, or a random uuid can sort it first.
  const LATER = new Date(Date.parse(REFUND_DAY) + 3_600_000).toISOString();

  /** Deliver a cash-out of `amountIdr` over `intentId`. */
  async function payout(
    world: World,
    intentId: string,
    amountIdr: number,
    completedAt: string = REFUND_DAY,
  ) {
    const refundId = await seedRefund(
      world,
      intentId,
      amountIdr,
      undefined,
      completedAt,
    );
    return deliver(
      world.tenant,
      paymentRefunded(world, refundId, intentId, amountIdr),
    );
  }

  it("AJ-9Z1VM-01 a 30k qris line naming the first intent's tender frees 30k for the first intent only: 30001 parks, 30000 posts, the second intent stays fully held", async () => {
    const { world, orderUlid, first, second, firstTender } =
      await twoIntentOrder();
    await posRefundWith(world, orderUlid, [
      {
        method: "qris",
        amountIdr: 30_000,
        tenderId: firstTender,
        paymentIntentId: first,
      },
    ]);

    // Exact amount first: the guard orders payouts by (completedAt, id), so a
    // parked over-amount row posted earlier could sort before the exact one.
    expect(await payout(world, first, 30_000)).toMatchObject({
      status: "posted",
    });
    expect(await payout(world, first, 1, LATER)).toEqual(MISMATCH);
    expect(await payout(world, second, 1, LATER)).toEqual(MISMATCH);
    // receipts + sale + POS refund + the first payout
    expect(await journalCount(world)).toBe(5);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-9Z1VM-02 lines naming both tenders (20k first, 10k second) free exactly 20k and 10k: one more each parks, the exact amounts post", async () => {
    const { world, orderUlid, first, second, firstTender, secondTender } =
      await twoIntentOrder();
    await posRefundWith(world, orderUlid, [
      {
        method: "qris",
        amountIdr: 20_000,
        tenderId: firstTender,
        paymentIntentId: first,
      },
      {
        method: "qris",
        amountIdr: 10_000,
        tenderId: secondTender,
        paymentIntentId: second,
      },
    ]);

    // Exact amounts first (see AJ-9Z1VM-01), then one more each parks.
    expect(await payout(world, first, 20_000)).toMatchObject({
      status: "posted",
    });
    expect(await payout(world, second, 10_000)).toMatchObject({
      status: "posted",
    });
    expect(await payout(world, first, 1, LATER)).toEqual(MISMATCH);
    expect(await payout(world, second, 1, LATER)).toEqual(MISMATCH);
    expect(await journalCount(world)).toBe(6);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-9Z1VM-03 a legacy line without a tender id still frees nothing for either intent when only part of the method came back (30k of 100k)", async () => {
    const { world, orderUlid, first, second } = await twoIntentOrder();
    await posRefundWith(world, orderUlid, [
      { method: "qris", amountIdr: 30_000 },
    ]);

    expect(await payout(world, first, 1)).toEqual(MISMATCH);
    expect(await payout(world, second, 1)).toEqual(MISMATCH);
  });

  it("AJ-9Z1VM-05 a legacy 50k row plus a second row naming both tenders (10k first, 40k second) returns the whole method: the first intent pays out its full 60k and the second its full 40k", async () => {
    const { world, orderUlid, first, second, firstTender, secondTender } =
      await twoIntentOrder();
    await posRefundWith(world, orderUlid, [
      { method: "qris", amountIdr: 50_000 },
    ]);
    await posRefundWith(world, orderUlid, [
      {
        method: "qris",
        amountIdr: 10_000,
        tenderId: firstTender,
        paymentIntentId: first,
      },
      {
        method: "qris",
        amountIdr: 40_000,
        tenderId: secondTender,
        paymentIntentId: second,
      },
    ]);

    expect(await payout(world, first, 60_000)).toMatchObject({
      status: "posted",
    });
    expect(await payout(world, second, 40_000)).toMatchObject({
      status: "posted",
    });
    // receipts + sale + two POS refunds + two payouts
    expect(await journalCount(world)).toBe(7);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-9Z1VM-06 a legacy 50k row plus one line naming the first tender (10k) leaves the method partly kept: the first intent frees only 10k, the second stays fully held", async () => {
    const { world, orderUlid, first, second, firstTender } =
      await twoIntentOrder();
    await posRefundWith(world, orderUlid, [
      { method: "qris", amountIdr: 50_000 },
    ]);
    await posRefundWith(world, orderUlid, [
      {
        method: "qris",
        amountIdr: 10_000,
        tenderId: firstTender,
        paymentIntentId: first,
      },
    ]);

    expect(await payout(world, first, 10_000)).toMatchObject({
      status: "posted",
    });
    expect(await payout(world, first, 1, LATER)).toEqual(MISMATCH);
    expect(await payout(world, second, 1, LATER)).toEqual(MISMATCH);
    // receipts + sale + two POS refunds + the first payout
    expect(await journalCount(world)).toBe(6);
  });

  it("AJ-9Z1VM-07 a legacy 60k row plus a separate row naming only the second tender (40k) returns the whole method: the first intent pays out its full 60k and the second its full 40k", async () => {
    const { world, orderUlid, first, second, secondTender } =
      await twoIntentOrder();
    await posRefundWith(world, orderUlid, [
      { method: "qris", amountIdr: 60_000 },
    ]);
    await posRefundWith(world, orderUlid, [
      {
        method: "qris",
        amountIdr: 40_000,
        tenderId: secondTender,
        paymentIntentId: second,
      },
    ]);

    expect(await payout(world, first, 60_000)).toMatchObject({
      status: "posted",
    });
    expect(await payout(world, second, 40_000)).toMatchObject({
      status: "posted",
    });
    // receipts + sale + two POS refunds + two payouts
    expect(await journalCount(world)).toBe(7);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  for (const variant of [
    "unknown-tender-id",
    "tender-of-another-order",
    "intent-id-mismatch",
  ] as const) {
    it(`AJ-9Z1VM-04 (${variant}) a per-tender line that does not match a tender of the intent on this order frees nothing: both intents stay held`, async () => {
      const { world, orderUlid, first, second, firstTender } =
        await twoIntentOrder();
      let line: { tenderId: string; paymentIntentId: string };
      if (variant === "unknown-tender-id") {
        line = { tenderId: randomUUID(), paymentIntentId: first };
      } else if (variant === "intent-id-mismatch") {
        // The tender is the first intent's, the line claims the second.
        line = { tenderId: firstTender, paymentIntentId: second };
      } else {
        // A qris tender (no intent) of another order of the same outlet.
        const otherUlid = createUlid();
        await seedPosOrder(world, otherUlid, {
          grossSalesIdr: 20_000,
          completedAt: T_SALE,
          tenders: [{ method: "qris", amountIdr: 20_000 }],
        });
        const otherTender = await asTenant(world.tenant, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `SELECT id FROM pos_order_tenders WHERE order_id = $1`,
            [ulidToUuid(otherUlid)],
          );
          return rows[0]!.id;
        });
        line = { tenderId: otherTender, paymentIntentId: first };
      }
      await posRefundWith(world, orderUlid, [
        { method: "qris", amountIdr: 30_000, ...line },
      ]);

      expect(await payout(world, first, 1)).toEqual(MISMATCH);
      expect(await payout(world, second, 1)).toEqual(MISMATCH);
    });
  }
});

describe("legend-3bsyh parked SALE_MISSING dependents retry once the sale posts", () => {
  const cashSale: SaleAmounts = {
    grossSalesIdr: 100_000,
    tenders: [{ method: "cash", amountIdr: 100_000 }],
  };
  // The event claims 60k cash + 40k gateway; the tender rows hold 100k cash.
  const wrongClaim: SaleAmounts = {
    grossSalesIdr: 100_000,
    tenders: [
      { method: "cash", amountIdr: 60_000 },
      { method: "qris", amountIdr: 40_000 },
    ],
  };

  async function seedVoidRow(
    world: World,
    orderUlid: string,
    amountIdr: number,
  ): Promise<string> {
    const voidId = randomUUID();
    await asTenant(world.tenant, (client) =>
      client.query(
        `INSERT INTO pos_order_voids
           (id, tenant_id, outlet_id, order_id, receipt_number, amount_idr, reason, reason_note,
            requested_by, approved_by, approval_request_id, voided_at)
         VALUES ($1, $2, $3, $4, 'AJ-0001', $7, 'wrong_order', 'Pesanan salah',
                 'requester', 'approver', $6, $5)`,
        [
          voidId,
          world.tenant.id,
          world.outletId,
          ulidToUuid(orderUlid),
          REFUND_DAY,
          randomUUID(),
          amountIdr,
        ],
      ),
    );
    return voidId;
  }

  function voidEvent(
    world: World,
    orderUlid: string,
    voidId: string,
    amountIdr: number,
  ): EventEnvelope {
    return envelope(world, {
      name: "order.voided",
      aggregateType: "order",
      aggregateId: orderUlid,
      occurredAt: REFUND_DAY,
      payload: {
        orderId: orderUlid,
        outletId: world.outletId,
        businessDate: "2026-10-15",
        amountIdr,
        reason: "wrong_order",
        reasonNote: "Pesanan salah",
        approvedBy: randomUUID(),
        overrideId: null,
        approvalRequestId: null,
        voidedFinalOrder: true,
        voidId,
        receiptNumber: "AJ-0001",
        voidedAt: REFUND_DAY,
      },
    });
  }

  /** Parks the sale (mismatch) and its void and refund (SALE_MISSING). */
  async function parkSaleVoidAndRefund(world: World) {
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, cashSale);
    expect(
      await deliver(world.tenant, orderPaid(world, orderUlid, wrongClaim)),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    const voidId = await seedVoidRow(world, orderUlid, 100_000);
    const refundId = createUlid();
    expect(
      await deliver(world.tenant, voidEvent(world, orderUlid, voidId, 100_000)),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_SALE_MISSING",
      retryable: false,
    });
    expect(
      await deliver(
        world.tenant,
        orderRefunded(world, orderUlid, refundId, {
          grossSalesIdr: 10_000,
          pbjtIdr: 0,
          lines: [{ method: "cash", amountIdr: 10_000 }],
        }),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_SALE_MISSING",
      retryable: false,
    });
    return { orderUlid, voidId, refundId };
  }

  async function retryStateOf(
    tenant: Tenant,
    key: string,
  ): Promise<{ retryable: boolean; next_retry_at: Date | null }[]> {
    return asTenant(tenant, async (client) => {
      const { rows } = await client.query<{
        retryable: boolean;
        next_retry_at: Date | null;
      }>(
        `SELECT retryable, next_retry_at FROM auto_journal_parked
          WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenant.id, key],
      );
      return rows;
    });
  }

  it("AJ-3BSYH-01 the sale posts after its data is fixed: the parked void and refund turn retryable and due, and the sweep posts both", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const { orderUlid, refundId } = await parkSaleVoidAndRefund(world);
    const voidKey = `aj:sale-void:${orderUlid}`;
    const refundKey = `aj:order-refund:${refundId}`;
    // Nothing is due while the sale is missing.
    expect(await sweep(tenant)).toEqual({
      posted: 0,
      stillParked: 0,
      failed: 0,
    });

    // Data corrected: the replay of order.paid now matches the tender rows.
    await post(world, orderPaid(world, orderUlid, cashSale));
    for (const key of [voidKey, refundKey]) {
      const [row] = await retryStateOf(tenant, key);
      expect(row?.retryable).toBe(true);
      expect(row?.next_retry_at).not.toBeNull();
    }

    expect(await sweep(tenant)).toEqual({
      posted: 2,
      stillParked: 0,
      failed: 0,
    });
    await journalIdOf(world, voidKey);
    await journalIdOf(world, refundKey);
    expect(await parkedOf(tenant, voidKey)).toHaveLength(0);
    expect(await parkedOf(tenant, refundKey)).toHaveLength(0);
  });

  it("AJ-3BSYH-02 parked rows of another order or another tenant stay untouched", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const mine = await parkSaleVoidAndRefund(world);
    const other = await parkSaleVoidAndRefund(world);
    const foreignTenant = await makeTenant();
    const foreignWorld = await makeWorld(foreignTenant);
    const foreign = await parkSaleVoidAndRefund(foreignWorld);

    await post(world, orderPaid(world, mine.orderUlid, cashSale));

    expect(
      await retryStateOf(tenant, `aj:sale-void:${mine.orderUlid}`),
    ).toEqual([expect.objectContaining({ retryable: true })]);
    expect(
      await retryStateOf(tenant, `aj:order-refund:${mine.refundId}`),
    ).toEqual([expect.objectContaining({ retryable: true })]);
    for (const [t, key] of [
      [tenant, `aj:sale-void:${other.orderUlid}`],
      [tenant, `aj:order-refund:${other.refundId}`],
      [foreignTenant, `aj:sale-void:${foreign.orderUlid}`],
      [foreignTenant, `aj:order-refund:${foreign.refundId}`],
    ] as const) {
      expect(await retryStateOf(t, key)).toEqual([
        { retryable: false, next_retry_at: null },
      ]);
    }
  });
});

describe("legend-x1i1h legend-j0ag5 a void or a finance reversal of what backs an intent payout", () => {
  const T_SALE = "2026-10-15T05:00:00.000Z";
  const T_VOID = "2026-10-15T09:00:00.000Z"; // before REFUND_DAY
  const T_POS_REFUND = "2026-10-15T08:00:00.000Z"; // before REFUND_DAY

  /** A completed-sale void of the order: its pos_order_voids row and event. */
  async function seedSaleVoid(
    world: World,
    orderUlid: string,
    amountIdr: number,
    eventAmountIdr: number = amountIdr,
  ): Promise<EventEnvelope> {
    const voidId = randomUUID();
    await asTenant(world.tenant, (client) =>
      client.query(
        `INSERT INTO pos_order_voids
           (id, tenant_id, outlet_id, order_id, receipt_number, amount_idr, reason, reason_note,
            requested_by, approved_by, approval_request_id, voided_at)
         VALUES ($1, $2, $3, $4, 'AJ-0001', $7, 'wrong_order', 'Pesanan salah',
                 'requester', 'approver', $6, $5)`,
        [
          voidId,
          world.tenant.id,
          world.outletId,
          ulidToUuid(orderUlid),
          T_VOID,
          randomUUID(),
          amountIdr,
        ],
      ),
    );
    return envelope(world, {
      name: "order.voided",
      aggregateType: "order",
      aggregateId: orderUlid,
      occurredAt: T_VOID,
      payload: {
        orderId: orderUlid,
        outletId: world.outletId,
        businessDate: "2026-10-15",
        amountIdr: eventAmountIdr,
        reason: "wrong_order",
        reasonNote: "Pesanan salah",
        approvedBy: randomUUID(),
        overrideId: null,
        approvalRequestId: null,
        voidedFinalOrder: true,
        voidId,
        receiptNumber: "AJ-0001",
        voidedAt: T_VOID,
      },
    });
  }

  /** A 100k intent with a posted receipt and a posted sale paid by `tenders`. */
  async function soldOnIntent(
    tenant: Tenant,
    tenders: (intentId: string) => SaleAmounts["tenders"],
  ) {
    const world = await makeWorld(tenant);
    const intentId = await seedIntent(world, { amountIdr: 100_000 });
    await post(world, paymentPaid(world, intentId, 100_000));
    const orderUlid = createUlid();
    const sale: SaleAmounts = {
      grossSalesIdr: 100_000,
      completedAt: T_SALE,
      tenders: tenders(intentId),
    };
    await seedPosOrder(world, orderUlid, sale);
    await post(world, orderPaid(world, orderUlid, sale));
    return { world, intentId, orderUlid };
  }

  const allQris = (intentId: string): SaleAmounts["tenders"] => [
    { method: "qris", amountIdr: 100_000, intentId },
  ];

  it("AJ-X1I1H-01 intent 100k, QRIS sale 100k, void: the void reverses the sale (customer_deposit back to 100k), a 100k payout of the intent posts and customer_deposit nets to 0", async () => {
    const { world, intentId, orderUlid } = await soldOnIntent(shared, allQris);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);

    const voided = await post(
      world,
      await seedSaleVoid(world, orderUlid, 100_000),
    );
    await expectBalanced(world, voided.journalEntryId);
    expect(await balanceOf(world, "customer_deposit")).toBe(-100_000);
    expect(await balanceOf(world, "sales_revenue")).toBe(0);

    const refundId = await seedRefund(world, intentId, 100_000);
    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, intentId, 100_000),
      ),
    ).toMatchObject({ status: "posted" });
    // receipt + sale + void + payout
    expect(await journalCount(world)).toBe(4);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-X1I1H-02 a void of cash 30k + QRIS 70k on the intent returns the cash and puts 70k back in customer_deposit; a 100k payout of the intent posts", async () => {
    const { world, intentId, orderUlid } = await soldOnIntent(shared, (id) => [
      { method: "cash", amountIdr: 30_000 },
      { method: "qris", amountIdr: 70_000, intentId: id },
    ]);
    await post(world, await seedSaleVoid(world, orderUlid, 100_000));
    expect(await balanceOf(world, "cash_on_hand")).toBe(0);
    // receipt 100k credit - sale 70k debit + void 70k credit
    expect(await balanceOf(world, "customer_deposit")).toBe(-100_000);

    const refundId = await seedRefund(world, intentId, 100_000);
    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, intentId, 100_000),
      ),
    ).toMatchObject({ status: "posted" });
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-X1I1H-03 the void journal not delivered yet: a 100k payout parks retryable; once the void posts the sweep posts the payout", async () => {
    const tenant = await makeTenant();
    const { world, intentId, orderUlid } = await soldOnIntent(tenant, allQris);
    const voidEvent = await seedSaleVoid(world, orderUlid, 100_000);
    const outboxId = await seedOutboxEvent(
      world,
      voidEvent,
      ulidToUuid(orderUlid),
      "pending",
    );
    const refundId = await seedRefund(world, intentId, 100_000);
    const payoutKey = `aj:payout:${refundId}`;

    expect(
      await deliver(
        tenant,
        paymentRefunded(world, refundId, intentId, 100_000),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_PENDING",
      retryable: true,
    });
    expect(await journalCount(world)).toBe(2);

    await markDelivered(world, outboxId);
    await post(world, voidEvent);
    expect(await sweep(tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    expect(await parkedOf(tenant, payoutKey)).toHaveLength(0);
    // receipt + sale + void + payout
    expect(await journalCount(world)).toBe(4);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-X1I1H-04 the void journal parked non-retryable (never books its credit): a 100k payout parks POSTING_AMOUNTS_MISMATCH", async () => {
    const { world, intentId, orderUlid } = await soldOnIntent(shared, allQris);
    expect(
      await deliver(
        world.tenant,
        await seedSaleVoid(world, orderUlid, 100_000, 99_000),
      ),
    ).toMatchObject({ status: "parked", retryable: false });
    const refundId = await seedRefund(world, intentId, 100_000);

    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, intentId, 100_000),
      ),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(2);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-J0AG5-01 a POS refund journal that finance reversed backs nothing: a 30k payout parks POSTING_AMOUNTS_MISMATCH and customer_deposit never goes above 0", async () => {
    const { world, intentId, orderUlid } = await soldOnIntent(shared, allQris);
    const lines = [{ method: "qris" as const, amountIdr: 30_000 }];
    const posRefundId = await seedPosRefund(
      world,
      orderUlid,
      lines,
      T_POS_REFUND,
    );
    const posRefund = await post(
      world,
      orderRefunded(
        world,
        orderUlid,
        posRefundId,
        { grossSalesIdr: 30_000, pbjtIdr: 0, lines },
        T_POS_REFUND,
      ),
    );
    await reverseJournal(
      contextOf(world.tenant),
      posRefund.journalEntryId,
      {
        entryDate: "2026-10-15",
        reason: "Koreksi keuangan",
        idempotencyKey: `fin-${randomUUID()}`,
      },
      userIdSchema.parse(await seedUser()),
    );
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    const refundId = await seedRefund(world, intentId, 30_000);

    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, intentId, 30_000),
      ),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    // receipt + sale + POS refund + its reversal
    expect(await journalCount(world)).toBe(4);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  /** Finance reverses the journal (ACC-01). */
  async function financeReverses(world: World, entryId: string) {
    await reverseJournal(
      contextOf(world.tenant),
      entryId,
      {
        entryDate: "2026-10-15",
        reason: "Koreksi keuangan",
        idempotencyKey: `fin-${randomUUID()}`,
      },
      userIdSchema.parse(await seedUser()),
    );
  }

  it("AJ-X1I1H-05 a QRIS tender whose intent receipt never posts (sale booked to gateway_clearing): the void parks non-retryable AUTO_JOURNAL_VOID_UNSUPPORTED", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, { amountIdr: 100_000 });
    const orderUlid = createUlid();
    const sale: SaleAmounts = {
      grossSalesIdr: 100_000,
      completedAt: T_SALE,
      tenders: allQris(intentId),
    };
    await seedPosOrder(world, orderUlid, sale);
    await post(world, orderPaid(world, orderUlid, sale));
    expect(await balanceOf(world, "gateway_clearing")).toBe(100_000);

    expect(
      await deliver(
        world.tenant,
        await seedSaleVoid(world, orderUlid, 100_000),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_VOID_UNSUPPORTED",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(1);
  });

  it("AJ-X1I1H-06 a QRIS sale finance reversed, then voided: the void parks JOURNAL_ALREADY_REVERSED and a 100k payout of the intent parks POSTING_AMOUNTS_MISMATCH", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, { amountIdr: 100_000 });
    await post(world, paymentPaid(world, intentId, 100_000));
    const orderUlid = createUlid();
    const sale: SaleAmounts = {
      grossSalesIdr: 100_000,
      completedAt: T_SALE,
      tenders: allQris(intentId),
    };
    await seedPosOrder(world, orderUlid, sale);
    const posted = await post(world, orderPaid(world, orderUlid, sale));
    await financeReverses(world, posted.journalEntryId);

    expect(
      await deliver(
        world.tenant,
        await seedSaleVoid(world, orderUlid, 100_000),
      ),
    ).toMatchObject({ status: "parked", code: "JOURNAL_ALREADY_REVERSED" });
    const refundId = await seedRefund(world, intentId, 100_000);
    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, intentId, 100_000),
      ),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    // receipt + sale + finance reversal
    expect(await journalCount(world)).toBe(3);
  });

  it("AJ-J0AG5-02 a POS refund of a sale finance reversed parks AUTO_JOURNAL_SALE_MISSING and counts as never posting: a 30k payout parks POSTING_AMOUNTS_MISMATCH, not retryable", async () => {
    const world = await makeWorld();
    const intentId = await seedIntent(world, { amountIdr: 100_000 });
    await post(world, paymentPaid(world, intentId, 100_000));
    const orderUlid = createUlid();
    const sale: SaleAmounts = {
      grossSalesIdr: 100_000,
      completedAt: T_SALE,
      tenders: allQris(intentId),
    };
    await seedPosOrder(world, orderUlid, sale);
    const posted = await post(world, orderPaid(world, orderUlid, sale));
    await financeReverses(world, posted.journalEntryId);
    const lines = [{ method: "qris" as const, amountIdr: 30_000 }];
    const posRefundId = await seedPosRefund(
      world,
      orderUlid,
      lines,
      T_POS_REFUND,
    );

    expect(
      await deliver(
        world.tenant,
        orderRefunded(
          world,
          orderUlid,
          posRefundId,
          { grossSalesIdr: 30_000, pbjtIdr: 0, lines },
          T_POS_REFUND,
        ),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_SALE_MISSING",
      retryable: false,
    });
    const refundId = await seedRefund(world, intentId, 30_000);
    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, intentId, 30_000),
      ),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    // receipt + sale + finance reversal
    expect(await journalCount(world)).toBe(3);
  });
});

// legend-41li5: payouts with an equal completedAt.
//
// The guard orders completed payment_refunds by (completed_at, id). The verdict
// (posted or parked, and how much money moved) must be a function of the stored
// rows only, never of the order the events were delivered in. With equal
// completed_at the tie is broken by id, the same way in every check: a payout
// is judged together with the payouts that sort before it, so the larger id is
// the one that parks when the sum does not fit.
//
// Assumptions:
// - The parked verdict is non-retryable POSTING_AMOUNTS_MISMATCH (the code the
//   existing over-refund tests use). The sweep must not change any verdict.
// - Refund ids are fixed per world as "<random prefix>-...<n>" so LOW < HIGH
//   holds in every world, while two worlds never collide on the primary key.
// - O4 (session DP): each payout fits its own intent; in the session DP check
//   the payout with the larger id is judged with the other intent's tied
//   payout counted, so it is the one that parks.
describe("legend-41li5 payouts with equal completedAt", () => {
  const MISMATCH = {
    status: "parked",
    code: "POSTING_AMOUNTS_MISMATCH",
    retryable: false,
  } as const;

  type Payout = {
    key: string;
    intentId: string;
    amountIdr: number;
    /** Last uuid group: a smaller number sorts first (LOW < HIGH). */
    rank: number;
  };

  const verdictOf = (result: AutoJournalResult) =>
    result.status === "posted" ? ("posted" as const) : result;

  /**
   * Seeds the payouts (all completed at the same instant) in `seedOrder`,
   * delivers them in `deliveryOrder`, sweeps, and returns what a user sees.
   */
  async function runPayouts(
    world: World,
    payouts: Payout[],
    seedOrder: string[],
    deliveryOrder: string[],
  ) {
    const prefix = randomUUID().slice(0, 24);
    const byKey = new Map(payouts.map((p) => [p.key, p]));
    const idOf = (p: Payout) => `${prefix}${String(p.rank).padStart(12, "0")}`;
    for (const key of seedOrder) {
      const p = byKey.get(key)!;
      await seedRefund(
        world,
        p.intentId,
        p.amountIdr,
        undefined,
        REFUND_DAY,
        idOf(p),
      );
    }
    const verdicts: Record<string, unknown> = {};
    for (const key of deliveryOrder) {
      const p = byKey.get(key)!;
      verdicts[key] = verdictOf(
        await deliver(
          world.tenant,
          paymentRefunded(world, idOf(p), p.intentId, p.amountIdr),
        ),
      );
    }
    const before = {
      journals: await journalCount(world),
      deposit: await balanceOf(world, "customer_deposit"),
    };
    await sweep(world.tenant);
    const after = {
      journals: await journalCount(world),
      deposit: await balanceOf(world, "customer_deposit"),
    };
    // A sweep never turns a parked payout into a different verdict.
    expect(after).toEqual(before);
    return { verdicts, ...after };
  }

  /** One fresh world per delivery order; every world must show the same verdicts. */
  async function expectSameInBothOrders(
    low: number,
    high: number,
    expected: {
      low: "posted" | typeof MISMATCH;
      high: "posted" | typeof MISMATCH;
      journals: number;
      deposit: number;
    },
  ) {
    const worlds = [
      // World A: LOW seeded and delivered first.
      { seed: ["low", "high"], deliver: ["low", "high"] },
      // World B: HIGH seeded and delivered first.
      { seed: ["high", "low"], deliver: ["high", "low"] },
    ];
    for (const run of worlds) {
      const world = await makeWorld();
      const intentId = await seedIntent(world, { amountIdr: 30_000 });
      await post(world, paymentPaid(world, intentId, 30_000));
      const result = await runPayouts(
        world,
        [
          { key: "low", intentId, amountIdr: low, rank: 1 },
          { key: "high", intentId, amountIdr: high, rank: 2 },
        ],
        run.seed,
        run.deliver,
      );
      expect(result.verdicts).toEqual({
        low: expected.low,
        high: expected.high,
      });
      expect(result.journals).toBe(expected.journals);
      expect(result.deposit).toBe(expected.deposit);
    }
  }

  it("legend-41li5-O1 two payouts that together exceed the intent: the smaller id posts, the larger id parks, in either delivery order", async () => {
    // 20_000 + 20_000 > 30_000: receipt + LOW payout journals. customer_deposit
    // is a liability, so debit minus credit is negative: 10_000 still owed.
    await expectSameInBothOrders(20_000, 20_000, {
      low: "posted",
      high: MISMATCH,
      journals: 2,
      deposit: -10_000,
    });
  });

  it("legend-41li5-O2 two payouts that together fit the intent: both post in either delivery order", async () => {
    // 25_000 + 5_000 = 30_000: receipt + two payouts, nothing left.
    await expectSameInBothOrders(25_000, 5_000, {
      low: "posted",
      high: "posted",
      journals: 3,
      deposit: 0,
    });
  });

  it("legend-41li5-O3 the larger id is judged including the smaller one: 5_000 posts, 28_000 parks, in either delivery order", async () => {
    // 5_000 + 28_000 = 33_000 > 30_000.
    await expectSameInBothOrders(5_000, 28_000, {
      low: "posted",
      high: MISMATCH,
      journals: 2,
      deposit: -25_000,
    });
  });

  it("legend-41li5-O4 session DP: a sale applied 30_000 of the session DP, so with equal completedAt the payouts A 60_000 (smaller id) posts and B 50_000 (larger id) parks, in every delivery order", async () => {
    // Session DP = 60_000 (intent A) + 50_000 (intent B). A completed sale
    // (before the payouts) applied 30_000 of it. Paying out A and B (110_000)
    // would take back DP the sale used, so the payout judged last, B, parks:
    // B is judged together with A and the session holds 50_000 - 50_000 = 0 of
    // the DP the sale used. Each payout alone fits its own intent, so only the
    // session check can park B.
    const orders = [
      ["low", "high"],
      ["high", "low"],
    ];
    for (const deliveryOrder of orders) {
      const world = await makeWorld();
      const a = await seedSeatedDeposit(world, 60_000);
      const b = await seedSeatedDeposit(world, 50_000, a.sessionId);
      await post(world, paymentPaid(world, a.intentId, 60_000));
      await post(world, paymentPaid(world, b.intentId, 50_000));
      const orderUlid = createUlid();
      const sale: SaleAmounts = {
        grossSalesIdr: 100_000,
        pbjtIdr: 10_000,
        depositIdr: 30_000,
        tableSessionId: a.sessionId,
        // Completed (DAY) before the payouts (REFUND_DAY): the sale counts.
        completedAt: DAY,
        tenders: [{ method: "cash", amountIdr: 80_000 }],
      };
      await seedPosOrder(world, orderUlid, sale);
      await post(world, orderPaid(world, orderUlid, sale));

      const result = await runPayouts(
        world,
        [
          { key: "low", intentId: a.intentId, amountIdr: 60_000, rank: 1 },
          { key: "high", intentId: b.intentId, amountIdr: 50_000, rank: 2 },
        ],
        deliveryOrder,
        deliveryOrder,
      );
      expect(result.verdicts).toEqual({ low: "posted", high: MISMATCH });
      // 2 receipts + sale + payout A; customer_deposit: -110_000 + 30_000 +
      // 60_000 = 20_000 still owed (the sale's DP is used, B stays unpaid).
      expect(result.journals).toBe(4);
      expect(result.deposit).toBe(-20_000);
    }
  });
});

// Q81 DP goods returns restore customer_deposit before the original intent pays out.
describe("legend-77r0 Q81 DP return accounting never funds a payout twice", () => {
  const T_RETURN = "2026-10-15T08:00:00.000Z";

  async function returnedDeposit(
    state: "posted" | "pending" | "reversed" = "posted",
  ) {
    const world = await makeWorld();
    const dp = await seedSeatedDeposit(world, 50_000);
    await post(world, paymentPaid(world, dp.intentId, 50_000));
    const orderUlid = createUlid();
    const sale: SaleAmounts = {
      grossSalesIdr: 80_000,
      depositIdr: 50_000,
      tableSessionId: dp.sessionId,
      completedAt: DAY,
      tenders: [{ method: "cash", amountIdr: 30_000 }],
    };
    await seedPosOrder(world, orderUlid, sale);
    await post(world, orderPaid(world, orderUlid, sale));
    const posRefundId = await seedPosRefund(
      world,
      orderUlid,
      [{ method: "cash", amountIdr: 15_000 }],
      T_RETURN,
    );
    await asTenant(world.tenant, (client) =>
      client.query(
        `INSERT INTO pos_deposit_refunds
      (tenant_id,outlet_id,order_id,pos_refund_id,payment_intent_id,amount_idr,released_at)
      VALUES ($1,$2,$3,$4,$5,25000,$6)`,
        [
          world.tenant.id,
          world.outletId,
          ulidToUuid(orderUlid),
          posRefundId,
          dp.intentId,
          T_RETURN,
        ],
      ),
    );
    const event = orderRefunded(
      world,
      orderUlid,
      posRefundId,
      {
        grossSalesIdr: 40_000,
        pbjtIdr: 0,
        lines: [
          { method: "cash", amountIdr: 15_000 },
          { method: "qris", amountIdr: 25_000 },
        ],
      },
      T_RETURN,
    );
    let journalId: string | null = null;
    let outboxId: string | null = null;
    if (state === "pending")
      outboxId = await seedOutboxEvent(world, event, ulidToUuid(orderUlid));
    else {
      journalId = (await post(world, event)).journalEntryId;
      if (state === "reversed")
        await reverseJournal(
          contextOf(world.tenant),
          journalId,
          {
            entryDate: "2026-10-15",
            reason: "Koreksi DP retur",
            idempotencyKey: randomUUID(),
          },
          userIdSchema.parse(await seedUser()),
        );
    }
    return { world, dp, event, journalId, outboxId, posRefundId };
  }

  it("AJ-Q81-01: return40k restores DP25k and cash15k with a balanced journal; original payer payout25k then nets liability to zero", async () => {
    const { world, dp, journalId } = await returnedDeposit();
    expect(await linesOf(world, journalId!)).toEqual([
      { role: "cash_on_hand", debit: 0, credit: 15_000 },
      { role: "customer_deposit", debit: 0, credit: 25_000 },
      { role: "sales_revenue", debit: 40_000, credit: 0 },
    ]);
    await expectBalanced(world, journalId!);
    const refundId = await seedRefund(world, dp.intentId, 25_000);
    const payout = await post(
      world,
      paymentRefunded(world, refundId, dp.intentId, 25_000),
    );
    await expectBalanced(world, payout.journalEntryId);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-Q81-02: original payer payout25001 cannot exceed the returned DP25000", async () => {
    const { world, dp } = await returnedDeposit();
    const refundId = await seedRefund(world, dp.intentId, 25_001);
    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, dp.intentId, 25_001),
      ),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    expect(await balanceOf(world, "customer_deposit")).toBe(-25_000);
  });

  it("AJ-Q81-03: original payer payout waits for the return journal and then posts once after that journal", async () => {
    const { world, dp, event, outboxId } = await returnedDeposit("pending");
    const refundId = await seedRefund(world, dp.intentId, 25_000);
    const payoutEvent = paymentRefunded(world, refundId, dp.intentId, 25_000);
    expect(await deliver(world.tenant, payoutEvent)).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_PENDING",
      retryable: true,
    });
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    await markDelivered(world, outboxId!);
    await post(world, event);
    const result = await post(world, payoutEvent);
    expect(await deliver(world.tenant, payoutEvent)).toEqual({
      status: "already_posted",
      journalEntryId: result.journalEntryId,
    });
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-Q81-04: finance reversing the return removes its DP backing, so original payer payout cannot post", async () => {
    const { world, dp } = await returnedDeposit("reversed");
    const refundId = await seedRefund(world, dp.intentId, 25_000);
    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, dp.intentId, 25_000),
      ),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  for (const first of ["payout", "reversal"] as const) {
    it(`AJ-AYZ7Q-RACE ${first} locks first: concurrent finance reversal and payout never leave an unbacked debit`, async () => {
      const { world, dp, journalId } = await returnedDeposit();
      const refundId = await seedRefund(world, dp.intentId, 25_000);
      const actorId = userIdSchema.parse(await seedUser());
      const reversalKey = randomUUID();
      const payoutKey = `aj:payout:${refundId}`;
      const gateKey = `ayz7q:${randomUUID()}`;
      const triggerName = `ayz7q_gate_${randomBytes(8).toString("hex")}`;
      const helper = await owner.connect();
      let gateReleased = false;
      const releaseGate = async () => {
        if (gateReleased) return;
        gateReleased = true;
        await helper.query("COMMIT");
      };
      const runPayout = () =>
        deliver(
          world.tenant,
          paymentRefunded(world, refundId, dp.intentId, 25_000),
        );
      const runReversal = () =>
        reverseJournal(
          contextOf(world.tenant),
          journalId!,
          {
            entryDate: "2026-10-15",
            reason: "Koreksi DP retur saat worker payout berjalan",
            idempotencyKey: reversalKey,
          },
          actorId,
        );
      let payout: Promise<PromiseSettledResult<AutoJournalResult>> | undefined;
      let reversal:
        | Promise<PromiseSettledResult<Awaited<ReturnType<typeof runReversal>>>>
        | undefined;
      // Observe a lock condition instead of assuming a scheduling delay. The
      // first writer pauses at INSERT, after reading/locking its backing. Old
      // code lets the second writer commit through this gap; fixed code makes
      // it wait on the first writer's source-journal row lock.
      const waitFor = async (condition: () => Promise<boolean>) => {
        const deadline = Date.now() + 5_000;
        while (!(await condition())) {
          if (Date.now() >= deadline)
            throw new Error(
              "DP return race did not reach its database barrier",
            );
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      const settle = async <T>(operation: () => Promise<T>) =>
        (await Promise.allSettled([operation()]))[0]!;
      try {
        // Test-only trigger, scoped to this tenant and one exact journal key.
        // It leaves production code and all other tenants' writes untouched.
        await owner.query(`CREATE FUNCTION public.${triggerName}() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.tenant_id::text = TG_ARGV[0] AND NEW.idempotency_key = TG_ARGV[1] THEN
              PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[2], 0));
            END IF;
            RETURN NEW;
          END $$`);
        await owner.query(`CREATE TRIGGER ${triggerName}
          BEFORE INSERT ON journal_entries FOR EACH ROW
          EXECUTE FUNCTION public.${triggerName}('${world.tenant.id}',
            '${first === "payout" ? payoutKey : reversalKey}', '${gateKey}')`);
        await helper.query("BEGIN");
        await helper.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [gateKey],
        );
        if (first === "payout") payout = settle(runPayout);
        else reversal = settle(runReversal);
        let firstPid: number | undefined;
        await waitFor(async () => {
          const { rows } = await owner.query<{ pid: number }>(
            `SELECT pid FROM pg_locks WHERE locktype = 'advisory'
               AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)
               AND NOT granted`,
            [gateKey],
          );
          firstPid = rows[0]?.pid;
          return firstPid !== undefined;
        });
        let secondSettled = false;
        if (first === "payout") {
          reversal = settle(runReversal).then((result) => {
            secondSettled = true;
            return result;
          });
        } else {
          payout = settle(runPayout).then((result) => {
            secondSettled = true;
            return result;
          });
        }
        await waitFor(async () => {
          if (secondSettled) return true;
          const { rows } = await owner.query<{ blocked: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_stat_activity
               WHERE $1::integer = ANY(pg_blocking_pids(pid))
             ) AS blocked`,
            [firstPid],
          );
          return rows[0]!.blocked;
        });
        await releaseGate();
        const [payoutResult, reversalResult] = await Promise.all([
          payout!,
          reversal!,
        ]);
        // This is +25k before the fix: receipt + sale + return + reversal +
        // payout debits customer_deposit without any remaining source credit.
        expect(await balanceOf(world, "customer_deposit")).toBe(0);
        expect(payoutResult.status).toBe("fulfilled");
        if (payoutResult.status !== "fulfilled") throw payoutResult.reason;
        if (first === "reversal") {
          expect(reversalResult.status).toBe("fulfilled");
          expect(payoutResult.value).toEqual({
            status: "parked",
            code: "POSTING_AMOUNTS_MISMATCH",
            retryable: false,
          });
          expect(await runPayout()).toEqual(payoutResult.value);
          if (reversalResult.status !== "fulfilled")
            throw reversalResult.reason;
          expect((await runReversal()).id).toBe(reversalResult.value.id);
        } else {
          expect(payoutResult.value.status).toBe("posted");
          expect(reversalResult.status).toBe("rejected");
          if (reversalResult.status === "rejected")
            expect(reversalResult.reason).toMatchObject({
              status: 409,
              code: "JOURNAL_BACKING_IN_USE",
            });
          if (payoutResult.value.status !== "posted")
            throw new Error("payout not posted");
          expect(await runPayout()).toEqual({
            status: "already_posted",
            journalEntryId: payoutResult.value.journalEntryId,
          });
          await expect(runReversal()).rejects.toMatchObject({
            status: 409,
            code: "JOURNAL_BACKING_IN_USE",
          });
        }
        const { rows } = await owner.query<{
          id: string;
          idempotency_key: string;
        }>(
          `SELECT id, idempotency_key FROM journal_entries
             WHERE tenant_id = $1 AND legal_entity_id = $2`,
          [world.tenant.id, world.entity],
        );
        expect(rows).toHaveLength(4);
        for (const row of rows) await expectBalanced(world, row.id);
        expect(
          rows.filter((row) => row.idempotency_key === payoutKey),
        ).toHaveLength(first === "payout" ? 1 : 0);
        expect(await balanceOf(world, "gateway_clearing")).toBe(
          first === "payout" ? 25_000 : 50_000,
        );
        expect(await balanceOf(world, "customer_deposit")).toBe(0);
      } finally {
        await releaseGate();
        await Promise.all([payout, reversal]);
        helper.release();
        await owner.query(
          `DROP TRIGGER IF EXISTS ${triggerName} ON journal_entries`,
        );
        await owner.query(`DROP FUNCTION IF EXISTS public.${triggerName}()`);
      }
    });
  }

  it("AJ-AYZ7Q-UNPOSTED: a completed refund without a payout journal does not prevent source reversal; its later delivery cannot debit the deposit", async () => {
    const { world, dp, journalId } = await returnedDeposit();
    const refundId = await seedRefund(world, dp.intentId, 25_000);
    const reversed = await reverseJournal(
      contextOf(world.tenant),
      journalId!,
      {
        entryDate: "2026-10-15",
        reason: "Koreksi DP retur sebelum jurnal payout",
        idempotencyKey: randomUUID(),
      },
      userIdSchema.parse(await seedUser()),
    );
    await expectBalanced(world, reversed.id);
    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, dp.intentId, 25_000),
      ),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(4);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await balanceOf(world, "gateway_clearing")).toBe(50_000);
  });

  it("AJ-AYZ7Q-SOURCE-VISIBILITY: a source committed after the empty lock read cannot fund that payout attempt", async () => {
    const { world, dp, event, outboxId, posRefundId } =
      await returnedDeposit("pending");
    const refundId = await seedRefund(world, dp.intentId, 25_000);
    const payoutEvent = paymentRefunded(world, refundId, dp.intentId, 25_000);
    const sourceKey = `aj:order-refund:${posRefundId}`;
    const originalQuery = Client.prototype.query;
    let interleaved = false;
    let sourceJournalId: string | undefined;
    // Every statement still executes against PostgreSQL. This wrapper only
    // schedules the independent source writer after SELECT FOR UPDATE found
    // no source row, before the worker's fresh backing-state read can see it.
    const querySpy = vi
      .spyOn(Client.prototype, "query")
      .mockImplementation(function (this: Client, ...args: unknown[]) {
        const result: unknown = Reflect.apply(originalQuery, this, args);
        const config = args[0] as
          string | { text?: string; values?: unknown[] };
        const text = typeof config === "string" ? config : config.text;
        const values = (
          typeof config === "string" ? args[1] : (config.values ?? args[1])
        ) as unknown[] | undefined;
        if (
          !interleaved &&
          text?.includes('from "journal_entries"') &&
          text.includes("for update") &&
          values?.includes(world.tenant.id) &&
          values.includes(sourceKey)
        ) {
          interleaved = true;
          return Promise.resolve(result).then(async (rows) => {
            expect((rows as { rows: unknown[] }).rows).toHaveLength(0);
            await markDelivered(world, outboxId!);
            sourceJournalId = (await post(world, event)).journalEntryId;
            return rows;
          });
        }
        return result;
      } as typeof originalQuery);
    let firstAttempt: AutoJournalResult;
    try {
      firstAttempt = await deliver(world.tenant, payoutEvent);
    } finally {
      querySpy.mockRestore();
    }
    expect(
      interleaved,
      "the source must commit after the empty lock read",
    ).toBe(true);
    expect(firstAttempt).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_PENDING",
      retryable: true,
    });
    expect(sourceJournalId).toBeDefined();
    await expectBalanced(world, sourceJournalId!);
    expect(await journalCount(world)).toBe(3);
    expect(await balanceOf(world, "customer_deposit")).toBe(-25_000);
    const sourceReversal = await reverseJournal(
      contextOf(world.tenant),
      sourceJournalId!,
      {
        entryDate: "2026-10-15",
        reason: "Koreksi jurnal retur yang baru terlihat worker",
        idempotencyKey: randomUUID(),
      },
      userIdSchema.parse(await seedUser()),
    );
    await expectBalanced(world, sourceReversal.id);
    expect(await deliver(world.tenant, payoutEvent)).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    expect(await journalCount(world)).toBe(4);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await balanceOf(world, "gateway_clearing")).toBe(50_000);
  });

  it("AJ-AYZ7Q-PAYOUT-REVERSED: reversing the payout journal does not reclaim cash or permit reversing its source", async () => {
    const { world, dp, journalId } = await returnedDeposit();
    const refundId = await seedRefund(world, dp.intentId, 25_000);
    const payout = await post(
      world,
      paymentRefunded(world, refundId, dp.intentId, 25_000),
    );
    const actorId = userIdSchema.parse(await seedUser());
    const reversedPayout = await reverseJournal(
      contextOf(world.tenant),
      payout.journalEntryId,
      {
        entryDate: "2026-10-16",
        reason: "Koreksi jurnal payout; uang belum dikembalikan pembayar",
        idempotencyKey: randomUUID(),
      },
      actorId,
    );
    await expectBalanced(world, reversedPayout.id);
    await expect(
      reverseJournal(
        contextOf(world.tenant),
        journalId!,
        {
          entryDate: "2026-10-15",
          reason: "Koreksi DP retur setelah jurnal payout dibalik",
          idempotencyKey: randomUUID(),
        },
        actorId,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "JOURNAL_BACKING_IN_USE",
    });
    expect(await journalCount(world)).toBe(5);
    expect(await balanceOf(world, "customer_deposit")).toBe(-25_000);
    expect(await balanceOf(world, "gateway_clearing")).toBe(50_000);
  });

  for (const connected of [true, false]) {
    it(`AJ-AYZ7Q-COMPONENT connected=${connected}: another intent's booked payout blocks source reversal only in the same DP component`, async () => {
      const { world, dp, journalId } = await returnedDeposit();
      const other = await seedSeatedDeposit(
        world,
        20_000,
        connected ? dp.sessionId : undefined,
      );
      await post(world, paymentPaid(world, other.intentId, 20_000));
      const otherRefund = await seedRefund(world, other.intentId, 20_000);
      await post(
        world,
        paymentRefunded(world, otherRefund, other.intentId, 20_000),
      );
      const reversal = reverseJournal(
        contextOf(world.tenant),
        journalId!,
        {
          entryDate: "2026-10-15",
          reason: "Koreksi DP retur dengan payout intent lain",
          idempotencyKey: randomUUID(),
        },
        userIdSchema.parse(await seedUser()),
      );
      if (connected) {
        await expect(reversal).rejects.toMatchObject({
          status: 409,
          code: "JOURNAL_BACKING_IN_USE",
        });
      } else {
        await expectBalanced(world, (await reversal).id);
      }
      expect(await journalCount(world)).toBe(connected ? 5 : 6);
      expect(await balanceOf(world, "customer_deposit")).toBe(
        connected ? -25_000 : 0,
      );
      expect(await balanceOf(world, "gateway_clearing")).toBe(50_000);
    });
  }
});

// Q82 credit retains the original payer's money across table sessions.
describe("legend-fug4 Q82 credit-backed sales share one original DP receipt cap", () => {
  const T_OLD_SALE = "2026-10-15T06:00:00.000Z";
  const T_USE = "2026-10-15T08:00:00.000Z";
  const T_NEW_SALE = "2026-10-15T09:00:00.000Z";
  async function creditMovedToAnotherSession() {
    const world = await makeWorld();
    const dp = await seedSeatedDeposit(world, 100_000);
    const receipt = await post(world, paymentPaid(world, dp.intentId, 100_000));
    const oldOrder = createUlid();
    const oldSale: SaleAmounts = {
      grossSalesIdr: 60_000,
      depositIdr: 60_000,
      tableSessionId: dp.sessionId,
      completedAt: T_OLD_SALE,
      tenders: [],
    };
    await seedPosOrder(world, oldOrder, oldSale);
    await post(world, orderPaid(world, oldOrder, oldSale, T_OLD_SALE));
    const destination = await seedSession(world);
    const remainderId = randomUUID();
    const profileId = randomUUID();
    await asTenant(world.tenant, async (client) => {
      await client.query(
        `INSERT INTO customer_profiles(id,tenant_id,name,membership_status,whatsapp_verified_at)
        VALUES($1,$2,'Pemilik saldo Q82','active',now())`,
        [profileId, world.tenant.id],
      );
      await client.query(
        `INSERT INTO reservation_deposit_remainders
        (id,tenant_id,outlet_id,reservation_id,table_session_id,payment_intent_id,customer_profile_id,amount_idr,remaining_idr,kind,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,40000,0,'customer_credit',$8)`,
        [
          remainderId,
          world.tenant.id,
          world.outletId,
          dp.reservationId,
          dp.sessionId,
          dp.intentId,
          profileId,
          T_USE,
        ],
      );
      await client.query(
        `INSERT INTO reservation_customer_credit_uses
        (tenant_id,outlet_id,remainder_id,table_session_id,amount_idr,idempotency_key,created_at)
        VALUES($1,$2,$3,$4,40000,$5,$6)`,
        [
          world.tenant.id,
          world.outletId,
          remainderId,
          destination,
          randomUUID(),
          T_USE,
        ],
      );
    });
    return { world, dp, destination, receipt };
  }

  it("AJ-Q82-01: old sale60k and next visit credit40k consume exactly receipt100k; no additional payer payout is backed", async () => {
    const { world, dp, destination } = await creditMovedToAnotherSession();
    const order = createUlid();
    const sale: SaleAmounts = {
      grossSalesIdr: 40_000,
      depositIdr: 40_000,
      tableSessionId: destination,
      completedAt: T_NEW_SALE,
      tenders: [],
    };
    await seedPosOrder(world, order, sale);
    const result = await post(world, orderPaid(world, order, sale, T_NEW_SALE));
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 40_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 40_000 },
    ]);
    await expectBalanced(world, result.journalEntryId);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    const refundId = await seedRefund(world, dp.intentId, 1);
    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, dp.intentId, 1),
      ),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-Q82-02: destination sale40001 cannot use more than credit40000 or total original DP100000", async () => {
    const { world, destination } = await creditMovedToAnotherSession();
    const order = createUlid();
    const sale: SaleAmounts = {
      grossSalesIdr: 40_001,
      depositIdr: 40_001,
      tableSessionId: destination,
      completedAt: T_NEW_SALE,
      tenders: [],
    };
    await seedPosOrder(world, order, sale);
    expect(
      await deliver(world.tenant, orderPaid(world, order, sale, T_NEW_SALE)),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    expect(await balanceOf(world, "customer_deposit")).toBe(-40_000);
  });

  it("AJ-Q82-03: reversed original receipt cannot fund a credit sale at a later visit", async () => {
    const { world, destination, receipt } = await creditMovedToAnotherSession();
    await reverseJournal(
      contextOf(world.tenant),
      receipt.journalEntryId,
      {
        entryDate: "2026-10-15",
        reason: "Koreksi penerimaan DP",
        idempotencyKey: randomUUID(),
      },
      userIdSchema.parse(await seedUser()),
    );
    const before = await balanceOf(world, "customer_deposit");
    const order = createUlid();
    const sale: SaleAmounts = {
      grossSalesIdr: 40_000,
      depositIdr: 40_000,
      tableSessionId: destination,
      completedAt: T_NEW_SALE,
      tenders: [],
    };
    await seedPosOrder(world, order, sale);
    expect(
      await deliver(world.tenant, orderPaid(world, order, sale, T_NEW_SALE)),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    expect(await balanceOf(world, "customer_deposit")).toBe(before);
  });
  it("AJ-Q82-04: a connected DP source without a posted receipt cannot inflate another source's booked credit", async () => {
    const { world, dp, destination } = await creditMovedToAnotherSession();
    await seedSeatedDeposit(world, 100_000, dp.sessionId);
    const order = createUlid();
    const sale: SaleAmounts = {
      grossSalesIdr: 40_000,
      depositIdr: 40_000,
      tableSessionId: destination,
      completedAt: T_NEW_SALE,
      tenders: [],
    };
    await seedPosOrder(world, order, sale);
    expect(
      await deliver(world.tenant, orderPaid(world, order, sale, T_NEW_SALE)),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_DEPOSIT_CUTOVER_MIXED",
      retryable: false,
    });
    expect(await balanceOf(world, "customer_deposit")).toBe(-40_000);
  });
  it("AJ-Q82-CLOCK-01: original DP fact clock follows a completed credit-backed destination sale", async () => {
    const { world, dp, destination } = await creditMovedToAnotherSession();
    const future = new Date(Date.now() + 60000).toISOString();
    const order = createUlid();
    await seedPosOrder(world, order, {
      grossSalesIdr: 40000,
      depositIdr: 40000,
      tableSessionId: destination,
      completedAt: future,
      tenders: [],
    });
    const next = await withTenant(db, contextOf(world.tenant), (tx) =>
      lockIntentsForFact(
        tx,
        tenantIdSchema.parse(world.tenant.id),
        [dp.intentId],
        new Date(0),
      ),
    );
    expect(next.getTime()).toBeGreaterThan(new Date(future).getTime());
  });
});
