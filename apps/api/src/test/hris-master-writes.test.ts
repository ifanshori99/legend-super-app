// Paket C: legend-zygi; F24 HR-01/03, TEN-01/02/03. Contract-first HTTP
// coverage using the real session, scoped permissions and disposable DB.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures as fixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createSecondTenant,
  removeSecondTenant,
  requireDisposableDatabase,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

requireDisposableDatabase();
const app = createApp({ storageRuntime: null });
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const tenantId = fixtures.tenant.id;
const [outlet, otherOutlet] = fixtures.outlets;
type Client = ReturnType<typeof agent>;
let hr: Client;
let scopedHr: Client;
let staff: Client;
let hrUserId: string;
let foreignUserId: string;
let tenantB: SecondTenant;
let ownEmployeeId: string;
let otherEmployeeId: string;
let foreignEmployeeId: string;
let foreignUnitId: string;
let documentId: string;
const users: string[] = [];
const roles: string[] = [];
const prefix = `CW-${randomUUID().slice(0, 8).toUpperCase()}`;
const key = () => `master-write-${randomUUID()}`;

async function asTenant<T>(
  run: (db: PoolClient) => Promise<T>,
  id: string = tenantId,
) {
  const db = await owner.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [id],
    );
    const result = await run(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

async function signIn(
  name: string,
  permissions: string[],
  scope: string | null,
  id: string = tenantId,
) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  users.push(userId);
  await verifySessionMfa(email);
  const roleId = randomUUID();
  roles.push(roleId);
  const scopeType = scope === null ? "tenant" : "outlet";
  await asTenant(async (db) => {
    await db.query(
      "INSERT INTO roles (id,tenant_id,name,is_template,permissions,allowed_scope_types) VALUES ($1,$2,$3,false,$4,$5)",
      [
        roleId,
        id,
        `${prefix}-${roleId}`,
        JSON.stringify(permissions),
        JSON.stringify([scopeType]),
      ],
    );
    await db.query(
      "INSERT INTO role_assignments (tenant_id,user_id,role_id,scope_type,scope_id,valid_from,assigned_by) VALUES ($1,$2,$3,$4,$5,now()-interval '1 hour',$2)",
      [id, userId, roleId, scopeType, scope],
    );
  }, id);
  return { client, userId, roleId };
}

async function seedEmployee(id: string, outletId: string) {
  const employeeId = randomUUID();
  await asTenant(
    (db) =>
      db.query(
        "INSERT INTO employees (id,tenant_id,employee_no,full_name,home_outlet_id,employment_type,join_date,status) VALUES ($1,$2,$3,'Master write fixture',$4,'pkwtt','2026-01-01','active')",
        [
          employeeId,
          id,
          `${prefix}-${employeeId.slice(0, 8).toUpperCase()}`,
          outletId,
        ],
      ),
    id,
  );
  return employeeId;
}
const post = (client: Client, path: string, body: object) =>
  client.post(`/api/hris${path}`).set(originHeader).send(body);
const employeeBody = (overrides: Record<string, unknown> = {}) => ({
  userId: null,
  legalEntityId: null,
  employeeNo: `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`,
  fullName: "Karyawan kontrak baru",
  positionId: null,
  orgUnitId: null,
  managerId: null,
  homeOutletId: outlet.id,
  employmentType: "pkwtt",
  joinDate: "2026-11-12",
  endDate: null,
  ptkpStatus: null,
  status: "onboarding",
  idempotencyKey: key(),
  ...overrides,
});
const contractBody = (
  employeeId: string,
  overrides: Record<string, unknown> = {},
) => ({
  employeeId,
  type: "pkwtt",
  taxScheme: "gross",
  startDate: "2026-11-12",
  endDate: null,
  renewedFromId: null,
  salarySnapshotIdr: null,
  fileObjectId: null,
  reminderDaysBefore: 30,
  status: "draft",
  idempotencyKey: key(),
  ...overrides,
});
const denied = (response: { status: number; body: unknown }) =>
  expect([403, 404], JSON.stringify(response.body)).toContain(response.status);
const created = (response: {
  status: number;
  body: { data: Record<string, unknown> };
}) => {
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data;
};

