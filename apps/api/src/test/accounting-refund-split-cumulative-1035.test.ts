// legend-2hl7y (brief 1035, finding D, tier K "jangan sampai rugi"): split
// transaction, two provider partial refunds. One provider transaction paid
// Rp140.000 for a Rp100.000 bill: Rp100.000 settled the bill, Rp40.000 is
// parked as an `overpayment` unallocated fund of the SAME evidence. The provider
// then refunds Rp30.000 twice on its own (payment_provider_refunds). The
// journal guard of `payment.provider_refunded` decides per ROW whether a refund
// comes off the parked money, while the cumulative refund of the evidence group
// is what matters: both events are refused AutoJournalPayloadInvalid although
// Rp60.000 really left the gateway and Rp20.000 of it was bill money.
// Written from the brief (docs/briefs/sub-1035-refund-so2.md, finding D),
// docs/qa/second-opinion-refund-ronde2-1034.md finding 5, the CTO decision
// below and the 1013 fixtures, failing first; not from the implementation.
//
// Rule (CTO decision, 18 Nov 2026): each provider refund is judged at its own
// time (rows ordered by (created_at, id), up to and including that row) with
// the CUMULATIVE total of its evidence group against the parked money:
//  - cumulative <= parked (R1 = 30 of 40): refused AutoJournalPayloadInvalid
//    (parked non-retryable, the finance route of parked funds), no journal;
//  - cumulative > parked (R2 = 30 more, 60 of 40): journaled for its OWN amount
//    (Dr customer_deposit / Cr gateway_clearing, like any provider refund);
//  - the order in which events are processed (R1 before or after R2 is
//    recorded) never changes the outcome, and no event journals another
//    event's money.
//
// 1035-D-01 R1 then R2 (R1 delivered before R2 is recorded): R1 refused, R2 = 30
// 1035-D-02 R2 delivered first, then R1: same outcome
// 1035-D-03 replays and sweeps change nothing (never a double journal)
// 1035-D-04 controls: one refund of 30 refused, one refund of 50 books 50
// 1035-D-05 another tenant with the same split is never touched
//
// Assumptions:
//  - Receipt: `payment.paid` receivedIdr 140.000 posted first (gateway received
//    the whole transaction); the evidence row (140.000, its own provider payment
//    ref, different from the intent's provider ref; refunds name the evidence ref and are bound to the
//    evidence row, evidence_id set) and the fund (40.000, reason overpayment, evidence_id) are
//    seeded directly, the refund rows directly (as in 1013).
//  - "Refused" = delivery does not throw, result is parked with code
//    AUTO_JOURNAL_PAYLOAD_INVALID, retryable false, no journal of the key.
//  - Books: gateway_clearing = 140.000 - booked refunds; customer_deposit
//    (credit balance) = -(140.000 - booked refunds).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/accounting-refund-split-cumulative-1035.test.ts" heavy pnpm test

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

const BILL = 100_000;
const PARKED = 40_000;
const RECEIVED = BILL + PARKED;

type Split = { intentId: string; providerRef: string; evidenceId: string };

/**
 * One paid intent (bill 100.000) whose single provider transaction was 140.000:
 * evidence 140.000 and an `overpayment` fund of 40.000 linked to it.
 */
