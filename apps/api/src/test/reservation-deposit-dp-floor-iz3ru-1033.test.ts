// legend-iz3ru (brief 1033): the spent-DP FLOOR of an allocation must subtract
// only the OTHER allocations of the same session whose intent was really paid.
// Written from the bug description, not from the implementation. Fixtures are
// copied from reservation-deposit-dp-pool-1033.test.ts (1033-8 two-DP session).
//
// Assumptions:
// - Credit is observed through depositCreditForSession (what a bill reads) and,
//   after the table closes, through bisection (`takeable`, unit 1.000 IDR).
// - iz3ru-1/5: intent X (200k) is shared by T (allocation 100k, earlier) and S
//   (allocation 100k). S also holds allocation Z (100k) on a second intent that
//   is pending/failed/expired (no paid_at, no evidence, no receipt: never
//   received, so never spendable). Provider refunds 40k of X (net X 160k). T and
//   S each spend 100k (5k base + 95k extra). T's claim on the pool of X leaves
//   net - claim = 60k for S, but S already spent 100k, so the spent FLOOR must
//   decide: S reads 100k (floor = spent, without subtracting the unpaid Z).
//   Spent DP is never taken back, so spent + refund passes X (unavoidable,
//   already accepted by 1033-7/8): the total read credit only stays <= 200k and
//   nothing more is takeable after both close.
// - iz3ru-2/3/4 use S with allocations A (paid 100k) + B on a second intent.
//
// Run: LEGEND_TEST_FILES="src/test/reservation-deposit-dp-floor-iz3ru-1033.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
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
 VALUES($1,$2,$3,$4,$5,$6,'customer_deposit',$7,'Penerimaan DP 1033',$8,$9)`,
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
     VALUES ($1, $2, '1033 Customer', 'active', now())`,
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
    deviceHash: `t1033-${randomUUID()}`,
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
      `T1033-${id.slice(0, 8)}`,
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
     VALUES ($1, $2, $3, $4, '1033 Payer', now(), 90, 2, $5, $6, $7,
             'seated', 'staff', now(), $8)`,
    [
      reservationId,
      seededTenantId,
      outletId,
      profileId,
      session.zoneId,
      deposit,
      JSON.stringify({
        version: "t1033",
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
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 't1033-test')`,
    [
      linkId,
      seededTenantId,
      outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `T1033-${linkId.slice(0, 8)}`,
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
      `t1033-pay-${intentId}`,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [seededTenantId, outletId, intentId, `t1033-evidence-${intentId}`, deposit],
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
     ON CONFLICT (tenant_id, provider, refund_id_kind, provider_refund_id) DO NOTHING`,
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
    label: "1033 DP Credit Owner",
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
      `INSERT INTO chart_of_accounts(id,tenant_id,legal_entity_id,code,name,type,report_group) VALUES($1,$2,$3,$4,'1033 DP receipt',$5,$6)`,
      [
        receiptAccounts[i],
        seededTenantId,
        receiptEntity,
        `987.${i + 1}`,
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
  tenantB = await createIsolatedTenant(`t1033-${randomUUID().slice(0, 6)}`);
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
      "DELETE FROM refund_recon_holds WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
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

const UNIT = 1_000;

/**
 * Total credit the guest can still take over all closed sessions of the DPs
 * they own, found by bisection. Every success really applies credit, a
 * rejection moves nothing. Ends with a 1 IDR probe: nothing is left.
 */
async function takeable(d: { profileId: string; deposit: number }) {
  let total = 0;
  let lo = 0;
  let hi = Math.ceil(d.deposit / UNIT);
  let target: string | null = null;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    target ??= await targetSession(d.profileId, d.deposit);
    try {
      await applyCredit(d.profileId, target, mid * UNIT);
      total += mid * UNIT;
      target = null;
      lo = 0;
      hi -= mid;
    } catch (error) {
      if ((error as { code?: string }).code !== "CUSTOMER_CREDIT_NOT_AVAILABLE")
        throw error;
      hi = mid - 1;
    }
  }
  await expectNothingLeft(d);
  return total;
}

type Dp = Awaited<ReturnType<typeof sharedDp>>;

const SPENT = 50_000;

/** Session 2 pays a 50k bill fully from the DP (before any provider refund). */
async function payFromDp(d: Dp, seat: number, amount = SPENT) {
  const s = d.seats[seat]!;
  await addOrder(s.sessionId, amount, d.profileId, amount);
  // Bill (base 5k + extra) is fully settled by the deposit, so the table can close.
  settlements.set(s.sessionId, {
    total: CONSUMED + amount,
    paid: CONSUMED + amount,
  });
}

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

type OtherStatus = "pending" | "failed" | "expired" | "paid";

/** A second intent B of `amount` allocated to an existing session. */
async function addIntentOnSession(
  profileId: string,
  seat: { sessionId: string; reservationId: string },
  amount: number,
  status: OtherStatus,
) {
  const paid = status === "paid";
  const reservationId = randomUUID();
  reservationIds.push(reservationId);
  await owner.query(
    `INSERT INTO reservations
       (id, tenant_id, outlet_id, customer_profile_id, guest_name, reserved_for,
        duration_minutes, pax, zone_id, deposit_idr, policy_snapshot, status,
        source, seated_at, table_session_id)
     SELECT $1, tenant_id, outlet_id, customer_profile_id, guest_name, reserved_for,
        duration_minutes, pax, zone_id, $4, policy_snapshot, status,
        source, seated_at, $2
       FROM reservations WHERE id = $3`,
    [reservationId, seat.sessionId, seat.reservationId, amount],
  );
  const intentId = randomUUID();
  const linkId = randomUUID();
  intentIds.push(intentId);
  linkIds.push(linkId);
  await owner.query(
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 't1033-test')`,
    [
      linkId,
      seededTenantId,
      outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `T1033-${linkId.slice(0, 8)}`,
      amount,
      paid ? amount : 0,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, reservation_id, method, provider,
        amount_idr, idempotency_key, status, instructions, expires_at, paid_at)
     VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', $6, $7, $8,
       '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
       now() + interval '1 hour', ${paid ? "now()" : "NULL"})`,
    [
      intentId,
      seededTenantId,
      outletId,
      linkId,
      reservationId,
      amount,
      `t1033-b-${intentId}`,
      status,
    ],
  );
  if (paid) await payIntent(intentId, amount);
  await owner.query(
    "UPDATE reservations SET deposit_payment_id = $2, deposit_payment_link_id = $3 WHERE id = $1",
    [reservationId, intentId, linkId],
  );
  await owner.query(
    `INSERT INTO reservation_deposit_allocations
       (tenant_id, outlet_id, reservation_id, table_session_id, payment_intent_id, amount_idr)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [seededTenantId, outletId, reservationId, seat.sessionId, intentId, amount],
  );
  return { intentId, linkId, reservationId };
}

