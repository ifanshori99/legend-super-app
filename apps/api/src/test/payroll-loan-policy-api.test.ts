// Tenant kasbon policy HTTP API (bead legend-hjaot; contract
// `@starter/shared/hris/payroll` loans.ts + endpoints.ts: getLoanPolicy and
// setLoanPolicy). Runs the real Express app, Better Auth, the RBAC resolver and
// PostgreSQL.
//
// Tenants: throwaway tenants (createIsolatedTenant), never the seeded Cafe
// Legend tenant, so the one-row-per-tenant policy cannot race with
// payroll-loans-api.test.ts / payroll-loans-caps.test.ts. The HTTP tenant is
// chosen by the Host header. Each scenario owns its tenant, so no test depends
// on the order of another.
//
// Assumptions where the brief is ambiguous:
// - Validation failures answer 422 with error.code VALIDATION_ERROR.
// - Same idempotency key with another body answers 409 IDEMPOTENCY_KEY_REUSED
//   (as payroll-pph21-policy-api.test.ts).
// - The audit event keeps the five limit fields in maskedChanges.before/after,
//   no idempotency key, no updatedAt. The audit masker refuses keys containing
//   "salary", so the salary multiple is stored as `principalMultipleBp`;
//   auditRows() maps it back to the API name.
// - A refused kasbon request answers 422 PAYROLL_LOAN_LIMIT_EXCEEDED.
// - Concurrent PUTs on a tenant without a row serialize: exactly one audit row
//   has before null, and the audit rows form one chain before -> after.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const app = createApp();
const POLICY = "/api/hris/payroll/loan-policy";
const ME_LOANS = "/api/hris/me/loans";
const LIMIT_CODE = "PAYROLL_LOAN_LIMIT_EXCEEDED";
const AUDIT_ACTION = "payroll.loan_policy.set";
const AUDIT_OBJECT = "payroll_loan_policy";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdUsers: string[] = [];
const createdEmployees: Array<{ id: string; tenantId: string }> = [];
const tenants: IsolatedTenant[] = [];
const key = () => `loan-policy-api-${randomUUID()}`;
const slug = () => `lpol-${randomUUID().slice(0, 6)}`;

type Client = ReturnType<typeof agent>;
type Limits = {
  maxPrincipalIdr: number | null;
  maxPrincipalOfBaseSalaryBp: number | null;
  maxInstallments: number;
  maxDeductionOfNetPayBp: number;
  singleOpenLoan: boolean;
  maxTotalOpenIdr: number;
};
type Ctx = { tenant: IsolatedTenant; host: string };

const LENIENT: Limits = {
  maxPrincipalIdr: 10_000_000,
  maxPrincipalOfBaseSalaryBp: null,
  maxInstallments: 12,
  maxDeductionOfNetPayBp: 5000,
  singleOpenLoan: false,
  maxTotalOpenIdr: 1_000_000_000,
};
const body = (limits: Partial<Limits> = {}, idempotencyKey = key()) => ({
  ...LENIENT,
  ...limits,
  idempotencyKey,
});
const limitsOf = (value: Limits): Limits => ({
  maxPrincipalIdr: value.maxPrincipalIdr,
  maxPrincipalOfBaseSalaryBp: value.maxPrincipalOfBaseSalaryBp,
  maxInstallments: value.maxInstallments,
  maxDeductionOfNetPayBp: value.maxDeductionOfNetPayBp,
  singleOpenLoan: value.singleOpenLoan,
  maxTotalOpenIdr: value.maxTotalOpenIdr,
});

async function asTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
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
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function newCtx(): Promise<Ctx> {
  const tenant = await createIsolatedTenant(slug());
  tenants.push(tenant);
  return { tenant, host: tenant.hostname };
}

/** A signed-in account holding exactly `permissions` in the tenant. */
async function actor(ctx: Ctx, permissions: string[], name = "Loan policy") {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  const roleId = randomUUID();
  await asTenant(ctx.tenant.tenantId, async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, '["tenant"]')`,
      [
        roleId,
        ctx.tenant.tenantId,
        `Loan policy ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
      ],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [ctx.tenant.tenantId, userId, roleId],
    );
  });
  return { client, userId };
}

