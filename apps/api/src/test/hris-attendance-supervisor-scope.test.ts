// Finding 501-1 (P1, brief docs/briefs/hris-leave-guard.md section 502 item B): the
// manual-correction queue and the selfie review (review queue, review decision,
// signed photo URLs) are limited per outlet today. A supervisor must only see
// and decide for their OWN subordinates (employees.manager_id chain); HR
// (hr.attendance.manage held tenant-wide) keeps the unchanged tenant view.
// Expected behaviour comes from the brief and the shared endpoint contracts
// (packages/shared/src/hris/endpoints.ts), not from service code. Everything
// runs through HTTP against the real Express app, Better Auth, RBAC and
// PostgreSQL.
//
// Assumptions (the brief leaves these open):
//  - A "supervisor" is a signed-in user who holds hr.attendance.manage and
//    hr.attendance_correction.approve at OUTLET scope and whose employee record
//    (employees.user_id) is the manager_id of the subordinates. "HR" is the
//    same permission pair held at TENANT scope.
//  - "Own subordinates" means rows of employees whose manager_id is the
//    supervisor's employee id. Indirect reports (a supervisor's supervisor
//    chain beyond one level) and an outlet-scoped holder without any employee
//    record are NOT asserted: the brief does not say.
//  - A refused read of another supervisor's employee answers 200 with no rows,
//    or 403/404; the test only requires that no row, id or photo URL of that
//    employee leaks. A refused decision answers 403 or 404 and changes nothing.
//  - A decision only settles (status leaves 'pending') when the correction has an
//    approval chain. Corrections seeded straight into the table have none, so the
//    decision test creates its correction through the API (POST
//    /attendance/corrections, as the subordinate) under an
//    'attendance_correction' approval policy whose approver role is the
//    outlet_manager template, which the supervisor also holds at outlet scope.
//  - GET /attendance/logs?employeeId=<own subordinate> returns that
//    subordinate's logs for the supervisor (same admin scope as the queue).
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidToUlid } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { ObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const KEY_PREFIX = "att-sup-scope-";
const signedUrlFor = (objectId: string) =>
  `https://signed.example.test/selfie/${objectId}?sig=fake`;

// The signer is the only part of the runtime the attendance routes use.
const storageRuntime: StorageRuntime = {
  storage: {} as ObjectStorage,
  scanner: new NoopMalwareScanner(),
  fileSigner: async (_context, objectId) => signedUrlFor(objectId),
  hrisDocumentSigner: async () => null,
};
const app = createApp({ storageRuntime });

type Client = ReturnType<typeof agent>;
type JsonRow = Record<string, unknown>;

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdLogs: string[] = [];
const createdCorrections: string[] = [];
const createdObjects: string[] = [];
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
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function signedInClient(name: string) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  await verifySessionMfa(email);
  return { client, userId };
}

const SUPERVISOR_PERMISSIONS = [
  "hr.attendance.manage",
  "hr.attendance_correction.approve",
];
const STAFF_PERMISSIONS = ["self.profile.view", "self.attendance.clock"];

async function grantRole(
  userId: string,
  scope: { type: "tenant" } | { type: "outlet"; outletIds: string[] },
  permissions: string[] = SUPERVISOR_PERMISSIONS,
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
        `Supervisor scope ${roleId.slice(0, 8)}`,
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

async function templateRoleId(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenant.id, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function assignTemplateRole(
  userId: string,
  roleId: string,
  scopeOutletId: string,
) {
  await asTenant((client) =>
    client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenant.id, userId, roleId, scopeOutletId],
    ),
  );
}

const CENTER = { latitude: -6.2, longitude: 106.8 };

async function seedOutlet() {
  const id = randomUUID();
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status, geofence)
       VALUES ($1, $2, $3, $4, $5, 'Outlet scope supervisor', 'Jl. Absensi', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $6)`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `SS-${id.slice(0, 8)}`.toUpperCase(),
        JSON.stringify({ ...CENTER, radiusMeters: 100 }),
      ],
    );
  });
  return id;
}

async function seedEmployee(options: {
  userId: string | null;
  managerId: string | null;
  name: string;
}): Promise<string> {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status, manager_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active', $7)`,
      [
        id,
        tenant.id,
        options.userId,
        `SS-${id.slice(0, 8).toUpperCase()}`,
        options.name,
        outletId,
        options.managerId,
      ],
    ),
  );
  return id;
}

