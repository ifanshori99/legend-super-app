// legend-ua9ja + legend-9uvvu (brief 1025c, group B, money): customer credit
// that a reservation deposit (DP) already moved to another table session can be
// USED up before the provider's refund of that DP arrives. Today the recorder of
// a provider refund (recordProviderRefundInTx) then only writes a recon flag:
// no hold, no alert, so finance never learns the guest got more than the net DP.
//
//  - ua9ja: when a provider refund is recorded and the credit already USED is
//    larger than what is left of the DP (net of provider refunds and of what the
//    source session consumed), the source intent gets ONE open recon hold
//    (refund_recon_holds, reason credit_used_before_provider_refund, amount =
//    the surplus) and the supervisor gets ONE alert. Refunds and payouts of the
//    source intent stay blocked until finance resolves it. Nothing the guest
//    already used is cut, no new credit appears, nobody is paid more.
//  - 9uvvu: the recorder takes the deposit-intent advisory lock EXCLUSIVE before
//    it reads the net, so it waits for a concurrent credit apply (which holds
//    that lock SHARED) and then sees the credit it used.
//
// Written from the brief, the shared contract and the 1020/1025 fixtures, not
// from the implementation. Fail-first. Harness: reservation-deposit-credit-
// provider-refund-1020.test.ts (paidDeposit, closedSourceWithCredit, applyCredit).
//
// Scenario numbers: DP 100.000 -> source session A consumes 60.000 -> 40.000 is
// customer credit -> the customer moves credit to session B and B closes having
// used it (settlement lookup says the bill is covered) -> the provider refunds R.
// Net left of the DP = max(0, 100.000 - R - 60.000); surplus = used - net.
//
// Assumptions where the brief is not exact:
//  - "Credit used" = credit applied to a session that then closed with its bill
//    covered (the T3 shape of the 1020 tests). Credit applied to a still-open
//    session is cut on read (1020), so no hold is asserted for it.
//  - The hold is read from refund_recon_holds (tenant_id, payment_intent_id,
//    provider_refund_id, amount_idr, reason, resolved_at); an open hold has
//    resolved_at NULL; reason is matched by prefix `credit_used_before_provider_refund`.
//  - The alert is an in-app `notifications` row for an outlet-scoped supervisor.
//    It may be written after the recorder returns, so a positive count is polled
//    (up to 5 s) and then re-read after a short settle to catch duplicates.
//  - "Blocked" = what a provider refund already does (958/1025c): a new refund
//    and the resolution of a parked fund answer 409 PROVIDER_REFUNDED. The parked
//    fund belongs to a separate extra transaction, so only the hold (not the
//    refunded evidence) can block it.
//  - "Other tenant": a real second tenant is out of reach for this fixture, so
//    unaffected = a second, equal DP of the same tenant gets no hold, and no
//    hold of this reason exists under any other tenant id.
//  - Replay = the same providerRefundId recorded again, under the same or
//    another source (refund_webhook / payment_webhook / poller), also at once.
//  - Barrier: the credit apply is stalled AFTER it took its advisory locks by an
//    owner-side `LOCK TABLE ... IN SHARE MODE` on the tables it writes (reads
//    still pass). Advisory-lock keys are not guessed: the recorder's waiting
//    EXCLUSIVE lock must equal one of the SHARE advisory locks the stalled apply
//    holds (pg_locks). What the recorder does with credit applied to a still
//    open session is not pinned: afterwards either an open hold exists or B's
//    effective credit is within the net DP (never both missing).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1025c-b-credit-vs-provider-refund.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { idr, outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { closeTableSessionInputSchema } from "@starter/shared/qr-order";
import { createApp } from "../app";
import { db } from "../db";
import { paymentIntents } from "../db/schema/payment.ts";
import { withTenant } from "../db/tenant";
import { resolveUnallocatedFund } from "../services/payment-admin-funds.service.ts";
import {
  createRefund,
  refundableBalance,
} from "../services/payment-admin.service.ts";
import { recordProviderRefundInTx } from "../services/payment-provider-partial-refund.ts";
import { depositCreditForSession } from "../services/reservation-lifecycle.ts";
import { applyReservationCustomerCredit } from "../services/reservation-deposit-remainder.ts";
import {
  closeTableSession,
  openOrJoinTableSession,
  setTableSessionSettlementLookup,
} from "../services/table-session.service.ts";
import {
  createTable,
  createZone,
  dropFloorRows,
  issueQr,
  owner,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";

const HOLD_REASON = "credit_used_before_provider_refund";
const outletId = outletIdSchema.parse(seededOutletA);
const scope = (tenantId = seededTenantId) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
const zoneIds: string[] = [];
const tableIds: string[] = [];
const reservationIds: string[] = [];
const intentIds: string[] = [];
const linkIds: string[] = [];
const profileIds: string[] = [];
const orderIds: string[] = [];
const sessionIds: string[] = [];
const settlements = new Map<string, { total: number; paid: number } | null>();
let staff: Staff;
let supervisor: Staff;
let receiptEntity: string;
let receiptPeriod: string;
const receiptAccounts = [randomUUID(), randomUUID()];
const receiptEntries: string[] = [];

async function seedOriginalReceipt(intentId: string, amount: number) {
  const journalId = randomUUID();
  receiptEntries.push(journalId);
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO journal_entries(id,tenant_id,legal_entity_id,outlet_id,entry_date,fiscal_period_id,source_type,source_id,description,idempotency_key,request_fingerprint)
 VALUES($1,$2,$3,$4,$5,$6,'customer_deposit',$7,'Penerimaan DP 1025c-B',$8,$9)`,
      [
        journalId,
        seededTenantId,
        receiptEntity,
        outletId,
        new Date().toISOString().slice(0, 10),
        receiptPeriod,
        intentId,
        `aj:receipt:${intentId}`,
        "0".repeat(64),
      ],
    );
    await c.query(
      `INSERT INTO journal_lines(tenant_id,entry_id,account_id,line_no,debit_idr,credit_idr,outlet_id) VALUES($1,$2,$3,1,$5,0,$6),($1,$2,$4,2,0,$5,$6)`,
      [
        seededTenantId,
        journalId,
        receiptAccounts[0],
        receiptAccounts[1],
        amount,
        outletId,
      ],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  return journalId;
}

async function newProfile() {
  const id = randomUUID();
  profileIds.push(id);
  await owner.query(
    `INSERT INTO customer_profiles
       (id, tenant_id, name, membership_status, whatsapp_verified_at)
     VALUES ($1, $2, '1025c-B Customer', 'active', now())`,
    [id, seededTenantId],
  );
  return id;
}

async function newSession() {
  const zone = await createZone(staff.client);
  zoneIds.push(zone.id);
  const table = await createTable(staff.client, { zoneId: zone.id });
  tableIds.push(table.id);
  const qr = await issueQr(staff.client, table.id);
  const opened = await openOrJoinTableSession(scope(), {
    qrToken: qr.token,
    pax: 2,
    deviceHash: `t1025cb-${randomUUID()}`,
  });
  sessionIds.push(opened.session.id);
  return { sessionId: opened.session.id, zoneId: zone.id as string };
}

async function addOrder(
  sessionId: string,
  total: number,
  deposit: number,
  profileId: string | null,
) {
  const id = randomUUID();
  orderIds.push(id);
  await owner.query(
    `INSERT INTO orders
       (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
        subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
        total_idr, deposit_applied_idr, status, business_date, placed_at,
        table_session_id, customer_profile_id)
     VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', $5, 0, 0, 0, 0,
             $5, $6, 'sent', '2026-11-12', now(), $7, $8)`,
    [
      id,
      seededTenantId,
      outletId,
      `T1025CB-${id.slice(0, 8)}`,
      total,
      deposit,
      sessionId,
      profileId,
    ],
  );
}

type Deposit = Awaited<ReturnType<typeof paidDeposit>>;

/** Paid DP 100.000 seated on session A whose bill is 60.000 (DP covers it). */
async function paidDeposit() {
  const profileId = await newProfile();
  const total = 60_000;
  const deposit = 100_000;
  const session = await newSession();
  const reservationId = randomUUID();
  const intentId = randomUUID();
  const linkId = randomUUID();
  const providerRef = `t1025cb-evidence-${intentId}`;
  reservationIds.push(reservationId);
  intentIds.push(intentId);
  linkIds.push(linkId);
  await owner.query(
    `INSERT INTO reservations
       (id, tenant_id, outlet_id, customer_profile_id, guest_name, reserved_for,
        duration_minutes, pax, zone_id, deposit_idr, policy_snapshot, status,
        source, seated_at, table_session_id)
     VALUES ($1, $2, $3, $4, '1025c-B Payer', now(), 90, 2, $5, $6, $7,
             'seated', 'staff', now(), $8)`,
    [
      reservationId,
      seededTenantId,
      outletId,
      profileId,
      session.zoneId,
      deposit,
      JSON.stringify({
        version: "t1025cb",
        depositRequirement: "required",
        depositAmountIdr: deposit,
        paymentWindowMinutes: 60,
        freeCancellationHours: 24,
        lateCancellationRefundBp: 0,
        noShowRefundBp: 0,
        minimumSpendIdr: 0,
        capturedAt: new Date().toISOString(),
      }),
      session.sessionId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 't1025cb-test')`,
    [
      linkId,
      seededTenantId,
      outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `T1025CB-${linkId.slice(0, 8)}`,
      deposit,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, reservation_id, method, provider,
        provider_ref, amount_idr, idempotency_key, status, instructions, expires_at, paid_at)
     VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', $6, $7, $8, 'paid',
       '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
       now() + interval '1 hour', now())`,
    [
      intentId,
      seededTenantId,
      outletId,
      linkId,
      reservationId,
      providerRef,
      deposit,
      `t1025cb-pay-${intentId}`,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [seededTenantId, outletId, intentId, providerRef, deposit],
  );
  await owner.query(
    `UPDATE reservations SET deposit_payment_id = $2, deposit_payment_link_id = $3 WHERE id = $1`,
    [reservationId, intentId, linkId],
  );
  await owner.query(
    "UPDATE table_sessions SET reservation_id = $2 WHERE id = $1",
    [session.sessionId, reservationId],
  );
  await owner.query(
    `INSERT INTO reservation_deposit_allocations
       (tenant_id, outlet_id, reservation_id, table_session_id, payment_intent_id, amount_idr)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      seededTenantId,
      outletId,
      reservationId,
      session.sessionId,
      intentId,
      deposit,
    ],
  );
  await addOrder(session.sessionId, total, Math.min(deposit, total), profileId);
  settlements.set(session.sessionId, { total, paid: deposit });
  const receiptJournalId = await seedOriginalReceipt(intentId, deposit);
  return {
    ...session,
    reservationId,
    intentId,
    profileId,
    providerRef,
    deposit,
    total,
    receiptJournalId,
  };
}

