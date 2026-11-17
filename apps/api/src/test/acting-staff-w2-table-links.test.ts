// Acting staff, wave 2: table links (legend-ptn11). Spec = DECISIONS.md entry
// "Kasir aktif per perangkat lewat token server": POS calls that carry
// X-Acting-Staff run as that staff member (actor = staff, permissions = the
// staff's, never the session owner's); a bad token is 401 and never falls back
// to the session owner; no header = the session owner stays the actor.
//
// Routes: POST /api/table-links and POST /api/table-links/:groupId/unlink.
//
// Assumptions (spec silent):
//  - The actor is read from the audit row (audit_logs.event.actorId) of the
//    link/unlink request, found by the group id appearing in the event JSON.
//  - Rows written by the unlink request = audit rows mentioning the group id
//    that did not exist before the request.
//  - Tables get sessions by guest QR scan on the tenant host (pay_first zone,
//    confirmed by staff when the scan left it pending).
//  - The device token header is sent with every call like the POS does.
//  - `till` holds floor.table.view/operate/manage + order.view; `limited` only
//    order.view, so the staff-permission check is 403 PERMISSION_DENIED.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const PIN = "582914";
const device = randomUUID();
const roles = { till: randomUUID(), limited: randomUUID() };

type Client = ReturnType<typeof agent>;
type Member = { client: Client; userId: string };
let app: Express;
let tenant: IsolatedTenant;
let host: { Host: string };
let sessionOwner: Member;
let cashierB: Member;
let limited: Member;
let zoneId: string;

async function member(label: string, roleId: string): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { client, userId };
}

const deviceToken = () =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId: device,
  });

async function tokenFor(who: Member): Promise<string> {
  const response = await sessionOwner.client
    .post("/api/staff-pins/pos-session")
    .set(host)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken())
    .send({ userId: who.userId, pin: PIN });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

/** A guest-scanned, confirmed (open) session on a fresh table. */
async function openSeat() {
  const table = await createTable(sessionOwner.client, { zoneId }, host);
  const qr = await issueQr(sessionOwner.client, table.id, host);
  const scanned = await scan(app, {
    token: qr.token,
    hostname: tenant.hostname,
  });
  expect(scanned.status, JSON.stringify(scanned.body)).toBe(201);
  const sessionId = scanned.body.data.session.id as string;
  if (scanned.body.data.session.status === "pending_confirmation") {
    const confirmed = await sessionOwner.client
      .post(`/api/table-sessions/${sessionId}/confirm`)
      .set(host)
      .set(originHeader);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  }
  return { tableId: table.id as string, sessionId };
}

const twoTables = async () =>
  [await openSeat(), await openSeat()].map((seat) => seat.tableId);

function call(path: string, body: object, token?: string | null) {
  const request = sessionOwner.client.post(path).set(host).set(originHeader);
  // legend-f586w: registered device without a token is shared-device mode.
  // No token means a browser-style client without a device identity.
  return (
    token
      ? request
          .set(DEVICE_TOKEN_HEADER, deviceToken())
          .set(ACTING_HEADER, token)
      : request
  ).send(body);
}

const link = (tableIds: string[], token?: string | null) =>
  call("/api/table-links", { tableIds }, token);
const unlink = (groupId: string, token?: string | null) =>
  call(`/api/table-links/${groupId}/unlink`, {}, token);

function expectError(
  response: { status: number; body: unknown },
  status: number,
  code: string,
) {
  const body = response.body as { error?: { code?: string } };
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(body.error?.code, JSON.stringify(response.body)).toBe(code);
}

/** Audit rows whose event JSON mentions `key`, with the recorded actor. */
async function auditRows(key: string) {
  const { rows } = await owner.query<{ id: string; actor: string | null }>(
    `SELECT id::text AS id, event->>'actorId' AS actor FROM audit_logs
     WHERE tenant_id = $1 AND event::text LIKE '%' || $2::text || '%'`,
    [tenant.tenantId, key],
  );
  return rows;
}

async function liveMembers(tableIds: string[]) {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM table_link_members WHERE tenant_id = $1 AND table_id = ANY($2::uuid[]) AND left_at IS NULL",
    [tenant.tenantId, tableIds],
  );
  return rows[0]!.n;
}

