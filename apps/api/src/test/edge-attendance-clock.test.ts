// Edge clock with the local copy (bead legend-j6cyb, T4 + T8; design
// docs/design/hris-edge-replication.md 3.4, 6.2, 9 T4 and T8, founder Q86/Q87).
// An edge process (EDGE_MODE) accepts method `outlet_device`: a staff-PIN
// session on a registered outlet device plus a sealed selfie. Runs the real
// Express app, Better Auth, RBAC and PostgreSQL against the seeded Cafe Legend
// tenant. Written from the design, not from the implementation.
//
// Assumptions where the design is silent:
// - "Edge mode" is the process setting EDGE_MODE=true (withEdgeModeEnv), set
//   only around the clock request. The cloud and the edge replica share this
//   test database, so the devices table is also "the device registry replica".
// - The outlet device is a registered device of type `pos` (design names no
//   type). Its signed token travels in X-Device-Token (DEVICE_TOKEN_HEADER).
// - The clock body for outlet_device carries `location: null`, `deviceIdHash:
//   null`, `qrToken: null`: the edge ignores all three (design 3.4 step 5).
// - The log outlet O is the outlet of the registered device; the employee's
//   home outlet is also O. A device of another outlet gives 403 (EDG-03 "at
//   outlet O").
// - Employee not onboarding/active (here: suspended) and a role without
//   self.attendance.clock both answer 403 "as on the cloud".
// - selfie_geo and rotating_qr on the edge answer 400, checked with a valid
//   device token so only the method decides.
// - edgeDeviceId in the payload is the registered device id (string).
// - Founder Q87: every outlet_device log is flagged with review_status
//   pending, and its reasons are exactly [offline_unverified] (plus
//   edge_roster_stale when last_checked_at is older than 24 h; 23 h is fresh).
// - "Queued" = a domain_event_outbox row named attendance.logged for the
//   employee (any destination). A rejected clock queues none.
// - The shared-transaction guarantee (log, event and upload row commit
//   together) is not tested here: it needs a fault injected inside the service.
// - Item 9 (staff-PIN session and mfa_required roles) is a documentation
//   finding, not a test here.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import sharp from "sharp";

// Must run before ../config/env is first imported (imports are hoisted).
const edgeDir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), "edge-attendance-clock-"));
  process.env.EDGE_SELFIE_DIR = dir;
  return dir;
});

import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { outletIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  DEVICE_TOKEN_HEADER,
  cafeLegendPlatformFixtures,
} from "@starter/shared/platform";
import { createApp } from "../app.ts";
import * as schema from "../db/schema";
import { signDeviceToken } from "../lib/device-token.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { enrollDevice, revokeDevice } from "../services/device.service.ts";
import { uploadEdgeSelfie } from "../services/edge-selfie.service.ts";
import { rotateAttendanceQrSecret } from "../services/hris-attendance.service.ts";
import { withEdgeModeEnv } from "./edge-mode-env.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const db = drizzle(appPool, { schema });
const tenantContext = establishTenantContext({
  tenantId: tenant.id,
  brandId: null,
  source: "session",
});
const context = establishScopedTenantContext(tenantContext, {
  kind: "tenant",
});
const outletScope = (outletId: string) =>
  establishScopedTenantContext(tenantContext, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });
const actor = randomUUID();

const KID = "edge-clock-kid-1";
const { publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WIB_OFFSET = 7 * HOUR;
const wibDate = (ms: number) =>
  new Date(ms + WIB_OFFSET).toISOString().slice(0, 10);

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdOutlets: string[] = [];
let outletId: string; // O
let otherOutletId: string; // another outlet of the tenant
let adminUserId: string;
let deviceToken: string; // active device at O
let deviceId: string;
let otherOutletDeviceToken: string; // active device at another outlet

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

type Client = ReturnType<typeof agent>;

async function grantRole(
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; outletIds: string[] },
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Edge clock ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    const scopeIds = scope.type === "tenant" ? [null] : scope.outletIds;
    for (const scopeId of scopeIds)
      await client.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
        [tenant.id, userId, roleId, scope.type, scopeId],
      );
  });
}

// Outlet centre; the policy below REJECTS outside 100 m and unbound devices,
// so a pass proves the edge ignores geofence and device binding.
const CENTER = { latitude: -6.2, longitude: 106.8 };
const FAR = { ...CENTER, latitude: CENTER.latitude + 0.01 };

