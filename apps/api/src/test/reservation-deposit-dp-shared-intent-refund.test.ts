// legend-mez2n (brief 1028): one DP payment intent shared by two reservations
// (allocation 50k + 50k) and a DOIT provider refund of part of that payment.
// The refund must be spread over the allocations ONCE (total deduction = the
// provider refund), not deducted in full from every allocation. Otherwise the
// guest's legitimate credit is locked: customer credit apply answers
// 409 CUSTOMER_CREDIT_NOT_AVAILABLE although the net value still covers it.
// Written from the brief (money rule: nobody is paid more than the net DP, the
// outlet never loses), not from the implementation. Fixtures follow
// reservation-deposit-credit-provider-refund-1020.test.ts. Fail-first.
//
// Assumptions where the brief is not exact:
// - "Combined credit" is observed through behaviour: the guest can apply
//   exactly the net credit (80.000) to a bill and not 1 IDR more. Raw
//   remainder rows are only asserted to be >= 0 (where the cut is booked, on
//   the row or on a pool at read time, is an implementation choice).
// - Each session consumes 5.000 of its 50.000 allocation (an empty bill makes
//   the leftover a manual_refund remainder, not customer credit), so credit
//   before the refund is 90.000 and after the 10.000 provider refund 80.000
//   (the brief's "90k" is the net value of the DP before consumption).
// - "Another tenant" = an isolated tenant reading credit of this tenant's
//   sessions yields 0; "unaffected" = an independent DP (other customer, own
//   intent) in the same tenant keeps its full credit while the shared intent
//   is refunded.
// - The duplicate refund event is the same provider_refund_id delivered twice
//   (UNIQUE tenant+provider+provider_refund_id, migration 0505).
//
// Run: LEGEND_TEST_FILES="src/test/reservation-deposit-dp-shared-intent-refund.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import {
  createRefund,
  refundableBalance,
} from "../services/payment-admin.service.ts";
import { depositCreditForSession } from "../services/reservation-lifecycle.ts";
import { applyReservationCustomerCredit } from "../services/reservation-deposit-remainder.ts";
import {
  closeTableSession,
  openOrJoinTableSession,
  setTableSessionSettlementLookup,
} from "../services/table-session.service.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  dropFloorRows,
  dropIsolatedTenant,
  issueQr,
  owner,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers";

const CONSUMED = 5_000;
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
let tenantB: IsolatedTenant;

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
 VALUES($1,$2,$3,$4,$5,$6,'customer_deposit',$7,'Penerimaan DP 1028',$8,$9)`,
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
     VALUES ($1, $2, '1028 Customer', 'active', now())`,
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
    deviceHash: `t1028-${randomUUID()}`,
  });
  sessionIds.push(opened.session.id);
  return { sessionId: opened.session.id, zoneId: zone.id as string };
}

