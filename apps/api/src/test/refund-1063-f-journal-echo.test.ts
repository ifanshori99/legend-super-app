// (brief 1063, legend-9uz9n, tier K "jangan sampai rugi"): the journal side of
// the source-transaction echo rule. Written from docs/briefs/1063-9uz9n.md and
// the fixtures of accounting-provider-refund-net-1013.test.ts, not from the
// implementation.
//
// Rule under test (brief): our refund R echoes a provider fact only when the
// provider refund id, the intent AND the source transaction are the same and
// the fact's amount is not more than R's. Otherwise the fact is foreign money
// and journals on its own (restrictive: when in doubt the fact counts).
//
// 1063-f-01 R of T1 done with ref X + fact X/T2: both journals post once each
// 1063-f-02 control: legit echo X/T1 (amount <= R): only R's journal
// 1063-f-03 fact X/T1 above R's amount is not an echo: both journals post
//
// Assumptions (the brief does not fix them):
//  - R is an intent-level refund of T1 (the intent's own provider reference);
//    T2 is another transaction reference of the same intent. The fact X/T2 is
//    seeded as the recorder leaves it after a `force` (own row, own tenant).
//  - R is in flight without ref, then completes with ref X (completeOurRefund),
//    as in 1013-AJ-09; both delivery orders are driven.
//  - The journal key of the provider fact is `aj:provider-refund:<row id>`
//    (1013). R's own journal key is not asserted; its effect is read from the
//    total journal count and the clearing / deposit balances.
//  - A fact that is an echo is "not posted" (no throw, no journal), as in 1013.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1063-f-journal-echo.test.ts" heavy pnpm test

import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createUlid,
  tenantIdSchema,
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

vi.setConfig({ testTimeout: 120_000 });

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const short = () => randomUUID().slice(0, 6);
/** Fixed "now" of the consumer; every business instant below is in the past. */
const NOW = new Date("2026-11-08T03:00:00Z");
/** The gateway received the money: 2026-10-15 12:00 Jakarta. */
const DAY = "2026-10-15T05:00:00.000Z";
/** Our refund is decided / the provider fact is recorded after the payment. */
const AFTER_PAID = "2026-10-16T05:00:00.000Z";
/** Our refund completes (ref matched) after the fact was recorded. */
const AFTER_PAID_LATER = "2026-10-16T06:00:00.000Z";

const RECEIPT = 100_000;
const R_IDR = 30_000;

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
     VALUES ($1, $2, 'Uji Echo Jurnal 1063f', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-1063f-${id.slice(0, 8)}`,
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
    [entity, tenant.id, `Entity 1063f ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet 1063f', 'Jl. Uji', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [outletId, tenant.id, tenant.brandId, entity, `E-${short()}`.toUpperCase()],
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

/** The intent's own transaction reference (T1). */
async function setIntentProviderRef(
  intentId: string,
  providerRef: string,
): Promise<void> {
  await owner.query(
    `UPDATE payment_intents SET provider_ref = $2 WHERE id = $1`,
    [intentId, providerRef],
  );
}

/**
 * The provider reported refund `x` of transaction `paymentRef`, booked as a
 * fact (as the recorder leaves it). Returns the row id (the event's
 * `providerRefundId`).
 */
async function seedFact(
  world: World,
  intentId: string,
  paymentRef: string,
  x: string,
  amountIdr: number,
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
        x,
        paymentRef,
        amountIdr,
        AFTER_PAID,
      ],
    ),
  );
  return rowId;
}

/** Our refund R at the intent level, in flight: approved, no reference yet. */
async function seedOurRefundInFlight(
  world: World,
  intentId: string,
  amountIdr: number,
): Promise<string> {
  const refundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, completed_at, provider_ref, payout_attempts)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian dana', 'approved', 'requester', 'approver', $6,
             NULL, NULL, 1)`,
    [
      refundId,
      world.tenant.id,
      world.outletId,
      intentId,
      amountIdr,
      AFTER_PAID,
    ],
  );
  return refundId;
}

/** R finishes at the provider: the reference X is matched, then it completes. */
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

// ---- synthetic events -------------------------------------------------------

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

function providerRefunded(
  world: World,
  rowId: string,
  intentId: string,
  amountIdr: number,
): EventEnvelope {
  return envelope(world, {
    name: "payment.provider_refunded",
    aggregateId: rowId,
    occurredAt: AFTER_PAID,
    payload: {
      providerRefundId: rowId,
      paymentIntentId: intentId,
      amountIdr,
      refundedAt: AFTER_PAID,
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
    aggregateId: refundId,
    occurredAt: AFTER_PAID_LATER,
    payload: { refundId, paymentIntentId: intentId, amountIdr },
  });
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

/** An echo: no throw, not posted, no journal added. */
async function expectNotPosted(world: World, event: EventEnvelope) {
  const before = await journalCount(world);
  const result = await deliver(world.tenant, event);
  expect(result.status, `${event.name} must not post`).not.toBe("posted");
  expect(await journalCount(world)).toBe(before);
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

/** Debit minus credit over every journal of the world, per role. */
async function balanceOf(world: World, role: Role): Promise<number> {
  const { rows } = await owner.query<{ balance: string | null }>(
    `SELECT sum(debit_idr - credit_idr)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [world.tenant.id, world.accounts[role]],
  );
  return Number(rows[0]!.balance ?? 0);
}

