// Leave attachment (bead legend-arj.4): `attachmentUploadRef` must be a fresh private
// `document` core_storage_objects row, used once, of the requester's tenant and home outlet (422
// otherwise); responses carry a short-lived signed URL only for the requester
// and for HR/approvers who can see the request, and each URL issued is audited.
// Same setup as hris-leave-db.test.ts, against PostgreSQL with the app role.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  createLeaveRequest as createLeaveRequestEndpoint,
  decideLeaveRequest as decideLeaveRequestEndpoint,
  leaveTypeInputSchema,
} from "@starter/shared/hris";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { createLeaveType } from "../services/hris-leave.service.ts";
import {
  createLeaveRequest,
  decideLeaveRequest,
  getLeaveRequest,
  listLeaveRequests,
} from "../services/hris-leave-request.service.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const outletB = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[1].id);

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdTypes: string[] = [];
const createdStorage: string[] = [];
let savedLeavePolicies: Record<string, unknown>[] = [];

const base = (tenant: string = tenantId) =>
  establishTenantContext({
    tenantId: tenant,
    brandId: null,
    source: "session",
  });
const tenantScope = (tenant: string = tenantId) =>
  establishScopedTenantContext(base(tenant), { kind: "tenant" });
const outletScope = (outletId: string) =>
  establishScopedTenantContext(base(), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
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

async function sql<R extends Record<string, unknown> = Record<string, string>>(
  text: string,
  params: unknown[] = [],
  tenant: string = tenantId,
): Promise<R[]> {
  return asOwner(
    tenant,
    async (client) => (await client.query(text, params)).rows,
  );
}

async function roleIdOf(templateKey: string): Promise<string> {
  const rows = await sql<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function newUser(tenant: string = tenantId): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Leave DB', $2)`,
    [userId, `${userId}@example.test`],
  );
  void tenant;
  return userId;
}

