// POST /api/pos-overrides under the per-device PIN window (bead legend-vfj7z;
// PRD v1.7 §3 F6 "Override Supervisor", AUTH-06). The route passes the signed
// device id (X-Device-Token of the resolved tenant) to createPosOverride; a
// supervisor PIN guess takes one of the device's 10 slots per 5 minutes. Over
// the limit: 429 PIN_DEVICE_THROTTLED with Retry-After (1..300 s) before the
// staff counter moves. A request without a device token (a signed-in staff
// browser) has no device to count: no throttle row. The service rules are in
// staff-override-device-slot.test.ts; this file covers the HTTP layer only.
// Real Express app + Better Auth + PostgreSQL (disposable server from
// `pnpm test`). Requester = a cashier session; the device token makes the
// tenant resolve from the device, the session cookie authenticates the
// requester.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  DEVICE_TOKEN_HEADER,
  cafeLegendPlatformFixtures,
} from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import { enrollDevice } from "../services/device.service.ts";
import { originHeader } from "./helpers.ts";
import {
  seededHostname,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdUserIds: string[] = [];
const createdDeviceIds: string[] = [];

const WRONG = "907153";
const PIN = "582914";
const tenantContext = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const outletScope = establishScopedTenantContext(tenantContext, {
  kind: "outlets",
  outletIds: [outletIdSchema.parse(bandung)],
});

let app: Express;
let cashier: Staff;

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

/** A supervisor of the outlet who set their own PIN. */
async function newApprover(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Staf supervisor', $2)`,
    [id, `${id}@example.test`],
  );
  createdUserIds.push(id);
  // Backdated: the container clock may drift from the Node clock.
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenantId, id, await roleIdOf("supervisor"), bandung],
  );
  await setStaffPin(
    tenantContext,
    id,
    { outletId: bandung, userId: id },
    { pin: PIN },
  );
  return id;
}

/** A registered device of the outlet: its signed token and id. */
async function newDevice() {
  const enrolled = await enrollDevice(outletScope, randomUUID(), {
    outletId: bandung,
    type: "pos",
    label: `Kasir rute override ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  createdDeviceIds.push(enrolled.device.id);
  return { token: enrolled.token, id: enrolled.device.id };
}

async function pinRow(userId: string) {
  const { rows } = await owner.query<{ failed_attempts: number }>(
    "SELECT failed_attempts FROM staff_pins WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3",
    [tenantId, bandung, userId],
  );
  return rows[0];
}

async function throttleFailures(deviceId: string): Promise<number> {
  const { rows } = await owner.query<{ failures: number }>(
    "SELECT failures FROM device_pin_throttle WHERE tenant_id = $1 AND device_id = $2",
    [tenantId, deviceId],
  );
  return rows[0]?.failures ?? 0;
}

async function throttleRowCount(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM device_pin_throttle WHERE tenant_id = $1",
    [tenantId],
  );
  return rows[0]!.n;
}

/** One supervisor-PIN override request, with or without a device token. */
function requestOverride(
  approverUserId: string,
  pin: string,
  deviceToken: string | null,
) {
  const request = cashier.client
    .post("/api/pos-overrides")
    .set(originHeader)
    .send({
      outletId: bandung,
      action: "void",
      valueIdr: 45_000,
      reason: "Tamu membatalkan menu sebelum dimasak.",
      objectType: "order",
      objectId: randomUUID(),
      approval: { method: "supervisor_pin", approverUserId, pin },
    });
  // Without the token the tenant comes from the registered domain.
  return deviceToken === null
    ? request.set("Host", seededHostname)
    : request.set(DEVICE_TOKEN_HEADER, deviceToken);
}

beforeAll(async () => {
  app = createApp();
  cashier = await staffWithRole(app, {
    template: "cashier",
    scopeType: "outlet",
    scopeId: bandung,
    label: "Kasir rute override",
  });
  createdUserIds.push(cashier.userId);
});

afterAll(async () => {
  if (createdDeviceIds.length > 0) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      // The throttle rows go with their device (ON DELETE CASCADE).
      await client.query("DELETE FROM devices WHERE id = ANY($1::uuid[])", [
        createdDeviceIds,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  await owner.query(
    `DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = ANY($2::text[])`,
    [tenantId, createdUserIds],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, createdUserIds],
  );
  await owner.end();
});

describe("legend-vfj7z POST /api/pos-overrides under the device PIN window", () => {
  it("legend-vfj7z after 10 locking guesses the 11th request is 429 PIN_DEVICE_THROTTLED with Retry-After 1..300, staff counter untouched", async () => {
    const device = await newDevice();
    const approvers: string[] = [];
    for (let i = 0; i < 11; i += 1) approvers.push(await newApprover());
    // Each approver sits at 4 wrong PINs: the next wrong guess is the 5th and
    // locks the PIN, which still holds the device slot (legend-sp9vq).
    await owner.query(
      `UPDATE staff_pins SET failed_attempts = 4
        WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = ANY($3::text[])`,
      [tenantId, bandung, approvers],
    );
    for (const approver of approvers.slice(0, 10)) {
      const response = await requestOverride(approver, WRONG, device.token);
      expect(response.status, JSON.stringify(response.body)).toBe(423);
      expect(response.body.error.code).toBe("PIN_LOCKED");
    }
    expect(await throttleFailures(device.id)).toBe(10);

    const blocked = await requestOverride(approvers[10]!, WRONG, device.token);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(429);
    expect(blocked.body.error.code).toBe("PIN_DEVICE_THROTTLED");
    const retryAfter = Number(blocked.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(300);
    expect((await pinRow(approvers[10]!))?.failed_attempts).toBe(4);
    // The refused request gave its own reservation back.
    expect(await throttleFailures(device.id)).toBe(10);
  });

  it("legend-vfj7z a request without a device token adds no throttle row", async () => {
    const device = await newDevice();
    const approver = await newApprover();
    const rowsBefore = await throttleRowCount();
    const response = await requestOverride(approver, WRONG, null);
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(response.body.error.code).toBe("PIN_INVALID");
    expect((await pinRow(approver))?.failed_attempts).toBe(1);
    expect(response.headers["retry-after"]).toBeUndefined();
    expect(await throttleFailures(device.id)).toBe(0);
    expect(await throttleRowCount()).toBe(rowsBefore);
  });
});
