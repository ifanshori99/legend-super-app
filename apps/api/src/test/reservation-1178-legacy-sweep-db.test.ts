// legend-chmz2 (1178 kartu 2): legacy DP bookings whose provider code never got
// a final answer must not starve the deposit sweep. Against PostgreSQL with the
// real booking, deposit port, deposit sweep and payment confirmation; only the
// gateway is a double.
//
// A "legacy" booking (pre-0049) has no DP link (`deposit_payment_link_id` NULL)
// and points at its code through `deposit_payment_id`. Behavior under test:
//  1. 120 legacy bookings whose code has a provider reference, no final answer
//     and is past the poll window cap stay `pending_deposit` with their hold
//     (nothing in the system can finish them), but they must not fill the
//     default sweep batch (LIMIT 100, oldest first): a newer normally due
//     booking (no code) is still cancelled and its hold released, across
//     repeated sweeps with the default limit.
//  2. A legacy booking whose code is PAID is still confirmed by the sweep, even
//     though it is newer than the 120 and would sit behind them in the batch.
//  3. A due booking of another outlet is untouched by an outlet-scoped sweep
//     (and is cancelled once its own outlet is swept, proving it was due).
//
// Assumptions (spec silent): payableUntil = booking creation + the policy
// payment window (60 min); the cap is payableUntil + GATEWAY_POLL_WINDOW_MS;
// the sweep clock is one hour after the cap. The consumer of payment.paid has
// not run (worker behind), so the paid legacy booking is still pending_deposit
// until the sweep reconciles it. The second outlet is a copy of an outlet A
// zone/table/policy made with SQL because the floor API only creates rows in
// the caller's first outlet.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createPaymentIntentInputSchema } from "@starter/shared/payment";
import { createReservationInputSchema } from "@starter/shared/reservation";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  setPaymentGateway,
  type GatewayIntent,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import {
  confirmPayment,
  createIntent,
  GATEWAY_POLL_WINDOW_MS,
} from "../services/payment.service.ts";
import { createReservation } from "../services/reservation-booking.ts";
import { createPaymentReservationDepositPort } from "../services/reservation-deposit-payment.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import { setReservationDepositPort } from "../services/reservation-ports.ts";
import { sweepStaleDepositHolds } from "../services/reservation-sweeps.ts";
import {
  createTable,
  createZone,
  dropFloorRows,
  owner,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";

const WIB = "Asia/Jakarta";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DP_IDR = 100_000;
const WINDOW_MIN = 60;
const LEGACY_COUNT = 120; // more than the default sweep batch of 100
const outletA = outletIdSchema.parse(seededOutletA);
const outletB = outletIdSchema.parse(seededOutletB);
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

/** Provider double: one code (with a provider reference) per idempotency key. */
class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  private readonly byKey = new Map<string, GatewayIntent>();
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest): Promise<GatewayIntent> {
    const cached = this.byKey.get(input.idempotencyKey);
    if (cached) return cached;
    const created: GatewayIntent = {
      providerRef: `FAKE-DP-${randomUUID()}`,
      instructions: {
        method: "qris",
        qrPayload: "00020101021226FAKEDP",
        issuer: null,
      },
      expiresAt: input.expiresAt,
    };
    this.byKey.set(input.idempotencyKey, created);
    return created;
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: "pending" as const,
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
  async channels() {
    return [];
  }
}

let app: ReturnType<typeof createApp>;
let staff: Staff;
const zoneIds: string[] = [];
const tableIds: string[] = [];
const linkIds: string[] = [];

async function setPolicy(outletId: string) {
  await asOwner(async (client) => {
    await client.query(
      "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, outletId],
    );
    await client.query(
      `INSERT INTO reservation_policies
         (tenant_id, outlet_id, version, deposit_requirement, deposit_amount_idr, payment_window_minutes,
          free_cancellation_hours, late_cancellation_refund_bp, no_show_refund_bp, minimum_spend_idr,
          default_duration_minutes, slot_interval_minutes, is_active)
       VALUES ($1, $2, 'chmz2-legacy', 'required', $3, $4, 24, 5000, 0, 0, 90, 30, true)`,
      [seededTenantId, outletId, DP_IDR, WINDOW_MIN],
    );
  });
}

