// Work certificate ("Surat Keterangan Kerja") over HTTP (WS-10 lifecycle,
// brief 299; HR-01; TEN-01/02/03). Runs the real Express app, Better Auth, the
// RBAC resolver and PostgreSQL against the seeded Cafe Legend tenant plus a
// throwaway second tenant. Offboardings are seeded straight into the table in
// the state under test; the offboarding routes belong to another slice.
//
// Needs `hrisWorkCertificateRouter` mounted under `/api/hris` in routes/index.ts.
//
// Assumptions (the brief leaves these open):
//  - HR reading an offboarding that is still `open` is answered 409.
//  - An employee reading their own certificate before `completed`, someone
//    else's, or a cancelled offboarding's, is answered 404.
//  - A malformed offboarding id is answered 422 (strict params).
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, signUp, verifySessionMfa } from "./helpers.ts";
import { allText } from "./pdf-text.ts";
import {
  createAppPool,
  createSecondTenant,
  expectRowsIsolated,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = createAppPool();

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdOffboardings: string[] = [];
const createdOutlets: string[] = [];
let tenantB: SecondTenant | null = null;

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

async function signedInClient(name: string, options: { mfa?: boolean } = {}) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  if (options.mfa) await verifySessionMfa(email);
  return { client, userId };
}

async function grantRole(
  userId: string,
  permissions: string[],
  scope: { kind: "tenant" } | { kind: "outlet"; outletId: string },
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
        `Surat kerja API ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.kind]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [
        tenant.id,
        userId,
        roleId,
        scope.kind,
        scope.kind === "outlet" ? scope.outletId : null,
      ],
    );
  });
}

async function seedOutlet(label: string) {
  const id = randomUUID();
  createdOutlets.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Surat', 'Asia/Jakarta', '{}', 'active')`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `SK-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet surat ${label}`,
      ],
    ),
  );
  return id;
}

const FULL_NAME = "Siti Nurhaliza Surat Kerja";
const JOIN_DATE = "2025-03-01";
const LAST_DAY = "2034-03-10";

async function seedEmployee(userId: string | null, outletId: string) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', $7, 'active')`,
      [
        id,
        tenant.id,
        userId,
        `SK-${id.slice(0, 8).toUpperCase()}`,
        FULL_NAME,
        outletId,
        JOIN_DATE,
      ],
    ),
  );
  return id;
}

async function seedOffboarding(
  employeeId: string,
  status: "open" | "revoked" | "completed" | "cancelled",
) {
  const id = randomUUID();
  createdOffboardings.push(id);
  const revoked = status === "revoked" || status === "completed";
  await asTenant((client) =>
    client.query(
      `INSERT INTO hris_offboardings
         (id, tenant_id, employee_id, exit_type, reason, last_working_date, status,
          access_revoked_at, access_revoked_by, revocation_result,
          completed_at, completed_by, settlement_snapshot,
          cancelled_at, cancelled_by, cancel_reason, created_by)
       VALUES ($1, $2, $3, 'resignation', 'Pindah kota', $4, $5,
               $6, $7, $8, $9, $10, $11, $12, $13, $14, $7)`,
      [
        id,
        tenant.id,
        employeeId,
        LAST_DAY,
        status,
        revoked ? new Date() : null,
        revoked ? "system-test" : "system-test",
        revoked ? JSON.stringify({ sessionsRevoked: 0 }) : null,
        status === "completed" ? new Date() : null,
        status === "completed" ? "system-test" : null,
        status === "completed" ? JSON.stringify({}) : null,
        status === "cancelled" ? new Date() : null,
        status === "cancelled" ? "system-test" : null,
        status === "cancelled" ? "Batal" : null,
      ],
    ),
  );
  return id;
}

async function setStatus(id: string, status: "revoked" | "completed") {
  await asTenant((client) =>
    client.query(
      `UPDATE hris_offboardings
          SET status = $2::varchar,
              access_revoked_at = COALESCE(access_revoked_at, now()),
              access_revoked_by = COALESCE(access_revoked_by, 'system-test'),
              revocation_result = COALESCE(revocation_result, '{}'::jsonb),
              completed_at = CASE WHEN $4::boolean THEN now() END,
              completed_by = CASE WHEN $4::boolean THEN 'system-test' END,
              settlement_snapshot = CASE WHEN $4::boolean THEN '{}'::jsonb END
        WHERE tenant_id = $1 AND id = $3`,
      [tenant.id, status, id, status === "completed"],
    ),
  );
}

