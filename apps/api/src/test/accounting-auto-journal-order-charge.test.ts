// Revenue journal of a paid swap-difference charge (legend-i83ls, slice S3,
// design scratchpad design-B.md).
//
// A dearer swap leaves the guest a charge (order_issue_charges) paid through its
// own payment link. The money arrives as `payment.paid` (`aj:receipt:<intent>`,
// Dr gateway_clearing / Cr customer_deposit); the revenue is recognised by
// `order_issue.charge_paid` under `aj:order-charge:<chargeId>` with the rules of
// `order.paid`: Dr customer_deposit (receipt posted) or gateway_clearing (no
// receipt will ever post), Cr sales_revenue / service_charge / tax_payable_pbjt.
// It waits for the receipt of its intent and for the sale journal of its order.
//
// Money: order 100k + 10k PBJT (due 110k, one code). Charge: difference 20k,
// service 2k, PBJT 2.2k, amount 24.2k, its own link and intent.
//
// Guards: once the charge is paid its intent holds the charge amount, so a
// payout of it after (or a refund request) is refused: the revenue already
// took the money out of customer_deposit.

import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
import { qrOrderEvents } from "@starter/shared/qr-order";
import { db } from "../db/index.ts";
import { paymentIntents } from "../db/schema/payment.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  deliverAutoJournalEvent,
  retryParkedAutoJournals,
  type AutoJournalResult,
} from "../services/accounting-auto-journal-consumer.ts";
import { refundableBalance } from "../services/payment-admin.service.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const short = () => randomUUID().slice(0, 6);
const NOW = new Date("2026-11-08T03:00:00Z");
const SWEEP_AT = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
/** 2026-10-15 12:00 in Jakarta; the order fires here. */
const DAY = "2026-10-15T05:00:00.000Z";
/** The swap charge is paid later the same day. */
const CHARGE_DAY = "2026-10-15T07:00:00.000Z";
/** Completion instant of payouts: after the charge was paid. */
const REFUND_DAY = "2026-10-16T05:00:00.000Z";

const FLAGS_ON = JSON.stringify({
  modules: ["accounting"],
  integrationProviders: [],
});

const CHARGE = {
  differenceIdr: 20_000,
  grossSalesIdr: 20_000,
  serviceChargeIdr: 2_000,
  pbjtIdr: 2_200,
  amountIdr: 24_200,
} as const;

type Role =
  | "cash_on_hand"
  | "gateway_clearing"
  | "tax_payable_pbjt"
  | "customer_deposit"
  | "sales_revenue"
  | "service_charge";

const CHART: [Role, string, string, string, string][] = [
  ["cash_on_hand", "1101", "Kas Outlet", "asset", "current_asset"],
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
  ["service_charge", "4103", "Service Charge", "revenue", "revenue"],
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
     VALUES ($1, $2, 'Uji Tagihan Selisih', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-oc-${id.slice(0, 8)}`,
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

async function makeWorld(tenant: Tenant): Promise<World> {
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenant.id, `Entity OC ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet OC', 'Jl. OC', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      outletId,
      tenant.id,
      tenant.brandId,
      entity,
      `OC-${short()}`.toUpperCase(),
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
      `OC-${linkId.slice(0, 8)}`,
      totalIdr,
    ],
  );
  return linkId;
}