/** Copy one row of `table` with some columns replaced by (trusted) SQL literals. */
async function cloneRow(
  client: PoolClient,
  table: string,
  id: string,
  overrides: Record<string, string>,
) {
  const { rows } = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND is_generated = 'NEVER'
      ORDER BY ordinal_position`,
    [table],
  );
  const columns = rows.map((row) => `"${row.column_name}"`);
  const values = rows.map((row) =>
    row.column_name in overrides
      ? overrides[row.column_name]!
      : `"${row.column_name}"`,
  );
  await client.query(
    `INSERT INTO ${table} (${columns.join(", ")}) SELECT ${values.join(", ")} FROM ${table} WHERE id = $1`,
    [id],
  );
}

async function floor() {
  const zone = await createZone(staff.client);
  zoneIds.push(zone.id);
  const table = await createTable(staff.client, { zoneId: zone.id });
  tableIds.push(table.id);
  return zone.id as string;
}

/** A zone with one table in outlet B (copy of a fresh outlet A zone/table). */
async function floorInOutletB() {
  const sourceZone = await createZone(staff.client);
  zoneIds.push(sourceZone.id);
  const sourceTable = await createTable(staff.client, {
    zoneId: sourceZone.id,
  });
  tableIds.push(sourceTable.id);
  const zoneId = randomUUID();
  const tableId = randomUUID();
  await asOwner(async (client) => {
    await cloneRow(client, "floor_zones", sourceZone.id, {
      id: `'${zoneId}'::uuid`,
      outlet_id: `'${seededOutletB}'::uuid`,
      name: `'Zona B ${zoneId.slice(0, 8)}'`,
    });
    await cloneRow(client, "tables", sourceTable.id, {
      id: `'${tableId}'::uuid`,
      outlet_id: `'${seededOutletB}'::uuid`,
      zone_id: `'${zoneId}'::uuid`,
      code: `'B-${tableId.slice(0, 6).toUpperCase()}'`,
    });
  });
  zoneIds.push(zoneId);
  tableIds.push(tableId);
  return zoneId;
}

const dayAt = (date: string, time: string) => zonedInstant(date, time, WIB);
const key = () => `rsv-chmz2-${randomUUID()}`;

async function bookIn(
  outletId: typeof outletA,
  zoneId: string,
  date: string,
  createdAt: Date,
) {
  const created = await createReservation(
    tenantScope(),
    outletId,
    createReservationInputSchema.parse({
      reservedFor: dayAt(date, "19:00").toISOString(),
      pax: 2,
      zoneId,
      guestName: "Tamu Legacy chmz2",
      contactPhone: "081234567890",
    }),
    key(),
    createdAt,
  );
  linkIds.push(created.deposit!.paymentLinkId);
  return created;
}
type Booked = Awaited<ReturnType<typeof bookIn>>;

/** The guest opens the hosted page and a QRIS code is created on the DP link. */
async function openIntent(created: Booked): Promise<string> {
  const token = created.deposit!.paymentPath.slice("/bayar/".length);
  const intent = await createIntent(
    tenantScope(),
    token,
    createPaymentIntentInputSchema.parse({
      method: "qris",
      channelCode: null,
      idempotencyKey: `rsv-chmz2-pay-${created.reservation.id}`,
    }),
  );
  return intent.id;
}

/** Sweep at `now`; no limit option, so the default batch applies. */
async function sweepAt(now: Date, outletId: typeof outletA) {
  return withTenant(db, tenantScope(), (tx) =>
    sweepStaleDepositHolds(tx, tenantScope(), now, { outletId }),
  );
}

async function reservationRow(id: string) {
  const { rows } = await asOwner((client) =>
    client.query<{ status: string; close_reason: string | null }>(
      "SELECT status, close_reason FROM reservations WHERE id = $1",
      [id],
    ),
  );
  return rows[0]!;
}

async function liveHolds(reservationId: string): Promise<number> {
  const { rows } = await asOwner((client) =>
    client.query(
      "SELECT 1 FROM reservation_tables WHERE reservation_id = $1 AND released_at IS NULL",
      [reservationId],
    ),
  );
  return rows.length;
}

/** How many of `ids` are still pending_deposit and how many live holds they keep. */
async function stillPendingWithHold(ids: string[]) {
  const { rows } = await asOwner((client) =>
    client.query<{ pending: string; holds: string }>(
      `SELECT
         (SELECT count(*) FROM reservations WHERE id = ANY($1::uuid[]) AND status = 'pending_deposit')::text AS pending,
         (SELECT count(*) FROM reservation_tables WHERE reservation_id = ANY($1::uuid[]) AND released_at IS NULL)::text AS holds`,
      [ids],
    ),
  );
  return { pending: Number(rows[0]!.pending), holds: Number(rows[0]!.holds) };
}

/** Turns a normal booking into a pre-0049 one: no DP link, code via deposit_payment_id. */
async function makeLegacy(reservationIds: string[], intentIds: string[]) {
  await asOwner((client) =>
    client.query(
      `UPDATE reservations r
          SET deposit_payment_link_id = NULL,
              deposit_payment_id = x.intent_id,
              deposit_link_expires_at = r.created_at + interval '60 minutes'
         FROM unnest($1::uuid[], $2::uuid[]) AS x(reservation_id, intent_id)
        WHERE r.id = x.reservation_id`,
      [reservationIds, intentIds],
    ),
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  staff = await staffWithRole(app, {
    template: "owner",
    label: "Rsv chmz2 legacy",
  });
  setPaymentGateway(new FakeGateway());
  setReservationDepositPort(createPaymentReservationDepositPort());
  await setPolicy(seededOutletA);
  await setPolicy(seededOutletB);
});

afterAll(async () => {
  setReservationDepositPort(null);
  setPaymentGateway(null);
  await asOwner(async (client) => {
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
    for (const outletId of [seededOutletA, seededOutletB])
      await client.query(
        "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
        [seededTenantId, outletId],
      );
    const intents = `(SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[]))`;
    for (const table of [
      "payment_refunds",
      "payment_evidence",
      "payment_unallocated_funds",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND payment_intent_id IN ${intents}`,
        [seededTenantId, linkIds],
      );
    await client.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      [seededTenantId, linkIds],
    );
    await client.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [seededTenantId, linkIds],
    );
  });
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await owner.end();
});

