// Device token generation on every POS request (second-opinion 495 G1, tier K
// access; PRD v1.7 §3 F5 Registri Perangkat, §3 F6, TEN-02, AUTH-06). A
// reissued device token replaces every older one (services/device.service.ts
// issueDeviceToken moves `devices.token_issued_at`). On a session request the
// tenant comes from the domain, so the device token is read by routes/device-id.ts
// and the acting-staff middleware; both must ask the registry, not only check
// the signature.
//
// Contract under test, after a rotation the OLD device token (valid signature,
// `issuedAt` before the registry's `token_issued_at`) is 401 on:
//   - POST /api/staff-pins/pos-session      (start an acting-staff session)
//   - POST /api/pos-overrides                (with and without X-Acting-Staff)
//   - GET  /api/pos-overrides/:overrideId    (acting cashier poll)
//   - GET  /api/pos-overrides/approvals/:requestId          (read)
//   - POST /api/pos-overrides/approvals/:requestId/cancel   (cancel; stays pending)
// while the NEW token of the same device keeps working (same acting token).
// Real Express app + Better Auth + PostgreSQL (disposable server).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const PIN = "582914";
const tillRole = randomUUID();
const devices = new Set<string>();

type Client = ReturnType<typeof agent>;
type Member = { client: Client; userId: string };
let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let sessionOwner: Member;
let staff: Member;

const nowSeconds = () => Math.floor(Date.now() / 1000);

const deviceToken = (deviceId: string, issuedAt: number) =>
  signDeviceToken({
    version: 1,
    issuedAt,
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });

async function asTenant(sql: string, params: unknown[]): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
    );
    await client.query(sql, params);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A registered device (generation three minutes ago) and a token of it. */
async function registeredDevice(): Promise<{ id: string; oldToken: string }> {
  const id = randomUUID();
  devices.add(id);
  await asTenant(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', 'Kasir Rotasi', now() - interval '3 minutes')`,
    [id, tenant.tenantId, tenant.outletId],
  );
  return { id, oldToken: deviceToken(id, nowSeconds() - 120) };
}

/** Reissue: the registry generation moves on, the old token is replaced. */
async function rotate(deviceId: string): Promise<string> {
  await asTenant(
    `UPDATE devices SET token_issued_at = now() - interval '30 seconds'
     WHERE id = $1 AND tenant_id = $2`,
    [deviceId, tenant.tenantId],
  );
  return deviceToken(deviceId, nowSeconds());
}

async function member(label: string): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, tillRole],
  );
  return { client, userId };
}

function posSession(deviceTokenValue: string) {
  return sessionOwner.client
    .post("/api/staff-pins/pos-session")
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceTokenValue)
    .send({ userId: staff.userId, pin: PIN });
}

async function actingToken(deviceTokenValue: string): Promise<string> {
  const response = await posSession(deviceTokenValue);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

function postOverride(deviceTokenValue: string, acting?: string) {
  let request = sessionOwner.client
    .post("/api/pos-overrides")
    .set(headers)
    .set(originHeader)
    .set("Idempotency-Key", `rot-${randomUUID()}`)
    .set(DEVICE_TOKEN_HEADER, deviceTokenValue);
  if (acting) request = request.set(ACTING_HEADER, acting);
  return request.send({
    outletId: tenant.outletId,
    action: "void",
    valueIdr: 25000,
    reason: "Pelanggan batal pesan.",
    objectType: "order",
    objectId: randomUUID(),
    approval: { method: "supervisor_phone" },
  });
}

async function openPhoneOverride(deviceTokenValue: string, acting: string) {
  const response = await postOverride(deviceTokenValue, acting);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as { id: string; approvalRequestId: string };
}

function withDevice(
  request: ReturnType<Client["get"]>,
  deviceTokenValue: string,
  acting: string,
) {
  return request
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceTokenValue)
    .set(ACTING_HEADER, acting);
}

async function statusOf(id: string): Promise<string | undefined> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM approval_requests WHERE id = $1",
    [id],
  );
  return rows[0]?.status;
}

