// Edge clock with the local copy (bead legend-j6cyb, T4 + T8; design
// docs/design/hris-edge-replication.md 3.4, 6.2, 9 T4 and T8, founder Q86/Q87).
// An edge process (EDGE_MODE) accepts method `outlet_device` only through
// POST /api/hris/attendance/outlet-clock (legend-u7g9w): a registered outlet
// device (X-Device-Token), a one-time staff PIN proof (X-Pin-Proof, issued by
// POST /api/staff-pins/verify with purpose attendance_clock) and a sealed
// selfie uploaded under that proof. No session. Runs the real
// Express app, Better Auth, RBAC and PostgreSQL against the seeded Cafe Legend
// tenant. Written from the design, not from the implementation.
//
// Assumptions where the design is silent:
// - "Edge mode" is the process setting EDGE_MODE=true (withEdgeModeEnv), set
//   only around the clock request. The cloud and the edge replica share this
//   test database, so the devices table is also "the device registry replica".
// - The outlet device is a registered device of type `pos` (design names no
//   type). Its signed token travels in X-Device-Token (DEVICE_TOKEN_HEADER).
// - The outlet-clock body is strict { type, occurredAt, photoUploadRef,
//   idempotencyKey }: no location, device hash, QR or user id.
// - The log outlet O is the outlet of the registered device; the employee's
//   home outlet is also O. A device of another outlet gives 403 (EDG-03 "at
//   outlet O").
// - Employee not onboarding/active (here: suspended) and a role without
//   self.attendance.clock both answer 403 ATTENDANCE_NOT_ALLOWED. The proof is
//   issued while the staff member is eligible, then the eligibility is removed
//   (issuing refuses an ineligible user up front).
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
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
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
import {
  enrollDevice,
  revokeDevice,
  setDeviceTrainingMode,
} from "../services/device.service.ts";
import { createDeviceOutletResolver } from "../services/device-outlet-resolver.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { uploadEdgeSelfie } from "../services/edge-selfie.service.ts";
import { rotateAttendanceQrSecret } from "../services/hris-attendance.service.ts";
import { PIN_PROOF_HEADER } from "../services/staff-pin-proof.service.ts";
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
  await setStaffPin(
    tenantContext,
    userId,
    { outletId, userId },
    { pin: STAFF_PIN },
  );
  return { client, userId, employeeId };
}

const STAFF_PIN = "582914";

/** The one-time proof of a PIN just typed on a device (POST /api/staff-pins/verify). */
async function issueProof(userId: string, token: string = deviceToken) {
  const response = await agent(app)
    .post("/api/staff-pins/verify")
    .set(DEVICE_TOKEN_HEADER, token)
    .send({ userId, pin: STAFF_PIN, purpose: "attendance_clock" });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const proofToken = response.body.data.proof.token as string;
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM staff_pin_proofs WHERE tenant_id = $1 AND token_hash = $2",
    [tenant.id, createHash("sha256").update(proofToken).digest()],
  );
  return { token: proofToken, id: rows[0]!.id };
}

/** An edge-sealed selfie object, made by the real edge upload service. */
async function sealedSelfie(userId: string, pinProofId: string) {
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
      pinProofId,
      scanner: new NoopMalwareScanner(),
      dir: edgeDir,
      maxBytes: 1024 * 1024 * 1024,
    } as never,
  );
  return stored.id;
}

/** Body of POST /api/hris/attendance/outlet-clock. */
const clockBody = (overrides: Record<string, unknown> = {}) => ({
  type: "in",
  occurredAt: new Date().toISOString(),
  photoUploadRef: null,
  idempotencyKey: `att-edge-clock-${randomUUID()}`,
  ...overrides,
});