const close = (sessionId: string) =>
  closeTableSession(
    scope(),
    sessionId,
    closeTableSessionInputSchema.parse({
      tableCleaned: true,
      waiterConfirmedEmpty: false,
    }),
    staff.userId,
  );

async function remainders(reservationId: string) {
  const { rows } = await owner.query<{
    kind: string;
    amount_idr: string;
    remaining_idr: string;
  }>(
    "SELECT kind, amount_idr::text, remaining_idr::text FROM reservation_deposit_remainders WHERE reservation_id = $1 ORDER BY kind, amount_idr, remaining_idr",
    [reservationId],
  );
  return rows.map((r) => ({
    kind: r.kind,
    amount: Number(r.amount_idr),
    remaining: Number(r.remaining_idr),
  }));
}

/** Every credit-use row of a session, as JSON (column-agnostic snapshot). */
async function creditUses(sessionId: string) {
  const { rows } = await owner.query<{ row: string }>(
    `SELECT to_jsonb(u)::text AS row FROM reservation_customer_credit_uses u
      WHERE tenant_id = $1 AND table_session_id = $2 ORDER BY 1`,
    [seededTenantId, sessionId],
  );
  return rows.map((r) => r.row);
}

const applyCredit = (
  profileId: string,
  sessionId: string,
  amount: number,
  key: string = randomUUID(),
) =>
  applyReservationCustomerCredit(
    scope(),
    staff.userId,
    outletId,
    {
      customerProfileId: profileId,
      tableSessionId: sessionId,
      amountIdr: idr(amount),
    },
    key,
  );

