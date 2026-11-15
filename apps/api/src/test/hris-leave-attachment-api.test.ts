// legend-qu04u: who gets a leave request's signed `attachmentUrl` over HTTP
// (GET /api/hris/leave/requests and GET /api/hris/leave/requests/:id).
//
// Target rule (card brief; the PRD keeps a medical certificate private): the
// requester gets the URL only while holding an ACTIVE `self.leave.request` at
// the leave's outlet, or `hr.leave.approve` at that outlet. An approver at
// that outlet gets it too. Anyone else who can still read the row (for
// instance a requester whose grant at that outlet ended but who keeps a
// leave-read code elsewhere) gets the row with `attachmentUrl: null`.
//
// There is no GET /api/hris/leave/requests/:id in the contract (endpoints.ts
// defines list, create and decision only), so the detail case is NOT covered
// here; the service-level getLeaveRequest needs a db-style test instead.
//
// Assumptions:
//  - "Revoked" is a role assignment whose `valid_until` is in the past
//    (assignments are time-boxed, there is no separate revoke flag).
//  - A requester whose grant at the leave outlet ended but who holds
//    `hr.employee.view` tenant-wide still reads the row (200, row present)
//    with attachmentUrl null. With only outlet-B grants the outlet-A row is
//    hidden by outlet scoping today, so those two cases only assert that the
//    URL never leaks (they pass now and guard against regression).
//  - An approver whose grants sit at another outlet cannot see the row at all
//    (absent from the list), as hris-leave-attachment-db.test.ts already
//    asserts for the other outlet's manager.
//  - Reads need no MFA.
//
// legend-bkd76 (second describe at the bottom): creating a leave request
// (POST /api/hris/leave/requests) and uploading its attachment
// (POST /api/hris/leave/attachments) need an ACTIVE `self.leave.request` at the
// employee's leave outlet (outlet A), not at just any outlet. Refusals are 403
// and write nothing. Extra assumptions for those cases:
//  - the employee's home outlet is the leave outlet (A); success is 200 or 201.
//  - a PNG is an accepted attachment (the contract lists PDF/JPEG/PNG/WebP).
//  - the seeded tenant leave approval policy lets a create succeed; the
//    positive cases fail for a setup reason if it does not.
//  - replaying an idempotent create after the grant ended is refused the same
//    way (403), which is what the offline mobile replay relies on.
// Runs the real Express app (with a stub storage signer), Better Auth, RBAC
// and PostgreSQL against the seeded Cafe Legend tenant.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenant = cafeLegendPlatformFixtures.tenant;
const [outletA, outletB] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const signedUrlFor = (objectId: string) =>
  `https://signed.example.test/document/${objectId}?sig=fake`;

const storageRuntime: StorageRuntime = {
  storage: new FakeObjectStorage(),
  scanner: new NoopMalwareScanner(),
  fileSigner: async () => null,
  hrisDocumentSigner: async (_context, objectId) => signedUrlFor(objectId),
};
const app = createApp({ storageRuntime });

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdLeave: string[] = [];
let leaveTypeId: string;
let createTypeId: string;
let bystanderUserId: string;
// legend-bkd76: the tenant's own 'leave' approval policies, restored in afterAll.
let savedLeavePolicies: Record<string, unknown>[] = [];

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

