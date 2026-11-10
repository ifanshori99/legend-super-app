// Edge selfie hook on the clock path (design docs/design/hris-edge-replication.md
// section 5 and 9 T5, brief legend-we0yc): when a clock-in carries a selfie that
// the edge sealed (object key "edge-sealed:..."), clockAttendance queues exactly
// one pending edge_selfie_uploads row for the new attendance log, in the same
// transaction. A replay of the same idempotency key adds no second row. A normal
// S3 selfie queues nothing. Runs the real Express app, Better Auth, RBAC and
// PostgreSQL against the seeded Cafe Legend tenant.
//
// Assumptions where the brief is silent:
// - The clock route is driven over HTTP (POST /api/hris/attendance/clock), the
//   same way hris-attendance-storage-wire.test.ts does; the edge object is made
//   with the real uploadEdgeSelfie, into a tmp dir named by EDGE_SELFIE_DIR.
// - The queue row's file_path is <dir>/<tenantId>/<objectId>.lss.
// - A clock-in without a selfie queues nothing either.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), "edge-selfie-clock-"));
  process.env.EDGE_SELFIE_DIR = dir;
  return dir;
});

import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { outletIdSchema, ulidToUuid } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import * as schema from "../db/schema";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { uploadEdgeSelfie } from "../services/edge-selfie.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const db = drizzle(appPool, { schema });
const context = establishScopedTenantContext(
  establishTenantContext({
    tenantId: tenant.id,
    brandId: null,
    source: "session",
  }),
  { kind: "tenant" },
);

const KID = "clock-test-kid-1";
const { publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
let outletId: string;

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
        `Edge selfie clock ${roleId.slice(0, 8)}`,
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

// Outlet centre; 0.01 deg of latitude is ~1.1 km, outside the 100 m geofence,
// so the clock-in is flagged (not rejected) under the "flag" policy below.
const CENTER = { latitude: -6.2, longitude: 106.8 };
const FAR = { ...CENTER, latitude: CENTER.latitude + 0.01 };

async function seedOutlet() {
  const id = randomUUID();
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status, geofence)
       VALUES ($1, $2, $3, $4, $5, 'Outlet selfie edge', 'Jl. Absensi', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $6)`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `SE-${id.slice(0, 8)}`.toUpperCase(),
        JSON.stringify({ ...CENTER, radiusMeters: 100 }),
      ],
    );
  });
  return id;
}

/** A signed-in employee of the outlet who may clock. */
async function newStaff(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  await grantRole(userId, ["self.profile.view", "self.attendance.clock"], {
    type: "outlet",
    outletIds: [outletId],
  });
  const employeeId = randomUUID();
  createdEmployees.push(employeeId);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Selfie Edge', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        tenant.id,
        userId,
        `SE-${employeeId.slice(0, 8).toUpperCase()}`,
        outletId,
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

/** A normal (S3-style) selfie object: key without the edge-sealed prefix. */
async function s3Selfie(userId: string) {
  const objectId = randomUUID();
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
          thumbnail_key, owner_user_id)
       VALUES ($1, $2, $3, 'selfie', $4, 'image/webp', 2048, $5, $6)`,
      [
        tenant.id,
        outletId,
        objectId,
        `selfie/${objectId}/original.webp`,
        `selfie/${objectId}/thumb.webp`,
        userId,
      ],
    );
  });
  return objectId;
}

const post = (client: Client, body: unknown) =>
  client
    .post("/api/hris/attendance/clock")
    .set(originHeader)
    .send(body as object);

const clockBody = (photoUploadRef: string | null) => ({
  type: "in",
  method: "selfie_geo",
  occurredAt: new Date().toISOString(),
  location: { ...FAR, accuracyM: 5 },
  deviceIdHash: null,
  photoUploadRef,
  qrToken: null,
  idempotencyKey: `att-edge-selfie-${randomUUID()}`,
});

type QueueRow = {
  tenant_id: string;
  outlet_id: string;
  state: string;
  seal_kid: string;
  file_path: string;
  attendance_log_id: string;
};

