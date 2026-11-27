// legend-m7tnt (885 card A, P1): the DP provider proof is fail closed.
//
// Second opinion docs/qa/second-opinion-qris-879.md, first P1, and CTO decision
// docs/briefs/885-qris-879-so-fix.md: local time (expiry, margin) is never
// proof that a DP code is dead. Reservation cancel / no-show is refused with
// 409 PAYMENT_PROVIDER_UNCONFIRMED while
//  - the provider answers `pending` for ANY intent of the DP link, whatever
//    its local status (pending, expired/superseded, failed), before or after
//    expiry + margin;
//  - the provider is unreachable;
//  - a failed (amount mismatch) intent still has unallocated funds that are
//    not resolved (refunded/credited): the refund/forfeit decision waits for
//    that reconciliation.
// Assumptions: the answer `expired` / `failed` is final proof; an unallocated
// fund counts as reconciled once `resolved_at` is set.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qris-hold-so885-a-dp-proof.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createPaymentIntentInputSchema } from "@starter/shared/payment";
import {
  cancelReservationInputSchema,
  createReservationInputSchema,
  markNoShowInputSchema,
  type ReservationCreated,
} from "@starter/shared/reservation";
import { createApp } from "../app";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import {
  createIntent,
  holdGatewayAmountMismatch,
} from "../services/payment.service.ts";
import { createReservation } from "../services/reservation-booking.ts";
import { handlePaymentPaid } from "../services/reservation-consumers.ts";
import { createPaymentReservationDepositPort } from "../services/reservation-deposit-payment.ts";
import {
  cancelReservation,
  markReservationNoShow,
} from "../services/reservation-lifecycle.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import { setReservationDepositPort } from "../services/reservation-ports.ts";
import {
  createTable,
  createZone,
  dropFloorRows,
  owner,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";
import {
  PROVIDER_UNSURE,
  backdateIntentExpiry,
  expectLinkActive,
  expectMoneyOnce,
  expectNoMoneyMoved,
  expectUnconfirmedError,
  installScriptedGateway,
  intentInfo,
  moneyOfIntent,
  paidEventsOf,
  providerWebhook,
  settleCall,
  type ScriptedGateway,
} from "./payment-link-cancel-provider-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

const WIB = "Asia/Jakarta";
const DP_IDR = 100_000;
const PARKED_IDR = 20_000;
const outletA = outletIdSchema.parse(seededOutletA);

const tenantScope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: seededTenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

async function asOwner<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
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

let staff: Staff;
let gateway: ScriptedGateway;
const zoneIds: string[] = [];
const tableIds: string[] = [];

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const app = createApp();
  staff = await staffWithRole(app, {
    template: "owner",
    label: "Rsv 885a Proof",
  });
  gateway = installScriptedGateway();
  enableVaBank(gateway);
  setReservationDepositPort(createPaymentReservationDepositPort());
  await asOwner(async (client) => {
    await client.query(
      "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, seededOutletA],
    );
    await client.query(
      `INSERT INTO reservation_policies
         (tenant_id, outlet_id, version, deposit_requirement, deposit_amount_idr, payment_window_minutes,
          free_cancellation_hours, late_cancellation_refund_bp, no_show_refund_bp, minimum_spend_idr,
          default_duration_minutes, slot_interval_minutes, is_active)
       VALUES ($1, $2, '885a-dp', 'required', $3, 60, 24, 5000, 0, 0, 90, 30, true)`,
      [seededTenantId, seededOutletA, DP_IDR],
    );
  });
});

afterAll(async () => {
  setReservationDepositPort(null);
  setPaymentGateway(null);
  await asOwner(async (client) => {
    const links = (
      await client.query<{ id: string }>(
        "SELECT deposit_payment_link_id AS id FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2) AND deposit_payment_link_id IS NOT NULL",
        [seededTenantId, zoneIds],
      )
    ).rows.map((row) => row.id);
    const rsv = `(SELECT id FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2))`;
    for (const table of [
      "reservation_deposit_allocations",
      "reservation_tables",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND reservation_id IN ${rsv}`,
        [seededTenantId, zoneIds],
      );
    await client.query(
      `DELETE FROM reservation_idempotency WHERE tenant_id = $1 AND (reservation_id IN ${rsv} OR reservation_id IS NULL)`,
      [seededTenantId, zoneIds],
    );
    await client.query(
      "DELETE FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2)",
      [seededTenantId, zoneIds],
    );
    await client.query(
      "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, seededOutletA],
    );
    const intents = `(SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[]))`;
    for (const table of [
      "payment_refunds",
      "payment_evidence",
      "payment_unallocated_funds",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND payment_intent_id IN ${intents}`,
        [seededTenantId, links],
      );
    await client.query(
      "DELETE FROM payment_admin_idempotency WHERE tenant_id = $1 AND key LIKE 'reservation-refund:%'",
      [seededTenantId],
    );
    await client.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      [seededTenantId, links],
    );
    await client.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [seededTenantId, links],
    );
  });
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await owner.end();
});