/** A second visit of the same customer with an open bill of `total`. */
async function targetSession(profileId: string, total: number) {
  const target = await newSession();
  await addOrder(target.sessionId, total, 0, profileId);
  settlements.set(target.sessionId, { total, paid: 0 });
  return target.sessionId;
}

const effectiveCredit = (sessionId: string) =>
  withTenant(db, scope(), (tx) =>
    depositCreditForSession(
      tx,
      tenantIdSchema.parse(seededTenantId),
      sessionId,
    ),
  );

/** DP 100k, A consumed 60k and closed: 40k credit exists for the customer. */
async function closedSourceWithCredit() {
  const d = await paidDeposit();
  await close(d.sessionId);
  expect(await remainders(d.reservationId)).toEqual([
    { kind: "customer_credit", amount: 40_000, remaining: 40_000 },
  ]);
  return d;
}

/**
 * DP source closed, then session B takes `used` of the credit and closes with
 * its bill covered by it (credit really USED).
 */
async function creditUsedScene(used: number) {
  const d = await closedSourceWithCredit();
  const b = await targetSession(d.profileId, used);
  await applyCredit(d.profileId, b, used);
  settlements.set(b, { total: used, paid: used });
  await close(b);
  return { ...d, b };
}

type Hold = {
  id: string;
  amount: number;
  reason: string;
  resolvedAt: Date | null;
  providerRefundId: string | null;
  tenantId: string;
};