async function seedSplit(world: World): Promise<Split> {
  const linkId = randomUUID();
  const intentId = randomUUID();
  const providerRef = `dp_split_${randomBytes(6).toString("hex")}`;
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'seed')`,
    [
      linkId,
      world.tenant.id,
      world.outletId,
      randomBytes(32).toString("hex"),
      `PR-${linkId.slice(0, 8)}`,
      BILL,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, method, provider, provider_ref, amount_idr,
        idempotency_key, status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, $7, 'paid', $8,
             '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [
      intentId,
      world.tenant.id,
      world.outletId,
      linkId,
      `dp_intent_${randomBytes(6).toString("hex")}`,
      BILL,
      `pr-${intentId}`,
      DAY,
    ],
  );
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, $6)
     RETURNING id`,
    [world.tenant.id, world.outletId, intentId, providerRef, RECEIVED, DAY],
  );
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'overpayment')`,
    [
      randomUUID(),
      world.tenant.id,
      world.outletId,
      intentId,
      rows[0]!.id,
      PARKED,
    ],
  );
  return { intentId, providerRef, evidenceId: rows[0]!.id };
}

/** The provider refunded `amountIdr` of that transaction on its own. */
async function seedProviderRefund(
  world: World,
  split: Split,
  amountIdr: number,
  recordedAt: string,
): Promise<string> {
  const rowId = randomUUID();
  await asTenant(world.tenant, (client) =>
    client.query(
      `INSERT INTO payment_provider_refunds
         (id, tenant_id, outlet_id, payment_intent_id, provider, provider_refund_id,
          provider_payment_ref, amount_idr, source, created_at, evidence_id)
       VALUES ($1, $2, $3, $4, 'doit', $5, $6, $7, 'payment_webhook', $8, $9)`,
      [
        rowId,
        world.tenant.id,
        world.outletId,
        split.intentId,
        `rf_${randomUUID().slice(0, 12)}`,
        split.providerRef,
        amountIdr,
        recordedAt,
        split.evidenceId,
      ],
    ),
  );
  return rowId;
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
    idempotencyKey: `split-test-${id}`,
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload,
  });
}

const paymentPaid = (world: World, intentId: string) =>
  envelope(world, {
    name: "payment.paid",
    aggregateId: intentId,
    occurredAt: DAY,
    payload: {
      intentId,
      method: "qris",
      provider: "doit",
      receivedIdr: RECEIVED,
      paidAt: DAY,
      late: false,
    },
  });

/** A fresh event id each call: a replay by another delivery of the same row. */
const providerRefunded = (
  world: World,
  rowId: string,
  intentId: string,
  amountIdr: number,
  refundedAt: string,
) =>
  envelope(world, {
    name: "payment.provider_refunded",
    aggregateId: rowId,
    occurredAt: refundedAt,
    payload: {
      providerRefundId: rowId,
      paymentIntentId: intentId,
      amountIdr,
      refundedAt,
    },
  });

// ---- driving + reading ------------------------------------------------------

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

/** Refused as an invalid payload (finance route of the parked fund). */
function expectRefused(result: AutoJournalResult, label: string): void {
  expect(result, label).toMatchObject({
    status: "parked",
    code: "AUTO_JOURNAL_PAYLOAD_INVALID",
    retryable: false,
  });
}

async function journalsByKey(world: World, key: string): Promise<string[]> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2",
    [world.tenant.id, key],
  );
  return rows.map((row) => row.id);
}

async function journalCount(world: World): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [world.tenant.id, world.entity],
  );
  return Number(rows[0]!.n);
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

async function balanceOf(world: World, role: Role): Promise<number> {
  const { rows } = await owner.query<{ balance: string | null }>(
    `SELECT sum(debit_idr - credit_idr)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [world.tenant.id, world.accounts[role]],
  );
  return Number(rows[0]!.balance ?? 0);
}

const refundLines = (amountIdr: number): Line[] => [
  { role: "customer_deposit", debit: amountIdr, credit: 0 },
  { role: "gateway_clearing", debit: 0, credit: amountIdr },
];

/** A split world with the 140.000 receipt posted. */
async function readyWorld(): Promise<{ world: World; split: Split }> {
  const world = await makeWorld(await makeTenant());
  const split = await seedSplit(world);
  const paid = await deliver(world.tenant, paymentPaid(world, split.intentId));
  expect(paid.status, "receipt posts").toBe("posted");
  return { world, split };
}

