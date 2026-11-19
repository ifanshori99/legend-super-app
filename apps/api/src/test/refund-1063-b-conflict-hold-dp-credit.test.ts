// (brief 1063, F2 = legend-awdwd, P1, money "jangan sampai rugi"): fail-first
// tests, written from docs/briefs/1063-shared-context.md, the second-opinion
// report ronde 5 (finding 2) and the 1033 / 1055-a / xmtih fixtures, not from
// the implementation.
//
// Scenario (finding 2): the intent's MAIN transaction T2 paid the DP of
// Rp100.000 that is allocated to a session. An EXTRA payment T1 of Rp100.000 of
// the same intent is fully parked (payment_unallocated_funds, double_payment).
// The provider refund X of T1 (Rp100.000) is already a fact. The signed report
// X/T2 (Rp100.000) arrives: X is booked on another transaction, so a
// HOLD_TRANSACTION_CONFLICT hold is filed on T2 (round 4, G2). The hold stays
// OPEN until finance decides, and the restrictive rule (CTO) says: while in
// doubt, the open hold still takes its amount off the DP pool. Today the hold
// is "represented" by fact X/T1 (same refund id) and is dropped from the
// subtraction although the fact belongs to a parked transaction that never
// funded the DP, so the guest can still spend the whole Rp100.000.
//
//  - awdwd-1 control + premise: the conflict hold is filed, open, on T2.
//  - awdwd-2 the credit an OPEN session reads (what a new order applies) is
//    not Rp100.000 while the hold is open.
//  - awdwd-3 the transferred pool (customer credit of a closed session) is not
//    spendable: the apply is refused, nothing is consumed.
//  - awdwd-4 resolve `not_this_intent` (real HTTP route) gives the credit back
//    exactly once (open session read and transferred pool; a second resolve and
//    a second spend change nothing).
//  - awdwd-5 control: a hold whose providerPaymentRef is the SAME as the fact's
//    is still excluded (represented by its fact): no double subtraction.
//  - awdwd-6/7 barriers, both lock orders (credit apply first, hold first).
//
// Assumptions (the brief does not fix them):
//  - "A new order is not closed with that DP" is observed through the credit
//    read an order uses (depositCreditForSession: a POS order applies
//    min(credit - already used, total)). Driving a whole POS order needs a menu,
//    tax and cashier fixture, out of proportion; the read is the contract.
//  - The conflict hold is filed through the recorder (recordProviderRefundInTx,
//    id door, provider kind) as the 1033-xmtih / 1025c-B tests do, with the fact
//    X/T1 seeded directly. T1's evidence row and its fully parked fund are
//    seeded like 1055-a `addParkedExtra`.
//  - Hold amount = the reported amount (Rp100.000). Net DP after it is
//    max(0, DP - consumed - hold) = 0 for the transferred pool (DP 100.000,
//    consumed 60.000, credit 40.000).
//  - Barrier tests (as xmtih): no sleep decides pass/fail. What the fix does
//    about credit already applied when the hold lands is not pinned: afterwards
//    either the guest can spend nothing above the net, or a
//    credit_used_before_provider_refund hold names the surplus.
//  - Error codes are read from body.error.code (409 / 422 not asserted for the
//    second resolve: only "not 200 or idempotent with no change").
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1063-b-conflict-hold-dp-credit.test.ts" heavy pnpm test

import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idr, outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { closeTableSessionInputSchema } from "@starter/shared/qr-order";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { recordProviderRefundInTx } from "../services/payment-provider-partial-refund.ts";
import { depositCreditForSession } from "../services/reservation-lifecycle.ts";
import { applyReservationCustomerCredit } from "../services/reservation-deposit-remainder.ts";
import {
  closeTableSession,
  openOrJoinTableSession,
  setTableSessionSettlementLookup,
} from "../services/table-session.service.ts";
import { originHeader, verifySessionMfa } from "./helpers";
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