/** A flagged clock-in awaiting review whose selfie is owned by the log. */
async function seedFlaggedLog(employeeId: string) {
  const logId = randomUUID();
  const objectId = randomUUID();
  createdLogs.push(logId);
  createdObjects.push(objectId);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
          source_kind, source_id)
       VALUES ($1, $2, $3, 'selfie', $4, 'image/webp', 2048, 'attendance', $5)`,
      [
        tenant.id,
        outletId,
        objectId,
        `selfie/${objectId}/original.webp`,
        logId,
      ],
    );
    await client.query(
      `INSERT INTO attendance_logs
         (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
          geo_distance_m, validity, business_date, client_event_id, photo_key)
       VALUES ($1, $2, $3, $4, 'in', 'selfie_geo', now(), now(), 500, 'flagged',
               (now() AT TIME ZONE 'UTC')::date, $5, $6)`,
      [
        logId,
        tenant.id,
        outletId,
        employeeId,
        `${KEY_PREFIX}${randomUUID()}`,
        objectId,
      ],
    );
  });
  return { logId, objectId, apiId: uuidToUlid(logId) };
}

async function seedCorrection(employeeId: string) {
  const id = randomUUID();
  createdCorrections.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO attendance_corrections
         (id, tenant_id, outlet_id, employee_id, requested_type, requested_occurred_at, reason,
          requested_by, idempotency_key)
       VALUES ($1, $2, $3, $4, 'out', now(), 'Lupa absen pulang', $5, $6)`,
      [id, tenant.id, outletId, employeeId, randomUUID(), `${KEY_PREFIX}${id}`],
    ),
  );
  // Corrections use UUID ids on the wire (attendanceCorrectionIdSchema), unlike
  // attendance logs, which are exposed as ULIDs.
  return { id, apiId: id };
}

/**
 * A correction with a real approval chain: the subordinate (own user and
 * employee record under `managerId`) files it through the API.
 */
async function requestCorrectionViaApi(managerId: string) {
  const staff = await signedInClient("Bawahan Pemohon Scope");
  await grantRole(
    staff.userId,
    { type: "outlet", outletIds: [outletId] },
    STAFF_PERMISSIONS,
  );
  const employeeId = await seedEmployee({
    userId: staff.userId,
    managerId,
    name: "Bawahan Pemohon Scope",
  });
  const occurredAt = new Date();
  occurredAt.setUTCDate(occurredAt.getUTCDate() - 3);
  occurredAt.setUTCHours(12, 0, 0, 0);
  const response = await post(
    staff.client,
    "/api/hris/attendance/corrections",
    {
      outletId,
      attendanceLogId: null,
      requestedType: "in",
      requestedOccurredAt: occurredAt.toISOString(),
      reason: "Lupa absen masuk, mesin tidak terbaca",
      idempotencyKey: `${KEY_PREFIX}${randomUUID()}`,
    },
  );
  expect([200, 201], JSON.stringify(response.body)).toContain(response.status);
  const id = response.body.data.id as string;
  createdCorrections.push(id);
  return { id, apiId: id, employeeId };
}

const post = (client: Client, path: string, body: unknown) =>
  client
    .post(path)
    .set(originHeader)
    .send(body as object);

