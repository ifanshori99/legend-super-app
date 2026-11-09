// WS-03 zone waiter management API and resolve-by-other-staff (legend-xlzl,
// legend-khiv parts 2-3). Real Express app + Better Auth + RBAC + PostgreSQL.
// Cases: manager assign / duplicate / list / remove, refusal of users outside
// the tenant or the outlet, permission gate, resolved_by idempotency.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app";
import { tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  assignZoneWaiter,
  removeZoneWaiterAssignment,
} from "../services/service-request.service";
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
let waiterA: Staff;
let waiterB: Staff;
let outsideWaiter: Staff;
let zoneId: string;
const zoneIds: string[] = [];
const tableIds: string[] = [];

const base = () => `/api/outlets/${outletId}`;
const assign = (staff: Staff, body: Record<string, unknown>, zone = zoneId) =>
  staff.client
    .post(`${base()}/zones/${zone}/waiters`)
    .set(originHeader)
    .set("Host", seededHostname)
    .send(body);
const list = (staff: Staff, query = "") =>
  staff.client
    .get(`${base()}/zone-waiters${query}`)
    .set("Host", seededHostname);
const remove = (staff: Staff, id: string) =>
  staff.client
    .delete(`${base()}/zone-waiters/${id}`)
    .set(originHeader)
    .set("Host", seededHostname);