const CREDIT_HOLD = "credit_used_before_provider_refund";
const ADMIN = "/api/payments/admin";
const DP = 100_000;
const CONSUMED = 60_000;
const outletId = outletIdSchema.parse(seededOutletA);
const scope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
const app = createApp();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newRefundId = () => `rf_${randomBytes(6).toString("hex")}`;

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
let mfaDone = false;
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
 VALUES($1,$2,$3,$4,$5,$6,'customer_deposit',$7,'Penerimaan DP 1063-b',$8,$9)`,
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
}

async function newProfile() {
  const id = randomUUID();
  profileIds.push(id);
  await owner.query(
    `INSERT INTO customer_profiles
       (id, tenant_id, name, membership_status, whatsapp_verified_at)
     VALUES ($1, $2, '1063-b Customer', 'active', now())`,
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
    deviceHash: `t1063b-${randomUUID()}`,
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
      `T1063B-${id.slice(0, 8)}`,
      total,
      deposit,
      sessionId,
      profileId,
    ],
  );
}

type Deposit = Awaited<ReturnType<typeof paidDeposit>>;

/**
 * Main transaction T2: a paid DOIT DP of 100.000 (the intent's own provider
 * ref) allocated in full to one session. `billTotal`/`applied` describe the
 * session's bill: an OPEN session with a bill that still takes the whole DP
 * (`billTotal` 150.000, nothing applied), or a session about to close having
 * consumed 60.000 (the leftover 40.000 becomes transferable customer credit).
 */
async function paidDeposit(billTotal: number, applied: number) {
  const profileId = await newProfile();
  const session = await newSession();
  const reservationId = randomUUID();
  const intentId = randomUUID();
  const linkId = randomUUID();
  const providerRef = `t1063b-main-${intentId}`;
  reservationIds.push(reservationId);
  intentIds.push(intentId);
  linkIds.push(linkId);
  await owner.query(
    `INSERT INTO reservations
       (id, tenant_id, outlet_id, customer_profile_id, guest_name, reserved_for,
        duration_minutes, pax, zone_id, deposit_idr, policy_snapshot, status,
        source, seated_at, table_session_id)
     VALUES ($1, $2, $3, $4, '1063-b Payer', now(), 90, 2, $5, $6, $7,
             'seated', 'staff', now(), $8)`,
    [
      reservationId,
      seededTenantId,
      outletId,
      profileId,
      session.zoneId,
      DP,
      JSON.stringify({
        version: "t1063b",
        depositRequirement: "required",
        depositAmountIdr: DP,
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
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 't1063b-test')`,
    [
      linkId,
      seededTenantId,
      outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `T1063B-${linkId.slice(0, 8)}`,
      DP,
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
      DP,
      `t1063b-pay-${intentId}`,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [seededTenantId, outletId, intentId, providerRef, DP],
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
    [seededTenantId, outletId, reservationId, session.sessionId, intentId, DP],
  );
  await addOrder(session.sessionId, billTotal, applied, profileId);
  settlements.set(session.sessionId, { total: billTotal, paid: DP });
  await seedOriginalReceipt(intentId, DP);
  return { ...session, reservationId, intentId, profileId, providerRef };
}

/** Open session whose bill (150.000) still takes the whole DP. */
const openSessionDeposit = () => paidDeposit(150_000, 0);
/** Session with a bill of 60.000 that the DP covers; closing leaves 40.000 credit. */
const closingDeposit = () => paidDeposit(CONSUMED, CONSUMED);

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

/** DP 100k, the session consumed 60k and closed: 40k transferable credit. */
async function closedSourceWithCredit() {
  const d = await closingDeposit();
  await close(d.sessionId);
  expect(await remainders(d.reservationId), "premise: 40k credit").toEqual([
    { kind: "customer_credit", amount: 40_000, remaining: 40_000 },
  ]);
  return d;
}

const applyCredit = (profileId: string, sessionId: string, amount: number) =>
  applyReservationCustomerCredit(
    scope(),
    staff.userId,
    outletId,
    {
      customerProfileId: profileId,
      tableSessionId: sessionId,
      amountIdr: idr(amount),
    },
    randomUUID(),
  );

/** A second visit of the same customer with an open bill of `total`. */
async function targetSession(profileId: string, total: number) {
  const target = await newSession();
  await addOrder(target.sessionId, total, 0, profileId);
  settlements.set(target.sessionId, { total, paid: total });
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

// --- the cross-transaction scenario -------------------------------------------

type Extra = { providerRef: string; evidenceId: string };

/** T1: an extra payment of the intent, parked in full as an unallocated fund. */
async function addParkedExtra(d: Deposit): Promise<Extra> {
  const providerRef = `t1063b-extra-${randomBytes(8).toString("hex")}`;
  const evidence = await owner.query<{ id: string }>(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())
     RETURNING id`,
    [seededTenantId, outletId, d.intentId, providerRef, DP],
  );
  const evidenceId = evidence.rows[0]!.id;
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'double_payment')`,
    [randomUUID(), seededTenantId, outletId, d.intentId, evidenceId, DP],
  );
  return { providerRef, evidenceId };
}

