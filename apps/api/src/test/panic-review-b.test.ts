// Architect review findings F-B on the emergency receiver session (bead
// legend-bod, design docs/design/edge-emergency.md D-03):
//  (2) a session ends `device_revoked` when its device token was reissued after
//      the session was issued (devices.token_issued_at > session.issued_at).
//      The device type is immutable (trigger app.guard_device_update), so the
//      type check in the re-check has no test;
//  (7) the 3-live-sessions-per-staff cap counts across the outlets of the tenant.
// Fixtures follow panic-receiver-session.test.ts.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Must run before ../config/env is first imported (imports are hoisted).
vi.hoisted(() => {
  process.env.EDGE_MODE = "true";
  process.env.EDGE_CLOUD_URL = "wss://cloud.invalid/api/edge-link";
  process.env.EDGE_NODE_CREDENTIAL =
    "edg1.5d1e7c00-0000-4000-8000-000000000011.5d1e7c00-0000-4000-8000-000000000012.5d1e7c00-0000-4000-8000-000000000013." +
    "A".repeat(43);
});

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
import {
  installEdgeStaffPinPeppers,
  resetEdgeStaffPinPeppers,
} from "../edge/staff-pin-pepper-registry.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { createDeviceOutletResolver } from "../services/device-outlet-resolver.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  enrollDevice,
  issueDeviceToken,
  revokeDevice,
} from "../services/device.service.ts";
import { authenticateReceiverSession } from "../services/panic-receiver-session.ts";
import { withEdgeModeEnv } from "./edge-mode-env.ts";
import { agent, WEB_ORIGIN } from "./helpers.ts";
import {
  PANIC_COOKIE_NAME,
  PANIC_PERMISSION_RESPOND,
  PANIC_ROUTES,
  sessionBody,
} from "./panic-test-helpers.ts";

const PIN = "582914";
const HOUR = 60 * 60_000;

const edge = createApp({ edgeMode: true });
delete process.env.EDGE_MODE;

const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const tenantContext = establishTenantContext({
  tenantId: tenant.id,
  brandId: null,
  source: "session",
});
const outletScope = (id: string) =>
  establishScopedTenantContext(tenantContext, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(id)],
  });
const actor = randomUUID();

const outletPeppers = new Map<string, Buffer>();
let outletA: string;
let outletB: string;
let adminUserId: string;

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

let edgeOutlet: string | null = null;
const tokenOutlet = new Map<string, string>();
function holdPeppers(outlet: string) {
  resetEdgeStaffPinPeppers();
  let pepper = outletPeppers.get(outlet);
  if (pepper === undefined) {
    pepper = randomBytes(32);
    outletPeppers.set(outlet, pepper);
  }
  installEdgeStaffPinPeppers(tenant.id, outlet, [{ version: 2, pepper }]);
  edgeOutlet = outlet;
}
const ensurePeppers = (outlet: string) => {
  if (edgeOutlet !== outlet) holdPeppers(outlet);
};

async function seedOutlet(label: string) {
  const id = randomUUID();
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Darurat', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `RB-${id.slice(0, 8)}`.toUpperCase(),
        label,
      ],
    );
  });
  return id;
}

async function enrollAt(outlet: string, type: "pos" | "waiter_phone") {
  const enrolled = await enrollDevice(outletScope(outlet), actor, {
    outletId: outlet,
    type,
    label: `Layar ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  tokenOutlet.set(enrolled.token, outlet);
  return { token: enrolled.token, id: enrolled.device.id, outlet };
}
type Device = Awaited<ReturnType<typeof enrollAt>>;

async function insertUser(label: string) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
    [id, label, `${id}@example.test`],
  );
  return id;
}

async function grantRespond(userId: string, outlet: string) {
  const roleId = randomUUID();
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, false, '["outlet"]')`,
      [
        roleId,
        tenant.id,
        `Darurat ${roleId.slice(0, 8)}`,
        JSON.stringify([PANIC_PERMISSION_RESPOND]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenant.id, userId, roleId, outlet],
    );
  });
}

async function seedShift(employeeId: string, outlet: string) {
  const now = Date.now();
  await asTenant((client) =>
    client.query(
      `INSERT INTO shift_assignments
         (id, tenant_id, outlet_id, employee_id, business_date, segments, break_minutes,
          status, source, published_by, published_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 'published', 'user', $7, now(), $7)`,
      [
        randomUUID(),
        tenant.id,
        outlet,
        employeeId,
        new Date(now + 7 * HOUR).toISOString().slice(0, 10),
        JSON.stringify([
          {
            startsAt: new Date(now - HOUR).toISOString(),
            endsAt: new Date(now + 7 * HOUR).toISOString(),
          },
        ]),
        adminUserId,
      ],
    ),
  );
}

