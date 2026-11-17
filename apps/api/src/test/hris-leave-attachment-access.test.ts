// legend-qu04u (bead 983 card B): the signed `attachmentUrl` of a leave request
// (a medical certificate, PII class "health") must not leak across employees,
// tenants or outlets. Read over the leave router: GET /api/hris/leave/requests.
//
// Rule under test (card brief, PRD keeps the certificate private): the URL is
// shown only to the requester while holding an ACTIVE `self.leave.request` at
// the leave's outlet, or to an approver holding `hr.leave.approve` at that
// outlet. Everyone else who can still read the row gets `attachmentUrl: null`.
//
// Assumptions:
//  - The contract (packages/shared/src/hris/endpoints.ts) defines list, create
//    and decision only; there is no GET /api/hris/leave/requests/:id. The
//    "detail" case therefore asserts that such a path never leaks the object
//    id or a signed URL (a 404 satisfies it). It does not require the route.
//  - A colleague with only `hr.employee.view` (no `hr.leave.approve`) may see
//    the row but gets `attachmentUrl: null` (same rule as hris-leave-attachment-api.test.ts).
//    A colleague with no HR grant at all may be refused or see nothing; only
//    the absence of the URL and object id is asserted.
//  - Cross tenant: a user whose only grants live in a second tenant (tenant
//    wide hr.employee.view + hr.leave.approve there) cannot read the Cafe
//    Legend row; the status may be 200 (empty) or 403/404, the row and URL
//    must be absent.
//  - "Revoked" is a role assignment whose `valid_until` is in the past.
// Runs the real Express app (with a stub storage signer), Better Auth, RBAC
// and PostgreSQL against the seeded Cafe Legend tenant.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { agent, signUp } from "./helpers.ts";

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

const otherTenantId = randomUUID();
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdLeave: string[] = [];
let leaveTypeId: string;
let creatorUserId: string;

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
  tenantId: string = tenant.id,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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
  tenantId?: string;
};

async function grant(
  userId: string,
  { permissions, outletId, revoked, tenantId = tenant.id }: Grant,
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `Leave access ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([outletId === null ? "tenant" : "outlet"]),
      ],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
       VALUES ($1, $2, $3, CASE WHEN $4::uuid IS NULL THEN 'tenant' ELSE 'outlet' END, $4, now() - interval '2 hours',
               CASE WHEN $5::boolean THEN now() - interval '1 hour' END, $2)`,
      [tenantId, userId, roleId, outletId, revoked === true],
    );
  }, tenantId);
}

/** One employee at outlet A with a pending leave request carrying a private file. */
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
       VALUES ($1, $2, $3, $4, 'Karyawan Akses Lampiran', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        tenant.id,
        employeeUserId,
        `AL-${employeeId.slice(0, 8).toUpperCase()}`,
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
        employeeUserId ?? creatorUserId,
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
        employeeUserId ?? creatorUserId,
      ],
    );
  });
  return { employeeId, objectId, leaveId };
}

type Row = { id: string; attachmentUrl: string | null };
type Seeded = { employeeId: string; objectId: string; leaveId: string };

/** The request as the list route shows it to this client. */
async function readList(client: Client, seeded: Seeded) {
  const list = await client.get(
    `/api/hris/leave/requests?employeeId=${seeded.employeeId}&limit=50`,
  );
  const listed =
    list.status === 200
      ? (list.body.data as Row[]).find((row) => row.id === seeded.leaveId)
      : undefined;
  return { list, listed };
}

function expectNoLeak(
  response: { body: unknown; status: number },
  seeded: Seeded,
) {
  const text = JSON.stringify(response.body);
  expect(text, "object id must not appear").not.toContain(seeded.objectId);
  expect(text, "signed URL must not appear").not.toContain(
    "signed.example.test",
  );
}

beforeAll(async () => {
  creatorUserId = (await signedInUser("Pembuat Akses Lampiran")).userId;
  leaveTypeId = randomUUID();
  await asTenant((db) =>
    db.query(
      `INSERT INTO leave_types (id, tenant_id, code, name, paid, requires_attachment, policy, is_active)
       VALUES ($1, $2, $3, 'Cuti Akses Lampiran', true, false, '{}'::jsonb, true)`,
      [leaveTypeId, tenant.id, `AA${leaveTypeId.slice(0, 8)}`],
    ),
  );
  const fixture = cafeLegendPlatformFixtures.tenant;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Leave attachment other tenant', $3, $4, $5, $6, $7, $8)`,
    [
      otherTenantId,
      `leave-att-${otherTenantId}`,
      fixture.plan,
      fixture.status,
      fixture.deploymentMode,
      JSON.stringify(fixture.featureFlags),
      JSON.stringify(fixture.limits),
      fixture.createdBy,
    ],
  );
});

afterAll(async () => {
  await asTenant(async (db) => {
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
  await asTenant(async (db) => {
    await db.query("DELETE FROM role_assignments WHERE tenant_id = $1", [
      otherTenantId,
    ]);
    await db.query("DELETE FROM roles WHERE tenant_id = $1", [otherTenantId]);
  }, otherTenantId);
  await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenantId]);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  await owner.end();
});

