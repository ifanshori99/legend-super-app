// A PIN approval for a cash shift close is bound to the verified device that
// created it (bead legend-fjwxo, Codex 418 finding 3 follow-up; PRD v1.7 §3 F8
// "Shift Kasir", §3.7 approval matrix, AUTH-06). closePosShift and
// forceClosePosShift verify the `cash_shift_close` approval through
// verifyCloseApproval, which must apply the same device rule as the POS order
// consumers: an approval typed on device A is refused for device B and for a
// caller that names no device, and stays unspent for A.
//
// Assumptions (spec silent): the refusal is the shift close's own 403
// FORBIDDEN (same as every other approval mismatch), and a refused close
// leaves the shift open.
//
// Fixtures are trimmed copies of pos-shift-codex146.test.ts.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { establishTenantContext } from "@starter/shared/core/server";
import { tenantIdSchema, userIdSchema } from "@starter/shared/core";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { posShiftCountReceiptSchema } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const FLOAT_IDR = 100_000;

const roleIds = { cashier: randomUUID(), supervisor: randomUUID() };

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };

type Member = { client: ReturnType<typeof agent>; userId: string };
let supervisor: Member;

const registeredDevices = new Map<string, string>();

async function member(roleId: string, label: string): Promise<Member> {
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

/** A registered POS device of the outlet (the PIN throttle references it). */
async function newDeviceId(): Promise<string> {
  const deviceId = randomUUID();
  registeredDevices.set(`${tenant.tenantId}:${deviceId}`, tenant.outletId);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
    );
    await client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', 'Kasir bind shift', now())`,
      [deviceId, tenant.tenantId, tenant.outletId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return deviceId;
}

function deviceHeader(deviceId: string): string {
  return signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });
}

const SHIFTS = () =>
  `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/shifts`;

type Req = ReturnType<Member["client"]["post"]>;
function from(request: Req, deviceId: string | null): Req {
  const base = request.set(headers).set(originHeader);
  return deviceId === null
    ? base
    : base.set(DEVICE_TOKEN_HEADER, deviceHeader(deviceId));
}

async function openShift(
  cashier: Member,
  deviceId: string,
): Promise<{ id: string }> {
  const response = await from(cashier.client.post(SHIFTS()), deviceId).send({
    openingFloatIdr: FLOAT_IDR,
    idempotencyKey: randomUUID(),
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as { id: string };
}

/** A blind count of exactly the float: variance 0. */
async function countFloat(who: Member, shiftId: string): Promise<string> {
  const response = await from(
    who.client.post(`${SHIFTS()}/${shiftId}/counts`),
    null,
  ).send({
    idempotencyKey: randomUUID(),
    counts: [{ denominationIdr: 100_000, quantity: 1 }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return posShiftCountReceiptSchema.parse(response.body.data).id;
}

/** The supervisor's PIN typed on `deviceId` for closing with `countId`. */
async function approveOnDevice(
  requester: Member,
  countId: string,
  deviceId: string | null,
): Promise<string> {
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    requester.userId,
    {
      outletId: tenant.outletId,
      action: "cash_shift_close",
      valueIdr: 0,
      reason: "Hitung kas akhir shift",
      objectType: "pos_shift_count",
      objectId: countId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(supervisor.userId),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID(), deviceId },
  );
  return override.id;
}

async function shiftStatus(shiftId: string): Promise<string | undefined> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM pos_shifts WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, shiftId],
  );
  return rows[0]?.status;
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`shiftbind-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(
    async ({ tenantId, deviceId }) =>
      registeredDevices.get(`${tenantId}:${deviceId}`) ?? null,
  );
  const roles: [string, string, string[]][] = [
    [roleIds.cashier, "Kasir Bind Shift", ["shift.cash.operate"]],
    [roleIds.supervisor, "Supervisor Bind Shift", ["shift.cash.approve_close"]],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  supervisor = await member(roleIds.supervisor, "Supervisor Bind");
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("legend-fjwxo a shift close approval is bound to the verified device", () => {
  it("legend-fjwxo close: an approval made on device A is refused from device B and from no device, and closes from device A", async () => {
    const cashier = await member(roleIds.cashier, "Kasir Bind Tutup");
    const deviceA = await newDeviceId();
    const deviceB = await newDeviceId();
    const shift = await openShift(cashier, deviceA);
    const countId = await countFloat(cashier, shift.id);
    const approvalRequestId = await approveOnDevice(cashier, countId, deviceA);
    const body = { countId, approvedBy: supervisor.userId, approvalRequestId };

    for (const device of [deviceB, null]) {
      const refused = await from(
        cashier.client.post(`${SHIFTS()}/${shift.id}/close`),
        device,
      ).send({ idempotencyKey: randomUUID(), ...body });
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(await shiftStatus(shift.id)).toBe("open");
    }

    const closed = await from(
      cashier.client.post(`${SHIFTS()}/${shift.id}/close`),
      deviceA,
    ).send({ idempotencyKey: randomUUID(), ...body });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await shiftStatus(shift.id)).toBe("closed");
  });

  it("legend-fjwxo force close: an approval made on device A is refused from device B and from no device, and closes from device A", async () => {
    const cashier = await member(roleIds.cashier, "Kasir Bind Paksa");
    const caller = await member(roleIds.supervisor, "Supervisor Bind Paksa");
    const deviceA = await newDeviceId();
    const deviceB = await newDeviceId();
    const shift = await openShift(cashier, await newDeviceId());
    const countId = await countFloat(caller, shift.id);
    const approvalRequestId = await approveOnDevice(caller, countId, deviceA);
    const body = {
      countId,
      note: "Kasir gagal menghitung kas tiga kali",
      approvedBy: supervisor.userId,
      approvalRequestId,
    };

    for (const device of [deviceB, null]) {
      const refused = await from(
        caller.client.post(`${SHIFTS()}/${shift.id}/force-close`),
        device,
      ).send({ idempotencyKey: randomUUID(), ...body });
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(await shiftStatus(shift.id)).toBe("open");
    }

    const closed = await from(
      caller.client.post(`${SHIFTS()}/${shift.id}/force-close`),
      deviceA,
    ).send({ idempotencyKey: randomUUID(), ...body });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await shiftStatus(shift.id)).toBe("closed");
  });

  it("legend-fjwxo close: an approval made with no device still closes from any device", async () => {
    const cashier = await member(roleIds.cashier, "Kasir Bind Bebas");
    const deviceA = await newDeviceId();
    const shift = await openShift(cashier, deviceA);
    const countId = await countFloat(cashier, shift.id);
    const approvalRequestId = await approveOnDevice(cashier, countId, null);
    const closed = await from(
      cashier.client.post(`${SHIFTS()}/${shift.id}/close`),
      deviceA,
    ).send({
      idempotencyKey: randomUUID(),
      countId,
      approvedBy: supervisor.userId,
      approvalRequestId,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  });
});
