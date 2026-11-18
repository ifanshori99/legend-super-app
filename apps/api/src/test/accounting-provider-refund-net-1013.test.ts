// legend-tlm3h (brief 1013, tier K "jangan sampai rugi"): the payment provider
// (DOIT) can refund part of a QRIS payment on its own (legend-30hfs, rows in
// `payment_provider_refunds`). Until now no journal knew about it: the gateway
// clearing account kept the GROSS money the gateway received, so the books said
// more money was owed to the outlet than the gateway ever held. Written from the
// brief (design decision of the engineer) and the F19 auto-journal test
// fixtures, failing first; not from the implementation.
//
// Design asserted (brief 1013 "Desain akuntansi"):
//  - Receipt stays GROSS: `payment.paid` = Dr gateway_clearing / Cr
//    customer_deposit of what the gateway received.
//  - A new event `payment.provider_refunded` {providerRefundId,
//    paymentIntentId, amountIdr, refundedAt} (aggregate = the
//    payment_provider_refunds row) books Dr customer_deposit / Cr
//    gateway_clearing for `amountIdr`, source type "refund", key
//    `aj:provider-refund:<providerRefundId>`. Result: clearing = gross - refunds
//    = net, revenue = net.
//
// 1013-AJ-01 refund before paid: journals balance to the net
// 1013-AJ-02 refund event ahead of its receipt waits, then posts once
// 1013-AJ-03 refund after paid and sale: books once, old journals unchanged,
//            old events replay without error
// 1013-AJ-04 duplicate / replayed refund events never double the journal
// 1013-AJ-05 our refunds + provider refunds never exceed the receipt
// 1013-AJ-06 an event that does not match the recorded refund posts nothing
// 1013-AJ-07 another tenant is never touched
//
// Assumptions (the brief does not fix them):
//  - providerRefundId in the payload is the `payment_provider_refunds.id` of
//    the row (brief: "Satu event per baris payment_provider_refunds ... kunci
//    jurnal aj:provider-refund:${providerRefundId}", builder reads the row by
//    tenant + id + intent + amount). The envelope aggregate is the same id.
//  - The money time of the journal is `refundedAt` (business date from it).
//  - "Time bound": only provider refunds RECORDED (created_at) up to the paid
//    time of the sale being judged reduce its backing. A refund recorded
//    before the paid time reduces the share (net); one recorded later does not
//    change a sale/paid event that is replayed or first delivered later.
//  - A refused posting (cap exceeded, row mismatch, wrong tenant) is not
//    pinned to one code: the delivery does not throw, status is not "posted",
//    and no journal is written.
//  - Setup is raw SQL like accounting-auto-journal.test.ts: the intent is
//    seeded paid, the provider refund row is seeded directly.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/accounting-provider-refund-net-1013.test.ts" heavy pnpm test

import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { recordProviderRefundInTx } from "../services/payment-provider-partial-refund.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  deliverAutoJournalEvent,
  retryParkedAutoJournals,
  type AutoJournalResult,
} from "../services/accounting-auto-journal-consumer.ts";

vi.setConfig({ testTimeout: 120_000 });

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const short = () => randomUUID().slice(0, 6);
/** Fixed "now" of the consumer; every business instant below is in the past. */
const NOW = new Date("2026-11-08T03:00:00Z");
/** The sweep clock: a day later, past any retry backoff. */
const SWEEP_AT = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
/** The gateway received the money: 2026-10-15 12:00 Jakarta. */
const DAY = "2026-10-15T05:00:00.000Z";
/** A provider refund recorded BEFORE the money was booked as paid. */
const BEFORE_PAID = "2026-10-15T04:00:00.000Z";
/** A provider refund recorded AFTER the paid event and the sale. */
const AFTER_PAID = "2026-10-16T05:00:00.000Z";
/** A provider refund recorded after another one made at AFTER_PAID. */
const AFTER_PAID_LATER = "2026-10-16T06:00:00.000Z";

const FLAGS_ON = JSON.stringify({
  modules: ["accounting"],
  integrationProviders: [],
});

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
     VALUES ($1, $2, 'Uji Refund Provider 1013', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-1013-${id.slice(0, 8)}`,
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

/** A legal entity + outlet + CoA with every posting role mapped + open periods. */
async function makeWorld(tenant: Tenant): Promise<World> {
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenant.id, `Entity 1013 ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet 1013', 'Jl. Uji', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [outletId, tenant.id, tenant.brandId, entity, `P-${short()}`.toUpperCase()],
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

/** A paid gateway (QRIS) intent with its payment link. */
async function seedIntent(world: World, amountIdr: number): Promise<string> {
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
      `PR-${linkId.slice(0, 8)}`,
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
      `pr-${intentId}`,
      DAY,
    ],
  );
  return intentId;
}

