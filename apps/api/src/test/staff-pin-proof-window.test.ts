// Approver PIN windows apply per user AND per device at the same time
// (Codex finding 2 on area 418, bead legend-fjwxo). Before the fix a verified
// device id switched the requester window (user_pin_throttle) off, so one
// signed-in requester could rotate across devices and keep guessing approver
// PINs without ever hitting a per-account limit. Expected behaviour (this
// test's assumption, from the finding): with a verified device id every PIN
// attempt takes one slot in BOTH windows (10 failures per 5 minutes each);
// either window being full answers 429 PIN_DEVICE_THROTTLED before the
// approver's counter moves; a correct PIN gives both slots back. Covers the
// shared check (attemptApproverPin) and the open-bill convert path
// (convertSessionToOpenBill). Harness: open-bill-device-slot.test.ts.
//
// NOTE for the fixer: approver-pin-requester-window.test.ts asserts the old
// contract in two places ("user_pin_throttle is not touched" when a device id
// is present, requesterRowCount = 0 / requesterAudits = 0). Those assertions
// describe the bug and must be updated together with the service fix.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { outletIdSchema, userIdSchema } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { createDeviceOutletResolver } from "../services/device-outlet-resolver.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { enrollDevice } from "../services/device.service.ts";
import { hashStaffPin } from "../services/device-pin-hash.ts";
import {
  currentStaffPinPepperVersion,
  staffPinPepper,
} from "../services/device-pin-pepper.ts";
import { convertSessionToOpenBill } from "../services/open-bill-control.service.ts";
import { attemptApproverPin } from "../services/staff-pin-proof.service.ts";
import {
  createTable,
  createZone,
  dropFloorRows,
  issueQr,
  owner,
  scan,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers.ts";

const PIN = "482913";
const WRONG_PIN = "135790";
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

let app: Express;
let outletId: string;
let manager: Staff; // the requester (owner: also builds zone, table, QR)
const zoneIds: string[] = [];
const tableIds: string[] = [];
const pinUsers: string[] = [];
const devices: string[] = [];
const actor = randomUUID();

const tenantContext = establishTenantContext({
  tenantId: seededTenantId,
  brandId: null,
  source: "session",
});
const tenantScope = establishScopedTenantContext(tenantContext, {
  kind: "tenant",
});

async function seedPin(userId: string) {
  const hashed = await hashStaffPin({
    pepper: staffPinPepper(seededTenantId, outletId),
    binding: { tenantId: seededTenantId, outletId, userId },
    pin: PIN,
  });
  const setAt = new Date(Date.now() - 60_000);
  await owner.query(
    `INSERT INTO staff_pins (id, tenant_id, outlet_id, user_id, pin_hash, pin_salt, kdf_n, kdf_r, kdf_p,
        pepper_version, failed_attempts, locked_until, set_by, created_at, updated_at, pin_set_at, pin_generation_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, NULL, $4, $11, $11, $11, $11)`,
    [
      randomUUID(),
      seededTenantId,
      outletId,
      userId,
      hashed.pinHash,
      hashed.salt,
      hashed.params.N,
      hashed.params.r,
      hashed.params.p,
      currentStaffPinPepperVersion(),
      setAt,
    ],
  );
  pinUsers.push(userId);
}

async function newApprover(label: string) {
  const staff = await staffWithRole(app, {
    template: "supervisor",
    scopeType: "outlet",
    scopeId: outletId,
    label,
  });
  await seedPin(staff.userId);
  return staff;
}

/** Approvers whose next wrong guess is the 5th: it locks the PIN. */
async function lockableApprovers(count: number, tag: string) {
  const approvers: Staff[] = [];
  for (let i = 0; i < count; i += 1)
    approvers.push(await newApprover(`${tag} ${i + 1}`));
  await owner.query(
    `UPDATE staff_pins SET failed_attempts = 4
      WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = ANY($3::text[])`,
    [seededTenantId, outletId, approvers.map((s) => s.userId)],
  );
  return approvers;
}

async function enrollAt(label: string) {
  const enrolled = await enrollDevice(
    establishScopedTenantContext(tenantContext, {
      kind: "outlets",
      outletIds: [outletIdSchema.parse(outletId)],
    }),
    actor,
    {
      outletId,
      type: "pos",
      label: `${label} ${randomUUID().slice(0, 6)}`,
      stationId: null,
      idempotencyKey: randomUUID(),
    },
  );
  devices.push(enrolled.device.id);
  return enrolled.device.id;
}

async function seat(): Promise<string> {
  const zone = await createZone(manager.client, {
    paymentMode: "pay_first",
    hours: ALL_DAY,
  });
  zoneIds.push(zone.id);
  const table = await createTable(manager.client, { zoneId: zone.id });
  tableIds.push(table.id);
  const qr = await issueQr(manager.client, table.id);
  const scanned = await scan(app, { token: qr.token });
  expect(scanned.status).toBe(201);
  return scanned.body.data.session.id as string;
}

type Answer = { status: number; code: string } | null;

function describeError(error: unknown): Answer {
  const { status, code } = error as { status: number; code: string };
  return { status, code };
}

/** One approver PIN attempt through the shared check. */
async function attempt(
  approver: Staff,
  pin: string,
  deviceId: string | null,
): Promise<Answer> {
  try {
    await attemptApproverPin(tenantContext, {
      outletId,
      approverUserId: approver.userId,
      requesterUserId: manager.userId,
      pin,
      deviceId,
      now: new Date(),
    });
    return null;
  } catch (error) {
    return describeError(error);
  }
}

/** One approver PIN attempt through the open-bill convert path. */
async function convert(
  sessionId: string,
  approver: Staff,
  pin: string,
  deviceId: string | null,
): Promise<Answer> {
  try {
    await convertSessionToOpenBill(
      tenantScope,
      sessionId,
      {
        reason: "Tamu minta bayar di akhir",
        approverUserId: userIdSchema.parse(approver.userId),
        pin,
      },
      manager.userId,
      { deviceId },
    );
    return null;
  } catch (error) {
    return describeError(error);
  }
}

async function requesterFailures(): Promise<number> {
  const { rows } = await owner.query<{ failures: number }>(
    "SELECT failures FROM user_pin_throttle WHERE tenant_id = $1 AND user_id = $2",
    [seededTenantId, manager.userId],
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

async function failedAttempts(userId: string): Promise<number> {
  const { rows } = await owner.query<{ failed_attempts: number }>(
    "SELECT failed_attempts FROM staff_pins WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3",
    [seededTenantId, outletId, userId],
  );
  return rows[0]!.failed_attempts;
}

async function auditCount(action: string, objectId: string): Promise<number> {
  const { rows } = await owner.query(
    `SELECT 1 FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2
        AND event::text LIKE '%' || $3 || '%'`,
    [seededTenantId, action, objectId],
  );
  return rows.length;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setDeviceOutletResolver(createDeviceOutletResolver());
  app = createApp();
  manager = await staffWithRole(app, {
    template: "owner",
    label: "PIN Window Owner",
  });
  const probe = await createZone(manager.client, { hours: ALL_DAY });
  zoneIds.push(probe.id);
  outletId = (probe.outletId as string | undefined) ?? seededOutletA;
}, 90_000);

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.query(
    "DELETE FROM device_pin_throttle WHERE tenant_id = $1 AND device_id = ANY($2::uuid[])",
    [seededTenantId, devices],
  );
  await owner.query("DELETE FROM user_pin_throttle WHERE tenant_id = $1", [
    seededTenantId,
  ]);
  await owner.query(
    "DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = ANY($2)",
    [seededTenantId, pinUsers],
  );
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await owner.end();
});

