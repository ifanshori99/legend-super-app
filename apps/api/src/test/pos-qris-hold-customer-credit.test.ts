// QRIS hold vs reservation customer credit (legend-yhia9, brief gap 2).
// `applyReservationCustomerCredit` moves what a bill still owes, so it must be
// frozen like a DP while a QR is collectible (design D-01: anything that moves
// the amount due is refused with 409 QRIS_HOLD_ACTIVE while the hold is `open`
// or `cancelling`). Founder rule: the customer never pays more than the
// remainder R, the outlet never receives less than T.
//
// Written from the design and the public contract (PosError QRIS_HOLD_ACTIVE
// 409, credit tables), not from the implementation.
//
// Assumptions:
// - Credit applied to a table session lowers what the next QRIS on that
//   session's bill asks for (R = T - credit), the same way a DP does. If it did
//   not, the closed-hold test would see a QR for T and the customer would pay
//   T + credit: that is the harm this file guards.
// - The credit use is bound to the bill through `orders.customer_profile_id`
//   (set here before the QR is issued), as in reservation-deposit-remainder.
// - After the hold is `paid` the bill owes nothing, so no credit may add money
//   on top of T (either refused or applied to Rp0; only the sum is asserted).
// - Fixture bill: Rp30.000 meal + 10% PBJT = Rp33.000 (asserted in QH-01).
// - Round 2 (architect findings): the hold guard looks at EVERY order of the
//   table session (not only the bill the credit is bound to), and the credit
//   path takes its locks in the same order as a DP return (no 40P01 deadlock).
//   CREDIT-HOLD-05 treats any outcome except a Postgres deadlock as
//   acceptable for the credit call (applied or a clean domain refusal): the
//   test guards the lock order and the money invariant, not who wins.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
} from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import type { PosReceipt } from "@starter/shared/pos";
import { closeTableSessionInputSchema } from "@starter/shared/qr-order";
import { setStaffPin } from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { setQrOrderDepositCreditLookup } from "../services/qr-order-ports.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { applyReservationCustomerCredit } from "../services/reservation-deposit-remainder.ts";
import {
  closeTableSession,
  setTableSessionSettlementLookup,
} from "../services/table-session.service.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, signUp } from "./helpers.ts";
import {
  HOLD_CLOSE_MARGIN_S,
  capturedIdr,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  payNotice,
  postCancel,
  readBill,
  readHold,
  refundsOfIntent,
  resetHoldPorts,
  runHoldCheck,
  tenderStatuses,
  unallocatedFunds,
  type HoldFixture,
  type IssuedQris,
} from "./pos-qris-hold-test-helpers.ts";

const BILL_IDR = 33_000;
const CREDIT_IDR = 10_000;
/** Source session: bill 60.000 against a DP of 100.000 leaves 40.000 credit. */
const SOURCE_DEPOSIT_IDR = 100_000;
const SOURCE_TOTAL_IDR = 60_000;
const SOURCE_CREDIT_IDR = SOURCE_DEPOSIT_IDR - SOURCE_TOTAL_IDR;

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-credit");
  // The cashier role of the hold fixture may not manage reservations; applying
  // customer credit needs reservation.manage (same permission as the route).
  await owner.query(
    "UPDATE roles SET permissions = permissions || $2::jsonb WHERE id = $1",
    [fx.tenant.roleId, JSON.stringify(["reservation.manage"])],
  );
});
afterAll(async () => {
  setPosReceiptPort(null);
  resetHoldPorts();
  await owner.end();
});

// ------------------------------------------------------------ credit source

/** Seed a closed visit whose unused DP became customer credit (the same way
 * reservation-deposit-remainder.test.ts does, but inside the hold fixture's
 * tenant). Returns the profile that owns Rp40.000 of credit. */