beforeAll(async () => {
  tenantB = await createSecondTenant(owner, "contractwrites");
  const admin = await signIn(
    "Master HR tenant",
    ["hr.employee.manage", "hr.employee.view"],
    null,
  );
  hr = admin.client;
  hrUserId = admin.userId;
  scopedHr = (
    await signIn(
      "Master HR outlet",
      ["hr.employee.manage", "hr.employee.view"],
      outlet.id,
    )
  ).client;
  staff = (await signIn("Master staff", ["self.profile.view"], outlet.id))
    .client;
  foreignUserId = (
    await signIn(
      "Master foreign",
      ["self.profile.view"],
      tenantB.outletId,
      tenantB.tenantId,
    )
  ).userId;
  ownEmployeeId = await seedEmployee(tenantId, outlet.id);
  otherEmployeeId = await seedEmployee(tenantId, otherOutlet.id);
  foreignEmployeeId = await seedEmployee(tenantB.tenantId, tenantB.outletId);
  foreignUnitId = randomUUID();
  await asTenant(
    (db) =>
      db.query(
        "INSERT INTO org_units (id,tenant_id,code,name) VALUES ($1,$2,$3,'Foreign unit')",
        [foreignUnitId, tenantB.tenantId, `${prefix}-B`],
      ),
    tenantB.tenantId,
  );
  documentId = randomUUID();
  await asTenant((db) =>
    db.query(
      "INSERT INTO core_storage_objects (tenant_id,outlet_id,id,purpose,object_key,content_type,size_bytes,owner_user_id) VALUES ($1,$2,$3,'document',$4,'application/pdf',2048,$5)",
      [
        tenantId,
        outlet.id,
        documentId,
        `document/${documentId}/original.pdf`,
        hrUserId,
      ],
    ),
  );
});

afterAll(async () => {
  // The database is disposable; fixture outlets stay when append-only audit
  // rows refer to them. Remove foreign tenant rows, which were never mutated.
  await asTenant(async (db) => {
    await db.query("DELETE FROM employees WHERE tenant_id=$1", [
      tenantB.tenantId,
    ]);
    await db.query("DELETE FROM org_units WHERE tenant_id=$1", [
      tenantB.tenantId,
    ]);
    await db.query("DELETE FROM role_assignments WHERE tenant_id=$1", [
      tenantB.tenantId,
    ]);
    await db.query("DELETE FROM roles WHERE tenant_id=$1", [tenantB.tenantId]);
  }, tenantB.tenantId);
  await removeSecondTenant(owner, tenantB);
  await owner.end();
});

