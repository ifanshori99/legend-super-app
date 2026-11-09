// Device pins + POS supervisor override (bead legend-dxb; PRD v1.7 §3 F6
// "Staf — PIN Perangkat" + "Override Supervisor", §6 B staff_pins, AUTH-06,
// TEN-01..03). Service tests run the real services on the disposable
// PostgreSQL (RLS on); HTTP tests run the real Express app and Better Auth.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import {
  createPosOverrideSchema,
  type CreatePosOverrideInput,
} from "@starter/shared/access/override";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { establishTenantContext } from "@starter/shared/core/server";
import { ulidToUuid, type TenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { signDeviceToken } from "../lib/device-token";
import { setAuditWriter, type AuditEntry } from "../services/audit-writer";
import {
  setDeviceOutletResolver,
  setStaffPin,
  verifyStaffPinOnDevice,
} from "../services/device-pin.service";
import {
  createPosOverride,
  getPosOverride,
} from "../services/staff-override.service";
import { decideApprovalRequest } from "../services/platform-approval.service";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const bandung2 = cafeLegendAccessFixtures.outletIds.bandung2;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const audits: AuditEntry[] = [];
const createdUserIds: string[] = [];
const ACTIONS = ["void", "refund"];
let savedPolicies: Record<string, unknown>[] = [];

const PIN = "582914";
const WRONG = "907153";
const tenant: TenantContext = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const deviceTenant: TenantContext = establishTenantContext({
  tenantId,
  brandId: null,
  source: "device",
});

/** WS-02 stand-in: device id → outlet. Unknown devices stay unregistered. */
const devices = new Map<string, string>();
const deviceAt = (outletId: string) => {
  const id = randomUUID();
  devices.set(id, outletId);
  return id;
};
/** Device ids enrolled in the real registry for the HTTP tests; removed in afterAll. */
const registeredDeviceIds: string[] = [];

/**
 * An enrolled device (F5 registry, legend-165) and a token issued for it. The
 * credential check needs a registry row: active, same tenant, with
 * `token_issued_at` at or before the token's `issuedAt`.
 */
async function enrolledDeviceToken(outletId: string) {
  const deviceId = deviceAt(outletId);
  const issuedAt = Math.floor(Date.now() / 1000);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', 'Kasir PIN', $4)`,
      [deviceId, tenantId, outletId, new Date(issuedAt * 1000)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  registeredDeviceIds.push(deviceId);
  return {
    deviceId,
    token: signDeviceToken({
      version: 1,
      tenantId,
      brandId: null,
      deviceId,
      issuedAt,
    }),
  };
}

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function assign(
  userId: string,
  templateKey: string,
  scope: { type: string; id?: string },
) {
  // Backdated: the container clock may drift from the Node clock.
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [
      tenantId,
      userId,
      await roleIdOf(templateKey),
      scope.type,
      scope.id ?? null,
    ],
  );
}

async function createUser(
  templateKey: string,
  scope: { type: string; id?: string },
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
    [id, `Staf ${templateKey}`, `${id}@example.test`],
  );
  createdUserIds.push(id);
  await assign(id, templateKey, scope);
  return id;
}

/** A staff member who set their own pin at the outlet (self-service). */
async function staffWithPin(
  templateKey: string,
  outletId: string = bandung,
  pin: string = PIN,
): Promise<string> {
  const id = await createUser(templateKey, { type: "outlet", id: outletId });
  await setStaffPin(tenant, id, { outletId, userId: id }, { pin });
  return id;
}

async function pinRow(userId: string, outletId: string = bandung) {
  const { rows } = await owner.query<Record<string, unknown>>(
    "SELECT * FROM staff_pins WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3",
    [tenantId, outletId, userId],
  );
  return rows[0];
}

async function setPolicy(
  actionType: string,
  thresholdIdr: number | null,
  templateKey: string,
  level: number,
) {
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, actionType, thresholdIdr, await roleIdOf(templateKey), level],
  );
}