beforeAll(async () => {
  app = createApp();
  setAuditWriter({ record: async () => {} });
  tenant = await createIsolatedTenant(`rot-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && devices.has(deviceId)
      ? tenant.outletId
      : null,
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'POS Rotasi Kasir', false, NULL, $3, false, '["tenant"]')`,
    [
      tillRole,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "shift.cash.operate",
        "pos.override.request",
      ]),
    ],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'void', NULL, $2, 1)`,
    [tenant.tenantId, tillRole],
  );
  sessionOwner = await member("Sesi Login Rotasi");
  staff = await member("Kasir Rotasi");
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    staff.userId,
    { outletId: tenant.outletId, userId: staff.userId },
    { pin: PIN },
  );
});

afterAll(async () => {
  setAuditWriter(null);
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("G1 an old device token is refused after rotation", () => {
  it("G1 POST /api/staff-pins/pos-session: the old token is 401, the new one starts the acting session", async () => {
    const device = await registeredDevice();
    const fresh = await rotate(device.id);

    const replay = await posSession(device.oldToken);
    expect(replay.status, JSON.stringify(replay.body)).toBe(401);

    const current = await posSession(fresh);
    expect(current.status, JSON.stringify(current.body)).toBe(201);
  });

  it("G1 POST /api/pos-overrides: the old token is 401 with and without an acting cashier", async () => {
    const device = await registeredDevice();
    const acting = await actingToken(device.oldToken);
    const fresh = await rotate(device.id);

    const withActing = await postOverride(device.oldToken, acting);
    expect(withActing.status, JSON.stringify(withActing.body)).toBe(401);
    const withoutActing = await postOverride(device.oldToken);
    expect(withoutActing.status, JSON.stringify(withoutActing.body)).toBe(401);

    const current = await postOverride(fresh, acting);
    expect(current.status, JSON.stringify(current.body)).toBe(201);
  });

  it("G1 GET /api/pos-overrides/:overrideId and GET /approvals/:requestId: the old token is 401", async () => {
    const device = await registeredDevice();
    const acting = await actingToken(device.oldToken);
    const opened = await openPhoneOverride(device.oldToken, acting);
    const fresh = await rotate(device.id);

    const poll = await withDevice(
      sessionOwner.client.get(`/api/pos-overrides/${opened.id}`),
      device.oldToken,
      acting,
    );
    expect(poll.status, JSON.stringify(poll.body)).toBe(401);
    const read = await withDevice(
      sessionOwner.client.get(
        `/api/pos-overrides/approvals/${opened.approvalRequestId}`,
      ),
      device.oldToken,
      acting,
    );
    expect(read.status, JSON.stringify(read.body)).toBe(401);

    const currentRead = await withDevice(
      sessionOwner.client.get(
        `/api/pos-overrides/approvals/${opened.approvalRequestId}`,
      ),
      fresh,
      acting,
    );
    expect(currentRead.status, JSON.stringify(currentRead.body)).toBe(200);
  });

  it("G1 POST /approvals/:requestId/cancel: the old token is 401 and the request stays pending", async () => {
    const device = await registeredDevice();
    const acting = await actingToken(device.oldToken);
    const opened = await openPhoneOverride(device.oldToken, acting);
    const fresh = await rotate(device.id);

    const replay = await withDevice(
      sessionOwner.client.post(
        `/api/pos-overrides/approvals/${opened.approvalRequestId}/cancel`,
      ),
      device.oldToken,
      acting,
    );
    expect(replay.status, JSON.stringify(replay.body)).toBe(401);
    expect(await statusOf(opened.approvalRequestId)).toBe("pending");

    const current = await withDevice(
      sessionOwner.client.post(
        `/api/pos-overrides/approvals/${opened.approvalRequestId}/cancel`,
      ),
      fresh,
      acting,
    );
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    expect(await statusOf(opened.approvalRequestId)).toBe("cancelled");
  });

  it("G1 a revoked device's token is 401 on the acting cashier read", async () => {
    const device = await registeredDevice();
    const acting = await actingToken(device.oldToken);
    const opened = await openPhoneOverride(device.oldToken, acting);
    await asTenant(
      `UPDATE devices SET status = 'revoked', revoked_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [device.id, tenant.tenantId],
    );
    const read = await withDevice(
      sessionOwner.client.get(
        `/api/pos-overrides/approvals/${opened.approvalRequestId}`,
      ),
      device.oldToken,
      acting,
    );
    expect(read.status, JSON.stringify(read.body)).toBe(401);
  });
});
