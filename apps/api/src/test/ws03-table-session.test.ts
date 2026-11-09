// WS-03 slice S2 (legend-rml8, legend-khiv part 1): a guest scanning a
// SECONDARY table of a multi-table party joins the party's session, and
// closing a session cancels its open service requests. Real services +
// PostgreSQL (disposable server from `pnpm test`).
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  closeTableSessionInputSchema,
  updateTableStatusInputSchema,
} from "@starter/shared/qr-order";
import {
  createReservationInputSchema,
  seatReservationInputSchema,
} from "@starter/shared/reservation";
import { createReservation } from "../services/reservation-booking.ts";
import { seatReservation } from "../services/reservation-lifecycle.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import { idr } from "@starter/shared/core";
import {
  closeTableSession,
  openOrJoinTableSession,
  setTableSessionSettlementLookup,
  updateTableStatus,
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

async function seatParty(
  zoneId: string,
  date: string,
  ids: string[],
): Promise<string> {
  const created = await createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: zonedInstant(date, "19:00", "Asia/Jakarta").toISOString(),
      pax: 4,
      zoneId,
      guestName: "Tamu Party",
      contactPhone: "081234567890",
    }),
    `ws03-${randomUUID()}`,
  );
  const seated = await seatReservation(
    tenantScope(),
    staff.userId,
    outletA,
    created.reservation.id,
    seatReservationInputSchema.parse({ tableIds: ids }),
    `ws03-${randomUUID()}`,
  );
  return seated.tableSessionId;
}

const scan = (token: string) =>
  openOrJoinTableSession(tenantScope(), {
    qrToken: token,
    pax: 2,
    deviceHash: `device-${randomUUID()}`,
  });

async function sessionCount(ids: string[]): Promise<number> {
  const { rows } = await asOwner((client) =>
    client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM table_sessions WHERE tenant_id = $1 AND table_id = ANY($2)",
      [seededTenantId, ids],
    ),
  );
  return Number(rows[0]?.count ?? 0);
}

async function addRequest(
  sessionId: string,
  tableId: string,
  zoneId: string,
  type: "call_waiter" | "request_bill",
  status: "pending" | "acknowledged",
): Promise<string> {
  const id = randomUUID();
  await asOwner((client) =>
    client.query(
      `INSERT INTO service_requests
         (id, tenant_id, outlet_id, table_session_id, table_id, zone_id, type, status,
          assigned_to, acknowledged_at, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        seededTenantId,
        seededOutletA,
        sessionId,
        tableId,
        zoneId,
        type,
        status,
        status === "acknowledged" ? staff.userId : null,
        status === "acknowledged" ? new Date() : null,
        `key-${id}`,
        "f".repeat(64),
      ],
    ),
  );
  return id;
}

async function requestStatus(id: string): Promise<string> {
  const { rows } = await asOwner((client) =>
    client.query<{ status: string }>(
      "SELECT status FROM service_requests WHERE id = $1",
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
    label: "WS03 Session Owner",
  });
  // A settled zero bill, so an expiry or a clean close sees a paid table.
  setTableSessionSettlementLookup(async () => ({
    billTotalIdr: idr(0),
    paidIdr: idr(0),
  }));
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
       VALUES ($1, $2, 'ws03-1', 'none', 0, 60, 24, 0, 0, 0, 90, 30, true)`,
      [seededTenantId, seededOutletA],
    );
  });
});