async function assign(
  tenant: string,
  userId: string,
  roleId: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  await sql(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [
      tenant,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
    tenant,
  );
}

/** A user holding a custom role with exactly `permissions` at `scope`. */
async function actor(
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
  tenant: string = tenantId,
): Promise<string> {
  const userId = await newUser(tenant);
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await sql(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenant,
      `Leave test ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify([scope.type]),
    ],
    tenant,
  );
  await assign(tenant, userId, roleId, scope);
  return userId;
}

/** A user holding a seeded role template (the approver in the matrix). */
async function templateActor(templateKey: string, outletId: string) {
  const userId = await newUser();
  await assign(tenantId, userId, await roleIdOf(templateKey), {
    type: "outlet",
    id: outletId,
  });
  return userId;
}

const codeOf = (error: unknown) => (error as { code?: string }).code;
const statusOf = (error: unknown) => (error as { status?: number }).status;
async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return { code: codeOf(error), status: statusOf(error), error };
  }
  throw new Error("Expected the call to fail");
}

const randomCode = (prefix: string) =>
  `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
const freshNo = () =>
  `T-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
const key = () => `hris-db-${randomUUID()}`;

// ---------------------------------------------------------------- fixtures

let hr: string; // tenant-wide: hr.employee.manage + view + hr.leave.approve
let managerA: string; // outlet_manager template at outlet A (the matrix approver)
let managerB: string; // outlet_manager template at outlet B

type Staff = { userId: string; employee: { id: string } };

async function makeStaff(
  outletId: string = outletA,
  joinDate = "2026-01-05",
): Promise<Staff> {
  const userId = await actor(["self.leave.request", "self.profile.view"], {
    type: "outlet",
    id: outletId,
  });
  // Attachment tests need active employees, not a tenant-plan provisioning
  // test. Seed these private fixtures without consuming a shared quota race.
  const [employee] = await sql<{ id: string }>(
    `INSERT INTO employees
       (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
        employment_type, join_date, status, created_by)
     VALUES ($1, $2, $3, $4, 'Karyawan Cuti', $5, 'pkwt', $6, 'active', $7)
     RETURNING id`,
    [randomUUID(), tenantId, userId, freshNo(), outletId, joinDate, hr],
  );
  return { userId, employee };
}

type PolicyOverrides = {
  annualDays?: string;
  carryOverMaxDays?: string;
  carryOverExpiryMonths?: number;
  tracksBalance?: boolean;
  accrual?: "upfront" | "monthly";
  negativeAllowanceDays?: string;
};

async function makeType(
  policy: PolicyOverrides = {},
  extra: { requiresAttachment?: boolean } = {},
) {
  const input = leaveTypeInputSchema.parse({
    code: randomCode("T1"),
    name: "Cuti uji",
    paid: true,
    requiresAttachment: extra.requiresAttachment ?? false,
    policy: {
      annualDays: "12.0000",
      carryOverMaxDays: "0.0000",
      carryOverExpiryMonths: 0,
      tracksBalance: true,
      accrual: "upfront",
      negativeAllowanceDays: "0.0000",
      ...policy,
    },
  });
  const type = await createLeaveType(tenantScope(), hr, {
    ...input,
    idempotencyKey: randomUUID(),
  });
  createdTypes.push(type.id);
  return type;
}

/** A core_storage_objects row; `purpose` and `outletId` vary per case. */
async function storageObject(
  outletId: string,
  purpose: "document" | "selfie" | "menu_photo" | "receipt" = "document",
  ageHours = 0,
  ownerUserId: string | null = null,
  sourceKind: string | null = purpose === "document" ? "leave_request" : null,
): Promise<string> {
  const id = randomUUID();
  createdStorage.push(id);
  await sql(
    `INSERT INTO core_storage_objects (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, created_at, owner_user_id, source_kind)
     VALUES ($1, $2, $3, $4, $5, 'application/pdf', 1024, now() - make_interval(hours => $6::int), $7, $8)`,
    [
      tenantId,
      outletId,
      id,
      purpose,
      `private/${tenantId}/${id}.pdf`,
      ageHours,
      ownerUserId,
      sourceKind,
    ],
  );
  return id;
}

const stubSigner = async (_context: unknown, id: string) =>
  `https://signed.example.test/${id}`;

function requestBody(
  leaveTypeId: string,
  attachmentUploadRef: string | null,
  day = "03",
) {
  return createLeaveRequestEndpoint.body.parse({
    leaveTypeId,
    startDate: `2031-03-${day}`,
    endDate: `2031-03-${day}`,
    reason: "Surat dokter",
    attachmentUploadRef,
    idempotencyKey: key(),
  });
}

async function requestCount(employeeId: string) {
  const rows = await sql<{ n: string }>(
    "SELECT count(*) AS n FROM leave_requests WHERE tenant_id = $1 AND employee_id = $2",
    [tenantId, employeeId],
  );
  return Number(rows[0]!.n);
}

async function issuedAudit(requestId: string) {
  return sql<{ actor: string; sensitive: boolean; raw: string }>(
    `SELECT event->>'actorId' AS actor,
            (event->>'sensitiveAccess')::boolean AS sensitive,
            event::text AS raw
       FROM audit_logs
      WHERE tenant_id = $1 AND event->>'objectId' = $2
        AND event->>'action' = 'hris.leave_request.attachment_url_issued'`,
    [tenantId, requestId],
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  // §3.7 matrix: a leave request goes to the outlet manager, one level.
  savedLeavePolicies = await sql(
    `SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'`,
    [tenantId],
  );
  await sql(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'`,
    [tenantId],
  );
  await sql(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'leave', NULL, $2, 1)`,
    [tenantId, await roleIdOf("outlet_manager")],
  );
  hr = await actor(
    ["hr.employee.manage", "hr.employee.view", "hr.leave.approve"],
    { type: "tenant" },
  );
  managerA = await templateActor("outlet_manager", outletA);
  managerB = await templateActor("outlet_manager", outletB);
});

afterAll(async () => {
  setAuditWriter(null);
  await asOwner(tenantId, async (client) => {
    const mine = `employee_id IN (SELECT id FROM employees WHERE tenant_id = $1 AND created_by = ANY($2))`;
    await client.query(
      `DELETE FROM leave_requests WHERE tenant_id = $1 AND (${mine} OR leave_type_id = ANY($3::uuid[]))`,
      [tenantId, createdUsers, createdTypes],
    );
    await client.query(
      `DELETE FROM leave_balances WHERE tenant_id = $1 AND (${mine} OR leave_type_id = ANY($3::uuid[]))`,
      [tenantId, createdUsers, createdTypes],
    );
    await client.query(
      `DELETE FROM leave_accruals WHERE tenant_id = $1 AND (${mine} OR leave_type_id = ANY($3::uuid[]))`,
      [tenantId, createdUsers, createdTypes],
    );
    await client.query(
      `DELETE FROM leave_types WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenantId, createdTypes],
    );
    await client.query(
      `DELETE FROM core_storage_objects WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenantId, createdStorage],
    );
    await client.query(
      `DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])`,
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'hris-db-%'",
      [tenantId],
    );
    await client.query(
      "UPDATE employees SET manager_id = NULL WHERE tenant_id = $1 AND created_by = ANY($2)",
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND created_by = ANY($2)",
      [tenantId, createdUsers],
    );
    await client.query(
      `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'`,
      [tenantId],
    );
    for (const row of savedLeavePolicies)
      await client.query(
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
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdRoles],
    );
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