async function storedCertificate(id: string) {
  return asTenant(async (client) => {
    const { rows } = await client.query<{
      certificate_no: string | null;
      certificate_issued_at: Date | null;
    }>(
      "SELECT certificate_no, certificate_issued_at FROM hris_offboardings WHERE tenant_id = $1 AND id = $2",
      [tenant.id, id],
    );
    return rows[0]!;
  });
}

async function issuedAuditRows(id: string) {
  return asTenant(async (client) => {
    const { rows } = await client.query(
      `SELECT 1 FROM audit_logs
        WHERE tenant_id = $1 AND event->>'objectId' = $2
          AND event->>'action' = 'hris.offboarding.certificate_issued'`,
      [tenant.id, id],
    );
    return rows.length;
  });
}

const certPath = (id: string) =>
  `/api/hris/offboardings/${id}/work-certificate`;
const pdfPath = (id: string) => `${certPath(id)}.pdf`;
const binary = (res: Buffer | unknown) => res as Buffer;
const getPdf = (client: Client, id: string) =>
  client
    .get(pdfPath(id))
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });

type Certificate = {
  offboardingId: string;
  certificateNo: string;
  issuedAt: string;
  company: { name: string };
  employee: { id: string; fullName: string; employeeNo: string };
  positionName: string;
  outletName: string;
  joinDate: string;
  lastWorkingDate: string;
  exitType: string;
  managerName: string | null;
};

const YEAR = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jakarta",
  year: "numeric",
}).format(new Date());
const NUMBER_PATTERN = new RegExp(`^SK/${YEAR}/\\d{4}$`);

let jkt: string;
let otherOutlet: string;
let hr: Client;
let hrOtherOutlet: Client;
let staffSelf: Client;
let staffOther: Client;
let noPermission: Client;
let supervisor: Client;
let empSelf: string;
let empHr: string;

beforeAll(async () => {
  jkt = await seedOutlet("jakarta");
  otherOutlet = await seedOutlet("lain");

  const manager = await signedInClient("HR Surat Kerja API", { mfa: true });
  await grantRole(manager.userId, ["hr.employee.manage"], {
    kind: "outlet",
    outletId: jkt,
  });
  hr = manager.client;

  const managerOther = await signedInClient("HR Outlet Lain Surat API", {
    mfa: true,
  });
  await grantRole(managerOther.userId, ["hr.employee.manage"], {
    kind: "outlet",
    outletId: otherOutlet,
  });
  hrOtherOutlet = managerOther.client;

  const self = await signedInClient("Karyawan Surat Kerja API");
  await grantRole(self.userId, ["self.profile.view"], {
    kind: "outlet",
    outletId: jkt,
  });
  staffSelf = self.client;
  empSelf = await seedEmployee(self.userId, jkt);

  const other = await signedInClient("Karyawan Lain Surat Kerja API");
  await grantRole(other.userId, ["self.profile.view"], {
    kind: "outlet",
    outletId: jkt,
  });
  staffOther = other.client;
  await seedEmployee(other.userId, jkt);

  const view = await signedInClient("Supervisor Surat Kerja API");
  await grantRole(view.userId, ["hr.employee.view"], {
    kind: "outlet",
    outletId: jkt,
  });
  supervisor = view.client;

  noPermission = (await signedInClient("Tanpa Izin Surat Kerja API")).client;
  empHr = await seedEmployee(null, jkt);
});