afterAll(async () => {
  setTableSessionSettlementLookup(null);
  await asOwner(async (client) => {
    await client.query(
      "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, seededOutletA],
    );
    const rsv = `(SELECT id FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2))`;
    await client.query(
      "DELETE FROM service_requests WHERE tenant_id = $1 AND table_id = ANY($2)",
      [seededTenantId, tableIds],
    );
    await client.query(
      `DELETE FROM reservation_tables WHERE tenant_id = $1 AND reservation_id IN ${rsv}`,
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
  });
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await owner.end();
});

describe("legend-rml8 secondary-table scan joins the party session", () => {
  it("a scan of the secondary table joins the party's session and opens no second one", async () => {
    const f = await floor(2);
    const [primary, secondary] = f.tables as [
      (typeof f.tables)[0],
      (typeof f.tables)[0],
    ];
    const sessionId = await seatParty(f.zoneId, "2027-05-01", [
      primary.id,
      secondary.id,
    ]);
    const scanned = await scan(secondary.token);
    expect(scanned.outcome).toBe("joined");
    expect(scanned.session.id).toBe(sessionId);
    expect(await sessionCount([primary.id, secondary.id])).toBe(1);
    // The primary's scan still joins the same session.
    expect((await scan(primary.token)).session.id).toBe(sessionId);
  });

  it("after the party's session closes, the secondary table opens a fresh session", async () => {
    const f = await floor(2);
    const [primary, secondary] = f.tables as [
      (typeof f.tables)[0],
      (typeof f.tables)[0],
    ];
    const sessionId = await seatParty(f.zoneId, "2027-05-02", [
      primary.id,
      secondary.id,
    ]);
    await closeTableSession(
      tenantScope(),
      sessionId,
      closeTableSessionInputSchema.parse({
        tableCleaned: true,
        waiterConfirmedEmpty: true,
      }),
      staff.userId,
    );
    const scanned = await scan(secondary.token);
    expect(scanned.outcome).toBe("opened");
    expect(scanned.session.id).not.toBe(sessionId);
  });

  it("a secondary table that is no longer occupied never joins the party (stale hold)", async () => {
    const f = await floor(2);
    const [primary, secondary] = f.tables as [
      (typeof f.tables)[0],
      (typeof f.tables)[0],
    ];
    const sessionId = await seatParty(f.zoneId, "2027-05-03", [
      primary.id,
      secondary.id,
    ]);
    await asOwner((client) =>
      client.query("UPDATE tables SET status = 'available' WHERE id = $1", [
        secondary.id,
      ]),
    );
    const scanned = await scan(secondary.token);
    expect(scanned.outcome).toBe("opened");
    expect(scanned.session.id).not.toBe(sessionId);
  });

  it("an expired party session is not expired by a secondary scan (409), and stays open", async () => {
    const f = await floor(2);
    const [primary, secondary] = f.tables as [
      (typeof f.tables)[0],
      (typeof f.tables)[0],
    ];
    const sessionId = await seatParty(f.zoneId, "2027-05-04", [
      primary.id,
      secondary.id,
    ]);
    await asOwner((client) =>
      client.query(
        "UPDATE table_sessions SET opened_at = now() - interval '13 hours', last_activity_at = now() - interval '13 hours' WHERE id = $1",
        [sessionId],
      ),
    );
    await expect(scan(secondary.token)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const { rows } = await asOwner((client) =>
      client.query<{ status: string }>(
        "SELECT status FROM table_sessions WHERE id = $1",
        [sessionId],
      ),
    );
    expect(rows[0]?.status).toBe("open");
    expect(await sessionCount([primary.id, secondary.id])).toBe(1);
  });

  it("staff cannot mark a party's secondary table available mid-meal", async () => {
    const f = await floor(2);
    const [primary, secondary] = f.tables as [
      (typeof f.tables)[0],
      (typeof f.tables)[0],
    ];
    await seatParty(f.zoneId, "2027-05-05", [primary.id, secondary.id]);
    await expect(
      updateTableStatus(
        tenantScope(),
        secondary.id,
        updateTableStatusInputSchema.parse({ action: "mark_available" }),
        staff.userId,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("legend-khiv close cancels the session's open service requests", () => {
  it("cancels pending and acknowledged requests, leaves other sessions alone, frees the dedupe slot", async () => {
    const f = await floor(2);
    const [a, b] = f.tables as [(typeof f.tables)[0], (typeof f.tables)[0]];
    const sessionA = (await scan(a.token)).session.id;
    const sessionB = (await scan(b.token)).session.id;
    const pending = await addRequest(
      sessionA,
      a.id,
      f.zoneId,
      "call_waiter",
      "pending",
    );
    const acknowledged = await addRequest(
      sessionA,
      a.id,
      f.zoneId,
      "request_bill",
      "acknowledged",
    );
    const other = await addRequest(
      sessionB,
      b.id,
      f.zoneId,
      "call_waiter",
      "pending",
    );
    await closeTableSession(
      tenantScope(),
      sessionA,
      closeTableSessionInputSchema.parse({
        tableCleaned: true,
        waiterConfirmedEmpty: true,
      }),
      staff.userId,
    );
    expect(await requestStatus(pending)).toBe("cancelled");
    expect(await requestStatus(acknowledged)).toBe("cancelled");
    expect(await requestStatus(other)).toBe("pending");
    // The next session's call at table A no longer collides with a stale one.
    const next = (await scan(a.token)).session.id;
    await expect(
      addRequest(next, a.id, f.zoneId, "call_waiter", "pending"),
    ).resolves.toBeTruthy();
  });

  it("a resolved request stays resolved", async () => {
    const f = await floor(1);
    const t = f.tables[0]!;
    const sessionId = (await scan(t.token)).session.id;
    const id = await addRequest(
      sessionId,
      t.id,
      f.zoneId,
      "call_waiter",
      "pending",
    );
    await asOwner((client) =>
      client.query(
        "UPDATE service_requests SET status = 'resolved', resolved_at = now() WHERE id = $1",
        [id],
      ),
    );
    await closeTableSession(
      tenantScope(),
      sessionId,
      closeTableSessionInputSchema.parse({
        tableCleaned: true,
        waiterConfirmedEmpty: true,
      }),
      staff.userId,
    );
    expect(await requestStatus(id)).toBe("resolved");
  });

  it("an expiry on rescan cancels the expired session's open requests", async () => {
    const f = await floor(1);
    const t = f.tables[0]!;
    const sessionId = (await scan(t.token)).session.id;
    const id = await addRequest(
      sessionId,
      t.id,
      f.zoneId,
      "call_waiter",
      "pending",
    );
    await asOwner((client) =>
      client.query(
        "UPDATE table_sessions SET opened_at = now() - interval '13 hours', last_activity_at = now() - interval '13 hours' WHERE id = $1",
        [sessionId],
      ),
    );
    const next = await scan(t.token);
    expect(next.outcome).toBe("opened");
    expect(next.session.id).not.toBe(sessionId);
    expect(await requestStatus(id)).toBe("cancelled");
  });
});