/**
 * The provider refunded `amountIdr` of the intent on its own (brief 967). The
 * row id is what the event calls `providerRefundId`. `recordedAt` is when we
 * recorded it (BEFORE_PAID / AFTER_PAID decide which sale it may touch).
 */
async function seedProviderRefund(
  world: World,
  intentId: string,
  amountIdr: number,
  recordedAt: string,
  /** The provider's own refund id (random when not given). */
  providerRefundId: string = `rf_${randomUUID().slice(0, 12)}`,
): Promise<string> {
  const rowId = randomUUID();
  await asTenant(world.tenant, (client) =>
    client.query(
      `INSERT INTO payment_provider_refunds
         (id, tenant_id, outlet_id, payment_intent_id, provider, provider_refund_id,
          provider_payment_ref, amount_idr, source, created_at)
       VALUES ($1, $2, $3, $4, 'doit', $5, $6, $7, 'payment_webhook', $8)`,
      [
        rowId,
        world.tenant.id,
        world.outletId,
        intentId,
        providerRefundId,
        `pay_${intentId.slice(0, 12)}`,
        amountIdr,
        recordedAt,
      ],
    ),
  );
  return rowId;
}

/** A completed refund of OUR side (payout done through the refund module). */
async function seedOurRefund(
  world: World,
  intentId: string,
  amountIdr: number,
  /** Not final yet: status, provider reference and payout attempts of the row. */
  opts: {
    status?: "completed" | "approved" | "failed";
    providerRef?: string | null;
    attempts?: number;
  } = {},
): Promise<string> {
  const refundId = randomUUID();
  const status = opts.status ?? "completed";
  await owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, completed_at, provider_ref, payout_attempts)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian dana', $7, 'requester', 'approver', $6,
             $8, $9, $10)`,
    [
      refundId,
      world.tenant.id,
      world.outletId,
      intentId,
      amountIdr,
      AFTER_PAID,
      status,
      status === "completed" ? AFTER_PAID : null,
      opts.providerRef ?? null,
      opts.attempts ?? 0,
    ],
  );
  return refundId;
}

/** Our refund goes final: the provider reference is matched, then it completes. */
async function completeOurRefund(
  refundId: string,
  providerRef: string,
): Promise<void> {
  await owner.query(
    `UPDATE payment_refunds SET provider_ref = $2, status = 'completed',
            completed_at = $3 WHERE id = $1`,
    [refundId, providerRef, AFTER_PAID_LATER],
  );
}

/** Gives the intent the provider reference a provider refund names. */
async function setIntentProviderRef(
  intentId: string,
  providerRef: string,
): Promise<void> {
  await owner.query(
    `UPDATE payment_intents SET provider_ref = $2 WHERE id = $1`,
    [intentId, providerRef],
  );
}

type RecordStatus = Awaited<
  ReturnType<typeof recordProviderRefundInTx>
>["status"];

/** The recorder as the webhook calls it, in one tenant transaction. */
async function record(
  world: World,
  intentId: string,
  input: {
    providerRefundId: string;
    providerPaymentRef: string;
    amountIdr?: number;
    force?: boolean;
  },
): Promise<RecordStatus> {
  const context = contextOf(world.tenant);
  const outcome = await withTenant(db, context, (tx) =>
    recordProviderRefundInTx(
      tx,
      context,
      {
        provider: "doit",
        providerRefundId: input.providerRefundId,
        refundIdKind: "provider",
        providerPaymentRef: input.providerPaymentRef,
        amountIdr: input.amountIdr ?? 10_000,
        source: "payment_webhook",
        expectedIntentId: intentId,
        ...(input.force === undefined ? {} : { force: input.force }),
      },
      new Date("2026-10-16T05:00:00.000Z"),
    ),
  );
  return outcome.status;
}

async function emittedRefundEvents(world: World): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'payment.provider_refunded'`,
    [world.tenant.id],
  );
  return Number(rows[0]!.n);
}