// ------------------------------------------------------------------- helpers

const key = () => `rsv-885a-${randomUUID()}`;
let nextDay = 1;

async function newBooking(): Promise<ReservationCreated> {
  const zone = await createZone(staff.client);
  zoneIds.push(zone.id);
  const table = await createTable(staff.client, { zoneId: zone.id });
  tableIds.push(table.id);
  const date = `2027-12-${String(nextDay++).padStart(2, "0")}`;
  return createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: zonedInstant(date, "19:00", WIB).toISOString(),
      pax: 2,
      zoneId: zone.id,
      guestName: "Tamu DP Bukti",
      contactPhone: "081234567890",
    }),
    key(),
  );
}

const tokenOf = (created: ReservationCreated) =>
  created.deposit!.paymentPath.slice("/bayar/".length);

async function openQr(created: ReservationCreated) {
  return createIntent(
    tenantScope(),
    tokenOf(created),
    createPaymentIntentInputSchema.parse({
      method: "qris",
      channelCode: null,
      idempotencyKey: `rsv-885a-qr-${randomUUID()}`,
    }),
  );
}

async function openVa(created: ReservationCreated) {
  return createIntent(
    tenantScope(),
    tokenOf(created),
    createPaymentIntentInputSchema.parse({
      method: "va",
      channelCode: "bmri",
      idempotencyKey: `rsv-885a-va-${randomUUID()}`,
    }),
  );
}

type Closer = "cancel" | "no_show";

function close(created: ReservationCreated, how: Closer = "cancel") {
  return settleCall(
    how === "cancel"
      ? cancelReservation(
          tenantScope(),
          staff.userId,
          outletA,
          created.reservation.id,
          cancelReservationInputSchema.parse({ reason: "Tamu batal" }),
          key(),
        )
      : markReservationNoShow(
          tenantScope(),
          staff.userId,
          outletA,
          created.reservation.id,
          markNoShowInputSchema.parse({ note: "Tamu tidak datang" }),
          key(),
        ),
  );
}

async function reservationRow(id: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ status: string; deposit_payment_id: string | null }>(
      "SELECT status, deposit_payment_id FROM reservations WHERE id = $1",
      [id],
    ),
  );
  return rows[0]!;
}

async function liveHolds(reservationId: string) {
  const { rows } = await asOwner((client) =>
    client.query(
      "SELECT 1 FROM reservation_tables WHERE reservation_id = $1 AND released_at IS NULL",
      [reservationId],
    ),
  );
  return rows.length;
}

/** The provider's payment of `intentId` reaches the reservation consumer, replayed. */
async function deliverNotices(intentId: string) {
  await providerWebhook(tenantScope(), seededTenantId, intentId, DP_IDR);
  for (const event of await paidEventsOf(seededTenantId, intentId))
    for (let i = 0; i < 2; i += 1)
      await handlePaymentPaid(tenantScope(), event);
}

async function expectHeld(created: ReservationCreated, label: string) {
  expectUnconfirmedError(await close(created), label);
  expect((await reservationRow(created.reservation.id)).status).toBe(
    "pending_deposit",
  );
  expect(await liveHolds(created.reservation.id)).toBe(1);
}

/** The QR is paid after the close was refused: DP applied or returned once. */
async function expectPaidQrAccountedOnce(
  created: ReservationCreated,
  intentId: string,
) {
  gateway.script(intentId, { rawStatus: "00", amountIdr: DP_IDR });
  await deliverNotices(intentId);
  const row = await reservationRow(created.reservation.id);
  expect(
    row.status,
    "a refused close must not have cancelled the reservation",
  ).not.toBe("cancelled");
  expectMoneyOnce(
    "paid DP code",
    await moneyOfIntent(seededTenantId, intentId),
    DP_IDR,
    row.status === "confirmed" && row.deposit_payment_id === intentId,
  );
}

