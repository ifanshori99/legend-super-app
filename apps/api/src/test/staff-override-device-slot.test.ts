// Per-device PIN window on the supervisor override path (bead legend-vfj7z;
// PRD v1.7 §3 F6 "Override Supervisor", AUTH-06). createPosOverride with a
// supervisor PIN and `options.deviceId` takes one of the device's 10 slots per
// 5 minutes (device_pin_throttle) before the approver's PIN is checked. A wrong
// guess and the guess that newly locks the PIN keep the slot (and can raise the
// staff_pin.device_throttled alert, once per window); a correct PIN, an already
// locked PIN and any other answer give it back. Over the limit: 429
// PIN_DEVICE_THROTTLED before the staff counter moves. No device id: the old
// behaviour, no throttle row. Same style as edge-pin-proof.test.ts (f) and
// device-pin-service.test.ts. Runs the real services on the disposable
// PostgreSQL (RLS on).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import {
  createPosOverrideSchema,
  type CreatePosOverrideInput,
} from "@starter/shared/access/override";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { establishTenantContext } from "@starter/shared/core/server";
import type { TenantContext } from "@starter/shared/core";
import { setAuditWriter, type AuditEntry } from "../services/audit-writer.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const audits: AuditEntry[] = [];
const createdUserIds: string[] = [];
const createdDeviceIds: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];

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

/** A registered device of the outlet (the throttle row references it). */
async function newDevice(): Promise<string> {
  const id = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', 'Kasir slot override', now())`,
      [id, tenantId, bandung],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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

async function throttleRow(deviceId: string) {
  const { rows } = await owner.query<{ failures: number }>(
    "SELECT failures FROM device_pin_throttle WHERE tenant_id = $1 AND device_id = $2",
    [tenantId, deviceId],
  );
  return rows[0];
}

/** Throttle rows of every device this file enrolled. */
async function throttleRowCount(): Promise<number> {
  const { rowCount } = await owner.query(
    "SELECT 1 FROM device_pin_throttle WHERE tenant_id = $1 AND device_id = ANY($2::uuid[])",
    [tenantId, createdDeviceIds],
  );
  return rowCount ?? 0;
}

const throttleAudits = (deviceId: string) =>
  audits.filter(
    (row) =>
      row.action === "staff_pin.device_throttled" && row.objectId === deviceId,
  ).length;

function overrideInput(
  approverUserId: string,
  pin: string,
): CreatePosOverrideInput {
  return createPosOverrideSchema.parse({
    outletId: bandung,
    action: "void",
    valueIdr: 45_000,
    reason: "Tamu membatalkan menu sebelum dimasak.",
    objectType: "order",
    objectId: randomUUID(),
    approval: { method: "supervisor_pin", approverUserId, pin },
  });
}

/** One supervisor-PIN override attempt; resolves to the error or null. */
async function attempt(
  requester: string,
  approver: string,
  pin: string,
  deviceId: string | null,
) {
  try {
    await createPosOverride(tenant, requester, overrideInput(approver, pin), {
      idempotencyKey: null,
      deviceId,
    });
    return null;
  } catch (error) {
    return error as { code?: string; status?: number };
  }
}

beforeAll(async () => {
  setAuditWriter({
    record: async (entry) => {
      audits.push(entry);
    },
  });
  savedPolicies = (
    await owner.query(
      `SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'void'`,
      [tenantId],
    )
  ).rows;
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'void'`,
    [tenantId],
  );
  // §3.7 matrix: a void goes to a supervisor, one level.
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'void', NULL, $2, 1)`,
    [tenantId, await roleIdOf("supervisor")],
  );
});

afterEach(() => {
  audits.length = 0;
});

afterAll(async () => {
  setAuditWriter(null);
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
    `DELETE FROM pos_overrides WHERE tenant_id = $1 AND requested_by = ANY($2::text[])`,
    [tenantId, createdUserIds],
  );
  await owner.query(
    `DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])`,
    [tenantId, createdUserIds],
  );
  await owner.query(
    `DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = ANY($2::text[])`,
    [tenantId, createdUserIds],
  );
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'void'`,
    [tenantId],
  );
  for (const row of savedPolicies)
    await owner.query(
      `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.tenant_id,
        row.action_type,
        row.threshold_idr,
        row.approver_role_id,
        row.levels,
        row.requires_distinct_actor,
      ],
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

