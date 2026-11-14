// legend-2jyr + legend-27mt: `order.refunded` splits its gateway part.
//
// Rule under test (brief 2jyr, consumer side; the event payload is unchanged):
// the gateway part of a POS / recovery refund (`refundGatewayIdr`) is credited
// to `customer_deposit` ONLY for the portion that a payment refund row will
// pay out later (the `payment.refunded` that clears it) AND whose intent
// receipt is posted. Every other gateway part is credited to `gateway_clearing`
// (it reverses the sale's clearing debit and never emits `payment.refunded`).
//
// Link between an order refund and its payment refund rows (brief):
// - POS refund: `payment_admin_idempotency` key
//   `pos-refund-gateway:<posRefundId>:<intentId>` with response.refundId =
//   payment_refunds.id.
// - Recovery refund: `payment_refunds.order_issue_id` = the refund id (issue id).
// Per linked intent the receipt state decides: posted -> customer_deposit,
// none (money paid before the auto-journal wiring) -> gateway_clearing,
// pending (receipt still in the outbox) -> the refund parks retryable
// AUTO_JOURNAL_RECEIPT_PENDING and the sweep posts it once the receipt posted.
//
// Assumptions:
// - Fixtures (tenant, chart, intent, POS order, events) are copied from
//   accounting-auto-journal.test.ts (AJ-142-F1*, legend-hxpd5), which does not
//   export them.
// - "customer_deposit never negative" means the account never carries a DEBIT
//   balance (balanceOf = debit - credit stays <= 0), as the legend-hxpd5 tests
//   treat it.
// - Linked payment refund rows are seeded `completed`; the status of a linked
//   row is not part of this spec (the brief says "sum of linked rows").
// - A tender that has an intent but no linked payment refund row (intent
//   skipped: EDC / unsettled / room 0) counts as intentless: gateway_clearing.
// - A pending receipt is reached after the sale posted at cutover (receipt
//   did not exist then) and the receipt event then shows up in the outbox.

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
/** 2026-10-15 12:00 in Jakarta: business date 2026-10-15. */
const DAY = "2026-10-15T05:00:00.000Z";
const T_SALE = "2026-10-15T04:00:00.000Z";
/** Completion instant of seeded payment refunds (after the order refund). */
const REFUND_DAY = "2026-10-16T05:00:00.000Z";

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
     VALUES ($1, $2, 'Uji Refund Split', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-rs-${id.slice(0, 8)}`,
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

/** Owner connection with the tenant GUCs set; `replica` skips FK triggers. */
async function asTenant<T>(
  tenant: Tenant,
  run: (client: PoolClient) => Promise<T>,
  { replica = false }: { replica?: boolean } = {},
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    if (replica)
      await client.query("SET LOCAL session_replication_role = replica");
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
    [entity, tenant.id, `Entity RS ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet RS', 'Jl. RS', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      outletId,
      tenant.id,
      tenant.brandId,
      entity,
      `RS-${short()}`.toUpperCase(),
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
      `RS-${linkId.slice(0, 8)}`,
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
      `rs-${intentId}`,
      DAY,
    ],
  );
  return intentId;
}

/** A completed gateway payment refund (payout done) of an intent. */
async function seedPaymentRefund(
  world: World,
  intentId: string,
  amountIdr: number,
  orderIssueId: string | null = null,
): Promise<string> {
  const refundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, completed_at, order_issue_id)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian dana', 'completed', 'requester', 'approver', $6, $6, $7)`,
    [
      refundId,
      world.tenant.id,
      world.outletId,
      intentId,
      amountIdr,
      REFUND_DAY,
      orderIssueId,
    ],
  );
  return refundId;
}