const admin = async (ctx: Ctx) =>
  (await actor(ctx, ["payroll.view", "payroll.run"], "Loan policy admin"))
    .client;

const getPolicy = (ctx: Ctx, client: Client) =>
  client.get(POLICY).set("Host", ctx.host);

const putPolicy = (ctx: Ctx, client: Client, payload: object) =>
  client.put(POLICY).set(originHeader).set("Host", ctx.host).send(payload);

async function putOk(
  ctx: Ctx,
  client: Client,
  payload: ReturnType<typeof body>,
) {
  const response = await putPolicy(ctx, client, payload);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response;
}

type AuditEvent = {
  action: string;
  objectType: string;
  maskedChanges: { before: Limits | null; after: Limits };
};

async function auditRows(ctx: Ctx): Promise<AuditEvent[]> {
  const rows = await asTenant(ctx.tenant.tenantId, (db) =>
    db.query<{ event: AuditEvent }>(
      `SELECT event FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = $2`,
      [ctx.tenant.tenantId, AUDIT_ACTION],
    ),
  );
  const fromAudit = (value: Record<string, unknown> | null) => {
    if (value === null) return null;
    const { principalMultipleBp, ...rest } = value;
    return {
      ...rest,
      maxPrincipalOfBaseSalaryBp: principalMultipleBp,
    } as Limits;
  };
  return rows.rows.map((row) => {
    const changes = row.event.maskedChanges as unknown as {
      before: Record<string, unknown> | null;
      after: Record<string, unknown>;
    };
    return {
      ...row.event,
      maskedChanges: {
        before: fromAudit(changes.before),
        after: fromAudit(changes.after)!,
      },
    };
  });
}

async function rowCount(ctx: Ctx): Promise<number> {
  const rows = await asTenant(ctx.tenant.tenantId, (db) =>
    db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM payroll_loan_policies WHERE tenant_id = $1",
      [ctx.tenant.tenantId],
    ),
  );
  return Number(rows.rows[0]!.n);
}

async function seedStaff(ctx: Ctx) {
  const staff = await actor(ctx, ["self.profile.view"], "Loan policy staff");
  const id = randomUUID();
  createdEmployees.push({ id, tenantId: ctx.tenant.tenantId });
  await asTenant(ctx.tenant.tenantId, (db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Policy Kasbon', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        ctx.tenant.tenantId,
        staff.userId,
        `LP-${id.slice(0, 8).toUpperCase()}`,
        ctx.tenant.outletId,
      ],
    ),
  );
  return staff.client;
}

const requestLoan = (ctx: Ctx, client: Client, principalIdr: number) =>
  client.post(ME_LOANS).set(originHeader).set("Host", ctx.host).send({
    principalIdr,
    installmentCount: 3,
    reason: "Biaya uji policy kasbon",
    idempotencyKey: key(),
  });