async function seedOutlet(label: string) {
  const id = randomUUID();
  createdOutlets.push(id);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status, geofence)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Absensi', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $7)`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `EC-${id.slice(0, 8)}`.toUpperCase(),
        label,
        JSON.stringify({ ...CENTER, radiusMeters: 100 }),
      ],
    );
  });
  return id;
}

/** A signed-in employee of O who may clock (unless overridden). */
async function newStaff(
  name: string,
  options: { status?: string; permissions?: string[] } = {},
) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  await grantRole(
    userId,
    options.permissions ?? ["self.profile.view", "self.attendance.clock"],
    { type: "outlet", outletIds: [outletId] },
  );
  const employeeId = randomUUID();
  createdEmployees.push(employeeId);
  await asTenant(async (c) => {
    await c.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Layar Outlet', $5, 'pkwtt', '2025-03-01', $6)`,
      [
        employeeId,
        tenant.id,
        userId,
        `EC-${employeeId.slice(0, 8).toUpperCase()}`,
        outletId,
        options.status ?? "active",
      ],
    );
  });
  return { client, userId, employeeId };
}

/** An edge-sealed selfie object, made by the real edge upload service. */
async function sealedSelfie(userId: string) {
  const jpeg = await sharp({
    create: { width: 64, height: 48, channels: 3, background: "teal" },
  })
    .jpeg()
    .toBuffer();
  const stored = await uploadEdgeSelfie(
    db,
    context,
    {
      purpose: "selfie",
      outletId: outletIdSchema.parse(outletId),
    } as never,
    jpeg,
    {
      authorize: async () => true,
      actorUserId: userId,
      scanner: new NoopMalwareScanner(),
      dir: edgeDir,
      maxBytes: 1024 * 1024 * 1024,
    } as never,
  );
  return stored.id;
}

const clockBody = (overrides: Record<string, unknown> = {}) => ({
  type: "in",
  method: "outlet_device",
  occurredAt: new Date().toISOString(),
  location: null,
  deviceIdHash: null,
  photoUploadRef: null,
  qrToken: null,
  idempotencyKey: `att-edge-clock-${randomUUID()}`,
  ...overrides,
});

/** The clock request as an edge process answers it (EDGE_MODE on). */
const clockOnEdge = (
  client: Client,
  body: unknown,
  token: string | null = deviceToken,
) =>
  withEdgeModeEnv(async () => {
    let req = client.post("/api/hris/attendance/clock").set(originHeader);
    if (token !== null) req = req.set(DEVICE_TOKEN_HEADER, token);
    return await req.send(body as object);
  });

/** The same request on the cloud (EDGE_MODE off). */
const clockOnCloud = (client: Client, body: unknown, token = deviceToken) =>
  client
    .post("/api/hris/attendance/clock")
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, token)
    .send(body as object);

type LogRow = {
  id: string;
  outlet_id: string;
  type: string;
  method: string;
  validity: string;
  flag_reasons: string[];
  review_status: string;
  photo_key: string | null;
  shift_assignment_id: string | null;
};

async function logsOf(employeeId: string): Promise<LogRow[]> {
  const { rows } = await owner.query(
    `SELECT id, outlet_id, type, method, validity, flag_reasons, review_status,
            photo_key, shift_assignment_id
       FROM attendance_logs WHERE tenant_id = $1 AND employee_id = $2
      ORDER BY occurred_at`,
    [tenant.id, employeeId],
  );
  return rows as LogRow[];
}

type OutboxRow = {
  destination: string;
  event: {
    name: string;
    payload: {
      attendanceLogId: string;
      employeeId: string;
      outletId: string;
      method: string;
      validity: string;
      shiftAssignmentId: string | null;
      selfieObjectId?: string | null;
      edgeFlagReasons?: string[];
      edgeDeviceId?: string | null;
    };
  };
};

async function queuedEvents(employeeId: string): Promise<OutboxRow[]> {
  const { rows } = await owner.query(
    `SELECT destination, event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'attendance.logged'
        AND event->'payload'->>'employeeId' = $2`,
    [tenant.id, employeeId],
  );
  return rows as OutboxRow[];
}

type QueueRow = {
  tenant_id: string;
  outlet_id: string;
  state: string;
  seal_kid: string;
  file_path: string;
};

/** Upload rows for one API log id (the API id is a ULID; the column is a uuid). */
async function uploadRows(logId: string): Promise<QueueRow[]> {
  const { rows } = await owner.query(
    `SELECT tenant_id, outlet_id, state, seal_kid, file_path
       FROM edge_selfie_uploads WHERE tenant_id = $1 AND attendance_log_id = $2`,
    [tenant.id, ulidToUuid(logId)],
  );
  return rows as QueueRow[];
}