describe("legend-vfj7z createPosOverride supervisor PIN under the device window", () => {
  it("legend-vfj7z 10 locking guesses use the 10 slots: the 11th is 429 before the staff counter moves, one throttle audit", async () => {
    const cashier = await createUser("cashier");
    const device = await newDevice();
    const approvers: string[] = [];
    for (let i = 0; i < 11; i += 1) approvers.push(await newApprover());
    // Each approver sits at 4 wrong PINs: the next wrong guess is the 5th and
    // locks the PIN (legend-sp9vq).
    await owner.query(
      `UPDATE staff_pins SET failed_attempts = 4
        WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = ANY($3::text[])`,
      [tenantId, bandung, approvers],
    );
    for (const approver of approvers.slice(0, 10)) {
      const error = await attempt(cashier, approver, WRONG, device);
      expect(error, "locking guess").toMatchObject({
        code: "PIN_LOCKED",
        status: 423,
      });
    }
    expect((await throttleRow(device))?.failures).toBe(10);
    const blocked = await attempt(cashier, approvers[10]!, WRONG, device);
    expect(blocked, "11th call").toMatchObject({
      code: "PIN_DEVICE_THROTTLED",
      status: 429,
    });
    expect((await pinRow(approvers[10]!))?.failed_attempts).toBe(4);
    // The refused call gave its own reservation back.
    expect((await throttleRow(device))?.failures).toBe(10);
    expect(throttleAudits(device)).toBe(1);
  });

  it("legend-vfj7z an already locked approver tried 15 times on one device is always PIN_LOCKED, never 429", async () => {
    const cashier = await createUser("cashier");
    const device = await newDevice();
    const approver = await newApprover();
    await owner.query(
      `UPDATE staff_pins SET failed_attempts = 5, locked_until = now() + interval '30 minutes'
        WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3`,
      [tenantId, bandung, approver],
    );
    for (let i = 0; i < 15; i += 1) {
      const error = await attempt(cashier, approver, WRONG, device);
      expect(error, `try ${i + 1}`).toMatchObject({
        code: "PIN_LOCKED",
        status: 423,
      });
    }
    expect((await throttleRow(device))?.failures ?? 0).toBe(0);
    expect(throttleAudits(device)).toBe(0);
  });

  it("legend-vfj7z a correct PIN gives its slot back", async () => {
    const cashier = await createUser("cashier");
    const device = await newDevice();
    const approver = await newApprover();
    const other = await newApprover();
    const wrong = await attempt(cashier, other, WRONG, device);
    expect(wrong).toMatchObject({ code: "PIN_INVALID", status: 401 });
    const before = (await throttleRow(device))?.failures;
    expect(before).toBe(1);
    expect(await attempt(cashier, approver, PIN, device)).toBeNull();
    expect((await throttleRow(device))?.failures).toBe(before);
    expect(throttleAudits(device)).toBe(0);
  });

  it("legend-vfj7z a null device id keeps the old behaviour: no throttle row", async () => {
    const cashier = await createUser("cashier");
    const device = await newDevice();
    const approver = await newApprover();
    const rowsBefore = await throttleRowCount();
    const wrong = await attempt(cashier, approver, WRONG, null);
    expect(wrong).toMatchObject({ code: "PIN_INVALID", status: 401 });
    expect((await pinRow(approver))?.failed_attempts).toBe(1);
    expect(await attempt(cashier, approver, PIN, null)).toBeNull();
    // Omitting the option is the same as null.
    const omitted = await createPosOverride(
      tenant,
      cashier,
      overrideInput(approver, PIN),
      { idempotencyKey: null },
    );
    expect(omitted.override.status).toBe("approved");
    expect(await throttleRow(device)).toBeUndefined();
    expect(await throttleRowCount()).toBe(rowsBefore);
    expect(throttleAudits(device)).toBe(0);
  });
});
