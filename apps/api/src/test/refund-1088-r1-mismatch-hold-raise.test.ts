// (brief 1090 "Keputusan CTO", SO refund ronde 9 finding 1 = refund 1088 R1, P1, tier K
// "jangan sampai rugi"): red-first tests, written from
// docs/qa/second-opinion-refund-ronde9-1088.md (finding 1), docs/briefs/1072-invarian.md
// (I3/I10(b)) and the pattern of refund-1077-r2-mismatch-unreadable-amount.test.ts,
// not from the implementation.
//
// Rule under test (CTO decision): an OPEN REFERENCE_MISMATCH hold of a report keyed to
// our refund R1 but naming a refund Y of payment T2 (another intent) is RAISED to
// greatest(old, new) when a later report with the same identity (same key, same Y,
// same T2) computes a larger amount, and it is never lowered. Today the later report
// hits the unique key of the open hold and returns: the hold stays small.
//
// Scenario (SO): T1 Rp100.000 with R1 Rp30.000 completed (ref X1). T2 is another paid
// payment of Rp100.000 (never refunded). Signed refund.succeeded keyed `refund:<R1>`,
// refund id Y, payment_id T2:
//   1. readable amount 30000        -> one open hold on T2 worth Rp30.000;
//   2. the same key/Y/T2 again with an unreadable amount ('80000.0', text, missing)
//      -> the hold is raised to the whole payment, Rp100.000 (one row, same hold).
//
// Rules pinned:
//   - after step 2 exactly one open hold on T2, Rp100.000, still the ONE row of step 1
//     (raised, not duplicated);
//   - a refund of Rp70.000 on T2 is refused (409/422 at request or approve), nothing
//     reaches the provider (the Rp30.000 hold left Rp70.000 open: that is the red);
//   - replays (new envelope id, poller, worker) add no hold, no fact, no journal event;
//   - never lowered: a later report with the readable Rp30.000 keeps Rp100.000;
//   - order unreadable first, readable later: Rp100.000 stays;
//   - a larger readable amount with the same identity raises the hold as well;
//   - T1 is untouched.
//
// Assumptions (the brief does not fix them):
//   - The first (readable) amount is the JSON number 30000; the SO reads it as Rp30.000.
//   - "Same identity" = same envelope-independent key, same Y, same T2; each report is
//     its own stored event (new envelope id).
//   - "Raised" = the same hold row (same id) changes amount; a second open row is not
//     "raised" (the DP credit would then add holds of one identity, and the SO and CTO
//     say the hold itself is raised).
//   - The DP credit of a reservation-linked T2 is asserted in the second `describe`
//     (1088-r1-DP) with a reservation-linked T2 built in this suite's tenant; see there.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1088-r1-mismatch-hold-raise.test.ts" heavy pnpm test

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../config/env";
import { idr, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { closeTableSessionInputSchema } from "@starter/shared/qr-order";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { applyReservationCustomerCredit } from "../services/reservation-deposit-remainder.ts";
import { depositCreditForSession } from "../services/reservation-lifecycle.ts";
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
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";
import { verifySessionMfa } from "./helpers";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

const h = createRefundHarness("1088r1");

// The matched suites exercise the active provider-refund path: DOIT refunds
// are off by default, so switch them on here and restore the value afterwards.
const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;
beforeAll(() => {
  flags.DOIT_REFUNDS_ENABLED = true;
});
afterAll(() => {
  flags.DOIT_REFUNDS_ENABLED = flagBefore;
});

const R1_IDR = 30_000;
const NEXT_IDR = 70_000;

type World = { t1: Code; t2: Code; refundId: string; x1: string; y: string };

async function world(): Promise<World> {
  const t1 = await h.newCode(BILL_IDR);
  expect((await h.paid(t1, BILL_IDR)).status).toBe(200);
  const own = await h.ownCompletedRefund(t1, R1_IDR);
  const t2 = await h.newCode(BILL_IDR);
  expect((await h.paid(t2, BILL_IDR)).status).toBe(200);
  expect(await h.allHolds(t1.id), "premise: no hold on T1").toHaveLength(0);
  expect(await h.allHolds(t2.id), "premise: no hold on T2").toHaveLength(0);
  return {
    t1,
    t2,
    refundId: own.refundId,
    x1: own.x,
    y: `rf_${randomBytes(6).toString("hex")}`,
  };
}

/** One stored report (one envelope id) keyed to R1, refund Y, payment T2. */
const report = (w: World, amount: unknown) => {
  const eventId = `evt_${randomBytes(8).toString("hex")}`;
  return () => ({
    id: eventId,
    type: "refund.succeeded",
    created_at: new Date().toISOString(),
    data: {
      object: "refund",
      id: w.y,
      idempotency_key: `refund:${w.refundId}`,
      payment_id: w.t2.providerRef,
      status: "succeeded",
      ...(amount === undefined ? {} : { amount }),
    },
  });
};

/** The state a replay must not change. */
async function snapshot(w: World) {
  return {
    factsT1: await h.providerRows(w.t1.id),
    factsT2: await h.providerRows(w.t2.id),
    eventsT1: await h.refundEventsOfIntent(w.t1.id),
    eventsT2: await h.refundEventsOfIntent(w.t2.id),
  };
}

/** Exactly one open hold on T2 of `amount`; returns it. */
async function expectOneHold(w: World, amount: number, label: string) {
  const holds = JSON.stringify(await h.allHolds(w.t2.id));
  const open = await h.openOf(w.t2.id);
  expect(open, `${label}: one open hold on T2 (holds: ${holds})`).toHaveLength(
    1,
  );
  expect(
    open[0]!.amount_idr,
    `${label}: the hold is worth Rp${amount} (holds: ${holds})`,
  ).toBe(amount);
  expect(
    (await h.allHolds(w.t2.id)).length,
    `${label}: one hold row only (holds: ${holds})`,
  ).toBe(1);
  return open[0]!;
}

/** T2 cannot be refunded any more; the provider is not asked. */
async function expectT2Blocked(w: World, label: string, callsBefore: number) {
  const filed = await h.manualRefund(w.t2.id, NEXT_IDR);
  if (filed.status === 201) {
    const approved = await h.approveRefund(filed.body.data.id as string);
    expect(
      [409, 422],
      `${label}: approving ${NEXT_IDR} on T2: ${JSON.stringify(approved.body)}`,
    ).toContain(approved.status);
  } else {
    expect(
      [409, 422],
      `${label}: requesting ${NEXT_IDR} on T2: ${JSON.stringify(filed.body)}`,
    ).toContain(filed.status);
  }
  expect(h.fake.calls, `${label}: nothing reached the provider`).toHaveLength(
    callsBefore,
  );
}

async function expectT1Untouched(w: World, label: string) {
  expect(await h.allHolds(w.t1.id), `${label}: no hold on T1`).toHaveLength(0);
  expect(await h.refundRow(w.refundId), `${label}: R1 untouched`).toMatchObject(
    {
      status: "completed",
      amount_idr: String(R1_IDR),
      provider_ref: w.x1,
    },
  );
}

/** Unreadable amounts; `base` offsets the test ids (01-03, 04-06, 07-09). */
const unreadable = (base: number): Array<[string, string, unknown]> => [
  [
    `1088-r1-${String(base).padStart(2, "0")}`,
    "non-canonical '80000.0'",
    "80000.0",
  ],
  [
    `1088-r1-${String(base + 1).padStart(2, "0")}`,
    "text 'eighty thousand'",
    "eighty thousand",
  ],
  [`1088-r1-${String(base + 2).padStart(2, "0")}`, "missing", undefined],
];

describe("R1 (P1) an open mismatch hold of the same identity is raised, never lowered", () => {
  it.each(unreadable(1))(
    "%s Rp30.000 hold on T2 first, then the same key/Y/T2 with amount %s: the hold is raised to Rp100.000 (one row), refund of Rp70.000 on T2 refused, replays add nothing, T1 untouched",
    async (id, _label, amount) => {
      const w = await world();
      const callsBefore = h.fake.calls.length;
      const before = await snapshot(w);

      await h.replayAll(report(w, R1_IDR), 1);
      const first = await expectOneHold(w, R1_IDR, `${id} premise`);

      const later = report(w, amount);
      await h.replayAll(later, 1);
      const raised = await expectOneHold(w, BILL_IDR, `${id} raised`);
      expect(raised.id, `${id}: the same hold row was raised`).toBe(first.id);

      // Replays of the same report and of a new envelope with the same evidence.
      await h.replayAll(later, 2);
      await h.replayAll(report(w, amount), 1);
      await expectOneHold(w, BILL_IDR, `${id} after replays`);

      expect(await snapshot(w), `${id}: no fact, no journal event`).toEqual(
        before,
      );
      await expectT2Blocked(w, id, callsBefore);
      await expectT1Untouched(w, id);
    },
  );

  it.each(unreadable(4))(
    "%s never lowered: once raised to Rp100.000, a later report of the same identity with the readable Rp30.000 keeps Rp100.000 (one row)",
    async (id, _label, amount) => {
      const w = await world();
      await h.replayAll(report(w, R1_IDR), 1);
      await h.replayAll(report(w, amount), 1);
      await expectOneHold(w, BILL_IDR, `${id} premise (raised)`);

      await h.replayAll(report(w, R1_IDR), 2);
      await expectOneHold(w, BILL_IDR, `${id} readable replay`);
      await expectT1Untouched(w, id);
    },
  );

  it.each(unreadable(7))(
    "%s order unreadable first (Rp100.000), the readable Rp30.000 of the same identity later: still one hold of Rp100.000",
    async (id, _label, amount) => {
      const w = await world();
      await h.replayAll(report(w, amount), 1);
      await expectOneHold(w, BILL_IDR, `${id} premise`);
      await h.replayAll(report(w, R1_IDR), 2);
      await expectOneHold(w, BILL_IDR, `${id} after the readable report`);
      expect(
        await h.providerRows(w.t2.id),
        `${id}: no fact on T2`,
      ).toHaveLength(0);
    },
  );

  it("1088-r1-10 a larger readable amount of the same identity raises the open hold too (Rp30.000, then Rp50.000: one hold of Rp50.000; Rp40.000 afterwards does not lower it)", async () => {
    const w = await world();
    await h.replayAll(report(w, R1_IDR), 1);
    const first = await expectOneHold(w, R1_IDR, "r1-10 premise");
    await h.replayAll(report(w, 50_000), 1);
    const raised = await expectOneHold(w, 50_000, "r1-10 raised");
    expect(raised.id, "r1-10: the same hold row was raised").toBe(first.id);
    await h.replayAll(report(w, 40_000), 1);
    await expectOneHold(w, 50_000, "r1-10 not lowered");
    await expectT1Untouched(w, "r1-10");
  });
});

// --- 1088-r1-DP: a reservation-linked T2 -------------------------------------------
//
// T2 (a real DOIT payment of the harness tenant, so the signed report finds it) is
// turned into a deposit (DP): a reservation, a table session and an allocation are
// attached to it with raw rows, the way refund-1072-a2 / refund-1063-b do in the
// seeded tenant. The credit a guest can still use is read (depositCreditForSession of
// an open session) or spent (applyReservationCustomerCredit of the customer credit of
// a closed session), the same figures the QR and POS checkout use.
//
// DP numbers: DP Rp100.000. "Open" shape: the session bill is Rp150.000, nothing
// applied, the session reads the whole DP. "Pool" shape: the source session consumed
// Rp20.000 and closed, Rp80.000 is transferable customer credit.
//
// Assumptions: with the Rp30.000 hold the open session reads Rp70.000 (the SO's
// "Rp70.000 masih tersedia"); the pool still has Rp50.000 spendable (100 - 20 - 30).
// "Apply Rp70.000 rejected" is observed with the amount the small hold would still
// allow in the pool shape (Rp50.000) and with Rp1: the hold of Rp100.000 leaves the
// pool nothing. The harness' own tenant carries the fixtures (no seeded tenant).

const HOST = `refund-${h.tenantId}.example.test`;
const DP_IDR = BILL_IDR;
const POOL_CONSUMED = 20_000;
const POOL_CREDIT = DP_IDR - POOL_CONSUMED;
const STILL_SPENDABLE = POOL_CREDIT - R1_IDR; // 50.000 under the small hold
const scope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(h.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
const zoneIds: string[] = [];
const tableIds: string[] = [];
const reservationIds: string[] = [];
const profileIds: string[] = [];
const orderIds: string[] = [];
const sessionIds: string[] = [];
const intentIds: string[] = [];
const settlements = new Map<string, { total: number; paid: number } | null>();
let floorStaff: Staff;
let receiptEntity = "";
let receiptPeriod = "";
const receiptAccounts = [randomUUID(), randomUUID()];
const receiptEntries: string[] = [];

beforeAll(async () => {
  floorStaff = await staffWithRole(h.app, {
    template: "owner",
    tenantId: h.tenantId,
    label: "1088-r1 DP owner",
  });
  floorStaff.client.set("Host", HOST);
  await verifySessionMfa(floorStaff.email);
  // The original DP receipt journal of T2 (the credit apply reads it), as in 1072-a2.
  const entity = await h.owner.query(
    "SELECT legal_entity_id FROM outlets WHERE id = $1",
    [h.outletId],
  );
  receiptEntity = entity.rows[0].legal_entity_id;
  for (const [i, type, group] of [
    [0, "asset", "current_asset"],
    [1, "liability", "current_liability"],
  ] as const)
    await h.owner.query(
      `INSERT INTO chart_of_accounts(id,tenant_id,legal_entity_id,code,name,type,report_group) VALUES($1,$2,$3,$4,'1088-r1 DP receipt',$5,$6)`,
      [
        receiptAccounts[i],
        h.tenantId,
        receiptEntity,
        `993.${i + 1}`,
        type,
        group,
      ],
    );
  const period = new Date().toISOString().slice(0, 7);
  await h.owner.query(
    "INSERT INTO fiscal_periods(tenant_id,legal_entity_id,period) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    [h.tenantId, receiptEntity, period],
  );
  receiptPeriod = (
    await h.owner.query(
      "SELECT id FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $3",
      [h.tenantId, receiptEntity, period],
    )
  ).rows[0].id;
  setTableSessionSettlementLookup(async ({ sessionId }) => {
    const found = settlements.get(sessionId);
    return found
      ? { billTotalIdr: idr(found.total), paidIdr: idr(found.paid) }
      : null;
  });
});

// Registered after the harness hooks: runs first, so no row of ours still points
// at the payment intents the harness deletes.
afterAll(async () => {
  setTableSessionSettlementLookup(null);
  const client = await h.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "DELETE FROM journal_lines WHERE entry_id = ANY($1::uuid[])",
      [receiptEntries],
    );
    await client.query(
      "DELETE FROM journal_entries WHERE id = ANY($1::uuid[])",
      [receiptEntries],
    );
    await client.query(
      "DELETE FROM chart_of_accounts WHERE id = ANY($1::uuid[])",
      [receiptAccounts],
    );
    for (const table of [
      "reservation_credit_recon_flags",
      "reservation_customer_credit_uses",
      "reservation_deposit_remainders",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND table_session_id = ANY($2::uuid[])`,
        [h.tenantId, sessionIds],
      );
    await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      orderIds,
    ]);
    await client.query(
      "DELETE FROM reservation_deposit_allocations WHERE reservation_id = ANY($1::uuid[])",
      [reservationIds],
    );
    await client.query(
      "UPDATE payment_intents SET reservation_id = NULL WHERE id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query("DELETE FROM reservations WHERE id = ANY($1::uuid[])", [
      reservationIds,
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
  await dropFloorRows({ tenantId: h.tenantId, zoneIds, tableIds }).catch(
    () => undefined,
  );
});

async function newProfile() {
  const id = randomUUID();
  profileIds.push(id);
  await h.owner.query(
    `INSERT INTO customer_profiles
       (id, tenant_id, name, membership_status, whatsapp_verified_at)
     VALUES ($1, $2, '1088-r1 Customer', 'active', now())`,
    [id, h.tenantId],
  );
  return id;
}

async function newSession() {
  const headers = { Host: HOST };
  const zone = await createZone(floorStaff.client, {}, headers);
  zoneIds.push(zone.id);
  const table = await createTable(
    floorStaff.client,
    { zoneId: zone.id },
    headers,
  );
  tableIds.push(table.id);
  const qr = await issueQr(floorStaff.client, table.id, headers);
  const opened = await openOrJoinTableSession(scope(), {
    qrToken: qr.token,
    pax: 2,
    deviceHash: `t1088r1-${randomUUID()}`,
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
  await h.owner.query(
    `INSERT INTO orders
       (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
        subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
        total_idr, deposit_applied_idr, status, business_date, placed_at,
        table_session_id, customer_profile_id)
     VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', $5, 0, 0, 0, 0,
             $5, $6, 'sent', '2026-11-12', now(), $7, $8)`,
    [
      id,
      h.tenantId,
      h.outletId,
      `T1088R1-${id.slice(0, 8)}`,
      total,
      deposit,
      sessionId,
      profileId,
    ],
  );
}

async function seedOriginalReceipt(intentId: string, amount: number) {
  const journalId = randomUUID();
  receiptEntries.push(journalId);
  const c = await h.owner.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO journal_entries(id,tenant_id,legal_entity_id,outlet_id,entry_date,fiscal_period_id,source_type,source_id,description,idempotency_key,request_fingerprint)
       VALUES($1,$2,$3,$4,$5,$6,'customer_deposit',$7,'Penerimaan DP 1088-r1',$8,$9)`,
      [
        journalId,
        h.tenantId,
        receiptEntity,
        h.outletId,
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
        h.tenantId,
        journalId,
        receiptAccounts[0],
        receiptAccounts[1],
        amount,
        h.outletId,
      ],
    );
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}

type Dp = Awaited<ReturnType<typeof makeDp>>;

/** Attach a reservation, a session and the allocation to T2 (already paid, Rp100.000). */
async function makeDp(w: World, billTotal: number, applied: number) {
  const profileId = await newProfile();
  const session = await newSession();
  const reservationId = randomUUID();
  reservationIds.push(reservationId);
  intentIds.push(w.t2.id);
  await h.owner.query(
    `INSERT INTO reservations
       (id, tenant_id, outlet_id, customer_profile_id, guest_name, reserved_for,
        duration_minutes, pax, zone_id, deposit_idr, policy_snapshot, status,
        source, seated_at, table_session_id)
     VALUES ($1, $2, $3, $4, '1088-r1 Payer', now(), 90, 2, $5, $6, $7,
             'seated', 'staff', now(), $8)`,
    [
      reservationId,
      h.tenantId,
      h.outletId,
      profileId,
      session.zoneId,
      DP_IDR,
      JSON.stringify({
        version: "t1088r1",
        depositRequirement: "required",
        depositAmountIdr: DP_IDR,
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
  await h.owner.query(
    "UPDATE payment_intents SET reservation_id = $2 WHERE id = $1",
    [w.t2.id, reservationId],
  );
  await h.owner.query(
    "UPDATE reservations SET deposit_payment_id = $2, deposit_payment_link_id = $3 WHERE id = $1",
    [reservationId, w.t2.id, w.t2.linkId],
  );
  await h.owner.query(
    "UPDATE table_sessions SET reservation_id = $2 WHERE id = $1",
    [session.sessionId, reservationId],
  );
  await h.owner.query(
    `INSERT INTO reservation_deposit_allocations
       (tenant_id, outlet_id, reservation_id, table_session_id, payment_intent_id, amount_idr)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [h.tenantId, h.outletId, reservationId, session.sessionId, w.t2.id, DP_IDR],
  );
  await addOrder(
    session.sessionId,
    billTotal,
    Math.min(applied, billTotal),
    profileId,
  );
  settlements.set(session.sessionId, { total: billTotal, paid: DP_IDR });
  await seedOriginalReceipt(w.t2.id, DP_IDR);
  return { ...session, reservationId, profileId };
}

const effectiveCredit = (sessionId: string) =>
  withTenant(db, scope(), (tx) =>
    depositCreditForSession(tx, tenantIdSchema.parse(h.tenantId), sessionId),
  );

const applyCredit = (
  dp: Pick<Dp, "profileId">,
  sessionId: string,
  amount: number,
) =>
  applyReservationCustomerCredit(
    scope(),
    floorStaff.userId,
    h.outletId,
    {
      customerProfileId: dp.profileId,
      tableSessionId: sessionId,
      amountIdr: idr(amount),
    },
    randomUUID(),
  );

async function remainders(reservationId: string) {
  const { rows } = await h.owner.query<{
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

/** A second visit of the same customer with an open bill of `total`. */
async function targetSession(profileId: string, total: number) {
  const target = await newSession();
  await addOrder(target.sessionId, total, 0, profileId);
  // Nothing paid yet: a bill that is already paid takes no credit (1025c fixture).
  settlements.set(target.sessionId, { total, paid: 0 });
  return target.sessionId;
}

/** Pool shape: the source session consumed Rp20.000 and closed, Rp80.000 is credit. */
async function closedPool(w: World) {
  const dp = await makeDp(w, POOL_CONSUMED, POOL_CONSUMED);
  await closeTableSession(
    scope(),
    dp.sessionId,
    closeTableSessionInputSchema.parse({
      tableCleaned: true,
      waiterConfirmedEmpty: false,
    }),
    floorStaff.userId,
  );
  expect(
    await remainders(dp.reservationId),
    "premise: Rp80.000 credit",
  ).toEqual([
    { kind: "customer_credit", amount: POOL_CREDIT, remaining: POOL_CREDIT },
  ]);
  return dp;
}

describe("R1 (P1) DP credit of a reservation-linked T2 follows the raised hold", () => {
  it("1088-r1-11 open session: the Rp30.000 hold leaves Rp70.000, the unreadable report of the same identity takes it to zero; replays add no hold, fact or journal event", async () => {
    const w = await world();
    const dp = await makeDp(w, 150_000, 0);
    expect(
      await effectiveCredit(dp.sessionId),
      "premise: the open session reads the whole DP",
    ).toBe(DP_IDR);
    const before = await snapshot(w);

    await h.replayAll(report(w, R1_IDR), 1);
    await expectOneHold(w, R1_IDR, "r1-11 premise");
    expect(
      await effectiveCredit(dp.sessionId),
      "premise: the small hold leaves Rp70.000",
    ).toBe(DP_IDR - R1_IDR);

    const later = report(w, "80000.0");
    await h.replayAll(later, 1);
    await expectOneHold(w, DP_IDR, "r1-11 raised");
    expect(
      await effectiveCredit(dp.sessionId),
      "r1-11: the DP credit the session reads is zero (DP - hold)",
    ).toBe(0);

    await h.replayAll(later, 2);
    await h.replayAll(report(w, "80000.0"), 1);
    await expectOneHold(w, DP_IDR, "r1-11 after replays");
    expect(await effectiveCredit(dp.sessionId), "r1-11: still zero").toBe(0);
    expect(await snapshot(w), "r1-11: no fact, no journal event").toEqual(
      before,
    );
  });

  it.each([
    ["1088-r1-12", "non-canonical '80000.0'", "80000.0"],
    ["1088-r1-13", "missing", undefined],
  ] as Array<[string, string, unknown]>)(
    "%s transferred pool (customer credit Rp80.000): after the Rp30.000 hold and the report with amount %s the credit apply of Rp50.000 (what the small hold would still allow) and of Rp1 are rejected, the credit is untouched, replays add nothing",
    async (id, _label, amount) => {
      const w = await world();
      const dp = await closedPool(w);
      const before = await snapshot(w);

      await h.replayAll(report(w, R1_IDR), 1);
      await expectOneHold(w, R1_IDR, `${id} premise`);
      const later = report(w, amount);
      await h.replayAll(later, 1);
      await expectOneHold(w, DP_IDR, `${id} raised`);

      const target = await targetSession(dp.profileId, STILL_SPENDABLE);
      await expect(
        applyCredit(dp, target, STILL_SPENDABLE),
        `${id}: spending what the small hold would allow is refused`,
      ).rejects.toMatchObject({ code: "CUSTOMER_CREDIT_NOT_AVAILABLE" });
      const probe = await targetSession(dp.profileId, 1);
      await expect(
        applyCredit(dp, probe, 1),
        `${id}: not even Rp1 is spendable`,
      ).rejects.toMatchObject({ code: "CUSTOMER_CREDIT_NOT_AVAILABLE" });
      expect(
        await remainders(dp.reservationId),
        `${id}: the customer credit is untouched`,
      ).toEqual([
        {
          kind: "customer_credit",
          amount: POOL_CREDIT,
          remaining: POOL_CREDIT,
        },
      ]);

      await h.replayAll(later, 2);
      await h.replayAll(report(w, amount), 1);
      await expectOneHold(w, DP_IDR, `${id} after replays`);
      expect(await snapshot(w), `${id}: no fact, no journal event`).toEqual(
        before,
      );
    },
  );
});

// --- barriers: two connections, both lock orders ------------------------------------
//
// No sleep decides pass or fail (bounded polling only waits for a state). The stalled
// side is parked AFTER it took its advisory locks by an owner-side
// `LOCK TABLE ... IN SHARE MODE` on the tables it writes (reads and locks pass), as in
// refund-1063-b-conflict-hold-dp-credit (awdwd-6/7). The other side must queue on the
// stalled advisory key or finish. Afterwards, whatever the order: one open hold of
// the whole payment, and the guest cannot keep anything above the net (nothing
// spendable, or a credit_used_before_provider_refund hold names the surplus).

type Stall = { keys: string[] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function advisoryKeysOfWaiters(): Promise<string[]> {
  const { rows } = await h.owner.query<{ key: string }>(
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

async function queuedOn(keys: string[]) {
  const { rows } = await h.owner.query<{ key: string }>(
    `SELECT classid::text || ':' || objid::text || ':' || objsubid::text AS key
       FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
  );
  return rows.some((r) => keys.includes(r.key));
}

async function waitsOrFinishes(keys: string[], finished: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (finished()) return;
    if (await queuedOn(keys)) return;
    await sleep(50);
  }
  throw new Error("neither queued on the stalled lock nor finished");
}

function track<T>(p: PromiseLike<T>) {
  const state = { done: false };
  const tracked = Promise.resolve(p).then(
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

async function whileStalled<T>(
  tables: string,
  start: () => PromiseLike<unknown>,
  body: (stall: Stall) => Promise<T>,
): Promise<T> {
  const gate = await h.owner.connect();
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
    running = Promise.resolve(start());
    running.catch(() => undefined);
    let keys: string[] = [];
    const deadline = Date.now() + 15_000;
    while (keys.length === 0) {
      if (Date.now() > deadline)
        throw new Error("premise: the work never stalled holding locks");
      keys = await advisoryKeysOfWaiters();
      if (keys.length === 0) await sleep(50);
    }
    return await body({ keys });
  } finally {
    await release();
    await Promise.allSettled([running]);
  }
}

describe("R1 (P1) barriers: the raise of the mismatch hold against the DP credit apply, both lock orders", () => {
  async function expectNoOverspendAfter(
    w: World,
    dp: Dp,
    target: string,
    label: string,
  ) {
    await expectOneHold(w, DP_IDR, `${label} the hold was raised`);
    const spendable = await effectiveCredit(target);
    const { rows } = await h.owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM refund_recon_holds
        WHERE tenant_id = $1 AND payment_intent_id = $2 AND resolved_at IS NULL
          AND reason LIKE 'credit_used_before_provider_refund%'`,
      [h.tenantId, w.t2.id],
    );
    expect(
      spendable === 0 || Number(rows[0]!.n) > 0,
      `${label}: the guest can still spend ${spendable} of a net of 0 and no credit_used_before_provider_refund hold names the surplus`,
    ).toBe(true);
    const left = (await remainders(dp.reservationId)).reduce(
      (sum, r) => sum + r.remaining,
      0,
    );
    expect(
      left,
      `${label}: never more than the credit left`,
    ).toBeLessThanOrEqual(POOL_CREDIT);
  }

  it("1088-r1-14 order 1, credit apply first: the unreadable report waits on the DP lock (or finishes), the hold ends at Rp100.000 and nothing above the net stays spendable", async () => {
    const w = await world();
    const dp = await closedPool(w);
    await h.replayAll(report(w, R1_IDR), 1);
    await expectOneHold(w, R1_IDR, "r1-14 premise");
    const target = await targetSession(dp.profileId, STILL_SPENDABLE);

    let applied!: ReturnType<typeof track<unknown>>;
    const filing = await whileStalled(
      "reservation_customer_credit_uses, reservation_deposit_remainders",
      () => {
        applied = track(applyCredit(dp, target, STILL_SPENDABLE));
        return applied.tracked;
      },
      async ({ keys }) => {
        const delivering = track(h.deliver(report(w, "80000.0")()));
        await waitsOrFinishes(keys, () => delivering.state.done);
        return delivering;
      },
    );
    await filing.tracked;
    await expect(
      applied.tracked,
      "r1-14 premise: the Rp30.000 hold still allowed the apply of Rp50.000",
    ).resolves.toBeDefined();
    await h.runWorker();
    await expectNoOverspendAfter(w, dp, target, "r1-14");
  }, 60_000);

  it("1088-r1-15 order 2, report first: a credit apply that comes while the raise is being written waits (or the surplus is named); the hold ends at Rp100.000 and nothing above the net stays spendable", async () => {
    const w = await world();
    const dp = await closedPool(w);
    await h.replayAll(report(w, R1_IDR), 1);
    await expectOneHold(w, R1_IDR, "r1-15 premise");
    const target = await targetSession(dp.profileId, STILL_SPENDABLE);

    const applying = await whileStalled(
      "refund_recon_holds",
      () => h.deliver(report(w, "80000.0")()),
      async ({ keys }) => {
        const spending = track(applyCredit(dp, target, STILL_SPENDABLE));
        await waitsOrFinishes(keys, () => spending.state.done);
        return spending;
      },
    );
    await Promise.allSettled([applying.tracked]);
    await h.runWorker();
    await expectNoOverspendAfter(w, dp, target, "r1-15");
  }, 60_000);
});

describe("R1 (P1) DP fixture premise", () => {
  it("1088-r1-16 premise: with no hold at all the transferred pool lets the guest spend Rp10.000 once (so the refusals above are the hold's, not the fixture's)", async () => {
    const w = await world();
    const dp = await closedPool(w);
    const target = await targetSession(dp.profileId, 10_000);
    await applyCredit(dp, target, 10_000);
    expect(await remainders(dp.reservationId)).toEqual([
      {
        kind: "customer_credit",
        amount: POOL_CREDIT,
        remaining: POOL_CREDIT - 10_000,
      },
    ]);
  });
});