async function overrideEvents(overrideId: string) {
  const { rows } = await owner.query<{
    name: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT event->>'name' AS name, event->'payload' AS payload
     FROM domain_event_outbox
     WHERE tenant_id = $1 AND aggregate_type = 'pos_override' AND aggregate_id = $2
     ORDER BY sequence`,
    [tenantId, ulidToUuid(overrideId)],
  );
  return rows;
}

/** Parsed through the route's strict schema, so tests send what the API accepts. */
function overrideInput(
  approval: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): CreatePosOverrideInput {
  return createPosOverrideSchema.parse({
    outletId: bandung,
    action: "void",
    valueIdr: 45_000,
    reason: "Tamu membatalkan menu sebelum dimasak.",
    objectType: "order",
    objectId: randomUUID(),
    approval,
    ...extra,
  });
}

beforeAll(async () => {
  setAuditWriter({
    record: async (entry) => {
      audits.push(entry);
    },
  });
  setDeviceOutletResolver(async ({ tenantId: id, deviceId }) =>
    id === tenantId ? (devices.get(deviceId) ?? null) : null,
  );
  savedPolicies = (
    await owner.query(
      `SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])`,
      [tenantId, ACTIONS],
    )
  ).rows;
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])`,
    [tenantId, ACTIONS],
  );
  // §3.7 matrix: a void goes to a supervisor; refunds only from Rp500.000.
  await setPolicy("void", null, "supervisor", 1);
  await setPolicy("refund", 500_000, "supervisor", 1);
});

afterEach(() => {
  audits.length = 0;
});

