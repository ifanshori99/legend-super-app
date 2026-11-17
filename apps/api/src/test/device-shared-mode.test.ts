// PATCH /api/devices/:deviceId/shared-mode (legend-f586w, legend-ypwsp).
// Written from the shared contract (`setOutletDeviceSharedMode` in
// packages/shared/src/edge/endpoints.ts, `deviceSchema`) and the card brief,
// not from the implementation. Spec: back office switch for shared-device mode;
// same guards as training mode: `device.registry.manage`, tenant and outlet
// scope, audit event `device.shared_mode_enabled` / `device.shared_mode_disabled`,
// strict body `{ sharedMode: boolean }`, trusted origin, active devices only.
//
// Assumptions (the contract leaves these open):
//  - Refusals for a missing permission or an out-of-scope outlet are 403 or 404
//    (the registry may hide what the caller cannot manage), as the existing
//    revoke tests accept. A device of another tenant is exactly 404.
//  - A malformed body is 400 or 422; a revoked device is 404 or 409.
//  - Audit `maskedChanges.before/after` carry a boolean `sharedMode`.
//  - Setting the same value again answers 200 with the unchanged device and
//    writes no second audit row ("idempotent").
//  - The tenant comes from the Host header (verified hostname of the isolated
//    tenant), as in the other isolated-tenant suites.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceSchema } from "@starter/shared/edge";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const ENABLED = "device.shared_mode_enabled";
const DISABLED = "device.shared_mode_disabled";

type Client = ReturnType<typeof agent>;
type Member = { client: Client; userId: string };

let app: Express;
let tenant: IsolatedTenant;
let foreign: IsolatedTenant;
let host: { Host: string };
let outletA: string;
let outletB: string;
let manageRole: string;
let viewRole: string;
let admin: Member;
let outletAdminA: Member;
let noPermission: Member;

async function member(
  label: string,
  roleId: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
): Promise<Member> {
  const client = agent(app);
  const email = await signUp(client, label);
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenant.tenantId,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
  await verifySessionMfa(email);
  return { client, userId };
}

async function addDevice(
  tenantId: string,
  outletId: string,
  extra: { revoked?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute')`,
    [id, tenantId, outletId, `Kasir Mode ${id.slice(0, 6)}`],
  );
  if (extra.revoked)
    await owner.query(
      "UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1",
      [id],
    );
  return id;
}

async function flagOf(id: string): Promise<boolean> {
  const { rows } = await owner.query<{ shared_mode: boolean }>(
    "SELECT shared_mode FROM devices WHERE id = $1",
    [id],
  );
  return rows[0]!.shared_mode;
}

type AuditEvent = {
  actorId: string | null;
  objectId: string | null;
  maskedChanges: {
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  };
};

async function auditRows(deviceId: string, action: string) {
  const { rows } = await owner.query<{ event: AuditEvent }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = $3
      ORDER BY event->>'createdAt', id`,
    [tenant.tenantId, deviceId, action],
  );
  return rows.map((row) => row.event);
}

const patch = (
  who: Member,
  deviceId: string,
  body: unknown,
  origin: Record<string, string> = originHeader,
) =>
  who.client
    .patch(`/api/devices/${encodeURIComponent(deviceId)}/shared-mode`)
    .set(host)
    .set(origin)
    .send(body as object);

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`shm-${randomUUID().slice(0, 6)}`);
  foreign = await createIsolatedTenant(`shx-${randomUUID().slice(0, 6)}`);
  host = { Host: tenant.hostname };
  outletA = tenant.outletId;
  outletB = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet B Mode', 'Jl. Uji 2', 'Asia/Jakarta', $6, 'active')`,
    [
      outletB,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `SHMB-${outletB.slice(0, 6)}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  manageRole = randomUUID();
  viewRole = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $3, 'Pengelola Perangkat', false, NULL, $4, false, '["tenant","outlet"]'),
            ($2, $3, 'Hanya Lihat Meja', false, NULL, $5, false, '["tenant","outlet"]')`,
    [
      manageRole,
      viewRole,
      tenant.tenantId,
      JSON.stringify(["device.registry.manage"]),
      JSON.stringify(["floor.table.view"]),
    ],
  );
  admin = await member("Pengelola Tenant", manageRole, { type: "tenant" });
  outletAdminA = await member("Pengelola Outlet A", manageRole, {
    type: "outlet",
    id: outletA,
  });
  noPermission = await member("Tanpa Izin Perangkat", viewRole, {
    type: "tenant",
  });
});