async function openFunds(intentId: string) {
  const { rows } = await owner.query<{ n: number; sum: number }>(
    `SELECT count(*)::int AS n, coalesce(sum(amount_idr),0)::int AS sum
       FROM payment_unallocated_funds
      WHERE tenant_id = $1 AND payment_intent_id = $2 AND resolved_at IS NULL`,
    [seededTenantId, intentId],
  );
  return rows[0]!;
}

// --------------------------------------------------------------------- tests

describe("legend-m7tnt DP proof is fail closed: provider pending holds the close", () => {
  for (const how of ["cancel", "no_show"] as const) {
    it(`pending QR, provider pending BEFORE expiry + margin: ${how} is held; the QR is then paid and the DP is accounted once`, async () => {
      const created = await newBooking();
      const qr = await openQr(created);
      expect((await intentInfo(seededTenantId, qr.id)).status).toBe("pending");
      gateway.script(qr.id, { rawStatus: "01" });

      expectUnconfirmedError(await close(created, how), `pending, ${how}`);
      expect((await reservationRow(created.reservation.id)).status).toBe(
        "pending_deposit",
      );
      expect(await liveHolds(created.reservation.id)).toBe(1);
      await expectLinkActive(seededTenantId, qr.id, "pending provider");
      expectNoMoneyMoved("held", await moneyOfIntent(seededTenantId, qr.id));

      await expectPaidQrAccountedOnce(created, qr.id);
    });
  }

  it("pending QR, provider STILL pending AFTER expiry + margin: the close is held (local time is no proof); QR paid afterwards is accounted once", async () => {
    const created = await newBooking();
    const qr = await openQr(created);
    await backdateIntentExpiry(seededTenantId, qr.id);
    gateway.script(qr.id, { rawStatus: "01" });

    await expectHeld(created, "pending past expiry + margin");
    expectNoMoneyMoved("held", await moneyOfIntent(seededTenantId, qr.id));

    await expectPaidQrAccountedOnce(created, qr.id);
  });

  it("superseded QR (expired locally), provider STILL pending after expiry + margin, new code proven dead: held", async () => {
    const created = await newBooking();
    const a = await openQr(created);
    // legend-osqou.41 (1bdbf0a8b): a DP link takes no second code while the
    // first is live; the old superseded state (expired, not final) is built by
    // closing A just long enough to issue B.
    await owner.query(
      "UPDATE payment_intents SET status = 'expired', provider_final_at = now() WHERE tenant_id = $1 AND id = $2",
      [seededTenantId, a.id],
    );
    const b = await openVa(created);
    await owner.query(
      "UPDATE payment_intents SET provider_final_at = NULL WHERE tenant_id = $1 AND id = $2",
      [seededTenantId, a.id],
    );
    expect((await intentInfo(seededTenantId, a.id)).status).toBe("expired");
    await backdateIntentExpiry(seededTenantId, a.id);
    await backdateIntentExpiry(seededTenantId, b.id);
    gateway.script(a.id, { rawStatus: "01" });
    gateway.script(b.id, { rawStatus: "02" });

    await expectHeld(created, "superseded, pending after margin");
    expectNoMoneyMoved("old code", await moneyOfIntent(seededTenantId, a.id));

    await expectPaidQrAccountedOnce(created, a.id);
  });

  it("failed intent (provider failure) whose code the provider still reports pending: held", async () => {
    const created = await newBooking();
    const qr = await openQr(created);
    await owner.query(
      "UPDATE payment_intents SET status = 'failed' WHERE tenant_id = $1 AND id = $2",
      [seededTenantId, qr.id],
    );
    await backdateIntentExpiry(seededTenantId, qr.id);
    gateway.script(qr.id, { rawStatus: "01" });

    await expectHeld(created, "failed locally, pending at provider");
  });

  for (const answer of PROVIDER_UNSURE) {
    it(`pending QR, provider unreachable or unsure (${JSON.stringify(answer)}) past expiry + margin: held`, async () => {
      const created = await newBooking();
      const qr = await openQr(created);
      await backdateIntentExpiry(seededTenantId, qr.id);
      gateway.script(qr.id, answer);

      await expectHeld(created, "unsure provider");
    });
  }

  it("control: provider final answer expired for every code past expiry + margin -> the reservation cancels", async () => {
    const created = await newBooking();
    const qr = await openQr(created);
    await backdateIntentExpiry(seededTenantId, qr.id);
    gateway.script(qr.id, { rawStatus: "02" });

    const closed = await close(created);
    expect(closed.ok, JSON.stringify(closed)).toBe(true);
    expect((await reservationRow(created.reservation.id)).status).toBe(
      "cancelled",
    );
    expect(await liveHolds(created.reservation.id)).toBe(0);
    expectNoMoneyMoved("dead code", await moneyOfIntent(seededTenantId, qr.id));
  });
});

