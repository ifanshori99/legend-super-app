// Sale journal of a split-bill QR pay-first order (legend-gzu54, brief
// docs/briefs/255a-test-qr-split-sale-journal.md).
//
// One QR pay-first order (due 110k = 100k + 10% PBJT, no DP), one payment link,
// several paid intents on that link, each paying part of the bill. The order is
// pinned to one payer intent (P) that alone took less than total - DP. The
// `order.paid` sale must still post: each contributor (intent with an
// allocation > 0, evidence less unallocated funds) holds min(total - DP,
// allocation) of the sale, drawn from its own receipt.
//
// Assumptions:
// - Test names carry SALE-n (the brief's ids); no features.json id exists for
//   them (it is a backend journal test).
// - SALE-7: the brief says customer_deposit nets to 0, but the 50k fund of the
//   payer is money that belongs to no bill, so it stays in customer_deposit
//   (receipts 110k + 50k, sale 110k). The test asserts -50_000; the sale
//   itself debits customer_deposit 110k.
// - SALE-5: the "none" receipt is an intent with evidence whose payment.paid
//   is neither delivered nor in the outbox (pre-cutover, as AJ-QR-04).
// - SALE-6: the final refund of N (10k, completed 2026-10-16) is delivered as
//   a payout and posts before the order fires (2026-10-17); the intent turns
//   partially_refunded.
// - Helpers are copied from accounting-auto-journal.test.ts and
//   accounting-auto-journal-split-qr-guard.test.ts (old files unchanged).

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
/** 2026-10-15 12:00 in Jakarta; the order fires and the money arrives here. */
const DAY = "2026-10-15T05:00:00.000Z";
/** Completion instant of payouts: after the order fired. */
const REFUND_DAY = "2026-10-16T05:00:00.000Z";

const FLAGS_ON = JSON.stringify({
  modules: ["accounting"],
  integrationProviders: [],
});

type Role =
  | "gateway_clearing"
  | "tax_payable_pbjt"
  | "customer_deposit"
  | "sales_revenue";

const CHART: [Role, string, string, string, string][] = [
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
     VALUES ($1, $2, 'Uji Split QR', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-sq-${id.slice(0, 8)}`,
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

async function makeWorld(tenant: Tenant): Promise<World> {
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenant.id, `Entity SQ ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet SQ', 'Jl. SQ', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      outletId,
      tenant.id,
      tenant.brandId,
      entity,
      `SQ-${short()}`.toUpperCase(),
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

/** One payment link of the whole bill (due 110k). */
async function seedLink(world: World, totalIdr: number): Promise<string> {
  const linkId = randomUUID();
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'seed')`,
    [
      linkId,
      world.tenant.id,
      world.outletId,
      randomBytes(32).toString("hex"),
      `SQ-${linkId.slice(0, 8)}`,
      totalIdr,
    ],
  );
  return linkId;
}

/** A paid gateway intent on the given link, with its evidence (money in). */
async function seedIntentOnLink(
  world: World,
  linkId: string,
  amountIdr: number,
  evidenceIdr: number = amountIdr,
): Promise<{ intentId: string; evidenceId: string }> {
  const intentId = randomUUID();
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
      `sq-${intentId}`,
      DAY,
    ],
  );
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, $6)
     RETURNING id`,
    [
      world.tenant.id,
      world.outletId,
      intentId,
      `sq-ref-${intentId}`,
      evidenceIdr,
      DAY,
    ],
  );
  return { intentId, evidenceId: rows[0]!.id };
}

/** Money of an intent's evidence that belongs to no bill (PAY-04). */
async function seedFund(
  world: World,
  intentId: string,
  evidenceId: string,
  amountIdr: number,
  reason: "overpayment" | "double_payment" = "double_payment",
): Promise<void> {
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      world.tenant.id,
      world.outletId,
      intentId,
      evidenceId,
      amountIdr,
      reason,
    ],
  );
}