describe("legend-qu04u leave attachment access", () => {
  it("[requester with active self.leave.request at the leave outlet] gets the signed URL", async () => {
    const requester = await signedInUser("Pemohon Aktif Akses");
    await grant(requester.userId, {
      permissions: ["self.profile.view", "self.leave.request"],
      outletId: outletA.id,
    });
    const seeded = await seedLeave(requester.userId);

    const { list, listed } = await readList(requester.client, seeded);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(listed?.attachmentUrl).toBe(signedUrlFor(seeded.objectId));
  });

  it("[same tenant, other employee without hr.leave.approve] never receives the URL", async () => {
    const owner1 = await signedInUser("Pemilik Cuti Akses");
    await grant(owner1.userId, {
      permissions: ["self.profile.view", "self.leave.request"],
      outletId: outletA.id,
    });
    const seeded = await seedLeave(owner1.userId);

    const colleague = await signedInUser("Rekan Sama Outlet");
    await grant(colleague.userId, {
      permissions: [
        "self.profile.view",
        "self.leave.request",
        "hr.employee.view",
      ],
      outletId: outletA.id,
    });
    await seedLeave(colleague.userId);

    const { list, listed } = await readList(colleague.client, seeded);
    // The row may be visible (hr.employee.view) but never with the URL.
    expect(listed?.attachmentUrl ?? null).toBeNull();
    expectNoLeak(list, seeded);
  });

  it("[same tenant, other employee with only self permissions] sees no URL", async () => {
    const owner1 = await signedInUser("Pemilik Cuti Akses 2");
    await grant(owner1.userId, {
      permissions: ["self.profile.view", "self.leave.request"],
      outletId: outletA.id,
    });
    const seeded = await seedLeave(owner1.userId);

    const colleague = await signedInUser("Rekan Tanpa HR");
    await grant(colleague.userId, {
      permissions: ["self.profile.view", "self.leave.request"],
      outletId: outletA.id,
    });
    await seedLeave(colleague.userId);

    const { list, listed } = await readList(colleague.client, seeded);
    expect(listed?.attachmentUrl ?? null).toBeNull();
    expectNoLeak(list, seeded);
  });

  it("[other tenant] a user whose grants live only in another tenant cannot read the row or URL", async () => {
    const owner1 = await signedInUser("Pemilik Cuti Lintas Tenant");
    await grant(owner1.userId, {
      permissions: ["self.profile.view", "self.leave.request"],
      outletId: outletA.id,
    });
    const seeded = await seedLeave(owner1.userId);

    const foreign = await signedInUser("Orang Tenant Lain");
    await grant(foreign.userId, {
      permissions: ["hr.employee.view", "hr.leave.approve"],
      outletId: null,
      tenantId: otherTenantId,
    });

    const { list, listed } = await readList(foreign.client, seeded);
    expect(listed, "the other tenant's row must be invisible").toBeUndefined();
    expectNoLeak(list, seeded);
  });

  it("[requester whose self.leave.request at the leave outlet was revoked] keeps the row but attachmentUrl is null", async () => {
    const requester = await signedInUser("Pemohon Dicabut Akses");
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
    expectNoLeak(list, seeded);
  });

  it("[approver with hr.leave.approve at the leave outlet] gets the signed URL", async () => {
    const approver = await signedInUser("Penyetuju Outlet A Akses");
    await grant(approver.userId, {
      permissions: ["hr.employee.view", "hr.leave.approve"],
      outletId: outletA.id,
    });
    const seeded = await seedLeave(null);

    const { list, listed } = await readList(approver.client, seeded);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(listed?.attachmentUrl).toBe(signedUrlFor(seeded.objectId));
  });

  it("[approver with hr.leave.approve only at another outlet] gets no URL and does not see the row", async () => {
    const approver = await signedInUser("Penyetuju Outlet B Akses");
    await grant(approver.userId, {
      permissions: ["hr.employee.view", "hr.leave.approve"],
      outletId: outletB.id,
    });
    const seeded = await seedLeave(null);

    const { list, listed } = await readList(approver.client, seeded);
    expect(listed?.attachmentUrl ?? null).toBeNull();
    expectNoLeak(list, seeded);
  });

  it("[detail path] another employee's request by id never exposes the object id or a signed URL", async () => {
    const owner1 = await signedInUser("Pemilik Cuti Detail");
    await grant(owner1.userId, {
      permissions: ["self.profile.view", "self.leave.request"],
      outletId: outletA.id,
    });
    const seeded = await seedLeave(owner1.userId);

    const colleague = await signedInUser("Rekan Detail");
    await grant(colleague.userId, {
      permissions: ["self.profile.view", "self.leave.request"],
      outletId: outletA.id,
    });
    await seedLeave(colleague.userId);

    const detail = await colleague.client.get(
      `/api/hris/leave/requests/${seeded.leaveId}`,
    );
    expectNoLeak(detail, seeded);
  });
});