async function creditHoldsOf(intentId: string): Promise<Hold[]> {
  const { rows } = await owner.query<{
    id: string;
    amount_idr: string;
    reason: string;
    resolved_at: Date | null;
    provider_refund_id: string | null;
    tenant_id: string;
  }>(
    `SELECT id, amount_idr::text, reason, resolved_at, provider_refund_id, tenant_id
       FROM refund_recon_holds
      WHERE payment_intent_id = $1 AND reason LIKE $2
      ORDER BY flagged_at`,
    [intentId, `${HOLD_REASON}%`],
  );
  return rows.map((r) => ({
    id: r.id,
    amount: Number(r.amount_idr),
    reason: r.reason,
    resolvedAt: r.resolved_at,
    providerRefundId: r.provider_refund_id,
    tenantId: r.tenant_id,
  }));
}

type Source = "refund_webhook" | "payment_webhook" | "poller";

/** The provider refunds `amountIdr` of the DP payment (webhook/poller path). */
function recordRefund(
  d: Pick<Deposit, "intentId" | "providerRef">,
  amountIdr: number,
  opts: { providerRefundId?: string; source?: Source } = {},
) {
  const context = scope();
  return withTenant(db, context, (tx) =>
    recordProviderRefundInTx(
      tx,
      context,
      {
        provider: "doit",
        providerRefundId:
          opts.providerRefundId ?? `rf_${randomUUID().slice(0, 12)}`,
        providerPaymentRef: d.providerRef,
        amountIdr,
        source: opts.source ?? "payment_webhook",
        expectedIntentId: d.intentId,
        // Record without the in-flight "retry" window (as 1016 does).
        force: true,
      },
      new Date(),
    ),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const supervisorAlerts = async () => {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM notifications WHERE tenant_id = $1 AND user_id = $2",
    [seededTenantId, supervisor.userId],
  );
  return Number(rows[0]!.n);
};

/** Exactly `expected` new supervisor alerts since `before` (polled, then settled). */
async function expectAlerts(before: number, expected: number) {
  if (expected > 0)
    await vi.waitFor(
      async () => {
        expect((await supervisorAlerts()) - before).toBe(expected);
      },
      { timeout: 5_000, interval: 100 },
    );
  await sleep(400);
  expect(await supervisorAlerts(), "no duplicate alert").toBe(
    before + expected,
  );
}

/**
 * A provider refund already alerts the supervisor today (a plain "provider
 * refunded" alert), hold or not. The hold alert must come ON TOP of it, so the
 * expectations below are relative to what a refund that creates no hold
 * alerts. Measured on a scene whose refund (20.000 vs credit used 10.000) is
 * below the credit, with the same call pattern.
 */
const plainAlertCache = new Map<string, number>();
async function plainAlerts(pattern: "single" | "replayed") {
  const cached = plainAlertCache.get(pattern);
  if (cached !== undefined) return cached;
  const d = await creditUsedScene(10_000);
  const before = await supervisorAlerts();
  if (pattern === "single") await recordRefund(d, 20_000);
  else await replayRefund(d, 20_000, `rf_${randomUUID().slice(0, 12)}`);
  await sleep(800);
  const delta = (await supervisorAlerts()) - before;
  plainAlertCache.set(pattern, delta);
  return delta;
}

/** The same provider refund delivered five times, by every source, even at once. */
async function replayRefund(
  d: Pick<Deposit, "intentId" | "providerRef">,
  amountIdr: number,
  providerRefundId: string,
) {
  await recordRefund(d, amountIdr, {
    providerRefundId,
    source: "refund_webhook",
  });
  await recordRefund(d, amountIdr, { providerRefundId, source: "poller" });
  await recordRefund(d, amountIdr, {
    providerRefundId,
    source: "payment_webhook",
  });
  await Promise.all([
    recordRefund(d, amountIdr, { providerRefundId, source: "poller" }),
    recordRefund(d, amountIdr, { providerRefundId, source: "refund_webhook" }),
  ]);
}

async function providerRefundRows(intentId: string) {
  const { rows } = await owner.query<{ n: string; idr: string }>(
    `SELECT count(*)::text AS n, coalesce(sum(amount_idr), 0)::text AS idr
       FROM payment_provider_refunds WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [seededTenantId, intentId],
  );
  return { rows: Number(rows[0]!.n), idr: Number(rows[0]!.idr) };
}

async function providerRefundIdsOf(intentId: string) {
  const { rows } = await owner.query<{ provider_refund_id: string }>(
    `SELECT provider_refund_id FROM payment_provider_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [seededTenantId, intentId],
  );
  return rows.map((r) => r.provider_refund_id);
}

async function ourRefundRows(intentId: string) {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [seededTenantId, intentId],
  );
  return Number(rows[0]!.n);
}

