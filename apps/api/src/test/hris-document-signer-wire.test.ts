// legend-2ect: the production-mounted app hands hrisRouter and hrisLeaveRouter
// the storage runtime's `hrisDocumentSigner`. With a runtime, leave
// `attachmentUrl`, contract `fileUrl` and employee document `downloadUrl` are
// non-null, and the signer gets the caller's transaction (no second pooled
// connection per row). With `storageRuntime: null` all three stay null.
// Signing itself is covered by core-storage-runtime.test.ts. Runs the real
// Express app, Better Auth, RBAC and PostgreSQL against the seeded Cafe Legend
// tenant.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { ObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { createHrisLeaveRouter } from "../routes/hris-leave.routes.ts";
import { createHrisRouter } from "../routes/hris.routes.ts";
import { HRIS_SIGNED_SEGMENTS } from "../routes/storage-api.routes.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { agent, signUp, verifySessionMfa } from "./helpers.ts";

const tenant = cafeLegendPlatformFixtures.tenant;
const outletId = cafeLegendPlatformFixtures.outlets[0].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const signedUrlFor = (objectId: string) =>
  `https://signed.example.test/document/${objectId}?sig=fake`;

// Every sign call the routes make, and whether it carried the caller's tx.
const calls: { objectId: string; withTx: boolean }[] = [];
const withStorage: StorageRuntime = {
  storage: {} as ObjectStorage,
  scanner: new NoopMalwareScanner(),
  // The selfie signer must never be used for HRIS documents.
  fileSigner: async () => null,
  hrisDocumentSigner: async (_context, objectId, tx) => {
    calls.push({ objectId, withTx: tx !== undefined });
    return signedUrlFor(objectId);
  },
};
const appWithStorage = createApp({ storageRuntime: withStorage });
const appWithoutStorage = createApp({ storageRuntime: null });

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdTypes: string[] = [];
const createdContracts: string[] = [];
const createdLeave: string[] = [];
const createdDocuments: string[] = [];

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

type App = ReturnType<typeof createApp>;

async function hrManager(app: App, name: string) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  await verifySessionMfa(email);
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, '["tenant"]')`,
      [
        roleId,
        tenant.id,
        `Signer wire ${roleId.slice(0, 8)}`,
        JSON.stringify([
          "hr.employee.view",
          "hr.employee.manage",
          "hr.leave.approve",
        ]),
      ],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
      [tenant.id, userId, roleId],
    );
  });
  return { client, userId };
}

async function documentObject(userId: string) {
  const objectId = randomUUID();
  await asTenant((db) =>
    db.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, owner_user_id)
       VALUES ($1, $2, $3, 'document', $4, 'application/pdf', 2048, $5)`,
      [
        tenant.id,
        outletId,
        objectId,
        `document/${objectId}/original.pdf`,
        userId,
      ],
    ),
  );
  return objectId;
}

/** An employee with one document, one contract and one leave request, each with a file. */
async function seedPerson(userId: string) {
  const employeeId = randomUUID();
  createdEmployees.push(employeeId);
  const documentFile = await documentObject(userId);
  const contractFile = await documentObject(userId);
  const leaveFile = await documentObject(userId);
  const documentId = randomUUID();
  const contractId = randomUUID();
  const leaveTypeId = randomUUID();
  const leaveId = randomUUID();
  createdDocuments.push(documentId);
  createdContracts.push(contractId);
  createdTypes.push(leaveTypeId);
  createdLeave.push(leaveId);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, 'Karyawan Signer Wire', $4, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        tenant.id,
        `SW-${employeeId.slice(0, 8).toUpperCase()}`,
        outletId,
      ],
    );
    await db.query(
      `INSERT INTO employee_documents (id, tenant_id, employee_id, type, storage_object_id, uploaded_by)
       VALUES ($1, $2, $3, 'other', $4, $5)`,
      [documentId, tenant.id, employeeId, documentFile, userId],
    );
    await db.query(
      `INSERT INTO employment_contracts (id, tenant_id, employee_id, type, tax_scheme, start_date,
                                         file_object_id, reminder_days_before, status)
       VALUES ($1, $2, $3, 'pkwtt', 'gross', '2025-03-01', $4, 30, 'active')`,
      [contractId, tenant.id, employeeId, contractFile],
    );
    await db.query(
      `INSERT INTO leave_types (id, tenant_id, code, name, paid, requires_attachment, policy, is_active)
       VALUES ($1, $2, $3, 'Cuti Signer Wire', true, false, '{}'::jsonb, true)`,
      [leaveTypeId, tenant.id, `SW${leaveTypeId.slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO leave_requests (id, tenant_id, outlet_id, employee_id, leave_type_id, period_year,
                                   start_date, end_date, days, attachment_key, status, requested_by)
       VALUES ($1, $2, $3, $4, $5, 2026, '2026-03-02', '2026-03-02', 1, $6, 'pending', $7)`,
      [
        leaveId,
        tenant.id,
        outletId,
        employeeId,
        leaveTypeId,
        leaveFile,
        userId,
      ],
    );
  });
  return {
    employeeId,
    documentFile,
    contractFile,
    leaveFile,
    contractId,
    leaveId,
  };
}

