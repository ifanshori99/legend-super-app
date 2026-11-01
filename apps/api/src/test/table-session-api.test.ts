// WS-03 table session lifecycle (legend-irw; PRD v1.7 §3 F10 "Scan & Sesi
// Meja", "Keamanan Sesi", "Kontrol Open Bill"; ORD-04, ORD-10).
//
// Real Express app + Better Auth + RBAC + PostgreSQL (disposable server from
// `pnpm test`). Cases: open/join, participant once per device, open-bill waiter
// confirmation, ORD-04 closed/expired credential refusal, ORD-10 close and
// table-status guards, and cross-outlet denial of a lifecycle action.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app";
import { idr, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  createFloorZone,
  createTable as createTableService,
  issueTableQr,
} from "../services/floor.service";
import { authenticateGuestSession } from "../services/table-session.service";
import { agent, originHeader, signUp } from "./helpers";
import {
  createTable,
  createZone,
  dropFloorRows,
  issueQr,
  owner,
  scan,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffWithRole,
} from "./floor-test-helpers";

let app: Express;
let staff: Awaited<ReturnType<typeof staffWithRole>>;
const zoneIds: string[] = [];
const tableIds: string[] = [];

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

async function outboxCount(name: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM domain_event_outbox WHERE tenant_id = $1 AND event->>'name' = $2",
    [seededTenantId, name],
  );
  return Number(rows[0]?.count ?? 0);
}

async function newTable(zoneId?: string) {
  const zone = zoneId ? { id: zoneId } : await createZone(staff.client);
  if (!zoneId) zoneIds.push(zone.id);
  const table = await createTable(staff.client, { zoneId: zone.id });
  tableIds.push(table.id);
  const qr = await issueQr(staff.client, table.id);
  return { zoneId: zone.id, table, token: qr.token };
}

async function closeSession(sessionId: string, body: Record<string, unknown>) {
  return staff.client
    .post(`/api/table-sessions/${sessionId}/close`)
    .set(originHeader)
    .send(body);
}

beforeAll(async () => {
  app = createApp();
  staff = await staffWithRole(app, {
    template: "owner",
    label: "Session Owner",
  });
});

afterAll(async () => {
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await owner.end();
});