/** The payment of B arrives later (provider confirms it). */
async function payIntent(intentId: string, amount: number) {
  await owner.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [seededTenantId, outletId, intentId, `t1033-evidence-${intentId}`, amount],
  );
  await seedOriginalReceipt(intentId, amount);
}

async function markPaidLater(b: { intentId: string; linkId: string }) {
  await owner.query(
    "UPDATE payment_intents SET status = 'paid', paid_at = now() WHERE id = $1",
    [b.intentId],
  );
  await owner.query(
    "UPDATE payment_links SET paid_idr = total_idr WHERE id = $1",
    [b.linkId],
  );
  await payIntent(b.intentId, 100_000);
}

const DP = 100_000;
const SPENT_TOTAL = CONSUMED + 75_000; // 80k incl. the 5k base bill
const OVER_REFUND = 40_000;

/** S: allocation A (paid 100k) + allocation B; S spends 80k of DP. */
async function twoAllocations(status: OtherStatus, refund = OVER_REFUND) {
  const a = await sharedDp([DP]);
  const b = await addIntentOnSession(a.profileId, a.seats[0]!, DP, status);
  await payFromDp(a, 0, 75_000);
  if (refund > 0) await providerRefunded(a.intentId, refund);
  return { a, b, sessionId: a.seats[0]!.sessionId };
}

/** X 200k shared by T (earlier) and S; S also holds Z; both spend 100k; X refunded 40k. */
async function sharedXWithUnpaidZ(status: OtherStatus) {
  const x = await sharedDp([DP, DP]);
  const z = await addIntentOnSession(x.profileId, x.seats[1]!, DP, status);
  await payFromDp(x, 0, 95_000);
  await payFromDp(x, 1, 95_000);
  await providerRefunded(x.intentId, OVER_REFUND);
  return {
    x,
    z,
    sessionT: x.seats[0]!.sessionId,
    sessionS: x.seats[1]!.sessionId,
  };
}