/** Maps a POS refund to its gateway payment refund (pos-refund-gateway key). */
async function linkPosGatewayRefund(
  world: World,
  posRefundId: string,
  intentId: string,
  paymentRefundId: string,
): Promise<void> {
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

type TenderMethod = "cash" | "qris";
type Tender = {
  method: TenderMethod;
  amountIdr: number;
  intentId?: string;
};

/** The POS order and its tenders; gross = tenders total - pbjt. */
async function seedPosOrder(
  world: World,
  orderUlid: string,
  tenders: Tender[],
  pbjtIdr: number,
): Promise<number> {
  const orderId = ulidToUuid(orderUlid);
  const total = tenders.reduce((sum, tender) => sum + tender.amountIdr, 0);
  const gross = total - pbjtIdr;
  await asTenant(world.tenant, async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at, deposit_applied_idr, table_session_id)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, $6, 0, $7,
               'completed', '2026-10-15', now(), 0, NULL)`,
      [
        orderId,
        world.tenant.id,
        world.outletId,
        `RS-${short()}`,
        gross,
        pbjtIdr,
        total,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', now(), $4::timestamptz)`,
      [orderId, world.tenant.id, world.outletId, T_SALE],
    );
    for (const tender of tenders) {
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
  return gross;
}

/** The captured tender of the order that names `intentId` (null: no intent). */
async function tenderIdOf(
  world: World,
  orderUlid: string,
  intentId: string | null,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM pos_order_tenders
      WHERE tenant_id = $1 AND order_id = $2 AND method = 'qris'
        AND payment_intent_id IS NOT DISTINCT FROM $3::uuid`,
    [world.tenant.id, ulidToUuid(orderUlid), intentId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

/** The pos_order_refunds row of a POS refund of the order; its id. */
async function seedPosRefund(
  world: World,
  orderUlid: string,
  lines: {
    method: TenderMethod;
    amountIdr: number;
    tenderId?: string;
    paymentIntentId?: string | null;
  }[],
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

/** A resolved ORD-09 failed-item issue of the order (user and menu FKs skipped). */
async function seedIssue(world: World, orderUlid: string): Promise<string> {
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
        [
          itemId,
          world.tenant.id,
          world.outletId,
          ulidToUuid(orderUlid),
          randomUUID(),
        ],
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
          ulidToUuid(orderUlid),
          itemId,
          randomUUID(),
          randomUUID(),
          `rs-issue-${randomUUID()}`,
        ],
      );
    },
    { replica: true },
  );
  return issueId;
}

// ---- synthetic events -------------------------------------------------------

function envelope(
  world: World,
  input: {
    name: string;
    aggregateType: string;
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
    idempotencyKey: `rs-test-${id}`,
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

const sumOf = (tenders: Tender[], method: TenderMethod) =>
  tenders
    .filter((tender) => tender.method === method)
    .reduce((total, tender) => total + tender.amountIdr, 0);

function orderPaid(
  world: World,
  orderUlid: string,
  tenders: Tender[],
  pbjtIdr: number,
): EventEnvelope {
  const total = sumOf(tenders, "cash") + sumOf(tenders, "qris");
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
      grossSalesIdr: total - pbjtIdr,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr,
      roundingIdr: 0,
      totalIdr: total,
      paidCashIdr: sumOf(tenders, "cash"),
      paidGatewayIdr: sumOf(tenders, "qris"),
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      tenders: tenders.map((tender) => ({
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

type RefundLines = { method: TenderMethod; amountIdr: number }[];

function orderRefunded(
  world: World,
  orderUlid: string,
  refundId: string,
  lines: RefundLines,
  pbjtIdr: number,
): EventEnvelope {
  const cash = lines
    .filter((line) => line.method === "cash")
    .reduce((total, line) => total + line.amountIdr, 0);
  const gateway = lines
    .filter((line) => line.method === "qris")
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
      amountIdr: cash + gateway,
      reason: "customer_request",
      reasonNote: "Pesanan salah",
      approvedBy: randomUUID(),
      overrideId: null,
      approvalRequestId: null,
      grossSalesIdr: cash + gateway - pbjtIdr,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr,
      refundCashIdr: cash,
      refundGatewayIdr: gateway,
      refundEdcIdr: 0,
      refundPointsIdr: 0,
      lines,
      refundedAt: DAY,
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

let sweepCount = 0;
function sweep(tenant: Tenant) {
  sweepCount += 1;
  return retryParkedAutoJournals(
    contextOf(tenant),
    new Date(SWEEP_AT.getTime() + sweepCount * 60 * 60 * 1000),
  );
}

async function post(world: World, event: EventEnvelope) {
  const result = await deliver(world.tenant, event);
  expect(result.status).toBe("posted");
  if (result.status !== "posted") throw new Error("not posted");
  return result;
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

async function journalCount(world: World): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [world.tenant.id, world.entity],
  );
  return Number(rows[0]!.n);
}

async function journalsWithKey(world: World, key: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2",
    [world.tenant.id, key],
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

async function parkedOf(
  tenant: Tenant,
  key: string,
): Promise<{ error_code: string; retryable: boolean }[]> {
  return asTenant(tenant, async (client) => {
    const { rows } = await client.query<{
      error_code: string;
      retryable: boolean;
    }>(
      `SELECT error_code, retryable FROM auto_journal_parked
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenant.id, key],
    );
    return rows;
  });
}

