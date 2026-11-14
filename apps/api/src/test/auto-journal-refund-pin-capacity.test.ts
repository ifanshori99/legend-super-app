// legend-zwaro (UANG): a refund journal must never credit customer_deposit
// beyond the capacity of the intent pinned on the order (orders.payment_intent_id).
//
// Contract (brief legend-zwaro): earlier refund obligations on the pinned intent
// reduce its capacity for every later refund, including
// - Scenario A: an order_issues recovery refund (no pos_order_refunds row, no
//   payment_refunds row) after an earlier POS refund (journaled; its payment
//   refund failed, or a legacy line without intent and no payment refund);
// - Scenario B: payload-only refunds (no row, no payment refund, no issue).
// Over capacity parks the refund AUTO_JOURNAL_REFUND_SOURCE_PENDING (retryable,
// no journal). Every journal stays balanced. A refund that fits still posts.
//
// Assumptions:
// - Pin = 40k intent on a 55k cash-paid POS order; the receipt is posted.
// - "Credited" = sum of customer_deposit credit over the refund journals.
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
  type AutoJournalResult,
} from "../services/accounting-auto-journal-consumer.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const short = () => randomUUID().slice(0, 6);
const NOW = new Date("2026-11-08T03:00:00Z");
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

const SOURCE_PENDING = "AUTO_JOURNAL_REFUND_SOURCE_PENDING";
const SALE = { grossSalesIdr: 50_000, pbjtIdr: 5_000 };

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

// ---- scenarios ---------------------------------------------------------------

const PIN_IDR = 40_000;

/** 55k POS order paid in cash, pinned to a paid 40k intent. */
async function sellPinned(world: World) {
  const { linkId, intentId } = await seedLinkedIntent(world, PIN_IDR);
  await post(world, paymentPaid(world, intentId, PIN_IDR));
  const orderUlid = createUlid();
  const sale = {
    ...SALE,
    tenders: [{ method: "cash" as const, amountIdr: 55_000 }],
  };
  await seedPosOrder(world, orderUlid, sale, { linkId, intentId });
  await post(world, orderPaid(world, orderUlid, sale));
  return { orderUlid, intentId };
}

function qrRefund(
  world: World,
  orderUlid: string,
  refundId: string,
  amountIdr: number,
) {
  return orderRefunded(world, orderUlid, refundId, {
    grossSalesIdr: amountIdr,
    pbjtIdr: 0,
    lines: [{ method: "qris", amountIdr }],
  });
}

/**
 * Deliver the second refund. Asserts the total credited to customer_deposit
 * (first + second if posted) stays within the pin first, then the outcome.
 */
async function expectSecondWithinPin(
  world: World,
  firstEntryId: string,
  event: EventEnvelope,
  secondId: string,
): Promise<void> {
  const firstLines = await linesOf(world, firstEntryId);
  expectBalancedLines(firstLines);
  const result = await deliver(world.tenant, event);
  let credited = creditOf(firstLines, "customer_deposit");
  if (result.status === "posted") {
    const secondLines = await linesOf(world, result.journalEntryId);
    expectBalancedLines(secondLines);
    credited += creditOf(secondLines, "customer_deposit");
  }
  expect(credited).toBeLessThanOrEqual(PIN_IDR);
  expect(result).toEqual({
    status: "parked",
    code: SOURCE_PENDING,
    retryable: true,
  });
  expect(
    await parkedOf(world.tenant, `aj:order-refund:${secondId}`),
  ).toMatchObject([
    {
      error_code: SOURCE_PENDING,
      retryable: true,
      event_name: "order.refunded",
    },
  ]);
}