describe("legend-iz3ru floor ignores the DP of an intent that was never paid", () => {
  for (const status of ["pending", "failed", "expired"] as const) {
    it(`iz3ru-1 Z of a ${status} intent: S spent 100k from shared X, T claims first, S credit reads 100k`, async () => {
      const { sessionS, sessionT } = await sharedXWithUnpaidZ(status);
      const creditS = await effectiveCredit(sessionS);
      const creditT = await effectiveCredit(sessionT);
      expect(
        creditS,
        `S credit read ${creditS}: below the DP S really spent (Z ${status} was never received)`,
      ).toBe(100_000);
      expect(
        creditS + creditT,
        "credits of S + T pass the DP of X that was received",
      ).toBeLessThanOrEqual(2 * DP);
    });

    it(`iz3ru-1 Z of a ${status} intent: after both close nothing more is takeable, no negative remainder`, async () => {
      const { x, sessionS, sessionT } = await sharedXWithUnpaidZ(status);
      await close(sessionT);
      await close(sessionS);
      await expectNoNegativeRemainders(x);
      const total = await takeable(x);
      expect(total, "guest takes DP that is already spent (outlet loss)").toBe(
        0,
      );
    });
  }

  it("iz3ru-2 control: B really paid (two real DPs) is never counted on both: nobody is paid more, outlet does not lose", async () => {
    const { a, sessionId } = await twoAllocations("paid");
    const credit = await effectiveCredit(sessionId);
    // Value in play: A 100k + B 100k - refund 40k = 160k; S spent 80k.
    expect(
      credit,
      "credit above what the 160k net pool allows",
    ).toBeLessThanOrEqual(2 * DP - OVER_REFUND);
    expect(credit, "credit read below what S spent").toBeGreaterThanOrEqual(
      SPENT_TOTAL,
    );
    await close(sessionId);
    await expectNoNegativeRemainders(a);
    const total = await takeable(a);
    expect(
      SPENT_TOTAL + total + OVER_REFUND,
      "spent + takeable + refund pass the DP received",
    ).toBeLessThanOrEqual(2 * DP);
  });

  it("iz3ru-3 money rule: credit + refund never pass the paid DP when the refund fits what S did not spend", async () => {
    // A 100k paid, B pending. S spends 50k (5k + 45k), A refunded 40k: net 60k.
    const a = await sharedDp([DP]);
    await addIntentOnSession(a.profileId, a.seats[0]!, DP, "pending");
    await payFromDp(a, 0, 45_000);
    await providerRefunded(a.intentId, OVER_REFUND);
    const credit = await effectiveCredit(a.seats[0]!.sessionId);
    expect(credit, "credit below what S spent").toBeGreaterThanOrEqual(50_000);
    expect(
      credit + OVER_REFUND,
      "credit + refund pass the DP",
    ).toBeLessThanOrEqual(DP);
    await close(a.seats[0]!.sessionId);
    await expectNoNegativeRemainders(a);
    const total = await takeable(a);
    expect(50_000 + total + OVER_REFUND).toBeLessThanOrEqual(DP);
  });

  it("iz3ru-4 another tenant reads no credit of these sessions", async () => {
    const { sessionId } = await twoAllocations("pending");
    expect(await effectiveCredit(sessionId, tenantB.tenantId)).toBe(0);
  });

  it("iz3ru-5 Z pending then paid later: S credit never swells past what the DPs allow", async () => {
    const { x, z, sessionS, sessionT } = await sharedXWithUnpaidZ("pending");
    expect(await effectiveCredit(sessionS)).toBe(100_000);
    await markPaidLater(z);
    // Value: X 200k + Z 100k - refund 40k = 260k; T spent 100k, S spent 100k.
    const after = await effectiveCredit(sessionS);
    expect(after, "S credit fell below what S spent").toBeGreaterThanOrEqual(
      100_000,
    );
    expect(
      after,
      "S credit passes net of both DPs less what T spent",
    ).toBeLessThanOrEqual(3 * DP - OVER_REFUND - 100_000);
    await close(sessionT);
    await close(sessionS);
    await expectNoNegativeRemainders(x);
    const total = await takeable(x);
    expect(
      2 * DP + total + OVER_REFUND,
      "spent + takeable + refund pass the DP received",
    ).toBeLessThanOrEqual(3 * DP);
  });
});