afterAll(async () => {
  for (const t of [tenant, foreign]) {
    await owner.query("DELETE FROM devices WHERE tenant_id = $1", [t.tenantId]);
  }
  // audit_logs (append-only, outlet FK) is purged inside dropIsolatedTenant, so
  // the extra outlet goes after it, not before.
  await dropIsolatedTenant(tenant);
  await dropIsolatedTenant(foreign);
  for (const t of [tenant, foreign])
    await owner.query("DELETE FROM outlets WHERE tenant_id = $1 AND id = $2", [
      t.tenantId,
      outletB,
    ]);
  await owner.end();
});

describe("PATCH /api/devices/:deviceId/shared-mode", () => {
  it("a device manager switches shared mode on: 200, the device matches the contract, the flag is stored", async () => {
    const id = await addDevice(tenant.tenantId, outletA);
    expect(await flagOf(id)).toBe(false);
    const response = await patch(admin, id, { sharedMode: true });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const device = deviceSchema.parse(response.body.data);
    expect(device).toMatchObject({ id, sharedMode: true, status: "active" });
    expect(await flagOf(id)).toBe(true);
  });

  it("switching it off again: 200 and the flag is cleared", async () => {
    const id = await addDevice(tenant.tenantId, outletA);
    await patch(admin, id, { sharedMode: true });
    const response = await patch(admin, id, { sharedMode: false });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(deviceSchema.parse(response.body.data).sharedMode).toBe(false);
    expect(await flagOf(id)).toBe(false);
  });

  it("setting the same value twice is idempotent: 200 both times and one audit row", async () => {
    const id = await addDevice(tenant.tenantId, outletA);
    const first = await patch(admin, id, { sharedMode: true });
    const second = await patch(admin, id, { sharedMode: true });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.data).toMatchObject({ id, sharedMode: true });
    expect(await flagOf(id)).toBe(true);
    expect(await auditRows(id, ENABLED)).toHaveLength(1);

    // Switching off a device that is already off changes nothing either.
    const other = await addDevice(tenant.tenantId, outletA);
    const off = await patch(admin, other, { sharedMode: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(await flagOf(other)).toBe(false);
    expect(await auditRows(other, DISABLED)).toHaveLength(0);
  });

  it("each change is audited with actor, device, and the before/after flag", async () => {
    const id = await addDevice(tenant.tenantId, outletA);
    expect((await patch(admin, id, { sharedMode: true })).status).toBe(200);
    const enabled = await auditRows(id, ENABLED);
    expect(enabled).toHaveLength(1);
    expect(enabled[0]).toMatchObject({ actorId: admin.userId, objectId: id });
    expect(enabled[0]!.maskedChanges.before).toMatchObject({
      sharedMode: false,
    });
    expect(enabled[0]!.maskedChanges.after).toMatchObject({ sharedMode: true });

    expect((await patch(admin, id, { sharedMode: false })).status).toBe(200);
    const disabled = await auditRows(id, DISABLED);
    expect(disabled).toHaveLength(1);
    expect(disabled[0]).toMatchObject({ actorId: admin.userId, objectId: id });
    expect(disabled[0]!.maskedChanges.before).toMatchObject({
      sharedMode: true,
    });
    expect(disabled[0]!.maskedChanges.after).toMatchObject({
      sharedMode: false,
    });
    // The two actions never cross over.
    expect(await auditRows(id, ENABLED)).toHaveLength(1);
  });

  it("a user without device.registry.manage is refused and the flag stays", async () => {
    const id = await addDevice(tenant.tenantId, outletA);
    const response = await patch(noPermission, id, { sharedMode: true });
    expect([403, 404], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(await flagOf(id)).toBe(false);
    expect(await auditRows(id, ENABLED)).toHaveLength(0);
  });

  it("an anonymous caller gets 401 and the flag stays", async () => {
    const id = await addDevice(tenant.tenantId, outletA);
    const response = await agent(app)
      .patch(`/api/devices/${id}/shared-mode`)
      .set(host)
      .set(originHeader)
      .send({ sharedMode: true });
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(await flagOf(id)).toBe(false);
  });

  it("a device of another tenant is 404 and stays untouched", async () => {
    const id = await addDevice(foreign.tenantId, foreign.outletId);
    const response = await patch(admin, id, { sharedMode: true });
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(await flagOf(id)).toBe(false);
  });

  it("an unknown device id is 404", async () => {
    const response = await patch(admin, randomUUID(), { sharedMode: true });
    expect(response.status, JSON.stringify(response.body)).toBe(404);
  });

  it("a manager scoped to outlet A can flag a device of outlet A but not of outlet B", async () => {
    const own = await addDevice(tenant.tenantId, outletA);
    const ok = await patch(outletAdminA, own, { sharedMode: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await flagOf(own)).toBe(true);

    const other = await addDevice(tenant.tenantId, outletB);
    const refused = await patch(outletAdminA, other, { sharedMode: true });
    expect([403, 404], JSON.stringify(refused.body)).toContain(refused.status);
    expect(await flagOf(other)).toBe(false);
    expect(await auditRows(other, ENABLED)).toHaveLength(0);

    // The tenant-wide manager still reaches outlet B.
    const wide = await patch(admin, other, { sharedMode: true });
    expect(wide.status, JSON.stringify(wide.body)).toBe(200);
    expect(await flagOf(other)).toBe(true);
  });

  it("a revoked device cannot be switched and stays unflagged", async () => {
    const id = await addDevice(tenant.tenantId, outletA, { revoked: true });
    const response = await patch(admin, id, { sharedMode: true });
    expect([404, 409], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(await flagOf(id)).toBe(false);
  });

  it.each([
    ["an extra key", { sharedMode: true, trainingMode: true }],
    ["a missing sharedMode", {}],
    ["a non-boolean sharedMode", { sharedMode: "yes" }],
    ["a null sharedMode", { sharedMode: null }],
  ])(
    "a strict body: %s is rejected and the flag stays",
    async (_name, body) => {
      const id = await addDevice(tenant.tenantId, outletA);
      const response = await patch(admin, id, body);
      expect([400, 422], JSON.stringify(response.body)).toContain(
        response.status,
      );
      expect(await flagOf(id)).toBe(false);
      expect(await auditRows(id, ENABLED)).toHaveLength(0);
    },
  );

  it("a malformed device id is rejected", async () => {
    const response = await patch(admin, "not-a-uuid", { sharedMode: true });
    expect([400, 404, 422], JSON.stringify(response.body)).toContain(
      response.status,
    );
  });

  it("a request from an untrusted origin is refused (403) and the flag stays", async () => {
    const id = await addDevice(tenant.tenantId, outletA);
    const response = await patch(
      admin,
      id,
      { sharedMode: true },
      { Origin: "https://evil.example" },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await flagOf(id)).toBe(false);
    expect(await auditRows(id, ENABLED)).toHaveLength(0);
  });
});

// ---- round C: device management is refused from a shared device (1012) ---------
// Decision (CTO brief, legend-a6aq6, and the 1012 shared-device router guard):
// managing devices (revoke, and shared mode both ON and OFF) is a back office
// action from a PERSONAL device. When the caller's login session is marked with a
// shared device (`session.shared_device_ids` is non-empty) or the request carries
// a device token header, the default-closed `requireAuth` answers 403 with code
// `ACTING_STAFF_NOT_ALLOWED` before any handler runs, for ANY device (own or
// other). There is no step-up flow from the tablet: the tablet sees the guard text
// "Perangkat bersama: fitur ini hanya bisa dibuka dari perangkat pribadi." and
// the owner switches the mode off or revokes from a personal device. Another, unmarked session
// still manages the device normally, and doing so closes the tablet's session
// (1024 decision): its follow-up requests answer 401.
// Earlier premise (pre-1012, now replaced): the marked session could manage OTHER
// devices and only its own device was forbidden, with a fixed message text.
// Assumptions: the mark is written by SQL here (the middleware stamping is covered
// in acting-staff-shared-device.test.ts); the closed session is observed through
// a 401 on a follow-up request, not through the storage of the session row.
describe("device management is refused from a shared device", () => {
  let powerRole: string;

  beforeAll(async () => {
    powerRole = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Pengelola Penuh Perangkat', false, NULL, $3, false, '["tenant","outlet"]')`,
      [
        powerRole,
        tenant.tenantId,
        JSON.stringify(["device.registry.manage", "device.registry.revoke"]),
      ],
    );
  });

  const powerMember = (label: string) =>
    member(label, powerRole, { type: "tenant" });

  async function flaggedDevice(): Promise<string> {
    const id = await addDevice(tenant.tenantId, outletA);
    await owner.query("UPDATE devices SET shared_mode = true WHERE id = $1", [
      id,
    ]);
    return id;
  }

  /** The login session was marked by an earlier request from the shared device. */
  async function mark(who: Member, deviceId: string) {
    const { rowCount } = await owner.query(
      `UPDATE "session" SET shared_device_ids = ARRAY[$2]::uuid[] WHERE user_id = $1`,
      [who.userId, deviceId],
    );
    expect(rowCount).toBeGreaterThan(0);
  }

  const tokenOf = (deviceId: string) => ({
    [DEVICE_TOKEN_HEADER]: signDeviceToken({
      version: 1,
      issuedAt: Math.floor(Date.now() / 1000),
      tenantId: tenant.tenantId,
      brandId: null,
      deviceId,
    }),
  });

  const revoke = (
    who: Member,
    deviceId: string,
    extra: Record<string, string> = {},
  ) =>
    who.client
      .post(`/api/devices/${encodeURIComponent(deviceId)}/revoke`)
      .set(host)
      .set(originHeader)
      .set(extra)
      .send({
        reason: "Perangkat hilang saat uji",
        idempotencyKey: randomUUID(),
      });

  async function statusOf(id: string): Promise<string> {
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM devices WHERE id = $1",
      [id],
    );
    return rows[0]!.status;
  }

  /** 403 with the acting-staff "not allowed on a shared device" code. */
  function expectSharedDeviceRefusal(response: {
    status: number;
    body: unknown;
  }) {
    const body = response.body as { error?: { code?: string } };
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(body.error?.code).toBe(ACTING_STAFF_ERROR_CODES.NOT_ALLOWED);
  }

  /** The tablet's session was closed: an authenticated route now answers 401. */
  async function expectSessionClosed(marked: Member) {
    const probe = await addDevice(tenant.tenantId, outletA);
    const response = await patch(marked, probe, { sharedMode: true });
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(await flagOf(probe)).toBe(false);
  }

  // Changed (legend-a6aq6): was a 403 with the "Matikan mode ..." message for the
  // own device only; now the whole route is refused with ACTING_STAFF_NOT_ALLOWED.
  it("a session marked with the device cannot switch its shared mode off: 403 ACTING_STAFF_NOT_ALLOWED, flag and audit unchanged", async () => {
    const id = await flaggedDevice();
    const marked = await powerMember("Sesi Bertanda Matikan");
    await mark(marked, id);
    const response = await patch(marked, id, { sharedMode: false });
    expectSharedDeviceRefusal(response);
    expect(await flagOf(id)).toBe(true);
    expect(await auditRows(id, DISABLED)).toHaveLength(0);
  });

  // Changed (legend-a6aq6): same new code instead of the fixed message text.
  it("a request carrying the device's own token header cannot switch it off either", async () => {
    const id = await flaggedDevice();
    const caller = await powerMember("Sesi Header Perangkat");
    const response = await caller.client
      .patch(`/api/devices/${encodeURIComponent(id)}/shared-mode`)
      .set(host)
      .set(originHeader)
      .set(tokenOf(id))
      .send({ sharedMode: false });
    expectSharedDeviceRefusal(response);
    expect(await flagOf(id)).toBe(true);
    expect(await auditRows(id, DISABLED)).toHaveLength(0);
  });

  // Extended (legend-a6aq6, 1024): after the switch-off the tablet's own session is
  // closed, so it can no longer act.
  it("another session without the mark or the header switches it off: 200 and the tablet's session is closed", async () => {
    const id = await flaggedDevice();
    const marked = await powerMember("Sesi Bertanda Lain");
    await mark(marked, id);
    const other = await powerMember("Sesi Perangkat Lain");
    const response = await patch(other, id, { sharedMode: false });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await flagOf(id)).toBe(false);
    expect(await auditRows(id, DISABLED)).toHaveLength(1);
    await expectSessionClosed(marked);
  });

  // Changed (legend-a6aq6): was "marked session may still switch ON and manage
  // other devices"; now it cannot manage ANY device, ON or OFF, own or other.
  it("a marked session cannot manage ANY device: switching shared mode on or off is refused", async () => {
    const id = await flaggedDevice();
    const marked = await powerMember("Sesi Bertanda Hidupkan");
    await mark(marked, id);

    // (a) switch ON another, unflagged device
    const enableOther = await addDevice(tenant.tenantId, outletA);
    const on = await patch(marked, enableOther, { sharedMode: true });
    expectSharedDeviceRefusal(on);
    expect(await flagOf(enableOther)).toBe(false);
    expect(await auditRows(enableOther, ENABLED)).toHaveLength(0);

    // (b) switch ON its own device (already on): still refused, stays on
    const again = await patch(marked, id, { sharedMode: true });
    expectSharedDeviceRefusal(again);
    expect(await flagOf(id)).toBe(true);

    // (c) switch OFF a different flagged device: refused, flag stays
    const flaggedOther = await flaggedDevice();
    const off = await patch(marked, flaggedOther, { sharedMode: false });
    expectSharedDeviceRefusal(off);
    expect(await flagOf(flaggedOther)).toBe(true);
    expect(await auditRows(flaggedOther, DISABLED)).toHaveLength(0);
  });

  // Changed (legend-a6aq6): new code instead of the fixed message text.
  it("a session marked with the device cannot revoke it: 403 ACTING_STAFF_NOT_ALLOWED and the device stays active", async () => {
    const id = await flaggedDevice();
    const marked = await powerMember("Sesi Bertanda Cabut");
    await mark(marked, id);
    const response = await revoke(marked, id);
    expectSharedDeviceRefusal(response);
    expect(await statusOf(id)).toBe("active");
  });

  // Changed (legend-a6aq6): new code instead of the fixed message text.
  it("a request carrying the device's own token header cannot revoke it", async () => {
    const id = await flaggedDevice();
    const caller = await powerMember("Sesi Header Cabut");
    const response = await revoke(caller, id, tokenOf(id));
    expectSharedDeviceRefusal(response);
    expect(await statusOf(id)).toBe("active");
  });

  // Extended (legend-a6aq6, 1024): the revoked tablet's session is closed.
  it("another session revokes the device: 200, it is revoked and the tablet's session is closed", async () => {
    const id = await flaggedDevice();
    const marked = await powerMember("Sesi Bertanda Cabut Lain");
    await mark(marked, id);
    const other = await powerMember("Sesi Pencabut");
    const response = await revoke(other, id);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await statusOf(id)).toBe("revoked");
    await expectSessionClosed(marked);
  });

  // Changed (legend-a6aq6): was "the marked session can revoke a different
  // device" (200); now it is refused and both devices stay active.
  it("a marked session cannot revoke a different device either", async () => {
    const id = await flaggedDevice();
    const marked = await powerMember("Sesi Bertanda Cabut Beda");
    await mark(marked, id);
    const otherDevice = await addDevice(tenant.tenantId, outletA);
    const response = await revoke(marked, otherDevice);
    expectSharedDeviceRefusal(response);
    expect(await statusOf(otherDevice)).toBe("active");
    expect(await statusOf(id)).toBe("active");
  });
});
