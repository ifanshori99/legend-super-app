// Guard of the payout journal on a split-bill QR pay-first order (legend-05cm9,
// brief docs/briefs/245a-test-journal-split.md).
//
// One QR pay-first order (due 110k = 100k + 10% PBJT), one payment link, two
// paid intents on that link: P (the order's pinned payer) and N. Each intent
// part of the sale is what its own money paid (evidence less unallocated
// funds), so a payout of an intent may only spend what its receipt left after
// that part. The order.paid sale of a split bill cannot be posted today (the
// payer's intent is smaller than total - DP), so these tests seed only the
// `orders` row (the guard reads it) and deliver the receipts and the payout.
//
// Assumptions:
// - A payout is `payment.refunded` whose `payment_refunds` row completes at
//   REFUND_DAY, after the order's fired_at (DAY): the sale part is counted.
// - Unallocated funds that carry an `evidence_id` are part of the intent's
//   evidence (so the intent's `payment.paid` receipt covers them) and are not
//   delivered as a separate `payment.funds_unallocated` receipt.
// - Helpers are copied from accounting-auto-journal.test.ts (the old file is
//   not changed).
// - order_items and order_issues point at users and menu items the test does not
//   need; they are inserted with session_replication_role = replica.

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
/** The recovery refund of an order issue is filed here: after the order, before REFUND_DAY. */
const T_RECOVERY = "2026-10-15T08:00:00.000Z";

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
): Promise<string> {
  const orderUuid = ulidToUuid(createUlid());
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
        orderUuid,
        world.tenant.id,
        world.outletId,
        `QR-${short()}`,
        DAY,
        linkId,
        payerIntentId,
      ],
    ),
  );
  return orderUuid;
}

/** A resolved ORD-09 failed-item issue of the order (user and menu FKs skipped). */
async function seedIssue(world: World, orderUuid: string): Promise<string> {
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
          `sq-issue-${randomUUID()}`,
        ],
      );
    },
    { replica: true },
  );
  return issueId;
}