async function seedCreditSource() {
  const tenantId = fx.tenant.tenantId;
  const outletId = fx.tenant.outletId;
  const profileId = randomUUID();
  await owner.query(
    `INSERT INTO customer_profiles
       (id, tenant_id, name, membership_status, whatsapp_verified_at)
     VALUES ($1, $2, 'Hold Credit Customer', 'active', now())`,
    [profileId, tenantId],
  );
  const source = await fx.newGuest();
  const reservationId = randomUUID();
  const intentId = randomUUID();
  const linkId = randomUUID();
  await owner.query(
    `INSERT INTO reservations
       (id, tenant_id, outlet_id, customer_profile_id, guest_name, reserved_for,
        duration_minutes, pax, zone_id, deposit_idr, policy_snapshot, status,
        source, seated_at, table_session_id)
     VALUES ($1, $2, $3, $4, 'Hold Credit Payer', now(), 90, 2, $5, $6, $7,
             'seated', 'staff', now(), $8)`,
    [
      reservationId,
      tenantId,
      outletId,
      profileId,
      source.zone.id,
      SOURCE_DEPOSIT_IDR,
      JSON.stringify({
        version: "hold-credit",
        depositRequirement: "required",
        depositAmountIdr: SOURCE_DEPOSIT_IDR,
        paymentWindowMinutes: 60,
        freeCancellationHours: 24,
        lateCancellationRefundBp: 0,
        noShowRefundBp: 0,
        minimumSpendIdr: 0,
        capturedAt: new Date().toISOString(),
      }),
      source.sessionId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'hold-credit-test')`,
    [
      linkId,
      tenantId,
      outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `HC-${linkId.slice(0, 8)}`,
      SOURCE_DEPOSIT_IDR,
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
      tenantId,
      outletId,
      linkId,
      reservationId,
      SOURCE_DEPOSIT_IDR,
      `hold-credit-pay-${intentId}`,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [
      tenantId,
      outletId,
      intentId,
      `hold-credit-evidence-${intentId}`,
      SOURCE_DEPOSIT_IDR,
    ],
  );
  await owner.query(
    `UPDATE reservations SET deposit_payment_id = $2, deposit_payment_link_id = $3 WHERE id = $1`,
    [reservationId, intentId, linkId],
  );
  await owner.query(
    "UPDATE table_sessions SET reservation_id = $2 WHERE id = $1",
    [source.sessionId, reservationId],
  );
  await owner.query(
    `INSERT INTO reservation_deposit_allocations
       (tenant_id, outlet_id, reservation_id, table_session_id, payment_intent_id, amount_idr)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      tenantId,
      outletId,
      reservationId,
      source.sessionId,
      intentId,
      SOURCE_DEPOSIT_IDR,
    ],
  );
  const orderId = randomUUID();
  await owner.query(
    `INSERT INTO orders
       (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
        subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
        total_idr, deposit_applied_idr, status, business_date, placed_at,
        table_session_id, customer_profile_id)
     VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', $5, 0, 0, 0, 0,
             $5, $5, 'sent', '2026-11-12', now(), $6, $7)`,
    [
      orderId,
      tenantId,
      outletId,
      `HC-${orderId.slice(0, 8)}`,
      SOURCE_TOTAL_IDR,
      source.sessionId,
      profileId,
    ],
  );
  await seedOriginalReceipt(intentId, SOURCE_DEPOSIT_IDR);

  // Close the source visit with a settlement that says "fully paid by the DP".
  setTableSessionSettlementLookup(async ({ sessionId }) =>
    sessionId === source.sessionId
      ? {
          billTotalIdr: idr(SOURCE_TOTAL_IDR),
          paidIdr: idr(SOURCE_DEPOSIT_IDR),
        }
      : null,
  );
  try {
    await closeTableSession(
      fx.context,
      source.sessionId,
      closeTableSessionInputSchema.parse({
        tableCleaned: true,
        waiterConfirmedEmpty: false,
      }),
      fx.staff.userId,
    );
  } finally {
    setTableSessionSettlementLookup(qrOrderSettlementLookup);
  }
  expect(
    await creditLeft(profileId),
    "setup: closing the source visit turns the unused DP into credit",
  ).toBe(SOURCE_CREDIT_IDR);
  return { profileId };
}

