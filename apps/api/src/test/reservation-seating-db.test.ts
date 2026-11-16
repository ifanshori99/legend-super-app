// Reservation seating through the shared table-session service (legend-0twq,
// RSV-02; bead legend-t8bz rework). Real services + PostgreSQL: seating opens
// the same session a guest QR scan would join, refuses inactive zones, locks
// and checks every table of a multi-table party, and allocates the paid DP
// that `depositCreditForSession` reports for the bill.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { closeTableSessionInputSchema } from "@starter/shared/qr-order";
import {
  createReservationInputSchema,
  seatReservationInputSchema,
} from "@starter/shared/reservation";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { createReservation } from "../services/reservation-booking.ts";
import {
  depositCreditForSession,
  seatReservation,
} from "../services/reservation-lifecycle.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import {
  setReservationDepositPort,
  type ReservationDepositPort,
} from "../services/reservation-ports.ts";
import {
  closeTableSession,
  openOrJoinTableSession,
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

const outletA = outletIdSchema.parse(seededOutletA);
const tenantScope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
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
const zoneIds: string[] = [];
const tableIds: string[] = [];
const intentIds: string[] = [];
const linkIds: string[] = [];

/** A deposit port that opens the DP bill link like WS-05 (the intent comes when the guest pays). */
const depositPort: ReservationDepositPort = {
  async assertReady() {},
  async openDeposit(input) {
    const expiresAt = new Date(
      input.now.getTime() + input.expiresInMinutes * 60_000,
    );
    const linkId = randomUUID();
    await asOwner(async (client) => {
      await client.query(
        `INSERT INTO payment_links
           (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 'reservation-test')`,
        [
          linkId,
          seededTenantId,
          input.outletId,
          randomUUID().replaceAll("-", "").padEnd(64, "0"),
          `RSV-${linkId.slice(0, 8)}`,
          input.amountIdr,
        ],
      );
    });
    linkIds.push(linkId);
    return {
      paymentLinkId: linkId,
      paymentPath: `/bayar/${linkId}`,
      expiresAt: expiresAt.toISOString(),
    };
  },
};

async function setPolicy(requirement: "none" | "required", amount = 0) {
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
       VALUES ($1, $2, 'seat-1', $3, $4, 60, 24, 0, 0, 0, 90, 30, true)`,
      [seededTenantId, seededOutletA, requirement, amount],
    );
  });
}

async function floor(count: number) {
  const zone = await createZone(staff.client);
  zoneIds.push(zone.id);
  const tables: { id: string; token: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const table = await createTable(staff.client, { zoneId: zone.id });
    tableIds.push(table.id);
    tables.push({
      id: table.id,
      token: (await issueQr(staff.client, table.id)).token,
    });
  }
  return { zoneId: zone.id as string, tables };
}

const key = () => `seat-${randomUUID()}`;

async function book(zoneId: string, date: string, time = "19:00") {
  const created = await createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: zonedInstant(date, time, "Asia/Jakarta").toISOString(),
      pax: 2,
      zoneId,
      guestName: "Tamu Seat",
      contactPhone: "081234567890",
    }),
    key(),
  );
  return created;
}

const seat = (reservationId: string, ids: string[]) =>
  seatReservation(
    tenantScope(),
    staff.userId,
    outletA,
    reservationId,
    seatReservationInputSchema.parse({ tableIds: ids }),
    key(),
  );

async function sessionRows(ids: string[]) {
  const { rows } = await asOwner((client) =>
    client.query<{ id: string; table_id: string }>(
      "SELECT id, table_id FROM table_sessions WHERE tenant_id = $1 AND table_id = ANY($2)",
      [seededTenantId, ids],
    ),
  );
  return rows;
}

async function tableStatus(id: string): Promise<string> {
  const { rows } = await asOwner((client) =>
    client.query<{ status: string }>(
      "SELECT status FROM tables WHERE id = $1",
      [id],
    ),
  );
  return rows[0]!.status;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  staff = await staffWithRole(createApp(), {
    template: "owner",
    label: "Seat Owner",
  });
  setReservationDepositPort(depositPort);
  await setPolicy("none");
});

afterAll(async () => {
  setReservationDepositPort(null);
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
    await client.query(
      "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, seededOutletA],
    );
    await client.query(
      "DELETE FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = ANY($2)",
      [seededTenantId, intentIds],
    );
    await client.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND id = ANY($2)",
      [seededTenantId, intentIds],
    );
    await client.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2)",
      [seededTenantId, linkIds],
    );
  });
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await owner.end();
});

describe("RSV-02 staff-seated session shares WS-03 semantics", () => {
  it("RSV-02 a guest QR scan after reservation seating joins the same session", async () => {
    const f = await floor(1);
    const created = await book(f.zoneId, "2027-04-01");
    const seated = await seat(created.reservation.id, [f.tables[0]!.id]);
    expect(await tableStatus(f.tables[0]!.id)).toBe("occupied");

    const scanned = await openOrJoinTableSession(tenantScope(), {
      qrToken: f.tables[0]!.token,
      pax: 2,
      deviceHash: `device-${randomUUID()}`,
    });
    expect(scanned.outcome).toBe("joined");
    expect(scanned.session.id).toBe(seated.tableSessionId);
    expect(await sessionRows([f.tables[0]!.id])).toHaveLength(1);
  });

  it("RSV-02 seating on an inactive zone is refused and opens nothing", async () => {
    const f = await floor(1);
    const created = await book(f.zoneId, "2027-04-02");
    await asOwner((client) =>
      client.query("UPDATE floor_zones SET status = 'inactive' WHERE id = $1", [
        f.zoneId,
      ]),
    );
    await expect(
      seat(created.reservation.id, [f.tables[0]!.id]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await sessionRows([f.tables[0]!.id])).toHaveLength(0);
    expect(await tableStatus(f.tables[0]!.id)).not.toBe("occupied");
  });
});

describe("RSV-02 multi-table seating", () => {
  it("RSV-02 a busy second table refuses the whole seating (409) and opens nothing", async () => {
    const f = await floor(2);
    const [a, b] = f.tables as [(typeof f.tables)[0], (typeof f.tables)[0]];
    // A guest already sits at the second table.
    await openOrJoinTableSession(tenantScope(), {
      qrToken: b.token,
      pax: 2,
      deviceHash: `device-${randomUUID()}`,
    });
    const created = await book(f.zoneId, "2027-04-03");
    await expect(
      seat(created.reservation.id, [a.id, b.id]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await sessionRows([a.id])).toHaveLength(0);
    expect(await tableStatus(a.id)).not.toBe("occupied");
    expect(await sessionRows([b.id])).toHaveLength(1);
  });

  it("RSV-02 a party seated on two tables occupies both under one session", async () => {
    const f = await floor(2);
    const [a, b] = f.tables as [(typeof f.tables)[0], (typeof f.tables)[0]];
    const created = await book(f.zoneId, "2027-04-04");
    const seated = await seat(created.reservation.id, [b.id, a.id]);
    const rows = await sessionRows([a.id, b.id]);
    expect(rows).toEqual([
      expect.objectContaining({
        id: seated.tableSessionId,
        table_id: b.id,
      }),
    ]);
    expect(await tableStatus(a.id)).toBe("occupied");
    expect(await tableStatus(b.id)).toBe("occupied");
  });

  it("RSV-02 closing a two-table party's session frees the secondary table too", async () => {
    const f = await floor(2);
    const [a, b] = f.tables as [(typeof f.tables)[0], (typeof f.tables)[0]];
    const created = await book(f.zoneId, "2027-04-08");
    const seated = await seat(created.reservation.id, [b.id, a.id]);
    const closed = await closeTableSession(
      tenantScope(),
      seated.tableSessionId,
      closeTableSessionInputSchema.parse({
        tableCleaned: false,
        waiterConfirmedEmpty: true,
      }),
      staff.userId,
    );
    expect(closed.status).toBe("closed");
    // Not cleaned: both the primary and the secondary table need a wipe.
    expect(await tableStatus(b.id)).toBe("dirty");
    expect(await tableStatus(a.id)).toBe("dirty");
  });

  it("RSV-02 opposite table orders seated concurrently do not deadlock: exactly one wins", async () => {
    const f = await floor(2);
    const [a, b] = f.tables as [(typeof f.tables)[0], (typeof f.tables)[0]];
    const first = await book(f.zoneId, "2027-04-05", "12:00");
    const second = await book(f.zoneId, "2027-04-06", "12:00");
    const results = await Promise.allSettled([
      seat(first.reservation.id, [a.id, b.id]),
      seat(second.reservation.id, [b.id, a.id]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected");
    expect(lost).toMatchObject({ reason: { code: "CONFLICT" } });
    expect(await sessionRows([a.id, b.id])).toHaveLength(1);
  });
});

describe("RSV-02 DP credit on the bill", () => {
  it("legend-f7rnw seating waits for the deposit intent lock before reading its balance", async () => {
    await setPolicy("required", 150_000);
    const holder = await owner.connect();
    let seating: ReturnType<typeof seat> | undefined;
    try {
      const f = await floor(1);
      const created = await book(f.zoneId, "2027-04-07");
      const intentId = randomUUID();
      await asOwner(async (client) => {
        await client.query(
          `INSERT INTO payment_intents
             (id, tenant_id, outlet_id, payment_link_id, reservation_id, method, provider, amount_idr,
              idempotency_key, status, instructions, expires_at, paid_at)
           VALUES ($1, $2, $3, $4, $5, 'qris', 'duitku', 150000, $6, 'paid',
                   '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}', now() + interval '1 hour', now())`,
          [
            intentId,
            seededTenantId,
            outletA,
            created.deposit!.paymentLinkId,
            created.reservation.id,
            `seat-pay-${intentId}`,
          ],
        );
        await client.query(
          "UPDATE reservations SET status = 'confirmed', deposit_payment_id = $1 WHERE id = $2",
          [intentId, created.reservation.id],
        );
      });
      intentIds.push(intentId);
      await holder.query("BEGIN");
      await holder.query(
        "SELECT id FROM payment_intents WHERE id = $1 FOR UPDATE",
        [intentId],
      );
      await holder.query(
        "INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by) VALUES ($1, $2, $3, $4, 50000, 'Test refund', 'pending', 'seat-test')",
        [randomUUID(), seededTenantId, outletA, intentId],
      );
      const { rows } = await holder.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      let settled = false;
      seating = seat(created.reservation.id, [f.tables[0]!.id]);
      void seating.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      let blocked = false;
      for (let i = 0; i < 100 && !settled && !blocked; i += 1) {
        const result = await owner.query<{ blocked: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked",
          [rows[0]!.pid],
        );
        blocked = result.rows[0]!.blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await holder.query("COMMIT");
      const seated = await seating;
      const allocation = await asOwner((client) =>
        client.query<{ amount_idr: string }>(
          "SELECT amount_idr FROM reservation_deposit_allocations WHERE table_session_id = $1",
          [seated.tableSessionId],
        ),
      );
      expect(Number(allocation.rows[0]?.amount_idr)).toBe(100_000);
      expect(blocked, "seating must wait for the locked intent").toBe(true);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await seating?.catch(() => undefined);
      await setPolicy("none");
    }
  });

  it("RSV-02 seating allocates the paid DP and depositCreditForSession returns it", async () => {
    await setPolicy("required", 150_000);
    try {
      const f = await floor(1);
      const created = await book(f.zoneId, "2027-04-07");
      const intentId = randomUUID();
      await asOwner(async (client) => {
        await client.query(
          `INSERT INTO payment_intents
             (id, tenant_id, outlet_id, payment_link_id, reservation_id, method, provider, amount_idr,
              idempotency_key, status, instructions, expires_at, paid_at)
           VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', 150000, $6, 'paid',
                   '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}', now() + interval '1 hour', now())`,
          [
            intentId,
            seededTenantId,
            outletA,
            created.deposit!.paymentLinkId,
            created.reservation.id,
            `seat-pay-${intentId}`,
          ],
        );
        await client.query(
          "UPDATE payment_links SET paid_idr = total_idr WHERE id = $1",
          [created.deposit!.paymentLinkId],
        );
      });
      intentIds.push(intentId);
      const seated = await seat(created.reservation.id, [f.tables[0]!.id]);
      const credit = await withTenant(db, tenantScope(), (tx) =>
        depositCreditForSession(
          tx,
          tenantIdSchema.parse(seededTenantId),
          seated.tableSessionId,
        ),
      );
      expect(credit).toBe(150_000);
    } finally {
      await setPolicy("none");
    }
  });
});