/** The provider refund fact: refund id `refundId` of the payment `paymentRef`. */
async function seedFact(
  d: Deposit,
  paymentRef: string,
  refundId: string,
  amountIdr: number,
  evidenceId: string | null,
) {
  // The recorder links a fact to the evidence row of the transaction it
  // refunds (evidence_id); without that link the fact is "unattributable".
  await owner.query(
    `INSERT INTO payment_provider_refunds
       (tenant_id, outlet_id, payment_intent_id, evidence_id, provider, provider_refund_id,
        provider_payment_ref, amount_idr, source)
     VALUES ($1, $2, $3, $4, 'doit', $5, $6, $7, 'payment_webhook')`,
    [
      seededTenantId,
      outletId,
      d.intentId,
      evidenceId,
      refundId,
      paymentRef,
      amountIdr,
    ],
  );
}

/** Fact X/T1 (parked extra payment) of the full 100.000 is booked. */
async function withFactOnParkedExtra(d: Deposit) {
  const extra = await addParkedExtra(d);
  const x = newRefundId();
  await seedFact(d, extra.providerRef, x, DP, extra.evidenceId);
  return { extra, x };
}

/** The signed report X/T2 reaches the recorder (id door, provider kind). */
function reportOnMain(d: Deposit, x: string, amountIdr: number = DP) {
  const context = scope();
  return withTenant(db, context, (tx) =>
    recordProviderRefundInTx(
      tx,
      context,
      {
        provider: "doit",
        providerRefundId: x,
        refundIdKind: "provider",
        providerPaymentRef: d.providerRef,
        amountIdr,
        source: "payment_webhook",
        expectedIntentId: d.intentId,
        force: true,
      },
      new Date(),
    ),
  );
}

type Hold = {
  id: string;
  amount: number;
  reason: string;
  open: boolean;
  resolution: string | null;
  refundId: string | null;
  paymentRef: string | null;
};

async function holdsOf(intentId: string): Promise<Hold[]> {
  const { rows } = await owner.query<{
    id: string;
    amount_idr: string;
    reason: string;
    resolved_at: Date | null;
    resolution: string | null;
    provider_refund_id: string | null;
    provider_payment_ref: string | null;
  }>(
    `SELECT id, amount_idr::text, reason, resolved_at, resolution, provider_refund_id, provider_payment_ref
       FROM refund_recon_holds
      WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY flagged_at, id`,
    [seededTenantId, intentId],
  );
  return rows.map((r) => ({
    id: r.id,
    amount: Number(r.amount_idr),
    reason: r.reason,
    open: r.resolved_at === null,
    resolution: r.resolution,
    refundId: r.provider_refund_id,
    paymentRef: r.provider_payment_ref,
  }));
}

const conflictHolds = async (intentId: string) =>
  (await holdsOf(intentId)).filter((h) =>
    /HOLD_TRANSACTION_CONFLICT/i.test(h.reason),
  );
const creditHolds = async (intentId: string) =>
  (await holdsOf(intentId)).filter((h) => h.reason.startsWith(CREDIT_HOLD));

async function factRows(intentId: string) {
  const { rows } = await owner.query<{
    provider_refund_id: string;
    provider_payment_ref: string;
    amount_idr: string;
  }>(
    `SELECT provider_refund_id, provider_payment_ref, amount_idr::text
       FROM payment_provider_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY created_at, id`,
    [seededTenantId, intentId],
  );
  return rows.map((r) => [
    r.provider_refund_id,
    r.provider_payment_ref,
    Number(r.amount_idr),
  ]);
}

/** Premise shared by the scenarios: the conflict hold is filed and open on T2. */
async function expectOpenConflictHold(
  d: Deposit,
  x: string,
  extra: Extra,
  facts: unknown,
) {
  const holds = await conflictHolds(d.intentId);
  expect(
    holds,
    `premise: one open conflict hold for X on T2 (holds: ${JSON.stringify(await holdsOf(d.intentId))})`,
  ).toHaveLength(1);
  expect(holds[0]).toMatchObject({
    open: true,
    refundId: x,
    paymentRef: d.providerRef,
    amount: DP,
  });
  expect(
    await factRows(d.intentId),
    "T1's fact is unchanged and T2 has no fact",
  ).toEqual(facts);
  expect(extra.providerRef).not.toBe(d.providerRef);
  return holds[0]!;
}

