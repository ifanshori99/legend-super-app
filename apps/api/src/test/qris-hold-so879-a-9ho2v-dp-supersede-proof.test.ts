// legend-9ho2v (SO-879 second opinion, card A): reservation cancel asks the
// provider about EVERY DP code that may still hold money, not only the pending
// one. A DP QR that was superseded locally (guest switched method, the old code
// is `expired` in our books) can still be paid at the provider.
//
// Written from docs/briefs/so-879-qris-hold-fix.md (CTO decision) and the
// fourth finding of docs/qa/second-opinion-qris-hold.md:
// "provider-proof checks all provider intents of the bill/reservation that may
//  hold money (pending, expired locally, superseded), fails closed when not yet
//  proven; reservation cancel waits for reconciliation before deciding
//  refund/forfeit."
// Same rules and helpers as payment-link-cancel-provider-reservation.test.ts
// (founder Q93: provider asked first; money received -> not closed locally;
// unsure -> hold 409 PAYMENT_PROVIDER_UNCONFIRMED; nobody paid twice).
//
// Assumptions:
// - Code A = QRIS DP, then the guest switches to a VA (code B). That makes A
//   `expired` locally and B `pending` (precondition asserted in each test).
// - Provider already holds the DP of A ("00"): cancel either refuses (held) or
//   takes the payment into account and cancels under the policy; both are
//   accepted, but A MUST be read from the provider before anything closes and
//   the money of A ends accounted once (applied, or returned/parked in full
//   once). Nothing for B (never paid).
// - Unsure about A (timeout / 5xx / answer about another reference) while B is
//   proven dead: cancel is held (409 PAYMENT_PROVIDER_UNCONFIRMED); reservation
//   stays pending_deposit with its table; no refund, nothing parked.
// - Control: both A and B proven expired by the provider, past the 60 s margin:
//   the reservation cancels and nothing is owed.
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
  type ReservationCreated,
} from "@starter/shared/reservation";
import { createApp } from "../app";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { createIntent } from "../services/payment.service.ts";
import { createReservation } from "../services/reservation-booking.ts";
import { handlePaymentPaid } from "../services/reservation-consumers.ts";
import { createPaymentReservationDepositPort } from "../services/reservation-deposit-payment.ts";
import { cancelReservation } from "../services/reservation-lifecycle.ts";
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
  expectLinkClosed,
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

const WIB = "Asia/Jakarta";
const DP_IDR = 100_000;
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