afterAll(async () => {
  for (const tenant of tenants) {
    await asTenant(tenant.tenantId, async (db) => {
      for (const sql of [
        "DELETE FROM payroll_loan_policies WHERE tenant_id = $1",
        "DELETE FROM hris_idempotency WHERE tenant_id = $1",
        "DELETE FROM employee_loans WHERE tenant_id = $1",
      ])
        await db.query(sql, [tenant.tenantId]);
      await db.query(
        "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2)",
        [
          tenant.tenantId,
          createdEmployees
            .filter((employee) => employee.tenantId === tenant.tenantId)
            .map((employee) => employee.id),
        ],
      );
    });
    // Also purges the tenant's audit rows, roles and role assignments.
    await dropIsolatedTenant(tenant);
  }
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

describe("loan policy API: read and replace", () => {
  it("[loan-policy-get-empty] answers data null while the tenant has no policy", async () => {
    const ctx = await newCtx();
    const viewer = (await actor(ctx, ["payroll.view"])).client;
    const response = await getPolicy(ctx, viewer);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: null });
  });

  it("[loan-policy-put-create] creates the policy and a later read shows it with updatedAt", async () => {
    const ctx = await newCtx();
    const client = await admin(ctx);
    const payload = body({
      maxPrincipalIdr: 2_500_000,
      maxPrincipalOfBaseSalaryBp: 15000,
      maxInstallments: 10,
      maxDeductionOfNetPayBp: 3000,
      singleOpenLoan: true,
    });
    const put = await putOk(ctx, client, payload);
    expect(put.body.data).toMatchObject(limitsOf(payload));
    expect(Number.isNaN(Date.parse(put.body.data.updatedAt))).toBe(false);

    const read = await getPolicy(ctx, client);
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject(limitsOf(payload));
    expect(read.body.data.updatedAt).toBe(put.body.data.updatedAt);
    expect(await rowCount(ctx)).toBe(1);
  });

  it("[loan-policy-put-total] a read returns maxTotalOpenIdr and a replacement changes it", async () => {
    const ctx = await newCtx();
    const client = await admin(ctx);
    const first = body({
      maxPrincipalIdr: 2_000_000,
      maxTotalOpenIdr: 3_000_000,
    });
    const created = await putOk(ctx, client, first);
    expect(created.body.data.maxTotalOpenIdr).toBe(3_000_000);
    expect((await getPolicy(ctx, client)).body.data.maxTotalOpenIdr).toBe(
      3_000_000,
    );
    await putOk(ctx, client, body({ maxPrincipalIdr: 1, maxTotalOpenIdr: 1 }));
    expect((await getPolicy(ctx, client)).body.data.maxTotalOpenIdr).toBe(1);
    const rows = await auditRows(ctx);
    expect(rows.map((row) => row.maskedChanges.after.maxTotalOpenIdr)).toEqual(
      expect.arrayContaining([3_000_000, 1]),
    );
    expect(
      rows.find((row) => row.maskedChanges.before !== null)!.maskedChanges
        .before!.maxTotalOpenIdr,
    ).toBe(3_000_000);
  });

  it("[loan-policy-put-replace] a second PUT with a new key replaces the limits and keeps one row", async () => {
    const ctx = await newCtx();
    const client = await admin(ctx);
    const first = body({ maxPrincipalIdr: 3_000_000, maxInstallments: 6 });
    const second = body({
      maxPrincipalIdr: null,
      maxPrincipalOfBaseSalaryBp: 10000,
      maxInstallments: 24,
      singleOpenLoan: true,
    });
    const created = await putOk(ctx, client, first);
    const replaced = await putOk(ctx, client, second);
    expect(replaced.body.data).toMatchObject(limitsOf(second));
    expect(
      Date.parse(replaced.body.data.updatedAt),
      "updatedAt moves forward",
    ).toBeGreaterThanOrEqual(Date.parse(created.body.data.updatedAt));

    const read = await getPolicy(ctx, client);
    expect(read.body.data).toMatchObject(limitsOf(second));
    expect(read.body.data.maxPrincipalIdr).toBeNull();
    expect(await rowCount(ctx)).toBe(1);
  });

  it("[loan-policy-put-boundaries] accepts the smallest and largest allowed values", async () => {
    const ctx = await newCtx();
    const client = await admin(ctx);
    const low = body({
      maxPrincipalIdr: 1,
      maxPrincipalOfBaseSalaryBp: 1,
      maxInstallments: 1,
      maxDeductionOfNetPayBp: 0,
    });
    expect((await putOk(ctx, client, low)).body.data).toMatchObject(
      limitsOf(low),
    );
    const high = body({
      maxPrincipalIdr: null,
      maxPrincipalOfBaseSalaryBp: 120000,
      maxInstallments: 36,
      maxDeductionOfNetPayBp: 10000,
    });
    expect((await putOk(ctx, client, high)).body.data).toMatchObject(
      limitsOf(high),
    );
  });
});