async function refundableLeft(intentId: string) {
  const balance = await withTenant(db, scope(), async (tx) => {
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantIdSchema.parse(seededTenantId)),
          eq(paymentIntents.id, intentId),
        ),
      );
    return refundableBalance(tx, intent!);
  });
  return Number(balance.cap) - Number(balance.reserved);
}

const requestRefund = (intentId: string, amount: number, key = randomUUID()) =>
  createRefund(
    scope(),
    staff.userId,
    {
      idempotencyKey: key,
      paymentIntentId: intentId,
      amountIdr: idr(amount),
      reason: "1025c-B refund guard",
    },
    key,
  );

/** A parked fund of a SEPARATE extra transaction of the source intent. */
async function parkExtraFund(d: Pick<Deposit, "intentId">, amount = 30_000) {
  const evidenceId = randomUUID();
  const fundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_evidence
       (id, tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, $4, 'doit', $5, 'qris', 'verified_webhook', $6, now())`,
    [
      evidenceId,
      seededTenantId,
      outletId,
      d.intentId,
      `t1025cb-extra-${randomUUID()}`,
      amount,
    ],
  );
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'double_payment')`,
    [fundId, seededTenantId, outletId, d.intentId, evidenceId, amount],
  );
  return fundId;
}

function resolveFund(fundId: string, resolution: "refund" | "credit") {
  const key = randomUUID();
  return resolveUnallocatedFund(
    scope(),
    staff.userId,
    { fundId } as Parameters<typeof resolveUnallocatedFund>[2],
    {
      idempotencyKey: key,
      resolution,
      note: "Kembalikan kelebihan bayar",
    } as Parameters<typeof resolveUnallocatedFund>[3],
    key,
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires disposable database");
  const app = createApp();
  staff = await staffWithRole(app, {
    template: "owner",
    label: "1025c-B DP Credit Owner",
  });
  supervisor = await staffWithRole(app, {
    template: "supervisor",
    scopeType: "outlet",
    scopeId: outletId,
    label: "1025c-B Supervisor",
  });
  const entity = await owner.query(
    "SELECT legal_entity_id FROM outlets WHERE id=$1",
    [outletId],
  );
  receiptEntity = entity.rows[0].legal_entity_id;
  for (const [i, type, group] of [
    [0, "asset", "current_asset"],
    [1, "liability", "current_liability"],
  ] as const)
    await owner.query(
      `INSERT INTO chart_of_accounts(id,tenant_id,legal_entity_id,code,name,type,report_group) VALUES($1,$2,$3,$4,'1025c-B DP receipt',$5,$6)`,
      [
        receiptAccounts[i],
        seededTenantId,
        receiptEntity,
        `986.${i + 1}`,
        type,
        group,
      ],
    );
  await owner.query(
    `INSERT INTO fiscal_periods(tenant_id,legal_entity_id,period) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
    [seededTenantId, receiptEntity, new Date().toISOString().slice(0, 7)],
  );
  receiptPeriod = (
    await owner.query(
      "SELECT id FROM fiscal_periods WHERE tenant_id=$1 AND legal_entity_id=$2 AND period=$3",
      [seededTenantId, receiptEntity, new Date().toISOString().slice(0, 7)],
    )
  ).rows[0].id;
  setTableSessionSettlementLookup(async ({ sessionId }) => {
    const s = settlements.get(sessionId);
    return s ? { billTotalIdr: idr(s.total), paidIdr: idr(s.paid) } : null;
  });
});

afterAll(async () => {
  setTableSessionSettlementLookup(null);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "DELETE FROM journal_lines WHERE entry_id=ANY($1::uuid[]) OR entry_id IN(SELECT id FROM journal_entries WHERE reversal_of=ANY($1::uuid[]))",
      [receiptEntries],
    );
    await client.query(
      "DELETE FROM journal_entries WHERE id=ANY($1::uuid[]) OR reversal_of=ANY($1::uuid[])",
      [receiptEntries],
    );
    await client.query(
      "DELETE FROM chart_of_accounts WHERE id=ANY($1::uuid[])",
      [receiptAccounts],
    );
    for (const table of ["pos_deposit_refunds", "pos_order_refunds"])
      await client.query(
        `DELETE FROM ${table} WHERE order_id = ANY($1::uuid[])`,
        [orderIds],
      );
    for (const table of [
      "reservation_credit_recon_flags",
      "reservation_customer_credit_uses",
      "reservation_deposit_remainders",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND table_session_id = ANY($2::uuid[])`,
        [seededTenantId, sessionIds],
      );
    await client.query(
      "DELETE FROM approval_requests WHERE object_type = 'payment_refund' AND object_id IN (SELECT id::text FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[]))",
      [intentIds],
    );
    await client.query(
      "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query(
      "DELETE FROM refund_recon_holds WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query(
      "DELETE FROM payment_unallocated_funds WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      orderIds,
    ]);
    await client.query(
      "DELETE FROM reservation_deposit_allocations WHERE reservation_id = ANY($1::uuid[])",
      [reservationIds],
    );
    await client.query("DELETE FROM reservations WHERE id = ANY($1::uuid[])", [
      reservationIds,
    ]);
    await client.query(
      "DELETE FROM payment_provider_refunds WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query(
      "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query(
      "DELETE FROM payment_intents WHERE id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
      linkIds,
    ]);
    await client.query(
      "DELETE FROM customer_profiles WHERE id = ANY($1::uuid[])",
      [profileIds],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await owner.end();
});