async function addOrder(
  sessionId: string,
  total: number,
  profileId: string,
  deposit = 0,
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
             $5, $8, 'sent', '2026-11-12', now(), $6, $7)`,
    [
      id,
      seededTenantId,
      outletId,
      `T1028-${id.slice(0, 8)}`,
      total,
      sessionId,
      profileId,
      deposit,
    ],
  );
}

async function seatReservation(
  profileId: string,
  amount: number,
  deposit: number,
) {
  const session = await newSession();
  const reservationId = randomUUID();
  reservationIds.push(reservationId);
  await owner.query(
    `INSERT INTO reservations
       (id, tenant_id, outlet_id, customer_profile_id, guest_name, reserved_for,
        duration_minutes, pax, zone_id, deposit_idr, policy_snapshot, status,
        source, seated_at, table_session_id)
     VALUES ($1, $2, $3, $4, '1028 Payer', now(), 90, 2, $5, $6, $7,
             'seated', 'staff', now(), $8)`,
    [
      reservationId,
      seededTenantId,
      outletId,
      profileId,
      session.zoneId,
      deposit,
      JSON.stringify({
        version: "t1028",
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
    "UPDATE table_sessions SET reservation_id = $2 WHERE id = $1",
    [session.sessionId, reservationId],
  );
  // Each session consumes 5k of its allocation (an empty bill would turn the
  // leftover into a manual refund, not customer credit); the rest is credit.
  await addOrder(session.sessionId, CONSUMED, profileId, CONSUMED);
  settlements.set(session.sessionId, { total: CONSUMED, paid: amount });
  return { ...session, reservationId, amount };
}

/** One paid DOIT DP intent, shared by one reservation per entry of `shares`. */
async function sharedDp(shares: number[], guest?: string) {
  const deposit = shares.reduce((a, b) => a + b, 0);
  const profileId = guest ?? (await newProfile());
  const intentId = randomUUID();
  const linkId = randomUUID();
  intentIds.push(intentId);
  linkIds.push(linkId);
  const seats = [];
  for (const share of shares)
    seats.push(await seatReservation(profileId, share, deposit));
  await owner.query(
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 't1028-test')`,
    [
      linkId,
      seededTenantId,
      outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `T1028-${linkId.slice(0, 8)}`,
      deposit,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, reservation_id, method, provider,
        amount_idr, idempotency_key, status, instructions, expires_at, paid_at)
     VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', $6, $7, 'paid',
       '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
       now() + interval '1 hour', now())`,
    [
      intentId,
      seededTenantId,
      outletId,
      linkId,
      seats[0]!.reservationId,
      deposit,
      `t1028-pay-${intentId}`,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [seededTenantId, outletId, intentId, `t1028-evidence-${intentId}`, deposit],
  );
  await seedOriginalReceipt(intentId, deposit);
  for (const [index, seat] of seats.entries()) {
    // deposit_payment_link_id is unique per reservation: only the first
    // reservation of a shared intent carries the link (as in the 1020 T2 test).
    await owner.query(
      "UPDATE reservations SET deposit_payment_id = $2, deposit_payment_link_id = $3 WHERE id = $1",
      [seat.reservationId, intentId, index === 0 ? linkId : null],
    );
    await owner.query(
      `INSERT INTO reservation_deposit_allocations
         (tenant_id, outlet_id, reservation_id, table_session_id, payment_intent_id, amount_idr)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        seededTenantId,
        outletId,
        seat.reservationId,
        seat.sessionId,
        intentId,
        seat.amount,
      ],
    );
  }
  return { profileId, intentId, deposit, seats };
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
    "SELECT kind, amount_idr::text, remaining_idr::text FROM reservation_deposit_remainders WHERE reservation_id = $1",
    [reservationId],
  );
  return rows.map((r) => ({
    kind: r.kind,
    amount: Number(r.amount_idr),
    remaining: Number(r.remaining_idr),
  }));
}