/** customer_deposit is a liability: it must never carry a debit balance. */
async function expectDepositNotNegative(world: World): Promise<void> {
  expect(await balanceOf(world, "customer_deposit")).toBeLessThanOrEqual(0);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.end();
});

// ============================================================================

describe("legend-2jyr legend-27mt order.refunded splits its gateway part", () => {
  /**
   * One intent of `amountIdr` in the given receipt state. posted: the receipt
   * journal exists (sale debits customer_deposit). none: paid before the
   * wiring, no receipt (sale debits gateway_clearing). pending: see
   * `makeReceiptPending`.
   */
  async function intentWith(
    world: World,
    amountIdr: number,
    receipt: "posted" | "none",
  ): Promise<string> {
    const intentId = await seedIntent(world, amountIdr);
    if (receipt === "posted")
      await post(world, paymentPaid(world, intentId, amountIdr));
    return intentId;
  }

  /** Delivers the sale; the sale journal must be posted before any refund. */
  async function sell(
    world: World,
    tenders: Tender[],
    pbjtIdr = 0,
  ): Promise<string> {
    const orderUlid = createUlid();
    await seedPosOrder(world, orderUlid, tenders, pbjtIdr);
    await post(world, orderPaid(world, orderUlid, tenders, pbjtIdr));
    return orderUlid;
  }

  /**
   * A POS refund of the order. `links` are the gateway payment refunds the POS
   * refund filed (one per intent); returns the pos refund id (= event refundId)
   * and the payment refund ids.
   */
  async function posRefund(
    world: World,
    orderUlid: string,
    lines: RefundLines,
    links: { intentId: string; amountIdr: number }[],
  ) {
    const refundId = await seedPosRefund(world, orderUlid, lines);
    const paymentRefundIds: string[] = [];
    for (const link of links) {
      const paymentRefundId = await seedPaymentRefund(
        world,
        link.intentId,
        link.amountIdr,
      );
      await linkPosGatewayRefund(
        world,
        refundId,
        link.intentId,
        paymentRefundId,
      );
      paymentRefundIds.push(paymentRefundId);
    }
    return { refundId, paymentRefundIds };
  }

  it("AJ-2JYR-01 a gateway refund backed by a payment refund of an intent with a posted receipt credits customer_deposit (owed until payout); the payout then clears it", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const intentId = await intentWith(world, 110_000, "posted");
    const tenders: Tender[] = [
      { method: "qris", amountIdr: 110_000, intentId },
    ];
    const orderUlid = await sell(world, tenders, 10_000);
    const lines: RefundLines = [{ method: "qris", amountIdr: 44_000 }];
    const { refundId, paymentRefundIds } = await posRefund(
      world,
      orderUlid,
      lines,
      [{ intentId, amountIdr: 44_000 }],
    );

    const refund = await post(
      world,
      orderRefunded(world, orderUlid, refundId, lines, 4_000),
    );
    expect(await linesOf(world, refund.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 0, credit: 44_000 },
      { role: "sales_revenue", debit: 40_000, credit: 0 },
      { role: "tax_payable_pbjt", debit: 4_000, credit: 0 },
    ]);
    await expectBalanced(world, refund.journalEntryId);

    // The payout (payment.refunded) clears exactly what the refund credited.
    await post(
      world,
      paymentRefunded(world, paymentRefundIds[0]!, intentId, 44_000),
    );
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    // receipt +110k, payout -44k
    expect(await balanceOf(world, "gateway_clearing")).toBe(66_000);
  });

  it("AJ-2JYR-02 a gateway tender without a payment intent (no payment refund row): the refund credits gateway_clearing, customer_deposit is untouched", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const tenders: Tender[] = [{ method: "qris", amountIdr: 110_000 }];
    const orderUlid = await sell(world, tenders, 10_000);
    const lines: RefundLines = [{ method: "qris", amountIdr: 44_000 }];
    const refundId = await seedPosRefund(world, orderUlid, lines);

    const refund = await post(
      world,
      orderRefunded(world, orderUlid, refundId, lines, 4_000),
    );
    expect(await linesOf(world, refund.journalEntryId)).toEqual([
      { role: "gateway_clearing", debit: 0, credit: 44_000 },
      { role: "sales_revenue", debit: 40_000, credit: 0 },
      { role: "tax_payable_pbjt", debit: 4_000, credit: 0 },
    ]);
    await expectBalanced(world, refund.journalEntryId);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    // sale Dr 110k, refund Cr 44k
    expect(await balanceOf(world, "gateway_clearing")).toBe(66_000);
  });

  it("AJ-2JYR-03 a refund line naming the tender of a posted-receipt intent (no payment refund row yet) credits customer_deposit, owed until a payout clears it", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const intentId = await intentWith(world, 100_000, "posted");
    const orderUlid = await sell(world, [
      { method: "qris", amountIdr: 100_000, intentId },
    ]);
    const lines: RefundLines = [{ method: "qris", amountIdr: 40_000 }];
    const refundId = await seedPosRefund(world, orderUlid, [
      {
        method: "qris",
        amountIdr: 40_000,
        tenderId: await tenderIdOf(world, orderUlid, intentId),
        paymentIntentId: intentId,
      },
    ]);

    const refund = await post(
      world,
      orderRefunded(world, orderUlid, refundId, lines, 0),
    );
    expect(await linesOf(world, refund.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 0, credit: 40_000 },
      { role: "sales_revenue", debit: 40_000, credit: 0 },
    ]);
    await expectBalanced(world, refund.journalEntryId);
    await expectDepositNotNegative(world);
    // receipt and sale net customer_deposit to 0; the refund owes 40k
    expect(await balanceOf(world, "customer_deposit")).toBe(-40_000);
  });

  it("AJ-2JYR-03b a legacy line refund (no payment refund filed) of a posted-receipt intent credits customer_deposit (owed until a payout clears it); a manual payment refund later clears it once: customer_deposit never debit-balance, gateway_clearing credited once", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const intentId = await intentWith(world, 100_000, "posted");
    const orderUlid = await sell(world, [
      { method: "qris", amountIdr: 100_000, intentId },
    ]);
    // Legacy line: names a method, no tender, no payment refund filed.
    const lines: RefundLines = [{ method: "qris", amountIdr: 40_000 }];
    const refundId = await seedPosRefund(world, orderUlid, lines);

    const refund = await post(
      world,
      orderRefunded(world, orderUlid, refundId, lines, 0),
    );
    expect(await linesOf(world, refund.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 0, credit: 40_000 },
      { role: "sales_revenue", debit: 40_000, credit: 0 },
    ]);
    await expectBalanced(world, refund.journalEntryId);

    // The admin files the 40k refund by hand later; its payout clears deposit.
    const manualId = await seedPaymentRefund(world, intentId, 40_000);
    await post(world, paymentRefunded(world, manualId, intentId, 40_000));
    await expectDepositNotNegative(world);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    // receipt Dr 100k, payout Cr 40k: credited once
    expect(await balanceOf(world, "gateway_clearing")).toBe(60_000);
  });

  it("AJ-2JYR-04 (27mt) an intent whose receipt never existed (paid before the wiring): the refund credits gateway_clearing; its payout still parks RECEIPT_MISSING; customer_deposit never goes negative", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const intentId = await intentWith(world, 100_000, "none");
    const orderUlid = await sell(world, [
      { method: "qris", amountIdr: 100_000, intentId },
    ]);
    const lines: RefundLines = [{ method: "qris", amountIdr: 40_000 }];
    const { refundId, paymentRefundIds } = await posRefund(
      world,
      orderUlid,
      lines,
      [{ intentId, amountIdr: 40_000 }],
    );

    const refund = await post(
      world,
      orderRefunded(world, orderUlid, refundId, lines, 0),
    );
    expect(await linesOf(world, refund.journalEntryId)).toEqual([
      { role: "gateway_clearing", debit: 0, credit: 40_000 },
      { role: "sales_revenue", debit: 40_000, credit: 0 },
    ]);
    await expectBalanced(world, refund.journalEntryId);
    await expectDepositNotNegative(world);

    // The payout guard stays: no receipt, no payout journal.
    expect(
      await deliver(
        tenant,
        paymentRefunded(world, paymentRefundIds[0]!, intentId, 40_000),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_MISSING",
      retryable: false,
    });
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    // sale Dr 100k, refund Cr 40k
    expect(await balanceOf(world, "gateway_clearing")).toBe(60_000);
    // sale + refund only
    expect(await journalCount(world)).toBe(2);
  });

  it("AJ-2JYR-05 an intent whose receipt is still in the outbox: the refund parks AUTO_JOURNAL_RECEIPT_PENDING (retryable, no journal); after the receipt posted the sweep posts it once, crediting customer_deposit", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    // The sale posted at cutover (no receipt then); the receipt event shows up later.
    const intentId = await seedIntent(world, 100_000);
    const orderUlid = await sell(world, [
      { method: "qris", amountIdr: 100_000, intentId },
    ]);
    const outboxId = await seedUndeliveredReceipt(world, intentId, 100_000);
    const lines: RefundLines = [{ method: "qris", amountIdr: 40_000 }];
    const { refundId } = await posRefund(world, orderUlid, lines, [
      { intentId, amountIdr: 40_000 },
    ]);
    const refundKey = `aj:order-refund:${refundId}`;

    expect(
      await deliver(
        tenant,
        orderRefunded(world, orderUlid, refundId, lines, 0),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_PENDING",
      retryable: true,
    });
    // only the sale
    expect(await journalCount(world)).toBe(1);
    expect(await parkedOf(tenant, refundKey)).toMatchObject([
      { error_code: "AUTO_JOURNAL_RECEIPT_PENDING", retryable: true },
    ]);

    await markDelivered(world, outboxId);
    await post(world, paymentPaid(world, intentId, 100_000));
    expect(await sweep(tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    const refundEntry = await journalIdOf(world, refundKey);
    expect(await linesOf(world, refundEntry)).toEqual([
      { role: "customer_deposit", debit: 0, credit: 40_000 },
      { role: "sales_revenue", debit: 40_000, credit: 0 },
    ]);
    await expectBalanced(world, refundEntry);
    expect(await parkedOf(tenant, refundKey)).toHaveLength(0);
    // a second sweep posts nothing more
    expect(await sweep(tenant)).toEqual({
      posted: 0,
      stillParked: 0,
      failed: 0,
    });
    expect(await journalsWithKey(world, refundKey)).toBe(1);
  });

  it("AJ-2JYR-06 mixed: cash + a posted-receipt intent + a pre-wiring intent + an intentless tender; deposit gets only the posted-receipt part, clearing the rest; the journal balances", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const intentA = await intentWith(world, 90_000, "posted");
    const intentB = await intentWith(world, 60_000, "none");
    const orderUlid = await sell(world, [
      { method: "cash", amountIdr: 40_000 },
      { method: "qris", amountIdr: 90_000, intentId: intentA },
      { method: "qris", amountIdr: 60_000, intentId: intentB },
      { method: "qris", amountIdr: 10_000 },
    ]);
    // refund: cash 15k + gateway 60k (A 30k, B 20k, intentless 10k)
    const lines: RefundLines = [
      { method: "cash", amountIdr: 15_000 },
      { method: "qris", amountIdr: 60_000 },
    ];
    const refundId = await seedPosRefund(world, orderUlid, [
      { method: "cash", amountIdr: 15_000 },
      {
        method: "qris",
        amountIdr: 30_000,
        tenderId: await tenderIdOf(world, orderUlid, intentA),
        paymentIntentId: intentA,
      },
      {
        method: "qris",
        amountIdr: 20_000,
        tenderId: await tenderIdOf(world, orderUlid, intentB),
        paymentIntentId: intentB,
      },
      {
        method: "qris",
        amountIdr: 10_000,
        tenderId: await tenderIdOf(world, orderUlid, null),
        paymentIntentId: null,
      },
    ]);

    const refund = await post(
      world,
      orderRefunded(world, orderUlid, refundId, lines, 0),
    );
    expect(await linesOf(world, refund.journalEntryId)).toEqual([
      { role: "cash_on_hand", debit: 0, credit: 15_000 },
      { role: "customer_deposit", debit: 0, credit: 30_000 },
      { role: "gateway_clearing", debit: 0, credit: 30_000 },
      { role: "sales_revenue", debit: 75_000, credit: 0 },
    ]);
    await expectBalanced(world, refund.journalEntryId);
    await expectDepositNotNegative(world);
  });

  it("AJ-2JYR-07a cap: refund lines recorded for more than the event's gateway part never credit deposit above what the event refunded", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const intentId = await intentWith(world, 100_000, "posted");
    const orderUlid = await sell(world, [
      { method: "qris", amountIdr: 100_000, intentId },
    ]);

    // the row holds 60k for the tender, the event refunded only 40k
    const lines: RefundLines = [{ method: "qris", amountIdr: 40_000 }];
    const refundId = await seedPosRefund(world, orderUlid, [
      {
        method: "qris",
        amountIdr: 60_000,
        tenderId: await tenderIdOf(world, orderUlid, intentId),
        paymentIntentId: intentId,
      },
    ]);
    const entry = await post(
      world,
      orderRefunded(world, orderUlid, refundId, lines, 0),
    );
    expect(await linesOf(world, entry.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 0, credit: 40_000 },
      { role: "sales_revenue", debit: 40_000, credit: 0 },
    ]);
    await expectBalanced(world, entry.journalEntryId);
  });

  it("AJ-2JYR-07b cap: payment refunds linked for more than the gateway part never credit deposit above what was refunded", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const intentA = await intentWith(world, 60_000, "posted");
    const intentB = await intentWith(world, 40_000, "posted");
    const orderUlid = await sell(world, [
      { method: "qris", amountIdr: 60_000, intentId: intentA },
      { method: "qris", amountIdr: 40_000, intentId: intentB },
    ]);

    // linked rows total 70k (50k + 20k), the refund returned only 10k
    const small: RefundLines = [{ method: "qris", amountIdr: 10_000 }];
    const over = await posRefund(world, orderUlid, small, [
      { intentId: intentA, amountIdr: 50_000 },
      { intentId: intentB, amountIdr: 20_000 },
    ]);
    const overEntry = await post(
      world,
      orderRefunded(world, orderUlid, over.refundId, small, 0),
    );
    const overLines = await linesOf(world, overEntry.journalEntryId);
    const credited = (role: Role) =>
      overLines.find((line) => line.role === role)?.credit ?? 0;
    expect(credited("customer_deposit")).toBeLessThanOrEqual(10_000);
    expect(credited("customer_deposit") + credited("gateway_clearing")).toBe(
      10_000,
    );
    await expectBalanced(world, overEntry.journalEntryId);
    await expectDepositNotNegative(world);
  });

  it("AJ-2JYR-08 a recovery refund (payment refund linked by order_issue_id = refund id) of an intent with a posted receipt credits customer_deposit", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const intentId = await intentWith(world, 100_000, "posted");
    const orderUlid = await sell(world, [
      { method: "qris", amountIdr: 100_000, intentId },
    ]);
    const issueId = await seedIssue(world, orderUlid);
    await seedPaymentRefund(world, intentId, 40_000, issueId);

    const refund = await post(
      world,
      orderRefunded(
        world,
        orderUlid,
        issueId,
        [{ method: "qris", amountIdr: 40_000 }],
        0,
      ),
    );
    expect(await linesOf(world, refund.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 0, credit: 40_000 },
      { role: "sales_revenue", debit: 40_000, credit: 0 },
    ]);
    await expectBalanced(world, refund.journalEntryId);
  });

  it("AJ-2JYR-09 (27mt) a recovery refund of an intent whose receipt never existed credits gateway_clearing; customer_deposit never goes negative", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const intentId = await intentWith(world, 100_000, "none");
    const orderUlid = await sell(world, [
      { method: "qris", amountIdr: 100_000, intentId },
    ]);
    const issueId = await seedIssue(world, orderUlid);
    const paymentRefundId = await seedPaymentRefund(
      world,
      intentId,
      40_000,
      issueId,
    );

    const refund = await post(
      world,
      orderRefunded(
        world,
        orderUlid,
        issueId,
        [{ method: "qris", amountIdr: 40_000 }],
        0,
      ),
    );
    expect(await linesOf(world, refund.journalEntryId)).toEqual([
      { role: "gateway_clearing", debit: 0, credit: 40_000 },
      { role: "sales_revenue", debit: 40_000, credit: 0 },
    ]);
    await expectBalanced(world, refund.journalEntryId);

    expect(
      await deliver(
        tenant,
        paymentRefunded(world, paymentRefundId, intentId, 40_000),
      ),
    ).toMatchObject({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_MISSING",
    });
    await expectDepositNotNegative(world);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
  });

  it("AJ-2JYR-10 idempotent: a replay is already_posted, two concurrent deliveries and a sweep after a park post exactly one refund journal", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const intentId = await intentWith(world, 100_000, "posted");
    const orderUlid = await sell(world, [
      { method: "qris", amountIdr: 100_000, intentId },
    ]);
    const lines: RefundLines = [{ method: "qris", amountIdr: 40_000 }];
    const { refundId } = await posRefund(world, orderUlid, lines, [
      { intentId, amountIdr: 25_000 },
    ]);
    const refundKey = `aj:order-refund:${refundId}`;
    const event = orderRefunded(world, orderUlid, refundId, lines, 0);

    const settled = await Promise.allSettled([
      deliver(tenant, event),
      deliver(tenant, event),
    ]);
    const posted = settled.filter(
      (result) =>
        result.status === "fulfilled" && result.value.status === "posted",
    );
    expect(posted).toHaveLength(1);
    expect(await journalsWithKey(world, refundKey)).toBe(1);

    const entryId = await journalIdOf(world, refundKey);
    expect(await deliver(tenant, event)).toEqual({
      status: "already_posted",
      journalEntryId: entryId,
    });
    expect(await sweep(tenant)).toEqual({
      posted: 0,
      stillParked: 0,
      failed: 0,
    });
    expect(await journalsWithKey(world, refundKey)).toBe(1);
    expect(await balanceOf(world, "customer_deposit")).toBe(-40_000);
    expect(await balanceOf(world, "gateway_clearing")).toBe(100_000);
    // receipt + sale + refund
    expect(await journalCount(world)).toBe(3);
  });

  it("AJ-2JYR-11 end to end: a refund over a posted-receipt intent and a pre-wiring intent, then the payouts: the posted one clears deposit, the other parks; customer_deposit is never negative at any step", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const intentA = await intentWith(world, 60_000, "none");
    const intentB = await intentWith(world, 40_000, "posted");
    const orderUlid = await sell(world, [
      { method: "qris", amountIdr: 60_000, intentId: intentA },
      { method: "qris", amountIdr: 40_000, intentId: intentB },
    ]);
    await expectDepositNotNegative(world);
    // gateway part 70k: A 40k (no receipt), B 30k (posted receipt). The POS
    // refund writes per-tender lines (a legacy method line over two intents
    // frees no payout, pos-intent-attribution), so B's payout can post.
    const tenderOf = async (intentId: string) => {
      const { rows } = await owner.query<{ id: string }>(
        "SELECT id FROM pos_order_tenders WHERE order_id = $1 AND payment_intent_id = $2",
        [ulidToUuid(orderUlid), intentId],
      );
      return rows[0]!.id;
    };
    const tenderLines = [
      {
        method: "qris" as const,
        amountIdr: 40_000,
        tenderId: await tenderOf(intentA),
        paymentIntentId: intentA,
      },
      {
        method: "qris" as const,
        amountIdr: 30_000,
        tenderId: await tenderOf(intentB),
        paymentIntentId: intentB,
      },
    ];
    const lines: RefundLines = tenderLines.map(({ method, amountIdr }) => ({
      method,
      amountIdr,
    }));
    const refundId = await seedPosRefund(world, orderUlid, tenderLines);
    const paymentRefundIds: string[] = [];
    for (const link of [
      { intentId: intentA, amountIdr: 40_000 },
      { intentId: intentB, amountIdr: 30_000 },
    ]) {
      const paymentRefundId = await seedPaymentRefund(
        world,
        link.intentId,
        link.amountIdr,
      );
      await linkPosGatewayRefund(
        world,
        refundId,
        link.intentId,
        paymentRefundId,
      );
      paymentRefundIds.push(paymentRefundId);
    }

    const refund = await post(
      world,
      orderRefunded(world, orderUlid, refundId, lines, 0),
    );
    expect(await linesOf(world, refund.journalEntryId)).toEqual([
      { role: "customer_deposit", debit: 0, credit: 30_000 },
      { role: "gateway_clearing", debit: 0, credit: 40_000 },
      { role: "sales_revenue", debit: 70_000, credit: 0 },
    ]);
    await expectBalanced(world, refund.journalEntryId);
    await expectDepositNotNegative(world);

    // payout A: no receipt, parks; payout B: posts
    expect(
      await deliver(
        tenant,
        paymentRefunded(world, paymentRefundIds[0]!, intentA, 40_000),
      ),
    ).toMatchObject({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_MISSING",
    });
    await expectDepositNotNegative(world);
    await post(
      world,
      paymentRefunded(world, paymentRefundIds[1]!, intentB, 30_000),
    );
    await expectDepositNotNegative(world);
    expect(await balanceOf(world, "customer_deposit")).toBe(0);
    // receipt B +40k, sale A +60k, refund -40k, payout B -30k
    expect(await balanceOf(world, "gateway_clearing")).toBe(30_000);
  });
});