describe("legend-arj.4 leave attachment", () => {
  it("refuses a fresh unclassified document even when the requester owns it", async () => {
    const type = await makeType({ tracksBalance: false });
    const staff = await makeStaff();
    const objectId = await storageObject(
      outletA,
      "document",
      0,
      staff.userId,
      null,
    );
    const result = await failure(
      createLeaveRequest(
        outletScope(outletA),
        staff.userId,
        requestBody(type.id, objectId),
        new Date(),
        stubSigner,
      ),
    );
    expect([result.status, result.code]).toEqual([422, "VALIDATION_ERROR"]);
    expect(await requestCount(staff.employee.id)).toBe(0);
  });
  it("accepts the requester's private object, stores its id and signs a URL only for those who can see the request", async () => {
    const type = await makeType(
      { tracksBalance: false },
      { requiresAttachment: true },
    );
    const staff = await makeStaff();
    const other = await makeStaff();
    const objectId = await storageObject(outletA, "document", 0, staff.userId);
    const body = requestBody(type.id, objectId);

    const created = await createLeaveRequest(
      outletScope(outletA),
      staff.userId,
      body,
      new Date(),
      stubSigner,
    );
    expect(created.attachmentUrl).toBe(
      `https://signed.example.test/${objectId}`,
    );
    const stored = await sql<{ attachment_key: string }>(
      "SELECT attachment_key FROM leave_requests WHERE tenant_id = $1 AND id = $2",
      [tenantId, created.id],
    );
    expect(stored[0]?.attachment_key).toBe(objectId);
    // The object key never reaches the response; the URL is audited per issue.
    expect(JSON.stringify(created)).not.toContain("private/");
    let issued = await issuedAudit(created.id);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ actor: staff.userId, sensitive: true });
    expect(issued[0]?.raw).not.toContain(objectId);

    // Replay returns the same request, signed again for the requester.
    const replay = await createLeaveRequest(
      outletScope(outletA),
      staff.userId,
      body,
      new Date(),
      stubSigner,
    );
    expect(replay.id).toBe(created.id);
    expect(replay.attachmentUrl).not.toBeNull();

    // Requester list and get.
    const own = await listLeaveRequests(
      outletScope(outletA),
      staff.userId,
      { limit: 20 },
      stubSigner,
    );
    expect(own.data.map((row) => row.attachmentUrl)).toEqual([
      `https://signed.example.test/${objectId}`,
    ]);
    // HR (tenant-wide manage) and the outlet-A approver can open it.
    for (const [viewer, scope] of [
      [hr, tenantScope()],
      [managerA, outletScope(outletA)],
    ] as const) {
      const seen = await getLeaveRequest(scope, viewer, created.id, stubSigner);
      expect(seen.attachmentUrl).toBe(
        `https://signed.example.test/${objectId}`,
      );
    }
    // Employee administrators without leave approval may see the request but
    // cannot open its private medical attachment.
    const adminWithoutApproval = await actor(
      ["hr.employee.manage", "hr.employee.view"],
      { type: "tenant" },
    );
    const adminView = await getLeaveRequest(
      tenantScope(),
      adminWithoutApproval,
      created.id,
      stubSigner,
    );
    expect(adminView.attachmentUrl).toBeNull();
    // A colleague's list never holds it; the other outlet's manager gets 404.
    const colleague = await listLeaveRequests(
      outletScope(outletA),
      other.userId,
      { limit: 20 },
      stubSigner,
    );
    expect(colleague.data).toEqual([]);
    expect(
      (
        await failure(
          getLeaveRequest(
            outletScope(outletB),
            managerB,
            created.id,
            stubSigner,
          ),
        )
      ).status,
    ).toBe(404);

    // The approver's decision response is signed too.
    const approved = await decideLeaveRequest(
      outletScope(outletA),
      managerA,
      created.id as never,
      decideLeaveRequestEndpoint.body.parse({
        action: "approve",
        idempotencyKey: key(),
      }),
      { mfaVerified: true },
      new Date(),
      stubSigner,
    );
    expect(approved.status).toBe("approved");
    expect(approved.attachmentUrl).toBe(
      `https://signed.example.test/${objectId}`,
    );
    issued = await issuedAudit(created.id);
    expect(issued.length).toBeGreaterThanOrEqual(6);
    expect(issued.every((row) => row.sensitive)).toBe(true);
  });

  it("the default signer mints no URL and writes no URL audit (fail closed)", async () => {
    const type = await makeType({ tracksBalance: false });
    const staff = await makeStaff();
    const objectId = await storageObject(outletA, "document", 0, staff.userId);
    const created = await createLeaveRequest(
      outletScope(outletA),
      staff.userId,
      requestBody(type.id, objectId),
    );
    expect(created.attachmentUrl).toBeNull();
    const listed = await listLeaveRequests(outletScope(outletA), staff.userId, {
      limit: 20,
    });
    expect(listed.data[0]?.attachmentUrl).toBeNull();
    expect(await issuedAudit(created.id)).toHaveLength(0);
  });

  it("a request without attachment gets no URL and no audit", async () => {
    const type = await makeType({ tracksBalance: false });
    const staff = await makeStaff();
    const created = await createLeaveRequest(
      outletScope(outletA),
      staff.userId,
      requestBody(type.id, null),
      new Date(),
      stubSigner,
    );
    expect(created.attachmentUrl).toBeNull();
    expect(await issuedAudit(created.id)).toHaveLength(0);
  });

  it("refuses a missing, malformed, public, other-outlet, non-document or stale upload with 422 and creates nothing", async () => {
    const type = await makeType({ tracksBalance: false });
    const staff = await makeStaff();
    const refs: Record<string, string> = {
      unknown: randomUUID(),
      malformed: "not-a-uuid",
      public: await storageObject(outletA, "menu_photo", 0, staff.userId),
      otherOutlet: await storageObject(outletB, "document", 0, staff.userId),
      otherPrivatePurpose: await storageObject(
        outletA,
        "selfie",
        0,
        staff.userId,
      ),
      receiptPurpose: await storageObject(outletA, "receipt", 0, staff.userId),
      stale: await storageObject(outletA, "document", 25, staff.userId),
    };
    for (const [name, ref] of Object.entries(refs)) {
      const result = await failure(
        createLeaveRequest(
          outletScope(outletA),
          staff.userId,
          requestBody(type.id, ref),
          new Date(),
          stubSigner,
        ),
      );
      expect([name, result.status, result.code]).toEqual([
        name,
        422,
        "VALIDATION_ERROR",
      ]);
    }
    expect(await requestCount(staff.employee.id)).toBe(0);
  });

  it("refuses an upload already attached to an employee document", async () => {
    const type = await makeType({ tracksBalance: false });
    const staff = await makeStaff();
    const objectId = await storageObject(outletA, "document", 0, staff.userId);
    await sql(
      `INSERT INTO employee_documents (tenant_id, employee_id, type, storage_object_id)
       VALUES ($1, $2, 'ktp', $3)`,
      [tenantId, staff.employee.id, objectId],
    );
    try {
      const result = await failure(
        createLeaveRequest(
          outletScope(outletA),
          staff.userId,
          requestBody(type.id, objectId),
          new Date(),
          stubSigner,
        ),
      );
      expect([result.status, result.code]).toEqual([422, "VALIDATION_ERROR"]);
      expect(await requestCount(staff.employee.id)).toBe(0);
    } finally {
      await sql(
        "DELETE FROM employee_documents WHERE tenant_id = $1 AND storage_object_id = $2",
        [tenantId, objectId],
      );
    }
  });

  it("refuses an upload already attached to another leave request, even by another employee", async () => {
    const type = await makeType({ tracksBalance: false });
    const staff = await makeStaff();
    const other = await makeStaff();
    const objectId = await storageObject(outletA, "document", 0, staff.userId);
    await createLeaveRequest(
      outletScope(outletA),
      staff.userId,
      requestBody(type.id, objectId),
      new Date(),
      stubSigner,
    );
    const result = await failure(
      createLeaveRequest(
        outletScope(outletA),
        other.userId,
        requestBody(type.id, objectId, "04"),
        new Date(),
        stubSigner,
      ),
    );
    expect([result.status, result.code]).toEqual([422, "VALIDATION_ERROR"]);
    expect(await requestCount(other.employee.id)).toBe(0);
  });

  it("the unique index also rejects a duplicate attachment_key at the database", async () => {
    const type = await makeType({ tracksBalance: false });
    const staff = await makeStaff();
    const objectId = await storageObject(outletA, "document", 0, staff.userId);
    await createLeaveRequest(
      outletScope(outletA),
      staff.userId,
      requestBody(type.id, objectId),
      new Date(),
      stubSigner,
    );
    await expect(
      sql(
        `INSERT INTO leave_requests (tenant_id, outlet_id, employee_id, leave_type_id, period_year, start_date, end_date, days, attachment_key, requested_by)
         SELECT tenant_id, outlet_id, employee_id, leave_type_id, period_year, '2031-03-20', '2031-03-20', days, attachment_key, requested_by
         FROM leave_requests WHERE tenant_id = $1 AND attachment_key = $2`,
        [tenantId, objectId],
      ),
    ).rejects.toMatchObject({
      constraint: "leave_requests_tenant_attachment_key",
    });
  });

  it("[storage-object-owner] refuses an upload owned by another user (422, nothing created, ownership untouched)", async () => {
    const type = await makeType({ tracksBalance: false });
    const staff = await makeStaff();
    const other = await makeStaff();
    // Fresh, private, same outlet, unreferenced: only the owner differs.
    const objectId = await storageObject(outletA, "document", 0, other.userId);
    const result = await failure(
      createLeaveRequest(
        outletScope(outletA),
        staff.userId,
        requestBody(type.id, objectId),
        new Date(),
        stubSigner,
      ),
    );
    expect([result.status, result.code]).toEqual([422, "VALIDATION_ERROR"]);
    expect(await requestCount(staff.employee.id)).toBe(0);
    const rows = await sql<Record<string, string | null>>(
      "SELECT owner_user_id, source_kind, source_id FROM core_storage_objects WHERE tenant_id = $1 AND id = $2",
      [tenantId, objectId],
    );
    expect(rows[0]).toEqual({
      owner_user_id: other.userId,
      source_kind: "leave_request",
      source_id: null,
    });
  });

  it("[storage-object-owner] refuses the requester's own upload stored at another outlet than their home outlet (422, nothing linked)", async () => {
    const type = await makeType({ tracksBalance: false });
    const staff = await makeStaff();
    // Owner matches and the file is fresh: only the outlet differs from the home outlet A.
    const objectId = await storageObject(outletB, "document", 0, staff.userId);
    const result = await failure(
      createLeaveRequest(
        outletScope(outletA),
        staff.userId,
        requestBody(type.id, objectId),
        new Date(),
        stubSigner,
      ),
    );
    expect([result.status, result.code]).toEqual([422, "VALIDATION_ERROR"]);
    expect(await requestCount(staff.employee.id)).toBe(0);
    const rows = await sql<Record<string, string | null>>(
      "SELECT source_kind, source_id FROM core_storage_objects WHERE tenant_id = $1 AND id = $2",
      [tenantId, objectId],
    );
    expect(rows[0]).toEqual({ source_kind: "leave_request", source_id: null });
  });

  it("[storage-object-owner] accepts the requester's own upload and links it: source leave_request, source id = the request, owner = requester", async () => {
    const type = await makeType({ tracksBalance: false });
    const staff = await makeStaff();
    const objectId = await storageObject(outletA, "document", 0, staff.userId);
    const created = await createLeaveRequest(
      outletScope(outletA),
      staff.userId,
      requestBody(type.id, objectId),
      new Date(),
      stubSigner,
    );
    const rows = await sql<Record<string, string | null>>(
      "SELECT owner_user_id, source_kind, source_id FROM core_storage_objects WHERE tenant_id = $1 AND id = $2",
      [tenantId, objectId],
    );
    expect(rows[0]).toEqual({
      owner_user_id: staff.userId,
      source_kind: "leave_request",
      source_id: created.id,
    });
  });

  it("[storage-object-owner] a fresh upload with no owner at the home outlet is refused (422, nothing created, nothing linked)", async () => {
    const type = await makeType({ tracksBalance: false });
    const staff = await makeStaff();
    // Only the missing owner differs: private document, fresh, home outlet.
    const objectId = await storageObject(outletA);
    const result = await failure(
      createLeaveRequest(
        outletScope(outletA),
        staff.userId,
        requestBody(type.id, objectId),
        new Date(),
        stubSigner,
      ),
    );
    expect([result.status, result.code]).toEqual([422, "VALIDATION_ERROR"]);
    expect(await requestCount(staff.employee.id)).toBe(0);
    const rows = await sql<Record<string, string | null>>(
      "SELECT owner_user_id, source_kind, source_id FROM core_storage_objects WHERE tenant_id = $1 AND id = $2",
      [tenantId, objectId],
    );
    expect(rows[0]).toEqual({
      owner_user_id: null,
      source_kind: "leave_request",
      source_id: null,
    });
  });

  it("[storage-object-owner] an unowned document object (like a printed-menu render) cannot be claimed as a leave attachment by anyone", async () => {
    const type = await makeType({ tracksBalance: false });
    const staff = await makeStaff();
    const other = await makeStaff();
    // Assumption: a menu-print render is a private `document` object stored
    // at the outlet with no owner (uploaded with actorUserId null).
    const objectId = await storageObject(outletA);
    for (const [who, day] of [
      [staff, "03"],
      [other, "04"],
    ] as const) {
      const result = await failure(
        createLeaveRequest(
          outletScope(outletA),
          who.userId,
          requestBody(type.id, objectId, day),
          new Date(),
          stubSigner,
        ),
      );
      expect([result.status, result.code]).toEqual([422, "VALIDATION_ERROR"]);
      expect(await requestCount(who.employee.id)).toBe(0);
    }
    const rows = await sql<Record<string, string | null>>(
      "SELECT owner_user_id, source_kind, source_id FROM core_storage_objects WHERE tenant_id = $1 AND id = $2",
      [tenantId, objectId],
    );
    expect(rows[0]).toEqual({
      owner_user_id: null,
      source_kind: "leave_request",
      source_id: null,
    });
  });
});