describe("legend-ua9ja provider refund after the credit was used leaves a hold and an alert", () => {
  it("1025c-ua9ja DP 100k, A used 60k, B used the 40k credit, provider refunds 30k: one open hold of 30.000 on the source intent and one supervisor alert", async () => {
    const plain = await plainAlerts("single");
    const d = await creditUsedScene(40_000);
    expect(await creditHoldsOf(d.intentId)).toEqual([]);
    const alertsBefore = await supervisorAlerts();

    const outcome = await recordRefund(d, 30_000);
    expect(outcome.status).toBe("recorded");

    // Net left = 100k - 30k - 60k = 10k, used 40k: surplus 30k.
    const holds = await creditHoldsOf(d.intentId);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      amount: 30_000,
      resolvedAt: null,
      tenantId: seededTenantId,
    });
    expect(holds[0]!.providerRefundId).toBe(
      (await providerRefundIdsOf(d.intentId))[0],
    );
    // The plain provider-refund alert plus the hold alert.
    await expectAlerts(alertsBefore, plain + 1);
  });

  it("1025c-ua9ja the provider refunds the whole DP after the credit was used: the hold is the whole 40.000 used credit", async () => {
    const d = await creditUsedScene(40_000);

    await recordRefund(d, 100_000);

    // Net left = 0, used 40k: surplus 40k.
    const holds = await creditHoldsOf(d.intentId);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ amount: 40_000, resolvedAt: null });
  });

  it("1025c-ua9ja a refund that leaves less net DP than the credit used by one rupiah holds exactly 1 IDR", async () => {
    const d = await creditUsedScene(10_000);

    // Net after R = 100k - R - 60k; used 10k. R = 31.000 -> net 9.000, surplus 1.000.
    await recordRefund(d, 31_000);

    const holds = await creditHoldsOf(d.intentId);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ amount: 1_000, resolvedAt: null });
  });

  it.each([
    [20_000, "below the unused credit (net 20.000 >= used 10.000)"],
    [30_000, "exactly the credit used (net 10.000 == used 10.000)"],
  ])(
    "1025c-ua9ja a small provider refund of %i (%s) leaves no hold and no alert",
    async (refund) => {
      // B used only 10k of the 40k credit; 30k is still unused credit.
      const plain = await plainAlerts("single");
      const d = await creditUsedScene(10_000);
      const alertsBefore = await supervisorAlerts();

      const outcome = await recordRefund(d, refund);
      expect(outcome.status).toBe("recorded");

      expect(await creditHoldsOf(d.intentId)).toEqual([]);
      // Only the plain provider-refund alert, no hold alert on top.
      await expectAlerts(alertsBefore, plain);
    },
  );

  it("1025c-ua9ja refunds and payouts of the source intent are blocked (409 PROVIDER_REFUNDED) while the hold is open", async () => {
    const d = await creditUsedScene(40_000);
    const fundId = await parkExtraFund(d);

    await recordRefund(d, 30_000);
    expect(await creditHoldsOf(d.intentId)).toHaveLength(1);

    await expect(requestRefund(d.intentId, 1)).rejects.toMatchObject({
      status: 409,
      code: "PROVIDER_REFUNDED",
    });
    await expect(resolveFund(fundId, "credit")).rejects.toMatchObject({
      status: 409,
      code: "PROVIDER_REFUNDED",
    });
    await expect(resolveFund(fundId, "refund")).rejects.toMatchObject({
      status: 409,
      code: "PROVIDER_REFUNDED",
    });
    expect(await ourRefundRows(d.intentId), "no refund of ours filed").toBe(0);
    const { rows: funds } = await owner.query<{ resolved_at: Date | null }>(
      "SELECT resolved_at FROM payment_unallocated_funds WHERE id = $1",
      [fundId],
    );
    expect(funds[0]!.resolved_at, "the parked fund stays open").toBeNull();
  });

  it("1025c-ua9ja the guest is not paid more: used credit untouched, no new credit, nothing refundable, only the provider's 30.000 went out", async () => {
    const d = await creditUsedScene(40_000);
    const remaindersBefore = await remainders(d.reservationId);
    const usesBefore = await creditUses(d.b);
    expect(usesBefore.length).toBeGreaterThan(0);

    await recordRefund(d, 30_000);
    expect(await creditHoldsOf(d.intentId)).toHaveLength(1);

    // Credit already used is not cut and no new credit appeared.
    expect(await remainders(d.reservationId)).toEqual(remaindersBefore);
    expect(await creditUses(d.b)).toEqual(usesBefore);
    const c = await targetSession(d.profileId, 10_000);
    await applyCredit(d.profileId, c, 10_000).catch(() => undefined);
    expect(await effectiveCredit(c), "no credit left to move").toBe(0);
    expect(await remainders(d.reservationId)).toEqual(remaindersBefore);
    // Nothing more can be refunded: the net DP is gone.
    expect(await refundableLeft(d.intentId)).toBe(0);
    expect(await ourRefundRows(d.intentId)).toBe(0);
    expect(await providerRefundRows(d.intentId)).toEqual({
      rows: 1,
      idr: 30_000,
    });
  });

  it("1025c-ua9ja replay: the same provider refund recorded again, from webhook and poller, even at once, stays one hold and one alert", async () => {
    const plain = await plainAlerts("replayed");
    const d = await creditUsedScene(40_000);
    const alertsBefore = await supervisorAlerts();
    const providerRefundId = `rf_${randomUUID().slice(0, 12)}`;

    await replayRefund(d, 30_000, providerRefundId);

    const holds = await creditHoldsOf(d.intentId);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      amount: 30_000,
      providerRefundId,
      resolvedAt: null,
    });
    expect(await providerRefundRows(d.intentId)).toEqual({
      rows: 1,
      idr: 30_000,
    });
    await expectAlerts(alertsBefore, plain + 1);
  });

  it("1025c-ua9ja another DP and another tenant are not affected by the hold", async () => {
    const plain = await plainAlerts("single");
    const mine = await creditUsedScene(40_000);
    const other = await creditUsedScene(40_000);
    const alertsBefore = await supervisorAlerts();

    await recordRefund(mine, 30_000);

    expect(await creditHoldsOf(mine.intentId)).toHaveLength(1);
    expect(await creditHoldsOf(other.intentId)).toEqual([]);
    // The unrelated DP still works: its refund path is not blocked by a hold,
    // and its own provider-refund history is empty.
    expect(await providerRefundRows(other.intentId)).toEqual({
      rows: 0,
      idr: 0,
    });
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM refund_recon_holds
        WHERE reason LIKE $1 AND payment_intent_id = ANY($2::uuid[])
          AND tenant_id <> $3`,
      [`${HOLD_REASON}%`, intentIds, seededTenantId],
    );
    expect(Number(rows[0]!.n), "no hold under another tenant").toBe(0);
    await expectAlerts(alertsBefore, plain + 1);
  });
});

describe("legend-9uvvu the provider-refund recorder waits for a concurrent credit apply", () => {
  it("1025c-9uvvu apply holding the deposit-intent lock shared makes the recorder wait (exclusive), and after apply commits the recorder sees the used credit", async () => {
    const d = await closedSourceWithCredit();
    const b = await targetSession(d.profileId, 40_000);
    // B's bill is covered by the credit it is about to take.
    settlements.set(b, { total: 40_000, paid: 40_000 });

    const gate = await owner.connect();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await gate.query("ROLLBACK");
      gate.release();
    };
    let recorded = false;
    let applying: Promise<unknown> = Promise.resolve();
    let recording: Promise<unknown> = Promise.resolve();
    try {
      // Stall the apply AFTER it took its advisory locks: it must write these
      // tables, SHARE mode blocks writers only, so its reads and locks pass.
      await gate.query("BEGIN");
      await gate.query(
        "LOCK TABLE reservation_customer_credit_uses, reservation_deposit_remainders IN SHARE MODE",
      );
      applying = applyCredit(d.profileId, b, 40_000);
      applying.catch(() => undefined);

      // Premise: the apply is stalled on a table lock while holding SHARE
      // advisory locks. Remember their keys.
      let applyKeys: string[] = [];
      await vi.waitFor(
        async () => {
          const { rows } = await owner.query<{ key: string }>(
            `SELECT l.classid::text || ':' || l.objid::text || ':' || l.objsubid::text AS key
               FROM pg_stat_activity a
               JOIN pg_locks l ON l.pid = a.pid
              WHERE a.datname = current_database()
                AND a.pid <> pg_backend_pid()
                AND a.wait_event_type = 'Lock' AND a.wait_event = 'relation'
                AND l.locktype = 'advisory' AND l.granted AND l.mode = 'ShareLock'`,
          );
          expect(
            rows.length,
            "the credit apply is stalled holding shared advisory locks",
          ).toBeGreaterThan(0);
          applyKeys = rows.map((r) => r.key);
        },
        { timeout: 10_000, interval: 100 },
      );

      recording = recordRefund(d, 30_000).then((outcome) => {
        recorded = true;
        return outcome;
      });
      recording.catch(() => undefined);

      // The recorder asks for an advisory lock EXCLUSIVE that the apply holds.
      await vi.waitFor(
        async () => {
          const { rows } = await owner.query<{ key: string }>(
            `SELECT classid::text || ':' || objid::text || ':' || objsubid::text AS key
               FROM pg_locks
              WHERE locktype = 'advisory' AND NOT granted AND mode = 'ExclusiveLock'`,
          );
          expect(
            rows.length,
            "the recorder waits for an exclusive advisory lock",
          ).toBeGreaterThan(0);
          expect(
            rows.some((r) => applyKeys.includes(r.key)),
            "it waits on the lock the apply holds shared (the deposit-intent lock)",
          ).toBe(true);
        },
        { timeout: 10_000, interval: 100 },
      );
      expect(recorded, "the recorder has not run yet").toBe(false);
      expect(await creditHoldsOf(d.intentId)).toEqual([]);
    } finally {
      await release();
      await Promise.allSettled([applying, recording]);
    }

    // After the apply committed the recorder ran and saw the used credit.
    await applying;
    await recording;
    expect(recorded).toBe(true);
    const holds = await creditHoldsOf(d.intentId);
    const credit = await effectiveCredit(b);
    // Net left = 100k - 30k - 60k = 10k. B took 40k: either the surplus is held
    // (30k) or B's credit is already cut to the net DP; never both missing.
    if (holds.length > 0) {
      expect(holds).toHaveLength(1);
      expect(holds[0]).toMatchObject({ amount: 30_000, resolvedAt: null });
    } else {
      expect(credit).toBeLessThanOrEqual(10_000);
    }
  }, 60_000);
});