function resolveHttp(
  holdId: string,
  resolution: "not_this_intent" | "counted_against_intent",
) {
  return staff.client
    .post(`${ADMIN}/refund-recon-holds/${holdId}/resolve`)
    .set(originHeader)
    .send({
      idempotencyKey: `hold-${randomUUID()}`,
      resolution,
      note: "Dicocokkan dengan mutasi bank provider",
    });
}

async function resolveNotThisIntent(holdId: string) {
  if (!mfaDone) {
    await verifySessionMfa(staff.email);
    mfaDone = true;
  }
  return resolveHttp(holdId, "not_this_intent");
}

// --- barrier --------------------------------------------------------------------

type Stall = { keys: string[]; applying: Promise<unknown> };

async function advisoryKeysOfWaiters(): Promise<string[]> {
  const { rows } = await owner.query<{ key: string }>(
    `SELECT l.classid::text || ':' || l.objid::text || ':' || l.objsubid::text AS key
       FROM pg_stat_activity a
       JOIN pg_locks l ON l.pid = a.pid
      WHERE a.datname = current_database()
        AND a.pid <> pg_backend_pid()
        AND a.wait_event_type = 'Lock' AND a.wait_event = 'relation'
        AND l.locktype = 'advisory' AND l.granted`,
  );
  return rows.map((r) => r.key);
}

/**
 * Runs `body` while `start()` is stalled after it took its advisory locks:
 * `tables` are locked IN SHARE MODE from the owner side, which blocks only the
 * writes of the stalled transaction (its reads and locks pass). The stall is
 * released afterwards, always, and the stalled work awaited.
 */
async function whileStalled<T, S>(
  tables: string,
  start: () => Promise<S>,
  body: (stall: Stall) => Promise<T>,
): Promise<T> {
  const gate = await owner.connect();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await gate.query("ROLLBACK");
    gate.release();
  };
  let running: Promise<unknown> = Promise.resolve();
  try {
    await gate.query("BEGIN");
    await gate.query(`LOCK TABLE ${tables} IN SHARE MODE`);
    running = start();
    running.catch(() => undefined);
    let keys: string[] = [];
    const deadline = Date.now() + 15_000;
    while (keys.length === 0) {
      if (Date.now() > deadline)
        throw new Error("premise: the work never stalled holding locks");
      keys = await advisoryKeysOfWaiters();
      if (keys.length === 0) await sleep(50);
    }
    return await body({ keys, applying: running });
  } finally {
    await release();
    await Promise.allSettled([running]);
  }
}

async function queuedOn(keys: string[]) {
  const { rows } = await owner.query<{ key: string }>(
    `SELECT classid::text || ':' || objid::text || ':' || objsubid::text AS key
       FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
  );
  return rows.some((r) => keys.includes(r.key));
}

/** Resolves once the other party queues on the stalled keys or has finished. */
async function waitsOrFinishes(keys: string[], finished: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (finished()) return "finished" as const;
    if (await queuedOn(keys)) return "waiting" as const;
    await sleep(50);
  }
  throw new Error("neither queued on the lock nor finished");
}

function track<T>(p: Promise<T>) {
  const state = { done: false };
  const tracked = p.then(
    (v) => {
      state.done = true;
      return v;
    },
    (e) => {
      state.done = true;
      throw e;
    },
  );
  tracked.catch(() => undefined);
  return { state, tracked };
}

async function asTenantTx<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
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

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires disposable database");
  staff = await staffWithRole(app, {
    template: "owner",
    label: "1063-b DP Hold Owner",
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
      `INSERT INTO chart_of_accounts(id,tenant_id,legal_entity_id,code,name,type,report_group) VALUES($1,$2,$3,$4,'1063-b DP receipt',$5,$6)`,
      [
        receiptAccounts[i],
        seededTenantId,
        receiptEntity,
        `993.${i + 1}`,
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
      "DELETE FROM journal_lines WHERE entry_id=ANY($1::uuid[])",
      [receiptEntries],
    );
    await client.query("DELETE FROM journal_entries WHERE id=ANY($1::uuid[])", [
      receiptEntries,
    ]);
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
    for (const table of [
      "payment_refunds",
      "refund_recon_holds",
      "payment_provider_refunds",
      "payment_unallocated_funds",
      "payment_evidence",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE payment_intent_id = ANY($1::uuid[])`,
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
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds }).catch(
    () => undefined,
  );
});

