// Shared-device mode is only for POS devices (legend-xrbjv, follow-up of
// legend-f586w / legend-ypwsp). Written from the card brief, not the implementation.
// Spec: `PATCH /api/devices/:deviceId/shared-mode` with `sharedMode: true` on any
// device whose type is not `pos` answers 409 `CONFLICT` with the message
// "Mode perangkat bersama hanya untuk perangkat POS.", leaves the device
// unchanged and writes no audit row. `sharedMode: false` on a non-POS device
// stays allowed (the safe direction, idempotent). POS devices behave as before.
//
// Assumptions:
//  - Devices are inserted by SQL (as device-shared-mode.test.ts does) instead of
//    `enrollDevice`: the isolated tenant has no scoped session context here and the
//    HTTP route is what is under test. The row is the same as an enrolled one.
//  - The error code is read from `body.error.code`, the message from
//    `body.error.message`, like the other HTTP suites.
//  - A non-POS device whose flag was forced on by SQL (it cannot be produced by the
//    cloud any more) can still be switched off: 200, flag cleared. Whether that
//    writes a `device.shared_mode_disabled` audit row is not asserted.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceSchema } from "@starter/shared/edge";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const ENABLED = "device.shared_mode_enabled";
const DISABLED = "device.shared_mode_disabled";
const MESSAGE = "Mode perangkat bersama hanya untuk perangkat POS.";

const NON_POS_TYPES = [
  "kds",
  "printer",
  "display",
  "waiter_phone",
  "edc",
  "smart_lock",
  "panic_button",
] as const;

type Client = ReturnType<typeof agent>;
type Member = { client: Client; userId: string };

let app: Express;
let tenant: IsolatedTenant;
let host: { Host: string };
let admin: Member;

async function addDevice(type: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute')`,
    [
      id,
      tenant.tenantId,
      tenant.outletId,
      type,
      `Uji ${type} ${id.slice(0, 6)}`,
    ],
  );
  return id;
}

async function rowOf(id: string) {
  const { rows } = await owner.query<{
    shared_mode: boolean;
    status: string;
    type: string;
  }>("SELECT shared_mode, status, type FROM devices WHERE id = $1", [id]);
  return rows[0]!;
}

async function auditCount(deviceId: string, action: string): Promise<number> {
  const { rows } = await owner.query(
    `SELECT 1 FROM audit_logs
      WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = $3`,
    [tenant.tenantId, deviceId, action],
  );
  return rows.length;
}

const patch = (deviceId: string, body: unknown) =>
  admin.client
    .patch(`/api/devices/${encodeURIComponent(deviceId)}/shared-mode`)
    .set(host)
    .set(originHeader)
    .send(body as object);

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`shty-${randomUUID().slice(0, 6)}`);
  host = { Host: tenant.hostname };

  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Pengelola Perangkat Tipe', false, NULL, $3, false, '["tenant","outlet"]')`,
    [roleId, tenant.tenantId, JSON.stringify(["device.registry.manage"])],
  );
  const client = agent(app);
  const email = await signUp(client, "Pengelola Tipe Perangkat");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  await verifySessionMfa(email);
  admin = { client, userId };
});

afterAll(async () => {
  await owner.query("DELETE FROM devices WHERE tenant_id = $1", [
    tenant.tenantId,
  ]);
  await dropIsolatedTenant(tenant);
  await owner.end();
});

describe("shared mode is only for POS devices", () => {
  it.each(NON_POS_TYPES)(
    "a %s device cannot be switched to shared mode: 409 CONFLICT, flag unchanged, no audit row",
    async (type) => {
      const id = await addDevice(type);
      const response = await patch(id, { sharedMode: true });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error?.code).toBe("CONFLICT");
      expect(response.body.error?.message ?? "").toContain(MESSAGE);

      expect(await rowOf(id)).toMatchObject({
        shared_mode: false,
        status: "active",
        type,
      });
      expect(await auditCount(id, ENABLED)).toBe(0);
      expect(await auditCount(id, DISABLED)).toBe(0);
    },
  );

  it("a POS device still switches to shared mode: 200 and the flag is stored", async () => {
    const id = await addDevice("pos");
    const response = await patch(id, { sharedMode: true });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(deviceSchema.parse(response.body.data)).toMatchObject({
      id,
      type: "pos",
      sharedMode: true,
    });
    expect((await rowOf(id)).shared_mode).toBe(true);
    expect(await auditCount(id, ENABLED)).toBe(1);
  });

  // A flagged non-POS row cannot exist any more: the database refuses it
  // (CHECK devices_shared_mode_pos_only, shared-device-marks.test.ts), so there
  // is no "switch off a flagged non-POS device" case left to test.

  it("switching it off on an unflagged non-POS device is an idempotent 200", async () => {
    const id = await addDevice("printer");
    const response = await patch(id, { sharedMode: false });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await rowOf(id)).shared_mode).toBe(false);
    expect(await auditCount(id, ENABLED)).toBe(0);
  });
});
