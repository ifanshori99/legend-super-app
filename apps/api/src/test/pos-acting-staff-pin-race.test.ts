// PIN verify and token insert agree on one PIN generation (bead legend-aruta,
// Codex fix S2). `issueActingStaff` verifies the PIN and then inserts the token
// in a second transaction. A PIN reset that commits between the two used to
// leave a live token of the OLD PIN that nobody revoked. The race is made
// deterministic by wrapping the verify step of device-pin.service: the reset
// commits right after the verify returns and before the issue transaction.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import type { TenantContext } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { setAuditWriter } from "../services/audit-writer.ts";

// Runs once after the real verify returned (the PIN was correct at that time).
const raceHook = vi.hoisted(() => ({
  afterVerify: null as null | (() => Promise<void>),
}));
vi.mock("../services/device-pin.service.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../services/device-pin.service.ts")>();
  const wrap =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const result = await fn(...args);
      const hook = raceHook.afterVerify;
      raceHook.afterVerify = null;
      if (hook) await hook();
      return result;
    };
  return {
    ...original,
    verifyStaffPinOnDevice: wrap(original.verifyStaffPinOnDevice),
    ...("verifyStaffPinOnDeviceVersioned" in original
      ? {
          verifyStaffPinOnDeviceVersioned: wrap(
            (
              original as unknown as {
                verifyStaffPinOnDeviceVersioned: (
                  ...args: never[]
                ) => Promise<unknown>;
              }
            ).verifyStaffPinOnDeviceVersioned,
          ),
        }
      : {}),
  };
});

const { issueActingStaff } =
  await import("../services/pos-acting-staff.service.ts");
const { setDeviceOutletResolver, setStaffPin } =
  await import("../services/device-pin.service.ts");

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdUserIds: string[] = [];
const createdDeviceIds: string[] = [];
const PIN_OLD = "582914";
const PIN_NEW = "730418";

const tenant: TenantContext = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});

async function newStaff(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Staf balapan PIN', $2)`,
    [id, `${id}@example.test`],
  );
  createdUserIds.push(id);
  const {
    rows: [role],
  } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'cashier'",
    [tenantId],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '2 hours', $2)`,
    [tenantId, id, role!.id, bandung],
  );
  return id;
}

async function newDevice(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', 'Kasir balapan', now() - interval '1 minute')`,
    [id, tenantId, bandung],
  );
  createdDeviceIds.push(id);
  return id;
}

const setPin = (userId: string, pin: string) =>
  setStaffPin(tenant, userId, { outletId: bandung, userId }, { pin });

async function liveTokens(staffUserId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pos_acting_staff
     WHERE tenant_id = $1 AND staff_user_id = $2 AND revoked_at IS NULL`,
    [tenantId, staffUserId],
  );
  return rows[0]!.n;
}

beforeAll(() => {
  setAuditWriter({ record: async () => {} });
});

afterAll(async () => {
  setAuditWriter(null);
  setDeviceOutletResolver(null);
  await owner.query(
    "DELETE FROM pos_acting_staff WHERE tenant_id = $1 AND staff_user_id = ANY($2::text[])",
    [tenantId, createdUserIds],
  );
  await owner.query("DELETE FROM devices WHERE id = ANY($1::uuid[])", [
    createdDeviceIds,
  ]);
  await owner.query(
    `DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_type = 'staff_pin' AND event->'payload'->>'userId' = ANY($2::text[])`,
    [tenantId, createdUserIds],
  );
  await owner.query(
    "DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
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

describe("legend-aruta pin reset between verify and token insert", () => {
  it("leaves no live token of the old PIN when a reset commits in between", async () => {
    const staff = await newStaff();
    const sessionUser = await newStaff();
    const deviceId = await newDevice();
    setDeviceOutletResolver(async (input) =>
      input.deviceId === deviceId ? bandung : null,
    );
    await setPin(staff, PIN_OLD);

    raceHook.afterVerify = () => setPin(staff, PIN_NEW);
    const issued = issueActingStaff(tenant, {
      deviceId,
      sessionId: randomUUID(),
      sessionUserId: sessionUser,
      userId: staff,
      pin: PIN_OLD,
    });
    // Either answer is safe: the issue is refused, or the token is revoked.
    await issued.catch(() => undefined);
    expect(await liveTokens(staff)).toBe(0);
  });

  it("refuses the issue with ACTING_STAFF_INVALID when the PIN changed meanwhile", async () => {
    const staff = await newStaff();
    const sessionUser = await newStaff();
    const deviceId = await newDevice();
    setDeviceOutletResolver(async (input) =>
      input.deviceId === deviceId ? bandung : null,
    );
    await setPin(staff, PIN_OLD);

    raceHook.afterVerify = () => setPin(staff, PIN_NEW);
    await expect(
      issueActingStaff(tenant, {
        deviceId,
        sessionId: randomUUID(),
        sessionUserId: sessionUser,
        userId: staff,
        pin: PIN_OLD,
      }),
    ).rejects.toMatchObject({ status: 401, code: "ACTING_STAFF_INVALID" });
  });

  it("still issues a live token when the PIN did not change", async () => {
    const staff = await newStaff();
    const sessionUser = await newStaff();
    const deviceId = await newDevice();
    setDeviceOutletResolver(async (input) =>
      input.deviceId === deviceId ? bandung : null,
    );
    await setPin(staff, PIN_OLD);

    const result = await issueActingStaff(tenant, {
      deviceId,
      sessionId: randomUUID(),
      sessionUserId: sessionUser,
      userId: staff,
      pin: PIN_OLD,
    });
    expect(result.token).toMatch(/^pas_/);
    expect(await liveTokens(staff)).toBe(1);
  });
});