describe("legend-awdwd F2: a conflict hold on the main transaction keeps limiting the DP credit", () => {
  it("awdwd-1 control + premise: fact X/T1 on the fully parked extra payment, the report X/T2 files ONE open HOLD_TRANSACTION_CONFLICT hold on T2; T1's fact is unchanged, T2 has no fact", async () => {
    const d = await openSessionDeposit();
    expect(
      await effectiveCredit(d.sessionId),
      "premise: before any report the open session reads the whole DP",
    ).toBe(DP);
    const { extra, x } = await withFactOnParkedExtra(d);
    expect(
      await effectiveCredit(d.sessionId),
      "premise: the fact of a fully parked transaction alone does not touch the DP",
    ).toBe(DP);
    await reportOnMain(d, x);
    await expectOpenConflictHold(d, x, extra, [[x, extra.providerRef, DP]]);
  });

  it("awdwd-2 open session: while the conflict hold is open the session credit (what a new order applies) is not the 100.000 of the DP", async () => {
    const d = await openSessionDeposit();
    const { extra, x } = await withFactOnParkedExtra(d);
    await reportOnMain(d, x);
    const hold = await expectOpenConflictHold(d, x, extra, [
      [x, extra.providerRef, DP],
    ]);
    const credit = await effectiveCredit(d.sessionId);
    // The restrictive rule: in doubt, the hold takes its 100.000 off the DP
    // (100.000 - 100.000 = 0). Anything above that lets a new order be settled
    // with money that may already be back with the guest.
    expect(
      credit,
      `the open conflict hold (${hold.amount}) must take its amount off the DP credit, the session still reads ${credit}`,
    ).toBeLessThanOrEqual(DP - hold.amount);
    expect(
      (await conflictHolds(d.intentId))[0]!.open,
      "reading credit never closes the hold",
    ).toBe(true);
  });

  it("awdwd-3 transferred pool: with the conflict hold open the 40.000 customer credit of the closed session is not spendable and nothing is consumed", async () => {
    const d = await closedSourceWithCredit();
    const { extra, x } = await withFactOnParkedExtra(d);
    await reportOnMain(d, x);
    await expectOpenConflictHold(d, x, extra, [[x, extra.providerRef, DP]]);

    const target = await targetSession(d.profileId, 40_000);
    // Net after the hold: 100.000 - 60.000 consumed - 100.000 hold = 0.
    await expect(
      applyCredit(d.profileId, target, 40_000),
      "spending the transferred credit is refused",
    ).rejects.toMatchObject({ code: "CUSTOMER_CREDIT_NOT_AVAILABLE" });
    expect(
      await remainders(d.reservationId),
      "the customer credit is untouched",
    ).toEqual([{ kind: "customer_credit", amount: 40_000, remaining: 40_000 }]);
  });

  it("awdwd-4 resolve not_this_intent gives the credit back EXACTLY once: open session reads 100.000 again (not more), a second resolve changes nothing", async () => {
    const d = await openSessionDeposit();
    const { extra, x } = await withFactOnParkedExtra(d);
    await reportOnMain(d, x);
    const hold = await expectOpenConflictHold(d, x, extra, [
      [x, extra.providerRef, DP],
    ]);
    expect(
      await effectiveCredit(d.sessionId),
      "premise: the open hold limits the credit first",
    ).toBeLessThanOrEqual(DP - hold.amount);

    const resolved = await resolveNotThisIntent(hold.id);
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const after = (await holdsOf(d.intentId)).find((h) => h.id === hold.id)!;
    expect(after).toMatchObject({ open: false, resolution: "not_this_intent" });
    expect(
      await effectiveCredit(d.sessionId),
      "the credit is back, exactly the DP",
    ).toBe(DP);

    const again = await resolveHttp(hold.id, "not_this_intent");
    expect(again.status, "a closed hold is not resolved twice").not.toBe(500);
    expect(await effectiveCredit(d.sessionId), "not restored twice").toBe(DP);
    expect(
      (await conflictHolds(d.intentId)).filter((h) => h.open),
      "no open conflict hold is left",
    ).toEqual([]);
    expect(await factRows(d.intentId), "the resolve books no fact").toEqual([
      [x, extra.providerRef, DP],
    ]);
  });

  it("awdwd-4b resolve not_this_intent on the transferred pool: the 40.000 is spendable exactly once, then nothing is left", async () => {
    const d = await closedSourceWithCredit();
    const { extra, x } = await withFactOnParkedExtra(d);
    await reportOnMain(d, x);
    const hold = await expectOpenConflictHold(d, x, extra, [
      [x, extra.providerRef, DP],
    ]);
    const blocked = await targetSession(d.profileId, 40_000);
    await expect(
      applyCredit(d.profileId, blocked, 40_000),
      "premise: the open hold refuses the spend first",
    ).rejects.toMatchObject({ code: "CUSTOMER_CREDIT_NOT_AVAILABLE" });

    const resolved = await resolveNotThisIntent(hold.id);
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const target = await targetSession(d.profileId, 40_000);
    await applyCredit(d.profileId, target, 40_000);
    const probe = await targetSession(d.profileId, 1);
    await expect(
      applyCredit(d.profileId, probe, 1),
      "the credit was restored once, not twice",
    ).rejects.toMatchObject({ code: "CUSTOMER_CREDIT_NOT_AVAILABLE" });
  });

  it("awdwd-5 control: an open hold with the SAME providerPaymentRef as its fact stays excluded (no double subtraction): fact X/T2 40.000 + hold X/T2 40.000 reads 60.000, not 20.000", async () => {
    const d = await openSessionDeposit();
    const x = newRefundId();
    const main = await owner.query<{ id: string }>(
      "SELECT id FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2 AND provider_ref = $3",
      [seededTenantId, d.intentId, d.providerRef],
    );
    await seedFact(d, d.providerRef, x, 40_000, main.rows[0]!.id);
    await asTenantTx((client) =>
      client.query(
        `INSERT INTO refund_recon_holds
           (id, tenant_id, payment_intent_id, webhook_event_id, provider_refund_id, provider_refund_id_kind, provider_payment_ref, amount_idr, reason)
         VALUES ($1, $2, $3, $4, $5, 'provider', $6, 40000, 'Reference names another intent')`,
        [
          randomUUID(),
          seededTenantId,
          d.intentId,
          randomUUID(),
          x,
          d.providerRef,
        ],
      ),
    );
    expect(
      (await holdsOf(d.intentId)).filter((h) => h.open),
      "premise: the hold is open",
    ).toHaveLength(1);
    expect(
      await effectiveCredit(d.sessionId),
      "the 40.000 is subtracted once (by the fact), not twice",
    ).toBe(DP - 40_000);
  });
});

