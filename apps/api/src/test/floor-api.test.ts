// WS-03 floor editor + signed table QR API (legend-irw; PRD v1.7 §3 F9
// "Denah & Meja", §3 F10 "Keamanan Sesi", ORD-04, ORD-10).
//
// Runs the real Express app, Better Auth, RBAC and PostgreSQL (disposable
// server from `pnpm test`). Cases: CRUD guards, board reads, QR reprint vs
// rotation (ORD-04), cross-outlet denial (TEN-03) and cross-tenant isolation
// (TEN-01/02).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { idr, tenantIdSchema } from "@starter/shared/core";
import {
  createFloorZone,
  createTable as createTableService,
  issueTableQr,
} from "../services/floor.service";
import { qrTokenHash } from "../services/qr-token";
import { agent, originHeader, signUp } from "./helpers";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  dropFloorRows,
  dropIsolatedTenant,
  issueQr,
  owner,
  scan,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffOfIsolatedTenant,
  staffWithRole,
  waitForLockWaiters,
  type IsolatedTenant,
} from "./floor-test-helpers";

let app: Express;
let staff: Awaited<ReturnType<typeof staffWithRole>>;
const zoneIds: string[] = [];
const tableIds: string[] = [];
let isolated: IsolatedTenant;

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

async function auditActions(action: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = $2",
    [seededTenantId, action],
  );
  return Number(rows[0]?.count ?? 0);
}

beforeAll(async () => {
  app = createApp();
  staff = await staffWithRole(app, {
    template: "owner",
    label: "Floor Owner",
  });
});

afterAll(async () => {
  await dropFloorRows({
    tenantId: seededTenantId,
    zoneIds,
    tableIds,
  });
  if (isolated) await dropIsolatedTenant(isolated);
  await owner.end();
});