/** Links two fresh tables with no acting header (the session owner). */
async function linked(): Promise<{ tableIds: string[]; groupId: string }> {
  const tableIds = await twoTables();
  const response = await link(tableIds);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return { tableIds, groupId: response.body.data.group.id as string };
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`alk-${randomUUID().slice(0, 6)}`);
  host = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === device
      ? tenant.outletId
      : null,
  );
  const rolePerms: [string, string, string[]][] = [
    [
      roles.till,
      "Link Kasir",
      [
        "order.view",
        "floor.table.view",
        "floor.table.operate",
        "floor.table.manage",
      ],
    ],
    [roles.limited, "Link Terbatas", ["order.view"]],
  ];
  for (const [id, name, permissions] of rolePerms)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  sessionOwner = await member("Sesi Login Link", roles.till);
  cashierB = await member("Kasir B Link", roles.till);
  limited = await member("Staf Terbatas Link", roles.limited);
  const ctx = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    brandId: null,
    source: "session",
  });
  for (const who of [cashierB, limited])
    await setStaffPin(
      ctx,
      who.userId,
      { outletId: tenant.outletId, userId: who.userId },
      { pin: PIN },
    );
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', 'Kasir Link 1', now() - interval '1 minute')`,
    [device, tenant.tenantId, tenant.outletId],
  );
  const zone = await createZone(
    sessionOwner.client,
    {
      hours: [
        { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
      ],
    },
    host,
  );
  zoneId = zone.id;
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("acting staff on POST /api/table-links", () => {
  it("valid token links as the acting staff, recorded as the actor", async () => {
    const token = await tokenFor(cashierB);
    const tableIds = await twoTables();
    const response = await link(tableIds, token);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const groupId = response.body.data.group.id as string;
    const rows = await auditRows(groupId);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.actor).toBe(cashierB.userId);
    expect(cashierB.userId).not.toBe(sessionOwner.userId);
  });

  it("a staff member without floor.table.manage gets 403 PERMISSION_DENIED and no link is written", async () => {
    const token = await tokenFor(limited);
    const tableIds = await twoTables();
    expectError(await link(tableIds, token), 403, "PERMISSION_DENIED");
    expect(await liveMembers(tableIds)).toBe(0);
  });

  it("a garbage token is 401 ACTING_STAFF_INVALID, never the session owner", async () => {
    const tableIds = await twoTables();
    expectError(
      await link(tableIds, "pas_garbage-token"),
      401,
      "ACTING_STAFF_INVALID",
    );
    expect(await liveMembers(tableIds)).toBe(0);
  });

  it("without the header the session owner stays the actor", async () => {
    const { groupId } = await linked();
    const rows = await auditRows(groupId);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.actor).toBe(sessionOwner.userId);
  });
});

describe("acting staff on POST /api/table-links/:groupId/unlink", () => {
  it("valid token unlinks as the acting staff, recorded as the actor", async () => {
    const token = await tokenFor(cashierB);
    const { tableIds, groupId } = await linked();
    const before = new Set((await auditRows(groupId)).map((row) => row.id));
    const response = await unlink(groupId, token);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const added = (await auditRows(groupId)).filter(
      (row) => !before.has(row.id),
    );
    expect(added.length).toBeGreaterThan(0);
    for (const row of added) expect(row.actor).toBe(cashierB.userId);
    expect(await liveMembers(tableIds)).toBe(0);
  });

  it("a staff member without floor.table.manage gets 403 PERMISSION_DENIED and the group stays", async () => {
    const token = await tokenFor(limited);
    const { tableIds, groupId } = await linked();
    expectError(await unlink(groupId, token), 403, "PERMISSION_DENIED");
    expect(await liveMembers(tableIds)).toBe(2);
  });

  it("a garbage token is 401 ACTING_STAFF_INVALID and the group stays", async () => {
    const { tableIds, groupId } = await linked();
    expectError(
      await unlink(groupId, "pas_garbage-token"),
      401,
      "ACTING_STAFF_INVALID",
    );
    expect(await liveMembers(tableIds)).toBe(2);
  });

  it("without the header the session owner stays the actor", async () => {
    const { groupId } = await linked();
    const before = new Set((await auditRows(groupId)).map((row) => row.id));
    expect((await unlink(groupId)).status).toBe(200);
    const added = (await auditRows(groupId)).filter(
      (row) => !before.has(row.id),
    );
    expect(added.length).toBeGreaterThan(0);
    for (const row of added) expect(row.actor).toBe(sessionOwner.userId);
  });
});