describe("legend-chmz2 legacy unresolved DP bookings do not starve the deposit sweep", () => {
  it("legend-chmz2 120 legacy bookings with an unanswered code past the cap stay held, a newer due booking is cancelled, a paid legacy one is confirmed and another outlet is untouched", async () => {
    const t0 = dayAt("2027-01-20", "10:00");
    const zoneId = await floor();

    // 120 legacy bookings, the oldest of the tenant: code with a provider
    // reference, no final answer.
    const legacyIds: string[] = [];
    const legacyIntentIds: string[] = [];
    for (let i = 0; i < LEGACY_COUNT; i += 1) {
      const date = new Date(Date.UTC(2027, 2, 1 + i))
        .toISOString()
        .slice(0, 10);
      const created = await bookIn(outletA, zoneId, date, t0);
      legacyIds.push(created.reservation.id);
      legacyIntentIds.push(await openIntent(created));
    }
    await asOwner((client) =>
      client.query(
        `UPDATE payment_intents
            SET status = 'pending', expires_at = $2,
                provider_ref = 'PROV-' || id::text, provider_final_at = NULL
          WHERE id = ANY($1::uuid[])`,
        [legacyIntentIds, new Date(t0.getTime() + 30 * MINUTE)],
      ),
    );

    // One legacy booking whose DP was paid inside its window. Created a minute
    // after the 120, so it sits behind them in the oldest-first batch.
    const paid = await bookIn(
      outletA,
      await floor(),
      "2027-09-01",
      new Date(t0.getTime() + MINUTE),
    );
    const paidIntentId = await openIntent(paid);
    await asOwner((client) =>
      client.query("UPDATE payment_intents SET expires_at = $2 WHERE id = $1", [
        paidIntentId,
        new Date(t0.getTime() + 30 * MINUTE),
      ]),
    );
    await confirmPayment(
      tenantScope(),
      paidIntentId,
      {
        source: "verified_webhook",
        method: "qris",
        amountIdr: DP_IDR,
        providerRef: `PAID-${paidIntentId}`,
        at: new Date(t0.getTime() + 10 * MINUTE).toISOString(),
        receivedAt: new Date(t0.getTime() + 10 * MINUTE),
      },
      { type: "system" },
      new Date(t0.getTime() + 10 * MINUTE),
    );

    // A newer booking with no code: due 60 minutes after creation.
    const fresh = await bookIn(
      outletA,
      await floor(),
      "2027-09-02",
      new Date(t0.getTime() + 10 * MINUTE),
    );

    // A due booking of the other outlet (no code), created like the fresh one.
    const other = await bookIn(
      outletB,
      await floorInOutletB(),
      "2027-09-03",
      new Date(t0.getTime() + 10 * MINUTE),
    );

    // Make the 120 and the paid one legacy (no DP link).
    await makeLegacy(
      [...legacyIds, paid.reservation.id],
      [...legacyIntentIds, paidIntentId],
    );

    // Everything is past the cap (creation + 60 min window + 24 h poll window).
    const now = new Date(
      t0.getTime() + WINDOW_MIN * MINUTE + GATEWAY_POLL_WINDOW_MS + HOUR,
    );
    expect(await stillPendingWithHold(legacyIds)).toEqual({
      pending: LEGACY_COUNT,
      holds: LEGACY_COUNT,
    });
    expect((await reservationRow(paid.reservation.id)).status).toBe(
      "pending_deposit",
    );

    // Repeated sweeps with the default limit, scoped to outlet A.
    const first = await sweepAt(now, outletA);
    expect(first.released).toContain(fresh.reservation.id);
    expect(first.confirmed).toContain(paid.reservation.id);
    for (const id of legacyIds) {
      expect(first.released).not.toContain(id);
      expect(first.confirmed).not.toContain(id);
    }
    const second = await sweepAt(now, outletA);
    const third = await sweepAt(now, outletA);
    for (const result of [second, third]) {
      expect(result.released).toEqual([]);
      expect(result.confirmed).toEqual([]);
    }

    // The newer due booking is cancelled and its hold released.
    expect(await reservationRow(fresh.reservation.id)).toMatchObject({
      status: "cancelled",
      close_reason: "deposit_not_paid",
    });
    expect(await liveHolds(fresh.reservation.id)).toBe(0);

    // The paid legacy booking is confirmed and keeps its hold.
    expect(await reservationRow(paid.reservation.id)).toMatchObject({
      status: "confirmed",
      close_reason: null,
    });
    expect(await liveHolds(paid.reservation.id)).toBe(1);

    // The unresolved legacy bookings stay pending with their holds.
    expect(await stillPendingWithHold(legacyIds)).toEqual({
      pending: LEGACY_COUNT,
      holds: LEGACY_COUNT,
    });

    // The other outlet was not touched by the outlet A sweeps ...
    expect(await reservationRow(other.reservation.id)).toMatchObject({
      status: "pending_deposit",
      close_reason: null,
    });
    expect(await liveHolds(other.reservation.id)).toBe(1);

    // ... and it was due: its own outlet's sweep cancels it.
    const sweptB = await sweepAt(now, outletB);
    expect(sweptB.released).toContain(other.reservation.id);
    expect((await reservationRow(other.reservation.id)).status).toBe(
      "cancelled",
    );
    expect(await liveHolds(other.reservation.id)).toBe(0);
  }, 600_000);
});
