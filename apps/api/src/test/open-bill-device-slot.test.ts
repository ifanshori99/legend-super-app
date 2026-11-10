// Per-device PIN window on the open-bill convert path (bead legend-vfj7z).
//
// `convertSessionToOpenBill` checks the approver's PIN through
// `attemptApproverPin`: with a device id, one of the device's 10 window
// slots (5 minutes, table device_pin_throttle) is taken before the PIN is
// checked. A wrong guess and the guess that newly locks the staff PIN keep the
// slot (and can raise one `staff_pin.device_throttled` audit per window); a
// correct PIN and an already locked PIN give it back. Past the limit the answer
// is 429 PIN_DEVICE_THROTTLED before the staff counter moves. Without a device
// id there is no throttle row. Style: edge-pin-proof.test.ts "(f)"; harness:
// open-bill-convert.test.ts. The service is called directly because the route
// only passes a device id for a device-sourced tenant context.
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
let manager: Staff; // owner: builds the zone, table and QR code; the requester
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

/** Real staff PIN row (HMAC pepper + scrypt bound to tenant/outlet/user). */
async function seedPin(userId: string, pin = PIN) {
  const hashed = await hashStaffPin({
    pepper: staffPinPepper(seededTenantId, outletId),
    binding: { tenantId: seededTenantId, outletId, userId },
    pin,
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

/** A supervisor of the outlet (may approve open bill) with a PIN. */
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

/** A pay-first session scanned on the seeded tenant host. */
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

/** Runs the convert and returns what it threw (null when it converted). */
async function convert(
  sessionId: string,
  approver: Staff,
  pin: string,
  deviceId: string | null,
): Promise<{ status: number; code: string } | null> {
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
    const { status, code } = error as { status: number; code: string };
    return { status, code };
  }
}

async function failedAttempts(userId: string) {
  const { rows } = await owner.query<{ failed_attempts: number }>(
    "SELECT failed_attempts FROM staff_pins WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3",
    [seededTenantId, outletId, userId],
  );
  return rows[0]!.failed_attempts;
}

async function setFailedAttempts(userIds: string[], value: number) {
  await owner.query(
    `UPDATE staff_pins SET failed_attempts = $4
      WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = ANY($3::text[])`,
    [seededTenantId, outletId, userIds, value],
  );
}

async function deviceFailures(deviceId: string) {
  const { rows } = await owner.query<{ failures: number }>(
    "SELECT failures FROM device_pin_throttle WHERE tenant_id = $1 AND device_id = $2",
    [seededTenantId, deviceId],
  );
  return rows[0]?.failures;
}

async function throttleRowCount() {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM device_pin_throttle WHERE tenant_id = $1",
    [seededTenantId],
  );
  return rows[0]!.n;
}

async function throttleAudits(deviceId: string) {
  const { rows } = await owner.query(
    `SELECT 1 FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = 'staff_pin.device_throttled'
        AND event::text LIKE '%' || $2 || '%'`,
    [seededTenantId, deviceId],
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
    label: "OB Slot Owner",
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
  await owner.query(
    "DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = ANY($2)",
    [seededTenantId, pinUsers],
  );
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await owner.end();
});

describe("legend-vfj7z open-bill convert under the per-device PIN window", () => {
  // The requester's own window (user_pin_throttle) is shared by every test that
  // uses the same signed-in user: start each test with it empty.
  beforeEach(async () => {
    await owner.query("DELETE FROM user_pin_throttle WHERE tenant_id = $1", [
      seededTenantId,
    ]);
  });
  it("10 locking guesses use the 10 slots; the 11th is 429 before the staff counter moves; one audit", async () => {
    const sessionId = await seat();
    const deviceId = await enrollAt("Layar open bill kunci");
    const crowd: Staff[] = [];
    for (let i = 0; i < 11; i += 1)
      crowd.push(await newApprover(`OB Slot Kunci ${i + 1}`));
    // Each approver sits at 4 wrong PINs: the next wrong guess is the 5th and
    // locks the PIN.
    await setFailedAttempts(
      crowd.map((s) => s.userId),
      4,
    );
    for (const approver of crowd.slice(0, 10)) {
      const answer = await convert(sessionId, approver, WRONG_PIN, deviceId);
      expect(answer).toEqual({ status: 423, code: "PIN_LOCKED" });
    }
    const blocked = await convert(sessionId, crowd[10]!, WRONG_PIN, deviceId);
    expect(blocked).toEqual({ status: 429, code: "PIN_DEVICE_THROTTLED" });
    expect(await failedAttempts(crowd[10]!.userId)).toBe(4);
    expect(await throttleAudits(deviceId)).toBe(1);

    // A PIN that was already locked never looks at the guess: it gives the
    // slot back, so on a calm device many tries stay PIN_LOCKED, never 429.
    // (The requester's own window is full after the 11 calls above: empty it so
    // this part measures the device window only.)
    await owner.query("DELETE FROM user_pin_throttle WHERE tenant_id = $1", [
      seededTenantId,
    ]);
    const calm = await enrollAt("Layar open bill sudah terkunci");
    for (let i = 0; i < 15; i += 1) {
      const answer = await convert(sessionId, crowd[0]!, WRONG_PIN, calm);
      expect(answer).toEqual({ status: 423, code: "PIN_LOCKED" });
    }
    expect(await deviceFailures(calm)).toBe(0);
  }, 120_000);

  it("a correct PIN gives its slot back", async () => {
    const sessionId = await seat();
    const deviceId = await enrollAt("Layar open bill benar");
    const wrongOne = await newApprover("OB Slot Salah");
    const rightOne = await newApprover("OB Slot Benar");
    for (let i = 0; i < 2; i += 1)
      expect(await convert(sessionId, wrongOne, WRONG_PIN, deviceId)).toEqual({
        status: 401,
        code: "PIN_INVALID",
      });
    expect(await deviceFailures(deviceId)).toBe(2);

    expect(await convert(sessionId, rightOne, PIN, deviceId)).toBeNull();
    expect(await deviceFailures(deviceId)).toBe(2);
  }, 60_000);

  it("without a device id no throttle row is written", async () => {
    const sessionId = await seat();
    const approver = await newApprover("OB Slot Tanpa Perangkat");
    const before = await throttleRowCount();
    expect(await convert(sessionId, approver, WRONG_PIN, null)).toEqual({
      status: 401,
      code: "PIN_INVALID",
    });
    expect(await failedAttempts(approver.userId)).toBe(1);
    expect(await throttleRowCount()).toBe(before);
  }, 60_000);
});