describe("[legend-zygi F24] master writes", () => {
  it("[legend-zygi HR-03] a contract replay respects salary visibility after read permission is revoked", async () => {
    const actor = await signIn(
      "Master salary visibility",
      ["hr.employee.manage", "hr.employee.view"],
      outlet.id,
    );
    const body = contractBody(ownEmployeeId, { salarySnapshotIdr: 3_100_000 });
    const first = created(
      await post(actor.client, "/employment-contracts", body),
    );
    expect(first.salarySnapshot).not.toBeNull();
    const before = await actor.client.get(
      `/api/hris/employment-contracts/${first.id as string}`,
    );
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.data.salarySnapshot).not.toBeNull();

    // Keep write authorization; revoke only the permission that allowed
    // reading the salary when the original response entered the cache.
    await asTenant((db) =>
      db.query("UPDATE roles SET permissions=$1 WHERE tenant_id=$2 AND id=$3", [
        JSON.stringify(["hr.employee.manage"]),
        tenantId,
        actor.roleId,
      ]),
    );
    const current = await actor.client.get(
      `/api/hris/employment-contracts/${first.id as string}`,
    );
    expect([200, 403], JSON.stringify(current.body)).toContain(current.status);
    if (current.status === 200)
      expect(current.body.data.salarySnapshot).toBeNull();

    const replay = await post(actor.client, "/employment-contracts", body);
    expect([201, 200, 403, 409], JSON.stringify(replay.body)).toContain(
      replay.status,
    );
    if (replay.status < 300) {
      expect(replay.body.data.id).toBe(first.id);
      expect(replay.body.data.salarySnapshot).toBeNull();
    }
  });

  it("[legend-zygi F24] same-actor retries are idempotent for all six writes after file ownership transfer", async () => {
    async function retry(path: string, body: object) {
      const first = created(await post(hr, path, body));
      const again = created(await post(hr, path, body));
      expect(again.id, path).toBe(first.id);
      return first;
    }
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    const unit = await retry("/org-units", {
      parentId: null,
      code: `${prefix}-${suffix}`,
      name: "Retry unit",
      isActive: true,
      idempotencyKey: key(),
    });
    const grade = await retry("/position-grades", {
      code: `${prefix}-${suffix}`,
      name: "Retry grade",
      level: 1,
      idempotencyKey: key(),
    });
    const position = await retry("/positions", {
      name: `Retry position ${suffix}`,
      orgUnitId: unit.id,
      gradeId: grade.id,
      serviceChargePoints: "0.0000",
      isActive: true,
      idempotencyKey: key(),
    });
    const employee = await retry(
      "/employees",
      employeeBody({ orgUnitId: unit.id, positionId: position.id }),
    );
    async function freshDocumentObject() {
      const id = randomUUID();
      await asTenant((db) =>
        db.query(
          "INSERT INTO core_storage_objects (tenant_id,outlet_id,id,purpose,object_key,content_type,size_bytes,owner_user_id) VALUES ($1,$2,$3,'document',$4,'application/pdf',2048,$5)",
          [tenantId, outlet.id, id, `document/${id}/original.pdf`, hrUserId],
        ),
      );
      return id;
    }
    const contractObjectId = await freshDocumentObject();
    await retry(
      "/employment-contracts",
      contractBody(employee.id as string, { fileObjectId: contractObjectId }),
    );
    const employeeObjectId = await freshDocumentObject();
    await retry(`/employees/${employee.id as string}/documents`, {
      type: "ktp",
      storageObjectId: employeeObjectId,
      expiresOn: null,
      idempotencyKey: key(),
    });
    const counts = await asTenant(async (db) => {
      const contracts = await db.query(
        "SELECT count(*)::int AS count FROM employment_contracts WHERE tenant_id=$1 AND employee_id=$2",
        [tenantId, employee.id],
      );
      const documents = await db.query(
        "SELECT count(*)::int AS count FROM employee_documents WHERE tenant_id=$1 AND employee_id=$2",
        [tenantId, employee.id],
      );
      return {
        contracts: contracts.rows[0].count,
        documents: documents.rows[0].count,
      };
    });
    expect(counts).toEqual({ contracts: 1, documents: 1 });
  });

  it("[legend-zygi TEN-01] renewal cannot reference another employee's contract", async () => {
    const original = created(
      await post(hr, "/employment-contracts", contractBody(ownEmployeeId)),
    );
    const response = await post(
      hr,
      "/employment-contracts",
      contractBody(otherEmployeeId, { renewedFromId: original.id }),
    );
    expect([403, 404, 409, 422], JSON.stringify(response.body)).toContain(
      response.status,
    );
  });

  it("[legend-zygi TEN-03] another actor cannot replay the same master write key", async () => {
    const body = employeeBody();
    const first = created(await post(hr, "/employees", body));
    const replay = await post(scopedHr, "/employees", body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(409);
    const rows = await asTenant((db) =>
      db.query(
        "SELECT id FROM employees WHERE tenant_id=$1 AND employee_no=$2",
        [tenantId, body.employeeNo],
      ),
    );
    expect(rows.rows.map((row) => row.id)).toEqual([first.id]);
  });

  it("[legend-zygi TEN-03] revoked master permission cannot replay a successful key", async () => {
    const transient = await signIn(
      "Master transient",
      ["hr.employee.manage", "hr.employee.view"],
      outlet.id,
    );
    const body = employeeBody();
    created(await post(transient.client, "/employees", body));
    await asTenant((db) =>
      db.query(
        "DELETE FROM role_assignments WHERE tenant_id=$1 AND user_id=$2",
        [tenantId, transient.userId],
      ),
    );
    expect((await post(transient.client, "/employees", body)).status).toBe(403);
  });

  it("[legend-zygi HR-01/03] creates organisation, position, employee, contract and document through HTTP", async () => {
    const unit = created(
      await post(hr, "/org-units", {
        parentId: null,
        code: `${prefix}-UNIT`,
        name: "Kontrak Unit",
        isActive: true,
        idempotencyKey: key(),
      }),
    );
    const grade = created(
      await post(hr, "/position-grades", {
        code: `${prefix}-GRADE`,
        name: "Kontrak Grade",
        level: 1,
        idempotencyKey: key(),
      }),
    );
    const position = created(
      await post(hr, "/positions", {
        name: "Kontrak Position",
        orgUnitId: unit.id,
        gradeId: grade.id,
        serviceChargePoints: "0.0000",
        isActive: true,
        idempotencyKey: key(),
      }),
    );
    const body = employeeBody({ orgUnitId: unit.id, positionId: position.id });
    const employee = created(await post(hr, "/employees", body));
    expect(employee).toMatchObject({
      tenantId,
      homeOutletId: outlet.id,
      employeeNo: body.employeeNo,
      orgUnitId: unit.id,
      positionId: position.id,
    });
    expect(employee).not.toHaveProperty("pii");
    const read = await hr.get(`/api/hris/employees/${employee.id as string}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data.id).toBe(employee.id);
    const contract = created(
      await post(
        hr,
        "/employment-contracts",
        contractBody(employee.id as string),
      ),
    );
    expect(contract).toMatchObject({
      employeeId: employee.id,
      status: "draft",
      salarySnapshot: null,
      fileUrl: null,
    });
    const document = created(
      await post(hr, `/employees/${employee.id as string}/documents`, {
        type: "ktp",
        storageObjectId: documentId,
        expiresOn: null,
        idempotencyKey: key(),
      }),
    );
    expect(document).toMatchObject({
      employeeId: employee.id,
      type: "ktp",
      downloadUrl: null,
    });
    expect(JSON.stringify(document)).not.toContain("original.pdf");
  });

  it("[legend-zygi TEN-03] outlet HR cannot create an employee at another outlet", async () => {
    created(await post(scopedHr, "/employees", employeeBody()));
    denied(
      await post(
        scopedHr,
        "/employees",
        employeeBody({ homeOutletId: otherOutlet.id }),
      ),
    );
  });

  it("[legend-zygi TEN-01] another tenant outlet and organisation cannot be used as references", async () => {
    created(await post(hr, "/employees", employeeBody()));
    denied(
      await post(
        hr,
        "/employees",
        employeeBody({ homeOutletId: tenantB.outletId }),
      ),
    );
    denied(
      await post(hr, "/employees", employeeBody({ orgUnitId: foreignUnitId })),
    );
    denied(
      await post(hr, "/org-units", {
        parentId: foreignUnitId,
        code: `${prefix}-BAD`,
        name: "Foreign parent",
        idempotencyKey: key(),
      }),
    );
  });

  it("[legend-zygi TEN-01] a global login belonging only to another tenant cannot be linked", async () => {
    created(await post(hr, "/employees", employeeBody()));
    denied(
      await post(hr, "/employees", employeeBody({ userId: foreignUserId })),
    );
  });

  it("[legend-zygi TEN-03] outlet HR cannot attach a manager from outside their scope", async () => {
    created(
      await post(
        scopedHr,
        "/employees",
        employeeBody({ managerId: ownEmployeeId }),
      ),
    );
    denied(
      await post(
        scopedHr,
        "/employees",
        employeeBody({ managerId: otherEmployeeId }),
      ),
    );
  });

  it("[legend-zygi TEN-01/03] foreign employee contract and document writes are denied", async () => {
    created(
      await post(hr, "/employment-contracts", contractBody(ownEmployeeId)),
    );
    denied(
      await post(
        scopedHr,
        "/employment-contracts",
        contractBody(otherEmployeeId),
      ),
    );
    denied(
      await post(hr, "/employment-contracts", contractBody(foreignEmployeeId)),
    );
    for (const [client, employeeId] of [
      [scopedHr, otherEmployeeId],
      [hr, foreignEmployeeId],
    ] as const)
      denied(
        await post(client, `/employees/${employeeId}/documents`, {
          type: "ktp",
          storageObjectId: documentId,
          expiresOn: null,
          idempotencyKey: key(),
        }),
      );
  });

  it("[legend-zygi HR-01] employees cannot write any master resource", async () => {
    const paths = [
      ["/employees", employeeBody()],
      [
        "/org-units",
        {
          parentId: null,
          code: `${prefix}-STAFF`,
          name: "Staff unit",
          idempotencyKey: key(),
        },
      ],
      [
        "/position-grades",
        {
          code: `${prefix}-STAFF`,
          name: "Staff grade",
          level: 1,
          idempotencyKey: key(),
        },
      ],
      [
        "/positions",
        {
          name: "Staff position",
          gradeId: null,
          orgUnitId: null,
          serviceChargePoints: "0.0000",
          idempotencyKey: key(),
        },
      ],
      ["/employment-contracts", contractBody(ownEmployeeId)],
      [
        `/employees/${ownEmployeeId}/documents`,
        {
          type: "ktp",
          storageObjectId: documentId,
          expiresOn: null,
          idempotencyKey: key(),
        },
      ],
    ] as const;
    for (const [path, body] of paths)
      expect((await post(staff, path, body)).status, path).toBe(403);
  });

  it("[legend-zygi TEN-02] client tenantId is rejected by every master write body", async () => {
    for (const [path, body] of [
      ["/employees", employeeBody()],
      [
        "/org-units",
        {
          parentId: null,
          code: `${prefix}-TENANT`,
          name: "Tenant unit",
          idempotencyKey: key(),
        },
      ],
      [
        "/positions",
        {
          name: "Tenant position",
          gradeId: null,
          orgUnitId: null,
          serviceChargePoints: "0.0000",
          idempotencyKey: key(),
        },
      ],
      ["/employment-contracts", contractBody(ownEmployeeId)],
      [
        `/employees/${ownEmployeeId}/documents`,
        {
          type: "ktp",
          storageObjectId: documentId,
          expiresOn: null,
          idempotencyKey: key(),
        },
      ],
    ] as const)
      expect(
        (await post(hr, path, { ...body, tenantId: tenantB.tenantId })).status,
        path,
      ).toBe(422);
  });
});
