// WS-03 waiter call / bill request (legend-7qg; PRD v1.7 §3 F10 "Panggil
// Waiter & Minta Tagihan", §6 C service_requests; ORD-07: the call shows on the
// zone waiter's phone within 3 seconds).
//
// Real Express app + Better Auth + RBAC + PostgreSQL (disposable server from
// `pnpm test`). Cases: zone-only realtime fan-out in the commit path, dedupe,
// idempotency bound to the request fingerprint, ack/resolve state machine,
// per-session rate limit, overdue sweep, cross-outlet and cross-tenant denial.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { createApp } from "../app";
import { tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { transitionServiceRequest } from "@starter/shared/qr-order";
import { sweepOverdueServiceRequests } from "../services/service-request.service";
import { agent, originHeader } from "./helpers";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  dropFloorRows,
  dropIsolatedTenant,
  issueQr,
  owner,
  scan,
  seededHostname,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffOfIsolatedTenant,
  staffWithRole,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers";

let app: Express;
let manager: Staff;
let outletId: string;
let otherOutletId: string;
let waiterZone1: Staff;
let waiterZone2: Staff;
let outsideWaiter: Staff;
const zoneIds: string[] = [];
const tableIds: string[] = [];

type Guest = {
  token: string;
  sessionToken: string;
  sessionId: string;
  zoneId: string;
  tableId: string;
};

function tenantContext() {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

/** A zone, a table in it and a guest session scanned on the tenant host. */
async function newGuest(zone?: { id: string }): Promise<Guest> {
  const z = zone ?? (await createZone(manager.client));
  if (!zone) zoneIds.push(z.id);
  const table = await createTable(manager.client, { zoneId: z.id });
  tableIds.push(table.id);
  const qr = await issueQr(manager.client, table.id);
  const scanned = await scan(app, { token: qr.token });
  expect(scanned.status).toBe(201);
  return {
    token: qr.token,
    sessionToken: scanned.body.data.sessionToken,
    sessionId: scanned.body.data.session.id,
    zoneId: z.id,
    tableId: table.id,
  };
}

async function assign(zoneId: string, userId: string) {
  await owner.query(
    `INSERT INTO zone_waiter_assignments (tenant_id, outlet_id, zone_id, user_id)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [seededTenantId, outletId, zoneId, userId],
  );
}

function call(
  guest: Guest,
  body: Record<string, unknown> = {},
  options: { host?: string; token?: string | null } = {},
) {
  const req = agent(app)
    .post(`/api/table-sessions/${guest.sessionId}/service-requests`)
    .set("Host", options.host ?? seededHostname);
  const token =
    options.token === undefined ? guest.sessionToken : options.token;
  if (token) req.set("Authorization", `Bearer ${token}`);
  return req.send({
    type: "call_waiter",
    reason: "utensils",
    idempotencyKey: randomUUID(),
    ...body,
  });
}

const ack = (staff: Staff, id: string, host = seededHostname) =>
  staff.client
    .post(`/api/service-requests/${id}/acknowledge`)
    .set(originHeader)
    .set("Host", host);
const resolve = (staff: Staff, id: string, host = seededHostname) =>
  staff.client
    .post(`/api/service-requests/${id}/resolve`)
    .set(originHeader)
    .set("Host", host)
    .send({});

async function recipientsOf(requestId: string): Promise<string[]> {
  const { rows } = await owner.query<{ user_id: string }>(
    `SELECT n.user_id FROM notifications n
       JOIN domain_event_outbox o ON o.tenant_id = n.tenant_id AND o.event_id = n.source_event_id
      WHERE n.tenant_id = $1 AND o.aggregate_id = $2 AND o.event->>'name' = 'service_request.created'`,
    [seededTenantId, requestId],
  );
  return rows.map((row) => row.user_id);
}

async function eventCount(requestId: string, name: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = $3`,
    [seededTenantId, requestId, name],
  );
  return Number(rows[0]?.count ?? 0);
}

beforeAll(async () => {
  app = createApp();
  manager = await staffWithRole(app, { template: "owner", label: "SR Owner" });
  const probe = await createZone(manager.client);
  zoneIds.push(probe.id);
  outletId = probe.outletId as string;
  otherOutletId = [seededOutletA, seededOutletB].find((id) => id !== outletId)!;
  waiterZone1 = await staffWithRole(app, {
    template: "waiter",
    scopeType: "outlet",
    scopeId: outletId,
    label: "Waiter Z1",
  });
  waiterZone2 = await staffWithRole(app, {
    template: "waiter",
    scopeType: "outlet",
    scopeId: outletId,
    label: "Waiter Z2",
  });
  outsideWaiter = await staffWithRole(app, {
    template: "waiter",
    scopeType: "outlet",
    scopeId: otherOutletId,
    label: "Waiter Other Outlet",
  });
});

afterAll(async () => {
  await owner.query("DELETE FROM service_requests WHERE tenant_id = $1", [
    seededTenantId,
  ]);
  await owner.query(
    "DELETE FROM zone_waiter_assignments WHERE tenant_id = $1",
    [seededTenantId],
  );
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await owner.end();
});

describe("service requests (legend-7qg)", () => {
  it("ORD-07 pushes the call in the commit path to the zone's waiters only, within 3 s", async () => {
    const guest = await newGuest();
    await assign(guest.zoneId, waiterZone1.userId);
    const otherZone = await createZone(manager.client);
    zoneIds.push(otherZone.id);
    await assign(otherZone.id, waiterZone2.userId);

    const listener: PoolClient = await owner.connect();
    const wakeups: { notificationId: string }[] = [];
    listener.on("notification", (message) => {
      if (message.payload) wakeups.push(JSON.parse(message.payload));
    });
    await listener.query("LISTEN legend_notification_wakeup");
    try {
      const started = Date.now();
      const response = await call(guest);
      expect(response.status).toBe(201);
      const requestId = response.body.data.id as string;
      expect(response.body.data.status).toBe("pending");
      expect(response.body.data.zoneId).toBe(guest.zoneId);

      // Same transaction: the NOTIFY is delivered at commit, before the 201.
      const { rows } = await owner.query<{ id: string; user_id: string }>(
        `SELECT n.id, n.user_id FROM notifications n
           JOIN domain_event_outbox o ON o.event_id = n.source_event_id
          WHERE n.tenant_id = $1 AND o.aggregate_id = $2`,
        [seededTenantId, requestId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBe(waiterZone1.userId);
      for (let i = 0; i < 100 && wakeups.length === 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(wakeups.length).toBeGreaterThan(0);
      expect(Date.now() - started).toBeLessThan(3000);

      // Fan-out targets the zone's waiter, never the other zone's waiter.
      expect(await recipientsOf(requestId)).toEqual([waiterZone1.userId]);
      expect(await eventCount(requestId, "service_request.created")).toBe(1);
    } finally {
      await listener.query("UNLISTEN legend_notification_wakeup");
      listener.release();
    }
  });

  it("ORD-07 dedupes a repeated call for the same table and kind while one is open", async () => {
    const guest = await newGuest();
    const first = await call(guest);
    expect(first.status).toBe(201);
    const again = await call(guest, { reason: "add_order" });
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(first.body.data.id);
    // A different kind is a separate request.
    const bill = await call(guest, { type: "request_bill", reason: undefined });
    expect(bill.status).toBe(201);
    expect(bill.body.data.id).not.toBe(first.body.data.id);
    const { rows } = await owner.query(
      "SELECT id FROM service_requests WHERE tenant_id = $1 AND table_id = $2",
      [seededTenantId, guest.tableId],
    );
    expect(rows).toHaveLength(2);

    // Once resolved, a new call opens a new request.
    expect((await resolve(manager, first.body.data.id)).status).toBe(200);
    const next = await call(guest);
    expect(next.status).toBe(201);
    expect(next.body.data.id).not.toBe(first.body.data.id);
  });

  it("ORD-07 never shows an earlier session's message on a dedupe hit", async () => {
    const guest = await newGuest();
    const other = await newGuest();
    const first = await call(guest, { message: "Tolong bawa sendok" });
    expect(first.status).toBe(201);
    // Simulate a request left open by an earlier session at this table.
    await owner.query(
      "UPDATE service_requests SET table_session_id = $1 WHERE tenant_id = $2 AND id = $3",
      [other.sessionId, seededTenantId, first.body.data.id],
    );
    const again = await call(guest);
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(again.body.data.message).toBeNull();
  });

  it("ORD-07 binds the idempotency key to the request fingerprint", async () => {
    const guest = await newGuest();
    const key = randomUUID();
    const first = await call(guest, { idempotencyKey: key });
    expect(first.status).toBe(201);
    const replay = await call(guest, { idempotencyKey: key });
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(first.body.data.id);
    const reused = await call(guest, {
      idempotencyKey: key,
      reason: "add_order",
    });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("ORD-07 validates guest input and the session credential", async () => {
    const guest = await newGuest();
    expect(
      (await call(guest, { type: "call_waiter", reason: undefined })).status,
    ).toBe(422);
    expect((await call(guest, { tenantId: randomUUID() })).status).toBe(422);
    expect((await call(guest, {}, { token: null })).status).toBe(401);
    expect((await call(guest, {}, { token: "x".repeat(40) })).status).toBe(401);
    const stranger = await newGuest();
    // A valid credential of another session is refused for this session id.
    expect(
      (await call(guest, {}, { token: stranger.sessionToken })).status,
    ).toBe(401);
  });

  it("ORD-07 rate limits guest calls per session", async () => {
    const guest = await newGuest();
    const key = randomUUID();
    let limited = 0;
    for (let i = 0; i < 14; i++) {
      const response = await call(guest, { idempotencyKey: key });
      if (response.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it("ORD-07 runs open -> acknowledged -> resolved and refuses illegal transitions", async () => {
    const guest = await newGuest();
    await assign(guest.zoneId, waiterZone1.userId);
    const created = await call(guest);
    const id = created.body.data.id as string;

    const acked = await ack(waiterZone1, id);
    expect(acked.status).toBe(200);
    expect(acked.body.data.status).toBe("acknowledged");
    expect(acked.body.data.assignedTo).toBe(waiterZone1.userId);
    // Same waiter retrying is a no-op; another waiter cannot take it.
    expect((await ack(waiterZone1, id)).status).toBe(200);
    expect((await ack(waiterZone2, id)).status).toBe(409);

    const done = await resolve(waiterZone1, id);
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe("resolved");
    expect(done.body.data.resolvedAt).not.toBeNull();
    // resolved is terminal.
    expect((await ack(waiterZone1, id)).status).toBe(409);
    expect((await resolve(waiterZone2, id)).status).toBe(409);
    expect(() => transitionServiceRequest("resolved", "acknowledge")).toThrow();
    const audit = await owner.query(
      "SELECT 1 FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = 'service_request.resolve' AND event->>'objectId' = $2",
      [seededTenantId, id],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("ORD-07 lists the outlet inbox with status filter and cursor paging", async () => {
    const a = await newGuest();
    const b = await newGuest();
    const first = await call(a);
    const second = await call(b);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    await ack(waiterZone1, first.body.data.id);

    const page = await waiterZone1.client
      .get(`/api/outlets/${outletId}/service-requests?limit=1`)
      .set("Host", seededHostname);
    expect(page.status).toBe(200);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta.nextCursor).not.toBeNull();
    const next = await waiterZone1.client
      .get(
        `/api/outlets/${outletId}/service-requests?limit=1&cursor=${page.body.meta.nextCursor}`,
      )
      .set("Host", seededHostname);
    expect(next.status).toBe(200);
    expect(next.body.data[0].id).not.toBe(page.body.data[0].id);

    const acknowledged = await waiterZone1.client
      .get(`/api/outlets/${outletId}/service-requests?status=acknowledged`)
      .set("Host", seededHostname);
    expect(
      acknowledged.body.data.every(
        (r: { status: string }) => r.status === "acknowledged",
      ),
    ).toBe(true);
    expect(
      acknowledged.body.data.some(
        (r: { id: string }) => r.id === first.body.data.id,
      ),
    ).toBe(true);
  });

  it("ORD-07 escalates an overdue request once and only while open", async () => {
    const guest = await newGuest();
    await assign(guest.zoneId, waiterZone1.userId);
    const open = (await call(guest)).body.data.id as string;
    const guest2 = await newGuest();
    const closed = (await call(guest2)).body.data.id as string;
    await resolve(manager, closed);

    const now = new Date();
    expect(
      await sweepOverdueServiceRequests(now, tenantContext()),
    ).not.toContain(open);
    const later = new Date(now.getTime() + 181_000);
    const escalated = await sweepOverdueServiceRequests(later, tenantContext());
    expect(escalated).toContain(open);
    expect(escalated).not.toContain(closed);
    expect(await eventCount(open, "service_request.overdue")).toBe(1);
    // At most once per request.
    expect(
      await sweepOverdueServiceRequests(later, tenantContext()),
    ).not.toContain(open);
    expect(await eventCount(open, "service_request.overdue")).toBe(1);
  });

  describe("isolation", () => {
    let other: IsolatedTenant;
    let otherStaff: Staff;
    beforeAll(async () => {
      other = await createIsolatedTenant(`sr${randomUUID().slice(0, 6)}`);
      otherStaff = await staffOfIsolatedTenant(app, other);
    });
    afterAll(async () => {
      await dropIsolatedTenant(other);
    });

    it("ORD-07 denies a waiter of another outlet", async () => {
      const guest = await newGuest();
      const id = (await call(guest)).body.data.id as string;
      expect((await ack(outsideWaiter, id)).status).toBe(403);
      expect((await resolve(outsideWaiter, id)).status).toBe(403);
      const list = await outsideWaiter.client
        .get(`/api/outlets/${outletId}/service-requests`)
        .set("Host", seededHostname);
      expect(list.status).toBe(403);
    });

    it("ORD-07 hides requests and guest sessions across tenants", async () => {
      const guest = await newGuest();
      const id = (await call(guest)).body.data.id as string;
      // Staff of another tenant: RLS makes the request invisible.
      expect((await ack(otherStaff, id, other.hostname)).status).toBe(404);
      const list = await otherStaff.client
        .get(`/api/outlets/${outletId}/service-requests`)
        .set("Host", other.hostname);
      expect([403, 404]).toContain(list.status);
      // A guest credential of tenant A is useless on tenant B's host.
      const crossed = await call(guest, {}, { host: other.hostname });
      expect(crossed.status).toBe(401);
      const { rows } = await owner.query(
        "SELECT id FROM service_requests WHERE tenant_id = $1",
        [other.tenantId],
      );
      expect(rows).toHaveLength(0);
    });
  });
});