/** Every trace of a clock for the employee: logs, queued events. */
async function nothingStored(employeeId: string) {
  expect(await logsOf(employeeId)).toHaveLength(0);
  expect(await queuedEvents(employeeId)).toHaveLength(0);
}

/** Moves the roster check time (edge_people_sync_state.last_checked_at). */
async function setRosterAgeHours(hours: number) {
  await owner.query(
    `UPDATE edge_people_sync_state
        SET last_checked_at = now() - make_interval(hours => $3::int)
      WHERE tenant_id = $1 AND outlet_id = $2`,
    [tenant.id, outletId, hours],
  );
}

/** Never straddle outlet midnight: the business date is the local calendar day. */
async function avoidOutletMidnight() {
  const sinceMidnight = (Date.now() + WIB_OFFSET) % (24 * HOUR);
  const untilMidnight = 24 * HOUR - sinceMidnight;
  if (sinceMidnight < MINUTE || untilMidnight < 2 * MINUTE)
    await new Promise((resolve) =>
      setTimeout(resolve, untilMidnight + 2 * MINUTE),
    );
}

/** A published shift around "now" for the employee at the given outlet. */
async function seedShift(employeeId: string, shiftOutletId: string) {
  await avoidOutletMidnight();
  const id = randomUUID();
  const start = Date.now() - HOUR;
  await asTenant((client) =>
    client.query(
      `INSERT INTO shift_assignments
         (id, tenant_id, outlet_id, employee_id, business_date, segments, break_minutes,
          status, source, published_by, published_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 'published', 'user', $7, now(), $7)`,
      [
        id,
        tenant.id,
        shiftOutletId,
        employeeId,
        wibDate(Date.now()),
        JSON.stringify([
          {
            startsAt: new Date(start).toISOString(),
            endsAt: new Date(start + 8 * HOUR).toISOString(),
          },
        ]),
        adminUserId,
      ],
    ),
  );
  return id;
}

const sorted = (values: string[]) => [...values].sort();

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  outletId = await seedOutlet("Outlet layar edge");
  otherOutletId = await seedOutlet("Outlet lain layar edge");

  const enrolled = await enrollDevice(outletScope(outletId), actor, {
    outletId,
    type: "pos",
    label: `Layar ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  deviceToken = enrolled.token;
  deviceId = enrolled.device.id;
  const otherEnrolled = await enrollDevice(outletScope(otherOutletId), actor, {
    outletId: otherOutletId,
    type: "pos",
    label: `Layar lain ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  otherOutletDeviceToken = otherEnrolled.token;

  // The edge roster copy: seal key for the selfie, checked just now.
  await owner.query(
    `INSERT INTO edge_people_sync_state
       (tenant_id, outlet_id, selfie_seal_kid, selfie_seal_public_key, last_checked_at)
     VALUES ($1, $2, $3, $4, now())`,
    [tenant.id, outletId, KID, publicKey],
  );

  const policyAdmin = agent(app);
  await signUp(policyAdmin, "Admin Kebijakan Layar Edge");
  const session = await policyAdmin.get("/api/auth/get-session");
  adminUserId = session.body.user.id as string;
  createdUsers.push(adminUserId);
  await verifySessionMfa(session.body.user.email as string);
  await grantRole(adminUserId, ["hr.attendance.manage"], { type: "tenant" });
  const response = await policyAdmin
    .put("/api/hris/attendance/policy")
    .set(originHeader)
    .send({
      outletId,
      policy: {
        geofenceRadiusM: 100,
        outsideGeofenceAction: "reject",
        unboundDeviceAction: "reject",
        requireSelfie: true,
        requireDeviceBinding: true,
        allowRotatingQr: true,
        selfieRetentionDays: 90,
      },
      sampling: { rate: 0, flaggedAlways: true, minPerSupervisorPerWeek: 0 },
    });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}, 60_000);

