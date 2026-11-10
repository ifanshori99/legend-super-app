// Per-requester approver-PIN window over HTTP (bead legend-vfj7z, round 2;
// PRD v1.7 §3 F6 "Override Supervisor", F43 "Kontrol Open Bill", AUTH-06).
// One signed-in requester (a cashier session) guesses approver PINs. Every
// wrong guess, and every guess that newly locks the approver, holds one of the
// requester's 10 slots per 5 minutes, with or without a device token. The 11th
// request is 429 PIN_DEVICE_THROTTLED with Retry-After (1..300 s) before the
// approver's counter moves. Covers the HTTP layer of POST /api/pos-overrides
// and POST /api/table-sessions/:id/open-bill; the service rules are in
// staff-override-device-slot.test.ts and open-bill-device-slot.test.ts.
// Real Express app + Better Auth + PostgreSQL (disposable server from
// `pnpm test`).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import { enrollDevice } from "../services/device.service.ts";
import { originHeader } from "./helpers.ts";
import {
  createTable,
  createZone,
  dropFloorRows,
  issueQr,
  owner,
  scan,
  seededHostname,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers.ts";

const WRONG = "907153";
const PIN = "582914";
const SLOW = 90_000;
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];
const tenantContext = establishTenantContext({
  tenantId: seededTenantId,
  brandId: null,
  source: "session",
});

let app: Express;
let manager: Staff;
let outletId: string;
let approvers: string[];
let sessionId: string;
const createdUserIds: string[] = [];
const createdDeviceIds: string[] = [];
const zoneIds: string[] = [];
const tableIds: string[] = [];

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [seededTenantId, templateKey],
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
    [seededTenantId, id, await roleIdOf("supervisor"), outletId],
  );
  await setStaffPin(
    tenantContext,
    id,
    { outletId, userId: id },
    { pin: PIN },
  );
  return id;
}

/** Every approver sits at 4 wrong PINs and unlocked: the next guess locks. */
async function armApprovers() {
  await owner.query(
    `UPDATE staff_pins SET failed_attempts = 4, locked_until = NULL
      WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = ANY($3::text[])`,
    [seededTenantId, outletId, approvers],
  );
}

/** A fresh requester: its own session and its own (empty) requester window. */
async function newRequester(): Promise<Staff> {
  const cashier = await staffWithRole(app, {
    template: "cashier",
    scopeType: "outlet",
    scopeId: outletId,
    label: "Kasir jendela rute",
  });
  createdUserIds.push(cashier.userId);
  return cashier;
}

/** A registered device of the outlet: its signed token and id. */
async function newDevice() {
  const enrolled = await enrollDevice(
    establishScopedTenantContext(tenantContext, {
      kind: "outlets",
      outletIds: [outletIdSchema.parse(outletId)],
    }),
    randomUUID(),
    {
      outletId,
      type: "pos",
      label: `Kasir jendela rute ${randomUUID().slice(0, 6)}`,
      stationId: null,
      idempotencyKey: randomUUID(),
    },
  );
  createdDeviceIds.push(enrolled.device.id);
  return { token: enrolled.token, id: enrolled.device.id };
}

async function pinFailedAttempts(userId: string): Promise<number | undefined> {
  const { rows } = await owner.query<{ failed_attempts: number }>(
    "SELECT failed_attempts FROM staff_pins WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3",
    [seededTenantId, outletId, userId],
  );
  return rows[0]?.failed_attempts;
}

async function requesterFailures(userId: string): Promise<number> {
  const { rows } = await owner.query<{ failures: number }>(
    "SELECT failures FROM user_pin_throttle WHERE tenant_id = $1 AND user_id = $2",
    [seededTenantId, userId],
  );
  return rows[0]?.failures ?? 0;
}

async function deviceFailures(deviceId: string): Promise<number> {
  const { rows } = await owner.query<{ failures: number }>(
    "SELECT failures FROM device_pin_throttle WHERE tenant_id = $1 AND device_id = $2",
    [seededTenantId, deviceId],
  );
  return rows[0]?.failures ?? 0;
}

/** Without the token the tenant comes from the registered domain. */
function withTenantSource<T extends { set(name: string, value: string): T }>(
  request: T,
  deviceToken: string | null,
): T {
  return deviceToken === null
    ? request.set("Host", seededHostname)
    : request.set(DEVICE_TOKEN_HEADER, deviceToken);
}

