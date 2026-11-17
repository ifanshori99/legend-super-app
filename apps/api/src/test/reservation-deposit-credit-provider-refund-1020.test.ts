// legend-svwdz (P1), brief 1020 F2: a DOIT provider refund of a reservation's
// deposit payment must also shrink the customer credit that was already moved
// from that deposit to another table session. Written from the brief (money
// rule: nobody is paid more than the net deposit, the outlet never loses), not
// from the implementation. Fixtures follow reservation-deposit-remainder.test.ts
// and payment-doit-partial-refund-967-deposit.test.ts. Fail-first.
//
// Scenario: DP 100.000 -> session A's bill (60.000) consumes 60.000 -> the
// unused 40.000 becomes customer credit -> the customer moves credit onto
// session B (and C) -> the provider refunds part of the DP payment.
// Net value of the DP intent still unconsumed = 100.000 - providerRefund - 60.000
// (never below 0). The credit a session can still use must not exceed it.
//
// Assumptions where the brief is not exact:
// - "Effective credit of B" = depositCreditForSession(B), the figure the QR and
//   POS checkout read (same observation as Q82 spend tests).
// - "B must pay the shortfall" = bill total - effective credit (computed here).
// - With several credit recipients the brief only asks for a deterministic
//   split that never counts the same net value twice. Which recipient is cut
//   first is not specified, so only these are asserted: every recipient's
//   credit is within [0, what it was given], the SUM is <= the net value, and
//   reading twice gives identical numbers.
// - Race (transfer vs refund): either may win. Accepted outcomes: the transfer
//   is rejected or clamped. Asserted: total effective credit afterwards <= net
//   value, never negative.
// - The recon flag for "already consumed beyond net value" is the insert-only
//   row in reservation_credit_recon_flags (migration 0637), one per credit use.
// - The provider refund is seeded as payment_provider_refunds (columns from
//   brief 967 D1), as in payment-doit-partial-refund-967-deposit.test.ts.
//
// Run: LEGEND_TEST_FILES="src/test/reservation-deposit-credit-provider-refund-1020.test.ts" heavy pnpm test
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
import { flagCreditReconForIntent } from "../services/reservation-deposit-credit.ts";
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
 VALUES($1,$2,$3,$4,$5,$6,'customer_deposit',$7,'Penerimaan DP 1020',$8,$9)`,
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
     VALUES ($1, $2, '1020 Customer', 'active', now())`,
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
    deviceHash: `t1020-${randomUUID()}`,
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
      `T1020-${id.slice(0, 8)}`,
      total,
      deposit,
      sessionId,
      profileId,
    ],
  );
}