describe("loan policy API: validation", () => {
  const invalid: Array<[string, Record<string, unknown>]> = [
    [
      "both ceilings null",
      { maxPrincipalIdr: null, maxPrincipalOfBaseSalaryBp: null },
    ],
    ["maxInstallments 0", { maxInstallments: 0 }],
    ["maxInstallments 37", { maxInstallments: 37 }],
    [
      "maxPrincipalOfBaseSalaryBp 120001",
      { maxPrincipalOfBaseSalaryBp: 120001 },
    ],
    ["maxPrincipalOfBaseSalaryBp 0", { maxPrincipalOfBaseSalaryBp: 0 }],
    ["maxPrincipalIdr 0", { maxPrincipalIdr: 0 }],
    ["maxPrincipalIdr negative", { maxPrincipalIdr: -5 }],
    ["maxPrincipalIdr not an integer", { maxPrincipalIdr: 1000.5 }],
    ["maxDeductionOfNetPayBp 10001", { maxDeductionOfNetPayBp: 10001 }],
    ["maxDeductionOfNetPayBp negative", { maxDeductionOfNetPayBp: -1 }],
    [
      "maxTotalOpenIdr below maxPrincipalIdr",
      { maxPrincipalIdr: 2_000_000, maxTotalOpenIdr: 1_999_999 },
    ],
    ["maxTotalOpenIdr missing", { maxTotalOpenIdr: undefined }],
    ["maxTotalOpenIdr 0", { maxTotalOpenIdr: 0 }],
    ["maxTotalOpenIdr negative", { maxTotalOpenIdr: -1 }],
    ["maxTotalOpenIdr null", { maxTotalOpenIdr: null }],
    ["maxTotalOpenIdr not an integer", { maxTotalOpenIdr: 1000.5 }],
    ["singleOpenLoan not a boolean", { singleOpenLoan: "yes" }],
    ["unknown key tenantId", { tenantId: randomUUID() }],
    ["missing idempotencyKey", { idempotencyKey: undefined }],
  ];

  it.each(invalid)(
    "[loan-policy-put-validation] rejects %s with 422 and stores nothing",
    async (_label, override) => {
      const ctx = await newCtx();
      const client = await admin(ctx);
      const response = await putPolicy(ctx, client, {
        ...body(),
        ...override,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect((await getPolicy(ctx, client)).body).toEqual({ data: null });
      expect(await rowCount(ctx)).toBe(0);
      expect(await auditRows(ctx)).toHaveLength(0);
    },
  );

  it("[loan-policy-put-total-vs-principal] total equal to the per-loan ceiling is accepted; without a rupiah ceiling any total is", async () => {
    const ctx = await newCtx();
    const client = await admin(ctx);
    await putOk(
      ctx,
      client,
      body({ maxPrincipalIdr: 2_000_000, maxTotalOpenIdr: 2_000_000 }),
    );
    await putOk(
      ctx,
      client,
      body({
        maxPrincipalIdr: null,
        maxPrincipalOfBaseSalaryBp: 10_000,
        maxTotalOpenIdr: 1,
      }),
    );
    expect((await getPolicy(ctx, client)).body.data).toMatchObject({
      maxPrincipalIdr: null,
      maxTotalOpenIdr: 1,
    });
    expect(await rowCount(ctx)).toBe(1);
  });

  it("[loan-policy-put-validation] a rejected PUT leaves an existing policy untouched", async () => {
    const ctx = await newCtx();
    const client = await admin(ctx);
    const kept = body({ maxPrincipalIdr: 4_000_000 });
    await putOk(ctx, client, kept);
    const bad = await putPolicy(ctx, client, body({ maxInstallments: 37 }));
    expect(bad.status).toBe(422);
    expect((await getPolicy(ctx, client)).body.data).toMatchObject(
      limitsOf(kept),
    );
    expect(await auditRows(ctx)).toHaveLength(1);
  });
});

describe("loan policy API: permission and origin", () => {
  it("[loan-policy-permission] viewer reads but cannot write; no payroll permission cannot read", async () => {
    const ctx = await newCtx();
    const viewer = (await actor(ctx, ["payroll.view"])).client;
    const stranger = (await actor(ctx, ["hr.employee.view"])).client;
    const client = await admin(ctx);
    const kept = body({ maxPrincipalIdr: 1_500_000 });
    await putOk(ctx, client, kept);

    const read = await getPolicy(ctx, viewer);
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject(limitsOf(kept));

    const write = await putPolicy(ctx, viewer, body({ maxInstallments: 2 }));
    expect(write.status).toBe(403);
    expect((await getPolicy(ctx, client)).body.data).toMatchObject(
      limitsOf(kept),
    );
    expect(await auditRows(ctx)).toHaveLength(1);

    expect((await getPolicy(ctx, stranger)).status).toBe(403);
    expect((await putPolicy(ctx, stranger, body())).status).toBe(403);
  });

  it("[loan-policy-permission] anonymous callers get 401 on read and write", async () => {
    const ctx = await newCtx();
    expect((await getPolicy(ctx, agent(app))).status).toBe(401);
    const write = await agent(app)
      .put(POLICY)
      .set(originHeader)
      .set("Host", ctx.host)
      .send(body());
    expect(write.status).toBe(401);
  });

  it("[loan-policy-origin] rejects a write without Origin with 403 and stores nothing", async () => {
    const ctx = await newCtx();
    const client = await admin(ctx);
    const response = await client
      .put(POLICY)
      .set("Host", ctx.host)
      .send(body());
    expect(response.status).toBe(403);
    expect((await getPolicy(ctx, client)).body).toEqual({ data: null });
    expect(await rowCount(ctx)).toBe(0);
  });
});

describe("loan policy API: idempotency", () => {
  it("[loan-policy-idempotency] replays the stored response for the same key and body", async () => {
    const ctx = await newCtx();
    const client = await admin(ctx);
    const payload = body({ maxPrincipalIdr: 2_000_000 });
    const first = await putOk(ctx, client, payload);
    const replay = await putOk(ctx, client, payload);
    expect(replay.body).toEqual(first.body);
    expect(await rowCount(ctx)).toBe(1);
    expect(await auditRows(ctx)).toHaveLength(1);
  });

  it("[loan-policy-idempotency] refuses the same key with another body (409) and keeps the policy", async () => {
    const ctx = await newCtx();
    const client = await admin(ctx);
    const idempotencyKey = key();
    const original = body({ maxPrincipalIdr: 2_000_000 }, idempotencyKey);
    await putOk(ctx, client, original);
    const other = await putPolicy(
      ctx,
      client,
      body({ maxPrincipalIdr: 9_000_000 }, idempotencyKey),
    );
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await getPolicy(ctx, client)).body.data).toMatchObject(
      limitsOf(original),
    );
    expect(await auditRows(ctx)).toHaveLength(1);
  });
});