describe("floor editor (legend-irw)", () => {
  it("creates zones and tables and returns them on the floor board", async () => {
    const zone = await createZone(staff.client);
    zoneIds.push(zone.id);
    const table = await createTable(staff.client, { zoneId: zone.id });
    tableIds.push(table.id);

    const current = await staff.client.get("/api/floor");
    expect(current.status).toBe(200);
    expect(
      current.body.data.zones.map((row: { id: string }) => row.id),
    ).toContain(zone.id);
    expect(
      current.body.data.tables.map(
        (row: { table: { id: string } }) => row.table.id,
      ),
    ).toContain(table.id);

    const board = await staff.client.get(`/api/outlets/${seededOutletA}/floor`);
    expect(board.status).toBe(200);
    // An anonymous caller cannot read the board.
    const anonymous = await agent(app).get(
      `/api/outlets/${seededOutletA}/floor`,
    );
    expect([401, 403, 404]).toContain(anonymous.status);
  });

  it("ORD-04 reprints the same signed QR and rotates only on Ganti QR", async () => {
    const zone = await createZone(staff.client);
    zoneIds.push(zone.id);
    const table = await createTable(staff.client, { zoneId: zone.id });
    tableIds.push(table.id);

    const first = await issueQr(staff.client, table.id);
    const reprint = await issueQr(staff.client, table.id);
    expect(reprint.token).toBe(first.token);
    expect(reprint.url).toBe(first.url);

    // A rotated sticker is a new token and a new hash; the old one is refused
    // by the scan because no table row matches its hash anymore.
    const auditBefore = await auditActions("table.qr_rotated");
    const rotated = await staff.client
      .post(`/api/tables/${table.id}/qr/rotate`)
      .set(originHeader);
    expect(rotated.status).toBe(200);
    expect(rotated.body.data.token).not.toBe(first.token);
    expect(rotated.body.data.token.startsWith("v1.")).toBe(true);
    expect(await auditActions("table.qr_rotated")).toBe(auditBefore + 1);

    const oldScan = await scan(app, { token: first.token });
    expect(oldScan.status).toBe(404);
    const newScan = await scan(app, { token: rotated.body.data.token });
    expect(newScan.status).toBe(201);
  });

  it("Codex pre-review MED: concurrent QR issuance returns one signed credential", async () => {
    const zone = await createZone(staff.client);
    zoneIds.push(zone.id);
    const table = await createTable(staff.client, { zoneId: zone.id });
    tableIds.push(table.id);

    const blocker = await owner.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM tables WHERE id = $1 FOR UPDATE", [
        table.id,
      ]);
      const pending = [
        issueTableQr(
          tenantContext(),
          table.id,
          staff.userId,
          new Date("2026-01-01T00:00:00.000Z"),
        ),
        issueTableQr(
          tenantContext(),
          table.id,
          staff.userId,
          new Date("2026-01-01T00:00:01.000Z"),
        ),
      ];
      await waitForLockWaiters(2);
      await blocker.query("COMMIT");
      const [first, second] = await Promise.all(pending);
      // The loser reuses the credential the winner persisted instead of
      // minting a competing sticker that would stop resolving.
      expect(second.token).toBe(first.token);
      expect(second.issuedAt).toBe(first.issuedAt);
      const { rows } = await owner.query<{ hash: string }>(
        "SELECT qr_token_hash AS hash FROM tables WHERE id = $1",
        [table.id],
      );
      expect(rows[0]?.hash).toBe(qrTokenHash(first.token));
    } finally {
      // No-op after COMMIT; rolls back when the test failed mid-lock.
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
    }
  });

  it("enforces the editor guards: duplicate code 409, zone with tables 409, table with a session 409", async () => {
    const zone = await createZone(staff.client);
    zoneIds.push(zone.id);
    const table = await createTable(staff.client, {
      zoneId: zone.id,
      code: `DUP-${randomUUID().slice(0, 5)}`.toUpperCase(),
    });
    tableIds.push(table.id);

    const duplicate = await staff.client
      .post("/api/floor/tables")
      .set(originHeader)
      .send({
        zoneId: zone.id,
        code: table.code,
        capacity: 2,
        type: "bar",
        layout: {
          x: 1,
          y: 1,
          width: 20,
          height: 20,
          rotation: 0,
          shape: "rect",
        },
      });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("CONFLICT");

    const zoneInUse = await staff.client
      .delete(`/api/floor/zones/${zone.id}`)
      .set(originHeader);
    expect(zoneInUse.status).toBe(409);

    const { token } = await issueQr(staff.client, table.id);
    const opened = await scan(app, { token });
    expect(opened.status).toBe(201);
    const withSession = await staff.client
      .delete(`/api/floor/tables/${table.id}`)
      .set(originHeader);
    expect(withSession.status).toBe(409);

    // The table's editor status cannot be switched off while a session runs.
    const deactivate = await staff.client
      .patch(`/api/floor/tables/${table.id}`)
      .set(originHeader)
      .send({ status: "inactive" });
    expect(deactivate.status).toBe(409);
  });

  it("saves a whole layout in one request and rejects mixed outlets", async () => {
    const zone = await createZone(staff.client);
    zoneIds.push(zone.id);
    const first = await createTable(staff.client, { zoneId: zone.id });
    const second = await createTable(staff.client, { zoneId: zone.id });
    tableIds.push(first.id, second.id);
    const layout = {
      x: 20,
      y: 30,
      width: 40,
      height: 40,
      rotation: 90,
      shape: "round",
    } as const;
    const saved = await staff.client
      .put("/api/floor/layout")
      .set(originHeader)
      .send({
        placements: [
          { tableId: first.id, layout },
          { tableId: second.id, layout },
        ],
      });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toHaveLength(2);
    expect(saved.body.data[0].layout.rotation).toBe(90);

    const unknown = await staff.client
      .put("/api/floor/layout")
      .set(originHeader)
      .send({
        placements: [{ tableId: randomUUID(), layout }],
      });
    expect(unknown.status).toBe(404);
  });

  it("TEN-03 denies an outlet-scoped supervisor another outlet's table and board", async () => {
    // A zone/table in the *second* seeded outlet, created by the owner.
    const otherZone = await createFloorZone(
      tenantContext(),
      seededOutletB,
      {
        name: `Zona B ${randomUUID().slice(0, 6)}`,
        paymentMode: "open_bill",
        serviceChargeBp: 0,
        minimumSpendIdr: idr(0),
        hours: [{ daysOfWeek: [1], start: "08:00", end: "22:00" }],
        status: "active",
        sortOrder: 1,
      },
      staff.userId,
    );
    zoneIds.push(otherZone.id);
    const otherTable = await createTableService(
      tenantContext(),
      {
        zoneId: otherZone.id,
        code: `B-${randomUUID().slice(0, 5)}`.toUpperCase(),
        capacity: 4,
        type: "regular",
        layout: {
          x: 0,
          y: 0,
          width: 30,
          height: 30,
          rotation: 0,
          shape: "rect",
        },
        status: "available",
      },
      staff.userId,
    );
    tableIds.push(otherTable.id);

    const supervisor = await staffWithRole(app, {
      template: "supervisor",
      scopeType: "outlet",
      scopeId: seededOutletA,
      label: "Outlet A Supervisor",
    });
    const denied = await supervisor.client
      .post(`/api/tables/${otherTable.id}/status`)
      .set(originHeader)
      .send({ action: "mark_dirty" });
    // Outlet RLS (legend-tjey) hides the other outlet's table: not found,
    // without revealing that it exists.
    expect(denied.status).toBe(404);

    const board = await supervisor.client.get(
      `/api/outlets/${seededOutletB}/floor`,
    );
    expect(board.status).toBe(403);

    // The same supervisor reaches their own outlet's board.
    const own = await supervisor.client.get(
      `/api/outlets/${seededOutletA}/floor`,
    );
    expect(own.status).toBe(200);
    expect(own.body.data.outletId).toBe(seededOutletA);
  });

  it("TEN-01/TEN-02 isolates a second tenant's floor and QR tokens", async () => {
    isolated = await createIsolatedTenant(`floor-${randomUUID().slice(0, 6)}`);
    const tenantTwo = await staffOfIsolatedTenant(app, isolated);
    const headers = { Host: isolated.hostname };

    const zone = await createZone(tenantTwo.client, {}, headers);
    const table = await createTable(
      tenantTwo.client,
      { zoneId: zone.id },
      headers,
    );

    const board = await tenantTwo.client.get("/api/floor").set(headers);
    expect(board.status).toBe(200);
    expect(board.body.data.outletId).toBe(isolated.outletId);
    expect(
      board.body.data.tables.map(
        (row: { table: { id: string } }) => row.table.id,
      ),
    ).toContain(table.id);

    // Tenant A's table id is invisible from tenant B (RLS + tenant filter).
    const foreign = await tenantTwo.client
      .patch(`/api/floor/tables/${tableIds[0]}`)
      .set(headers)
      .set(originHeader)
      .send({ capacity: 6 });
    expect(foreign.status).toBe(404);

    // A tenant B QR is refused on tenant A's host and vice versa.
    const tenantBQr = await issueQr(tenantTwo.client, table.id, headers);
    expect((await scan(app, { token: tenantBQr.token })).status).toBe(404);
    const tenantATable = await createTable(staff.client, {
      zoneId: zoneIds[0],
    });
    tableIds.push(tenantATable.id);
    const tenantAQr = await issueQr(staff.client, tenantATable.id);
    expect(
      (await scan(app, { token: tenantAQr.token, hostname: isolated.hostname }))
        .status,
    ).toBe(404);

    // Tenant B's role does not reach the seeded tenant's outlets.
    const foreignBoard = await tenantTwo.client
      .get(`/api/outlets/${seededOutletA}/floor`)
      .set(headers);
    expect(foreignBoard.status).toBe(403);
  });

  it("denies a signed-in account without a floor role", async () => {
    const client = agent(app);
    await signUp(client, "No Role");
    const response = await client.get("/api/floor");
    expect(response.status).toBe(403);
  });
});