beforeAll(async () => {
  app = createApp();
  manager = await staffWithRole(app, { template: "owner", label: "ZW Owner" });
  const zone = await createZone(manager.client);
  zoneIds.push(zone.id);
  zoneId = zone.id;
  outletId = zone.outletId as string;
  otherOutletId = [seededOutletA, seededOutletB].find((id) => id !== outletId)!;
  const waiter = (label: string, scopeId: string) =>
    staffWithRole(app, {
      template: "waiter",
      scopeType: "outlet",
      scopeId,
      label,
    });
  waiterA = await waiter("ZW Waiter A", outletId);
  waiterB = await waiter("ZW Waiter B", outletId);
  outsideWaiter = await waiter("ZW Waiter Elsewhere", otherOutletId);
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

describe("zone waiter management (legend-xlzl)", () => {
  it("assigns, treats a repeat as idempotent, lists and removes", async () => {
    const created = await assign(manager, { userId: waiterA.userId });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      outletId,
      zoneId,
      userId: waiterA.userId,
    });
    const id = created.body.data.id as string;

    const repeat = await assign(manager, { userId: waiterA.userId });
    expect(repeat.status).toBe(200);
    expect(repeat.body.data.id).toBe(id);

    await assign(manager, { userId: waiterB.userId, note: "Shift malam" });
    const all = await list(manager, `?zoneId=${zoneId}`);
    expect(all.status).toBe(200);
    expect(
      all.body.data.map((row: { userId: string }) => row.userId).sort(),
    ).toEqual([waiterA.userId, waiterB.userId].sort());
    const other = await createZone(manager.client);
    zoneIds.push(other.id);
    expect((await list(manager, `?zoneId=${other.id}`)).body.data).toEqual([]);

    expect((await remove(manager, id)).status).toBe(204);
    expect((await remove(manager, id)).status).toBe(404);
    const left = await list(manager, `?zoneId=${zoneId}`);
    expect(left.body.data).toHaveLength(1);
    expect(left.body.data[0].userId).toBe(waiterB.userId);
  });

  it("refuses users who are not active members with access to the outlet", async () => {
    // Waiter of another outlet, and an unknown account.
    expect(
      (await assign(manager, { userId: outsideWaiter.userId })).status,
    ).toBe(400);
    expect((await assign(manager, { userId: randomUUID() })).status).toBe(400);

    // Member of another tenant only.
    const tenant: IsolatedTenant = await createIsolatedTenant(
      `zw${randomUUID().slice(0, 6)}`,
    );
    try {
      const stranger = await staffOfIsolatedTenant(app, tenant);
      expect((await assign(manager, { userId: stranger.userId })).status).toBe(
        400,
      );
    } finally {
      await dropIsolatedTenant(tenant);
    }

    // Banned account.
    const banned = await staffWithRole(app, {
      template: "waiter",
      scopeType: "outlet",
      scopeId: outletId,
      label: "ZW Banned",
    });
    await owner.query(`UPDATE "user" SET banned = true WHERE id = $1`, [
      banned.userId,
    ]);
    expect((await assign(manager, { userId: banned.userId })).status).toBe(400);

    const rows = await owner.query(
      "SELECT 1 FROM zone_waiter_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [seededTenantId, [outsideWaiter.userId, banned.userId].filter(Boolean)],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("needs service_request.zone.manage on that outlet", async () => {
    expect((await assign(waiterA, { userId: waiterB.userId })).status).toBe(
      403,
    );
    expect((await list(waiterA)).status).toBe(403);
    // Manager of the other outlet cannot manage this one.
    const otherManager = await staffWithRole(app, {
      template: "outlet_manager",
      scopeType: "outlet",
      scopeId: otherOutletId,
      label: "ZW Other Manager",
    });
    expect(
      (await assign(otherManager, { userId: waiterB.userId })).status,
    ).toBe(403);
    expect((await list(otherManager)).status).toBe(403);
    // An outlet manager of this outlet can.
    const outletManager = await staffWithRole(app, {
      template: "outlet_manager",
      scopeType: "outlet",
      scopeId: outletId,
      label: "ZW Outlet Manager",
    });
    expect((await list(outletManager)).status).toBe(200);
    // Unknown zone.
    expect(
      (await assign(manager, { userId: waiterB.userId }, randomUUID())).status,
    ).toBe(404);
    // No session: guard rejects.
    const anon = await agent(app)
      .get(`${base()}/zone-waiters`)
      .set("Host", seededHostname);
    expect(anon.status).toBe(401);
  });

  it("a different staff resolving an already resolved request gets 200 with the original resolver", async () => {
    const table = await createTable(manager.client, { zoneId });
    tableIds.push(table.id);
    const qr = await issueQr(manager.client, table.id);
    const scanned = await scan(app, { token: qr.token });
    expect(scanned.status).toBe(201);
    const created = await agent(app)
      .post(
        `/api/table-sessions/${scanned.body.data.session.id}/service-requests`,
      )
      .set("Host", seededHostname)
      .set("Authorization", `Bearer ${scanned.body.data.sessionToken}`)
      .send({
        type: "call_waiter",
        reason: "utensils",
        idempotencyKey: randomUUID(),
      });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const resolveAs = (staff: Staff) =>
      staff.client
        .post(`/api/service-requests/${id}/resolve`)
        .set(originHeader)
        .set("Host", seededHostname)
        .send({});

    const first = await resolveAs(waiterA);
    expect(first.status).toBe(200);
    expect(first.body.data.resolvedBy).toBe(waiterA.userId);
    const second = await resolveAs(waiterB);
    expect(second.status).toBe(200);
    expect(second.body.data.status).toBe("resolved");
    expect(second.body.data.resolvedBy).toBe(waiterA.userId);
    expect(second.body.data.resolvedAt).toBe(first.body.data.resolvedAt);
    const { rows } = await owner.query<{ resolved_by: string }>(
      "SELECT resolved_by FROM service_requests WHERE id = $1",
      [id],
    );
    expect(rows[0].resolved_by).toBe(waiterA.userId);
  });

  it("audits assign and remove in the same transaction with the actor", async () => {
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(seededTenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    const zone = await createZone(manager.client);
    zoneIds.push(zone.id);
    const { assignment, created } = await assignZoneWaiter(
      context,
      outletId as never,
      zone.id,
      { userId: waiterA.userId as never },
      manager.userId,
    );
    expect(created).toBe(true);
    const audit = (action: string) =>
      owner.query<{ actor: string | null; outlet: string; changes: unknown }>(
        `SELECT event->>'actorId' AS actor, event->>'outletId' AS outlet,
                event->'maskedChanges' AS changes
           FROM audit_logs
          WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
        [seededTenantId, action, assignment.id],
      );
    const assigned = await audit("service_request.zone_waiter.assign");
    expect(assigned.rows).toHaveLength(1);
    expect(assigned.rows[0]).toMatchObject({
      actor: manager.userId,
      outlet: outletId,
    });
    expect(JSON.stringify(assigned.rows[0].changes)).toContain(zone.id);

    await removeZoneWaiterAssignment(
      context,
      outletId as never,
      assignment.id,
      manager.userId,
    );
    const removed = await audit("service_request.zone_waiter.remove");
    expect(removed.rows).toHaveLength(1);
    expect(removed.rows[0].actor).toBe(manager.userId);
  });

  it("a malformed notification preference row does not block the guest call", async () => {
    const zone = await createZone(manager.client);
    zoneIds.push(zone.id);
    const prefUser = await staffWithRole(app, {
      template: "waiter",
      scopeType: "outlet",
      scopeId: outletId,
      label: "ZW Bad Pref",
    });
    expect(
      (await assign(manager, { userId: prefUser.userId }, zone.id)).status,
    ).toBe(201);
    await owner.query(
      `INSERT INTO notification_preferences (tenant_id, user_id, categories, quiet_hours, time_zone)
       VALUES ($1, $2, '{"waiter_call": {"web_push": "nope"}}'::jsonb, NULL, 'Not/AZone')
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET categories = EXCLUDED.categories, time_zone = EXCLUDED.time_zone`,
      [seededTenantId, prefUser.userId],
    );
    const table = await createTable(manager.client, { zoneId: zone.id });
    tableIds.push(table.id);
    const qr = await issueQr(manager.client, table.id);
    const scanned = await scan(app, { token: qr.token });
    expect(scanned.status).toBe(201);
    const called = await agent(app)
      .post(
        `/api/table-sessions/${scanned.body.data.session.id}/service-requests`,
      )
      .set("Host", seededHostname)
      .set("Authorization", `Bearer ${scanned.body.data.sessionToken}`)
      .send({
        type: "call_waiter",
        reason: "utensils",
        idempotencyKey: randomUUID(),
      });
    expect(called.status).toBe(201);
    await owner.query(
      "DELETE FROM notification_preferences WHERE tenant_id = $1 AND user_id = $2",
      [seededTenantId, prefUser.userId],
    );
  });

  it("migration 0120 backfills service_request.zone.manage into stored template roles", async () => {
    const sql = readFileSync(
      new URL("../../drizzle/0120_ws03_roles_zone_manage.sql", import.meta.url),
      "utf8",
    )
      .split("--> statement-breakpoint")
      .find((statement) => /UPDATE\s+"roles"/.test(statement));
    expect(sql).toBeDefined();
    const tenant = await createIsolatedTenant(`zb${randomUUID().slice(0, 6)}`);
    try {
      const insertRole = async (name: string, template: string | null) => {
        const { rows } = await owner.query<{ id: string }>(
          `INSERT INTO roles (tenant_id, name, is_template, template_key, permissions, allowed_scope_types)
           VALUES ($1, $2, $3, $4, '["floor.table.operate"]'::jsonb, '["outlet"]'::jsonb) RETURNING id`,
          [tenant.tenantId, name, template !== null, template],
        );
        return rows[0].id;
      };
      const template = await insertRole("Outlet Manager", "outlet_manager");
      const waiterTemplate = await insertRole("Waiter", "waiter");
      const custom = await insertRole("Custom Floor Lead", null);
      const permsOf = async (id: string) =>
        (
          await owner.query<{ permissions: string[] }>(
            "SELECT permissions FROM roles WHERE id = $1",
            [id],
          )
        ).rows[0].permissions;

      await owner.query(sql!);
      await owner.query(sql!); // idempotent
      expect(await permsOf(template)).toEqual([
        "floor.table.operate",
        "service_request.zone.manage",
      ]);
      expect(await permsOf(waiterTemplate)).toEqual(["floor.table.operate"]);
      expect(await permsOf(custom)).toEqual(["floor.table.operate"]);
    } finally {
      await dropIsolatedTenant(tenant);
    }
  });
});