function requestOverride(
  requester: Staff,
  approverUserId: string,
  deviceToken: string | null,
) {
  return withTenantSource(
    requester.client
      .post("/api/pos-overrides")
      .set(originHeader)
      .send({
        outletId,
        action: "void",
        valueIdr: 45_000,
        reason: "Tamu membatalkan menu sebelum dimasak.",
        objectType: "order",
        objectId: randomUUID(),
        approval: { method: "supervisor_pin", approverUserId, pin: WRONG },
      }),
    deviceToken,
  );
}

function requestOpenBill(
  requester: Staff,
  approverUserId: string,
  deviceToken: string | null,
) {
  return withTenantSource(
    requester.client
      .post(`/api/table-sessions/${sessionId}/open-bill`)
      .set(originHeader)
      .send({
        reason: "Tamu minta bayar di akhir",
        approverUserId,
        pin: WRONG,
      }),
    deviceToken,
  );
}

type Attempt = (
  requester: Staff,
  approverUserId: string,
  deviceToken: string | null,
) => PromiseLike<{
  status: number;
  body: { error: { code: string } };
  headers: Record<string, string>;
}>;

/** 10 locking guesses by one requester, then the 11th is throttled. */
async function expectRequesterWindow(
  attempt: Attempt,
  deviceToken: string | null,
) {
  const requester = await newRequester();
  await armApprovers();
  for (const approver of approvers.slice(0, 10)) {
    const response = await attempt(requester, approver, deviceToken);
    expect(response.status, JSON.stringify(response.body)).toBe(423);
    expect(response.body.error.code).toBe("PIN_LOCKED");
  }
  expect(await requesterFailures(requester.userId)).toBe(10);

  const blocked = await attempt(requester, approvers[10]!, deviceToken);
  expect(blocked.status, JSON.stringify(blocked.body)).toBe(429);
  expect(blocked.body.error.code).toBe("PIN_DEVICE_THROTTLED");
  const retryAfter = Number(blocked.headers["retry-after"]);
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThanOrEqual(1);
  expect(retryAfter).toBeLessThanOrEqual(300);
  // The approver's counter did not move, and the refused request gave its
  // own reservation back.
  expect(await pinFailedAttempts(approvers[10]!)).toBe(4);
  expect(await requesterFailures(requester.userId)).toBe(10);
  return requester;
}

beforeAll(async () => {
  app = createApp();
  manager = await staffWithRole(app, {
    template: "owner",
    label: "Pemilik jendela rute",
  });
  createdUserIds.push(manager.userId);
  const zone = await createZone(manager.client, {
    paymentMode: "pay_first",
    hours: ALL_DAY,
  });
  zoneIds.push(zone.id);
  outletId = zone.outletId as string;
  const table = await createTable(manager.client, { zoneId: zone.id });
  tableIds.push(table.id);
  const qr = await issueQr(manager.client, table.id);
  const scanned = await scan(app, { token: qr.token });
  expect(scanned.status).toBe(201);
  sessionId = scanned.body.data.session.id;
  approvers = [];
  for (let i = 0; i < 11; i += 1) approvers.push(await newApprover());
}, SLOW);

afterAll(async () => {
  if (createdDeviceIds.length > 0) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [seededTenantId],
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
    "DELETE FROM user_pin_throttle WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [seededTenantId, createdUserIds],
  );
  await owner.query(
    "DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [seededTenantId, createdUserIds],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [seededTenantId, createdUserIds],
  );
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await owner.end();
});

describe("legend-vfj7z approver PIN window per requester over HTTP", () => {
  it(
    "POST /api/pos-overrides without a device token: the 11th guess of one requester is 429 with Retry-After",
    async () => {
      await expectRequesterWindow(requestOverride, null);
    },
    SLOW,
  );

  it(
    "POST /api/table-sessions/:id/open-bill without a device token: the 11th guess of one requester is 429 with Retry-After",
    async () => {
      await expectRequesterWindow(requestOpenBill, null);
    },
    SLOW,
  );

  it(
    "POST /api/table-sessions/:id/open-bill with a registered device token: the 11th guess is 429 with Retry-After, device slots held too",
    async () => {
      const device = await newDevice();
      await expectRequesterWindow(requestOpenBill, device.token);
      expect(await deviceFailures(device.id)).toBe(10);
    },
    SLOW,
  );
});