afterAll(async () => {
  setAuditWriter(null);
  setDeviceOutletResolver(null);
  if (registeredDeviceIds.length > 0) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      await client.query("DELETE FROM devices WHERE id = ANY($1::uuid[])", [
        registeredDeviceIds,
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
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])`,
    [tenantId, ACTIONS],
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
  await appPool.end();
});

// ------------------------------------------------------------- staff pins

describe("legend-dxb §3 F6 staff pin storage", () => {
  it("§3 F6 a pin is stored hashed only: no column holds the pin, and a reset changes salt and hash", async () => {
    const cashier = await staffWithPin("cashier");
    const first = await pinRow(cashier);
    expect(first).toBeDefined();
    expect(first?.pin_hash).toMatch(/^[0-9a-f]{64}$/);
    for (const value of Object.values(first ?? {}))
      expect(String(value)).not.toBe(PIN);
    expect(JSON.stringify(first)).not.toContain(`"${PIN}"`);
    expect(first).toMatchObject({ failed_attempts: 0, locked_until: null });
    await setStaffPin(
      tenant,
      cashier,
      { outletId: bandung, userId: cashier },
      { pin: PIN },
    );
    const second = await pinRow(cashier);
    expect(second?.id).toBe(first?.id);
    expect(second?.pin_salt).not.toBe(first?.pin_salt);
    expect(second?.pin_hash).not.toBe(first?.pin_hash);
    // Audit and outbox carry ids only, never the pin or its hash.
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(PIN);
    expect(serialized).not.toContain(String(second?.pin_hash));
    const { rows } = await owner.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
       WHERE tenant_id = $1 AND aggregate_type = 'staff_pin' AND aggregate_id = $2`,
      [tenantId, first?.id],
    );
    expect(rows.map((row) => (row.event as { name: string }).name)).toEqual([
      "staff_pin.set",
      "staff_pin.set",
    ]);
    expect(JSON.stringify(rows)).not.toContain(PIN);
  });

  it("legend-kyie only an edge node puts the hash material on staff_pin.set; pin_set_at moves on a set, not on an attempt", async () => {
    const cashier = await staffWithPin("cashier");
    const first = await pinRow(cashier);
    const payloads = async () =>
      (
        await owner.query<{ event: { payload: Record<string, unknown> } }>(
          `SELECT event FROM domain_event_outbox
           WHERE tenant_id = $1 AND aggregate_type = 'staff_pin' AND aggregate_id = $2
           ORDER BY sequence`,
          [tenantId, first?.id],
        )
      ).rows.map((row) => row.event.payload);
    // Cloud process: no material.
    expect((await payloads())[0]).not.toHaveProperty("material");

    // An attempt moves updated_at, never pin_set_at.
    await expect(
      verifyStaffPinOnDevice(deviceTenant, {
        deviceId: deviceAt(bandung),
        userId: cashier,
        pin: WRONG,
      }),
    ).rejects.toMatchObject({ code: "PIN_INVALID" });
    const attempted = await pinRow(cashier);
    expect(attempted?.failed_attempts).toBe(1);
    expect(attempted?.pin_set_at).toEqual(first?.pin_set_at);

    // Edge process: a reset carries the material and moves pin_set_at.
    const previous = process.env.EDGE_MODE;
    process.env.EDGE_MODE = "true";
    try {
      await setStaffPin(
        tenant,
        cashier,
        { outletId: bandung, userId: cashier },
        { pin: PIN },
      );
    } finally {
      if (previous === undefined) delete process.env.EDGE_MODE;
      else process.env.EDGE_MODE = previous;
    }
    const reset = await pinRow(cashier);
    expect((reset?.pin_set_at as Date).getTime()).toBeGreaterThan(
      (first?.pin_set_at as Date).getTime(),
    );
    const material = (await payloads())[1]?.material;
    expect(material).toEqual({
      algorithm: "scrypt-hmac-sha256-v1",
      salt: reset?.pin_salt,
      pinHash: reset?.pin_hash,
      params: {
        N: reset?.kdf_n,
        r: reset?.kdf_r,
        p: reset?.kdf_p,
        keyLength: 32,
      },
      pepperVersion: reset?.pepper_version,
      setAt: (reset?.pin_set_at as Date).toISOString(),
    });
    expect(JSON.stringify(material)).not.toContain(PIN);
  });

  it("§3 F6 a trivial pin is refused; another user's pin needs device.registry.manage on the outlet", async () => {
    const cashier = await createUser("cashier", {
      type: "outlet",
      id: bandung,
    });
    await expect(
      setStaffPin(
        tenant,
        cashier,
        { outletId: bandung, userId: cashier },
        { pin: "123456" },
      ),
    ).rejects.toMatchObject({ code: "WEAK_STAFF_PIN" });
    const supervisor = await createUser("supervisor", {
      type: "outlet",
      id: bandung,
    });
    await expect(
      setStaffPin(
        tenant,
        supervisor,
        { outletId: bandung, userId: cashier },
        { pin: PIN },
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    // Self-service only where the user works.
    await expect(
      setStaffPin(
        tenant,
        cashier,
        { outletId: bandung2, userId: cashier },
        { pin: PIN },
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    const admin = await createUser("tenant_admin", { type: "tenant" });
    await setStaffPin(
      tenant,
      admin,
      { outletId: bandung, userId: cashier },
      { pin: PIN },
    );
    expect(await pinRow(cashier)).toMatchObject({ set_by: admin });
    // The admin cannot give a pin at an outlet the staff does not work at.
    await expect(
      setStaffPin(
        tenant,
        admin,
        { outletId: bandung2, userId: cashier },
        { pin: PIN },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("legend-dxb §3 F6 staff pin verify (lock after 5)", () => {
  it("§3 F6 a correct pin on a registered device switches user", async () => {
    const cashier = await staffWithPin("cashier");
    const result = await verifyStaffPinOnDevice(deviceTenant, {
      deviceId: deviceAt(bandung),
      userId: cashier,
      pin: PIN,
    });
    expect(result).toMatchObject({
      outletId: bandung,
      user: { id: cashier, kind: "staff", status: "active" },
    });
  });

  it("§3 F6 five consecutive misses lock the pin, the lock refuses the right pin, and a success before the limit resets", async () => {
    const device = deviceAt(bandung);
    const cashier = await staffWithPin("cashier");
    for (let attempt = 1; attempt <= 4; attempt++)
      await expect(
        verifyStaffPinOnDevice(deviceTenant, {
          deviceId: device,
          userId: cashier,
          pin: WRONG,
        }),
      ).rejects.toMatchObject({ code: "PIN_INVALID" });
    expect(await pinRow(cashier)).toMatchObject({ failed_attempts: 4 });
    // A success resets the counter (§3 F6 "consecutive").
    await verifyStaffPinOnDevice(deviceTenant, {
      deviceId: device,
      userId: cashier,
      pin: PIN,
    });
    expect(await pinRow(cashier)).toMatchObject({
      failed_attempts: 0,
      locked_until: null,
    });
    for (let attempt = 1; attempt <= 5; attempt++)
      await expect(
        verifyStaffPinOnDevice(deviceTenant, {
          deviceId: device,
          userId: cashier,
          pin: WRONG,
        }),
      ).rejects.toMatchObject({
        code: attempt < 5 ? "PIN_INVALID" : "PIN_LOCKED",
      });
    const locked = await pinRow(cashier);
    expect(locked?.failed_attempts).toBe(5);
    expect(locked?.locked_until).not.toBeNull();
    await expect(
      verifyStaffPinOnDevice(deviceTenant, {
        deviceId: device,
        userId: cashier,
        pin: PIN,
      }),
    ).rejects.toMatchObject({ code: "PIN_LOCKED" });
    expect(audits.some((row) => row.action === "staff_pin.locked")).toBe(true);
    // Resetting the pin clears the lock (§3 F6: supervisor/self reset).
    await setStaffPin(
      tenant,
      cashier,
      { outletId: bandung, userId: cashier },
      { pin: PIN },
    );
    expect(await pinRow(cashier)).toMatchObject({
      failed_attempts: 0,
      locked_until: null,
    });
  });

  it("§3 F6 concurrent wrong guesses are each counted: never more than 5 tries before the lock", async () => {
    const device = deviceAt(bandung);
    const cashier = await staffWithPin("cashier");
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        verifyStaffPinOnDevice(deviceTenant, {
          deviceId: device,
          userId: cashier,
          pin: WRONG,
        }),
      ),
    );
    const codes = results.map((row) =>
      row.status === "rejected" ? (row.reason as { code: string }).code : "OK",
    );
    expect(codes.filter((code) => code === "PIN_INVALID")).toHaveLength(4);
    expect(codes.filter((code) => code === "PIN_LOCKED")).toHaveLength(4);
    const row = await pinRow(cashier);
    expect(row?.failed_attempts).toBe(5);
    expect(row?.locked_until).not.toBeNull();
  });

  it("§3 F6 unknown users, unregistered devices and another outlet's device are refused", async () => {
    const cashier = await staffWithPin("cashier");
    await expect(
      verifyStaffPinOnDevice(deviceTenant, {
        deviceId: deviceAt(bandung),
        userId: randomUUID(),
        pin: PIN,
      }),
    ).rejects.toMatchObject({ code: "PIN_INVALID" });
    // No WS-02 registration: fail closed.
    await expect(
      verifyStaffPinOnDevice(deviceTenant, {
        deviceId: randomUUID(),
        userId: cashier,
        pin: PIN,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // A device of another outlet never sees this outlet's pin (TEN-03).
    await expect(
      verifyStaffPinOnDevice(deviceTenant, {
        deviceId: deviceAt(bandung2),
        userId: cashier,
        pin: PIN,
      }),
    ).rejects.toMatchObject({ code: "PIN_INVALID" });
    expect(await pinRow(cashier)).toMatchObject({ failed_attempts: 0 });
    // A staff member whose role ended cannot switch in even with the right pin.
    await owner.query(
      `UPDATE role_assignments SET valid_until = now() - interval '1 minute'
       WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, cashier],
    );
    await expect(
      verifyStaffPinOnDevice(deviceTenant, {
        deviceId: deviceAt(bandung),
        userId: cashier,
        pin: PIN,
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("TEN-01 tenant B never reads, verifies or changes tenant A staff pins", async () => {
    const cashier = await staffWithPin("cashier");
    const row = await pinRow(cashier);
    const otherTenant = establishTenantContext({
      tenantId: randomUUID(),
      brandId: null,
      source: "device",
    });
    setDeviceOutletResolver(
      async ({ deviceId }) => devices.get(deviceId) ?? null,
    );
    try {
      await expect(
        verifyStaffPinOnDevice(otherTenant, {
          deviceId: deviceAt(bandung),
          userId: cashier,
          pin: PIN,
        }),
      ).rejects.toMatchObject({ code: "PIN_INVALID" });
    } finally {
      setDeviceOutletResolver(async ({ tenantId: id, deviceId }) =>
        id === tenantId ? (devices.get(deviceId) ?? null) : null,
      );
    }
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [randomUUID()],
      );
      expect(
        (
          await client.query("SELECT id FROM staff_pins WHERE id = $1", [
            row?.id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await client.query(
            "UPDATE staff_pins SET failed_attempts = 0 WHERE id = $1",
            [row?.id],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("TEN-03 another outlet's scope does not see this outlet's staff pins", async () => {
    const cashier = await staffWithPin("cashier");
    const row = await pinRow(cashier);
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
        [tenantId, JSON.stringify([bandung2])],
      );
      expect(
        (
          await client.query("SELECT id FROM staff_pins WHERE id = $1", [
            row?.id,
          ])
        ).rowCount,
      ).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

// ------------------------------------------------------- supervisor override

describe("legend-dxb AUTH-06 supervisor override with PIN", () => {
  it("AUTH-06 a PIN override records requester, approver, reason, value and outlet, with audit and outbox event", async () => {
    const cashier = await createUser("cashier", {
      type: "outlet",
      id: bandung,
    });
    const supervisor = await staffWithPin("supervisor");
    const input = overrideInput(
      { method: "supervisor_pin", approverUserId: supervisor, pin: PIN },
      { reasonCode: "salah_input" },
    );
    const { override, replayed } = await createPosOverride(
      tenant,
      cashier,
      input,
      { idempotencyKey: null },
    );
    expect(replayed).toBe(false);
    expect(override).toMatchObject({
      outletId: bandung,
      action: "void",
      method: "supervisor_pin",
      status: "approved",
      requestedBy: cashier,
      approvedBy: supervisor,
      reason: input.reason,
      reasonCode: "salah_input",
      valueIdr: 45_000,
      approvalRequestId: null,
    });
    const audit = audits.find(
      (row) =>
        row.action === "pos_override.recorded" && row.objectId === override.id,
    );
    expect(audit).toMatchObject({
      outletId: bandung,
      actorId: supervisor,
      reason: input.reason,
      after: {
        requestedBy: cashier,
        approvedBy: supervisor,
        valueIdr: 45_000,
        action: "void",
      },
    });
    const events = await overrideEvents(override.id);
    expect(events.map((row) => row.name)).toEqual(["pos_override.recorded"]);
    expect(events[0]?.payload).toMatchObject({
      requestedBy: cashier,
      approvedBy: supervisor,
      valueIdr: 45_000,
      method: "supervisor_pin",
      // legend-kyie: the cloud writes the audit row of an edge override.
      reason: input.reason,
      reasonCode: "salah_input",
    });
    // The pin stays out of the event.
    expect(JSON.stringify(events)).not.toContain(PIN);
  });

  it("AUTH-06 the requester can never approve their own override", async () => {
    const supervisor = await staffWithPin("supervisor");
    await expect(
      createPosOverride(
        tenant,
        supervisor,
        overrideInput({
          method: "supervisor_pin",
          approverUserId: supervisor,
          pin: PIN,
        }),
        { idempotencyKey: null },
      ),
    ).rejects.toMatchObject({ code: "APPROVER_IS_REQUESTER" });
    expect(await pinRow(supervisor)).toMatchObject({ failed_attempts: 0 });
    // The database refuses it too.
    await expect(
      owner.query(
        `INSERT INTO pos_overrides
           (id, tenant_id, outlet_id, action, method, status, requested_by, approved_by,
            reason, value_idr, object_type, object_id, request_fingerprint, resolved_at)
         VALUES ($1, $2, $3, 'void', 'supervisor_pin', 'approved', $4, $4,
                 'Uji batasan', 1000, 'order', $5, $6, now())`,
        [
          randomUUID(),
          tenantId,
          bandung,
          supervisor,
          randomUUID(),
          "0".repeat(64),
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("AUTH-06 an approver without the override permission for the outlet is refused before any pin attempt", async () => {
    const cashier = await createUser("cashier", {
      type: "outlet",
      id: bandung,
    });
    const otherCashier = await staffWithPin("cashier");
    await expect(
      createPosOverride(
        tenant,
        cashier,
        overrideInput({
          method: "supervisor_pin",
          approverUserId: otherCashier,
          pin: WRONG,
        }),
        { idempotencyKey: null },
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(await pinRow(otherCashier)).toMatchObject({ failed_attempts: 0 });
    // A supervisor of another outlet does not cover this one (TEN-03).
    const otherOutletSupervisor = await staffWithPin("supervisor", bandung2);
    await expect(
      createPosOverride(
        tenant,
        cashier,
        overrideInput({
          method: "supervisor_pin",
          approverUserId: otherOutletSupervisor,
          pin: PIN,
        }),
        { idempotencyKey: null },
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    // The requester must work at the outlet the override is for.
    const supervisor = await staffWithPin("supervisor");
    await expect(
      createPosOverride(
        tenant,
        cashier,
        overrideInput(
          { method: "supervisor_pin", approverUserId: supervisor, pin: PIN },
          { outletId: bandung2 },
        ),
        { idempotencyKey: null },
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    const { rowCount } = await owner.query(
      "SELECT 1 FROM pos_overrides WHERE tenant_id = $1 AND requested_by = $2",
      [tenantId, cashier],
    );
    expect(rowCount).toBe(0);
  });

  it("AUTH-06 a wrong approver pin records nothing and counts towards the approver's lock", async () => {
    const cashier = await createUser("cashier", {
      type: "outlet",
      id: bandung,
    });
    const supervisor = await staffWithPin("supervisor");
    await expect(
      createPosOverride(
        tenant,
        cashier,
        overrideInput({
          method: "supervisor_pin",
          approverUserId: supervisor,
          pin: WRONG,
        }),
        { idempotencyKey: null },
      ),
    ).rejects.toMatchObject({ code: "PIN_INVALID" });
    expect(await pinRow(supervisor)).toMatchObject({ failed_attempts: 1 });
    const { rowCount } = await owner.query(
      "SELECT 1 FROM pos_overrides WHERE tenant_id = $1 AND requested_by = $2",
      [tenantId, cashier],
    );
    expect(rowCount).toBe(0);
  });

  it("AUTH-06 an idempotency key replays the same override and refuses a different body", async () => {
    const cashier = await createUser("cashier", {
      type: "outlet",
      id: bandung,
    });
    const supervisor = await staffWithPin("supervisor");
    const key = `override-${randomUUID()}`;
    const input = overrideInput({
      method: "supervisor_pin",
      approverUserId: supervisor,
      pin: PIN,
    });
    const first = await createPosOverride(tenant, cashier, input, {
      idempotencyKey: key,
    });
    const replay = await createPosOverride(tenant, cashier, input, {
      idempotencyKey: key,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.override).toEqual(first.override);
    await expect(
      createPosOverride(
        tenant,
        cashier,
        createPosOverrideSchema.parse({ ...input, valueIdr: 99_000 }),
        { idempotencyKey: key },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(await overrideEvents(first.override.id)).toHaveLength(1);
  });

  it("TEN-03 AUTH-06 overrides of one outlet are invisible and immutable from another outlet's scope", async () => {
    const cashier = await createUser("cashier", {
      type: "outlet",
      id: bandung,
    });
    const supervisor = await staffWithPin("supervisor");
    const { override } = await createPosOverride(
      tenant,
      cashier,
      overrideInput({
        method: "supervisor_pin",
        approverUserId: supervisor,
        pin: PIN,
      }),
      { idempotencyKey: null },
    );
    const id = ulidToUuid(override.id);
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
        [tenantId, JSON.stringify([bandung2])],
      );
      expect(
        (await client.query("SELECT id FROM pos_overrides WHERE id = $1", [id]))
          .rowCount,
      ).toBe(0);
      expect(
        (
          await client.query(
            "UPDATE pos_overrides SET value_idr = 1 WHERE id = $1",
            [id],
          )
        ).rowCount,
      ).toBe(0);
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [randomUUID()],
      );
      expect(
        (await client.query("SELECT id FROM pos_overrides WHERE id = $1", [id]))
          .rowCount,
      ).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

// legend-m4fv, PRD EDC-04: a standalone EDC payment (EDC agent down) needs a
// supervisor PIN on the device, tied to the order and a real amount.
describe("legend-m4fv EDC-04 edc_standalone override", () => {
  const edcInput = (
    approval: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    overrideInput(approval, {
      action: "edc_standalone",
      valueIdr: 125_000,
      reason: "EDC standalone, referensi bank 123456789012",
      objectType: "pos_order",
      ...extra,
    });

  it("EDC-04 a supervisor PIN approves a standalone EDC payment and it is recorded", async () => {
    const cashier = await createUser("cashier", {
      type: "outlet",
      id: bandung,
    });
    const supervisor = await staffWithPin("supervisor");
    const { override } = await createPosOverride(
      tenant,
      cashier,
      edcInput({
        method: "supervisor_pin",
        approverUserId: supervisor,
        pin: PIN,
      }),
      { idempotencyKey: null },
    );
    expect(override).toMatchObject({
      action: "edc_standalone",
      method: "supervisor_pin",
      status: "approved",
      requestedBy: cashier,
      approvedBy: supervisor,
      valueIdr: 125_000,
      objectType: "pos_order",
    });
    const events = await overrideEvents(override.id);
    expect(events.map((row) => row.name)).toEqual(["pos_override.recorded"]);
  });

  it("EDC-04 an approver without pos.edc_standalone.approve is refused before any pin attempt", async () => {
    const cashier = await createUser("cashier", {
      type: "outlet",
      id: bandung,
    });
    const otherCashier = await staffWithPin("cashier");
    await expect(
      createPosOverride(
        tenant,
        cashier,
        edcInput({
          method: "supervisor_pin",
          approverUserId: otherCashier,
          pin: WRONG,
        }),
        { idempotencyKey: null },
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(await pinRow(otherCashier)).toMatchObject({ failed_attempts: 0 });
  });

  it("EDC-04 phone approval, a zero amount or a non-order object are refused", async () => {
    const cashier = await createUser("cashier", {
      type: "outlet",
      id: bandung,
    });
    const supervisor = await staffWithPin("supervisor");
    const pin = {
      method: "supervisor_pin",
      approverUserId: supervisor,
      pin: PIN,
    };
    for (const input of [
      edcInput({ method: "supervisor_phone" }),
      edcInput(pin, { valueIdr: 0 }),
      edcInput(pin, { objectType: "order" }),
    ])
      await expect(
        createPosOverride(tenant, cashier, input, { idempotencyKey: null }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const { rowCount } = await owner.query(
      "SELECT 1 FROM pos_overrides WHERE tenant_id = $1 AND requested_by = $2",
      [tenantId, cashier],
    );
    expect(rowCount).toBe(0);
    expect(await pinRow(supervisor)).toMatchObject({ failed_attempts: 0 });
  });
});

describe("legend-dxb AUTH-06 remote approval from the supervisor's phone", () => {
  async function phoneOverride(
    cashier: string,
    extra: Record<string, unknown> = {},
  ) {
    const { override } = await createPosOverride(
      tenant,
      cashier,
      overrideInput({ method: "supervisor_phone" }, extra),
      { idempotencyKey: null },
    );
    return override;
  }

  it("AUTH-06 a phone approval stays pending until the supervisor approves, then records the approver", async () => {
    const cashier = await createUser("cashier", {
      type: "outlet",
      id: bandung,
    });
    const supervisor = await createUser("supervisor", {
      type: "outlet",
      id: bandung,
    });
    const pending = await phoneOverride(cashier);
    expect(pending).toMatchObject({
      status: "pending",
      method: "supervisor_phone",
      approvedBy: null,
      requestedBy: cashier,
    });
    expect(pending.approvalRequestId).not.toBeNull();
    // Polling before the decision leaves it pending and records nothing.
    expect((await getPosOverride(tenant, cashier, pending.id)).status).toBe(
      "pending",
    );
    expect(await overrideEvents(pending.id)).toHaveLength(0);
    // The requester cannot approve it from the inbox either (AUTH-06).
    await expect(
      decideApprovalRequest(
        tenant,
        cashier,
        pending.approvalRequestId!,
        { decision: "approved", reason: "Saya setujui sendiri." },
        { mfaVerified: true, idempotencyKey: null },
      ),
    ).rejects.toMatchObject({
      code: expect.stringMatching(
        /^(APPROVER_IS_REQUESTER|PERMISSION_DENIED)$/,
      ),
    });
    await decideApprovalRequest(
      tenant,
      supervisor,
      pending.approvalRequestId!,
      { decision: "approved", reason: "Sesuai bukti transaksi." },
      { mfaVerified: true, idempotencyKey: null },
    );
    const resolved = await getPosOverride(tenant, cashier, pending.id);
    expect(resolved).toMatchObject({
      status: "approved",
      approvedBy: supervisor,
      requestedBy: cashier,
      valueIdr: 45_000,
      outletId: bandung,
    });
    expect(resolved.resolvedAt).not.toBeNull();
    // Settled exactly once: a second poll adds no second record.
    await getPosOverride(tenant, cashier, pending.id);
    expect((await overrideEvents(pending.id)).map((row) => row.name)).toEqual([
      "pos_override.recorded",
    ]);
    expect(
      audits.filter(
        (row) =>
          row.action === "pos_override.recorded" && row.objectId === pending.id,
      ),
    ).toHaveLength(1);
  });

  it("AUTH-06 a rejected or expired phone approval grants no override", async () => {
    const cashier = await createUser("cashier", {
      type: "outlet",
      id: bandung,
    });
    const supervisor = await createUser("supervisor", {
      type: "outlet",
      id: bandung,
    });
    const rejected = await phoneOverride(cashier);
    await decideApprovalRequest(
      tenant,
      supervisor,
      rejected.approvalRequestId!,
      { decision: "rejected", reason: "Pesanan sudah dimasak." },
      { mfaVerified: true, idempotencyKey: null },
    );
    expect(await getPosOverride(tenant, cashier, rejected.id)).toMatchObject({
      status: "rejected",
      approvedBy: null,
    });
    expect(await overrideEvents(rejected.id)).toHaveLength(0);

    const expiring = await phoneOverride(cashier);
    await owner.query(
      `UPDATE approval_requests
         SET created_at = now() - interval '2 hours', deadline_at = now() - interval '1 hour'
       WHERE tenant_id = $1 AND chain_id = $2`,
      [tenantId, expiring.approvalRequestId],
    );
    expect(await getPosOverride(tenant, cashier, expiring.id)).toMatchObject({
      status: "expired",
      approvedBy: null,
    });
    expect(await overrideEvents(expiring.id)).toHaveLength(0);
    expect(
      audits.filter((row) => row.action === "pos_override.denied"),
    ).toHaveLength(2);
  });

  it("AUTH-06 a phone approval needs a matrix approver at that value, and other users never see the override", async () => {
    const cashier = await createUser("cashier", {
      type: "outlet",
      id: bandung,
    });
    // Refund below the Rp500.000 tier: the matrix names nobody → refused.
    await expect(
      phoneOverride(cashier, { action: "refund", valueIdr: 100_000 }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const pending = await phoneOverride(cashier);
    const stranger = await createUser("cashier", {
      type: "outlet",
      id: bandung2,
    });
    await expect(
      getPosOverride(tenant, stranger, pending.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const colleague = await createUser("cashier", {
      type: "outlet",
      id: bandung,
    });
    await expect(
      getPosOverride(tenant, colleague, pending.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// --------------------------------------------------------------------- HTTP

describe("legend-dxb HTTP API (§3 F6, AUTH-06)", () => {
  async function signedIn(templateKey: string, outletId: string = bandung) {
    const client = agent(app);
    const email = await signUp(client, `Override ${templateKey}`);
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    createdUserIds.push(userId);
    await assign(userId, templateKey, { type: "outlet", id: outletId });
    await verifySessionMfa(email);
    return { client, userId };
  }

  it("§3 F6 POST /api/staff-pins/verify needs a signed device token and a strict body", async () => {
    const cashier = await staffWithPin("cashier");
    const { token } = await enrolledDeviceToken(bandung);
    const ok = await agent(app)
      .post("/api/staff-pins/verify")
      .set("X-Device-Token", token)
      .send({ userId: cashier, pin: PIN });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({
      outletId: bandung,
      user: { id: cashier },
    });
    const wrong = await agent(app)
      .post("/api/staff-pins/verify")
      .set("X-Device-Token", token)
      .send({ userId: cashier, pin: WRONG });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("PIN_INVALID");
    const strict = await agent(app)
      .post("/api/staff-pins/verify")
      .set("X-Device-Token", token)
      .send({ userId: cashier, pin: PIN, tenantId });
    expect(strict.status).toBe(422);
    // No device token: no tenant, no pin check.
    const anonymous = await agent(app)
      .post("/api/staff-pins/verify")
      .send({ userId: cashier, pin: PIN });
    expect([401, 404]).toContain(anonymous.status);
    // A correctly signed token for a device the registry does not know (F5).
    const stranger = await agent(app)
      .post("/api/staff-pins/verify")
      .set(
        "X-Device-Token",
        signDeviceToken({
          version: 1,
          tenantId,
          brandId: null,
          deviceId: deviceAt(bandung),
          issuedAt: Math.floor(Date.now() / 1000),
        }),
      )
      .send({ userId: cashier, pin: PIN });
    expect([401, 404]).toContain(stranger.status);
  });

  it("AUTH-06 POST /api/pos-overrides: session, origin, self-approval refused, 201 then 200 replay", async () => {
    expect((await agent(app).post("/api/pos-overrides").send({})).status).toBe(
      401,
    );
    const cashier = await signedIn("cashier");
    const supervisor = await staffWithPin("supervisor");
    const body = {
      outletId: bandung,
      action: "cash_drawer_open",
      valueIdr: 0,
      reason: `Tukar uang kecil ${randomBytes(3).toString("hex")}`,
      objectType: "cash_drawer",
      objectId: randomUUID(),
      approval: {
        method: "supervisor_pin",
        approverUserId: supervisor,
        pin: PIN,
      },
    };
    expect(
      (await cashier.client.post("/api/pos-overrides").send(body)).status,
    ).toBe(403);
    const self = await cashier.client
      .post("/api/pos-overrides")
      .set(originHeader)
      .send({
        ...body,
        approval: { ...body.approval, approverUserId: cashier.userId },
      });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("APPROVER_IS_REQUESTER");
    const key = `http-override-${randomUUID()}`;
    const created = await cashier.client
      .post("/api/pos-overrides")
      .set(originHeader)
      .set("Idempotency-Key", key)
      .send(body);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      status: "approved",
      requestedBy: cashier.userId,
      approvedBy: supervisor,
      valueIdr: 0,
    });
    const replay = await cashier.client
      .post("/api/pos-overrides")
      .set(originHeader)
      .set("Idempotency-Key", key)
      .send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(created.body.data.id);
    const read = await cashier.client.get(
      `/api/pos-overrides/${created.body.data.id}`,
    );
    expect(read.status).toBe(200);
    expect(read.body.data.id).toBe(created.body.data.id);
  });
});