async function seedOriginalReceipt(intentId: string, amount: number) {
  const tenantId = fx.tenant.tenantId;
  const outletId = fx.tenant.outletId;
  const entity = await owner.query<{ legal_entity_id: string }>(
    "SELECT legal_entity_id FROM outlets WHERE id=$1",
    [outletId],
  );
  const entityId = entity.rows[0]!.legal_entity_id;
  const accounts = [randomUUID(), randomUUID()];
  for (const [i, type, group] of [
    [0, "asset", "current_asset"],
    [1, "liability", "current_liability"],
  ] as const)
    await owner.query(
      `INSERT INTO chart_of_accounts(id,tenant_id,legal_entity_id,code,name,type,report_group)
       VALUES($1,$2,$3,$4,'Hold credit DP receipt',$5,$6)`,
      [
        accounts[i],
        tenantId,
        entityId,
        `97${Math.floor(Math.random() * 1e6)}.${i + 1}`,
        type,
        group,
      ],
    );
  const period = new Date().toISOString().slice(0, 7);
  await owner.query(
    `INSERT INTO fiscal_periods(tenant_id,legal_entity_id,period) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
    [tenantId, entityId, period],
  );
  const periodId = (
    await owner.query(
      "SELECT id FROM fiscal_periods WHERE tenant_id=$1 AND legal_entity_id=$2 AND period=$3",
      [tenantId, entityId, period],
    )
  ).rows[0].id;
  const journalId = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO journal_entries(id,tenant_id,legal_entity_id,outlet_id,entry_date,fiscal_period_id,source_type,source_id,description,idempotency_key,request_fingerprint)
       VALUES($1,$2,$3,$4,$5,$6,'customer_deposit',$7,'Penerimaan DP uji hold',$8,$9)`,
      [
        journalId,
        tenantId,
        entityId,
        outletId,
        new Date().toISOString().slice(0, 10),
        periodId,
        intentId,
        `aj:receipt:${intentId}`,
        "0".repeat(64),
      ],
    );
    await client.query(
      `INSERT INTO journal_lines(tenant_id,entry_id,account_id,line_no,debit_idr,credit_idr,outlet_id)
       VALUES($1,$2,$3,1,$5,0,$6),($1,$2,$4,2,0,$5,$6)`,
      [tenantId, journalId, accounts[0], accounts[1], amount, outletId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------ money readers

/** Spendable credit left for a customer, whole Rupiah. */
async function creditLeft(profileId: string) {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT coalesce(sum(remaining_idr),0)::text AS n
       FROM reservation_deposit_remainders
      WHERE tenant_id=$1 AND customer_profile_id=$2 AND kind='customer_credit'`,
    [fx.tenant.tenantId, profileId],
  );
  return Number(rows[0]!.n);
}

/** Credit already spent on a table session, whole Rupiah. */
async function creditSpent(sessionId: string) {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT coalesce(sum(amount_idr),0)::text AS n
       FROM reservation_customer_credit_uses
      WHERE tenant_id=$1 AND table_session_id=$2`,
    [fx.tenant.tenantId, sessionId],
  );
  return Number(rows[0]!.n);
}

async function creditUseRows(sessionId: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM reservation_customer_credit_uses
      WHERE tenant_id=$1 AND table_session_id=$2`,
    [fx.tenant.tenantId, sessionId],
  );
  return rows[0]!.n;
}

async function depositOfBill(orderId: string) {
  const { rows } = await owner.query<{ d: number }>(
    "SELECT deposit_applied_idr::int AS d FROM orders WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!.d;
}

// ------------------------------------------------------------------ fixtures

/** A submitted Rp33.000 bill whose table session belongs to a customer that
 * owns Rp40.000 of credit. */
async function creditedBill() {
  const { profileId } = await seedCreditSource();
  const order = await newSubmittedOrder(fx, 0);
  expect(order.totalIdr).toBe(BILL_IDR);
  const { rows } = await owner.query<{ sid: string }>(
    `UPDATE orders SET customer_profile_id=$3
      WHERE tenant_id=$1 AND id=$2 RETURNING table_session_id::text AS sid`,
    [fx.tenant.tenantId, ulidToUuid(order.id), profileId],
  );
  return { order, profileId, sessionId: rows[0]!.sid };
}

const applyCredit = (
  profileId: string,
  sessionId: string,
  amount = CREDIT_IDR,
  key: string = randomUUID(),
) =>
  applyReservationCustomerCredit(
    fx.context,
    fx.staff.userId,
    outletIdSchema.parse(fx.tenant.outletId),
    {
      customerProfileId: profileId,
      tableSessionId: sessionId,
      amountIdr: idr(amount),
    },
    key,
  );

const at = (qr: IssuedQris, seconds: number) =>
  new Date(qr.expiresAt.getTime() + seconds * 1000);

async function expectCreditRefused(
  bill: Awaited<ReturnType<typeof creditedBill>>,
  qr: IssuedQris,
  expectedState: "open" | "cancelling",
) {
  const before = await creditLeft(bill.profileId);
  await expect(
    applyCredit(bill.profileId, bill.sessionId),
  ).rejects.toMatchObject({
    name: "PosError",
    code: "QRIS_HOLD_ACTIVE",
    status: 409,
  });
  // Nothing moved: no credit-use row, the customer's credit is whole, the
  // bill's DP is untouched, the hold and its tender are still collectible.
  expect(await creditUseRows(bill.sessionId)).toBe(0);
  expect(await creditSpent(bill.sessionId)).toBe(0);
  expect(await creditLeft(bill.profileId)).toBe(before);
  expect(await creditLeft(bill.profileId)).toBe(SOURCE_CREDIT_IDR);
  expect(await depositOfBill(bill.order.id)).toBe(0);
  expect((await readHold(fx, bill.order.id))?.state).toBe(expectedState);
  expect(await tenderStatuses(fx, bill.order.id)).toEqual([
    expect.objectContaining({ status: "authorized", amount: qr.amountIdr }),
  ]);
}

// --------------------------------------------------------------------- tests

describe("QRIS hold: reservation customer credit cannot change the amount due while the QR is collectible", () => {
  it("CREDIT-HOLD-01 hold open: applying credit is refused with 409 QRIS_HOLD_ACTIVE and nothing changes", async () => {
    const bill = await creditedBill();
    const qr = await issueQris(fx, bill.order.id);
    expect(qr.amountIdr).toBe(BILL_IDR);

    await expectCreditRefused(bill, qr, "open");
  });

  it("CREDIT-HOLD-02 hold cancelling (cashier hid the QR, provider not yet confirmed): credit is still refused", async () => {
    const bill = await creditedBill();
    const qr = await issueQris(fx, bill.order.id);
    const cancelled = await postCancel(fx, bill.order.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);

    await expectCreditRefused(bill, qr, "cancelling");
  });

  it("CREDIT-HOLD-03 the customer pays the frozen QR: Rp33.000 in, the unchanged bill is covered once, no refund", async () => {
    const bill = await creditedBill();
    const qr = await issueQris(fx, bill.order.id);
    await expect(
      applyCredit(bill.profileId, bill.sessionId),
    ).rejects.toMatchObject({ code: "QRIS_HOLD_ACTIVE" });

    await payNotice(fx, qr.intentId, BILL_IDR);

    expect((await readHold(fx, bill.order.id))?.state).toBe("paid");
    expect(await capturedIdr(fx, bill.order.id)).toBe(BILL_IDR);
    // The refused credit never became money on the bill.
    expect(await creditSpent(bill.sessionId)).toBe(0);
    expect(await creditLeft(bill.profileId)).toBe(SOURCE_CREDIT_IDR);
    expect(await refundsOfIntent(fx, qr.intentId)).toEqual([]);
    expect(await unallocatedFunds(fx, qr.intentId)).toEqual([]);
    // Even asked again after the payment, credit never lifts money in above T.
    // Applied, or refused (QRIS_HOLD_ACTIVE, or "Saldo pelanggan tidak
    // tersedia": the bill is already paid so no credit is left to use): a
    // 409/422 refusal only. A deadlock or a 500 must fail this test.
    await applyCredit(bill.profileId, bill.sessionId).then(
      () => undefined,
      (error: unknown) => {
        expect([409, 422], String(error)).toContain(
          (error as { status?: number }).status,
        );
      },
    );
    expect(
      (await capturedIdr(fx, bill.order.id)) +
        (await creditSpent(bill.sessionId)),
      "captured + credit must never exceed the bill total",
    ).toBeLessThanOrEqual(BILL_IDR);
  });

  it("CREDIT-HOLD-04 after the provider closes the hold, credit applies and the new QR never asks more than the bill (money in == T)", async () => {
    const bill = await creditedBill();
    const qr = await issueQris(fx, bill.order.id);
    fx.gateway.script(qr.intentId, { rawStatus: "02" });
    const cancelled = await postCancel(fx, bill.order.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);

    // Still frozen until the provider proves the old QR is dead.
    await expect(
      applyCredit(bill.profileId, bill.sessionId),
    ).rejects.toMatchObject({ code: "QRIS_HOLD_ACTIVE" });

    try {
      await runHoldCheck(fx, at(qr, HOLD_CLOSE_MARGIN_S + 1));
    } catch (error) {
      if (!/scripted/.test(String(error))) throw error;
    }
    expect((await readHold(fx, bill.order.id))?.state).toBe("closed");
    expect(await tenderStatuses(fx, bill.order.id)).toEqual([
      expect.objectContaining({ status: "voided", amount: BILL_IDR }),
    ]);

    await applyCredit(bill.profileId, bill.sessionId);

    expect(await creditSpent(bill.sessionId)).toBe(CREDIT_IDR);
    expect(await creditLeft(bill.profileId)).toBe(
      SOURCE_CREDIT_IDR - CREDIT_IDR,
    );

    const second = await issueQris(fx, bill.order.id);
    expect(second.intentId).not.toBe(qr.intentId);
    // Credit reaches a submitted bill only through a reprice (pre-existing
    // rule, also without a hold); unused credit returns at session close. The
    // new QR is never above what the bill still owes.
    const billNow = await readBill(fx, bill.order.id);
    const owed = billNow.totalIdr - billNow.depositIdr;
    expect(second.amountIdr).toBe(owed);
    expect(second.amountIdr).toBeLessThanOrEqual(BILL_IDR);

    await payNotice(fx, second.intentId, second.amountIdr);

    expect(
      await capturedIdr(fx, bill.order.id),
      "the outlet receives the bill in full, the customer is charged once",
    ).toBe(owed);
    expect(await refundsOfIntent(fx, qr.intentId)).toEqual([]);
    expect(await refundsOfIntent(fx, second.intentId)).toEqual([]);
    expect(await unallocatedFunds(fx, qr.intentId)).toEqual([]);
    expect(await unallocatedFunds(fx, second.intentId)).toEqual([]);
  });
});

// ------------------------------------------------- one session, several bills

/** A second submitted bill on the SAME table session, bound to the same
 * customer as the first. */
async function secondBill(sessionId: string, profileId: string) {
  setQrOrderDepositCreditLookup(async () => 0);
  try {
    const draft = await fx.createDraft(sessionId);
    const submitted = await fx.submit(draft.id);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const order = submitted.body.data as { id: string; totalIdr: number };
    expect(order.totalIdr).toBe(BILL_IDR);
    await owner.query(
      "UPDATE orders SET customer_profile_id=$3 WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, ulidToUuid(order.id), profileId],
    );
    return order;
  } finally {
    setQrOrderDepositCreditLookup(null);
  }
}

async function expectSessionFrozen(
  bill: Awaited<ReturnType<typeof creditedBill>>,
  held: { id: string },
  qr: IssuedQris,
  billIds: string[],
) {
  await expect(
    applyCredit(bill.profileId, bill.sessionId),
  ).rejects.toMatchObject({
    name: "PosError",
    code: "QRIS_HOLD_ACTIVE",
    status: 409,
  });
  expect(await creditUseRows(bill.sessionId)).toBe(0);
  expect(await creditSpent(bill.sessionId)).toBe(0);
  expect(await creditLeft(bill.profileId)).toBe(SOURCE_CREDIT_IDR);
  for (const id of billIds) expect(await depositOfBill(id)).toBe(0);
  expect((await readHold(fx, held.id))?.state).toBe("open");
  expect(await tenderStatuses(fx, held.id)).toEqual([
    expect.objectContaining({ status: "authorized", amount: qr.amountIdr }),
  ]);
}

describe("QRIS hold: the freeze covers every bill of the table session (architect round 2)", () => {
  it("CREDIT-HOLD-MULTI-01 QR open on the second bill: credit is refused even though the first bill is free", async () => {
    const first = await creditedBill();
    const second = await secondBill(first.sessionId, first.profileId);
    const qr = await issueQris(fx, second.id);
    expect(qr.amountIdr).toBe(BILL_IDR);

    await expectSessionFrozen(first, second, qr, [first.order.id, second.id]);
    // The free bill really had no hold of its own.
    expect(await readHold(fx, first.order.id)).toBeFalsy();
  });

  it("CREDIT-HOLD-MULTI-02 QR open on the first bill: credit is refused even though the second bill is free", async () => {
    const first = await creditedBill();
    const second = await secondBill(first.sessionId, first.profileId);
    const qr = await issueQris(fx, first.order.id);

    await expectSessionFrozen(first, first.order, qr, [
      first.order.id,
      second.id,
    ]);
    expect(await readHold(fx, second.id)).toBeFalsy();
  });
});

// -------------------------------------------- lock order: credit vs DP return

const DP_IDR = 10_000;
const DEADLOCK = /deadlock|40P01/i;
const SUPERVISOR_PIN = "582914";
const DEADLOCK_ROUNDS = 20;

function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  let next = 0;
  return {
    async issueForSale(_tx, context, input) {
      const existing = byOrder.get(input.orderId);
      if (existing) return existing;
      next += 1;
      const receipt = {
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        orderId: input.orderId,
        deviceId: input.deviceId ?? randomUUID(),
        number: `HC-${String(next).padStart(6, "0")}`,
        sequenceNumber: next,
        status: "issued",
        issuedAt: input.at.toISOString(),
        voidedAt: null,
        voidReason: null,
        voidedBy: null,
        reprintCount: 0,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, receipt);
      return receipt;
    },
    async findForOrder(_tx, _context, orderId) {
      return byOrder.get(orderId) ?? null;
    },
    async voidForOrder(_tx, _context, input) {
      const found = byOrder.get(input.orderId);
      if (!found) return null;
      const voided = {
        ...found,
        status: "voided",
        voidedAt: input.at.toISOString(),
        voidReason: input.reason,
        voidedBy: input.voidedBy,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, voided);
      return voided;
    },
  };
}

/** A supervisor who can approve a refund by PIN; the cashier role may ask. */
async function refundApprover() {
  await owner.query(
    "UPDATE roles SET permissions = permissions || $2::jsonb WHERE id = $1",
    [fx.tenant.roleId, JSON.stringify(["pos.refund.request"])],
  );
  const client = agent(fx.app);
  await signUp(client, "Hold Credit Supervisor");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Hold Credit Supervisor', true, 'supervisor', $3, false, '["tenant"]')`,
    [
      roleId,
      fx.tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.void.approve",
        "pos.refund.approve",
        "pos.discount.approve",
      ]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [fx.tenant.tenantId, userId, roleId],
  );
  const tenantContext = establishTenantContext({
    tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
    brandId: null,
    source: "session",
  });
  await setStaffPin(
    tenantContext,
    userId,
    { outletId: fx.tenant.outletId, userId },
    { pin: SUPERVISOR_PIN },
  );
  return async (orderId: string, valueIdr: number) => {
    const { override } = await createPosOverride(
      tenantContext,
      fx.staff.userId,
      {
        outletId: fx.tenant.outletId,
        action: "refund",
        valueIdr,
        reason: "Pelanggan salah pesan",
        objectType: "order",
        objectId: orderId,
        approval: {
          method: "supervisor_pin",
          approverUserId: userIdSchema.parse(userId),
          pin: SUPERVISOR_PIN,
        },
      } as Parameters<typeof createPosOverride>[2],
      { idempotencyKey: randomUUID() },
    );
    expect(override.status).toBe("approved");
    return { approvedBy: userId, overrideId: override.id };
  };
}

/** The paid DP of a reservation, credited to `sessionId`, with its payer's
 * original QRIS intent (same rows as `seedCreditSource`, no closing). */
async function seedPaidDeposit(sessionId: string, profileId: string) {
  const tenantId = fx.tenant.tenantId;
  const outletId = fx.tenant.outletId;
  const zone = await owner.query<{ zone_id: string }>(
    `SELECT t.zone_id::text AS zone_id FROM table_sessions s
       JOIN tables t ON t.tenant_id = s.tenant_id AND t.id = s.table_id
      WHERE s.tenant_id=$1 AND s.id=$2`,
    [tenantId, sessionId],
  );
  const reservationId = randomUUID();
  const intentId = randomUUID();
  const linkId = randomUUID();
  await owner.query(
    `INSERT INTO reservations
       (id, tenant_id, outlet_id, customer_profile_id, guest_name, reserved_for,
        duration_minutes, pax, zone_id, deposit_idr, policy_snapshot, status,
        source, seated_at, table_session_id)
     VALUES ($1, $2, $3, $4, 'Hold Credit DP Payer', now(), 90, 2, $5, $6, $7,
             'seated', 'staff', now(), $8)`,
    [
      reservationId,
      tenantId,
      outletId,
      profileId,
      zone.rows[0]!.zone_id,
      DP_IDR,
      JSON.stringify({
        version: "hold-credit-dp",
        depositRequirement: "required",
        depositAmountIdr: DP_IDR,
        paymentWindowMinutes: 60,
        freeCancellationHours: 24,
        lateCancellationRefundBp: 0,
        noShowRefundBp: 0,
        minimumSpendIdr: 0,
        capturedAt: new Date().toISOString(),
      }),
      sessionId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'hold-credit-test')`,
    [
      linkId,
      tenantId,
      outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `HD-${linkId.slice(0, 8)}`,
      DP_IDR,
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
      tenantId,
      outletId,
      linkId,
      reservationId,
      DP_IDR,
      `hold-credit-dp-${intentId}`,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [
      tenantId,
      outletId,
      intentId,
      `hold-credit-dp-evidence-${intentId}`,
      DP_IDR,
    ],
  );
  await owner.query(
    `UPDATE reservations SET deposit_payment_id = $2, deposit_payment_link_id = $3 WHERE id = $1`,
    [reservationId, intentId, linkId],
  );
  await owner.query(
    "UPDATE table_sessions SET reservation_id = $2 WHERE id = $1",
    [sessionId, reservationId],
  );
  await owner.query(
    `INSERT INTO reservation_deposit_allocations
       (tenant_id, outlet_id, reservation_id, table_session_id, payment_intent_id, amount_idr)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, outletId, reservationId, sessionId, intentId, DP_IDR],
  );
  await seedOriginalReceipt(intentId, DP_IDR);
  return { intentId };
}