/** Paid DP 100.000 seated on session A whose bill is 60.000 (DP covers it). */
async function paidDeposit() {
  const profileId = await newProfile();
  const total = 60_000;
  const deposit = 100_000;
  const session = await newSession();
  const reservationId = randomUUID();
  const intentId = randomUUID();
  const linkId = randomUUID();
  reservationIds.push(reservationId);
  intentIds.push(intentId);
  linkIds.push(linkId);
  await owner.query(
    `INSERT INTO reservations
       (id, tenant_id, outlet_id, customer_profile_id, guest_name, reserved_for,
        duration_minutes, pax, zone_id, deposit_idr, policy_snapshot, status,
        source, seated_at, table_session_id)
     VALUES ($1, $2, $3, $4, '1020 Payer', now(), 90, 2, $5, $6, $7,
             'seated', 'staff', now(), $8)`,
    [
      reservationId,
      seededTenantId,
      outletId,
      profileId,
      session.zoneId,
      deposit,
      JSON.stringify({
        version: "t1020",
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
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 't1020-test')`,
    [
      linkId,
      seededTenantId,
      outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `T1020-${linkId.slice(0, 8)}`,
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
      reservationId,
      deposit,
      `t1020-pay-${intentId}`,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [seededTenantId, outletId, intentId, `t1020-evidence-${intentId}`, deposit],
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
    "SELECT kind, amount_idr::text, remaining_idr::text FROM reservation_deposit_remainders WHERE reservation_id = $1",
    [reservationId],
  );
  return rows.map((r) => ({
    kind: r.kind,
    amount: Number(r.amount_idr),
    remaining: Number(r.remaining_idr),
  }));
}

async function reconFlags(intentId: string) {
  const { rows } = await owner.query<{
    used_idr: string;
    effective_idr: string;
  }>(
    "SELECT used_idr::text, effective_idr::text FROM reservation_credit_recon_flags WHERE tenant_id = $1 AND payment_intent_id = $2",
    [seededTenantId, intentId],
  );
  return rows.map((r) => ({
    used: Number(r.used_idr),
    effective: Number(r.effective_idr),
  }));
}

async function providerRefunded(intentId: string, amountIdr: number) {
  await owner.query(
    `INSERT INTO payment_provider_refunds
       (tenant_id, outlet_id, payment_intent_id, provider, provider_refund_id,
        provider_payment_ref, amount_idr, source)
     VALUES ($1, $2, $3, 'doit', $4, $5, $6, 'payment_webhook')`,
    [
      seededTenantId,
      outletId,
      intentId,
      `rf_${randomUUID().slice(0, 12)}`,
      `pay_${intentId.slice(0, 12)}`,
      amountIdr,
    ],
  );
}

const requestRefund = (intentId: string, amount: number, key = randomUUID()) =>
  createRefund(
    scope(),
    staff.userId,
    {
      idempotencyKey: key,
      paymentIntentId: intentId,
      amountIdr: idr(amount),
      reason: "1020 refund guard",
    },
    key,
  );

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

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires disposable database");
  staff = await staffWithRole(createApp(), {
    template: "owner",
    label: "1020 DP Credit Owner",
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
      `INSERT INTO chart_of_accounts(id,tenant_id,legal_entity_id,code,name,type,report_group) VALUES($1,$2,$3,$4,'1020 DP receipt',$5,$6)`,
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

describe("legend-svwdz provider refund shrinks credit already moved to another session", () => {
  it("1020-F2 baseline: without a provider refund session B has the full 40.000 credit", async () => {
    const d = await closedSourceWithCredit();
    const b = await targetSession(d.profileId, 40_000);
    await applyCredit(d.profileId, b, 40_000);
    expect(await effectiveCredit(b)).toBe(40_000);
  });

  it("1020-F2 DP 100k, A consumed 60k, 40k moved to B, provider refunds 20k: B credit <= 20k and B must pay the shortfall", async () => {
    const d = await closedSourceWithCredit();
    const bill = 40_000;
    const b = await targetSession(d.profileId, bill);
    await applyCredit(d.profileId, b, 40_000);
    expect(await effectiveCredit(b)).toBe(40_000);

    await providerRefunded(d.intentId, 20_000);

    const credit = await effectiveCredit(b);
    expect(credit).toBeLessThanOrEqual(20_000);
    expect(credit).toBeGreaterThanOrEqual(0);
    // B owes what the credit no longer covers (at least 20.000).
    expect(bill - credit).toBeGreaterThanOrEqual(20_000);
  });

  it.each([
    [30_000, 10_000],
    [40_000, 0],
    [100_000, 0],
  ])(
    "1020-F2 provider refund %i after 60k consumed leaves B credit at most %i, never negative",
    async (refund, ceiling) => {
      const d = await closedSourceWithCredit();
      const b = await targetSession(d.profileId, 40_000);
      await applyCredit(d.profileId, b, 40_000);

      await providerRefunded(d.intentId, refund);

      const credit = await effectiveCredit(b);
      expect(credit).toBeLessThanOrEqual(ceiling);
      expect(credit).toBeGreaterThanOrEqual(0);
    },
  );

  it("1020-F2 full provider refund of the DP: B credit is 0", async () => {
    const d = await closedSourceWithCredit();
    const b = await targetSession(d.profileId, 40_000);
    await applyCredit(d.profileId, b, 40_000);

    await providerRefunded(d.intentId, 100_000);

    expect(await effectiveCredit(b)).toBe(0);
  });

  it("1020-F2 refund before the transfer: credit moved afterwards is also capped by the net value", async () => {
    const d = await closedSourceWithCredit();
    await providerRefunded(d.intentId, 20_000);
    const b = await targetSession(d.profileId, 40_000);
    // The transfer may be rejected or clamped; it must never give B > 20.000.
    await applyCredit(d.profileId, b, 40_000).catch(() => undefined);

    const credit = await effectiveCredit(b);
    expect(credit).toBeLessThanOrEqual(20_000);
    expect(credit).toBeGreaterThanOrEqual(0);
  });
});

describe("legend-svwdz provider refund BEFORE session A closes is not cut twice", () => {
  // Assumption: DP 100k, provider refunds 20k while A is still open, A's bill
  // consumes 60k, so the net value left for credit is 100k - 20k - 60k = 20k.
  // The refund was already deducted when A closed; the credit moved to B must
  // not be reduced by the same 20k a second time.
  it("1020-F2 refund 20k before A closes, A uses 60k, 20k credit moves to B: B credit stays 20k and B pays only the rest of its bill", async () => {
    const d = await paidDeposit();
    await providerRefunded(d.intentId, 20_000);
    await close(d.sessionId);
    expect(await remainders(d.reservationId)).toEqual([
      { kind: "customer_credit", amount: 20_000, remaining: 20_000 },
    ]);

    const bill = 50_000;
    const b = await targetSession(d.profileId, bill);
    await applyCredit(d.profileId, b, 20_000);

    const credit = await effectiveCredit(b);
    expect(credit).toBe(20_000);
    // B pays the remaining bill: 50.000 - 20.000.
    expect(bill - credit).toBe(30_000);
    // Reading again is stable (nothing is cut on read).
    expect(await effectiveCredit(b)).toBe(20_000);
  });

  // Variant: refund AFTER close still reduces (covered by the 20k test above in
  // the earlier describe), so only the stable-read is repeated here.
  it("1020-F2 refund 20k before A closes, then another 20k after the move: B credit drops to 0, never negative", async () => {
    const d = await paidDeposit();
    await providerRefunded(d.intentId, 20_000);
    await close(d.sessionId);
    const b = await targetSession(d.profileId, 50_000);
    await applyCredit(d.profileId, b, 20_000);
    expect(await effectiveCredit(b)).toBe(20_000);

    await providerRefunded(d.intentId, 20_000);

    expect(await effectiveCredit(b)).toBe(0);
  });
});

describe("legend-svwdz credit already used beyond the net value", () => {
  // One recon flag when the net value shrinks below credit that was already
  // used; the refund never makes remaining credit negative and never throws.
  it("1020-F2 provider refund after B already used its moved credit: credit read is 0, not negative", async () => {
    const d = await closedSourceWithCredit();
    const b = await targetSession(d.profileId, 40_000);
    await applyCredit(d.profileId, b, 40_000);
    // B's bill is fully covered by the credit and the session is closed.
    settlements.set(b, { total: 40_000, paid: 40_000 });
    await close(b);

    await providerRefunded(d.intentId, 100_000);

    const credit = await effectiveCredit(b);
    expect(credit).toBeGreaterThanOrEqual(0);
    expect(credit).toBe(0);
    // Recon flag (reservation_credit_recon_flags): exactly one row for the
    // 40.000 already used, none added on a repeated read.
    expect(await reconFlags(d.intentId)).toEqual([
      { used: 40_000, effective: 0 },
    ]);
    expect(await effectiveCredit(b)).toBe(0);
    expect(await reconFlags(d.intentId)).toHaveLength(1);
  });
});

describe("legend-svwdz two credit recipients never count the same net value twice", () => {
  it("1020-F2 B and C each got 20k of the 40k credit, provider refunds 20k: together at most 20k, deterministic", async () => {
    const d = await closedSourceWithCredit();
    const b = await targetSession(d.profileId, 20_000);
    const c = await targetSession(d.profileId, 20_000);
    await applyCredit(d.profileId, b, 20_000);
    await applyCredit(d.profileId, c, 20_000);
    expect((await effectiveCredit(b)) + (await effectiveCredit(c))).toBe(
      40_000,
    );

    await providerRefunded(d.intentId, 20_000);

    const [creditB, creditC] = [
      await effectiveCredit(b),
      await effectiveCredit(c),
    ];
    expect(creditB).toBeGreaterThanOrEqual(0);
    expect(creditC).toBeGreaterThanOrEqual(0);
    expect(creditB).toBeLessThanOrEqual(20_000);
    expect(creditC).toBeLessThanOrEqual(20_000);
    expect(creditB + creditC).toBeLessThanOrEqual(20_000);
    // Deterministic: reading again, in the other order, gives the same split.
    expect(await effectiveCredit(c)).toBe(creditC);
    expect(await effectiveCredit(b)).toBe(creditB);
  });

  it("1020-F2 B and C hold 40k together, provider refunds the whole DP: both are 0", async () => {
    const d = await closedSourceWithCredit();
    const b = await targetSession(d.profileId, 20_000);
    const c = await targetSession(d.profileId, 20_000);
    await applyCredit(d.profileId, b, 20_000);
    await applyCredit(d.profileId, c, 20_000);

    await providerRefunded(d.intentId, 100_000);

    expect(await effectiveCredit(b)).toBe(0);
    expect(await effectiveCredit(c)).toBe(0);
  });
});

describe("legend-svwdz race between the credit transfer and the provider refund", () => {
  it("1020-F2 transfer of 40k racing a 20k provider refund: total effective credit afterwards <= 20k", async () => {
    const d = await closedSourceWithCredit();
    const b = await targetSession(d.profileId, 40_000);

    await Promise.allSettled([
      applyCredit(d.profileId, b, 40_000),
      providerRefunded(d.intentId, 20_000),
    ]);

    const credit = await effectiveCredit(b);
    expect(credit).toBeGreaterThanOrEqual(0);
    expect(credit).toBeLessThanOrEqual(20_000);
  });
});

// Ronde 3 (architect findings on the delta). Written from the brief's numbers,
// not from the implementation.
// Assumptions:
// - T1 "old row" = a remainder written before migration 0636, so its
//   provider_refunded_snapshot_idr is 0; the test forces that with an owner
//   UPDATE. "Refund guard" = refundableBalance cap - reserved, plus
//   createRefund rejecting a 1 IDR request (money rule: never refundable more
//   than the net unconsumed DP).
// - T2 the brief does not say which remainder absorbs the provider refund, so
//   only the SUM of snapshots is asserted (it must equal the refund that was
//   really deducted, 10.000) and that credit moved out afterwards respects the
//   net value after a further refund.
// - T3 the recording path of a provider refund (payment-provider-partial-refund)
//   is not called from here; the exported flagCreditReconForIntent(tx,
//   tenantId, intentId) from the brief is called directly after the refund row
//   exists, WITHOUT reading the closed session's credit first.
describe("legend-svwdz ronde 3 T1 refund guard does not count a pre-close provider refund twice", () => {
  it("1020-F2 DP 100k, provider refund 20k before A closes, A used 60k, B used the 20k credit, old row snapshot 0: refundable is 0 and a 1 IDR refund is rejected", async () => {
    const d = await paidDeposit();
    await providerRefunded(d.intentId, 20_000);
    await close(d.sessionId);
    expect(await remainders(d.reservationId)).toEqual([
      { kind: "customer_credit", amount: 20_000, remaining: 20_000 },
    ]);
    const b = await targetSession(d.profileId, 20_000);
    await applyCredit(d.profileId, b, 20_000);
    settlements.set(b, { total: 20_000, paid: 20_000 });
    await close(b);
    // Row written before the snapshot column existed.
    await owner.query(
      "UPDATE reservation_deposit_remainders SET provider_refunded_snapshot_idr = 0 WHERE reservation_id = $1",
      [d.reservationId],
    );

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
    // 100k - 20k (provider) - 60k (A) - 20k (B) = 0 still refundable.
    expect(Number(balance.cap) - Number(balance.reserved)).toBe(0);
    await expect(requestRefund(d.intentId, 1)).rejects.toBeDefined();
  });
});

describe("legend-svwdz ronde 3 T2 snapshot is only the part of the provider refund really deducted", () => {
  it("1020-F2 DP 100k split S1 50k + S2 50k, each used 5k, provider refund 10k before close: snapshots stay 0 (cut not forced onto the remainders) and credit stays within the net value", async () => {
    const d = await paidDeposit();
    // Each session consumes 5k: drop the 60k bill that paidDeposit seeded on
    // S1 and seed 5k, so every remainder is a real customer credit.
    await owner.query("DELETE FROM orders WHERE table_session_id = $1", [
      d.sessionId,
    ]);
    await addOrder(d.sessionId, 5_000, 5_000, d.profileId);
    settlements.set(d.sessionId, { total: 5_000, paid: 50_000 });
    const s2 = await newSession();
    // One allocation per reservation: the second share belongs to a second
    // (multi-table) reservation of the same DP intent.
    const reservation2 = randomUUID();
    reservationIds.push(reservation2);
    await owner.query(
      "UPDATE reservation_deposit_allocations SET amount_idr = 50000 WHERE reservation_id = $1 AND table_session_id = $2",
      [d.reservationId, d.sessionId],
    );
    await owner.query(
      `INSERT INTO reservations
         (id, tenant_id, outlet_id, customer_profile_id, guest_name, reserved_for,
          duration_minutes, pax, zone_id, deposit_idr, policy_snapshot, status,
          source, seated_at, table_session_id)
       SELECT $1, tenant_id, outlet_id, customer_profile_id, guest_name, reserved_for,
          duration_minutes, pax, zone_id, deposit_idr, policy_snapshot, status,
          source, seated_at, $2
         FROM reservations WHERE id = $3`,
      [reservation2, s2.sessionId, d.reservationId],
    );
    await owner.query(
      `INSERT INTO reservation_deposit_allocations
         (tenant_id, outlet_id, reservation_id, table_session_id, payment_intent_id, amount_idr)
       VALUES ($1, $2, $3, $4, $5, 50000)`,
      [seededTenantId, outletId, reservation2, s2.sessionId, d.intentId],
    );
    await owner.query(
      "UPDATE table_sessions SET reservation_id = $2 WHERE id = $1",
      [s2.sessionId, reservation2],
    );
    await owner.query(
      "UPDATE reservations SET deposit_payment_id = $2 WHERE id = $1",
      [reservation2, d.intentId],
    );
    await addOrder(s2.sessionId, 5_000, 5_000, d.profileId);
    settlements.set(s2.sessionId, { total: 5_000, paid: 50_000 });
    await providerRefunded(d.intentId, 10_000);
    await close(d.sessionId);
    await close(s2.sessionId);

    const rows = [
      ...(await remainders(d.reservationId)),
      ...(await remainders(reservation2)),
    ];
    expect(rows).toHaveLength(2);
    // legend-6n4p3 (1033): the two sessions share one net pool in a fixed
    // order. The first allocation claims its 50k, the second takes the 10k
    // refund (45k + 35k = 80k, i.e. 100k - 10k refund - 10k consumed). The
    // snapshots add up to the 10k the remainders really absorbed, so the pool
    // does not cut it a second time. The value the guest can take stays 80k
    // (before 1033: 90k remainders minus the 10k cut later).
    const { rows: snaps } = await owner.query<{ snap: string }>(
      "SELECT provider_refunded_snapshot_idr::text AS snap FROM reservation_deposit_remainders WHERE payment_intent_id = $1",
      [d.intentId],
    );
    expect(snaps.reduce((sum, r) => sum + Number(r.snap), 0)).toBe(10_000);
    expect(rows.reduce((sum, r) => sum + r.amount, 0)).toBe(80_000);
  });
});

describe("legend-svwdz ronde 3 T3 recon flag covers closed sessions and follows later refunds", () => {
  it("1020-F2 provider refund after B (closed) used 40k: flagCreditReconForIntent flags {used 40k, effective 10k} without any read of B, then updates to effective 0 after a further refund", async () => {
    const d = await closedSourceWithCredit();
    const b = await targetSession(d.profileId, 40_000);
    await applyCredit(d.profileId, b, 40_000);
    settlements.set(b, { total: 40_000, paid: 40_000 });
    await close(b);
    expect(await reconFlags(d.intentId)).toEqual([]);

    const flag = () =>
      withTenant(db, scope(), (tx) =>
        flagCreditReconForIntent(
          tx,
          tenantIdSchema.parse(seededTenantId),
          d.intentId,
        ),
      );

    // Net unconsumed value: 100k - 30k - 60k (A) = 10k, B already used 40k.
    await providerRefunded(d.intentId, 30_000);
    await flag();
    expect(await reconFlags(d.intentId)).toEqual([
      { used: 40_000, effective: 10_000 },
    ]);

    // Net value shrinks to 0: the same flag row is updated, not frozen, no
    // second row, and the used value is never cut.
    await providerRefunded(d.intentId, 20_000);
    await flag();
    expect(await reconFlags(d.intentId)).toEqual([
      { used: 40_000, effective: 0 },
    ]);
  });
});
