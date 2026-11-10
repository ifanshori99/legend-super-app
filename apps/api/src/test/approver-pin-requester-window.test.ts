// Approver PIN windows (bead legend-vfj7z, round 3; PRD v1.7 §3 F6 "Override
// Supervisor", AUTH-06; per-user AND per-device since legend-fjwxo).
// attemptApproverPin uses windows of 10 failures per 5 minutes, taken before
// the approver's PIN is checked: the requester's (user_pin_throttle) always,
// so a client that drops X-Device-Token or rotates devices still hits a
// per-account limit, plus the device's (device_pin_throttle) when the request
// has a verified device id. A
// wrong guess and the guess that newly locks the PIN keep the slot (and raise
// staff_pin.requester_throttled / device_throttled once per window); a correct
// PIN, an already locked PIN, not_member, reset_required and an error thrown
// during the check give it back. Over the limit: 429 PIN_DEVICE_THROTTLED
// before the approver's counter moves. Service level; same style as
// staff-override-device-slot.test.ts. Runs the real services on the
// disposable PostgreSQL (RLS on). Only attemptStaffPin is spied on so a test
// can force one outcome or one thrown error.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { establishTenantContext } from "@starter/shared/core/server";
import type { TenantContext } from "@starter/shared/core";
import { setAuditWriter, type AuditEntry } from "../services/audit-writer.ts";
import * as devicePin from "../services/device-pin.service.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import { attemptApproverPin } from "../services/staff-pin-proof.service.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const audits: AuditEntry[] = [];
const createdUserIds: string[] = [];
const createdDeviceIds: string[] = [];

const PIN = "582914";
const WRONG = "907153";
const tenant: TenantContext = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function createUser(templateKey: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
    [id, `Staf ${templateKey}`, `${id}@example.test`],
  );
  createdUserIds.push(id);
  // Backdated: the container clock may drift from the Node clock.
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenantId, id, await roleIdOf(templateKey), bandung],
  );
  return id;
}

/** A supervisor who set their own PIN at the outlet. */
async function newApprover(): Promise<string> {
  const id = await createUser("supervisor");
  await setStaffPin(
    tenant,
    id,
    { outletId: bandung, userId: id },
    { pin: PIN },
  );
  return id;
}

/** Runs `sql` as the tenant with every outlet visible (RLS on). */
async function asTenant(sql: string, params: unknown[]): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

/** A registered device of the outlet (the throttle row references it). */
async function newDevice(): Promise<string> {
  const id = randomUUID();
  await asTenant(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', 'Kasir window peminta', now())`,
    [id, tenantId, bandung],
  );
  createdDeviceIds.push(id);
  return id;
}

async function pinRow(userId: string) {
  const { rows } = await owner.query<{ failed_attempts: number }>(
    "SELECT failed_attempts FROM staff_pins WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3",
    [tenantId, bandung, userId],
  );
  return rows[0];
}

async function requesterFailures(userId: string): Promise<number> {
  const { rows } = await owner.query<{ failures: number }>(
    "SELECT failures FROM user_pin_throttle WHERE tenant_id = $1 AND user_id = $2",
    [tenantId, userId],
  );
  return rows[0]?.failures ?? 0;
}

async function requesterRowCount(userId: string): Promise<number> {
  const { rowCount } = await owner.query(
    "SELECT 1 FROM user_pin_throttle WHERE tenant_id = $1 AND user_id = $2",
    [tenantId, userId],
  );
  return rowCount ?? 0;
}

async function deviceFailures(deviceId: string): Promise<number> {
  const { rows } = await owner.query<{ failures: number }>(
    "SELECT failures FROM device_pin_throttle WHERE tenant_id = $1 AND device_id = $2",
    [tenantId, deviceId],
  );
  return rows[0]?.failures ?? 0;
}

async function deviceThrottleRowCount(): Promise<number> {
  const { rowCount } = await owner.query(
    "SELECT 1 FROM device_pin_throttle WHERE tenant_id = $1 AND device_id = ANY($2::uuid[])",
    [tenantId, createdDeviceIds],
  );
  return rowCount ?? 0;
}

const requesterAudits = (userId: string) =>
  audits.filter(
    (row) =>
      row.action === "staff_pin.requester_throttled" && row.objectId === userId,
  ).length;

const deviceAudits = (deviceId: string) =>
  audits.filter(
    (row) =>
      row.action === "staff_pin.device_throttled" && row.objectId === deviceId,
  ).length;

type Failure = {
  code?: string;
  status?: number;
  retryAfterSeconds?: number;
};