describe("legend-m7tnt DP proof waits for unallocated funds of a failed intent", () => {
  /** DP Rp100.000; the guest paid Rp20.000 at the provider: intent failed,
   * Rp20.000 parked as unallocated funds (amount mismatch). */
  async function mismatchedDp() {
    const created = await newBooking();
    const qr = await openQr(created);
    const info = await intentInfo(seededTenantId, qr.id);
    await holdGatewayAmountMismatch(
      tenantScope(),
      qr.id,
      {
        providerRef: info.providerRef!,
        paidAmountIdr: PARKED_IDR,
        source: "webhook",
      },
      new Date(),
    );
    expect((await intentInfo(seededTenantId, qr.id)).status).toBe("failed");
    expect(await openFunds(qr.id)).toMatchObject({
      n: 1,
      sum: PARKED_IDR,
    });
    return { created, intentId: qr.id, providerRef: info.providerRef! };
  }

  async function resolveFund(intentId: string) {
    await owner.query(
      `UPDATE payment_unallocated_funds
          SET resolution = 'refund', resolved_by = 'test', resolved_at = now(),
              approval_ref = 'test-885a'
        WHERE tenant_id = $1 AND payment_intent_id = $2 AND resolved_at IS NULL`,
      [seededTenantId, intentId],
    );
  }

  for (const [label, answer] of [
    ["provider says the code is expired", { rawStatus: "02" }],
    [
      "provider says paid with the parked Rp20.000",
      { rawStatus: "00", amountIdr: PARKED_IDR },
    ],
  ] as const) {
    it(`Rp100.000 DP, Rp20.000 parked, intent failed, ${label}: close waits for the refund/credit; replays change nothing; then it closes with nothing owed twice`, async () => {
      const { created, intentId, providerRef } = await mismatchedDp();
      await backdateIntentExpiry(seededTenantId, intentId);
      gateway.script(intentId, answer);

      // The decision is held, again and again.
      await expectHeld(created, "unresolved mismatch fund");
      await expectHeld(created, "unresolved mismatch fund, retry");
      // Replay of the same mismatch parks nothing more.
      await holdGatewayAmountMismatch(
        tenantScope(),
        intentId,
        {
          providerRef,
          paidAmountIdr: PARKED_IDR,
          source: "webhook",
        },
        new Date(),
      );
      expect(await openFunds(intentId)).toMatchObject({
        n: 1,
        sum: PARKED_IDR,
      });
      const money = await moneyOfIntent(seededTenantId, intentId);
      expect(money.refundCount, "no refund from a held close").toBe(0);
      expect(money.parkedIdr).toBe(PARKED_IDR);

      // Reconciled (refunded/credited): the close goes through.
      await resolveFund(intentId);
      const closed = await close(created);
      expect(closed.ok, JSON.stringify(closed)).toBe(true);
      expect((await reservationRow(created.reservation.id)).status).toBe(
        "cancelled",
      );
      const after = await moneyOfIntent(seededTenantId, intentId);
      expect(after.fundCount, "the fund is not parked again").toBe(1);
      expect(after.parkedIdr).toBeLessThanOrEqual(PARKED_IDR);
      expect(after.refundsIdr).toBeLessThanOrEqual(PARKED_IDR);
    });
  }

  it("a mismatch fund that arrives after the provider proof but before the close commits still holds the close (re-check under the lock)", async () => {
    const created = await newBooking();
    const qr = await openQr(created);
    await backdateIntentExpiry(seededTenantId, qr.id);
    // The provider proves the code dead for the pre-check ...
    gateway.script(qr.id, { rawStatus: "02" });
    // ... and the mismatch lands while the close is running: the first provider
    // read triggers it, the transaction then sees the open fund.
    const info = await intentInfo(seededTenantId, qr.id);
    const realGetStatus = gateway.getStatus.bind(gateway);
    gateway.getStatus = async (input) => {
      const answer = await realGetStatus(input);
      gateway.getStatus = realGetStatus;
      await holdGatewayAmountMismatch(
        tenantScope(),
        qr.id,
        {
          providerRef: info.providerRef!,
          paidAmountIdr: PARKED_IDR,
          source: "webhook",
        },
        new Date(),
      );
      return answer;
    };

    await expectHeld(created, "fund parked between proof and close");
    expect((await openFunds(qr.id)).n).toBe(1);
  });
});
