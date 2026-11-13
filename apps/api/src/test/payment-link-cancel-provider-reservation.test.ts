// legend-ukbq3, call site: reservation cancel closes the unpaid DP link
// (reservation-lifecycle). FAIL-FIRST: today the cancel closes the link and the
// pending intent LOCALLY without asking the provider, so a guest who already
// paid becomes a refund and an unreachable provider is ignored.
//
// Written from docs/briefs/ukbq3-payment-link-cancel.md (founder Q93 rules) and
// the public service contract, not from the cancel implementation. Real
// services and PostgreSQL; only the gateway is a scripted test double.
//
// Assumptions where the brief is silent:
// - "Provider already holds the money" = the status read answers raw "00".
//   The cancel may then (a) refuse (409 / held, reservation stays
//   pending_deposit, the later notice confirms it) or (b) take the payment as a
//   paid DP and cancel under the policy (full refund requested once). Both are
//   accepted; closing the intent locally as expired/failed is not.
// - "Unsure" = status read timeout, 5xx, or an answer about another provider
//   reference. The cancel must hold (design): rejects with 409
//   PAYMENT_PROVIDER_UNCONFIRMED, reservation stays pending_deposit with its
//   table held, link and intent stay open, no refund, nothing parked.
// - Control: the provider says expired (raw "02") and the QR is long past its
//   life (past the 60 s margin) -> local close is allowed. No intent opened ->
//   closes at once with no provider call.
// - A pending (raw "01") answer before expiry is not tested: the brief does
//   not say whether that waits.
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
  expectIntentOpen,
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
    label: "Rsv Cancel Provider",
  });
  gateway = installScriptedGateway();
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
       VALUES ($1, $2, 'ukbq3-dp', 'required', $3, 60, 24, 5000, 0, 0, 90, 30, true)`,
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

const key = () => `rsv-ukbq3-${randomUUID()}`;
let nextDay = 1;

/** A free table and a booking date nobody else uses. */
async function newBooking(): Promise<ReservationCreated> {
  const zone = await createZone(staff.client);
  zoneIds.push(zone.id);
  const table = await createTable(staff.client, { zoneId: zone.id });
  tableIds.push(table.id);
  const date = `2027-09-${String(nextDay++).padStart(2, "0")}`;
  return createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: zonedInstant(date, "19:00", WIB).toISOString(),
      pax: 2,
      zoneId: zone.id,
      guestName: "Tamu Batal DP",
      contactPhone: "081234567890",
    }),
    key(),
  );
}

/** The guest opened the hosted page and holds a live QR (no payment yet). */
async function openIntent(created: ReservationCreated): Promise<string> {
  const token = created.deposit!.paymentPath.slice("/bayar/".length);
  const intent = await createIntent(
    tenantScope(),
    token,
    createPaymentIntentInputSchema.parse({
      method: "qris",
      channelCode: null,
      idempotencyKey: `rsv-ukbq3-pay-${created.reservation.id}`,
    }),
  );
  return intent.id;
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
      close_reason: string | null;
      deposit_payment_id: string | null;
    }>(
      "SELECT status, close_reason, deposit_payment_id FROM reservations WHERE id = $1",
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

/** The provider's payment reaches the reservation consumer, replayed. */
async function deliverNotices(intentId: string) {
  await providerWebhook(tenantScope(), seededTenantId, intentId, DP_IDR);
  for (const event of await paidEventsOf(seededTenantId, intentId))
    for (let i = 0; i < 2; i += 1)
      await handlePaymentPaid(tenantScope(), event);
}

// --------------------------------------------------------------------- tests

describe("legend-ukbq3 reservation cancel follows the provider", () => {
  it("ukbq3-rsv-paid: provider already got the DP -> the QR is not closed locally and the DP is applied or returned once", async () => {
    const created = await newBooking();
    const intentId = await openIntent(created);
    gateway.script(intentId, { rawStatus: "00", amountIdr: DP_IDR });

    const cancelled = await cancel(created);
    // Not a server error either way: refusal (409) or a handled answer.
    if (!cancelled.ok) expect(cancelled.error.status ?? 500).toBeLessThan(500);

    // The provider was asked before anything closed.
    expect(
      gateway.readsOf(intentId).length,
      "cancel never asked the provider",
    ).toBeGreaterThanOrEqual(1);
    await expectIntentOpen(seededTenantId, intentId, "provider holds the DP");

    await deliverNotices(intentId);

    const row = await reservationRow(created.reservation.id);
    const applied =
      row.status === "confirmed" && row.deposit_payment_id === intentId;
    expectMoneyOnce(
      "reservation DP",
      await moneyOfIntent(seededTenantId, intentId),
      DP_IDR,
      applied,
    );
  });

  it("ukbq3-rsv-paid: cancelling again after the money arrived adds no second refund", async () => {
    const created = await newBooking();
    const intentId = await openIntent(created);
    gateway.script(intentId, { rawStatus: "00", amountIdr: DP_IDR });

    await cancel(created);
    await deliverNotices(intentId);
    await cancel(created);
    await cancel(created);
    await deliverNotices(intentId);

    const row = await reservationRow(created.reservation.id);
    expectMoneyOnce(
      "reservation DP after repeated cancels",
      await moneyOfIntent(seededTenantId, intentId),
      DP_IDR,
      row.status === "confirmed" && row.deposit_payment_id === intentId,
    );
  });

  for (const answer of PROVIDER_UNSURE) {
    it(`ukbq3-rsv-unsure: provider answer ${JSON.stringify(answer)} -> 409 PAYMENT_PROVIDER_UNCONFIRMED: reservation, table, link and QR stay, no refund`, async () => {
      const created = await newBooking();
      const intentId = await openIntent(created);
      // Long past its life: only the provider's word may close it.
      await backdateIntentExpiry(seededTenantId, intentId);
      gateway.script(intentId, answer);

      const cancelled = await cancel(created);
      expectUnconfirmedError(cancelled, "unsure provider");

      expect(
        gateway.readsOf(intentId).length,
        "cancel never asked the provider",
      ).toBeGreaterThanOrEqual(1);
      await expectLinkActive(seededTenantId, intentId, "unsure provider");
      const row = await reservationRow(created.reservation.id);
      expect(row.status).toBe("pending_deposit");
      expect(await liveHolds(created.reservation.id)).toBe(1);
      expect((await intentInfo(seededTenantId, intentId)).status).toBe(
        "pending",
      );
      expectNoMoneyMoved(
        "unsure provider",
        await moneyOfIntent(seededTenantId, intentId),
      );
    });
  }

  it("ukbq3-rsv-expired: provider says expired and the QR is long past its life -> the reservation cancels, nothing is owed", async () => {
    const created = await newBooking();
    const intentId = await openIntent(created);
    await backdateIntentExpiry(seededTenantId, intentId);
    gateway.script(intentId, { rawStatus: "02" });

    const cancelled = await cancel(created);
    expect(cancelled.ok, JSON.stringify(cancelled)).toBe(true);

    expect(gateway.readsOf(intentId).length).toBeGreaterThanOrEqual(1);
    expect((await reservationRow(created.reservation.id)).status).toBe(
      "cancelled",
    );
    expect(await liveHolds(created.reservation.id)).toBe(0);
    // The link is closed; the gateway code past its expiry stays `pending` on
    // purpose (the poller may still settle a late payment).
    await expectLinkClosed(seededTenantId, intentId, "provider expired");
    expect((await intentInfo(seededTenantId, intentId)).status).not.toBe(
      "paid",
    );
    expectNoMoneyMoved(
      "provider expired",
      await moneyOfIntent(seededTenantId, intentId),
    );
  });

  it("ukbq3-rsv-empty: no QR was ever opened -> cancels at once without asking the provider", async () => {
    const created = await newBooking();
    const readsBefore = gateway.statusReads.length;

    const cancelled = await cancel(created);
    expect(cancelled.ok, JSON.stringify(cancelled)).toBe(true);

    expect((await reservationRow(created.reservation.id)).status).toBe(
      "cancelled",
    );
    expect(await liveHolds(created.reservation.id)).toBe(0);
    expect(gateway.statusReads).toHaveLength(readsBefore);
  });
});