/** Upload rows for one API log id (the API id is a ULID; the column is a uuid). */
async function queueRows(logId: string): Promise<QueueRow[]> {
  const { rows } = await owner.query(
    `SELECT tenant_id, outlet_id, state, seal_kid, file_path, attendance_log_id
       FROM edge_selfie_uploads WHERE tenant_id = $1 AND attendance_log_id = $2`,
    [tenant.id, ulidToUuid(logId)],
  );
  return rows as QueueRow[];
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  outletId = await seedOutlet();
  await owner.query(
    `INSERT INTO edge_people_sync_state (tenant_id, outlet_id, selfie_seal_kid, selfie_seal_public_key)
     VALUES ($1, $2, $3, $4)`,
    [tenant.id, outletId, KID, publicKey],
  );
  const policyAdmin = agent(app);
  await signUp(policyAdmin, "Admin Kebijakan Selfie Edge");
  const session = await policyAdmin.get("/api/auth/get-session");
  createdUsers.push(session.body.user.id as string);
  await verifySessionMfa(session.body.user.email as string);
  await grantRole(session.body.user.id as string, ["hr.attendance.manage"], {
    type: "tenant",
  });
  const response = await policyAdmin
    .put("/api/hris/attendance/policy")
    .set(originHeader)
    .send({
      outletId,
      policy: {
        geofenceRadiusM: 100,
        outsideGeofenceAction: "flag",
        unboundDeviceAction: "reject",
        requireSelfie: false,
        requireDeviceBinding: false,
        allowRotatingQr: true,
        selfieRetentionDays: 90,
      },
      sampling: { rate: 0, flaggedAlways: true, minPerSupervisorPerWeek: 0 },
    });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
});

afterAll(async () => {
  await asTenant(async (client) => {
    await client.query(
      "DELETE FROM edge_selfie_uploads WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.id, outletId],
    );
    await client.query(
      "DELETE FROM edge_people_sync_state WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.id, outletId],
    );
    for (const table of ["attendance_logs", "attendance_policies"])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND outlet_id = $2`,
        [tenant.id, outletId],
      );
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'att-edge-selfie-%'",
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
    // Outlet and storage objects stay: audit_logs is append-only and
    // references them (disposable DB).
  });
  await appPool.end();
  await owner.end();
  rmSync(edgeDir, { recursive: true, force: true });
});

describe("edge selfie queue on clock-in", () => {
  it("queues one pending upload for a clock-in that carries an edge-sealed selfie", async () => {
    const staff = await newStaff("Staf Selfie Edge Satu");
    const objectId = await sealedSelfie(staff.userId);
    const response = await post(staff.client, clockBody(objectId));
    expect(response.status, JSON.stringify(response.body)).toBe(201);

    const rows = await queueRows(response.body.data.id as string);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: tenant.id,
      outlet_id: outletId,
      state: "pending",
      seal_kid: KID,
      file_path: path.join(edgeDir, tenant.id, `${objectId}.lss`),
    });
  });

  it("adds no second row when the same idempotency key is replayed", async () => {
    const staff = await newStaff("Staf Selfie Edge Dua");
    const objectId = await sealedSelfie(staff.userId);
    const body = clockBody(objectId);
    const first = await post(staff.client, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await post(staff.client, body);
    expect(replay.status, JSON.stringify(replay.body)).toBeGreaterThanOrEqual(
      200,
    );
    expect(replay.status).toBeLessThan(300);
    expect(replay.body.data.id).toBe(first.body.data.id);

    expect(await queueRows(first.body.data.id as string)).toHaveLength(1);
  });

  it("queues nothing for a normal S3 selfie", async () => {
    const staff = await newStaff("Staf Selfie S3");
    const objectId = await s3Selfie(staff.userId);
    const response = await post(staff.client, clockBody(objectId));
    expect(response.status, JSON.stringify(response.body)).toBe(201);

    expect(await queueRows(response.body.data.id as string)).toHaveLength(0);
  });

  it("queues nothing for a clock-in without a selfie", async () => {
    const staff = await newStaff("Staf Tanpa Selfie");
    const response = await post(staff.client, clockBody(null));
    expect(response.status, JSON.stringify(response.body)).toBe(201);

    expect(await queueRows(response.body.data.id as string)).toHaveLength(0);
  });
});