async function providerRowId(
  world: World,
  providerRefundId: string,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM payment_provider_refunds
      WHERE tenant_id = $1 AND provider_refund_id = $2`,
    [world.tenant.id, providerRefundId],
  );
  return rows[0]!.id;
}

type Sale = { gross: number; pbjt: number; intentId: string };

/** A POS order paid with ONE gateway tender backed by an intent. */
async function seedPosOrder(
  world: World,
  orderUlid: string,
  sale: Sale,
  /** The sale's time (pos_orders.completed_at); now() when not given. */
  completedAt: string | null = null,
): Promise<void> {
  const orderId = ulidToUuid(orderUlid);
  const total = sale.gross + sale.pbjt;
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
        `PR-${short()}`,
        sale.gross,
        sale.pbjt,
        total,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', now(), coalesce($4::timestamptz, now()))`,
      [orderId, world.tenant.id, world.outletId, completedAt],
    );
    await client.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, payment_intent_id, amount_idr,
          status, requested_at, resolved_at)
       VALUES ($1, $2, $3, 'qris', 'doit', $4, $5, 'captured', now(), now())`,
      [world.tenant.id, world.outletId, orderId, sale.intentId, total],
    );
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
    idempotencyKey: `pr-test-${id}`,
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload,
  });
}

function paymentPaid(
  world: World,
  intentId: string,
  receivedIdr: number,
): EventEnvelope {
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

/** The new event of brief 1013. */
function providerRefunded(
  world: World,
  providerRefundId: string,
  intentId: string,
  amountIdr: number,
  extra: { id?: string; refundedAt?: string } = {},
): EventEnvelope {
  const refundedAt = extra.refundedAt ?? DAY;
  return envelope(world, {
    ...(extra.id === undefined ? {} : { id: extra.id }),
    name: "payment.provider_refunded",
    aggregateType: "payment",
    aggregateId: providerRefundId,
    occurredAt: refundedAt,
    payload: {
      providerRefundId,
      paymentIntentId: intentId,
      amountIdr,
      refundedAt,
    },
  });
}

/** Our own refund payout event (the existing `payment.refunded`). */
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
    occurredAt: AFTER_PAID,
    payload: { refundId, paymentIntentId: intentId, amountIdr },
  });
}

function orderPaid(world: World, orderUlid: string, sale: Sale): EventEnvelope {
  const total = sale.gross + sale.pbjt;
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
      grossSalesIdr: sale.gross,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: sale.pbjt,
      roundingIdr: 0,
      totalIdr: total,
      paidCashIdr: 0,
      paidGatewayIdr: total,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      tenders: [{ method: "qris", amountIdr: total }],
      shiftId: null,
      cashierId: null,
      deviceId: null,
      paidAt: DAY,
    },
  });
}

/** Emitted to cloud-sync but not consumed yet (receipt still pending). */
async function seedUndeliveredPaid(
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

// ---- driving the consumer ---------------------------------------------------

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
  expect(result.status, `${event.name} should post`).toBe("posted");
  if (result.status !== "posted") throw new Error("not posted");
  return result;
}

/** A refused delivery: no throw, not posted. */
async function expectNotPosted(world: World, event: EventEnvelope) {
  const before = await journalCount(world);
  const result = await deliver(world.tenant, event);
  expect(result.status, `${event.name} must not post`).not.toBe("posted");
  expect(await journalCount(world)).toBe(before);
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

async function journalCount(world: World): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [world.tenant.id, world.entity],
  );
  return Number(rows[0]!.n);
}

async function journalsByKey(world: World, key: string): Promise<string[]> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2",
    [world.tenant.id, key],
  );
  return rows.map((row) => row.id);
}

async function entryOf(world: World, entryId: string) {
  const { rows } = await owner.query<{
    source_type: string;
    outlet_id: string | null;
    entry_date: string;
  }>(
    `SELECT source_type, outlet_id, entry_date::text AS entry_date
       FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2 AND id = $3`,
    [world.tenant.id, world.entity, entryId],
  );
  expect(rows, `journal ${entryId}`).toHaveLength(1);
  return rows[0]!;
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

/** The refund payout lines every provider refund journal must have. */
const refundLines = (amountIdr: number): Line[] => [
  { role: "customer_deposit", debit: amountIdr, credit: 0 },
  { role: "gateway_clearing", debit: 0, credit: amountIdr },
];

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  // Journals, parked rows and tenants stay (append-only, random names).
  await owner.end();
});

// ============================================================================

describe("1013 a provider refund reaches the books", () => {
  it("1013-AJ-01 a partial provider refund before the sale: the books end at the net (clearing = net, revenue = net, deposit 0)", async () => {
    const world = await makeWorld(await makeTenant());
    const intentId = await seedIntent(world, 110_000);
    const refundRow = await seedProviderRefund(
      world,
      intentId,
      10_000,
      BEFORE_PAID,
    );

    // The receipt is the gross money the gateway received.
    await post(world, paymentPaid(world, intentId, 110_000));
    expect(await balanceOf(world, "gateway_clearing")).toBe(110_000);
    expect(await balanceOf(world, "customer_deposit")).toBe(-110_000);

    // The provider gave Rp10.000 back on its own: booked as a refund payout.
    const refund = await post(
      world,
      providerRefunded(world, refundRow, intentId, 10_000, {
        refundedAt: BEFORE_PAID,
      }),
    );
    const entry = await entryOf(world, refund.journalEntryId);
    expect(entry.source_type).toBe("refund");
    expect(entry.outlet_id).toBe(world.outletId);
    expect(entry.entry_date).toBe("2026-10-15");
    expect(await linesOf(world, refund.journalEntryId)).toEqual(
      refundLines(10_000),
    );
    await expectBalanced(world, refund.journalEntryId);
    expect(await balanceOf(world, "gateway_clearing")).toBe(100_000);
    expect(await balanceOf(world, "customer_deposit")).toBe(-100_000);

    // The sale (Rp100.000) is backed by the net Rp100.000.
    const orderUlid = createUlid();
    const sale: Sale = { gross: 90_000, pbjt: 10_000, intentId };
    await seedPosOrder(world, orderUlid, sale);
    await post(world, orderPaid(world, orderUlid, sale));

    expect(await balanceOf(world, "gateway_clearing")).toBe(100_000);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await balanceOf(world, "sales_revenue")).toBe(-90_000);
    expect(await balanceOf(world, "tax_payable_pbjt")).toBe(-10_000);
    // Every posted journal balances, so the whole ledger does too.
    expect(await journalCount(world)).toBe(3);
  });

  it("1013-AJ-02 a provider refund whose receipt is not booked yet waits (receipt pending), then posts once after it", async () => {
    const world = await makeWorld(await makeTenant());
    const intentId = await seedIntent(world, 100_000);
    const refundRow = await seedProviderRefund(
      world,
      intentId,
      10_000,
      BEFORE_PAID,
    );
    const outboxId = await seedUndeliveredPaid(world, intentId, 100_000);
    const event = providerRefunded(world, refundRow, intentId, 10_000, {
      refundedAt: BEFORE_PAID,
    });

    expect(await deliver(world.tenant, event)).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_PENDING",
      retryable: true,
    });
    expect(await journalCount(world)).toBe(0);

    // The receipt is consumed (journal and delivered status commit together).
    await owner.query(
      "UPDATE domain_event_outbox SET status = 'delivered', delivered_at = now() WHERE tenant_id = $1 AND id = $2",
      [world.tenant.id, outboxId],
    );
    await post(world, paymentPaid(world, intentId, 100_000));

    expect(await sweep(world.tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    const ids = await journalsByKey(world, `aj:provider-refund:${refundRow}`);
    expect(ids).toHaveLength(1);
    expect(await linesOf(world, ids[0]!)).toEqual(refundLines(10_000));
    expect(await balanceOf(world, "gateway_clearing")).toBe(90_000);
  });

  it("1013-AJ-03 a provider refund after the paid and sale journals books once; the old journals do not change and their events replay without error", async () => {
    const world = await makeWorld(await makeTenant());
    const intentId = await seedIntent(world, 100_000);
    const orderUlid = createUlid();
    const sale: Sale = { gross: 90_000, pbjt: 10_000, intentId };
    // The sale was paid on DAY: strictly before the provider refund below.
    await seedPosOrder(world, orderUlid, sale, DAY);

    const paidEvent = paymentPaid(world, intentId, 100_000);
    const saleEvent = orderPaid(world, orderUlid, sale);
    const paid = await post(world, paidEvent);
    const saleEntry = await post(world, saleEvent);
    const paidLines = await linesOf(world, paid.journalEntryId);
    const saleLines = await linesOf(world, saleEntry.journalEntryId);

    // Later the provider refunds Rp10.000 and we record it.
    const refundRow = await seedProviderRefund(
      world,
      intentId,
      10_000,
      AFTER_PAID,
    );
    const refund = await post(
      world,
      providerRefunded(world, refundRow, intentId, 10_000, {
        refundedAt: AFTER_PAID,
      }),
    );
    const entry = await entryOf(world, refund.journalEntryId);
    expect(entry.source_type).toBe("refund");
    expect(entry.entry_date).toBe("2026-10-16");
    expect(await linesOf(world, refund.journalEntryId)).toEqual(
      refundLines(10_000),
    );
    await expectBalanced(world, refund.journalEntryId);
    expect(
      await journalsByKey(world, `aj:provider-refund:${refundRow}`),
    ).toEqual([refund.journalEntryId]);

    // The gateway kept only the net now.
    expect(await balanceOf(world, "gateway_clearing")).toBe(90_000);
    // The sale spent the whole receipt before the refund: the refund is not
    // parked (the money already left); customer_deposit stands Rp10.000 in
    // debit until finance corrects the sale.
    expect(await balanceOf(world, "customer_deposit")).toBe(10_000);
    expect(await journalCount(world)).toBe(3);

    // The earlier journals are exactly as they were.
    expect(await linesOf(world, paid.journalEntryId)).toEqual(paidLines);
    expect(await linesOf(world, saleEntry.journalEntryId)).toEqual(saleLines);

    // The old events, delivered again (same event, or a re-emitted envelope
    // with a new id), are the same business facts: no throw, no new journal.
    for (const replay of [
      paidEvent,
      paymentPaid(world, intentId, 100_000),
      saleEvent,
      orderPaid(world, orderUlid, sale),
    ]) {
      const result = await deliver(world.tenant, replay);
      expect(result.status, replay.name).toBe("already_posted");
    }
    expect(await journalCount(world)).toBe(3);

    // Our own payout after that is still capped: the sale, the provider refund
    // and this payout would take more than the receipt held.
    const ours = await seedOurRefund(world, intentId, 5_000);
    await expectNotPosted(world, paymentRefunded(world, ours, intentId, 5_000));
  });

  it("1013-AJ-03b a sale first booked after a LATER provider refund is judged at its paid time: it posts with its full share", async () => {
    const world = await makeWorld(await makeTenant());
    const intentId = await seedIntent(world, 100_000);
    await post(world, paymentPaid(world, intentId, 100_000));
    // Recorded after the sale was paid (AFTER_PAID > the sale's paid time).
    const refundRow = await seedProviderRefund(
      world,
      intentId,
      10_000,
      AFTER_PAID,
    );
    const orderUlid = createUlid();
    const sale: Sale = { gross: 90_000, pbjt: 10_000, intentId };
    // The sale itself was paid on DAY, before the provider refund row (the
    // default completed_at, now(), would put the sale after it).
    await seedPosOrder(world, orderUlid, sale, DAY);

    // The sale event arrives late, after the refund row exists.
    const saleEntry = await post(world, orderPaid(world, orderUlid, sale));
    expect(await linesOf(world, saleEntry.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 100_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 90_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
    ]);
    await post(
      world,
      providerRefunded(world, refundRow, intentId, 10_000, {
        refundedAt: AFTER_PAID,
      }),
    );
    expect(await balanceOf(world, "gateway_clearing")).toBe(90_000);
    // The receipt was spent by the sale: the refund still books (money left),
    // customer_deposit stands in debit (finance signal).
    expect(await balanceOf(world, "customer_deposit")).toBe(10_000);
  });

  it("1013-AJ-04 the same provider refund through webhook, poller and replay posts exactly one journal; a second refund posts its own", async () => {
    const world = await makeWorld(await makeTenant());
    const intentId = await seedIntent(world, 100_000);
    await post(world, paymentPaid(world, intentId, 100_000));
    const refundRow = await seedProviderRefund(
      world,
      intentId,
      10_000,
      AFTER_PAID,
    );
    const event = providerRefunded(world, refundRow, intentId, 10_000, {
      refundedAt: AFTER_PAID,
    });

    const first = await post(world, event);
    // The identical event again, three times (outbox redelivery).
    for (let replay = 0; replay < 3; replay += 1)
      expect(await deliver(world.tenant, event)).toEqual({
        status: "already_posted",
        journalEntryId: first.journalEntryId,
      });
    // The same refund under new event ids (webhook, then poller, then retry).
    for (let again = 0; again < 2; again += 1)
      expect(
        await deliver(
          world.tenant,
          providerRefunded(world, refundRow, intentId, 10_000, {
            refundedAt: AFTER_PAID,
          }),
        ),
      ).toEqual({
        status: "already_posted",
        journalEntryId: first.journalEntryId,
      });

    expect(
      await journalsByKey(world, `aj:provider-refund:${refundRow}`),
    ).toEqual([first.journalEntryId]);
    expect(await journalCount(world)).toBe(2);
    expect(await balanceOf(world, "gateway_clearing")).toBe(90_000);
    expect(await balanceOf(world, "customer_deposit")).toBe(-90_000);

    // A DIFFERENT provider refund of the same intent is another fact.
    const secondRow = await seedProviderRefund(
      world,
      intentId,
      5_000,
      AFTER_PAID,
    );
    const second = await post(
      world,
      providerRefunded(world, secondRow, intentId, 5_000, {
        refundedAt: AFTER_PAID,
      }),
    );
    expect(second.journalEntryId).not.toBe(first.journalEntryId);
    expect(await journalCount(world)).toBe(3);
    expect(await balanceOf(world, "gateway_clearing")).toBe(85_000);
    expect(await balanceOf(world, "customer_deposit")).toBe(-85_000);
  });

  it("1013-AJ-05 our refunds plus provider refunds never pay out more than the receipt", async () => {
    const world = await makeWorld(await makeTenant());
    const intentId = await seedIntent(world, 100_000);
    await post(world, paymentPaid(world, intentId, 100_000));

    // Our payout of Rp80.000, then the provider's Rp20.000: together exactly the
    // receipt, so the money is fully paid back and nothing is left.
    const ours = await seedOurRefund(world, intentId, 80_000);
    await post(world, paymentRefunded(world, ours, intentId, 80_000));
    const within = await seedProviderRefund(
      world,
      intentId,
      20_000,
      AFTER_PAID,
    );
    await post(
      world,
      providerRefunded(world, within, intentId, 20_000, {
        refundedAt: AFTER_PAID,
      }),
    );
    expect(await balanceOf(world, "gateway_clearing")).toBe(0);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);

    // A further Rp10.000 from the provider would pay out 110.000 of 100.000:
    // it is refused and the books stay at 0.
    // Recorded after `within` (equal instants would be ordered by the random id).
    const over = await seedProviderRefund(
      world,
      intentId,
      10_000,
      AFTER_PAID_LATER,
    );
    await expectNotPosted(
      world,
      providerRefunded(world, over, intentId, 10_000, {
        refundedAt: AFTER_PAID,
      }),
    );
    expect(await journalsByKey(world, `aj:provider-refund:${over}`)).toEqual(
      [],
    );
    expect(await balanceOf(world, "gateway_clearing")).toBe(0);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("1013-AJ-05b the same cap the other way round: after the provider took Rp30.000 our refund cannot take more than the rest", async () => {
    const world = await makeWorld(await makeTenant());
    const intentId = await seedIntent(world, 100_000);
    await post(world, paymentPaid(world, intentId, 100_000));
    const providerRow = await seedProviderRefund(
      world,
      intentId,
      30_000,
      AFTER_PAID,
    );
    await post(
      world,
      providerRefunded(world, providerRow, intentId, 30_000, {
        refundedAt: AFTER_PAID,
      }),
    );
    expect(await balanceOf(world, "gateway_clearing")).toBe(70_000);

    // Our payout of Rp80.000 would bring the total out to 110.000 of 100.000.
    const ours = await seedOurRefund(world, intentId, 80_000);
    await expectNotPosted(
      world,
      paymentRefunded(world, ours, intentId, 80_000),
    );
    expect(await balanceOf(world, "gateway_clearing")).toBe(70_000);

    // The refused refund is withdrawn (a completed row would still count
    // against the receipt, ordered by id at the same instant).
    await owner.query(`DELETE FROM payment_refunds WHERE id = $1`, [ours]);

    // The refused refund is withdrawn (a completed row would still count
    // against the receipt, ordered by id at the same instant).
    await owner.query(`DELETE FROM payment_refunds WHERE id = $1`, [ours]);

    // What is left (Rp70.000) can still be paid back.
    const rest = await seedOurRefund(world, intentId, 70_000);
    await post(world, paymentRefunded(world, rest, intentId, 70_000));
    expect(await balanceOf(world, "gateway_clearing")).toBe(0);
  });

  it("1013-AJ-06 an event that does not match the recorded refund posts nothing: wrong amount, unknown row, other intent", async () => {
    const world = await makeWorld(await makeTenant());
    const intentId = await seedIntent(world, 100_000);
    const otherIntent = await seedIntent(world, 100_000);
    await post(world, paymentPaid(world, intentId, 100_000));
    await post(world, paymentPaid(world, otherIntent, 100_000));
    const row = await seedProviderRefund(world, intentId, 10_000, AFTER_PAID);

    // Control: the matching event posts.
    await post(
      world,
      providerRefunded(world, row, intentId, 10_000, {
        refundedAt: AFTER_PAID,
      }),
    );
    const afterGood = await journalCount(world);

    const second = await seedProviderRefund(world, intentId, 5_000, AFTER_PAID);
    // Amount differs from what was recorded.
    await expectNotPosted(
      world,
      providerRefunded(world, second, intentId, 6_000, {
        refundedAt: AFTER_PAID,
      }),
    );
    // The row does not exist.
    await expectNotPosted(
      world,
      providerRefunded(world, randomUUID(), intentId, 5_000, {
        refundedAt: AFTER_PAID,
      }),
    );
    // The row belongs to another intent.
    await expectNotPosted(
      world,
      providerRefunded(world, second, otherIntent, 5_000, {
        refundedAt: AFTER_PAID,
      }),
    );
    expect(await journalCount(world)).toBe(afterGood);
    expect(await journalsByKey(world, `aj:provider-refund:${second}`)).toEqual(
      [],
    );
    expect(await balanceOf(world, "gateway_clearing")).toBe(190_000);
  });

  it("1013-AJ-07 another tenant is never touched: its journals stay, and an event naming its refund posts nothing here", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const a = await makeWorld(tenantA);
    const b = await makeWorld(tenantB);
    const intentA = await seedIntent(a, 100_000);
    const intentB = await seedIntent(b, 100_000);
    await post(a, paymentPaid(a, intentA, 100_000));
    await post(b, paymentPaid(b, intentB, 100_000));
    const refundA = await seedProviderRefund(a, intentA, 10_000, AFTER_PAID);
    const refundB = await seedProviderRefund(b, intentB, 10_000, AFTER_PAID);

    const bBefore = {
      journals: await journalCount(b),
      clearing: await balanceOf(b, "gateway_clearing"),
      deposit: await balanceOf(b, "customer_deposit"),
    };

    // Tenant A's refund books in A only.
    await post(
      a,
      providerRefunded(a, refundA, intentA, 10_000, { refundedAt: AFTER_PAID }),
    );
    expect(await balanceOf(a, "gateway_clearing")).toBe(90_000);
    expect(
      await journalsByKey(a, `aj:provider-refund:${refundA}`),
    ).toHaveLength(1);

    // A forged event of tenant A that names tenant B's refund and intent.
    await expectNotPosted(
      a,
      providerRefunded(a, refundB, intentB, 10_000, { refundedAt: AFTER_PAID }),
    );

    expect(await journalCount(b)).toBe(bBefore.journals);
    expect(await balanceOf(b, "gateway_clearing")).toBe(bBefore.clearing);
    expect(await balanceOf(b, "customer_deposit")).toBe(bBefore.deposit);
    expect(await journalsByKey(b, `aj:provider-refund:${refundB}`)).toEqual([]);
    expect(await journalsByKey(a, `aj:provider-refund:${refundB}`)).toEqual([]);
  });

  it("1013-AJ-08 the recorder emits one payment.provider_refunded per newly recorded refund and none for duplicate, own, retry or unbound", async () => {
    const world = await makeWorld(await makeTenant());
    const intentId = await seedIntent(world, 100_000);
    const ref = `DOIT-${short()}`;
    await setIntentProviderRef(intentId, ref);
    expect(await emittedRefundEvents(world)).toBe(0);

    // recorded: exactly one event, naming the recorded row.
    expect(
      await record(world, intentId, {
        providerRefundId: "rf_a",
        providerPaymentRef: ref,
      }),
    ).toBe("recorded");
    expect(await emittedRefundEvents(world)).toBe(1);
    const { rows } = await owner.query<{ payload: Record<string, unknown> }>(
      `SELECT event->'payload' AS payload FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'payment.provider_refunded'`,
      [world.tenant.id],
    );
    expect(rows[0]!.payload).toMatchObject({
      providerRefundId: await providerRowId(world, "rf_a"),
      paymentIntentId: intentId,
      amountIdr: 10_000,
    });

    // duplicate (a retried webhook, the poller): nothing more.
    expect(
      await record(world, intentId, {
        providerRefundId: "rf_a",
        providerPaymentRef: ref,
      }),
    ).toBe("duplicate");
    // unbound: the payment is not one of this tenant's.
    expect(
      await record(world, intentId, {
        providerRefundId: "rf_u",
        providerPaymentRef: "DOIT-OTHER",
      }),
    ).toBe("unbound");
    // own: the echo of a refund we sent.
    await seedOurRefund(world, intentId, 5_000, { providerRef: "rf_own" });
    expect(
      await record(world, intentId, {
        providerRefundId: "rf_own",
        providerPaymentRef: ref,
      }),
    ).toBe("own");
    expect(await emittedRefundEvents(world)).toBe(1);

    // retry: a refund of ours is in flight with no reference yet.
    const other = await seedIntent(world, 100_000);
    const otherRef = `DOIT-${short()}`;
    await setIntentProviderRef(other, otherRef);
    await seedOurRefund(world, other, 5_000, {
      status: "approved",
      attempts: 1,
    });
    expect(
      await record(world, other, {
        providerRefundId: "rf_r",
        providerPaymentRef: otherRef,
      }),
    ).toBe("retry");
    expect(await emittedRefundEvents(world)).toBe(1);
    // forced (the retry window is over): recorded, one more event.
    expect(
      await record(world, other, {
        providerRefundId: "rf_r",
        providerPaymentRef: otherRef,
        force: true,
      }),
    ).toBe("recorded");
    expect(await emittedRefundEvents(world)).toBe(2);
  });

  it("1013-AJ-09 a forced provider refund whose twin of ours gets its reference late is journaled once: the payout is the echo (either order)", async () => {
    for (const providerFirst of [true, false]) {
      const world = await makeWorld(await makeTenant());
      const intentId = await seedIntent(world, 100_000);
      const ref = `DOIT-${short()}`;
      await setIntentProviderRef(intentId, ref);
      await post(world, paymentPaid(world, intentId, 100_000));
      // Our refund of 40.000 is in flight (no reference yet) when the provider
      // reports the same money; the recorder is forced past its retry window.
      const ours = await seedOurRefund(world, intentId, 40_000, {
        status: "approved",
        attempts: 1,
      });
      expect(
        await record(world, intentId, {
          providerRefundId: "rf_late",
          providerPaymentRef: ref,
          amountIdr: 40_000,
          force: true,
        }),
      ).toBe("recorded");
      const rowId = await providerRowId(world, "rf_late");
      const before = await journalCount(world);

      if (providerFirst) {
        // Our refund may still be the echo: the provider journal waits.
        await expectNotPosted(
          world,
          providerRefunded(world, rowId, intentId, 40_000),
        );
        expect(
          await journalsByKey(world, `aj:provider-refund:${rowId}`),
        ).toEqual([]);
      }
      // The reference is matched late and our refund completes.
      await completeOurRefund(ours, "rf_late");
      if (providerFirst) {
        // The provider journal now steps aside: a completed refund of ours is it.
        const result = await deliver(
          world.tenant,
          providerRefunded(world, rowId, intentId, 40_000),
        );
        expect(result.status).not.toBe("posted");
        await post(world, paymentRefunded(world, ours, intentId, 40_000));
      } else {
        // Our payout journal first, then the provider event: nothing twice.
        await post(world, paymentRefunded(world, ours, intentId, 40_000));
        const result = await deliver(
          world.tenant,
          providerRefunded(world, rowId, intentId, 40_000),
        );
        expect(result.status).not.toBe("posted");
      }
      expect(await journalCount(world)).toBe(before + 1);
      expect(await journalsByKey(world, `aj:provider-refund:${rowId}`)).toEqual(
        [],
      );
      expect(await balanceOf(world, "gateway_clearing")).toBe(60_000);
      expect(await balanceOf(world, "customer_deposit")).toBe(-60_000);
    }
  });

  it("1013-AJ-09b the safety net: our payout whose provider reference names a provider refund already journaled books nothing", async () => {
    const world = await makeWorld(await makeTenant());
    const intentId = await seedIntent(world, 100_000);
    await post(world, paymentPaid(world, intentId, 100_000));
    const rowId = await seedProviderRefund(
      world,
      intentId,
      40_000,
      AFTER_PAID,
      "rf_net",
    );
    await post(world, providerRefunded(world, rowId, intentId, 40_000));
    // Our refund looked unrelated when the provider journal posted; its
    // reference is matched afterwards.
    const ours = await seedOurRefund(world, intentId, 40_000, {
      providerRef: "rf_net",
    });
    const before = await journalCount(world);
    const result = await deliver(
      world.tenant,
      paymentRefunded(world, ours, intentId, 40_000),
    );
    expect(result.status).not.toBe("posted");
    expect(await journalCount(world)).toBe(before);
    expect(await balanceOf(world, "gateway_clearing")).toBe(60_000);
  });

  it("1013-AJ-10 a refund of ours that failed (even with a reference) was never the echo: the provider refund still books", async () => {
    const world = await makeWorld(await makeTenant());
    const intentId = await seedIntent(world, 100_000);
    await post(world, paymentPaid(world, intentId, 100_000));
    await seedOurRefund(world, intentId, 40_000, {
      status: "failed",
      providerRef: "rf_f",
    });
    const rowId = await seedProviderRefund(
      world,
      intentId,
      40_000,
      AFTER_PAID,
      "rf_f",
    );
    await post(world, providerRefunded(world, rowId, intentId, 40_000));
    expect(
      await journalsByKey(world, `aj:provider-refund:${rowId}`),
    ).toHaveLength(1);
    expect(await balanceOf(world, "gateway_clearing")).toBe(60_000);
  });

  it("1013-AJ-11 the cap holds whatever order the events come in: our payout of 80.000 first or the provider refund of 30.000 first", async () => {
    for (const ourFirst of [true, false]) {
      const world = await makeWorld(await makeTenant());
      const intentId = await seedIntent(world, 100_000);
      await post(world, paymentPaid(world, intentId, 100_000));
      // Our payout completed before the provider refund was recorded.
      const ours = await seedOurRefund(world, intentId, 80_000);
      const row = await seedProviderRefund(
        world,
        intentId,
        30_000,
        AFTER_PAID_LATER,
      );
      const payout = paymentRefunded(world, ours, intentId, 80_000);
      const provider = providerRefunded(world, row, intentId, 30_000, {
        refundedAt: AFTER_PAID_LATER,
      });
      if (ourFirst) {
        await post(world, payout);
        await expectNotPosted(world, provider);
      } else {
        await expectNotPosted(world, provider);
        await post(world, payout);
      }
      expect(await journalsByKey(world, `aj:provider-refund:${row}`)).toEqual(
        [],
      );
      expect(await balanceOf(world, "gateway_clearing")).toBe(20_000);
    }
  });
});