describe("loan policy API: audit", () => {
  it("[loan-policy-audit] the first set audits before null and the limits after", async () => {
    const ctx = await newCtx();
    const client = await admin(ctx);
    const payload = body({
      maxPrincipalIdr: 2_750_000,
      maxPrincipalOfBaseSalaryBp: 8000,
      maxInstallments: 9,
      maxDeductionOfNetPayBp: 2500,
      singleOpenLoan: true,
    });
    await putOk(ctx, client, payload);
    const rows = await auditRows(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe(AUDIT_ACTION);
    expect(rows[0]!.objectType).toBe(AUDIT_OBJECT);
    expect(rows[0]!.maskedChanges.before).toBeNull();
    expect(rows[0]!.maskedChanges.after).toEqual(limitsOf(payload));
  });

  it("[loan-policy-audit] a replacement audits the previous limits as before", async () => {
    const ctx = await newCtx();
    const client = await admin(ctx);
    const first = body({ maxPrincipalIdr: 1_000_000, maxInstallments: 4 });
    const second = body({ maxPrincipalIdr: 6_000_000, maxInstallments: 18 });
    await putOk(ctx, client, first);
    await putOk(ctx, client, second);
    const rows = await auditRows(ctx);
    expect(rows).toHaveLength(2);
    const replacement = rows.find((row) => row.maskedChanges.before !== null)!;
    expect(replacement.maskedChanges.before).toEqual(limitsOf(first));
    expect(replacement.maskedChanges.after).toEqual(limitsOf(second));
    const creation = rows.find((row) => row.maskedChanges.before === null)!;
    expect(creation.maskedChanges.after).toEqual(limitsOf(first));
  });
});

describe("loan policy API: tenant isolation", () => {
  it("[loan-policy-isolation] one tenant's PUT never changes or reveals another tenant's policy", async () => {
    const a = await newCtx();
    const b = await newCtx();
    const adminA = await admin(a);
    const adminB = await admin(b);
    const forA = body({ maxPrincipalIdr: 1_111_000, maxInstallments: 5 });
    const forB = body({ maxPrincipalIdr: 9_999_000, maxInstallments: 30 });

    await putOk(a, adminA, forA);
    expect((await getPolicy(b, adminB)).body).toEqual({ data: null });

    await putOk(b, adminB, forB);
    expect((await getPolicy(a, adminA)).body.data).toMatchObject(
      limitsOf(forA),
    );
    expect((await getPolicy(b, adminB)).body.data).toMatchObject(
      limitsOf(forB),
    );
    expect(await rowCount(a)).toBe(1);
    expect(await rowCount(b)).toBe(1);
    expect((await auditRows(a)).map((row) => row.maskedChanges.after)).toEqual([
      limitsOf(forA),
    ]);
    expect((await auditRows(b)).map((row) => row.maskedChanges.after)).toEqual([
      limitsOf(forB),
    ]);
  });

  it("[loan-policy-isolation] an admin of tenant A has no access to tenant B through its host", async () => {
    const a = await newCtx();
    const b = await newCtx();
    const adminA = await admin(a);
    // adminA holds no role in tenant B.
    expect((await getPolicy(b, adminA)).status).toBe(403);
    expect((await putPolicy(b, adminA, body())).status).toBe(403);
    expect(await rowCount(b)).toBe(0);
  });
});

describe("loan policy API: effect on kasbon requests", () => {
  it("[loan-policy-enforcement] setting and lowering the policy changes what staff may request", async () => {
    const ctx = await newCtx();
    const client = await admin(ctx);
    const staff = await seedStaff(ctx);

    const refused = await requestLoan(ctx, staff, 1_000_000);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error.code).toBe(LIMIT_CODE);

    await putOk(ctx, client, body({ maxPrincipalIdr: 10_000_000 }));
    const accepted = await requestLoan(ctx, staff, 1_000_000);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);

    await putOk(ctx, client, body({ maxPrincipalIdr: 500_000 }));
    const lowered = await requestLoan(ctx, staff, 1_000_000);
    expect(lowered.status, JSON.stringify(lowered.body)).toBe(422);
    expect(lowered.body.error.code).toBe(LIMIT_CODE);
  });
});