/** One approver PIN attempt; resolves to the error or null. */
async function attempt(
  requester: string,
  approver: string,
  pin: string,
  deviceId: string | null,
): Promise<Failure | null> {
  try {
    await attemptApproverPin(tenant, {
      outletId: bandung,
      approverUserId: approver,
      requesterUserId: requester,
      pin,
      deviceId,
      now: new Date(),
    });
    return null;
  } catch (error) {
    return error as Failure;
  }
}

/** Approvers whose next wrong guess is the 5th: it locks the PIN. */
async function lockableApprovers(count: number): Promise<string[]> {
  const approvers: string[] = [];
  for (let i = 0; i < count; i += 1) approvers.push(await newApprover());
  await owner.query(
    `UPDATE staff_pins SET failed_attempts = 4
      WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = ANY($3::text[])`,
    [tenantId, bandung, approvers],
  );
  return approvers;
}

beforeAll(() => {
  setAuditWriter({
    record: async (entry) => {
      audits.push(entry);
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  audits.length = 0;
});

afterAll(async () => {
  setAuditWriter(null);
  if (createdDeviceIds.length > 0)
    // The device throttle rows go with their device (ON DELETE CASCADE).
    await asTenant("DELETE FROM devices WHERE id = ANY($1::uuid[])", [
      createdDeviceIds,
    ]);
  await owner.query(
    `DELETE FROM user_pin_throttle WHERE tenant_id = $1 AND user_id = ANY($2::text[])`,
    [tenantId, createdUserIds],
  );
  await owner.query(
    `DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = ANY($2::text[])`,
    [tenantId, createdUserIds],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, createdUserIds],
  );
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    createdUserIds,
  ]);
  await owner.end();
});