/** The completed gateway payout the recovery filed for an issue (system:recovery). */
async function seedRecoveryRefund(
  world: World,
  intentId: string,
  amountIdr: number,
  issueId: string,
): Promise<string> {
  const refundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, completed_at, order_issue_id, created_at)
     VALUES ($1, $2, $3, $4, $5, 'Refund item gagal (ORD-09)', 'completed', 'system:recovery',
             'approver', $6, $6, $7, $6::timestamptz - interval '1 minute')`,
    [
      refundId,
      world.tenant.id,
      world.outletId,
      intentId,
      amountIdr,
      T_RECOVERY,
      issueId,
    ],
  );
  return refundId;
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

/**
 * The posted order.refunded journal of a recovery refund (aj:order-refund:<issueId>).
 * The split sale itself cannot be journalled today, so the refund's own event
 * parks; the guard only reads that this journal exists.
 */
async function seedRecoveryJournal(
  world: World,
  issueId: string,
  amountIdr: number,
): Promise<void> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM fiscal_periods
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-10'`,
    [world.tenant.id, world.entity],
  );
  const entryId = randomUUID();
  await asTenant(world.tenant, async (client) => {
    await client.query(
      `INSERT INTO journal_entries
         (id, tenant_id, legal_entity_id, outlet_id, entry_date, fiscal_period_id, source_type,
          source_id, description, posted_by, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, '2026-10-15', $5, 'refund', $6, 'Refund item gagal (ORD-09)',
               'system:recovery', $7, $8)`,
      [
        entryId,
        world.tenant.id,
        world.entity,
        world.outletId,
        rows[0]!.id,
        issueId,
        `aj:order-refund:${issueId}`,
        randomBytes(32).toString("hex"),
      ],
    );
    await client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr, outlet_id)
       VALUES ($1, $2, $3, 1, $5, 0, $6), ($1, $2, $4, 2, 0, $5, $6)`,
      [
        world.tenant.id,
        entryId,
        world.accounts.customer_deposit,
        world.accounts.gateway_clearing,
        amountIdr,
        world.outletId,
      ],
    );
  });
}

// ---- events -----------------------------------------------------------------

function envelope(
  world: World,
  input: {
    name: string;
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
    aggregateType: "payment",
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
  expect(result.status).toBe("posted");
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

// ============================================================================

describe("legend-05cm9 payout guard of a split-bill QR order", () => {
  /** Split bill 60k (payer P) + 50k (N) on one link, order fired at DAY. */
  async function splitBill(options: { tenant?: Tenant } = {}) {
    const world = await makeWorld(options.tenant ?? (await makeTenant()));
    const linkId = await seedLink(world, 110_000);
    const payer = await seedIntentOnLink(world, linkId, 60_000);
    const other = await seedIntentOnLink(world, linkId, 50_000);
    await seedSplitOrder(world, linkId, payer.intentId);
    return { world, linkId, payer, other };
  }

  it("SPLIT-S1 a payout of the whole 50k of the non-payer parks mismatch: its money is already in the sale", async () => {
    const { world, payer, other } = await splitBill();
    await post(world, paymentPaid(world, payer.intentId, 60_000));
    await post(world, paymentPaid(world, other.intentId, 50_000));

    const refundId = await seedRefund(world, other.intentId, 50_000);
    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, other.intentId, 50_000),
      ),
    ).toEqual(AMOUNTS_MISMATCH);
    // Both receipts only; the sale of 60k + 50k holds the money.
    expect(await balanceOf(world, "customer_deposit")).toBe(-110_000);
  });

  it("SPLIT-S2 payer with 110k evidence of which 50k is an unallocated fund: a non-fund payout of 50k posts (its part in the sale is 60k)", async () => {
    const world = await makeWorld(await makeTenant());
    const linkId = await seedLink(world, 110_000);
    const payer = await seedIntentOnLink(world, linkId, 110_000);
    await seedFund(world, payer.intentId, payer.evidenceId, 50_000);
    const other = await seedIntentOnLink(world, linkId, 50_000);
    await seedSplitOrder(world, linkId, payer.intentId);
    await post(world, paymentPaid(world, payer.intentId, 110_000));
    await post(world, paymentPaid(world, other.intentId, 50_000));

    const refundId = await seedRefund(world, payer.intentId, 50_000);
    const payout = await deliver(
      world.tenant,
      paymentRefunded(world, refundId, payer.intentId, 50_000),
    );
    // Base: false mismatch (110k + 50k > 110k).
    expect(JSON.stringify(payout)).toContain('"status":"posted"');
    // Receipts 110k + 50k, payout 50k.
    expect(await balanceOf(world, "customer_deposit")).toBe(-110_000);
  });

  it("SPLIT-S3 payer payout of 51k (above receipt 110k less its 60k part) still parks mismatch", async () => {
    const world = await makeWorld(await makeTenant());
    const linkId = await seedLink(world, 110_000);
    const payer = await seedIntentOnLink(world, linkId, 110_000);
    await seedFund(world, payer.intentId, payer.evidenceId, 50_000);
    const other = await seedIntentOnLink(world, linkId, 50_000);
    await seedSplitOrder(world, linkId, payer.intentId);
    await post(world, paymentPaid(world, payer.intentId, 110_000));
    await post(world, paymentPaid(world, other.intentId, 50_000));

    const refundId = await seedRefund(world, payer.intentId, 51_000);
    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, payer.intentId, 51_000),
      ),
    ).toEqual(AMOUNTS_MISMATCH);
    expect(await balanceOf(world, "customer_deposit")).toBe(-160_000);
  });

  it("SPLIT-S4 a non-payer whose whole money is a double_payment fund holds 0: a non-fund payout of its receipt posts", async () => {
    const world = await makeWorld(await makeTenant());
    const linkId = await seedLink(world, 110_000);
    const payer = await seedIntentOnLink(world, linkId, 110_000);
    const other = await seedIntentOnLink(world, linkId, 50_000);
    await seedFund(world, other.intentId, other.evidenceId, 50_000);
    await seedSplitOrder(world, linkId, payer.intentId);
    await post(world, paymentPaid(world, payer.intentId, 110_000));
    await post(world, paymentPaid(world, other.intentId, 50_000));

    const refundId = await seedRefund(world, other.intentId, 50_000);
    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, other.intentId, 50_000),
      ),
    ).toMatchObject({ status: "posted" });
    expect(await balanceOf(world, "customer_deposit")).toBe(-110_000);
  });

  it("SPLIT-S5 payout first: it waits (receipt in the outbox), and once the receipt posts the sweep gives the same mismatch verdict as S1", async () => {
    const tenant = await makeTenant();
    const { world, payer, other } = await splitBill({ tenant });
    await post(world, paymentPaid(world, payer.intentId, 60_000));
    const receiptEvent = paymentPaid(world, other.intentId, 50_000);
    const outboxId = await seedOutboxEvent(world, receiptEvent, other.intentId);

    const refundId = await seedRefund(world, other.intentId, 50_000);
    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, other.intentId, 50_000),
      ),
    ).toMatchObject({ status: "parked", retryable: true });
    expect(await balanceOf(world, "customer_deposit")).toBe(-60_000);

    await markDelivered(world, outboxId);
    await post(world, receiptEvent);
    await retryParkedAutoJournals(contextOf(tenant), SWEEP_AT);

    // Same verdict as receipt-first: the payout is never posted.
    expect(await balanceOf(world, "customer_deposit")).toBe(-110_000);
    const parked = await asTenant(tenant, async (client) => {
      const { rows } = await client.query<{
        error_code: string;
        retryable: boolean;
      }>(
        "SELECT error_code, retryable FROM auto_journal_parked WHERE tenant_id = $1 AND idempotency_key = $2",
        [tenant.id, `aj:payout:${refundId}`],
      );
      return rows;
    });
    expect(parked).toEqual([
      { error_code: "POSTING_AMOUNTS_MISMATCH", retryable: false },
    ]);
  });
  // R4: a recovery refund releases the sale hold only on the pinned code
  // (qrSaleInUseOfIntent); a non-pinned code's part of the sale stays whole.
  it("SPLIT-R4 a posted recovery refund does not release the non-payer's part of the sale: its payout still parks mismatch", async () => {
    const world = await makeWorld(await makeTenant());
    const linkId = await seedLink(world, 110_000);
    const payer = await seedIntentOnLink(world, linkId, 60_000);
    const other = await seedIntentOnLink(world, linkId, 50_000);
    const orderUuid = await seedSplitOrder(world, linkId, payer.intentId);
    await post(world, paymentPaid(world, payer.intentId, 60_000));
    await post(world, paymentPaid(world, other.intentId, 50_000));
    const issueId = await seedIssue(world, orderUuid);
    await seedRecoveryRefund(world, payer.intentId, 22_000, issueId);
    await seedRecoveryJournal(world, issueId, 22_000);

    // The non-payer's 50k is wholly in the sale; the release belongs to the payer.
    const refundId = await seedRefund(world, other.intentId, 22_000);
    expect(
      await deliver(
        world.tenant,
        paymentRefunded(world, refundId, other.intentId, 22_000),
      ),
    ).toEqual(AMOUNTS_MISMATCH);
  });
});