/** A fired QR pay-first order of 100k + 10k PBJT (due 110k), pinned to payerId. */
async function seedSplitOrder(
  world: World,
  linkId: string,
  payerIntentId: string,
  orderUlid: string,
  firedAt: string = DAY,
): Promise<void> {
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
        firedAt,
        linkId,
        payerIntentId,
      ],
    ),
  );
}

/** A completed gateway payout of an intent (or one of its funds) at REFUND_DAY. */
async function seedRefund(
  world: World,
  intentId: string,
  amountIdr: number,
): Promise<string> {
  const refundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, completed_at, unallocated_fund_id)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian dana', 'completed', 'requester', 'approver', $6, $6, NULL)`,
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

// ---- events -----------------------------------------------------------------

function envelope(
  world: World,
  input: {
    name: string;
    aggregateType?: string;
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
    aggregateType: input.aggregateType ?? "payment",
    aggregateId: input.aggregateId,
    sequence: 1,
    occurredAt: input.occurredAt,
    actor: { type: "system" },
    idempotencyKey: `sq-test-${id}`,
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload,
  });
}

function paymentPaid(world: World, intentId: string, receivedIdr: number) {
  return envelope(world, {
    name: "payment.paid",
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

function paymentRefunded(
  world: World,
  refundId: string,
  intentId: string,
  amountIdr: number,
) {
  return envelope(world, {
    name: "payment.refunded",
    aggregateId: refundId,
    occurredAt: REFUND_DAY,
    payload: { refundId, paymentIntentId: intentId, amountIdr },
  });
}

/** An event as a pending outbox row ("emitted but not consumed yet"). */
async function seedOutboxEvent(
  world: World,
  event: EventEnvelope,
  aggregateUuid: string,
): Promise<string> {
  const outboxId = randomUUID();
  await owner.query(
    `INSERT INTO domain_event_outbox
       (tenant_id, id, outlet_id, event_id, aggregate_type, aggregate_id, sequence, event, destination)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7, 'cloud-sync')`,
    [
      world.tenant.id,
      outboxId,
      world.outletId,
      randomUUID(),
      event.aggregateType,
      aggregateUuid,
      JSON.stringify(event),
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
  if (result.status !== "posted")
    throw new Error(`expected a posted journal, got ${JSON.stringify(result)}`);
  return result;
}

async function balanceOf(world: World, role: Role): Promise<number> {
  const { rows } = await owner.query<{ balance: string | null }>(
    `SELECT sum(debit_idr - credit_idr)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [world.tenant.id, world.accounts[role]],
  );
  return Number(rows[0]!.balance ?? 0);
}

const AMOUNTS_MISMATCH = {
  status: "parked",
  code: "POSTING_AMOUNTS_MISMATCH",
  retryable: false,
} as const;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.end();
});

// ---- extra helpers ------------------------------------------------------------

/** The order.paid of the split order: one gateway tender of the whole due 110k. */
function splitOrderPaid(
  world: World,
  orderUlid: string,
  paidAt: string = DAY,
): EventEnvelope {
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
      paidAt,
    },
  });
}

async function journalIdOf(world: World, key: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2",
    [world.tenant.id, key],
  );
  expect(rows, key).toHaveLength(1);
  return rows[0]!.id;
}

async function saleJournalCount(
  world: World,
  orderUlid: string,
): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2",
    [world.tenant.id, `aj:sale:${orderUlid}`],
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

async function parkedOf(tenant: Tenant, key: string) {
  return asTenant(tenant, async (client) => {
    const { rows } = await client.query<{
      error_code: string;
      retryable: boolean;
    }>(
      "SELECT error_code, retryable FROM auto_journal_parked WHERE tenant_id = $1 AND idempotency_key = $2",
      [tenant.id, key],
    );
    return rows;
  });
}

let sweepCount = 0;
function sweep(tenant: Tenant) {
  sweepCount += 1;
  return retryParkedAutoJournals(
    contextOf(tenant),
    new Date(SWEEP_AT.getTime() + sweepCount * 60 * 60 * 1000),
  );
}

const SALE_LINES = [
  { role: "customer_deposit", debit: 110_000, credit: 0 },
  { role: "sales_revenue", debit: 0, credit: 100_000 },
  { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
];

// ============================================================================

describe("legend-gzu54 order.paid sale journal of a split-bill QR order", () => {
  it("SALE-1 two codes 60k + 50k, both receipts posted first: the sale posts and customer_deposit nets to 0", async () => {
    const world = await makeWorld(await makeTenant());
    const linkId = await seedLink(world, 110_000);
    const payer = await seedIntentOnLink(world, linkId, 60_000);
    const other = await seedIntentOnLink(world, linkId, 50_000);
    const orderUlid = createUlid();
    await seedSplitOrder(world, linkId, payer.intentId, orderUlid);
    await post(world, paymentPaid(world, payer.intentId, 60_000));
    await post(world, paymentPaid(world, other.intentId, 50_000));

    const result = await post(world, splitOrderPaid(world, orderUlid));
    expect(await linesOf(world, result.journalEntryId)).toEqual(SALE_LINES);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await balanceOf(world, "gateway_clearing")).toBe(110_000);
    expect(await parkedOf(world.tenant, `aj:sale:${orderUlid}`)).toHaveLength(
      0,
    );
  });

  it("SALE-2 three codes 50k + 40k + 20k, all posted: the sale posts and customer_deposit nets to 0", async () => {
    const world = await makeWorld(await makeTenant());
    const linkId = await seedLink(world, 110_000);
    const payer = await seedIntentOnLink(world, linkId, 50_000);
    const second = await seedIntentOnLink(world, linkId, 40_000);
    const third = await seedIntentOnLink(world, linkId, 20_000);
    const orderUlid = createUlid();
    await seedSplitOrder(world, linkId, payer.intentId, orderUlid);
    await post(world, paymentPaid(world, payer.intentId, 50_000));
    await post(world, paymentPaid(world, second.intentId, 40_000));
    await post(world, paymentPaid(world, third.intentId, 20_000));

    const result = await post(world, splitOrderPaid(world, orderUlid));
    expect(await linesOf(world, result.journalEntryId)).toEqual(SALE_LINES);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("SALE-3 one receipt still in the outbox: the sale parks RECEIPT_PENDING (retryable); after the receipt and the sweep it posts", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const linkId = await seedLink(world, 110_000);
    const payer = await seedIntentOnLink(world, linkId, 60_000);
    const other = await seedIntentOnLink(world, linkId, 50_000);
    const orderUlid = createUlid();
    await seedSplitOrder(world, linkId, payer.intentId, orderUlid);
    await post(world, paymentPaid(world, payer.intentId, 60_000));
    const receiptEvent = paymentPaid(world, other.intentId, 50_000);
    const outboxId = await seedOutboxEvent(world, receiptEvent, other.intentId);

    expect(await deliver(tenant, splitOrderPaid(world, orderUlid))).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_PENDING",
      retryable: true,
    });
    expect(await saleJournalCount(world, orderUlid)).toBe(0);

    await markDelivered(world, outboxId);
    await post(world, receiptEvent);
    expect(await sweep(tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    const saleId = await journalIdOf(world, `aj:sale:${orderUlid}`);
    expect(await linesOf(world, saleId)).toEqual(SALE_LINES);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    expect(await parkedOf(tenant, `aj:sale:${orderUlid}`)).toHaveLength(0);
  });

  it("SALE-4 parts 60k + 30k are below the due 110k: the sale parks PAYLOAD_INVALID (non-retryable) and nothing is journaled", async () => {
    const world = await makeWorld(await makeTenant());
    const linkId = await seedLink(world, 110_000);
    const payer = await seedIntentOnLink(world, linkId, 60_000);
    const other = await seedIntentOnLink(world, linkId, 30_000);
    const orderUlid = createUlid();
    await seedSplitOrder(world, linkId, payer.intentId, orderUlid);
    await post(world, paymentPaid(world, payer.intentId, 60_000));
    await post(world, paymentPaid(world, other.intentId, 30_000));

    expect(
      await deliver(world.tenant, splitOrderPaid(world, orderUlid)),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      retryable: false,
    });
    expect(await saleJournalCount(world, orderUlid)).toBe(0);
    expect(await balanceOf(world, "customer_deposit")).toBe(-90_000);
  });

  it("SALE-5 a contributor without a receipt (pre-cutover) is debited to gateway_clearing; the posted one to customer_deposit", async () => {
    const world = await makeWorld(await makeTenant());
    const linkId = await seedLink(world, 110_000);
    const payer = await seedIntentOnLink(world, linkId, 60_000);
    // N: evidence exists, but its payment.paid is neither delivered nor in the outbox.
    await seedIntentOnLink(world, linkId, 50_000);
    const orderUlid = createUlid();
    await seedSplitOrder(world, linkId, payer.intentId, orderUlid);
    await post(world, paymentPaid(world, payer.intentId, 60_000));

    const result = await post(world, splitOrderPaid(world, orderUlid));
    expect(await linesOf(world, result.journalEntryId)).toEqual(
      [
        { role: "customer_deposit", debit: 60_000, credit: 0 },
        { role: "gateway_clearing", debit: 50_000, credit: 0 },
        { role: "sales_revenue", debit: 0, credit: 100_000 },
        { role: "tax_payable_pbjt", debit: 0, credit: 10_000 },
      ].sort((a, b) => a.role.localeCompare(b.role)),
    );
    // The 60k receipt is fully spent by the sale.
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("SALE-6 a final refund of N before the sale leaves its receipt short of its part: the sale parks POSTING_AMOUNTS_MISMATCH", async () => {
    const world = await makeWorld(await makeTenant());
    const linkId = await seedLink(world, 110_000);
    const payer = await seedIntentOnLink(world, linkId, 60_000);
    const other = await seedIntentOnLink(world, linkId, 50_000);
    const orderUlid = createUlid();
    // The order fires after the refund completed (REFUND_DAY = 10-16).
    const FIRED_LATE = "2026-10-17T05:00:00.000Z";
    await seedSplitOrder(world, linkId, payer.intentId, orderUlid, FIRED_LATE);
    await post(world, paymentPaid(world, payer.intentId, 60_000));
    await post(world, paymentPaid(world, other.intentId, 50_000));
    const refundId = await seedRefund(world, other.intentId, 10_000);
    await owner.query(
      "UPDATE payment_intents SET status = 'partially_refunded' WHERE tenant_id = $1 AND id = $2",
      [world.tenant.id, other.intentId],
    );
    await post(world, paymentRefunded(world, refundId, other.intentId, 10_000));

    expect(
      await deliver(world.tenant, splitOrderPaid(world, orderUlid, FIRED_LATE)),
    ).toEqual(AMOUNTS_MISMATCH);
    expect(await saleJournalCount(world, orderUlid)).toBe(0);
  });

  it("SALE-7 payer with 110k evidence of which 50k is an unallocated fund (allocation 60k) + N 50k: the sale posts", async () => {
    const world = await makeWorld(await makeTenant());
    const linkId = await seedLink(world, 110_000);
    const payer = await seedIntentOnLink(world, linkId, 110_000);
    await seedFund(world, payer.intentId, payer.evidenceId, 50_000);
    const other = await seedIntentOnLink(world, linkId, 50_000);
    const orderUlid = createUlid();
    await seedSplitOrder(world, linkId, payer.intentId, orderUlid);
    await post(world, paymentPaid(world, payer.intentId, 110_000));
    await post(world, paymentPaid(world, other.intentId, 50_000));

    const result = await post(world, splitOrderPaid(world, orderUlid));
    expect(await linesOf(world, result.journalEntryId)).toEqual(SALE_LINES);
    // See the header: the 50k fund belongs to no bill and stays in customer_deposit.
    expect(await balanceOf(world, "customer_deposit")).toBe(-50_000);
  });
});