// jsonb stores object keys in its own order, so compare with sorted keys.
const canon = (value: unknown): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([x], [y]) =>
        x.localeCompare(y),
      ),
    ),
  );

describe("loan policy API: concurrency", () => {
  it("[loan-policy-concurrent-put] five parallel PUTs all succeed, leave one row and a clean audit chain", async () => {
    const ctx = await newCtx();
    const client = await admin(ctx);
    const payloads = [1, 2, 3, 4, 5].map((n) =>
      body({
        maxPrincipalIdr: n * 1_000_000,
        maxInstallments: n + 5,
        maxDeductionOfNetPayBp: n * 1000,
        singleOpenLoan: n % 2 === 0,
      }),
    );
    const responses = await Promise.all(
      payloads.map((payload) => putPolicy(ctx, client, payload)),
    );
    for (const response of responses)
      expect(response.status, JSON.stringify(response.body)).toBe(200);

    expect(await rowCount(ctx)).toBe(1);
    const submitted = payloads.map((payload) => canon(limitsOf(payload)));
    const finalRead = (await getPolicy(ctx, client)).body.data as Limits;
    expect(submitted).toContain(canon(limitsOf(finalRead)));

    const rows = await auditRows(ctx);
    expect(rows).toHaveLength(5);
    const befores = rows.map((row) => row.maskedChanges.before);
    const afters = rows.map((row) => canon(row.maskedChanges.after));
    expect(afters.slice().sort()).toEqual(submitted.slice().sort());
    // One chain: a single first write, every other before is another write's
    // after and is used once, so the last link is the stored row.
    expect(befores.filter((before) => before === null)).toHaveLength(1);
    const linked = befores
      .filter((before): before is Limits => before !== null)
      .map((before) => canon(before));
    expect(new Set(linked).size).toBe(4);
    for (const before of linked) expect(afters).toContain(before);
    const last = afters.filter((after) => !linked.includes(after));
    expect(last).toEqual([canon(limitsOf(finalRead))]);
  });
});