/** Every row of a list endpoint; follows cursors so a late row cannot hide. */
async function collectAll(client: Client, path: string) {
  const rows: JsonRow[] = [];
  const bodies: unknown[] = [];
  let status = 0;
  let cursor: string | null = null;
  for (let page = 0; page < 30; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response: Awaited<ReturnType<Client["get"]>> = await client.get(
      `${path}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    status = response.status;
    bodies.push(response.body);
    if (status !== 200) break;
    rows.push(...(response.body.data as JsonRow[]));
    cursor = (response.body?.meta?.nextCursor as string | null) ?? null;
    if (!cursor) break;
  }
  return { status, rows, text: JSON.stringify(bodies) };
}

const queueIds = (rows: JsonRow[]) =>
  rows.map((row) => String((row.log as JsonRow).id).toUpperCase());
const rowIds = (rows: JsonRow[]) =>
  rows.map((row) => String(row.id).toUpperCase());
const correctionIds = (rows: JsonRow[]) =>
  rows.map((row) => String(row.id).toLowerCase());

let hr: Awaited<ReturnType<typeof signedInClient>>;
let supA: Awaited<ReturnType<typeof signedInClient>>;
let supB: Awaited<ReturnType<typeof signedInClient>>;
let supC: Awaited<ReturnType<typeof signedInClient>>;
let subA: string;
let subB: string;
let logA: Awaited<ReturnType<typeof seedFlaggedLog>>;
let logB: Awaited<ReturnType<typeof seedFlaggedLog>>;
let corrA: Awaited<ReturnType<typeof seedCorrection>>;
let corrB: Awaited<ReturnType<typeof seedCorrection>>;
let empAId: string;
let insertedApprovalPolicy = false;

beforeAll(async () => {
  outletId = await seedOutlet();
  // The approval flow needs a policy for the action; keep an existing one.
  const managerRole = await templateRoleId("outlet_manager");
  const inserted = await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     SELECT $1, 'attendance_correction', NULL, $2, 1
      WHERE NOT EXISTS (SELECT 1 FROM approval_policies
                         WHERE tenant_id = $1 AND action_type = 'attendance_correction')`,
    [tenant.id, managerRole],
  );
  insertedApprovalPolicy = (inserted.rowCount ?? 0) > 0;
  hr = await signedInClient("HR Scope Supervisor");
  await grantRole(hr.userId, { type: "tenant" });
  supA = await signedInClient("Supervisor Scope A");
  supB = await signedInClient("Supervisor Scope B");
  supC = await signedInClient("Supervisor Scope C");
  for (const supervisor of [supA, supB, supC])
    await grantRole(supervisor.userId, {
      type: "outlet",
      outletIds: [outletId],
    });

  // Review queue must hold flagged logs: sampling off, flagged always in.
  const policy = await hr.client
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
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);

  const empA = await seedEmployee({
    userId: supA.userId,
    managerId: null,
    name: "Supervisor Scope A",
  });
  empAId = empA;
  await assignTemplateRole(supA.userId, managerRole, outletId);
  const empB = await seedEmployee({
    userId: supB.userId,
    managerId: null,
    name: "Supervisor Scope B",
  });
  await seedEmployee({
    userId: supC.userId,
    managerId: null,
    name: "Supervisor Scope C",
  });
  subA = await seedEmployee({
    userId: null,
    managerId: empA,
    name: "Bawahan Scope A",
  });
  subB = await seedEmployee({
    userId: null,
    managerId: empB,
    name: "Bawahan Scope B",
  });
  logA = await seedFlaggedLog(subA);
  logB = await seedFlaggedLog(subB);
  corrA = await seedCorrection(subA);
  corrB = await seedCorrection(subB);
}, 120_000);

