import { randomBytes, randomUUID } from "node:crypto";

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

const ADMIN = "/api/payments/admin";
const DP = 100_000;
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
 VALUES($1,$2,$3,$4,$5,$6,'customer_deposit',$7,'Penerimaan DP 1072-a2',$8,$9)`,
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
     VALUES ($1, $2, '1072-a2 Customer', 'active', now())`,
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
    deviceHash: `t1072a2-${randomUUID()}`,
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
      `T1072A2-${id.slice(0, 8)}`,
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
 * consumed part of it (the leftover becomes transferable customer credit).
 */
async function paidDeposit(billTotal: number, applied: number) {
  const profileId = await newProfile();
  const session = await newSession();
  const reservationId = randomUUID();
  const intentId = randomUUID();
  const linkId = randomUUID();
  const providerRef = `t1072a2-main-${intentId}`;
  reservationIds.push(reservationId);
  intentIds.push(intentId);
  linkIds.push(linkId);
  await owner.query(
    `INSERT INTO reservations
       (id, tenant_id, outlet_id, customer_profile_id, guest_name, reserved_for,
        duration_minutes, pax, zone_id, deposit_idr, policy_snapshot, status,
        source, seated_at, table_session_id)
     VALUES ($1, $2, $3, $4, '1072-a2 Payer', now(), 90, 2, $5, $6, $7,
             'seated', 'staff', now(), $8)`,
    [
      reservationId,
      seededTenantId,
      outletId,
      profileId,
      session.zoneId,
      DP,
      JSON.stringify({
        version: "t1072a2",
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
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 't1072a2-test')`,
    [
      linkId,
      seededTenantId,
      outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `T1072A2-${linkId.slice(0, 8)}`,
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
      `t1072a2-pay-${intentId}`,
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

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires disposable database");
  staff = await staffWithRole(app, {
    template: "owner",
    label: "1072-a2 DP Hold Owner",
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
      `INSERT INTO chart_of_accounts(id,tenant_id,legal_entity_id,code,name,type,report_group) VALUES($1,$2,$3,$4,'1072-a2 DP receipt',$5,$6)`,
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

const POOL_CONSUMED = 20_000;
const POOL_CREDIT = DP - POOL_CONSUMED; // 80.000 transferable customer credit
const POOL_SPEND = 40_000; // an amount the pool would cover without R and the hold

/** DP 100k, the session consumed 20k and closed: 80k transferable credit (R 40k is added later). */
async function closedPoolWithCredit() {
  const d = await paidDeposit(POOL_CONSUMED, POOL_CONSUMED);
  await close(d.sessionId);
  expect(await remainders(d.reservationId), "premise: 80k credit").toEqual([
    { kind: "customer_credit", amount: POOL_CREDIT, remaining: POOL_CREDIT },
  ]);
  return d;
}

// --- the 1072-a2 world ------------------------------------------------------------

const R_IDR = 40_000;

async function mainEvidenceId(d: Deposit) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2 AND provider_ref = $3",
    [seededTenantId, d.intentId, d.providerRef],
  );
  return rows[0]!.id;
}

/**
 * End state of "R sent without a ref, fact booked with force, R completed with
 * ref X": our refund R of 40.000 (completed, ref X) of the intent's main
 * transaction T, plus the provider fact X/T of 40.000 (R's echo).
 */
async function withOwnRefundAndEchoFact(d: Deposit, amountIdr: number = R_IDR) {
  const x = newRefundId();
  await owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, completed_at, provider_ref, payout_attempts)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian dana 1072-a2', 'completed',
             'requester', 'approver', now(), now(), $6, 1)`,
    [randomUUID(), seededTenantId, outletId, d.intentId, amountIdr, x],
  );
  await seedFact(d, d.providerRef, x, amountIdr, await mainEvidenceId(d));
  return x;
}

/** The report X/T of 100.000 has been filed: ONE open conflict hold, fact unchanged. */
async function expectOneOpenConflictHold(
  d: Deposit,
  x: string,
  label: string,
  factIdr: number = R_IDR,
) {
  const open = (await conflictHolds(d.intentId)).filter((h) => h.open);
  expect(
    open,
    `${label}: one open conflict hold (holds: ${JSON.stringify(await holdsOf(d.intentId))})`,
  ).toHaveLength(1);
  expect(open[0]).toMatchObject({
    amount: DP,
    refundId: x,
    paymentRef: d.providerRef,
  });
  expect(
    await factRows(d.intentId),
    `${label}: the small fact is unchanged`,
  ).toEqual([[x, d.providerRef, factIdr]]);
  return open[0]!;
}

describe("1072-a2: a small echo fact must not hide an open conflict hold from the DP credit", () => {
  it("1072-a2-01 control + premise: R 40.000/X + echo fact X/T 40.000 read credit 60.000; the report X/T 100.000 files ONE open conflict hold of 100.000 and the fact row is unchanged", async () => {
    const d = await openSessionDeposit();
    expect(
      await effectiveCredit(d.sessionId),
      "premise: before R the open session reads the whole DP",
    ).toBe(DP);
    const x = await withOwnRefundAndEchoFact(d);
    expect(
      await effectiveCredit(d.sessionId),
      "premise: R and its echo fact count once: DP - R",
    ).toBe(DP - R_IDR);
    await reportOnMain(d, x);
    await expectOneOpenConflictHold(d, x, "a2-01");
  });

  it("1072-a2-02 open session: while the conflict hold is open the credit a new order applies is not 60.000 (<= DP - hold = 0); reading never closes the hold", async () => {
    const d = await openSessionDeposit();
    const x = await withOwnRefundAndEchoFact(d);
    await reportOnMain(d, x);
    const hold = await expectOneOpenConflictHold(d, x, "a2-02");
    const credit = await effectiveCredit(d.sessionId);
    expect(
      credit,
      `the open conflict hold (${hold.amount}) must take its amount off the DP, the session still reads ${credit}`,
    ).toBeLessThanOrEqual(DP - hold.amount);
    expect(
      (await conflictHolds(d.intentId))[0]!.open,
      "reading credit never closes the hold",
    ).toBe(true);
  });

  it("1072-a2-03 transferred pool: with the conflict hold open the customer credit of the closed session is not spendable and nothing is consumed", async () => {
    const d = await closedPoolWithCredit();
    const x = await withOwnRefundAndEchoFact(d);
    await reportOnMain(d, x);
    await expectOneOpenConflictHold(d, x, "a2-03");

    const target = await targetSession(d.profileId, POOL_SPEND);
    // Net after the hold: 100.000 - 20.000 consumed - 40.000 R - 100.000 hold = 0.
    await expect(
      applyCredit(d.profileId, target, POOL_SPEND),
      "spending the transferred credit is refused",
    ).rejects.toMatchObject({ code: "CUSTOMER_CREDIT_NOT_AVAILABLE" });
    expect(
      await remainders(d.reservationId),
      "the customer credit is untouched",
    ).toEqual([
      { kind: "customer_credit", amount: POOL_CREDIT, remaining: POOL_CREDIT },
    ]);
  });

  it("1072-a2-04 replays of the same report open no second hold, change no fact and do not release credit (open session and pool)", async () => {
    const d = await openSessionDeposit();
    const x = await withOwnRefundAndEchoFact(d);
    await reportOnMain(d, x);
    await expectOneOpenConflictHold(d, x, "a2-04 first report");
    for (let round = 0; round < 3; round += 1) await reportOnMain(d, x);
    const hold = await expectOneOpenConflictHold(d, x, "a2-04 after replays");
    expect(
      (await conflictHolds(d.intentId)).length,
      "no second hold row at all",
    ).toBe(1);
    expect(
      await effectiveCredit(d.sessionId),
      "replays do not give the credit back",
    ).toBeLessThanOrEqual(DP - hold.amount);

    const pool = await closedPoolWithCredit();
    const px = await withOwnRefundAndEchoFact(pool);
    await reportOnMain(pool, px);
    for (let round = 0; round < 2; round += 1) await reportOnMain(pool, px);
    await expectOneOpenConflictHold(pool, px, "a2-04 pool after replays");
    const target = await targetSession(pool.profileId, POOL_SPEND);
    await expect(
      applyCredit(pool.profileId, target, POOL_SPEND),
      "replays do not make the pool spendable",
    ).rejects.toMatchObject({ code: "CUSTOMER_CREDIT_NOT_AVAILABLE" });
  });

  it("1072-a2-05 resolve not_this_intent (HTTP) restores the credit exactly once: open session reads DP - R again (not more), a second resolve changes nothing", async () => {
    const d = await openSessionDeposit();
    const x = await withOwnRefundAndEchoFact(d);
    await reportOnMain(d, x);
    const hold = await expectOneOpenConflictHold(d, x, "a2-05");
    expect(
      await effectiveCredit(d.sessionId),
      "premise: the open hold limits the credit first",
    ).toBeLessThanOrEqual(DP - hold.amount);

    const resolved = await resolveNotThisIntent(hold.id);
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(
      (await holdsOf(d.intentId)).find((h) => h.id === hold.id),
    ).toMatchObject({ open: false, resolution: "not_this_intent" });
    expect(
      await effectiveCredit(d.sessionId),
      "the credit is back: DP - R, exactly once",
    ).toBe(DP - R_IDR);

    const again = await resolveHttp(hold.id, "not_this_intent");
    expect(again.status, "a closed hold is not resolved twice").not.toBe(500);
    expect(await effectiveCredit(d.sessionId), "not restored twice").toBe(
      DP - R_IDR,
    );
    expect(
      (await conflictHolds(d.intentId)).filter((h) => h.open),
      "no open conflict hold is left",
    ).toEqual([]);
    expect(await factRows(d.intentId), "the resolve books no fact").toEqual([
      [x, d.providerRef, R_IDR],
    ]);
  });
});

// --- F-T (brief "Fix architect akhir"): hold-vs-apply barriers + no double count ---
//
// Assumptions (the brief does not fix them):
//  - Pool premise: DP 100.000, session consumed 20.000 and closed (80.000 customer
//    credit). With R 40.000 + echo fact 40.000 (the a2-03 world) the pool credit is
//    not spendable at all even without any hold (probed: even 10.000 was refused:
//    the echo seems to be subtracted on top of R there). A provider fact WITHOUT a
//    refund of ours files no conflict hold on a bigger report (probed). So the pool
//    here has R 10.000 + echo fact X/T 10.000: the credit net stays >= 60.000, so
//    POOL_SPEND (40.000) is spendable until the report X/T 100.000 (bigger than the
//    fact) files the conflict hold.
//  - Both lock orders use the barrier of 1063-b (a table lock stalls one party after
//    it took its advisory locks; the other party is released only when it waits on
//    the same lock or has finished). No sleep decides pass or fail.
//  - End state accepted in BOTH orders: either the apply won (40.000 spent before the
//    hold existed) or it was refused CUSTOMER_CREDIT_NOT_AVAILABLE with the credit
//    untouched; never a partial spend. After both, one open conflict hold of 100.000
//    exists, the fact row is unchanged and nothing more can be spent.
//  - Control: a live-own style hold (open, ref X, transaction T, 40.000) next to a
//    NON-echo provider fact X/T 40.000 (no refund of ours) is "represented" by the
//    fact: the DP credit loses 40.000 once, not 80.000.

const POOL_FACT = 10_000;

/** R 10.000 (completed, ref X) + its echo fact X/T 10.000: smaller than the later report. */
const withSmallFact = (d: Deposit) => withOwnRefundAndEchoFact(d, POOL_FACT);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Runs `body` while `start()` is stalled after it took its advisory locks. */
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

/** After both parties finished: no partial spend, one open conflict hold, nothing more spendable. */
async function expectPoolEndState(
  d: Deposit,
  applyOutcome: PromiseSettledResult<unknown>,
  x: string,
  label: string,
) {
  const remaining = (await remainders(d.reservationId)).reduce(
    (sum, row) => sum + row.remaining,
    0,
  );
  if (applyOutcome.status === "fulfilled") {
    expect(
      remaining,
      `${label}: the apply won, exactly ${POOL_SPEND} was spent`,
    ).toBe(POOL_CREDIT - POOL_SPEND);
  } else {
    expect(
      applyOutcome.reason,
      `${label}: a refused apply is CUSTOMER_CREDIT_NOT_AVAILABLE`,
    ).toMatchObject({ code: "CUSTOMER_CREDIT_NOT_AVAILABLE" });
    expect(remaining, `${label}: a refused apply spends nothing`).toBe(
      POOL_CREDIT,
    );
  }
  await expectOneOpenConflictHold(d, x, label, POOL_FACT);
  const probe = await targetSession(d.profileId, 1_000);
  await expect(
    applyCredit(d.profileId, probe, 1_000),
    `${label}: with the conflict hold open nothing more is spendable`,
  ).rejects.toMatchObject({ code: "CUSTOMER_CREDIT_NOT_AVAILABLE" });
}

describe("1072-a2 F-T: conflict hold vs credit apply, both lock orders", () => {
  // 1072-a2-06 (order 1, credit apply first, stalled) is dropped on purpose: the
  // barrier cannot be built. With our refund R plus the echo fact present, the pool
  // refuses `applyCredit` (CUSTOMER_CREDIT_NOT_AVAILABLE) before it takes any lock,
  // so there is no stalled apply to hold the report behind. Order 2 (a2-07) and the
  // end-state checks stay.
  it("1072-a2-07 order 2, hold insert first (stalled): an apply that comes while the hold is being filed waits or is refused; end state is a whole spend or nothing, one open conflict hold, nothing more spendable", async () => {
    const d = await closedPoolWithCredit();
    const x = await withSmallFact(d);
    const target = await targetSession(d.profileId, POOL_SPEND);
    const stalled = await whileStalled(
      "refund_recon_holds",
      () => reportOnMain(d, x),
      async ({ keys }) => {
        const applying = track(applyCredit(d.profileId, target, POOL_SPEND));
        await waitsOrFinishes(keys, () => applying.state.done);
        return applying;
      },
    );
    const outcome = (await Promise.allSettled([stalled.tracked]))[0]!;
    await reportOnMain(d, x);
    await expectPoolEndState(d, outcome, x, "a2-07");
  }, 60_000);

  it("1072-a2-08 control: an open live-own style hold X/T 40.000 next to a NON-echo provider fact X/T 40.000 (no refund of ours) subtracts 40.000 once: the open session reads DP - 40.000, not DP - 80.000", async () => {
    const d = await openSessionDeposit();
    const x = newRefundId();
    await seedFact(d, d.providerRef, x, 40_000, await mainEvidenceId(d));
    await owner.query(
      `INSERT INTO refund_recon_holds
         (id, tenant_id, payment_intent_id, webhook_event_id, provider_refund_id, provider_refund_id_kind, provider_payment_ref, amount_idr, reason)
       VALUES ($1, $2, $3, $4, $5, 'provider', $6, 40000, 'The payment is refunded while a refund of ours ran')`,
      [
        randomUUID(),
        seededTenantId,
        d.intentId,
        randomUUID(),
        x,
        d.providerRef,
      ],
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