describe("legend-awdwd F2 barriers: hold insert and credit use, both lock orders", () => {
  /** After both finished: nothing above the net can be spent, or the surplus is named. */
  async function expectNoOverspend(d: Deposit, target: string) {
    const openHold = (await conflictHolds(d.intentId))
      .filter((h) => h.open)
      .reduce((s, h) => s + h.amount, 0);
    expect(openHold, "premise: the conflict hold exists and is open").toBe(DP);
    const net = Math.max(0, DP - CONSUMED - openHold);
    const spendable = await effectiveCredit(target);
    const trace = (await creditHolds(d.intentId)).filter((h) => h.open);
    expect(
      spendable <= net || trace.length > 0,
      `the guest can spend ${spendable} of a net of ${net} and no ${CREDIT_HOLD} hold names the surplus`,
    ).toBe(true);
    for (const h of trace) expect(h.amount).toBeLessThanOrEqual(40_000);
  }

  it("awdwd-6 order 1, credit apply first: the hold waits (or the surplus is named) and the guest never keeps 40.000 above the net", async () => {
    const d = await closedSourceWithCredit();
    const { x } = await withFactOnParkedExtra(d);
    const target = await targetSession(d.profileId, 40_000);
    const hold = await whileStalled(
      "reservation_customer_credit_uses, reservation_deposit_remainders",
      () => applyCredit(d.profileId, target, 40_000),
      async ({ keys }) => {
        const filing = track(reportOnMain(d, x));
        await waitsOrFinishes(keys, () => filing.state.done);
        return filing;
      },
    );
    await hold.tracked;
    await expectNoOverspend(d, target);
  }, 60_000);

  it("awdwd-7 order 2, hold insert first: a credit apply that comes while the hold is being filed waits (or the surplus is named) and the guest never keeps 40.000 above the net", async () => {
    const d = await closedSourceWithCredit();
    const { x } = await withFactOnParkedExtra(d);
    const target = await targetSession(d.profileId, 40_000);
    const apply = await whileStalled(
      "refund_recon_holds",
      () => reportOnMain(d, x),
      async ({ keys }) => {
        const applying = track(applyCredit(d.profileId, target, 40_000));
        await waitsOrFinishes(keys, () => applying.state.done);
        return applying;
      },
    );
    await Promise.allSettled([apply.tracked]);
    await expectNoOverspend(d, target);
  }, 60_000);
});