afterAll(async () => {
  try {
    await owner.query("BEGIN");
    await owner.query("SET LOCAL session_replication_role = replica");
    await owner.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    await owner.query(
      "DELETE FROM attendance_logs WHERE tenant_id = $1 AND (id = ANY($2::uuid[]) OR outlet_id = $3)",
      [tenant.id, createdLogs, outletId],
    );
    await owner.query(
      "DELETE FROM attendance_devices WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await owner.query(
      "DELETE FROM attendance_corrections WHERE tenant_id = $1 AND (id = ANY($2::uuid[]) OR outlet_id = $3)",
      [tenant.id, createdCorrections, outletId],
    );
    await owner.query(
      "DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    if (insertedApprovalPolicy)
      await owner.query(
        "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'attendance_correction'",
        [tenant.id],
      );
    await owner.query(
      "DELETE FROM attendance_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.id, outletId],
    );
    await owner.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE $2",
      [tenant.id, `${KEY_PREFIX}%`],
    );
    await owner.query(
      `DELETE FROM audit_logs
        WHERE tenant_id = $1 AND (event->>'objectId' = ANY($2::text[])
           OR event->>'actorId' = ANY($3::text[]))`,
      [
        tenant.id,
        [
          ...createdLogs.map(uuidToUlid),
          ...createdCorrections,
          ...createdCorrections.map(uuidToUlid),
        ],
        createdUsers,
      ],
    );
    await owner.query(
      `DELETE FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->'payload'->>'employeeId' = ANY($2::text[])`,
      [tenant.id, createdEmployees],
    );
    await owner.query(
      "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdObjects],
    );
    await owner.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await owner.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdRoles],
    );
    await owner.query("COMMIT");
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUsers,
    ]);
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await owner.end();
  }
}, 60_000);

const reviewQueue = (client: Client) =>
  collectAll(client, `/api/hris/attendance/review-queue?outletId=${outletId}`);