async function signedInUser(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

type Grant = {
  permissions: string[];
  /** null = tenant-wide. */
  outletId: string | null;
  /** true = the assignment ended an hour ago (revoked). */
  revoked?: boolean;
};

async function grant(
  userId: string,
  { permissions, outletId, revoked }: Grant,
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Leave attachment ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([outletId === null ? "tenant" : "outlet"]),
      ],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
       VALUES ($1, $2, $3, CASE WHEN $4::uuid IS NULL THEN 'tenant' ELSE 'outlet' END, $4, now() - interval '2 hours',
               CASE WHEN $5::boolean THEN now() - interval '1 hour' END, $2)`,
      [tenant.id, userId, roleId, outletId, revoked === true],
    );
  });
}

/** One employee at outlet A with one pending leave request carrying a private file. */
async function seedLeave(employeeUserId: string | null) {
  const employeeId = randomUUID();
  const objectId = randomUUID();
  const leaveId = randomUUID();
  createdEmployees.push(employeeId);
  createdLeave.push(leaveId);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Lampiran', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        tenant.id,
        employeeUserId,
        `LA-${employeeId.slice(0, 8).toUpperCase()}`,
        outletA.id,
      ],
    );
    await db.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, owner_user_id, source_kind, source_id)
       VALUES ($1, $2, $3, 'document', $4, 'application/pdf', 2048, $5, 'leave_request', $6)`,
      [
        tenant.id,
        outletA.id,
        objectId,
        `document/${objectId}/original.pdf`,
        employeeUserId ?? bystanderUserId,
        leaveId,
      ],
    );
    await db.query(
      `INSERT INTO leave_requests (id, tenant_id, outlet_id, employee_id, leave_type_id, period_year,
                                   start_date, end_date, days, attachment_key, status, requested_by)
       VALUES ($1, $2, $3, $4, $5, 2026, '2026-03-02', '2026-03-02', 1, $6, 'pending', $7)`,
      [
        leaveId,
        tenant.id,
        outletA.id,
        employeeId,
        leaveTypeId,
        objectId,
        employeeUserId ?? bystanderUserId,
      ],
    );
  });
  return { employeeId, objectId, leaveId };
}

type Row = { id: string; attachmentUrl: string | null };

/** The request as the list route shows it to this client. */
async function readList(
  client: Client,
  seeded: { employeeId: string; leaveId: string },
) {
  const list = await client.get(
    `/api/hris/leave/requests?employeeId=${seeded.employeeId}&limit=50`,
  );
  const listed =
    list.status === 200
      ? (list.body.data as Row[]).find((row) => row.id === seeded.leaveId)
      : undefined;
  return { list, listed };
}