/** Body of the session route POST /api/hris/attendance/clock. */
const sessionClockBody = (overrides: Record<string, unknown> = {}) => ({
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

/** The outlet clock as an edge process answers it (EDGE_MODE on): no session. */
const outletClockOnEdge = (
  body: unknown,
  proofToken: string | null,
  token: string | null = deviceToken,
) =>
  withEdgeModeEnv(async () => {
    let req = agent(app).post("/api/hris/attendance/outlet-clock");
    if (token !== null) req = req.set(DEVICE_TOKEN_HEADER, token);
    if (proofToken !== null) req = req.set(PIN_PROOF_HEADER, proofToken);
    return await req.send(body as object);
  });

/** The same request on the cloud (EDGE_MODE off). */
const outletClockOnCloud = (body: unknown, proofToken: string) =>
  agent(app)
    .post("/api/hris/attendance/outlet-clock")
    .set(DEVICE_TOKEN_HEADER, deviceToken)
    .set(PIN_PROOF_HEADER, proofToken)
    .send(body as object);

/** The session clock route as an edge process answers it. */
const sessionClockOnEdge = (
  client: Client,
  body: unknown,
  token: string | null = deviceToken,
) =>
  withEdgeModeEnv(async () => {
    let req = client.post("/api/hris/attendance/clock").set(originHeader);
    if (token !== null) req = req.set(DEVICE_TOKEN_HEADER, token);
    return await req.send(body as object);
  });

/** The session clock route on the cloud (EDGE_MODE off). */
const sessionClockOnCloud = (client: Client, body: unknown) =>
  client
    .post("/api/hris/attendance/clock")
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken)
    .send(body as object);

/**
 * An eligible staff member who typed their PIN (proof issued on `deviceToken`
 * unless told otherwise) and uploaded a selfie under that proof.
 */
async function readyToClock(
  name: string,
  options: { status?: string; permissions?: string[]; proofVia?: string } = {},
) {
  const { proofVia, ...staffOptions } = options;
  const staff = await newStaff(name, staffOptions);
  const proof = await issueProof(staff.userId, proofVia);
  const objectId = await sealedSelfie(staff.userId, proof.id);
  return { staff, proof, objectId };
}

const proofRow = async (proofId: string) =>
  (
    await owner.query<{ consumed_at: Date | null }>(
      "SELECT consumed_at FROM staff_pin_proofs WHERE id = $1",
      [proofId],
    )
  ).rows[0]!;

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
  setDeviceOutletResolver(createDeviceOutletResolver());
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
  setDeviceOutletResolver(null);
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
    await client.query(
      "DELETE FROM staff_pin_proofs WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await client.query(
      "DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
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
    const { staff, proof, objectId } = await readyToClock("Staf Layar Satu");
    const response = await outletClockOnEdge(
      clockBody({ photoUploadRef: objectId }),
      proof.token,
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
    expect((await proofRow(proof.id)).consumed_at).not.toBeNull();
  });

  it("no X-Pin-Proof header: 401 PIN_PROOF_INVALID and nothing stored", async () => {
    const { staff, objectId } = await readyToClock("Staf Tanpa Bukti");
    const response = await outletClockOnEdge(
      clockBody({ photoUploadRef: objectId }),
      null,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(response.body.error.code).toBe("PIN_PROOF_INVALID");
    await nothingStored(staff.employeeId);
  });

  it("no device token: 404 TENANT_NOT_FOUND and nothing stored", async () => {
    const { staff, proof, objectId } = await readyToClock("Staf Tanpa Token");
    const response = await outletClockOnEdge(
      clockBody({ photoUploadRef: objectId }),
      proof.token,
      null,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(response.body.error.code).toBe("TENANT_NOT_FOUND");
    await nothingStored(staff.employeeId);
  });

  it("a validly signed token of an unknown device: 404 TENANT_NOT_FOUND and nothing stored", async () => {
    const { staff, proof, objectId } = await readyToClock(
      "Staf Perangkat Asing",
    );
    const unknown = signDeviceToken({
      version: 1,
      issuedAt: Math.floor(Date.now() / 1000),
      tenantId: tenant.id,
      brandId: null,
      deviceId: randomUUID(),
    });
    const response = await outletClockOnEdge(
      clockBody({ photoUploadRef: objectId }),
      proof.token,
      unknown,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(response.body.error.code).toBe("TENANT_NOT_FOUND");
    await nothingStored(staff.employeeId);
  });

  it("a revoked device: 404 TENANT_NOT_FOUND and nothing stored", async () => {
    const { staff, proof, objectId } = await readyToClock(
      "Staf Perangkat Dicabut",
    );
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
    const response = await outletClockOnEdge(
      clockBody({ photoUploadRef: objectId }),
      proof.token,
      revoked.token,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(response.body.error.code).toBe("TENANT_NOT_FOUND");
    await nothingStored(staff.employeeId);
  });

  it("an active device registered at another outlet: 403 and nothing stored", async () => {
    const { staff, proof, objectId } = await readyToClock(
      "Staf Perangkat Outlet Lain",
    );
    const response = await outletClockOnEdge(
      clockBody({ photoUploadRef: objectId }),
      proof.token,
      otherOutletDeviceToken,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    await nothingStored(staff.employeeId);
  });
});

describe("T4.1b only a pos device may clock", () => {
  const enroll = async (
    type: "pos" | "display" | "kds" | "printer" | "waiter_phone",
    training: boolean,
  ) => {
    const enrolled = await enrollDevice(outletScope(outletId), actor, {
      outletId,
      type,
      label: `Layar ${type} ${randomUUID().slice(0, 6)}`,
      stationId: null,
      idempotencyKey: randomUUID(),
    });
    if (training)
      await setDeviceTrainingMode(outletScope(outletId), actor, {
        deviceId: enrolled.device.id,
        trainingMode: true,
      });
    return enrolled;
  };

  /** A proof row put straight into the table, for a device that cannot type a PIN. */
  const seedProofFor = async (deviceIdOf: string, userId: string) => {
    const token = `pp_${randomBytes(32).toString("base64url")}`;
    const id = randomUUID();
    await owner.query(
      `INSERT INTO staff_pin_proofs
         (id, tenant_id, outlet_id, device_id, user_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'attendance_clock', $6, now() + interval '2 minutes')`,
      [
        id,
        tenant.id,
        outletId,
        deviceIdOf,
        userId,
        createHash("sha256").update(token).digest(),
      ],
    );
    return { id, token };
  };

  it("a display device cannot verify a PIN (403), so no proof and no log", async () => {
    const enrolled = await enroll("display", false);
    const staff = await newStaff("Staf Perangkat display");
    const response = await agent(app)
      .post("/api/staff-pins/verify")
      .set(DEVICE_TOKEN_HEADER, enrolled.token)
      .send({
        userId: staff.userId,
        pin: STAFF_PIN,
        purpose: "attendance_clock",
      });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    const { rows } = await owner.query(
      "SELECT 1 FROM staff_pin_proofs WHERE tenant_id = $1 AND user_id = $2",
      [tenant.id, staff.userId],
    );
    expect(rows).toHaveLength(0);
    await nothingStored(staff.employeeId);
  });

  it.each(["kds", "waiter_phone"] as const)(
    "a %s device: 403 and nothing stored",
    async (type) => {
      const enrolled = await enroll(type, false);
      const { staff, proof, objectId } = await readyToClock(
        `Staf Perangkat ${type}`,
        { proofVia: enrolled.token },
      );
      const response = await outletClockOnEdge(
        clockBody({ photoUploadRef: objectId }),
        proof.token,
        enrolled.token,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      await nothingStored(staff.employeeId);
    },
  );

  it("a printer device (proof inserted directly): 403 and nothing stored", async () => {
    const enrolled = await enroll("printer", false);
    const staff = await newStaff("Staf Perangkat printer");
    const proof = await seedProofFor(enrolled.device.id, staff.userId);
    const objectId = await sealedSelfie(staff.userId, proof.id);
    const response = await outletClockOnEdge(
      clockBody({ photoUploadRef: objectId }),
      proof.token,
      enrolled.token,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    await nothingStored(staff.employeeId);
  });

  it("a pos device in training mode: 403 and nothing stored", async () => {
    const enrolled = await enroll("pos", true);
    const { staff, proof, objectId } = await readyToClock(
      "Staf Perangkat pos latihan",
      { proofVia: enrolled.token },
    );
    const response = await outletClockOnEdge(
      clockBody({ photoUploadRef: objectId }),
      proof.token,
      enrolled.token,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    await nothingStored(staff.employeeId);
  });
});

describe("T4.2 employee and permission", () => {
  it("an onboarding employee may clock", async () => {
    const { proof, objectId } = await readyToClock("Staf Onboarding", {
      status: "onboarding",
    });
    const response = await outletClockOnEdge(
      clockBody({ photoUploadRef: objectId }),
      proof.token,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  it("an employee suspended after the PIN: 403 ATTENDANCE_NOT_ALLOWED and nothing stored", async () => {
    const { staff, proof, objectId } = await readyToClock("Staf Ditangguhkan");
    await owner.query(
      "UPDATE employees SET status = 'suspended' WHERE tenant_id = $1 AND id = $2",
      [tenant.id, staff.employeeId],
    );
    const response = await outletClockOnEdge(
      clockBody({ photoUploadRef: objectId }),
      proof.token,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error.code).toBe("ATTENDANCE_NOT_ALLOWED");
    await nothingStored(staff.employeeId);
    expect((await proofRow(proof.id)).consumed_at).toBeNull();
  });

  it("a role that lost self.attendance.clock after the PIN: 403 ATTENDANCE_NOT_ALLOWED and nothing stored", async () => {
    const { staff, proof, objectId } = await readyToClock("Staf Tanpa Izin");
    await asTenant((client) =>
      client.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
        [tenant.id, staff.userId],
      ),
    );
    const response = await outletClockOnEdge(
      clockBody({ photoUploadRef: objectId }),
      proof.token,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error.code).toBe("ATTENDANCE_NOT_ALLOWED");
    await nothingStored(staff.employeeId);
  });
});

describe("T4.3 selfie is required", () => {
  it("no selfie: 422 selfie_missing, no log, nothing queued, proof not consumed", async () => {
    const { staff, proof } = await readyToClock("Staf Tanpa Selfie");
    const response = await outletClockOnEdge(
      clockBody({ photoUploadRef: null }),
      proof.token,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    // Same body as the cloud rejection (hris-attendance.routes.ts).
    expect(response.body.error.code).toBe("ATTENDANCE_REJECTED");
    expect(response.body.error.details).toEqual([
      { field: "reasons", message: "selfie_missing" },
    ]);
    await nothingStored(staff.employeeId);
    expect((await proofRow(proof.id)).consumed_at).toBeNull();
  });
});

describe("T4.4 no geofence, device binding or QR on the edge", () => {
  it("outlet_device passes a policy that rejects an outside-geofence and an unbound-device clock", async () => {
    const { staff, proof, objectId } = await readyToClock("Staf Tanpa Lokasi");
    const response = await outletClockOnEdge(
      clockBody({ photoUploadRef: objectId }),
      proof.token,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const logs = await logsOf(staff.employeeId);
    expect(logs[0]!.validity).not.toBe("rejected");
    // Only the edge reason: no outside-geofence or unbound-device reason.
    expect(logs[0]!.flag_reasons).toEqual(["offline_unverified"]);
  });

  it("the outlet-clock body takes no user id, method or location", async () => {
    const { staff, proof, objectId } = await readyToClock("Staf Badan Ketat");
    for (const extra of [
      { userId: randomUUID() },
      { method: "outlet_device" },
      { location: { latitude: -6.2, longitude: 106.8, accuracyM: 5 } },
    ]) {
      const response = await outletClockOnEdge(
        clockBody({ photoUploadRef: objectId, ...extra }),
        proof.token,
      );
      expect(
        response.status,
        JSON.stringify(response.body),
      ).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    await nothingStored(staff.employeeId);
  });

  it("outlet_device on the session route: 400 ATTENDANCE_METHOD_USE_OUTLET_CLOCK and nothing stored", async () => {
    const staff = await newStaff("Staf Rute Sesi Layar");
    const response = await sessionClockOnEdge(staff.client, sessionClockBody());
    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.error.code).toBe("ATTENDANCE_METHOD_USE_OUTLET_CLOCK");
    await nothingStored(staff.employeeId);
  });

  it("selfie_geo on the edge: 400 and nothing stored", async () => {
    const staff = await newStaff("Staf Selfie Geo di Edge");
    const response = await sessionClockOnEdge(
      staff.client,
      sessionClockBody({
        method: "selfie_geo",
        location: { ...CENTER, accuracyM: 5 },
      }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.error.code).toBe("ATTENDANCE_METHOD_NOT_ON_EDGE");
    await nothingStored(staff.employeeId);
  });

  it("rotating_qr on the edge: 400 and nothing stored", async () => {
    const staff = await newStaff("Staf QR di Edge");
    const response = await sessionClockOnEdge(
      staff.client,
      sessionClockBody({
        method: "rotating_qr",
        qrToken: "q".repeat(32),
      }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.error.code).toBe("ATTENDANCE_METHOD_NOT_ON_EDGE");
    await nothingStored(staff.employeeId);
  });

  it("selfie_geo without any device token on the edge: 400 too", async () => {
    const staff = await newStaff("Staf Selfie Geo Tanpa Token");
    const response = await sessionClockOnEdge(
      staff.client,
      sessionClockBody({
        method: "selfie_geo",
        location: { ...CENTER, accuracyM: 5 },
      }),
      null,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.error.code).toBe("ATTENDANCE_METHOD_NOT_ON_EDGE");
    await nothingStored(staff.employeeId);
  });
});

describe("T4.5 shift and outlet", () => {
  it("a shift of another outlet is not matched; the log is at O", async () => {
    const { staff, proof, objectId } = await readyToClock(
      "Staf Shift Outlet Lain",
    );
    await seedShift(staff.employeeId, otherOutletId);
    const response = await outletClockOnEdge(
      clockBody({ photoUploadRef: objectId }),
      proof.token,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const logs = await logsOf(staff.employeeId);
    expect(logs[0]!.outlet_id).toBe(outletId);
    expect(logs[0]!.shift_assignment_id).toBeNull();
  });

  it("a shift of O is matched", async () => {
    const { staff, proof, objectId } = await readyToClock(
      "Staf Shift Outlet Ini",
    );
    const shiftId = await seedShift(staff.employeeId, outletId);
    const response = await outletClockOnEdge(
      clockBody({ photoUploadRef: objectId }),
      proof.token,
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
    const { staff, proof, objectId } = await readyToClock("Staf Roster Segar");
    const response = await outletClockOnEdge(
      clockBody({ photoUploadRef: objectId }),
      proof.token,
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
    const { staff, proof, objectId } = await readyToClock("Staf Roster 23 Jam");
    const response = await outletClockOnEdge(
      clockBody({ photoUploadRef: objectId }),
      proof.token,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect((await logsOf(staff.employeeId))[0]!.flag_reasons).toEqual([
      "offline_unverified",
    ]);
  });

  it("roster checked 25 hours ago adds edge_roster_stale", async () => {
    await setRosterAgeHours(25);
    try {
      const { staff, proof, objectId } = await readyToClock("Staf Roster Basi");
      const response = await outletClockOnEdge(
        clockBody({ photoUploadRef: objectId }),
        proof.token,
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
      const { staff, proof, objectId } = await readyToClock("Staf Event V2");
      const shiftId = await seedShift(staff.employeeId, outletId);
      const response = await outletClockOnEdge(
        clockBody({ photoUploadRef: objectId }),
        proof.token,
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

  it("replaying the same idempotency key (proof already used) answers 200 with the old log and adds no second log, event or upload row", async () => {
    const { staff, proof, objectId } = await readyToClock("Staf Ulang");
    const body = clockBody({ photoUploadRef: objectId });
    const first = await outletClockOnEdge(body, proof.token);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await outletClockOnEdge(body, proof.token);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await logsOf(staff.employeeId)).toHaveLength(1);
    expect(await queuedEvents(staff.employeeId)).toHaveLength(1);
    expect(await uploadRows(first.body.data.id as string)).toHaveLength(1);
  });

  it("a used proof with a new idempotency key: 409 PIN_PROOF_USED", async () => {
    const { staff, proof, objectId } = await readyToClock(
      "Staf Bukti Terpakai",
    );
    const first = await outletClockOnEdge(
      clockBody({ photoUploadRef: objectId }),
      proof.token,
    );
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await outletClockOnEdge(
      clockBody({ type: "out", photoUploadRef: objectId }),
      proof.token,
    );
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(second.body.error.code).toBe("PIN_PROOF_USED");
    expect(await logsOf(staff.employeeId)).toHaveLength(1);
  });
});

describe("T4.8 outlet_device on the cloud stays refused", () => {
  it("a cloud process answers 400 on outlet-clock even with a valid device token and proof, and stores nothing", async () => {
    const { staff, proof, objectId } = await readyToClock("Staf Cloud Layar");
    const response = await outletClockOnCloud(
      clockBody({ photoUploadRef: objectId }),
      proof.token,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(400);
    await nothingStored(staff.employeeId);
  });

  it("outlet_device on the session route of the cloud: 400 ATTENDANCE_METHOD_USE_OUTLET_CLOCK", async () => {
    const staff = await newStaff("Staf Cloud Rute Sesi");
    const response = await sessionClockOnCloud(
      staff.client,
      sessionClockBody(),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.error.code).toBe("ATTENDANCE_METHOD_USE_OUTLET_CLOCK");
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