describe("[F25] supervisor sees only own subordinates in the selfie review", () => {
  it("lists a supervisor's own subordinate with a signed selfie URL", async () => {
    const queue = await reviewQueue(supA.client);
    expect(queue.status, queue.text).toBe(200);
    const item = queue.rows.find(
      (row) => String((row.log as JsonRow).id).toUpperCase() === logA.apiId,
    );
    expect(item, queue.text).toBeDefined();
    expect((item!.log as JsonRow).photoUrl).toBe(signedUrlFor(logA.objectId));
  });

  it("hides another supervisor's subordinate and selfie in the same outlet", async () => {
    const queueA = await reviewQueue(supA.client);
    expect(queueA.status, queueA.text).toBe(200);
    expect(queueIds(queueA.rows)).not.toContain(logB.apiId);
    expect(queueA.text).not.toContain(logB.objectId);
    expect(queueA.text).not.toContain(subB);

    const queueB = await reviewQueue(supB.client);
    expect(queueB.status, queueB.text).toBe(200);
    expect(queueIds(queueB.rows)).toContain(logB.apiId);
    expect(queueIds(queueB.rows)).not.toContain(logA.apiId);
    expect(queueB.text).not.toContain(logA.objectId);
    expect(queueB.text).not.toContain(subA);
  });

  it("answers an empty queue to a supervisor with no subordinates", async () => {
    const queue = await reviewQueue(supC.client);
    expect(queue.status, queue.text).toBe(200);
    expect(queueIds(queue.rows)).not.toContain(logA.apiId);
    expect(queueIds(queue.rows)).not.toContain(logB.apiId);
    expect(queue.rows).toHaveLength(0);
    expect(queue.text).not.toContain(logA.objectId);
    expect(queue.text).not.toContain(logB.objectId);
  });

  it("refuses a decision on another supervisor's subordinate and changes nothing", async () => {
    const response = await post(
      supA.client,
      `/api/hris/attendance/logs/${logB.apiId}/review`,
      { action: "reject", idempotencyKey: `${KEY_PREFIX}${randomUUID()}` },
    );
    expect([403, 404], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(JSON.stringify(response.body)).not.toContain(logB.objectId);
    const { rows } = await owner.query(
      "SELECT validity, review_status FROM attendance_logs WHERE tenant_id = $1 AND id = $2",
      [tenant.id, logB.logId],
    );
    expect(rows[0]).toEqual({ validity: "flagged", review_status: "none" });
  });

  it("lets a supervisor decide on their own subordinate and returns the signed URL", async () => {
    const own = await seedFlaggedLog(subA);
    const response = await post(
      supA.client,
      `/api/hris/attendance/logs/${own.apiId}/review`,
      { action: "accept", idempotencyKey: `${KEY_PREFIX}${randomUUID()}` },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.log.validity).toBe("valid");
    expect(response.body.data.log.photoUrl).toBe(signedUrlFor(own.objectId));
  });

  it("keeps the HR (tenant-wide) view of every subordinate and selfie", async () => {
    // Fresh pending logs: earlier tests decide on logA/logB, and on code that
    // leaks, a wrongly accepted decision would drop logB from the queue.
    const freshA = await seedFlaggedLog(subA);
    const freshB = await seedFlaggedLog(subB);
    const queue = await reviewQueue(hr.client);
    expect(queue.status, queue.text).toBe(200);
    const ids = queueIds(queue.rows);
    expect(ids).toContain(freshA.apiId);
    expect(ids).toContain(freshB.apiId);
    expect(queue.text).toContain(signedUrlFor(freshA.objectId));
    expect(queue.text).toContain(signedUrlFor(freshB.objectId));
  });
});

describe("[F25] supervisor sees only own subordinates in the manual-correction queue", () => {
  it("lists a supervisor's own subordinate correction, never the other supervisor's", async () => {
    const listA = await collectAll(
      supA.client,
      "/api/hris/attendance/corrections",
    );
    expect(listA.status, listA.text).toBe(200);
    expect(correctionIds(listA.rows)).toContain(corrA.apiId);
    expect(correctionIds(listA.rows)).not.toContain(corrB.apiId);
    expect(listA.text).not.toContain(subB);

    const listB = await collectAll(
      supB.client,
      "/api/hris/attendance/corrections",
    );
    expect(listB.status, listB.text).toBe(200);
    expect(correctionIds(listB.rows)).toContain(corrB.apiId);
    expect(correctionIds(listB.rows)).not.toContain(corrA.apiId);
  });

  it("answers an empty correction queue to a supervisor with no subordinates", async () => {
    const list = await collectAll(
      supC.client,
      "/api/hris/attendance/corrections",
    );
    expect(list.status, list.text).toBe(200);
    expect(list.rows).toHaveLength(0);
  });

  it("does not leak the other supervisor's corrections through ?employeeId", async () => {
    const leak = await collectAll(
      supA.client,
      `/api/hris/attendance/corrections?employeeId=${subB}`,
    );
    if (leak.status === 200) expect(leak.rows).toHaveLength(0);
    else expect([403, 404]).toContain(leak.status);
    expect(leak.text).not.toContain(corrB.apiId);
    expect(leak.text).not.toContain(subB);
  });

  it("refuses a decision on another supervisor's subordinate correction and changes nothing", async () => {
    const response = await post(
      supA.client,
      `/api/hris/attendance/corrections/${corrB.apiId}/decision`,
      {
        action: "reject",
        note: "Bukan bawahan saya",
        idempotencyKey: `${KEY_PREFIX}${randomUUID()}`,
      },
    );
    expect([403, 404], JSON.stringify(response.body)).toContain(
      response.status,
    );
    const { rows } = await owner.query(
      "SELECT status FROM attendance_corrections WHERE tenant_id = $1 AND id = $2",
      [tenant.id, corrB.id],
    );
    expect(rows[0]).toEqual({ status: "pending" });
  });

  it("lets a supervisor reject their own subordinate's correction", async () => {
    const own = await requestCorrectionViaApi(empAId);
    const response = await post(
      supA.client,
      `/api/hris/attendance/corrections/${own.apiId}/decision`,
      {
        action: "reject",
        note: "Bukti kurang",
        idempotencyKey: `${KEY_PREFIX}${randomUUID()}`,
      },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.status).toBe("rejected");
  });

  it("keeps the HR (tenant-wide) view of every correction", async () => {
    // Fresh pending corrections: the supervisor tests above may decide on the
    // shared ones, which would drop them from the pending filter.
    const freshA = await seedCorrection(subA);
    const freshB = await seedCorrection(subB);
    const list = await collectAll(
      hr.client,
      `/api/hris/attendance/corrections?status=pending`,
    );
    expect(list.status, list.text).toBe(200);
    expect(correctionIds(list.rows)).toContain(freshA.apiId);
    expect(correctionIds(list.rows)).toContain(freshB.apiId);
  });
});

describe("[F25] supervisor attendance logs do not leak through ?employeeId", () => {
  it("shows a supervisor their own subordinate's logs", async () => {
    const own = await collectAll(
      supA.client,
      `/api/hris/attendance/logs?employeeId=${subA}`,
    );
    expect(own.status, own.text).toBe(200);
    expect(rowIds(own.rows)).toContain(logA.apiId);
  });

  it("hides another supervisor's subordinate logs and selfie URL", async () => {
    const leak = await collectAll(
      supA.client,
      `/api/hris/attendance/logs?employeeId=${subB}`,
    );
    if (leak.status === 200) expect(leak.rows).toHaveLength(0);
    else expect([403, 404]).toContain(leak.status);
    expect(leak.text).not.toContain(logB.apiId);
    expect(leak.text).not.toContain(logB.objectId);
  });

  it("does not leak the other supervisor's logs when listing the whole outlet", async () => {
    const list = await collectAll(
      supA.client,
      `/api/hris/attendance/logs?outletId=${outletId}`,
    );
    if (list.status === 200)
      expect(rowIds(list.rows)).not.toContain(logB.apiId);
    else expect([403, 404]).toContain(list.status);
    expect(list.text).not.toContain(logB.objectId);
  });

  it("keeps the HR view of any subordinate's logs", async () => {
    const response = await collectAll(
      hr.client,
      `/api/hris/attendance/logs?employeeId=${subB}`,
    );
    expect(response.status, response.text).toBe(200);
    expect(rowIds(response.rows)).toContain(logB.apiId);
  });
});

describe("[F2-2] supervisor sees and revokes only direct reports' devices", () => {
  let deviceA: string;
  let deviceB: string;

  async function seedDevice(employeeId: string) {
    const id = randomUUID();
    await asTenant((client) =>
      client.query(
        `INSERT INTO attendance_devices (id, tenant_id, employee_id, device_id_hash, label)
         VALUES ($1, $2, $3, $4, 'HP scope')`,
        [
          id,
          tenant.id,
          employeeId,
          (randomUUID() + randomUUID()).replaceAll("-", ""),
        ],
      ),
    );
    return id;
  }

  const deviceStatus = async (id: string) =>
    (
      await owner.query(
        "SELECT status FROM attendance_devices WHERE tenant_id = $1 AND id = $2",
        [tenant.id, id],
      )
    ).rows[0];

  beforeAll(async () => {
    deviceA = await seedDevice(subA);
    deviceB = await seedDevice(subB);
  });

  it("lists only the supervisor's own subordinate's device", async () => {
    const list = await collectAll(supA.client, "/api/hris/attendance/devices");
    expect(list.status, list.text).toBe(200);
    const ids = list.rows.map((row) => String(row.id).toLowerCase());
    expect(ids).toContain(deviceA);
    expect(ids).not.toContain(deviceB);
  });

  it("answers an empty list when the filter names another supervisor's subordinate", async () => {
    const list = await collectAll(
      supA.client,
      `/api/hris/attendance/devices?employeeId=${subB}`,
    );
    expect(list.status, list.text).toBe(200);
    expect(list.rows).toHaveLength(0);
  });

  it("refuses to revoke another supervisor's subordinate's device with 404 and changes nothing", async () => {
    const response = await post(
      supA.client,
      `/api/hris/attendance/devices/${deviceB}/revoke`,
      { idempotencyKey: `${KEY_PREFIX}${randomUUID()}` },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(await deviceStatus(deviceB)).toEqual({ status: "active" });
  });

  it("keeps the HR (tenant-wide) view of every device", async () => {
    const list = await collectAll(hr.client, "/api/hris/attendance/devices");
    expect(list.status, list.text).toBe(200);
    const ids = list.rows.map((row) => String(row.id).toLowerCase());
    expect(ids).toContain(deviceA);
    expect(ids).toContain(deviceB);
  });

  it("lets a supervisor revoke their own subordinate's device", async () => {
    const response = await post(
      supA.client,
      `/api/hris/attendance/devices/${deviceA}/revoke`,
      { idempotencyKey: `${KEY_PREFIX}${randomUUID()}` },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await deviceStatus(deviceA)).toEqual({ status: "revoked" });
  });
});