beforeAll(async () => {
  // Creating a leave request needs a 'leave' approval policy (otherwise 409
  // APPROVAL_POLICY_MISSING). Swap in one level for the outlet manager (§3.7).
  savedLeavePolicies = (
    await owner.query(
      "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'",
      [tenant.id],
    )
  ).rows;
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'",
    [tenant.id],
  );
  const managerRole = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'outlet_manager'",
    [tenant.id],
  );
  if (!managerRole.rows[0]) throw new Error("No outlet_manager role");
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'leave', NULL, $2, 1)`,
    [tenant.id, managerRole.rows[0].id],
  );

  bystanderUserId = (await signedInUser("Pembuat Lampiran")).userId;
  leaveTypeId = randomUUID();
  await asTenant((db) =>
    db.query(
      `INSERT INTO leave_types (id, tenant_id, code, name, paid, requires_attachment, policy, is_active)
       VALUES ($1, $2, $3, 'Cuti Lampiran API', true, false, '{}'::jsonb, true)`,
      [leaveTypeId, tenant.id, `LA${leaveTypeId.slice(0, 8)}`],
    ),
  );
  createTypeId = randomUUID();
  await asTenant((db) =>
    db.query(
      `INSERT INTO leave_types (id, tenant_id, code, name, paid, requires_attachment, policy, is_active)
       VALUES ($1, $2, $3, 'Cuti Buat API', true, false, $4::jsonb, true)`,
      [
        createTypeId,
        tenant.id,
        `CB${createTypeId.slice(0, 8)}`,
        JSON.stringify({
          annualDays: "12.0000",
          carryOverMaxDays: "0.0000",
          carryOverExpiryMonths: 0,
          tracksBalance: false,
          accrual: "upfront",
          negativeAllowanceDays: "0.0000",
        }),
      ],
    ),
  );
});

afterAll(async () => {
  await asTenant(async (db) => {
    await db.query(
      "DELETE FROM leave_requests WHERE tenant_id = $1 AND leave_type_id = $2",
      [tenant.id, createTypeId],
    );
    await db.query(
      "DELETE FROM leave_balances WHERE tenant_id = $1 AND leave_type_id = $2",
      [tenant.id, createTypeId],
    );
    await db.query(
      "DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await db.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'bkd76-%'",
      [tenant.id],
    );
    await db.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'",
      [tenant.id],
    );
    for (const row of savedLeavePolicies)
      await db.query(
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
    await db.query("DELETE FROM leave_types WHERE tenant_id = $1 AND id = $2", [
      tenant.id,
      createTypeId,
    ]);
    const byId = (table: string, ids: string[]) =>
      db.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenant.id, ids],
      );
    await byId("leave_requests", createdLeave);
    await byId("leave_types", [leaveTypeId]);
    await byId("employees", createdEmployees);
    await db.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await byId("roles", createdRoles);
    // Storage objects stay: audit_logs references them (disposable DB).
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  await owner.end();
});

describe("legend-qu04u leave attachment URL over HTTP", () => {
  it("[requester active self.leave.request] gets the signed URL in the list", async () => {
    const requester = await signedInUser("Pemohon Aktif");
    await grant(requester.userId, {
      permissions: ["self.profile.view", "self.leave.request"],
      outletId: outletA.id,
    });
    const seeded = await seedLeave(requester.userId);

    const { list, listed } = await readList(requester.client, seeded);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(listed?.attachmentUrl).toBe(signedUrlFor(seeded.objectId));
  });

  it("[requester revoked at the leave outlet, self.leave.request at another outlet] never receives the URL", async () => {
    const requester = await signedInUser("Pemohon Dicabut Lain Outlet");
    await grant(requester.userId, {
      permissions: ["self.profile.view", "self.leave.request"],
      outletId: outletA.id,
      revoked: true,
    });
    await grant(requester.userId, {
      permissions: ["self.profile.view", "self.leave.request"],
      outletId: outletB.id,
    });
    const seeded = await seedLeave(requester.userId);

    const { list, listed } = await readList(requester.client, seeded);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    // Assumption: with outlet-scoped grants only at outlet B the outlet A row
    // may be hidden by outlet scoping (observed today) or shown without the
    // URL; either way the URL must not leak.
    expect(listed?.attachmentUrl ?? null).toBeNull();
    expect(JSON.stringify(list.body)).not.toContain(seeded.objectId);
  });

  it("[requester revoked at the leave outlet, hr.employee.view at another outlet] never receives the URL", async () => {
    const requester = await signedInUser("Pemohon Dicabut HR View");
    await grant(requester.userId, {
      permissions: ["self.profile.view", "self.leave.request"],
      outletId: outletA.id,
      revoked: true,
    });
    await grant(requester.userId, {
      permissions: ["hr.employee.view"],
      outletId: outletB.id,
    });
    const seeded = await seedLeave(requester.userId);

    const { list, listed } = await readList(requester.client, seeded);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    // Assumption: with outlet-scoped grants only at outlet B the outlet A row
    // may be hidden by outlet scoping (observed today) or shown without the
    // URL; either way the URL must not leak.
    expect(listed?.attachmentUrl ?? null).toBeNull();
    expect(JSON.stringify(list.body)).not.toContain(seeded.objectId);
  });

  it("[requester revoked at the leave outlet, hr.employee.view tenant-wide] still sees the row but attachmentUrl is null", async () => {
    const requester = await signedInUser("Pemohon Dicabut HR Tenant");
    await grant(requester.userId, {
      permissions: ["self.profile.view", "self.leave.request"],
      outletId: outletA.id,
      revoked: true,
    });
    await grant(requester.userId, {
      permissions: ["hr.employee.view"],
      outletId: null,
    });
    const seeded = await seedLeave(requester.userId);

    const { list, listed } = await readList(requester.client, seeded);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(listed, "row must stay visible in the list").toBeDefined();
    expect(listed?.attachmentUrl).toBeNull();
  });

  it("[approver hr.leave.approve at the leave outlet] gets the signed URL in the list", async () => {
    const approver = await signedInUser("Penyetuju Outlet A");
    await grant(approver.userId, {
      permissions: ["hr.employee.view", "hr.leave.approve"],
      outletId: outletA.id,
    });
    const seeded = await seedLeave(null);

    const { list, listed } = await readList(approver.client, seeded);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(listed?.attachmentUrl).toBe(signedUrlFor(seeded.objectId));
  });

  it("[approver hr.leave.approve only at another outlet] does not see the request or its attachment", async () => {
    const approver = await signedInUser("Penyetuju Outlet B");
    await grant(approver.userId, {
      permissions: ["hr.employee.view", "hr.leave.approve"],
      outletId: outletB.id,
    });
    const seeded = await seedLeave(null);

    const { list, listed } = await readList(approver.client, seeded);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(listed).toBeUndefined();
    expect(JSON.stringify(list.body)).not.toContain(seeded.objectId);
  });
});

// ---------------------------------------------------------------------------
// legend-bkd76: create + upload need a live self.leave.request at the leave
// outlet (the employee's home outlet, A).

const selfGrant = ["self.profile.view", "self.leave.request"];

/** An active employee of outlet A linked to this user (no leave yet). */
async function seedEmployee(userId: string) {
  const employeeId = randomUUID();
  createdEmployees.push(employeeId);
  await asTenant((db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Buat Cuti', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        tenant.id,
        userId,
        `BK-${employeeId.slice(0, 8).toUpperCase()}`,
        outletA.id,
      ],
    ),
  );
  return employeeId;
}

/** Ends every grant of this user at the outlet, as a revocation would. */
async function endGrants(userId: string, outletId: string) {
  await asTenant((db) =>
    db.query(
      `UPDATE role_assignments SET valid_until = now() - interval '1 hour'
        WHERE tenant_id = $1 AND user_id = $2 AND scope_id = $3`,
      [tenant.id, userId, outletId],
    ),
  );
}

let png: Buffer;
async function pngBytes() {
  png ??= await sharp({
    create: { width: 4, height: 4, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  return png;
}

async function uploadAttachment(client: Client) {
  return client
    .post("/api/hris/leave/attachments")
    .set(originHeader)
    .attach("file", await pngBytes(), "surat-dokter.png");
}

function createBody(
  attachmentUploadRef: string | null,
  idempotencyKey?: string,
) {
  return {
    leaveTypeId: createTypeId,
    startDate: "2031-03-03",
    endDate: "2031-03-03",
    reason: "Surat dokter",
    attachmentUploadRef,
    idempotencyKey: idempotencyKey ?? `bkd76-${randomUUID()}`,
  };
}

async function createLeave(
  client: Client,
  body: ReturnType<typeof createBody>,
) {
  return client.post("/api/hris/leave/requests").set(originHeader).send(body);
}

async function requestCount(employeeId: string) {
  return asTenant(async (db) =>
    Number(
      (
        await db.query(
          "SELECT count(*) AS n FROM leave_requests WHERE tenant_id = $1 AND employee_id = $2",
          [tenant.id, employeeId],
        )
      ).rows[0].n,
    ),
  );
}

/** A private document owned by the user at outlet A, not yet used by any request. */
async function seedOwnedObject(userId: string) {
  const objectId = randomUUID();
  await asTenant((db) =>
    db.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, owner_user_id, source_kind)
       VALUES ($1, $2, $3, 'document', $4, 'application/pdf', 2048, $5, 'leave_request')`,
      [
        tenant.id,
        outletA.id,
        objectId,
        `document/${objectId}/original.pdf`,
        userId,
      ],
    ),
  );
  return objectId;
}