afterAll(async () => {
  setAuditWriter(null);
  await asTenant(async (client) => {
    await client.query(
      "DELETE FROM edge_selfie_uploads WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.id, outletId],
    );
    await client.query(
      "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND event->'payload'->>'employeeId' = ANY($2::text[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM edge_people_sync_state WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.id, outletId],
    );
    for (const table of ["attendance_logs", "shift_assignments"])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])`,
        [tenant.id, createdOutlets],
      );
    await client.query(
      "DELETE FROM attendance_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.id, outletId],
    );
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'att-edge-clock-%'",
      [tenant.id],
    );
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdRoles],
    );
    // Outlets, devices and storage objects stay: audit_logs is append-only
    // and references them (disposable DB).
  });
  await appPool.end();
  await owner.end();
  rmSync(edgeDir, { recursive: true, force: true });
});

describe("T4.1 outlet device token (EDG-03)", () => {
  it("a registered, active device at O clocks in: 201 and an outlet_device log at O", async () => {
    const staff = await newStaff("Staf Layar Satu");
    const objectId = await sealedSelfie(staff.userId);
    const response = await clockOnEdge(
      staff.client,
      clockBody({ photoUploadRef: objectId }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.method).toBe("outlet_device");
    expect(response.body.data.outletId).toBe(outletId);
    const logs = await logsOf(staff.employeeId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      method: "outlet_device",
      outlet_id: outletId,
    });
  });

  it("no device token: 403 and nothing stored", async () => {
    const staff = await newStaff("Staf Tanpa Token");
    const objectId = await sealedSelfie(staff.userId);
    const response = await clockOnEdge(
      staff.client,
      clockBody({ photoUploadRef: objectId }),
      null,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    await nothingStored(staff.employeeId);
  });

  it("a validly signed token of an unknown device: 403 and nothing stored", async () => {
    const staff = await newStaff("Staf Perangkat Asing");
    const objectId = await sealedSelfie(staff.userId);
    const unknown = signDeviceToken({
      version: 1,
      issuedAt: Math.floor(Date.now() / 1000),
      tenantId: tenant.id,
      brandId: null,
      deviceId: randomUUID(),
    });
    const response = await clockOnEdge(
      staff.client,
      clockBody({ photoUploadRef: objectId }),
      unknown,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    await nothingStored(staff.employeeId);
  });

  it("a revoked device: 403 and nothing stored", async () => {
    const staff = await newStaff("Staf Perangkat Dicabut");
    const objectId = await sealedSelfie(staff.userId);
    const revoked = await enrollDevice(outletScope(outletId), actor, {
      outletId,
      type: "pos",
      label: `Layar dicabut ${randomUUID().slice(0, 6)}`,
      stationId: null,
      idempotencyKey: randomUUID(),
    });
    await revokeDevice(outletScope(outletId), actor, {
      deviceId: revoked.device.id,
      reason: "Dicabut untuk uji",
    });
    const response = await clockOnEdge(
      staff.client,
      clockBody({ photoUploadRef: objectId }),
      revoked.token,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    await nothingStored(staff.employeeId);
  });

  it("an active device registered at another outlet: 403 and nothing stored", async () => {
    const staff = await newStaff("Staf Perangkat Outlet Lain");
    const objectId = await sealedSelfie(staff.userId);
    const response = await clockOnEdge(
      staff.client,
      clockBody({ photoUploadRef: objectId }),
      otherOutletDeviceToken,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    await nothingStored(staff.employeeId);
  });
});

describe("T4.2 employee and permission", () => {
  it("an onboarding employee may clock", async () => {
    const staff = await newStaff("Staf Onboarding", { status: "onboarding" });
    const objectId = await sealedSelfie(staff.userId);
    const response = await clockOnEdge(
      staff.client,
      clockBody({ photoUploadRef: objectId }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  it("a suspended employee: 403 and nothing stored", async () => {
    const staff = await newStaff("Staf Ditangguhkan", { status: "suspended" });
    const objectId = await sealedSelfie(staff.userId);
    const response = await clockOnEdge(
      staff.client,
      clockBody({ photoUploadRef: objectId }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    await nothingStored(staff.employeeId);
  });

  it("a role without self.attendance.clock: 403 and nothing stored", async () => {
    const staff = await newStaff("Staf Tanpa Izin", {
      permissions: ["self.profile.view"],
    });
    const objectId = await sealedSelfie(staff.userId);
    const response = await clockOnEdge(
      staff.client,
      clockBody({ photoUploadRef: objectId }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    await nothingStored(staff.employeeId);
  });
});

describe("T4.3 selfie is required", () => {
  it("no selfie: 422 selfie_missing, no log, nothing queued", async () => {
    const staff = await newStaff("Staf Tanpa Selfie");
    const response = await clockOnEdge(
      staff.client,
      clockBody({ photoUploadRef: null }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(JSON.stringify(response.body)).toContain("selfie_missing");
    await nothingStored(staff.employeeId);
  });
});

describe("T4.4 no geofence, device binding or QR on the edge", () => {
  it("outlet_device with no location and no device hash passes a policy that rejects both", async () => {
    const staff = await newStaff("Staf Tanpa Lokasi");
    const objectId = await sealedSelfie(staff.userId);
    const response = await clockOnEdge(
      staff.client,
      clockBody({
        photoUploadRef: objectId,
        location: null,
        deviceIdHash: null,
      }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const logs = await logsOf(staff.employeeId);
    expect(logs[0]!.validity).not.toBe("rejected");
    // Only the edge reason: no outside-geofence or unbound-device reason.
    expect(logs[0]!.flag_reasons).toEqual(["offline_unverified"]);
  });

  it("outlet_device far from the outlet is accepted too", async () => {
    const staff = await newStaff("Staf Jauh");
    const objectId = await sealedSelfie(staff.userId);
    const response = await clockOnEdge(
      staff.client,
      clockBody({
        photoUploadRef: objectId,
        location: { ...FAR, accuracyM: 5 },
      }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect((await logsOf(staff.employeeId))[0]!.flag_reasons).toEqual([
      "offline_unverified",
    ]);
  });

  it("selfie_geo on the edge: 400 and nothing stored", async () => {
    const staff = await newStaff("Staf Selfie Geo di Edge");
    const objectId = await sealedSelfie(staff.userId);
    const response = await clockOnEdge(
      staff.client,
      clockBody({
        method: "selfie_geo",
        photoUploadRef: objectId,
        location: { ...CENTER, accuracyM: 5 },
      }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(400);
    await nothingStored(staff.employeeId);
  });

  it("rotating_qr on the edge: 400 and nothing stored", async () => {
    const staff = await newStaff("Staf QR di Edge");
    const objectId = await sealedSelfie(staff.userId);
    const response = await clockOnEdge(
      staff.client,
      clockBody({
        method: "rotating_qr",
        photoUploadRef: objectId,
        qrToken: "q".repeat(32),
      }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(400);
    await nothingStored(staff.employeeId);
  });
});

describe("T4.5 shift and outlet", () => {
  it("a shift of another outlet is not matched; the log is at O", async () => {
    const staff = await newStaff("Staf Shift Outlet Lain");
    await seedShift(staff.employeeId, otherOutletId);
    const objectId = await sealedSelfie(staff.userId);
    const response = await clockOnEdge(
      staff.client,
      clockBody({ photoUploadRef: objectId }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const logs = await logsOf(staff.employeeId);
    expect(logs[0]!.outlet_id).toBe(outletId);
    expect(logs[0]!.shift_assignment_id).toBeNull();
  });

  it("a shift of O is matched", async () => {
    const staff = await newStaff("Staf Shift Outlet Ini");
    const shiftId = await seedShift(staff.employeeId, outletId);
    const objectId = await sealedSelfie(staff.userId);
    const response = await clockOnEdge(
      staff.client,
      clockBody({ photoUploadRef: objectId }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const logs = await logsOf(staff.employeeId);
    expect(logs[0]!.outlet_id).toBe(outletId);
    expect(logs[0]!.shift_assignment_id).toBe(shiftId);
  });
});

describe("T4.6 validity and flag reasons (Q87)", () => {
  it("fresh roster: flagged, reasons exactly offline_unverified, supervisor review pending", async () => {
    await setRosterAgeHours(0);
    const staff = await newStaff("Staf Roster Segar");
    const objectId = await sealedSelfie(staff.userId);
    const response = await clockOnEdge(
      staff.client,
      clockBody({ photoUploadRef: objectId }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.validity).toBe("flagged");
    const [log] = await logsOf(staff.employeeId);
    expect(log!.validity).toBe("flagged");
    expect(log!.flag_reasons).toEqual(["offline_unverified"]);
    expect(log!.review_status).toBe("pending");
  });

  it("roster checked 23 hours ago is still fresh", async () => {
    await setRosterAgeHours(23);
    const staff = await newStaff("Staf Roster 23 Jam");
    const objectId = await sealedSelfie(staff.userId);
    const response = await clockOnEdge(
      staff.client,
      clockBody({ photoUploadRef: objectId }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect((await logsOf(staff.employeeId))[0]!.flag_reasons).toEqual([
      "offline_unverified",
    ]);
  });

  it("roster checked 25 hours ago adds edge_roster_stale", async () => {
    await setRosterAgeHours(25);
    try {
      const staff = await newStaff("Staf Roster Basi");
      const objectId = await sealedSelfie(staff.userId);
      const response = await clockOnEdge(
        staff.client,
        clockBody({ photoUploadRef: objectId }),
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const [log] = await logsOf(staff.employeeId);
      expect(sorted(log!.flag_reasons)).toEqual(
        sorted(["offline_unverified", "edge_roster_stale"]),
      );
      expect(log!.validity).toBe("flagged");
      expect(log!.review_status).toBe("pending");
    } finally {
      await setRosterAgeHours(0);
    }
  });
});

describe("T4.7 event v2 and selfie upload row in the same clock", () => {
  it("queues one attendance.logged v2 and one pending edge_selfie_uploads row", async () => {
    await setRosterAgeHours(25);
    try {
      const staff = await newStaff("Staf Event V2");
      const shiftId = await seedShift(staff.employeeId, outletId);
      const objectId = await sealedSelfie(staff.userId);
      const response = await clockOnEdge(
        staff.client,
        clockBody({ photoUploadRef: objectId }),
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const logId = response.body.data.id as string;
      const [log] = await logsOf(staff.employeeId);

      const events = await queuedEvents(staff.employeeId);
      expect(events).toHaveLength(1);
      const payload = events[0]!.event.payload;
      expect(payload).toMatchObject({
        attendanceLogId: logId,
        employeeId: staff.employeeId,
        outletId,
        method: "outlet_device",
        validity: "flagged",
        selfieObjectId: objectId,
        edgeDeviceId: deviceId,
      });
      expect(payload.shiftAssignmentId).toBe(shiftId);
      // The edge sends the reasons the log carries.
      expect(sorted(payload.edgeFlagReasons ?? [])).toEqual(
        sorted(log!.flag_reasons),
      );
      expect(sorted(payload.edgeFlagReasons ?? [])).toEqual(
        sorted(["offline_unverified", "edge_roster_stale"]),
      );

      const rows = await uploadRows(logId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenant_id: tenant.id,
        outlet_id: outletId,
        state: "pending",
        seal_kid: KID,
        file_path: path.join(edgeDir, tenant.id, `${objectId}.lss`),
      });
    } finally {
      await setRosterAgeHours(0);
    }
  });

  it("replaying the same idempotency key adds no second log, event or upload row", async () => {
    const staff = await newStaff("Staf Ulang");
    const objectId = await sealedSelfie(staff.userId);
    const body = clockBody({ photoUploadRef: objectId });
    const first = await clockOnEdge(staff.client, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await clockOnEdge(staff.client, body);
    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await logsOf(staff.employeeId)).toHaveLength(1);
    expect(await queuedEvents(staff.employeeId)).toHaveLength(1);
    expect(await uploadRows(first.body.data.id as string)).toHaveLength(1);
  });
});

describe("T4.8 outlet_device on the cloud stays refused", () => {
  it("a cloud process answers 422 even with a valid device token, and stores nothing", async () => {
    const staff = await newStaff("Staf Cloud Layar");
    const objectId = await sealedSelfie(staff.userId);
    const response = await clockOnCloud(
      staff.client,
      clockBody({ photoUploadRef: objectId }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    await nothingStored(staff.employeeId);
  });
});

describe("T8 QR rotation is cloud only", () => {
  const secretRows = async () => {
    const { rows } = await owner.query(
      "SELECT 1 FROM attendance_qr_secrets WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.id, outletId],
    );
    return rows.length;
  };
  const input = () => ({
    outletId: outletIdSchema.parse(outletId),
    idempotencyKey: `att-edge-clock-rotate-${randomUUID()}`,
  });

  it("rotateAttendanceQrSecret with edgeMode true throws and writes nothing", async () => {
    await expect(
      rotateAttendanceQrSecret(
        outletScope(outletId),
        adminUserId,
        input(),
        new Date(),
        { edgeMode: true },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(await secretRows()).toBe(0);
  });

  it("rotateAttendanceQrSecret in a process with EDGE_MODE=true throws and writes nothing", async () => {
    await withEdgeModeEnv(async () => {
      await expect(
        rotateAttendanceQrSecret(
          outletScope(outletId),
          adminUserId,
          input(),
          new Date(),
        ),
      ).rejects.toBeInstanceOf(Error);
    });
    expect(await secretRows()).toBe(0);
  });
});