describe("table session lifecycle (legend-irw)", () => {
  it("ORD-04 opens on the first scan, joins on the next device and refuses the closed session's token", async () => {
    const { table, token } = await newTable();
    const openedBefore = await outboxCount("table_session.opened");
    const joinedBefore = await outboxCount("table_session.joined");

    const first = await scan(app, {
      token,
      pax: 2,
      deviceHash: `device-${randomUUID()}`,
    });
    expect(first.status).toBe(201);
    expect(first.body.data.outcome).toBe("opened");
    expect(first.body.data.session.status).toBe("open");
    expect(first.body.data.session.paymentMode).toBe("pay_first");
    expect(first.body.data.session.pax).toBe(2);
    expect(first.body.data.session.participants).toHaveLength(1);
    const session = first.body.data.session;

    const second = await scan(app, {
      token,
      pax: 3,
      deviceHash: `device-${randomUUID()}`,
    });
    expect(second.status).toBe(201);
    expect(second.body.data.outcome).toBe("joined");
    expect(second.body.data.session.id).toBe(session.id);
    // The joining guest receives the same session credential.
    expect(second.body.data.sessionToken).toBe(first.body.data.sessionToken);
    expect(second.body.data.session.participants).toHaveLength(2);
    expect(second.body.data.session.pax).toBe(2);

    // A device that rescans does not become a second participant.
    const rescan = await scan(app, {
      token,
      deviceHash: first.body.data.session.participants[0].deviceHash,
    });
    expect(rescan.body.data.outcome).toBe("joined");
    expect(rescan.body.data.session.participants).toHaveLength(2);

    expect(await outboxCount("table_session.opened")).toBe(openedBefore + 1);
    expect(await outboxCount("table_session.joined")).toBe(joinedBefore + 1);

    const closed = await closeSession(session.id, { tableCleaned: true });
    expect(closed.status).toBe(200);
    expect(closed.body.data.status).toBe("closed");
    expect(closed.body.data.closedReason).toBe("paid_and_cleaned");

    // ORD-04: the credential from the closed session can never be used again.
    await expect(
      authenticateGuestSession(tenantContext(), first.body.data.sessionToken),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    // The permanent table QR stays valid: the next scan opens a new session.
    const reopened = await scan(app, {
      token,
      deviceHash: `device-${randomUUID()}`,
    });
    expect(reopened.status).toBe(201);
    expect(reopened.body.data.outcome).toBe("opened");
    expect(reopened.body.data.session.id).not.toBe(session.id);
    expect(reopened.body.data.table.id).toBe(table.id);
    // The board shows the table occupied by the new session.
    expect(reopened.body.data.table.status).toBe("occupied");
  });

  it("ORD-04 expires a session after 12 hours and opens a fresh one on rescan", async () => {
    const { table, token } = await newTable();
    const first = await scan(app, {
      token,
      deviceHash: `device-${randomUUID()}`,
    });
    const sessionId = first.body.data.session.id as string;

    await owner.query(
      "UPDATE table_sessions SET opened_at = now() - interval '13 hours', last_activity_at = now() - interval '13 hours' WHERE id = $1",
      [sessionId],
    );
    const rescan = await scan(app, {
      token,
      deviceHash: `device-${randomUUID()}`,
    });
    expect(rescan.status).toBe(201);
    expect(rescan.body.data.session.id).not.toBe(sessionId);

    const { rows } = await owner.query<{
      status: string;
      closed_reason: string;
    }>(
      "SELECT status, closed_reason FROM table_sessions WHERE id = $1 AND table_id = $2",
      [sessionId, table.id],
    );
    expect(rows[0]).toEqual({
      status: "closed",
      closed_reason: "expired",
    });
    await expect(
      authenticateGuestSession(tenantContext(), first.body.data.sessionToken),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("ORD-10 closes only after the bill is settled and the table cleaned, or with waiter confirmation", async () => {
    const first = await newTable();
    const session = await scan(app, { token: first.token });
    const sessionId = session.body.data.session.id as string;

    const refused = await closeSession(sessionId, { tableCleaned: false });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/ORD-10/);

    // A waiter explicitly confirming the empty table empties it; the table is
    // dirty because it was not marked cleaned.
    const confirmedEmpty = await closeSession(sessionId, {
      tableCleaned: false,
      waiterConfirmedEmpty: true,
    });
    expect(confirmedEmpty.status).toBe(200);
    expect(confirmedEmpty.body.data.status).toBe("closed");
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM tables WHERE id = $1",
      [first.table.id],
    );
    expect(rows[0]?.status).toBe("dirty");

    const second = await newTable();
    const secondSession = await scan(app, { token: second.token });
    const cleaned = await closeSession(secondSession.body.data.session.id, {
      tableCleaned: true,
    });
    expect(cleaned.status).toBe(200);
    expect(cleaned.body.data.closedReason).toBe("paid_and_cleaned");
    const { rows: tableRows } = await owner.query<{ status: string }>(
      "SELECT status FROM tables WHERE id = $1",
      [second.table.id],
    );
    expect(tableRows[0]?.status).toBe("available");
  });

  it("ORD-10 refuses to empty a table that still has an active session", async () => {
    const { table, token } = await newTable();
    const session = await scan(app, { token });

    for (const action of [
      "mark_available",
      "mark_dirty",
      "deactivate",
    ] as const) {
      const refused = await staff.client
        .post(`/api/tables/${table.id}/status`)
        .set(originHeader)
        .send({ action });
      expect(refused.status).toBe(409);
      expect(refused.body.error.message).toMatch(/ORD-10/);
    }

    // The session closes through its own route, not through a table status.
    const closed = await closeSession(session.body.data.session.id, {
      tableCleaned: true,
    });
    expect(closed.status).toBe(200);
    const dirty = await staff.client
      .post(`/api/tables/${table.id}/status`)
      .set(originHeader)
      .send({ action: "mark_dirty" });
    expect(dirty.status).toBe(200);
    expect(dirty.body.data.table.status).toBe("dirty");
    const available = await staff.client
      .post(`/api/tables/${table.id}/status`)
      .set(originHeader)
      .send({ action: "mark_available" });
    expect(available.status).toBe(200);
    expect(available.body.data.table.status).toBe("available");
  });

  it("Kontrol Open Bill: an open-bill session waits for a waiter before it is open", async () => {
    const zone = await createZone(staff.client, {
      paymentMode: "open_bill",
      serviceChargeBp: 500,
    });
    zoneIds.push(zone.id);
    const table = await createTable(staff.client, { zoneId: zone.id });
    tableIds.push(table.id);
    const { token } = await issueQr(staff.client, table.id);

    const pending = await scan(app, { token });
    expect(pending.status).toBe(201);
    expect(pending.body.data.session.status).toBe("pending_confirmation");
    expect(pending.body.data.session.confirmedBy).toBeNull();

    // Guests may join while the waiter is on the way.
    const joined = await scan(app, {
      token,
      deviceHash: `device-${randomUUID()}`,
    });
    expect(joined.body.data.outcome).toBe("joined");

    const confirmed = await staff.client
      .post(`/api/table-sessions/${pending.body.data.session.id}/confirm`)
      .set(originHeader);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.status).toBe("open");
    expect(confirmed.body.data.confirmedBy).toBe(staff.userId);

    const duplicate = await staff.client
      .post(`/api/table-sessions/${pending.body.data.session.id}/confirm`)
      .set(originHeader);
    expect(duplicate.status).toBe(409);
  });

  it("TEN-03 denies a supervisor another outlet's session lifecycle action", async () => {
    const otherZone = await createFloorZone(
      tenantContext(),
      seededOutletB,
      {
        name: `Open B ${randomUUID().slice(0, 6)}`,
        paymentMode: "open_bill",
        serviceChargeBp: 0,
        minimumSpendIdr: idr(0),
        hours: [{ daysOfWeek: [1], start: "08:00", end: "22:00" }],
        status: "active",
        sortOrder: 2,
      },
      staff.userId,
    );
    zoneIds.push(otherZone.id);
    const otherTable = await createTableService(
      tenantContext(),
      {
        zoneId: otherZone.id,
        code: `B-${randomUUID().slice(0, 5)}`.toUpperCase(),
        capacity: 2,
        type: "bar",
        layout: {
          x: 0,
          y: 0,
          width: 20,
          height: 20,
          rotation: 0,
          shape: "rect",
        },
        status: "available",
      },
      staff.userId,
    );
    tableIds.push(otherTable.id);
    const qr = await issueTableQr(tenantContext(), otherTable.id, staff.userId);
    const session = await scan(app, { token: qr.token });
    expect(session.status).toBe(201);

    const supervisor = await staffWithRole(app, {
      template: "supervisor",
      scopeType: "outlet",
      scopeId: seededOutletA,
      label: "Outlet A Supervisor",
    });
    const denied = await supervisor.client
      .post(`/api/table-sessions/${session.body.data.session.id}/confirm`)
      .set(originHeader);
    expect(denied.status).toBe(403);

    // A signed-in account without a role cannot confirm either.
    const anonymousStaff = agent(app);
    await signUp(anonymousStaff, "No Floor Role");
    const noRole = await anonymousStaff
      .post(`/api/table-sessions/${session.body.data.session.id}/confirm`)
      .set(originHeader);
    expect(noRole.status).toBe(403);
  });
});