describe("legend-vfj7z attemptApproverPin under the requester window (no device id)", () => {
  it("10 locking guesses by one requester use the 10 slots: the 11th is 429 before the approver counter moves, one requester audit, other requesters unaffected", async () => {
    const cashier = await createUser("cashier");
    const otherCashier = await createUser("cashier");
    const approvers = await lockableApprovers(11);
    for (const approver of approvers.slice(0, 10)) {
      const error = await attempt(cashier, approver, WRONG, null);
      expect(error, "locking guess").toMatchObject({
        code: "PIN_LOCKED",
        status: 423,
      });
    }
    expect(await requesterFailures(cashier)).toBe(10);
    const blocked = await attempt(cashier, approvers[10]!, WRONG, null);
    expect(blocked, "11th call").toMatchObject({
      code: "PIN_DEVICE_THROTTLED",
      status: 429,
    });
    expect(blocked?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(blocked?.retryAfterSeconds).toBeLessThanOrEqual(300);
    expect((await pinRow(approvers[10]!))?.failed_attempts).toBe(4);
    // The refused call gave its own reservation back.
    expect(await requesterFailures(cashier)).toBe(10);
    expect(requesterAudits(cashier)).toBe(1);
    // Another requester has its own window, even on the same approver.
    expect(await attempt(otherCashier, approvers[10]!, PIN, null)).toBeNull();
    expect(await requesterFailures(otherCashier)).toBe(0);
    expect(requesterAudits(otherCashier)).toBe(0);
    // No device id, no device throttle row, no device audit.
    expect(await deviceThrottleRowCount()).toBe(0);
  });

  it("an already locked approver tried 15 times by one requester is always PIN_LOCKED, never 429", async () => {
    const cashier = await createUser("cashier");
    const approver = await newApprover();
    await owner.query(
      `UPDATE staff_pins SET failed_attempts = 5, locked_until = now() + interval '30 minutes'
        WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3`,
      [tenantId, bandung, approver],
    );
    for (let i = 0; i < 15; i += 1) {
      const error = await attempt(cashier, approver, WRONG, null);
      expect(error, `try ${i + 1}`).toMatchObject({
        code: "PIN_LOCKED",
        status: 423,
      });
    }
    expect(await requesterFailures(cashier)).toBe(0);
    expect(requesterAudits(cashier)).toBe(0);
  });

  it("a correct PIN gives its slot back", async () => {
    const cashier = await createUser("cashier");
    const approver = await newApprover();
    const other = await newApprover();
    expect(await attempt(cashier, other, WRONG, null)).toMatchObject({
      code: "PIN_INVALID",
      status: 401,
    });
    const before = await requesterFailures(cashier);
    expect(before).toBe(1);
    expect(await attempt(cashier, approver, PIN, null)).toBeNull();
    expect(await requesterFailures(cashier)).toBe(before);
    expect(requesterAudits(cashier)).toBe(0);
  });

  it("not_member and reset_required give their slot back", async () => {
    const cashier = await createUser("cashier");
    const approver = await newApprover();
    expect(await attempt(cashier, approver, WRONG, null)).toMatchObject({
      code: "PIN_INVALID",
    });
    const before = await requesterFailures(cashier);
    expect(before).toBe(1);
    const check = vi.spyOn(devicePin, "attemptStaffPin");
    check.mockImplementationOnce(async () => ({ kind: "not_member" }));
    expect(await attempt(cashier, approver, PIN, null)).toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(await requesterFailures(cashier)).toBe(before);
    check.mockImplementationOnce(async () => ({ kind: "reset_required" }));
    expect(await attempt(cashier, approver, PIN, null)).toMatchObject({
      code: "STAFF_PIN_RESET_REQUIRED",
    });
    expect(await requesterFailures(cashier)).toBe(before);
    expect(requesterAudits(cashier)).toBe(0);
  });

  it("an error thrown in the middle of the PIN check gives its slot back", async () => {
    const cashier = await createUser("cashier");
    const approver = await newApprover();
    expect(await attempt(cashier, approver, WRONG, null)).toMatchObject({
      code: "PIN_INVALID",
    });
    const before = await requesterFailures(cashier);
    expect(before).toBe(1);
    const boom = new Error("pin check exploded");
    vi.spyOn(devicePin, "attemptStaffPin").mockImplementationOnce(async () => {
      throw boom;
    });
    expect(await attempt(cashier, approver, PIN, null)).toBe(boom);
    expect(await requesterFailures(cashier)).toBe(before);
    expect(requesterAudits(cashier)).toBe(0);
  });
});

describe("legend-vfj7z attemptApproverPin with a device id: device window and requester window together", () => {
  it("a wrong guess raises the device and requester counters; a correct PIN gives both slots back", async () => {
    const cashier = await createUser("cashier");
    const device = await newDevice();
    const approver = await newApprover();
    expect(await attempt(cashier, approver, WRONG, device)).toMatchObject({
      code: "PIN_INVALID",
      status: 401,
    });
    expect(await deviceFailures(device)).toBe(1);
    // The requester window counts the same guess (legend-fjwxo).
    expect(await requesterFailures(cashier)).toBe(1);
    expect(await attempt(cashier, approver, PIN, device)).toBeNull();
    expect(await deviceFailures(device)).toBe(1);
    expect(await requesterFailures(cashier)).toBe(1);
    expect(await requesterRowCount(cashier)).toBe(1);
    expect(requesterAudits(cashier)).toBe(0);
    expect(deviceAudits(device)).toBe(0);
  });

  it("two devices, one requester: 10 locking guesses at device A make the 11th at A 429; device B is blocked too because the requester window is full, and gets nothing counted", async () => {
    const cashier = await createUser("cashier");
    const deviceA = await newDevice();
    const deviceB = await newDevice();
    const approvers = await lockableApprovers(12);
    for (const approver of approvers.slice(0, 10)) {
      expect(
        await attempt(cashier, approver, WRONG, deviceA),
        "locking guess at A",
      ).toMatchObject({ code: "PIN_LOCKED", status: 423 });
    }
    expect(await deviceFailures(deviceA)).toBe(10);
    const blocked = await attempt(cashier, approvers[10]!, WRONG, deviceA);
    expect(blocked, "11th call at A").toMatchObject({
      code: "PIN_DEVICE_THROTTLED",
      status: 429,
    });
    expect(blocked?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(blocked?.retryAfterSeconds).toBeLessThanOrEqual(300);
    expect((await pinRow(approvers[10]!))?.failed_attempts).toBe(4);
    expect(deviceAudits(deviceA)).toBe(1);
    // Device B has a free window of its own, but the requester window is
    // full: 429 before the approver counter moves, device B's slot given back.
    const atB = await attempt(cashier, approvers[11]!, WRONG, deviceB);
    expect(atB, "first call at B").toMatchObject({
      code: "PIN_DEVICE_THROTTLED",
      status: 429,
    });
    expect((await pinRow(approvers[11]!))?.failed_attempts).toBe(4);
    expect(await deviceFailures(deviceB)).toBe(0);
    expect(await deviceFailures(deviceA)).toBe(10);
    expect(await requesterFailures(cashier)).toBe(10);
    expect(requesterAudits(cashier)).toBe(1);
  });
});