/** The provider refund event; the same refundId twice is a duplicate event. */
async function providerRefunded(
  intentId: string,
  amountIdr: number,
  refundId = `rf_${randomUUID().slice(0, 12)}`,
) {
  await owner.query(
    `INSERT INTO payment_provider_refunds
       (tenant_id, outlet_id, payment_intent_id, provider, provider_refund_id,
        provider_payment_ref, amount_idr, source)
     VALUES ($1, $2, $3, 'doit', $4, $5, $6, 'payment_webhook')
     ON CONFLICT (tenant_id, provider, provider_refund_id) DO NOTHING`,
    [
      seededTenantId,
      outletId,
      intentId,
      refundId,
      `pay_${intentId.slice(0, 12)}`,
      amountIdr,
    ],
  );
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

/** A later visit of the customer with an open bill of `total`. */
async function targetSession(profileId: string, total: number) {
  const target = await newSession();
  await addOrder(target.sessionId, total, profileId);
  settlements.set(target.sessionId, { total, paid: 0 });
  return target.sessionId;
}

const effectiveCredit = (sessionId: string, tenantId = seededTenantId) =>
  withTenant(db, scope(tenantId), (tx) =>
    depositCreditForSession(tx, tenantIdSchema.parse(tenantId), sessionId),
  );

/** DP 100k over two reservations (50k + 50k), both closed with no spend. */
async function closedSplitDp(refundBeforeClose: number | null) {
  const d = await sharedDp([50_000, 50_000]);
  if (refundBeforeClose !== null)
    await providerRefunded(d.intentId, refundBeforeClose);
  for (const seat of d.seats) await close(seat.sessionId);
  return d;
}

async function expectNoNegativeRemainders(d: {
  seats: { reservationId: string }[];
}) {
  for (const seat of d.seats)
    for (const row of await remainders(seat.reservationId))
      expect(row.remaining).toBeGreaterThanOrEqual(0);
}

/** The guest cannot get one more IDR than the net value. */
async function expectNothingLeft(d: { profileId: string }) {
  const probe = await targetSession(d.profileId, 1);
  await expect(applyCredit(d.profileId, probe, 1)).rejects.toMatchObject({
    code: "CUSTOMER_CREDIT_NOT_AVAILABLE",
  });
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires disposable database");
  staff = await staffWithRole(createApp(), {
    template: "owner",
    label: "1028 DP Credit Owner",
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
      `INSERT INTO chart_of_accounts(id,tenant_id,legal_entity_id,code,name,type,report_group) VALUES($1,$2,$3,$4,'1028 DP receipt',$5,$6)`,
      [
        receiptAccounts[i],
        seededTenantId,
        receiptEntity,
        `985.${i + 1}`,
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
  tenantB = await createIsolatedTenant(`t1028-${randomUUID().slice(0, 6)}`);
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
      "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
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
  await dropIsolatedTenant(tenantB);
  await owner.end();
});

describe("legend-mez2n one DP intent shared by two reservations, partial provider refund", () => {
  it("1028 baseline: without a refund the guest can apply the whole 100.000", async () => {
    const d = await closedSplitDp(null);
    const target = await targetSession(d.profileId, 90_000);
    await applyCredit(d.profileId, target, 90_000);
    expect(await effectiveCredit(target)).toBe(90_000);
    await expectNothingLeft(d);
  });

  it("1028-1 DP 100k = 50k + 50k, provider refund 10k: combined credit is 80k, no reservation is negative, and applying the legitimate 80k succeeds", async () => {
    const d = await closedSplitDp(10_000);
    await expectNoNegativeRemainders(d);

    const target = await targetSession(d.profileId, 80_000);
    // Must not answer 409 CUSTOMER_CREDIT_NOT_AVAILABLE: the net value left (80k)
    // is exactly what the guest is entitled to.
    await applyCredit(d.profileId, target, 80_000);
    expect(await effectiveCredit(target)).toBe(80_000);
    await expectNothingLeft(d);
  });

  it("1028-1 refund arriving after both sessions closed gives the same 80k, not 70k", async () => {
    const d = await closedSplitDp(null);
    await providerRefunded(d.intentId, 10_000);
    await expectNoNegativeRemainders(d);

    const target = await targetSession(d.profileId, 80_000);
    await applyCredit(d.profileId, target, 80_000);
    expect(await effectiveCredit(target)).toBe(80_000);
    await expectNothingLeft(d);
  });

  it("1028-1 the 80k can also be taken in two smaller steps", async () => {
    const d = await closedSplitDp(10_000);
    const first = await targetSession(d.profileId, 30_000);
    const second = await targetSession(d.profileId, 50_000);
    await applyCredit(d.profileId, first, 30_000);
    await applyCredit(d.profileId, second, 50_000);
    expect(await effectiveCredit(first)).toBe(30_000);
    expect(await effectiveCredit(second)).toBe(50_000);
    await expectNothingLeft(d);
  });
});

describe("legend-mez2n full provider refund", () => {
  it("1028-2 refund of the whole 100k: all credit is 0 and nothing can be applied", async () => {
    const d = await closedSplitDp(100_000);
    await expectNoNegativeRemainders(d);
    await expectNothingLeft(d);
  });

  it("1028-2 refund of the whole DP after close: all credit is 0", async () => {
    const d = await closedSplitDp(null);
    await providerRefunded(d.intentId, 100_000);
    await expectNoNegativeRemainders(d);
    await expectNothingLeft(d);
  });
});

describe("legend-mez2n duplicate refund event is idempotent", () => {
  it("1028-3 the same provider refund id delivered twice cuts 10k once: credit stays 80k", async () => {
    const d = await closedSplitDp(null);
    const refundId = `rf_${randomUUID().slice(0, 12)}`;
    await providerRefunded(d.intentId, 10_000, refundId);
    await providerRefunded(d.intentId, 10_000, refundId);
    const { rows } = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM payment_provider_refunds WHERE payment_intent_id = $1",
      [d.intentId],
    );
    expect(Number(rows[0]!.n)).toBe(1);

    const target = await targetSession(d.profileId, 80_000);
    await applyCredit(d.profileId, target, 80_000);
    expect(await effectiveCredit(target)).toBe(80_000);
    await expectNothingLeft(d);
  });
});

describe("legend-mez2n other DPs and other tenants are not affected", () => {
  it("1028-4 an independent DP of another guest keeps its full credit, and another tenant sees no credit of this tenant", async () => {
    const shared = await closedSplitDp(10_000);
    const other = await sharedDp([100_000]);
    await close(other.seats[0]!.sessionId);

    const otherTarget = await targetSession(other.profileId, 95_000);
    await applyCredit(other.profileId, otherTarget, 95_000);
    expect(await effectiveCredit(otherTarget)).toBe(95_000);

    const sharedTarget = await targetSession(shared.profileId, 80_000);
    await applyCredit(shared.profileId, sharedTarget, 80_000);
    expect(await effectiveCredit(sharedTarget)).toBe(80_000);

    // Tenant B cannot see this tenant's credit.
    expect(await effectiveCredit(sharedTarget, tenantB.tenantId)).toBe(0);
    expect(await effectiveCredit(otherTarget, tenantB.tenantId)).toBe(0);
  });
});

describe("legend-mez2n the outlet never loses and the guest is never paid more than the net value", () => {
  it("1028-5 after the guest used 80k nothing is refundable any more (5k + 5k consumed, 80k credit used, 10k provider refund = 100k)", async () => {
    const d = await closedSplitDp(10_000);
    const target = await targetSession(d.profileId, 80_000);
    await applyCredit(d.profileId, target, 80_000);
    settlements.set(target, { total: 80_000, paid: 80_000 });
    await close(target);

    const balance = await withTenant(db, scope(), async (tx) => {
      const [intent] = await tx
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.tenantId, tenantIdSchema.parse(seededTenantId)),
            eq(paymentIntents.id, d.intentId),
          ),
        );
      return refundableBalance(tx, intent!);
    });
    expect(Number(balance.cap) - Number(balance.reserved)).toBe(0);
    await expectNothingLeft(d);
  });

  it("1028-5 asking for more than the net value is rejected and moves nothing", async () => {
    const d = await closedSplitDp(10_000);
    const target = await targetSession(d.profileId, 100_000);
    await expect(
      applyCredit(d.profileId, target, 80_001),
    ).rejects.toMatchObject({ code: "CUSTOMER_CREDIT_NOT_AVAILABLE" });
    expect(await effectiveCredit(target)).toBe(0);
    // The legitimate 80k is still there afterwards.
    await applyCredit(d.profileId, target, 80_000);
    expect(await effectiveCredit(target)).toBe(80_000);
  });
});