describe("legend-zwaro refund pin capacity counts earlier refunds of any kind", () => {
  for (const variant of [
    "payment refund of the earlier line failed (intent on the line)",
    "legacy earlier line without intent and no payment refund",
  ]) {
    const withIntent = variant.startsWith("payment");
    it(`ZWARO-A recovery refund (real order_issues row) of 20k after an earlier 30k POS refund (${variant}) parks on the 40k pin: customer_deposit credited <= 40k`, async () => {
      const world = await makeWorld();
      const { orderUlid, intentId } = await sellPinned(world);
      const firstId = await seedPosRefund(world, orderUlid, [
        {
          method: "qris",
          amountIdr: 30_000,
          ...(withIntent
            ? { paymentIntentId: intentId, tenderId: randomUUID() }
            : {}),
        },
      ]);
      if (withIntent)
        await seedLinkedPaymentRefund(
          world,
          firstId,
          intentId,
          30_000,
          "failed",
        );
      const first = await post(
        world,
        qrRefund(world, orderUlid, firstId, 30_000),
      );

      const issueId = await seedIssue(world, orderUlid);
      await expectSecondWithinPin(
        world,
        first.journalEntryId,
        qrRefund(world, orderUlid, issueId, 20_000),
        issueId,
      );
    });
  }

  it("ZWARO-B payload-only refund of 20k after a posted payload-only 30k parks on the 40k pin: customer_deposit credited <= 40k", async () => {
    const world = await makeWorld();
    const { orderUlid } = await sellPinned(world);
    const first = await post(
      world,
      qrRefund(world, orderUlid, randomUUID(), 30_000),
    );
    const secondId = randomUUID();
    await expectSecondWithinPin(
      world,
      first.journalEntryId,
      qrRefund(world, orderUlid, secondId, 20_000),
      secondId,
    );
  });

  // ZWARO-D: a recovery refund whose payment refund was filed short (5k of its
  // 20k) still counts in full (5k filed + 15k unfiled) against the pin.
  // Assumption: payment_refunds.order_issue_id = the recovery issue id links it.
  async function recoveryFiledShort(world: World) {
    const { orderUlid, intentId } = await sellPinned(world);
    const issueId = await seedIssue(world, orderUlid);
    const paymentRefundId = randomUUID();
    await owner.query(
      `INSERT INTO payment_refunds
         (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
          requested_by, approved_by, decided_at, completed_at, order_issue_id)
       VALUES ($1, $2, $3, $4, 5000, 'Pengembalian dana', 'completed', 'requester',
               'approver', $5, $5, $6)`,
      [
        paymentRefundId,
        world.tenant.id,
        world.outletId,
        intentId,
        DAY,
        issueId,
      ],
    );
    const recovery = await post(
      world,
      qrRefund(world, orderUlid, issueId, 20_000),
    );
    const recoveryLines = await linesOf(world, recovery.journalEntryId);
    expectBalancedLines(recoveryLines);
    expect(creditOf(recoveryLines, "customer_deposit")).toBe(20_000);
    return { orderUlid };
  }

  it("ZWARO-D recovery refund of 20k filed at only 5k, then payload-only 35k parks (5+15+35 > 40k pin)", async () => {
    const world = await makeWorld();
    const { orderUlid } = await recoveryFiledShort(world);
    const secondId = randomUUID();
    const event = qrRefund(world, orderUlid, secondId, 35_000);
    await expectParkedNoJournal(world, event, secondId);
  });

  it("ZWARO-D variant: the same recovery, then payload-only 20k posts (5+15+20 = 40k pin), balanced", async () => {
    const world = await makeWorld();
    const { orderUlid } = await recoveryFiledShort(world);
    const second = await post(
      world,
      qrRefund(world, orderUlid, randomUUID(), 20_000),
    );
    const lines = await linesOf(world, second.journalEntryId);
    expectBalancedLines(lines);
    expect(creditOf(lines, "customer_deposit")).toBe(20_000);
  });

  // ZWARO-E: refund1 (earlier, journal pending) must not be parked because the
  // later refund2 (journaled first, payment refund filed) is counted twice:
  // real total 15k + 15k = 30k <= 40k pin.
  it("ZWARO-E earlier POS refund 15k still posts after a later POS refund 15k (payment refund filed on the pin) was journaled first", async () => {
    const world = await makeWorld();
    const { orderUlid, intentId } = await sellPinned(world);
    const line = (tenderId: string) => ({
      method: "qris" as const,
      amountIdr: 15_000,
      paymentIntentId: intentId,
      tenderId,
    });
    const refund1 = await seedPosRefund(world, orderUlid, [line(randomUUID())]);
    const refund2 = await seedPosRefund(world, orderUlid, [line(randomUUID())]);
    await seedLinkedPaymentRefund(world, refund2, intentId, 15_000);

    const second = await post(
      world,
      qrRefund(world, orderUlid, refund2, 15_000),
    );
    const secondLines = await linesOf(world, second.journalEntryId);
    expectBalancedLines(secondLines);

    const first = await post(
      world,
      qrRefund(world, orderUlid, refund1, 15_000),
    );
    const firstLines = await linesOf(world, first.journalEntryId);
    expectBalancedLines(firstLines);
    expect(
      creditOf(firstLines, "customer_deposit") +
        creditOf(secondLines, "customer_deposit"),
    ).toBeLessThanOrEqual(PIN_IDR);
  });

  it("ZWARO-C control: payload-only 30k then 10k (= 40k pin) both post, balanced, customer_deposit credited 40k", async () => {
    const world = await makeWorld();
    const { orderUlid } = await sellPinned(world);
    const first = await post(
      world,
      qrRefund(world, orderUlid, randomUUID(), 30_000),
    );
    const second = await post(
      world,
      qrRefund(world, orderUlid, randomUUID(), 10_000),
    );
    const firstLines = await linesOf(world, first.journalEntryId);
    const secondLines = await linesOf(world, second.journalEntryId);
    expectBalancedLines(firstLines);
    expectBalancedLines(secondLines);
    expect(
      creditOf(firstLines, "customer_deposit") +
        creditOf(secondLines, "customer_deposit"),
    ).toBe(PIN_IDR);
  });
});