/** The scripted gateway also offers one VA bank, so the guest can switch. */
function enableVa(gateway: ScriptedGateway) {
  const create = gateway.createIntent.bind(gateway);
  gateway.createIntent = async (input) => {
    const base = await create(input);
    return input.method === "va"
      ? {
          ...base,
          instructions: {
            method: "va" as const,
            channelCode: input.channelCode ?? "bmri",
            channelName: "Mandiri",
            virtualAccountNumber: "8808123456789012",
          },
        }
      : base;
  };
  (
    gateway as unknown as {
      channels: (c: unknown, method: string) => Promise<unknown[]>;
    }
  ).channels = async (_context, method) =>
    method === "va" ? [{ code: "bmri", name: "Mandiri" }] : [];
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
    label: "Rsv 9ho2v Proof",
  });
  gateway = installScriptedGateway();
  enableVa(gateway);
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
       VALUES ($1, $2, '9ho2v-dp', 'required', $3, 60, 24, 5000, 0, 0, 90, 30, true)`,
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

const key = () => `rsv-9ho2v-${randomUUID()}`;
let nextDay = 1;

async function newBooking(): Promise<ReservationCreated> {
  const zone = await createZone(staff.client);
  zoneIds.push(zone.id);
  const table = await createTable(staff.client, { zoneId: zone.id });
  tableIds.push(table.id);
  const date = `2027-11-${String(nextDay++).padStart(2, "0")}`;
  return createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: zonedInstant(date, "19:00", WIB).toISOString(),
      pax: 2,
      zoneId: zone.id,
      guestName: "Tamu DP Lama",
      contactPhone: "081234567890",
    }),
    key(),
  );
}

/** Guest opens QR (code A), then switches to a VA (code B): A is superseded. */
async function supersededDp(created: ReservationCreated) {
  const token = created.deposit!.paymentPath.slice("/bayar/".length);
  const a = await createIntent(
    tenantScope(),
    token,
    createPaymentIntentInputSchema.parse({
      method: "qris",
      channelCode: null,
      idempotencyKey: `rsv-9ho2v-a-${created.reservation.id}`,
    }),
  );
  const b = await createIntent(
    tenantScope(),
    token,
    createPaymentIntentInputSchema.parse({
      method: "va",
      channelCode: "bmri",
      idempotencyKey: `rsv-9ho2v-b-${created.reservation.id}`,
    }),
  );
  expect(b.id, "the switch must open a second code").not.toBe(a.id);
  expect(
    (await intentInfo(seededTenantId, a.id)).status,
    "precondition: the old QR is expired locally after the switch",
  ).toBe("expired");
  expect((await intentInfo(seededTenantId, b.id)).status).toBe("pending");
  return { aId: a.id, bId: b.id };
}

function cancel(created: ReservationCreated) {
  return settleCall(
    cancelReservation(
      tenantScope(),
      staff.userId,
      outletA,
      created.reservation.id,
      cancelReservationInputSchema.parse({ reason: "Tamu batal" }),
      key(),
    ),
  );
}

async function reservationRow(id: string) {
  const { rows } = await asOwner((client) =>
    client.query<{
      status: string;
      deposit_payment_id: string | null;
    }>("SELECT status, deposit_payment_id FROM reservations WHERE id = $1", [
      id,
    ]),
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

// --------------------------------------------------------------------- tests

describe("legend-9ho2v reservation cancel checks the superseded DP code at the provider", () => {
  it("legend-9ho2v old QR expired locally but PAID at the provider, new code pending: the old code is read before anything closes; its DP is accounted once, nothing for the new code", async () => {
    const created = await newBooking();
    const { aId, bId } = await supersededDp(created);
    gateway.script(aId, { rawStatus: "00", amountIdr: DP_IDR });
    gateway.script(bId, { rawStatus: "01" });

    const cancelled = await cancel(created);
    if (!cancelled.ok) expect(cancelled.error.status ?? 500).toBeLessThan(500);

    expect(
      gateway.readsOf(aId).length,
      "the superseded (expired locally) DP code was never asked at the provider",
    ).toBeGreaterThanOrEqual(1);

    // The webhook of the old code arrives late.
    await deliverNotices(aId);

    const row = await reservationRow(created.reservation.id);
    expectMoneyOnce(
      "old DP code",
      await moneyOfIntent(seededTenantId, aId),
      DP_IDR,
      row.status === "confirmed" && row.deposit_payment_id === aId,
    );
    expectNoMoneyMoved(
      "new code never paid",
      await moneyOfIntent(seededTenantId, bId),
    );
  });

  for (const answer of PROVIDER_UNSURE) {
    it(`legend-9ho2v old code unsure (${JSON.stringify(answer)}) while the new code is proven dead: cancel is held 409 PAYMENT_PROVIDER_UNCONFIRMED, reservation, table and link stay, no refund`, async () => {
      const created = await newBooking();
      const { aId, bId } = await supersededDp(created);
      await backdateIntentExpiry(seededTenantId, aId);
      await backdateIntentExpiry(seededTenantId, bId);
      gateway.script(aId, answer);
      gateway.script(bId, { rawStatus: "02" });

      const cancelled = await cancel(created);
      expectUnconfirmedError(cancelled, "unsure old DP code");

      expect(
        gateway.readsOf(aId).length,
        "the superseded DP code was never asked at the provider",
      ).toBeGreaterThanOrEqual(1);
      await expectLinkActive(seededTenantId, bId, "unsure old DP code");
      expect((await reservationRow(created.reservation.id)).status).toBe(
        "pending_deposit",
      );
      expect(await liveHolds(created.reservation.id)).toBe(1);
      expectNoMoneyMoved("old code", await moneyOfIntent(seededTenantId, aId));
      expectNoMoneyMoved("new code", await moneyOfIntent(seededTenantId, bId));
    });
  }

  it("legend-9ho2v control: old and new code both proven expired by the provider past the margin -> the reservation cancels, nothing owed", async () => {
    const created = await newBooking();
    const { aId, bId } = await supersededDp(created);
    await backdateIntentExpiry(seededTenantId, aId);
    await backdateIntentExpiry(seededTenantId, bId);
    gateway.script(aId, { rawStatus: "02" });
    gateway.script(bId, { rawStatus: "02" });

    const cancelled = await cancel(created);
    expect(cancelled.ok, JSON.stringify(cancelled)).toBe(true);

    expect(gateway.readsOf(aId).length).toBeGreaterThanOrEqual(1);
    expect(gateway.readsOf(bId).length).toBeGreaterThanOrEqual(1);
    expect((await reservationRow(created.reservation.id)).status).toBe(
      "cancelled",
    );
    expect(await liveHolds(created.reservation.id)).toBe(0);
    await expectLinkClosed(seededTenantId, bId, "both codes dead");
    expectNoMoneyMoved("old code", await moneyOfIntent(seededTenantId, aId));
    expectNoMoneyMoved("new code", await moneyOfIntent(seededTenantId, bId));
  });
});