/** Staff on duty and permitted at every outlet in `outlets`, with a PIN at each. */
async function onDutyStaff(outlets: string[]) {
  const userId = await insertUser("Staf Review B");
  const employeeId = randomUUID();
  await asTenant(async (c) => {
    await c.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Darurat', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        tenant.id,
        userId,
        `RB-${employeeId.slice(0, 8).toUpperCase()}`,
        outlets[0],
      ],
    );
  });
  for (const outlet of outlets) {
    await grantRespond(userId, outlet);
    ensurePeppers(outlet);
    await setStaffPin(
      tenantContext,
      userId,
      { outletId: outlet, userId },
      { pin: PIN },
    );
    await seedShift(employeeId, outlet);
  }
  return { userId };
}

const login = (device: Device, userId: string) =>
  withEdgeModeEnv(async () => {
    ensurePeppers(tokenOutlet.get(device.token) ?? outletA);
    return agent(edge)
      .post(PANIC_ROUTES.sessions)
      .set(DEVICE_TOKEN_HEADER, device.token)
      .set("Origin", WEB_ORIGIN)
      .send(sessionBody(userId, PIN));
  });

async function loginCookie(device: Device, userId: string) {
  const response = await login(device, userId);
  expect([200, 201], JSON.stringify(response.body)).toContain(response.status);
  const header = response.headers["set-cookie"];
  const raw = (Array.isArray(header) ? (header as string[]) : []).find((c) =>
    c.startsWith(`${PANIC_COOKIE_NAME}=`),
  );
  expect(raw, "Set-Cookie legend_emergency missing").toBeDefined();
  return `${PANIC_COOKIE_NAME}=${raw!.slice(PANIC_COOKIE_NAME.length + 1).split(";")[0]!}`;
}

async function sessionsOf(userId: string) {
  const { rows } = await owner.query<{
    device_id: string;
    revoked_at: Date | null;
    revoke_reason: string | null;
  }>(
    `SELECT device_id::text, revoked_at, revoke_reason FROM panic_receiver_sessions
      WHERE tenant_id = $1 AND user_id::text = $2 ORDER BY issued_at`,
    [tenant.id, userId],
  );
  return rows;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  setDeviceOutletResolver(createDeviceOutletResolver());
  outletA = await seedOutlet("Outlet review B-A");
  outletB = await seedOutlet("Outlet review B-B");
  holdPeppers(outletA);
  adminUserId = await insertUser("Admin Review B");
}, 90_000);

afterAll(async () => {
  resetEdgeStaffPinPeppers();
  setAuditWriter(null);
  setDeviceOutletResolver(null);
  await owner.end();
});

describe("F-B (2): a session follows its device", () => {
  it("token reissued after the session was issued -> device_revoked", async () => {
    const device = await enrollAt(outletA, "pos");
    const staff = await onDutyStaff([outletA]);
    const cookie = await loginCookie(device, staff.userId);
    expect(await authenticateReceiverSession(cookie)).not.toBeNull();

    await issueDeviceToken(
      outletScope(outletA),
      actor,
      { deviceId: device.id },
      new Date(Date.now() + 60_000),
    );

    expect(await authenticateReceiverSession(cookie)).toBeNull();
    const [row] = await sessionsOf(staff.userId);
    expect(row!.revoked_at).not.toBeNull();
    expect(row!.revoke_reason).toBe("device_revoked");
  });

  it("an untouched device keeps its session (no false revoke)", async () => {
    const device = await enrollAt(outletA, "pos");
    const staff = await onDutyStaff([outletA]);
    const cookie = await loginCookie(device, staff.userId);
    expect(await authenticateReceiverSession(cookie)).not.toBeNull();
    expect(await authenticateReceiverSession(cookie)).not.toBeNull();
    expect((await sessionsOf(staff.userId))[0]!.revoked_at).toBeNull();
    await revokeDevice(outletScope(outletA), actor, {
      deviceId: device.id,
      reason: "Uji selesai",
    });
  });
});

describe("F-B (7): 3 live sessions per staff across outlets", () => {
  it("2 sessions at outlet A + 2 at outlet B -> at most 3 live, the newest live", async () => {
    const staff = await onDutyStaff([outletA, outletB]);
    const devices = [
      await enrollAt(outletA, "pos"),
      await enrollAt(outletA, "pos"),
      await enrollAt(outletB, "pos"),
      await enrollAt(outletB, "pos"),
    ];
    for (const device of devices) await loginCookie(device, staff.userId);

    const rows = await sessionsOf(staff.userId);
    expect(rows).toHaveLength(4);
    const live = rows.filter((r) => r.revoked_at === null);
    expect(live.length).toBeLessThanOrEqual(3);
    expect(live.map((r) => r.device_id)).toContain(devices[3]!.id);
    const ended = rows.filter((r) => r.revoked_at !== null);
    expect(ended.every((r) => r.revoke_reason === "replaced")).toBe(true);
  });
});