/** The books hold exactly what really left the gateway: `booked`. */
async function expectBooks(world: World, booked: number): Promise<void> {
  expect(await balanceOf(world, "gateway_clearing")).toBe(RECEIVED - booked);
  expect(await balanceOf(world, "customer_deposit")).toBe(-(RECEIVED - booked));
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

describe("1035-D split transaction: two provider partial refunds judged on the cumulative total", () => {
  it("1035-D-01 R1 (30) is delivered before R2 (30) is recorded: R1 refused, R2 journals its own 30", async () => {
    const { world, split } = await readyWorld();
    const r1 = await seedProviderRefund(world, split, 30_000, AFTER_PAID);
    expectRefused(
      await deliver(
        world.tenant,
        providerRefunded(world, r1, split.intentId, 30_000, AFTER_PAID),
      ),
      "R1 alone: cumulative 30 <= parked 40",
    );
    expect(await journalsByKey(world, `aj:provider-refund:${r1}`)).toEqual([]);
    await expectBooks(world, 0);

    const r2 = await seedProviderRefund(world, split, 30_000, AFTER_PAID_LATER);
    const second = await deliver(
      world.tenant,
      providerRefunded(world, r2, split.intentId, 30_000, AFTER_PAID_LATER),
    );
    expect(second.status, "R2: cumulative 60 > parked 40").toBe("posted");
    if (second.status !== "posted") return;
    expect(await linesOf(world, second.journalEntryId)).toEqual(
      refundLines(30_000),
    );
    // R2 journals only its own money; R1 stays refused, nothing is booked twice.
    expect(await journalsByKey(world, `aj:provider-refund:${r1}`)).toEqual([]);
    expect(await journalsByKey(world, `aj:provider-refund:${r2}`)).toHaveLength(
      1,
    );
    await expectBooks(world, 30_000);
  });

  it("1035-D-02 both refunds are recorded and R2 is delivered first, then R1: same outcome", async () => {
    const { world, split } = await readyWorld();
    const r1 = await seedProviderRefund(world, split, 30_000, AFTER_PAID);
    const r2 = await seedProviderRefund(world, split, 30_000, AFTER_PAID_LATER);

    const second = await deliver(
      world.tenant,
      providerRefunded(world, r2, split.intentId, 30_000, AFTER_PAID_LATER),
    );
    expect(second.status, "R2 judged at its own time: 60 > 40").toBe("posted");
    if (second.status === "posted")
      expect(await linesOf(world, second.journalEntryId)).toEqual(
        refundLines(30_000),
      );

    expectRefused(
      await deliver(
        world.tenant,
        providerRefunded(world, r1, split.intentId, 30_000, AFTER_PAID),
      ),
      "R1 judged at its own time: 30 <= 40, even though R2 exists now",
    );
    expect(await journalsByKey(world, `aj:provider-refund:${r1}`)).toEqual([]);
    await expectBooks(world, 30_000);
  });

  it("1035-D-03 replays (new event ids, a sweep) never double a journal and never open the refused one", async () => {
    const { world, split } = await readyWorld();
    const r1 = await seedProviderRefund(world, split, 30_000, AFTER_PAID);
    const r2 = await seedProviderRefund(world, split, 30_000, AFTER_PAID_LATER);
    const ev1 = () =>
      providerRefunded(world, r1, split.intentId, 30_000, AFTER_PAID);
    const ev2 = () =>
      providerRefunded(world, r2, split.intentId, 30_000, AFTER_PAID_LATER);

    expectRefused(await deliver(world.tenant, ev1()), "R1");
    expect((await deliver(world.tenant, ev2())).status).toBe("posted");
    const journals = await journalCount(world);

    // Concurrent duplicate deliveries of R2 post once.
    const both = await Promise.all([
      deliver(world.tenant, ev2()),
      deliver(world.tenant, ev2()),
    ]);
    for (const result of both) expect(result.status).toBe("already_posted");
    expectRefused(await deliver(world.tenant, ev1()), "R1 replay");
    await sweep(world.tenant);
    await sweep(world.tenant);

    expect(await journalCount(world)).toBe(journals);
    expect(await journalsByKey(world, `aj:provider-refund:${r1}`)).toEqual([]);
    expect(await journalsByKey(world, `aj:provider-refund:${r2}`)).toHaveLength(
      1,
    );
    await expectBooks(world, 30_000);
  });

  it("1035-D-04 controls: one refund of 30 alone is refused, one refund of 50 alone journals 50", async () => {
    const small = await readyWorld();
    const only30 = await seedProviderRefund(
      small.world,
      small.split,
      30_000,
      AFTER_PAID,
    );
    expectRefused(
      await deliver(
        small.world.tenant,
        providerRefunded(
          small.world,
          only30,
          small.split.intentId,
          30_000,
          AFTER_PAID,
        ),
      ),
      "single 30",
    );
    await expectBooks(small.world, 0);

    const big = await readyWorld();
    const only50 = await seedProviderRefund(
      big.world,
      big.split,
      50_000,
      AFTER_PAID,
    );
    const result = await deliver(
      big.world.tenant,
      providerRefunded(
        big.world,
        only50,
        big.split.intentId,
        50_000,
        AFTER_PAID,
      ),
    );
    expect(result.status, "single 50: 50 > parked 40").toBe("posted");
    if (result.status === "posted")
      expect(await linesOf(big.world, result.journalEntryId)).toEqual(
        refundLines(50_000),
      );
    await expectBooks(big.world, 50_000);
  });

  it("1035-D-05 another tenant with the same split is never touched, and judges its own refunds alone", async () => {
    const a = await readyWorld();
    const b = await readyWorld();
    const b1 = await seedProviderRefund(b.world, b.split, 30_000, AFTER_PAID);
    const bBefore = {
      journals: await journalCount(b.world),
      clearing: await balanceOf(b.world, "gateway_clearing"),
    };

    // Tenant A: both refunds, R2 journals.
    const a1 = await seedProviderRefund(a.world, a.split, 30_000, AFTER_PAID);
    const a2 = await seedProviderRefund(
      a.world,
      a.split,
      30_000,
      AFTER_PAID_LATER,
    );
    expectRefused(
      await deliver(
        a.world.tenant,
        providerRefunded(a.world, a1, a.split.intentId, 30_000, AFTER_PAID),
      ),
      "A R1",
    );
    expect(
      (
        await deliver(
          a.world.tenant,
          providerRefunded(
            a.world,
            a2,
            a.split.intentId,
            30_000,
            AFTER_PAID_LATER,
          ),
        )
      ).status,
    ).toBe("posted");

    // B is untouched by A's two refunds, and B's single 30 is judged alone.
    expect(await journalCount(b.world)).toBe(bBefore.journals);
    expect(await balanceOf(b.world, "gateway_clearing")).toBe(bBefore.clearing);
    expectRefused(
      await deliver(
        b.world.tenant,
        providerRefunded(b.world, b1, b.split.intentId, 30_000, AFTER_PAID),
      ),
      "B single 30",
    );
    await expectBooks(b.world, 0);
    await expectBooks(a.world, 30_000);
  });
});