/** A completed Rp33.000 bill: DP Rp10.000 from the reservation + Rp23.000 in
 * cash, on a table session that belongs to the credit customer. */
async function completedBillWithDeposit(profileId: string) {
  const order = await newSubmittedOrder(fx, DP_IDR);
  expect(order.depositAppliedIdr).toBe(DP_IDR);
  const { rows } = await owner.query<{ sid: string }>(
    `UPDATE orders SET customer_profile_id=$3
      WHERE tenant_id=$1 AND id=$2 RETURNING table_session_id::text AS sid`,
    [fx.tenant.tenantId, ulidToUuid(order.id), profileId],
  );
  const sessionId = rows[0]!.sid;
  const { intentId } = await seedPaidDeposit(sessionId, profileId);

  const current = await fx.get(`${fx.base}/${order.id}`);
  expect(current.status, JSON.stringify(current.body)).toBe(200);
  const paid = await fx.tender(
    order.id,
    current.body.data.status as string,
    "cash",
    BILL_IDR - DP_IDR,
  );
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  // Walk the order to `completed` whatever state the cash payment left it in
  // (a fully paid captain bill may already be sent or completed): a DP return
  // is only possible on a completed sale.
  let status = (await fx.get(`${fx.base}/${order.id}`)).body.data
    .status as string;
  if (status === "awaiting_payment") {
    const lines = (await fx.get(`${fx.base}/${order.id}`)).body.data.items as {
      id: string;
    }[];
    const fired = await fx.post(`${fx.base}/${order.id}/fire`, {
      expectedStatus: status,
      itemIds: lines.map((line) => line.id),
      idempotencyKey: randomUUID(),
    });
    expect(fired.status, JSON.stringify(fired.body)).toBe(200);
    status = fired.body.data.status as string;
  }
  if (status === "sent") {
    const completed = await fx.post(`${fx.base}/${order.id}/complete`, {
      expectedStatus: status,
      idempotencyKey: randomUUID(),
    });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  }
  expect(
    (await fx.get(`${fx.base}/${order.id}`)).body.data.status,
    "setup: the sale is completed before the DP is returned",
  ).toBe("completed");
  const items = (await fx.get(`${fx.base}/${order.id}`)).body.data.items as {
    id: string;
  }[];
  return { order, sessionId, intentId, itemId: items[0]!.id };
}