afterAll(async () => {
  await asTenant(async (client) => {
    await client.query(
      "DELETE FROM hris_offboardings WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdOffboardings],
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
    // Outlets stay: audit_logs is append-only and references them (disposable DB).
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  if (tenantB) {
    await owner.query("DELETE FROM hris_offboardings WHERE tenant_id = $1", [
      tenantB.tenantId,
    ]);
    await owner.query("DELETE FROM employees WHERE tenant_id = $1", [
      tenantB.tenantId,
    ]);
    await removeSecondTenant(owner, tenantB);
  }
  await appPool.end();
  await owner.end();
});

describe("authentication and permissions", () => {
  it("[TEN-01] anonymous requests answer 401 on both routes", async () => {
    const anonymous = agent(app);
    const id = randomUUID();
    expect((await anonymous.get(certPath(id))).status).toBe(401);
    expect((await anonymous.get(pdfPath(id))).status).toBe(401);
  });

  it("a user without any HR code is refused and a malformed id is 422", async () => {
    const id = await seedOffboarding(await seedEmployee(null, jkt), "revoked");
    expect((await supervisor.get(certPath(id))).status).toBe(403);
    expect((await hr.get(certPath("not-a-uuid"))).status).toBe(422);
    // Control: a profile-only account passes the gate but sees no such row.
    expect((await noPermission.get(certPath(id))).status).toBe(403);
    expect((await staffOther.get(certPath(id))).status).toBe(404);
  });

  it("[HR-01] HR of another outlet answers 404, never a hint the row exists", async () => {
    const id = await seedOffboarding(await seedEmployee(null, jkt), "revoked");
    expect((await hr.get(certPath(id))).status).toBe(200); // control
    expect((await hrOtherOutlet.get(certPath(id))).status).toBe(404);
    expect((await hrOtherOutlet.get(pdfPath(id))).status).toBe(404);
    expect((await storedCertificate(id)).certificate_no).not.toBeNull();
  });
});

describe("certificate data", () => {
  it("answers 409 while the offboarding is open and assigns no number", async () => {
    const id = await seedOffboarding(empHr, "open");
    const res = await hr.get(certPath(id));
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error?.code ?? res.body.code).toBe("CERTIFICATE_NOT_READY");
    expect((await storedCertificate(id)).certificate_no).toBeNull();
    await asTenant((client) =>
      client.query("DELETE FROM hris_offboardings WHERE id = $1", [id]),
    );
  });

  it("a cancelled offboarding has no certificate (404)", async () => {
    const id = await seedOffboarding(
      await seedEmployee(null, jkt),
      "cancelled",
    );
    expect((await hr.get(certPath(id))).status).toBe(404);
    expect((await storedCertificate(id)).certificate_no).toBeNull();
  });

  it("assigns SK/<year>/<4 digits> once; repeats return the same number and date", async () => {
    const id = await seedOffboarding(await seedEmployee(null, jkt), "revoked");
    const first = await hr.get(certPath(id));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const data = first.body.data as Certificate;
    expect(data.certificateNo).toMatch(NUMBER_PATTERN);
    expect(data.offboardingId).toBe(id);
    expect(data.employee.fullName).toBe(FULL_NAME);
    expect(data.joinDate).toBe(JOIN_DATE);
    expect(data.lastWorkingDate).toBe(LAST_DAY);
    expect(data.exitType).toBe("resignation");
    expect(data.company.name.length).toBeGreaterThan(0);
    expect(data.outletName).toBe("Outlet surat jakarta");

    const second = await hr.get(certPath(id));
    expect(second.body.data).toEqual(data);
    const stored = await storedCertificate(id);
    expect(stored.certificate_no).toBe(data.certificateNo);
    expect(stored.certificate_issued_at?.toISOString()).toBe(data.issuedAt);
    // One issuance, one audit row.
    expect(await issuedAuditRows(id)).toBe(1);
  });

  it("numbers of one tenant and year are unique and increase", async () => {
    const ids = [
      await seedOffboarding(await seedEmployee(null, jkt), "revoked"),
      await seedOffboarding(await seedEmployee(null, jkt), "revoked"),
    ];
    const numbers: string[] = [];
    for (const id of ids) {
      const res = await hr.get(certPath(id));
      expect(res.status).toBe(200);
      numbers.push((res.body.data as Certificate).certificateNo);
    }
    const [a, b] = numbers.map((n) => Number(n.split("/")[2]));
    expect(b).toBe(a! + 1);
  });

  it("concurrent first reads end with one number", async () => {
    const id = await seedOffboarding(await seedEmployee(null, jkt), "revoked");
    const results = await Promise.all(
      [0, 1, 2, 3].map(() => hr.get(certPath(id))),
    );
    for (const res of results) expect(res.status).toBe(200);
    const unique = new Set(
      results.map((res) => (res.body.data as Certificate).certificateNo),
    );
    expect(unique.size).toBe(1);
    expect([...unique][0]).toBe((await storedCertificate(id)).certificate_no);
    expect(await issuedAuditRows(id)).toBe(1);
  });

  it("[HR-01] the employee reads their own certificate only after completed", async () => {
    const id = await seedOffboarding(empSelf, "revoked");
    expect((await staffSelf.get(certPath(id))).status).toBe(404);
    expect((await getPdf(staffSelf, id)).status).toBe(404);
    expect((await storedCertificate(id)).certificate_no).toBeNull();
    // Control: HR can read the same row at this status.
    const hrRead = await hr.get(certPath(id));
    expect(hrRead.status).toBe(200);

    await setStatus(id, "completed");
    const own = await staffSelf.get(certPath(id));
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data).toEqual(hrRead.body.data);
    expect((await getPdf(staffSelf, id)).status).toBe(200);
    // Someone else's completed certificate stays hidden.
    expect((await staffOther.get(certPath(id))).status).toBe(404);
  });
});

describe("certificate PDF", () => {
  it("is a PDF whose text carries the name, number and dates, and is stable", async () => {
    const id = await seedOffboarding(
      await seedEmployee(null, jkt),
      "completed",
    );
    const res = await getPdf(hr, id);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain("inline");
    const pdf = binary(res.body);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const cert = (await hr.get(certPath(id))).body.data as Certificate;
    const text = allText(pdf);
    expect(text).toContain(FULL_NAME);
    expect(text).toContain(cert.certificateNo);
    expect(text).toContain("1 Maret 2025");
    expect(text).toContain("10 Maret 2034");
    expect(text).toContain("SURAT KETERANGAN KERJA");

    const again = await getPdf(hr, id);
    expect(binary(again.body).equals(pdf)).toBe(true);
  });

  it("[HR-01] open offboarding gives 409 and another outlet's HR gets 404", async () => {
    const open = await seedOffboarding(await seedEmployee(null, jkt), "open");
    expect((await getPdf(hr, open)).status).toBe(409);
    const done = await seedOffboarding(
      await seedEmployee(null, jkt),
      "completed",
    );
    expect((await getPdf(hrOtherOutlet, done)).status).toBe(404);
  });
});

describe("tenant isolation", () => {
  it("[TEN-01] another tenant's offboarding is unreachable and RLS hides rows both ways", async () => {
    tenantB = await createSecondTenant(owner, "certificate");
    const employeeB = randomUUID();
    await owner.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, NULL, $3, 'Karyawan Tenant B', $4, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeB,
        tenantB.tenantId,
        `TB-${employeeB.slice(0, 8).toUpperCase()}`,
        tenantB.outletId,
      ],
    );
    const offboardingB = randomUUID();
    await owner.query(
      `INSERT INTO hris_offboardings
         (id, tenant_id, employee_id, exit_type, reason, last_working_date, status,
          access_revoked_at, access_revoked_by, revocation_result, created_by)
       VALUES ($1, $2, $3, 'resignation', 'Tenant B', $4, 'revoked',
               now(), 'system-test', '{}', 'system-test')`,
      [offboardingB, tenantB.tenantId, employeeB, LAST_DAY],
    );
    const offboardingA = await seedOffboarding(
      await seedEmployee(null, jkt),
      "revoked",
    );

    // Control: tenant A reads its own row.
    expect((await hr.get(certPath(offboardingA))).status).toBe(200);
    expect((await hr.get(certPath(offboardingB))).status).toBe(404);
    expect((await getPdf(hr, offboardingB)).status).toBe(404);
    const stored = await owner.query(
      "SELECT certificate_no FROM hris_offboardings WHERE id = $1",
      [offboardingB],
    );
    expect(stored.rows[0]?.certificate_no).toBeNull();

    await expectRowsIsolated(
      appPool,
      {
        table: "hris_offboardings",
        updateSet: "reason = reason || 'x'",
        tenantA: { tenantId: tenant.id, rowId: offboardingA },
        tenantB: { tenantId: tenantB.tenantId, rowId: offboardingB },
      },
      owner,
    );
  });
});