// The requester window is shared by every test that uses the same signed-in
// user: start each test with it empty.
beforeEach(async () => {
  await owner.query("DELETE FROM user_pin_throttle WHERE tenant_id = $1", [
    seededTenantId,
  ]);
});

describe("legend-fjwxo per-user window with a verified device: attemptApproverPin", () => {
  it("a wrong guess at a device takes a slot in the requester window AND the device window", async () => {
    const device = await enrollAt("Layar jendela ganda salah");
    const approver = await newApprover("Jendela Ganda Salah");
    expect(await attempt(approver, WRONG_PIN, device)).toEqual({
      status: 401,
      code: "PIN_INVALID",
    });
    expect(await deviceFailures(device)).toBe(1);
    expect(await requesterFailures()).toBe(1);
  }, 60_000);

  it("a correct PIN gives back the slot in both windows", async () => {
    const device = await enrollAt("Layar jendela ganda benar");
    const wrongOne = await newApprover("Jendela Ganda Salah Dulu");
    const rightOne = await newApprover("Jendela Ganda Benar");
    expect(await attempt(wrongOne, WRONG_PIN, device)).toEqual({
      status: 401,
      code: "PIN_INVALID",
    });
    expect(await attempt(rightOne, PIN, device)).toBeNull();
    expect(await deviceFailures(device)).toBe(1);
    expect(await requesterFailures()).toBe(1);
  }, 60_000);

  it("one requester rotating over devices: 10 locking guesses spread over two devices make the 11th at a fresh device 429 before the approver counter moves, with one requester audit", async () => {
    const deviceA = await enrollAt("Layar putar A");
    const deviceB = await enrollAt("Layar putar B");
    const fresh = await enrollAt("Layar putar baru");
    const approvers = await lockableApprovers(11, "Putar Perangkat");
    for (const [i, approver] of approvers.slice(0, 10).entries()) {
      expect(
        await attempt(approver, WRONG_PIN, i < 5 ? deviceA : deviceB),
        `locking guess ${i + 1}`,
      ).toEqual({ status: 423, code: "PIN_LOCKED" });
    }
    expect(await requesterFailures()).toBe(10);
    expect(await deviceFailures(deviceA)).toBe(5);
    expect(await deviceFailures(deviceB)).toBe(5);
    // Neither device is over its own limit; the requester is.
    const blocked = await attempt(approvers[10]!, WRONG_PIN, fresh);
    expect(blocked, "11th guess at a fresh device").toEqual({
      status: 429,
      code: "PIN_DEVICE_THROTTLED",
    });
    expect(await failedAttempts(approvers[10]!.userId)).toBe(4);
    expect(
      await auditCount("staff_pin.requester_throttled", manager.userId),
    ).toBe(1);
  }, 180_000);
});