/** The refund payout lines of a provider refund journal. */
const refundLines = (amountIdr: number): Line[] => [
  { role: "customer_deposit", debit: amountIdr, credit: 0 },
  { role: "gateway_clearing", debit: 0, credit: amountIdr },
];

/**
 * A paid intent (T1 = its own reference) with our refund R in flight, then
 * completed with ref X. The receipt is journaled first.
 */
async function worldWithCompletedR(x: string) {
  const world = await makeWorld(await makeTenant());
  const intentId = await seedIntent(world, RECEIPT);
  const t1 = `DOIT-T1-${short()}`;
  const t2 = `DOIT-T2-${short()}`;
  await setIntentProviderRef(intentId, t1);
  await post(world, paymentPaid(world, intentId, RECEIPT));
  const refundId = await seedOurRefundInFlight(world, intentId, R_IDR);
  return {
    world,
    intentId,
    t1,
    t2,
    refundId,
    finish: () => completeOurRefund(refundId, x),
  };
}

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

describe("1063-f the journal echo needs the same source transaction", () => {
  it("1063-f-01 R of T1 done with ref X and a fact X/T2: both journals post exactly once (either order)", async () => {
    for (const refundFirst of [true, false]) {
      const x = `rf_x_${short()}`;
      const { world, intentId, t2, refundId, finish } =
        await worldWithCompletedR(x);
      const factIdr = 20_000; // not more than R: only the other transaction differs
      const rowId = await seedFact(world, intentId, t2, x, factIdr);
      await finish();

      const refundEvent = paymentRefunded(world, refundId, intentId, R_IDR);
      const factEvent = providerRefunded(world, rowId, intentId, factIdr);
      const label = refundFirst ? "refund first" : "fact first";
      const first = await post(world, refundFirst ? refundEvent : factEvent);
      const second = await post(world, refundFirst ? factEvent : refundEvent);
      expect(second.journalEntryId, label).not.toBe(first.journalEntryId);

      // Each fact posts once: the fact under its own key, R as the third journal.
      const factJournals = await journalsByKey(
        world,
        `aj:provider-refund:${rowId}`,
      );
      expect(factJournals, label).toHaveLength(1);
      expect(await linesOf(world, factJournals[0]!), label).toEqual(
        refundLines(factIdr),
      );
      expect(await journalCount(world), label).toBe(3);

      // Replays add nothing.
      for (const replay of [refundEvent, factEvent])
        expect((await deliver(world.tenant, replay)).status, label).toBe(
          "already_posted",
        );
      expect(await journalCount(world), label).toBe(3);

      // The books hold both refunds: 100.000 - 30.000 (R) - 20.000 (X/T2).
      expect(await balanceOf(world, "gateway_clearing"), label).toBe(
        RECEIPT - R_IDR - factIdr,
      );
      expect(await balanceOf(world, "customer_deposit"), label).toBe(
        -(RECEIPT - R_IDR - factIdr),
      );
    }
  });

  it("1063-f-02 control: a legit echo X/T1 (amount <= R) journals once, through R only (either order)", async () => {
    for (const refundFirst of [true, false]) {
      const x = `rf_x_${short()}`;
      const { world, intentId, t1, refundId, finish } =
        await worldWithCompletedR(x);
      const factIdr = 20_000; // <= R_IDR
      const rowId = await seedFact(world, intentId, t1, x, factIdr);
      await finish();

      const refundEvent = paymentRefunded(world, refundId, intentId, R_IDR);
      const factEvent = providerRefunded(world, rowId, intentId, factIdr);
      const label = refundFirst ? "refund first" : "fact first";
      if (refundFirst) {
        await post(world, refundEvent);
        await expectNotPosted(world, factEvent);
      } else {
        await expectNotPosted(world, factEvent);
        await post(world, refundEvent);
      }

      expect(
        await journalsByKey(world, `aj:provider-refund:${rowId}`),
        label,
      ).toEqual([]);
      // receipt + R only
      expect(await journalCount(world), label).toBe(2);
      expect(await balanceOf(world, "gateway_clearing"), label).toBe(
        RECEIPT - R_IDR,
      );
      expect(await balanceOf(world, "customer_deposit"), label).toBe(
        -(RECEIPT - R_IDR),
      );
    }
  });

  it("1063-f-03 a fact X/T1 above R's amount is not an echo: both journals post once", async () => {
    const x = `rf_x_${short()}`;
    const { world, intentId, t1, refundId, finish } =
      await worldWithCompletedR(x);
    const factIdr = 40_000; // > R_IDR: the provider paid out more than we sent
    const rowId = await seedFact(world, intentId, t1, x, factIdr);
    await finish();

    await post(world, paymentRefunded(world, refundId, intentId, R_IDR));
    await post(world, providerRefunded(world, rowId, intentId, factIdr));

    expect(
      await journalsByKey(world, `aj:provider-refund:${rowId}`),
    ).toHaveLength(1);
    expect(await journalCount(world)).toBe(3);
    expect(await balanceOf(world, "gateway_clearing")).toBe(
      RECEIPT - R_IDR - factIdr,
    );
  });
});