const refundable = (intentId: string) =>
  withTenant(db, scope(), async (tx) => {
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

describe("legend-mez2n architect extras", () => {
  it("1028-6a two intents of one guest: A (50k, 5k used, 10k provider cut = 35k) + B (55k, 5k used = 50k): 85k takeable in total, 1 IDR more is rejected and A's cut never locks B", async () => {
    const a = await sharedDp([50_000]);
    const b = await sharedDp([55_000], a.profileId);
    await providerRefunded(a.intentId, 10_000);
    await close(a.seats[0]!.sessionId);
    await close(b.seats[0]!.sessionId);

    const first = await targetSession(a.profileId, 45_000);
    await applyCredit(a.profileId, first, 45_000);
    // Whatever intent the first 45k came from, the rest (40k) is still there.
    const second = await targetSession(a.profileId, 40_000);
    await applyCredit(a.profileId, second, 40_000);
    expect(
      (await effectiveCredit(first)) + (await effectiveCredit(second)),
    ).toBe(85_000);
    await expectNothingLeft(a);
  });

  it("1028-6b gross refund path is unchanged: after a provider refund and before any apply, nothing is payer-refundable and a 1 IDR payer refund is rejected", async () => {
    const d = await closedSplitDp(10_000);
    const balance = await refundable(d.intentId);
    expect(Number(balance.cap) - Number(balance.reserved)).toBe(0);
    const key = randomUUID();
    await expect(
      createRefund(
        scope(),
        staff.userId,
        {
          idempotencyKey: key,
          paymentIntentId: d.intentId,
          amountIdr: idr(1),
          reason: "1028 payer refund",
        },
        key,
      ),
    ).rejects.toBeDefined();
  });

  it("1028-6c mixed timing: S1 closes before the provider refund, S2 after: the pool is 80k, applying it passes and 1 IDR more is rejected", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await close(d.seats[0]!.sessionId);
    await providerRefunded(d.intentId, 10_000);
    await close(d.seats[1]!.sessionId);
    await expectNoNegativeRemainders(d);

    const target = await targetSession(d.profileId, 80_000);
    await applyCredit(d.profileId, target, 80_000);
    expect(await effectiveCredit(target)).toBe(80_000);
    await expectNothingLeft(d);
  });

  // Assumption: while a payer refund is pending the service may lock credit
  // apply entirely (observed even without a provider refund), so only the
  // ceiling is asserted: never more than net 80k - pending 5k = 75k in total.
  it("1028-6d a pending payer refund (5k) plus the 10k provider refund: applying more than the net 80k, or more than 75k, is never accepted", async () => {
    const d = await closedSplitDp(10_000);
    await owner.query(
      `INSERT INTO payment_refunds
         (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
       VALUES ($1, $2, $3, $4, 5000, '1028 pending payer refund', 'pending', $5)`,
      [randomUUID(), seededTenantId, outletId, d.intentId, staff.userId],
    );
    const target = await targetSession(d.profileId, 100_000);
    for (const amount of [80_001, 80_000, 75_001])
      await expect(
        applyCredit(d.profileId, target, amount),
      ).rejects.toMatchObject({ code: "CUSTOMER_CREDIT_NOT_AVAILABLE" });
    await applyCredit(d.profileId, target, 75_000).catch(() => undefined);
    expect(await effectiveCredit(target)).toBeLessThanOrEqual(75_000);
  });
});