/** A paid gateway intent on the link, with its evidence (money in). */
async function seedIntentOnLink(
  world: World,
  linkId: string,
  amountIdr: number,
  paidAt: string,
): Promise<string> {
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
      `oc-${intentId}`,
      paidAt,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, $6)`,
    [
      world.tenant.id,
      world.outletId,
      intentId,
      `oc-ref-${intentId}`,
      amountIdr,
      paidAt,
    ],
  );
  return intentId;
}

/** A fired QR pay-first order of 100k + 10k PBJT (due 110k), pinned to its payer. */
async function seedOrder(
  world: World,
  linkId: string,
  payerIntentId: string,
  orderUlid: string,
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
        DAY,
        linkId,
        payerIntentId,
      ],
    ),
  );
}

/** The issue each seeded charge belongs to (the event names it too). */
const issueOfCharge = new Map<string, string>();

/**
 * The charge row, `paid` by `intentId` at CHARGE_DAY (or `open`). The issue
 * foreign key is skipped: the consumer reads the charge, never the issue.
 */
async function seedCharge(
  world: World,
  input: {
    orderUlid: string;
    linkId: string;
    intentId: string | null;
    status?: "paid" | "open";
    amountIdr?: number;
    /** legend-800h1: paid in cash at the POS by this cash_in movement. */
    cashMovementId?: string;
  },
): Promise<string> {
  const chargeId = randomUUID();
  const issueId = randomUUID();
  issueOfCharge.set(chargeId, issueId);
  const status = input.status ?? "paid";
  // Only the cash variant writes the legend-800h1 columns.
  const cash = input.cashMovementId !== undefined;
  await asTenant(
    world.tenant,
    (client) =>
      client.query(
        `INSERT INTO order_issue_charges
           (id, tenant_id, outlet_id, order_issue_id, order_id, route, status, difference_idr,
            gross_sales_idr, service_charge_idr, pbjt_idr, amount_idr, payment_link_id,
            payment_link_token_sealed, payment_intent_id, paid_at${cash ? ", cash_movement_id, paid_by" : ""})
         VALUES ($1, $2, $3, $4, $5, 'qr_link', $6, $7, $8, $9, $10, $11, $12, 'sealed', $13, $14${cash ? ", $15, 'seed-cashier'" : ""})`,
        [
          chargeId,
          world.tenant.id,
          world.outletId,
          issueId,
          ulidToUuid(input.orderUlid),
          status,
          CHARGE.differenceIdr,
          CHARGE.grossSalesIdr,
          CHARGE.serviceChargeIdr,
          CHARGE.pbjtIdr,
          input.amountIdr ?? CHARGE.amountIdr,
          input.linkId,
          status === "paid" ? input.intentId : null,
          status === "paid" ? CHARGE_DAY : null,
          ...(cash ? [input.cashMovementId] : []),
        ],
      ),
    { replica: true },
  );
  return chargeId;
}

/**
 * A cash_in movement of the outlet (legend-800h1). The shift foreign key is
 * skipped: the consumer reads the movement, never the shift.
 */
async function seedCashMovement(
  world: World,
  input: { type?: string; amountIdr?: number; outletId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await asTenant(
    world.tenant,
    (client) =>
      client.query(
        `INSERT INTO cash_movements
           (id, tenant_id, outlet_id, shift_id, type, amount_idr, reason_note, recorded_by,
            recorded_at, idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, 'Selisih swap pesanan', 'seed-cashier', $7, $8, $9)`,
        [
          id,
          world.tenant.id,
          input.outletId ?? world.outletId,
          randomUUID(),
          input.type ?? "cash_in",
          input.amountIdr ?? CHARGE.amountIdr,
          CHARGE_DAY,
          `oc-cash-${id}`,
          randomBytes(32).toString("hex"),
        ],
      ),
    { replica: true },
  );
  return id;
}

/** A completed gateway payout of an intent at REFUND_DAY. */
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
    idempotencyKey: `oc-test-${id}`,
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload,
  });
}

function paymentPaid(
  world: World,
  intentId: string,
  receivedIdr: number,
  paidAt: string,
) {
  return envelope(world, {
    name: "payment.paid",
    aggregateId: intentId,
    occurredAt: paidAt,
    payload: {
      intentId,
      method: "qris",
      provider: "doit",
      receivedIdr,
      paidAt,
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

function orderPaid(world: World, orderUlid: string): EventEnvelope {
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

/** `order_issue.charge_paid` built through the shared contract (strict payload). */
function chargePaid(
  world: World,
  input: {
    orderUlid: string;
    chargeId: string;
    intentId: string | null;
    overrides?: Record<string, unknown>;
  },
): EventEnvelope {
  const definition = qrOrderEvents["order_issue.charge_paid"];
  const issueId = issueOfCharge.get(input.chargeId) ?? randomUUID();
  const id = createUlid();
  return definition.envelopeSchema.parse({
    id,
    tenantId: world.tenant.id,
    outletId: world.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: issueId,
    sequence: 1,
    occurredAt: CHARGE_DAY,
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `oc-charge-${id}`,
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: {
      orderId: input.orderUlid,
      orderIssueId: issueId,
      chargeId: input.chargeId,
      paymentIntentId: input.intentId,
      ...CHARGE,
      paidAt: CHARGE_DAY,
      ...input.overrides,
    },
  }) as EventEnvelope;
}

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

async function journalCount(world: World, key: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2",
    [world.tenant.id, key],
  );
  return Number(rows[0]!.n);
}

async function parkedOf(tenant: Tenant, key: string) {
  const { rows } = await owner.query<{
    error_code: string;
    retryable: boolean;
  }>(
    "SELECT error_code, retryable FROM auto_journal_parked WHERE tenant_id = $1 AND idempotency_key = $2",
    [tenant.id, key],
  );
  return rows;
}

let sweepCount = 0;
function sweep(tenant: Tenant) {
  sweepCount += 1;
  return retryParkedAutoJournals(
    contextOf(tenant),
    new Date(SWEEP_AT.getTime() + sweepCount * 60 * 60 * 1000),
  );
}

/** The order with its sale journal posted, and the charge paid on its own link. */
async function paidChargeWorld(options: { saleOutbox?: boolean } = {}) {
  const tenant = await makeTenant();
  const world = await makeWorld(tenant);
  const orderLink = await seedLink(world, 110_000);
  const orderIntent = await seedIntentOnLink(world, orderLink, 110_000, DAY);
  const orderUlid = createUlid();
  await seedOrder(world, orderLink, orderIntent, orderUlid);
  await post(world, paymentPaid(world, orderIntent, 110_000, DAY));
  const saleEvent = orderPaid(world, orderUlid);
  let saleOutboxId: string | null = null;
  if (options.saleOutbox)
    saleOutboxId = await seedOutboxEvent(
      world,
      saleEvent,
      ulidToUuid(orderUlid),
    );
  else await post(world, saleEvent);
  const chargeLink = await seedLink(world, CHARGE.amountIdr);
  const chargeIntent = await seedIntentOnLink(
    world,
    chargeLink,
    CHARGE.amountIdr,
    CHARGE_DAY,
  );
  const chargeId = await seedCharge(world, {
    orderUlid,
    linkId: chargeLink,
    intentId: chargeIntent,
  });
  return {
    tenant,
    world,
    orderUlid,
    saleEvent,
    saleOutboxId,
    chargeLink,
    chargeIntent,
    chargeId,
    event: chargePaid(world, { orderUlid, chargeId, intentId: chargeIntent }),
  };
}

const CHARGE_LINES_DEPOSIT: Line[] = [
  { role: "customer_deposit", debit: 24_200, credit: 0 },
  { role: "sales_revenue", debit: 0, credit: 20_000 },
  { role: "service_charge", debit: 0, credit: 2_000 },
  { role: "tax_payable_pbjt", debit: 0, credit: 2_200 },
];

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

describe("legend-i83ls order_issue.charge_paid revenue journal", () => {
  it("CHG-1 receipt posted: Dr customer_deposit, Cr revenue/service/PBJT under aj:order-charge; customer_deposit nets to 0; replay posts nothing", async () => {
    const c = await paidChargeWorld();
    await post(
      c.world,
      paymentPaid(c.world, c.chargeIntent, 24_200, CHARGE_DAY),
    );

    const result = await post(c.world, c.event);
    expect(await linesOf(c.world, result.journalEntryId)).toEqual(
      CHARGE_LINES_DEPOSIT,
    );
    expect(await journalCount(c.world, `aj:order-charge:${c.chargeId}`)).toBe(
      1,
    );
    expect(await balanceOf(c.world, "customer_deposit")).toBe(0);
    expect(await balanceOf(c.world, "gateway_clearing")).toBe(134_200);

    expect(await deliver(c.tenant, c.event)).toEqual({
      status: "already_posted",
      journalEntryId: result.journalEntryId,
    });
    expect(await journalCount(c.world, `aj:order-charge:${c.chargeId}`)).toBe(
      1,
    );
  });

  it("CHG-2 receipt still in the outbox: parks RECEIPT_PENDING (retryable); after the receipt and the sweep it posts", async () => {
    const c = await paidChargeWorld();
    const receipt = paymentPaid(c.world, c.chargeIntent, 24_200, CHARGE_DAY);
    const outboxId = await seedOutboxEvent(c.world, receipt, c.chargeIntent);

    expect(await deliver(c.tenant, c.event)).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_RECEIPT_PENDING",
      retryable: true,
    });
    expect(await journalCount(c.world, `aj:order-charge:${c.chargeId}`)).toBe(
      0,
    );

    await markDelivered(c.world, outboxId);
    await post(c.world, receipt);
    expect(await sweep(c.tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2",
      [c.world.tenant.id, `aj:order-charge:${c.chargeId}`],
    );
    expect(await linesOf(c.world, rows[0]!.id)).toEqual(CHARGE_LINES_DEPOSIT);
    expect(
      await parkedOf(c.tenant, `aj:order-charge:${c.chargeId}`),
    ).toHaveLength(0);
  });

  it("CHG-3 receipt will never post (pre-cutover): the money books as gateway_clearing once", async () => {
    const c = await paidChargeWorld();

    const result = await post(c.world, c.event);
    expect(await linesOf(c.world, result.journalEntryId)).toEqual([
      { role: "gateway_clearing", debit: 24_200, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 20_000 },
      { role: "service_charge", debit: 0, credit: 2_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 2_200 },
    ]);
  });

  it("CHG-4 sale journal of the order still in the outbox: parks SALE_PENDING (retryable); after the sale and the sweep it posts", async () => {
    const c = await paidChargeWorld({ saleOutbox: true });
    await post(
      c.world,
      paymentPaid(c.world, c.chargeIntent, 24_200, CHARGE_DAY),
    );

    expect(await deliver(c.tenant, c.event)).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_SALE_PENDING",
      retryable: true,
    });
    await markDelivered(c.world, c.saleOutboxId!);
    await post(c.world, c.saleEvent);
    expect(await sweep(c.tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    expect(await journalCount(c.world, `aj:order-charge:${c.chargeId}`)).toBe(
      1,
    );
  });

  it("CHG-5 sale journal will never post: parks SALE_MISSING (not retryable); once the sale posts it is requeued and posts", async () => {
    const c = await paidChargeWorld({ saleOutbox: true });
    await post(
      c.world,
      paymentPaid(c.world, c.chargeIntent, 24_200, CHARGE_DAY),
    );
    await markDelivered(c.world, c.saleOutboxId!);

    expect(await deliver(c.tenant, c.event)).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_SALE_MISSING",
      retryable: false,
    });
    await post(c.world, c.saleEvent);
    expect(await sweep(c.tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    expect(await journalCount(c.world, `aj:order-charge:${c.chargeId}`)).toBe(
      1,
    );
  });

  it("CHG-6 payload that differs from the charge row: parks POSTING_AMOUNTS_MISMATCH (not retryable), nothing journaled", async () => {
    const c = await paidChargeWorld();
    await post(
      c.world,
      paymentPaid(c.world, c.chargeIntent, 24_200, CHARGE_DAY),
    );
    const event = chargePaid(c.world, {
      orderUlid: c.orderUlid,
      chargeId: c.chargeId,
      intentId: c.chargeIntent,
      overrides: {
        grossSalesIdr: 21_000,
        amountIdr: 25_200,
      },
    });

    expect(await deliver(c.tenant, event)).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    expect(await journalCount(c.world, `aj:order-charge:${c.chargeId}`)).toBe(
      0,
    );
  });

  it("CHG-7 charge not paid (open) or paid by another intent: parks PAYLOAD_INVALID (not retryable)", async () => {
    const c = await paidChargeWorld();
    await post(
      c.world,
      paymentPaid(c.world, c.chargeIntent, 24_200, CHARGE_DAY),
    );
    const otherLink = await seedLink(c.world, CHARGE.amountIdr);
    const otherIntent = await seedIntentOnLink(
      c.world,
      otherLink,
      CHARGE.amountIdr,
      CHARGE_DAY,
    );
    // The event names an intent that is not the one the charge was paid by.
    const wrongIntent = chargePaid(c.world, {
      orderUlid: c.orderUlid,
      chargeId: c.chargeId,
      intentId: otherIntent,
    });
    expect(await deliver(c.tenant, wrongIntent)).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      retryable: false,
    });

    const openLink = await seedLink(c.world, CHARGE.amountIdr);
    const openChargeId = await seedCharge(c.world, {
      orderUlid: c.orderUlid,
      linkId: openLink,
      intentId: null,
      status: "open",
    });
    const openEvent = chargePaid(c.world, {
      orderUlid: c.orderUlid,
      chargeId: openChargeId,
      intentId: c.chargeIntent,
    });
    expect(await deliver(c.tenant, openEvent)).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      retryable: false,
    });
    expect(await journalCount(c.world, `aj:order-charge:${c.chargeId}`)).toBe(
      0,
    );
    expect(await journalCount(c.world, `aj:order-charge:${openChargeId}`)).toBe(
      0,
    );
  });
});

describe("legend-i83ls payout guards of a paid charge intent", () => {
  it("CHG-8 a payout of the charge intent after the revenue was recognised parks POSTING_AMOUNTS_MISMATCH: the money already left customer_deposit as revenue", async () => {
    const c = await paidChargeWorld();
    await post(
      c.world,
      paymentPaid(c.world, c.chargeIntent, 24_200, CHARGE_DAY),
    );
    await post(c.world, c.event);
    const refundId = await seedRefund(c.world, c.chargeIntent, 1_000);

    expect(
      await deliver(
        c.tenant,
        paymentRefunded(c.world, refundId, c.chargeIntent, 1_000),
      ),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    expect(await balanceOf(c.world, "customer_deposit")).toBe(0);
  });

  it("CHG-9 a payout of the charge intent before the charge was paid is not blocked by the charge (fact order)", async () => {
    const c = await paidChargeWorld();
    await post(
      c.world,
      paymentPaid(c.world, c.chargeIntent, 24_200, CHARGE_DAY),
    );
    // A payout completed before the charge was paid cannot be backed by it.
    const refundId = randomUUID();
    await owner.query(
      `INSERT INTO payment_refunds
         (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
          requested_by, approved_by, decided_at, completed_at, unallocated_fund_id)
       VALUES ($1, $2, $3, $4, 1000, 'Pengembalian dana', 'completed', 'requester', 'approver', $5, $5, NULL)`,
      [refundId, c.world.tenant.id, c.world.outletId, c.chargeIntent, DAY],
    );
    await post(
      c.world,
      paymentRefunded(c.world, refundId, c.chargeIntent, 1_000),
    );

    // The revenue then needs the whole receipt: 24.2k charge + 1k payout > 24.2k.
    expect(await deliver(c.tenant, c.event)).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    expect(await journalCount(c.world, `aj:order-charge:${c.chargeId}`)).toBe(
      0,
    );
  });

  it("CHG-10 refundableBalance of a paid charge intent holds the whole charge: cap 0", async () => {
    const c = await paidChargeWorld();
    const context = contextOf(c.tenant);
    const balance = await withTenant(db, context, async (tx) => {
      const [intent] = await tx
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.tenantId, context.tenant.tenantId),
            eq(paymentIntents.id, c.chargeIntent),
          ),
        );
      return refundableBalance(tx, intent!);
    });
    expect(balance.paid).toBe(24_200n);
    expect(balance.cap).toBe(0n);
  });

  it("CHG-11 an unpaid (open) charge holds nothing: its late payment stays refundable", async () => {
    const c = await paidChargeWorld();
    const context = contextOf(c.tenant);
    const openLink = await seedLink(c.world, CHARGE.amountIdr);
    const lateIntent = await seedIntentOnLink(
      c.world,
      openLink,
      CHARGE.amountIdr,
      CHARGE_DAY,
    );
    await seedCharge(c.world, {
      orderUlid: c.orderUlid,
      linkId: openLink,
      intentId: null,
      status: "open",
    });
    const balance = await withTenant(db, context, async (tx) => {
      const [intent] = await tx
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.tenantId, context.tenant.tenantId),
            eq(paymentIntents.id, lateIntent),
          ),
        );
      return refundableBalance(tx, intent!);
    });
    expect(balance.cap).toBe(24_200n);
  });
});

// ============================================================================

describe("legend-800h1 order_issue.charge_paid paid in cash at the POS", () => {
  /** The order with its sale posted, and a charge paid in cash by a cash_in. */
  async function cashChargeWorld() {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const orderLink = await seedLink(world, 110_000);
    const orderIntent = await seedIntentOnLink(world, orderLink, 110_000, DAY);
    const orderUlid = createUlid();
    await seedOrder(world, orderLink, orderIntent, orderUlid);
    await post(world, paymentPaid(world, orderIntent, 110_000, DAY));
    await post(world, orderPaid(world, orderUlid));
    const chargeLink = await seedLink(world, CHARGE.amountIdr);
    const cashMovementId = await seedCashMovement(world);
    const chargeId = await seedCharge(world, {
      orderUlid,
      linkId: chargeLink,
      intentId: null,
      cashMovementId,
    });
    const event = (overrides: Record<string, unknown> = {}) =>
      chargePaid(world, {
        orderUlid,
        chargeId,
        intentId: null,
        overrides: {
          method: "pos_cash",
          cashMovementId,
          ...overrides,
        },
      });
    return { tenant, world, orderUlid, chargeId, cashMovementId, event };
  }

  it("CASH-1 pos_cash: Dr cash_on_hand = amount, Cr revenue/service/PBJT exactly under aj:order-charge; replay posts nothing", async () => {
    const c = await cashChargeWorld();
    const event = c.event();

    const result = await post(c.world, event);
    expect(await linesOf(c.world, result.journalEntryId)).toEqual([
      { role: "cash_on_hand", debit: 24_200, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 20_000 },
      { role: "service_charge", debit: 0, credit: 2_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 2_200 },
    ]);
    expect(await balanceOf(c.world, "cash_on_hand")).toBe(24_200);
    expect(await journalCount(c.world, `aj:order-charge:${c.chargeId}`)).toBe(
      1,
    );

    expect(await deliver(c.tenant, event)).toEqual({
      status: "already_posted",
      journalEntryId: result.journalEntryId,
    });
    // A second event for the same charge (re-emit) is the same journal.
    expect(await deliver(c.tenant, c.event())).toEqual({
      status: "already_posted",
      journalEntryId: result.journalEntryId,
    });
    expect(await journalCount(c.world, `aj:order-charge:${c.chargeId}`)).toBe(
      1,
    );
  });

  it("CASH-2 the cash variant needs no gateway receipt: nothing is booked on gateway_clearing or customer_deposit for it", async () => {
    const c = await cashChargeWorld();
    const before = {
      clearing: await balanceOf(c.world, "gateway_clearing"),
      deposit: await balanceOf(c.world, "customer_deposit"),
    };
    await post(c.world, c.event());
    expect(await balanceOf(c.world, "gateway_clearing")).toBe(before.clearing);
    expect(await balanceOf(c.world, "customer_deposit")).toBe(before.deposit);
  });

  it("CASH-3 cashMovementId that is not the charge's: parks PAYLOAD_INVALID (not retryable), nothing journaled", async () => {
    const c = await cashChargeWorld();
    const other = await seedCashMovement(c.world);

    expect(await deliver(c.tenant, c.event({ cashMovementId: other }))).toEqual(
      {
        status: "parked",
        code: "AUTO_JOURNAL_PAYLOAD_INVALID",
        retryable: false,
      },
    );
    expect(await journalCount(c.world, `aj:order-charge:${c.chargeId}`)).toBe(
      0,
    );
  });

  it("CASH-4 the movement is missing, not a cash_in, or of another amount: parks PAYLOAD_INVALID, nothing journaled", async () => {
    // Missing: the charge row names a movement id that does not exist.
    const missing = await cashChargeWorld();
    await asTenant(
      missing.world.tenant,
      (client) =>
        client.query(
          "DELETE FROM cash_movements WHERE tenant_id = $1 AND id = $2",
          [missing.world.tenant.id, missing.cashMovementId],
        ),
      { replica: true },
    );
    expect(await deliver(missing.tenant, missing.event())).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      retryable: false,
    });
    expect(
      await journalCount(missing.world, `aj:order-charge:${missing.chargeId}`),
    ).toBe(0);

    for (const patch of [
      { type: "cash_out" },
      { amountIdr: CHARGE.amountIdr - 1_000 },
    ]) {
      const c = await cashChargeWorld();
      await asTenant(
        c.world.tenant,
        (client) =>
          client.query(
            "UPDATE cash_movements SET type = coalesce($3, type), amount_idr = coalesce($4, amount_idr) WHERE tenant_id = $1 AND id = $2",
            [
              c.world.tenant.id,
              c.cashMovementId,
              (patch as { type?: string }).type ?? null,
              (patch as { amountIdr?: number }).amountIdr ?? null,
            ],
          ),
        { replica: true },
      );
      expect(await deliver(c.tenant, c.event())).toEqual({
        status: "parked",
        code: "AUTO_JOURNAL_PAYLOAD_INVALID",
        retryable: false,
      });
      expect(await journalCount(c.world, `aj:order-charge:${c.chargeId}`)).toBe(
        0,
      );
    }
  });

  it("CASH-5 the movement belongs to another outlet: parks PAYLOAD_INVALID, nothing journaled", async () => {
    const c = await cashChargeWorld();
    await asTenant(
      c.world.tenant,
      (client) =>
        client.query(
          "UPDATE cash_movements SET outlet_id = $3 WHERE tenant_id = $1 AND id = $2",
          [c.world.tenant.id, c.cashMovementId, randomUUID()],
        ),
      { replica: true },
    );
    expect(await deliver(c.tenant, c.event())).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      retryable: false,
    });
    expect(await journalCount(c.world, `aj:order-charge:${c.chargeId}`)).toBe(
      0,
    );
  });

  it("CASH-6 charge not paid (open) fails closed: PAYLOAD_INVALID, nothing journaled", async () => {
    const c = await cashChargeWorld();
    await asTenant(
      c.world.tenant,
      (client) =>
        client.query(
          "UPDATE order_issue_charges SET status = 'open', paid_at = NULL, cash_movement_id = NULL, paid_by = NULL WHERE tenant_id = $1 AND id = $2",
          [c.world.tenant.id, c.chargeId],
        ),
      { replica: true },
    );
    expect(await deliver(c.tenant, c.event())).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      retryable: false,
    });
    expect(await journalCount(c.world, `aj:order-charge:${c.chargeId}`)).toBe(
      0,
    );
  });

  it("CASH-7 payload amounts that differ from the charge row: POSTING_AMOUNTS_MISMATCH, nothing journaled", async () => {
    const c = await cashChargeWorld();
    expect(
      await deliver(
        c.tenant,
        c.event({ grossSalesIdr: 21_000, amountIdr: 25_200 }),
      ),
    ).toEqual({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
      retryable: false,
    });
    expect(await journalCount(c.world, `aj:order-charge:${c.chargeId}`)).toBe(
      0,
    );
  });

  it("CASH-8 sale journal of the order will never post: parks SALE_MISSING (not retryable) even for cash", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const orderLink = await seedLink(world, 110_000);
    const orderIntent = await seedIntentOnLink(world, orderLink, 110_000, DAY);
    const orderUlid = createUlid();
    await seedOrder(world, orderLink, orderIntent, orderUlid);
    const saleEvent = orderPaid(world, orderUlid);
    const saleOutboxId = await seedOutboxEvent(
      world,
      saleEvent,
      ulidToUuid(orderUlid),
    );
    await markDelivered(world, saleOutboxId);
    const cashMovementId = await seedCashMovement(world);
    const chargeId = await seedCharge(world, {
      orderUlid,
      linkId: await seedLink(world, CHARGE.amountIdr),
      intentId: null,
      cashMovementId,
    });
    expect(
      await deliver(
        tenant,
        chargePaid(world, {
          orderUlid,
          chargeId,
          intentId: null,
          overrides: { method: "pos_cash", cashMovementId },
        }),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_SALE_MISSING",
      retryable: false,
    });
  });

  it("CASH-10 open bill: the cash charge parks SALE_MISSING before the sale posts; once the sale posts the sweep books the cash charge", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const orderLink = await seedLink(world, 110_000);
    const orderIntent = await seedIntentOnLink(world, orderLink, 110_000, DAY);
    const orderUlid = createUlid();
    await seedOrder(world, orderLink, orderIntent, orderUlid);
    const cashMovementId = await seedCashMovement(world);
    const chargeId = await seedCharge(world, {
      orderUlid,
      linkId: await seedLink(world, CHARGE.amountIdr),
      intentId: null,
      cashMovementId,
    });
    expect(
      await deliver(
        tenant,
        chargePaid(world, {
          orderUlid,
          chargeId,
          intentId: null,
          overrides: { method: "pos_cash", cashMovementId },
        }),
      ),
    ).toEqual({
      status: "parked",
      code: "AUTO_JOURNAL_SALE_MISSING",
      retryable: false,
    });
    await post(world, paymentPaid(world, orderIntent, 110_000, DAY));
    await post(world, orderPaid(world, orderUlid));
    expect(await sweep(tenant)).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    expect(await journalCount(world, `aj:order-charge:${chargeId}`)).toBe(1);
  });

  it("CASH-9 the stored QR variant keeps working: no method in the payload is qr_link (CHG-1 shape), and a payload mixing the variants is refused by the contract", () => {
    const world = {
      tenant: { id: randomUUID(), brandId: randomUUID() },
      outletId: randomUUID(),
    } as World;
    const base = {
      orderUlid: createUlid(),
      chargeId: randomUUID(),
    };
    expect(() =>
      chargePaid(world, {
        ...base,
        intentId: null,
        overrides: { method: "qr_link" },
      }),
    ).toThrow();
    expect(() =>
      chargePaid(world, {
        ...base,
        intentId: randomUUID(),
        overrides: { method: "pos_cash", cashMovementId: randomUUID() },
      }),
    ).toThrow();
    expect(() => chargePaid(world, { ...base, intentId: null })).toThrow();
  });
});