describe("legend-bkd76 create and upload need self.leave.request at the leave outlet", () => {
  it("[active at the leave outlet] upload and create succeed and the create response carries the attachment URL", async () => {
    const staff = await signedInUser("Buat Cuti Aktif");
    await grant(staff.userId, { permissions: selfGrant, outletId: outletA.id });
    const employeeId = await seedEmployee(staff.userId);

    const uploaded = await uploadAttachment(staff.client);
    expect([200, 201], JSON.stringify(uploaded.body)).toContain(
      uploaded.status,
    );
    const ref = uploaded.body.data.attachmentUploadRef as string;

    const created = await createLeave(staff.client, createBody(ref));
    expect([200, 201], JSON.stringify(created.body)).toContain(created.status);
    expect(created.body.data.attachmentUrl).toBe(signedUrlFor(ref));
    expect(await requestCount(employeeId)).toBe(1);
  });

  it("[self.leave.request only at another outlet] create is refused with 403 and writes nothing", async () => {
    const staff = await signedInUser("Buat Cuti Lain Outlet");
    await grant(staff.userId, { permissions: selfGrant, outletId: outletB.id });
    const employeeId = await seedEmployee(staff.userId);
    const objectId = await seedOwnedObject(staff.userId);

    const withFile = await createLeave(staff.client, createBody(objectId));
    expect(withFile.status, JSON.stringify(withFile.body)).toBe(403);
    const withoutFile = await createLeave(staff.client, createBody(null));
    expect(withoutFile.status, JSON.stringify(withoutFile.body)).toBe(403);

    expect(await requestCount(employeeId)).toBe(0);
    const [object] = (
      await asTenant((db) =>
        db.query(
          "SELECT source_id FROM core_storage_objects WHERE tenant_id = $1 AND id = $2",
          [tenant.id, objectId],
        ),
      )
    ).rows;
    expect(object.source_id, "the file must not be linked").toBeNull();
  });

  it("[self.leave.request only at another outlet] upload is refused with 403", async () => {
    const staff = await signedInUser("Unggah Lain Outlet");
    await grant(staff.userId, { permissions: selfGrant, outletId: outletB.id });
    await seedEmployee(staff.userId);

    const uploaded = await uploadAttachment(staff.client);
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(403);
  });

  it("[grant at the leave outlet revoked, active at another outlet] upload and create are refused with 403", async () => {
    const staff = await signedInUser("Dicabut Di Outlet Cuti");
    await grant(staff.userId, { permissions: selfGrant, outletId: outletA.id });
    await grant(staff.userId, { permissions: selfGrant, outletId: outletB.id });
    const employeeId = await seedEmployee(staff.userId);
    const objectId = await seedOwnedObject(staff.userId);
    await endGrants(staff.userId, outletA.id);

    const uploaded = await uploadAttachment(staff.client);
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(403);
    const created = await createLeave(staff.client, createBody(objectId));
    expect(created.status, JSON.stringify(created.body)).toBe(403);
    expect(await requestCount(employeeId)).toBe(0);
  });

  it("[offline replay of an earlier create after the grant ended] is refused with 403 and returns no URL", async () => {
    const staff = await signedInUser("Replay Dicabut");
    await grant(staff.userId, { permissions: selfGrant, outletId: outletA.id });
    await grant(staff.userId, { permissions: selfGrant, outletId: outletB.id });
    await seedEmployee(staff.userId);
    const uploaded = await uploadAttachment(staff.client);
    const body = createBody(uploaded.body.data.attachmentUploadRef as string);

    const first = await createLeave(staff.client, body);
    expect([200, 201], JSON.stringify(first.body)).toContain(first.status);

    await endGrants(staff.userId, outletA.id);
    const replay = await createLeave(staff.client, body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(403);
    expect(JSON.stringify(replay.body)).not.toContain("signed.example.test");
  });

  it("[replay while still active at the leave outlet] returns the same request with its URL", async () => {
    const staff = await signedInUser("Replay Aktif");
    await grant(staff.userId, { permissions: selfGrant, outletId: outletA.id });
    const employeeId = await seedEmployee(staff.userId);
    const uploaded = await uploadAttachment(staff.client);
    const body = createBody(uploaded.body.data.attachmentUploadRef as string);

    const first = await createLeave(staff.client, body);
    const replay = await createLeave(staff.client, body);
    expect([200, 201], JSON.stringify(replay.body)).toContain(replay.status);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(replay.body.data.attachmentUrl).toBe(
      signedUrlFor(body.attachmentUploadRef!),
    );
    expect(await requestCount(employeeId)).toBe(1);
  });
});