afterAll(async () => {
  await asTenant(async (db) => {
    const byId = (table: string, ids: string[]) =>
      db.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenant.id, ids],
      );
    await byId("leave_requests", createdLeave);
    await byId("leave_types", createdTypes);
    await byId("employment_contracts", createdContracts);
    await byId("employee_documents", createdDocuments);
    await byId("employees", createdEmployees);
    await db.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await byId("roles", createdRoles);
    // Storage objects stay: audit_logs is append-only and references them
    // (disposable DB).
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  await owner.end();
});

beforeAll(() => {
  calls.length = 0;
});

describe("createApp with a storage runtime", () => {
  it("signs leave attachment, contract file and employee document URLs", async () => {
    const hr = await hrManager(appWithStorage, "HR Signer Wire Ada");
    const person = await seedPerson(hr.userId);
    calls.length = 0;

    const documents = await hr.client.get(
      `/api/hris/employees/${person.employeeId}/documents`,
    );
    expect(documents.status, JSON.stringify(documents.body)).toBe(200);
    expect(documents.body.data[0].downloadUrl).toBe(
      signedUrlFor(person.documentFile),
    );

    const contract = await hr.client.get(
      `/api/hris/employment-contracts/${person.contractId}`,
    );
    expect(contract.status, JSON.stringify(contract.body)).toBe(200);
    expect(contract.body.data.fileUrl).toBe(signedUrlFor(person.contractFile));

    const leave = await hr.client.get("/api/hris/leave/requests");
    expect(leave.status, JSON.stringify(leave.body)).toBe(200);
    const request = (
      leave.body.data as { id: string; attachmentUrl: string | null }[]
    ).find((entry) => entry.id === person.leaveId);
    expect(request?.attachmentUrl).toBe(signedUrlFor(person.leaveFile));

    // The caller's transaction reaches the signer on all three paths.
    for (const objectId of [
      person.documentFile,
      person.contractFile,
      person.leaveFile,
    ])
      expect(
        calls.filter((call) => call.objectId === objectId),
        objectId,
      ).not.toHaveLength(0);
    expect(calls.filter((call) => !call.withTx)).toEqual([]);
  });
});

describe("createApp with storageRuntime null", () => {
  it("answers the same three reads with null URLs", async () => {
    const hr = await hrManager(appWithoutStorage, "HR Signer Wire Tanpa");
    const person = await seedPerson(hr.userId);

    const documents = await hr.client.get(
      `/api/hris/employees/${person.employeeId}/documents`,
    );
    expect(documents.status, JSON.stringify(documents.body)).toBe(200);
    expect(documents.body.data[0].downloadUrl).toBeNull();

    const contract = await hr.client.get(
      `/api/hris/employment-contracts/${person.contractId}`,
    );
    expect(contract.status, JSON.stringify(contract.body)).toBe(200);
    expect(contract.body.data.fileUrl).toBeNull();

    const leave = await hr.client.get("/api/hris/leave/requests");
    expect(leave.status, JSON.stringify(leave.body)).toBe(200);
    const request = (
      leave.body.data as { id: string; attachmentUrl: string | null }[]
    ).find((entry) => entry.id === person.leaveId);
    expect(request).toBeDefined();
    expect(request?.attachmentUrl).toBeNull();
  });

  it("keeps the payroll self routes ahead of /hris", async () => {
    const hr = await hrManager(appWithoutStorage, "HR Signer Wire Urutan");
    for (const path of ["/api/hris/me/loans", "/api/hris/me/reimbursements"]) {
      const response = await hr.client.get(path);
      // Answered by the payroll routers (not the /hris catch-all 404).
      expect(response.status, path).not.toBe(404);
    }
  });
});

describe("the /hris segment gate", () => {
  it("matches the segment case-insensitively, like Express routing", async () => {
    const hr = await hrManager(appWithStorage, "HR Signer Wire Huruf");
    const response = await hr.client.get("/api/hris/Employees");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  it("lists every first path segment of hrisRouter and hrisLeaveRouter", () => {
    type Layer = { route?: { path: unknown } };
    const paths: string[] = [];
    for (const router of [createHrisRouter(), createHrisLeaveRouter()])
      for (const layer of (router as unknown as { stack: Layer[] }).stack) {
        if (layer.route === undefined) continue;
        const path = layer.route.path;
        if (typeof path !== "string")
          throw new Error(`non-string route path: ${String(path)}`);
        paths.push(path);
      }
    expect(paths).not.toHaveLength(0);
    for (const path of paths) {
      const [segment] = path.split("/").filter(Boolean);
      // `/me` is matched exactly by the gate, beside the set.
      if (path === "/me") continue;
      expect(HRIS_SIGNED_SEGMENTS.has(segment ?? ""), path).toBe(true);
    }
  });
});