async function depositRefundedFrom(intentId: string) {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT coalesce(sum(amount_idr),0)::text AS n FROM payment_refunds
      WHERE tenant_id=$1 AND payment_intent_id=$2 AND status <> 'failed'`,
    [fx.tenant.tenantId, intentId],
  );
  return Number(rows[0]!.n);
}

describe("QRIS hold: credit apply and a DP return on one session never deadlock (architect round 2, R1)", () => {
  it("CREDIT-HOLD-05 credit apply racing a DP return of the same session: no 40P01 in 20 rounds, and no money is created", async () => {
    setPosReceiptPort(memoryReceiptPort());
    const approve = await refundApprover();
    const { profileId } = await seedCreditSource();
    const CREDIT_STEP_IDR = 1_000;
    let creditUsedInTotal = 0;

    for (let round = 0; round < DEADLOCK_ROUNDS; round += 1) {
      const sale = await completedBillWithDeposit(profileId);
      const refund = async () =>
        fx.post(`${fx.base}/${sale.order.id}/corrections/refund`, {
          amountIdr: BILL_IDR,
          items: [{ itemId: sale.itemId, quantity: 1 }],
          reason: "quality_complaint",
          reasonNote: "Pesanan dikembalikan",
          idempotencyKey: randomUUID(),
          ...(await approve(sale.order.id, BILL_IDR)),
        });
      const credit = () =>
        applyCredit(profileId, sale.sessionId, CREDIT_STEP_IDR);
      // Alternate who starts first so both lock orders are exercised.
      const startRefundFirst = round % 2 === 0;
      const refundPromise = startRefundFirst ? refund() : undefined;
      const creditPromise = credit();
      const [refundOutcome, creditOutcome] = await Promise.allSettled([
        refundPromise ?? refund(),
        creditPromise,
      ]);
      const label = `round ${round}`;

      // The credit call: applied, or a clean domain refusal. Never a deadlock.
      if (creditOutcome.status === "rejected") {
        const reason = creditOutcome.reason as { code?: string };
        expect(String(creditOutcome.reason), label).not.toMatch(DEADLOCK);
        expect(reason.code, label).not.toBe("40P01");
      }
      // The DP return: it answers (201 done or a clean 409), never a 500.
      expect(refundOutcome.status, label).toBe("fulfilled");
      if (refundOutcome.status === "fulfilled") {
        const response = refundOutcome.value;
        expect(JSON.stringify(response.body), label).not.toMatch(DEADLOCK);
        expect(
          [201, 409],
          `${label}: ${JSON.stringify(response.body)}`,
        ).toContain(response.status);
      }

      // Money invariants: the DP payer gets back at most what they paid, and
      // credit spent on the session is at most what was asked for.
      expect(
        await depositRefundedFrom(sale.intentId),
        `${label}: DP refunded to its payer`,
      ).toBeLessThanOrEqual(DP_IDR);
      const spent = await creditSpent(sale.sessionId);
      expect(spent, `${label}: credit used`).toBeLessThanOrEqual(
        CREDIT_STEP_IDR,
      );
      creditUsedInTotal += spent;
    }

    const left = await creditLeft(profileId);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(
      left + creditUsedInTotal,
      "the customer's credit is never created out of thin air",
    ).toBeLessThanOrEqual(SOURCE_CREDIT_IDR);
  }, 600_000);
});