describe("legend-fjwxo per-user window with a verified device: open-bill convert", () => {
  it("a wrong guess at a device takes a slot in the requester window AND the device window", async () => {
    const sessionId = await seat();
    const device = await enrollAt("Layar open bill ganda");
    const approver = await newApprover("OB Ganda");
    expect(await convert(sessionId, approver, WRONG_PIN, device)).toEqual({
      status: 401,
      code: "PIN_INVALID",
    });
    expect(await deviceFailures(device)).toBe(1);
    expect(await requesterFailures()).toBe(1);
  }, 60_000);

  it("one requester rotating over devices: the 11th locking guess at a fresh device is 429 before the approver counter moves", async () => {
    const sessionId = await seat();
    const deviceA = await enrollAt("Layar open bill putar A");
    const deviceB = await enrollAt("Layar open bill putar B");
    const fresh = await enrollAt("Layar open bill putar baru");
    const approvers = await lockableApprovers(11, "OB Putar");
    for (const [i, approver] of approvers.slice(0, 10).entries()) {
      expect(
        await convert(
          sessionId,
          approver,
          WRONG_PIN,
          i < 5 ? deviceA : deviceB,
        ),
        `locking guess ${i + 1}`,
      ).toEqual({ status: 423, code: "PIN_LOCKED" });
    }
    expect(await requesterFailures()).toBe(10);
    const blocked = await convert(sessionId, approvers[10]!, WRONG_PIN, fresh);
    expect(blocked, "11th guess at a fresh device").toEqual({
      status: 429,
      code: "PIN_DEVICE_THROTTLED",
    });
    expect(await failedAttempts(approvers[10]!.userId)).toBe(4);
  }, 180_000);
});