// legend-qu04u: the requester's signed attachment URL needs a LIVE
// self.leave.request grant at the leave's outlet. Assumptions: "revoked" means
// the outlet role assignment's valid_until is in the past (there is no revoke
// flag); a leave-read code elsewhere is hr.employee.view granted tenant-wide,
// which still lets the requester read the row.
describe("legend-qu04u leave attachment requester needs a live grant", () => {
  async function revokeAtOutlet(userId: string) {
    await sql(
      `UPDATE role_assignments SET valid_until = now() - interval '1 minute'
        WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );
  }
  async function grantElsewhere(userId: string) {
    const roleId = randomUUID();
    createdRoles.push(roleId);
    await sql(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `Leave read ${roleId.slice(0, 8)}`,
        JSON.stringify(["hr.employee.view"]),
        JSON.stringify(["tenant"]),
      ],
    );
    await assign(tenantId, userId, roleId, { type: "tenant" });
  }
  async function pending() {
    const type = await makeType({ tracksBalance: false });
    const staff = await makeStaff();
    const objectId = await storageObject(outletA, "document", 0, staff.userId);
    const created = await createLeaveRequest(
      outletScope(outletA),
      staff.userId,
      requestBody(type.id, objectId),
      new Date(),
      stubSigner,
    );
    return { staff, objectId, created };
  }

  it("getLeaveRequest: active requester gets the URL", async () => {
    const { staff, objectId, created } = await pending();
    const seen = await getLeaveRequest(
      outletScope(outletA),
      staff.userId,
      created.id,
      stubSigner,
    );
    expect(seen.attachmentUrl).toBe(`https://signed.example.test/${objectId}`);
  });

  it("getLeaveRequest: requester revoked at the leave outlet but reading elsewhere gets the row, attachmentUrl null, no URL audit", async () => {
    const { staff, created } = await pending();
    const before = (await issuedAudit(created.id)).length;
    await revokeAtOutlet(staff.userId);
    await grantElsewhere(staff.userId);
    const seen = await getLeaveRequest(
      tenantScope(),
      staff.userId,
      created.id,
      stubSigner,
    );
    expect(seen.id).toBe(created.id);
    expect(seen.attachmentUrl).toBeNull();
    expect(await issuedAudit(created.id)).toHaveLength(before);
  });

  it("listLeaveRequests: active requester gets the URL", async () => {
    const { staff, objectId } = await pending();
    const own = await listLeaveRequests(
      outletScope(outletA),
      staff.userId,
      { limit: 20 },
      stubSigner,
    );
    expect(own.data.map((row) => row.attachmentUrl)).toEqual([
      `https://signed.example.test/${objectId}`,
    ]);
  });

  it("listLeaveRequests: requester revoked at the leave outlet but reading elsewhere gets the row, attachmentUrl null, no URL audit", async () => {
    const { staff, created } = await pending();
    const before = (await issuedAudit(created.id)).length;
    await revokeAtOutlet(staff.userId);
    await grantElsewhere(staff.userId);
    const listed = await listLeaveRequests(
      tenantScope(),
      staff.userId,
      { limit: 20 },
      stubSigner,
    );
    const row = listed.data.find((item) => item.id === created.id);
    expect(row).toBeDefined();
    expect(row?.attachmentUrl).toBeNull();
    expect(await issuedAudit(created.id)).toHaveLength(before);
  });
});
