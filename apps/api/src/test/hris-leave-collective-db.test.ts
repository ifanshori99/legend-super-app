// Collective leave ("cuti bersama", founder decision Q7) against PostgreSQL:
// the tenant setting (GET/PUT, validation, tenant RLS) and the deduction that
// takes one annual-leave day per past collective holiday, run by the system
// from the daily leave job.
//
// Assumptions: everything is dated 2043-2044 (no other test file uses those
// years) and `now` is injected (2044-06-15 12:00 WIB), so the real clock never
// matters. The fixture tenant has no `ANNUAL` leave type of its own; this file
// creates it and removes it afterwards. There is no attendance table yet, so
// "worked on the collective day" is not tested.
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
  leaveSettingsInputSchema,
  leaveTypeInputSchema,
  type Employee,
} from "@starter/shared/hris";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  createEmployee,
  type CreateEmployeeInput,
} from "../services/hris-employee.service.ts";
import {
  createHoliday,
  deleteHoliday,
  updateHoliday,
} from "../services/hris-holiday.service.ts";
import {
  createLeaveType,
  updateLeaveType,
} from "../services/hris-leave.service.ts";
import {
  applyCollectiveLeaveDeductions,
  getLeaveSettings,
  updateLeaveSettings,
} from "../services/hris-leave-collective.service.ts";
import { runScheduledLeaveJobs } from "../services/hris-leave-jobs.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const outletB = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[1].id);
const otherTenant = randomUUID();
const SYSTEM = { type: "system" } as const;
// 2044-06-15 05:00Z = 12:00 WIB, local today 2044-06-15.
const NOW = new Date("2044-06-15T05:00:00Z");

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdTypes: string[] = [];

const scoped = (source: "session" | "job", tenant: string = tenantId) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId: tenant, brandId: null, source }),
    { kind: "tenant" },
  );
const tenantScope = () => scoped("session");
const workerContext = () => scoped("job");
const outletScope = (outletId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

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
): Promise<R[]> {
  return asOwner(
    tenantId,
    async (client) => (await client.query(text, params)).rows,
  );
}

/** Runs `text` as the restricted app role (RLS on) inside `tenant`. */
async function asApp<R>(
  tenant: string,
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    const { rows } = await client.query(text, params);
    await client.query("COMMIT");
    return rows as R[];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function customUser(
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Cuti Bersama', $2)`,
    [userId, `${userId}@example.test`],
  );
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await sql(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenantId,
      `Cuti bersama test ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify([scope.type]),
    ],
  );
  await sql(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [
      tenantId,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
  return userId;
}

const key = () => `cbdb-${randomUUID()}`;
async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return {
      code: (error as { code?: string }).code,
      status: (error as { status?: number }).status,
    };
  }
  throw new Error("Expected the call to fail");
}

const code = () =>
  `CB_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
async function leaveType(
  input: { code?: string; tracksBalance?: boolean; isActive?: boolean } = {},
): Promise<string> {
  const type = await createLeaveType(tenantScope(), hr, {
    ...leaveTypeInputSchema.parse({
      code: input.code ?? code(),
      name: "Cuti bersama test",
      paid: true,
      requiresAttachment: false,
      policy: {
        annualDays: "12.0000",
        carryOverMaxDays: "0.0000",
        carryOverExpiryMonths: 0,
        tracksBalance: input.tracksBalance ?? true,
      },
    }),
    idempotencyKey: key(),
  });
  createdTypes.push(type.id);
  if (input.isActive === false)
    await updateLeaveType(tenantScope(), hr, type.id, {
      isActive: false,
      idempotencyKey: key(),
    } as never);
  return type.id;
}

const freshNo = () =>
  `CB-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
function employee(homeOutletId: string, joinDate: string) {
  return createEmployee(tenantScope(), hr, {
    userId: null,
    legalEntityId: null,
    employeeNo: freshNo(),
    fullName: "Karyawan Cuti Bersama",
    positionId: null,
    orgUnitId: null,
    managerId: null,
    homeOutletId,
    employmentType: "pkwt",
    joinDate,
    endDate: null,
    ptkpStatus: "TK/0",
    status: "active",
  } as CreateEmployeeInput);
}

function holiday(
  date: string,
  type: "national" | "collective" | "company",
  outletId: string | null = null,
) {
  return createHoliday(tenantScope(), hr, {
    date,
    name: `CBDB ${type} ${date}`,
    type,
    outletId,
    idempotencyKey: key(),
  } as never);
}

const ledgerOf = (employeeId: string) =>
  sql<{ kind: string; period: string; days: string }>(
    `SELECT kind, period, days FROM leave_accruals
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
        AND kind = 'collective_leave'
      ORDER BY period`,
    [tenantId, employeeId, annualTypeId],
  );
const periodsOf = async (employeeId: string) =>
  (await ledgerOf(employeeId)).map((row) => row.period);
const usedOf = async (employeeId: string, year: number) =>
  (
    await sql<{ used_days: string }>(
      `SELECT used_days FROM leave_balances
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = $4`,
      [tenantId, employeeId, annualTypeId, year],
    )
  )[0]?.used_days ?? null;

let hr: string;
let hrOutlet: string;
let viewer: string;
let annualTypeId: string;
let eA: Employee; // outlet A, joined 2040
let eB: Employee; // outlet B, joined 2040
let eLate: Employee; // outlet A, joined 2044-03-01

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Cuti bersama other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `cb-other-${otherTenant.slice(0, 8)}`, tenantId],
  );
  hr = await customUser(["hr.employee.manage", "hr.employee.view"], {
    type: "tenant",
  });
  hrOutlet = await customUser(["hr.employee.manage", "hr.employee.view"], {
    type: "outlet",
    id: outletA,
  });
  viewer = await customUser(["hr.employee.view"], { type: "tenant" });
  annualTypeId = await leaveType({ code: "ANNUAL" });
  eA = await employee(outletA, "2040-01-02");
  eB = await employee(outletB, "2040-01-02");
  eLate = await employee(outletA, "2044-03-01");
});

afterAll(async () => {
  setAuditWriter(null);
  await asOwner(tenantId, async (client) => {
    await client.query("DELETE FROM hris_leave_settings WHERE tenant_id = $1", [
      tenantId,
    ]);
    // The deduction and the daily job touch every active employee of the
    // tenant, so clean by year range and by the types made here.
    await client.query(
      `DELETE FROM leave_accruals WHERE tenant_id = $1
         AND (period LIKE '2043%' OR period LIKE '2044%' OR leave_type_id = ANY($2::uuid[]))`,
      [tenantId, createdTypes],
    );
    await client.query(
      `DELETE FROM leave_balances WHERE tenant_id = $1
         AND (period_year BETWEEN 2043 AND 2044 OR leave_type_id = ANY($2::uuid[]))`,
      [tenantId, createdTypes],
    );
    await client.query(
      "DELETE FROM leave_requests WHERE tenant_id = $1 AND requested_by = ANY($2)",
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND (key LIKE 'cbdb-%' OR key LIKE 'leave-jobs/204%')",
      [tenantId],
    );
    await client.query(
      "DELETE FROM holidays WHERE tenant_id = $1 AND name LIKE 'CBDB %'",
      [tenantId],
    );
    await client.query(
      "DELETE FROM leave_types WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, createdTypes],
    );
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND created_by = ANY($2)",
      [tenantId, createdUsers],
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
  await owner
    .query("DELETE FROM tenants WHERE id = $1", [otherTenant])
    .catch(() => undefined);
  await owner
    .query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers])
    .catch(() => undefined);
  await owner.end();
  await appPool.end();
});

describe("leave settings (cuti bersama)", () => {
  it("defaults when no row exists: deduct, annual type = the active ANNUAL type", async () => {
    const settings = await getLeaveSettings(tenantScope(), hr, NOW);
    expect(settings).toEqual({
      tenantId,
      collectiveLeaveDeductsAnnual: true,
      annualLeaveTypeId: null,
      effectiveAnnualLeaveTypeId: annualTypeId,
      collectiveLeaveEffectiveFrom: "2027-01-01",
      updatedBy: null,
      updatedAt: null,
    });
  });

  it("only tenant-wide HR manage reads or writes the setting", async () => {
    expect(
      (await failure(getLeaveSettings(tenantScope(), viewer))).status,
    ).toBe(403);
    expect(
      (await failure(getLeaveSettings(outletScope(outletA), hrOutlet))).status,
    ).toBe(403);
    expect(
      (
        await failure(
          updateLeaveSettings(tenantScope(), viewer, {
            collectiveLeaveDeductsAnnual: false,
            annualLeaveTypeId: null,
            idempotencyKey: key(),
          }),
        )
      ).status,
    ).toBe(403);
  });

  it("PUT rejects an unknown, inactive or untracked annual type with 422", async () => {
    const inactive = await leaveType({ isActive: false });
    const untracked = await leaveType({ tracksBalance: false });
    for (const annualLeaveTypeId of [randomUUID(), inactive, untracked]) {
      const refused = await failure(
        updateLeaveSettings(tenantScope(), hr, {
          collectiveLeaveDeductsAnnual: true,
          annualLeaveTypeId: annualLeaveTypeId as never,
          idempotencyKey: key(),
        }),
      );
      expect(refused).toEqual({ code: "VALIDATION_ERROR", status: 422 });
    }
    expect(
      await sql("SELECT 1 FROM hris_leave_settings WHERE tenant_id = $1", [
        tenantId,
      ]),
    ).toEqual([]);
  });

  it("PUT saves, audits and replays on the same idempotency key", async () => {
    const other = await leaveType();
    const idempotencyKey = key();
    const body = {
      collectiveLeaveDeductsAnnual: false,
      annualLeaveTypeId: other as never,
      idempotencyKey,
    };
    const saved = await updateLeaveSettings(tenantScope(), hr, body, NOW);
    expect(saved).toMatchObject({
      collectiveLeaveDeductsAnnual: false,
      annualLeaveTypeId: other,
      effectiveAnnualLeaveTypeId: other,
      updatedBy: hr,
      updatedAt: NOW.toISOString(),
    });
    expect(await updateLeaveSettings(tenantScope(), hr, body, NOW)).toEqual(
      saved,
    );
    expect(
      (
        await failure(
          updateLeaveSettings(tenantScope(), hr, {
            ...body,
            collectiveLeaveDeductsAnnual: true,
          }),
        )
      ).code,
    ).toBe("IDEMPOTENCY_KEY_REUSED");
    const audits = await sql<{ after: Record<string, unknown> }>(
      `SELECT event->'maskedChanges'->'after' AS after FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'hris.leave_settings.updated'
          AND event->>'actorId' = $2`,
      [tenantId, hr],
    );
    expect(audits).toEqual([
      {
        after: {
          collectiveLeaveDeductsAnnual: false,
          annualLeaveTypeId: other,
          effectiveAnnualLeaveTypeId: other,
          collectiveLeaveEffectiveFrom: "2027-01-01",
        },
      },
    ]);

    // The effective-from date is saved, validated and null resets it.
    const dated = await updateLeaveSettings(tenantScope(), hr, {
      collectiveLeaveDeductsAnnual: true,
      annualLeaveTypeId: null,
      collectiveLeaveEffectiveFrom: "2030-03-04",
      idempotencyKey: key(),
    });
    expect(dated.collectiveLeaveEffectiveFrom).toBe("2030-03-04");
    expect(
      leaveSettingsInputSchema.safeParse({
        collectiveLeaveDeductsAnnual: true,
        annualLeaveTypeId: null,
        collectiveLeaveEffectiveFrom: "1999-12-31",
      }).success,
    ).toBe(false);
    expect(
      leaveSettingsInputSchema.safeParse({
        collectiveLeaveDeductsAnnual: true,
        annualLeaveTypeId: null,
        collectiveLeaveEffectiveFrom: "04/03/2030",
      }).success,
    ).toBe(false);

    // Back to the defaults for the deduction tests below.
    const reset = await updateLeaveSettings(tenantScope(), hr, {
      collectiveLeaveDeductsAnnual: true,
      annualLeaveTypeId: null,
      idempotencyKey: key(),
    });
    expect(reset.effectiveAnnualLeaveTypeId).toBe(annualTypeId);
  });

  it("tenant RLS hides the row from another tenant and refuses a cross-tenant write", async () => {
    expect(
      await asApp(
        tenantId,
        "SELECT tenant_id FROM hris_leave_settings WHERE tenant_id = $1",
        [tenantId],
      ),
    ).toHaveLength(1);
    expect(
      await asApp(otherTenant, "SELECT tenant_id FROM hris_leave_settings"),
    ).toEqual([]);
    await expect(
      asApp(
        otherTenant,
        "INSERT INTO hris_leave_settings (tenant_id, collective_leave_deducts_annual) VALUES ($1, false)",
        [tenantId],
      ),
    ).rejects.toThrow();
  });
});

describe("collective leave deduction", () => {
  beforeAll(async () => {
    await holiday("2043-12-26", "collective"); // previous local year, everyone
    await holiday("2044-02-10", "collective", outletA); // outlet A only
    await holiday("2044-01-01", "national");
    await holiday("2044-05-01", "company", outletA);
    await holiday("2044-06-15", "collective"); // local today: not yet
    await holiday("2044-06-20", "collective"); // future
  });

  it("deducts one annual day per past collective date for employed staff in scope", async () => {
    const result = await applyCollectiveLeaveDeductions(
      workerContext(),
      NOW,
      SYSTEM,
    );
    expect(result.granted).toBeGreaterThanOrEqual(3);

    expect(await ledgerOf(eA.id)).toEqual([
      { kind: "collective_leave", period: "2043-12-26", days: "-1.0000" },
      { kind: "collective_leave", period: "2044-02-10", days: "-1.0000" },
    ]);
    // Outlet A's collective day does not reach outlet B.
    expect(await periodsOf(eB.id)).toEqual(["2043-12-26"]);
    // Hired after both dates: nothing.
    expect(await periodsOf(eLate.id)).toEqual([]);

    // The day lands in the balance of the holiday's year, below zero if
    // nothing was granted yet (mandated deduction), and that is audited.
    expect(await usedOf(eA.id, 2043)).toBe("1.0000");
    expect(await usedOf(eA.id, 2044)).toBe("1.0000");
    expect(await usedOf(eB.id, 2044)).toBeNull();
    const negative = await sql<{ actor_type: string }>(
      `SELECT event->>'actorType' AS actor_type FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'hris.leave_balance.collective_negative'
          AND event->>'objectId' = (SELECT id::text FROM leave_balances
            WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = 2044)`,
      [tenantId, eA.id, annualTypeId],
    );
    expect(negative).toEqual([{ actor_type: "system" }]);
  });

  it("is idempotent: a re-run deducts nothing more", async () => {
    const again = await applyCollectiveLeaveDeductions(
      workerContext(),
      new Date("2044-06-15T09:00:00Z"),
      SYSTEM,
    );
    expect(again.granted).toBe(0);
    expect(again.skipped).toBeGreaterThanOrEqual(3);
    expect(await periodsOf(eA.id)).toEqual(["2043-12-26", "2044-02-10"]);
    expect(await usedOf(eA.id, 2044)).toBe("1.0000");
  });

  it("deducts nothing while the tenant setting is off, and catches up once it is on", async () => {
    await holiday("2044-03-15", "collective");
    await updateLeaveSettings(tenantScope(), hr, {
      collectiveLeaveDeductsAnnual: false,
      annualLeaveTypeId: null,
      idempotencyKey: key(),
    });
    expect(
      await applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM),
    ).toEqual({ granted: 0, skipped: 0 });
    expect(await periodsOf(eA.id)).not.toContain("2044-03-15");

    await updateLeaveSettings(tenantScope(), hr, {
      collectiveLeaveDeductsAnnual: true,
      annualLeaveTypeId: null,
      idempotencyKey: key(),
    });
    await applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);
    expect(await periodsOf(eA.id)).toEqual([
      "2043-12-26",
      "2044-02-10",
      "2044-03-15",
    ]);
    // Joined 2044-03-01: the 2044-03-15 collective day applies.
    expect(await periodsOf(eLate.id)).toEqual(["2044-03-15"]);
    expect(await usedOf(eA.id, 2044)).toBe("2.0000");
  });

  it("an outlet-scoped context cannot run it", async () => {
    expect(
      (
        await failure(
          applyCollectiveLeaveDeductions(outletScope(outletA), NOW, SYSTEM),
        )
      ).status,
    ).toBe(403);
  });

  it("the daily leave job runs the deduction as its first step", async () => {
    await holiday("2044-04-01", "collective");
    const result = await runScheduledLeaveJobs(
      workerContext(),
      new Date("2044-06-16T05:00:00Z"),
    );
    expect(result.ran).toBe(true);
    if (!result.ran) throw new Error("unreachable");
    expect(result.collective.granted).toBeGreaterThanOrEqual(2);
    // 2044-06-15 is now in the past too.
    expect(await periodsOf(eA.id)).toEqual([
      "2043-12-26",
      "2044-02-10",
      "2044-03-15",
      "2044-04-01",
      "2044-06-15",
    ]);
    // National and company holidays never deduct.
    expect(await periodsOf(eA.id)).not.toContain("2044-01-01");
    expect(await periodsOf(eA.id)).not.toContain("2044-05-01");
  });
});

describe("collective day that is already a national or company holiday", () => {
  it("is not deducted for staff whose scope has that holiday, only for the rest", async () => {
    // Company holiday at outlet A on a tenant-wide collective day.
    await holiday("2044-05-10", "collective");
    await holiday("2044-05-10", "company", outletA);
    // Tenant-wide national holiday on an outlet-B collective day.
    await holiday("2044-05-11", "collective", outletB);
    await holiday("2044-05-11", "national");
    // National holiday at outlet B on a tenant-wide collective day.
    await holiday("2044-05-12", "collective");
    await holiday("2044-05-12", "national", outletB);
    // Control: a plain collective day.
    await holiday("2044-05-13", "collective");

    await applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);

    const a = await periodsOf(eA.id);
    const b = await periodsOf(eB.id);
    // Outlet A has its own company holiday on 05-10; outlet B does not.
    expect(a).not.toContain("2044-05-10");
    expect(b).toContain("2044-05-10");
    // The national day covers everyone; nobody is deducted.
    expect(a).not.toContain("2044-05-11");
    expect(b).not.toContain("2044-05-11");
    // Outlet B's national day does not reach outlet A.
    expect(a).toContain("2044-05-12");
    expect(b).not.toContain("2044-05-12");
    expect(a).toContain("2044-05-13");
    expect(b).toContain("2044-05-13");
  });
});

describe("collective leave cutover and leave type switch", () => {
  const setFrom = (collectiveLeaveEffectiveFrom: string | null) =>
    updateLeaveSettings(tenantScope(), hr, {
      collectiveLeaveDeductsAnnual: true,
      annualLeaveTypeId: null,
      collectiveLeaveEffectiveFrom,
      idempotencyKey: key(),
    });
  const countOf = async (employeeId: string, period: string) =>
    Number(
      (
        await sql<{ n: string }>(
          `SELECT count(*)::text AS n FROM leave_accruals
            WHERE tenant_id = $1 AND employee_id = $2 AND period = $3
              AND kind = 'collective_leave'`,
          [tenantId, employeeId, period],
        )
      )[0]?.n,
    );

  it("deducts only holidays on or after the effective-from date; an earlier date catches up once", async () => {
    await holiday("2044-06-03", "collective"); // before the cutover
    await holiday("2044-06-07", "collective"); // after the cutover
    await setFrom("2044-06-05");
    await applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);
    expect(await countOf(eA.id, "2044-06-03")).toBe(0);
    expect(await countOf(eA.id, "2044-06-07")).toBe(1);

    await setFrom("2044-06-01");
    await applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);
    expect(await countOf(eA.id, "2044-06-03")).toBe(1);
    const used = await usedOf(eA.id, 2044);
    await applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);
    expect(await countOf(eA.id, "2044-06-03")).toBe(1);
    expect(await usedOf(eA.id, 2044)).toBe(used);
    await setFrom(null);
  });

  it("the default cutover is 2027-01-01 when the date is unset", async () => {
    await setFrom(null);
    expect(
      (await getLeaveSettings(tenantScope(), hr, NOW))
        .collectiveLeaveEffectiveFrom,
    ).toBe("2027-01-01");
  });

  it("switching the annual leave type does not deduct the same day again", async () => {
    await holiday("2044-06-08", "collective");
    await applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);
    expect(await countOf(eA.id, "2044-06-08")).toBe(1);
    const used = await usedOf(eA.id, 2044);

    const typeB = await leaveType();
    await updateLeaveSettings(tenantScope(), hr, {
      collectiveLeaveDeductsAnnual: true,
      annualLeaveTypeId: typeB as never,
      idempotencyKey: key(),
    });
    const rerun = await applyCollectiveLeaveDeductions(
      workerContext(),
      NOW,
      SYSTEM,
    );
    expect(rerun.granted).toBe(0);
    expect(await countOf(eA.id, "2044-06-08")).toBe(1);
    expect(await usedOf(eA.id, 2044)).toBe(used);
    expect(
      await sql(
        `SELECT 1 FROM leave_balances
          WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3`,
        [tenantId, eA.id, typeB],
      ),
    ).toEqual([]);

    await setFrom(null);
  });
});

describe("collective day inside a leave request (no double deduction)", () => {
  /** A request row as the request service leaves it; `days` is its count. */
  const request = (
    employeeId: string,
    range: [string, string],
    days: string,
    status: "pending" | "approved",
  ) =>
    sql<{ id: string }>(
      `INSERT INTO leave_requests
         (tenant_id, outlet_id, employee_id, leave_type_id, period_year,
          start_date, end_date, days, status, requested_by, requested_at)
       VALUES ($1, $2, $3, $4, 2044, $5, $6, $7, $8, $9, clock_timestamp())
       RETURNING id`,
      [
        tenantId,
        outletA,
        employeeId,
        annualTypeId,
        range[0],
        range[1],
        days,
        status,
        hr,
      ],
    );
  const in2044 = (periods: string[]) =>
    periods.filter((period) => period.startsWith("2044")).length;
  const setUsed = (employeeId: string, used: string) =>
    sql(
      `INSERT INTO leave_balances
         (tenant_id, employee_id, leave_type_id, period_year, entitled_days, used_days)
       VALUES ($1, $2, $3, 2044, '12', $4)
       ON CONFLICT (tenant_id, employee_id, leave_type_id, period_year)
       DO UPDATE SET used_days = EXCLUDED.used_days`,
      [tenantId, employeeId, annualTypeId, used],
    );

  it("a collective day added after an approved 5-day request is not deducted again", async () => {
    const e = await employee(outletA, "2040-01-02");
    await request(e.id, ["2044-04-20", "2044-04-24"], "5.0000", "approved");
    await setUsed(e.id, "5.0000");
    await holiday("2044-04-22", "collective"); // added after the request
    await applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);
    // A new employee also takes the earlier collective days of this file.
    const periods = await periodsOf(e.id);
    expect(periods).not.toContain("2044-04-22");
    expect(Number(await usedOf(e.id, 2044))).toBe(5 + in2044(periods));
  });

  it("a pending request is skipped too; once rejected, a later run deducts the day", async () => {
    const e = await employee(outletA, "2040-01-02");
    const [row] = await request(
      e.id,
      ["2044-04-25", "2044-04-26"],
      "2.0000",
      "pending",
    );
    await holiday("2044-04-25", "collective");
    await applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);
    expect(await periodsOf(e.id)).not.toContain("2044-04-25");

    await sql(
      `UPDATE leave_requests SET status = 'rejected' WHERE tenant_id = $1 AND id = $2`,
      [tenantId, row!.id],
    );
    await applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);
    const periods = await periodsOf(e.id);
    expect(periods).toContain("2044-04-25");
    expect(Number(await usedOf(e.id, 2044))).toBe(in2044(periods));
  });

  it("a request filed after the collective day existed (day excluded from its count) still deducts it", async () => {
    const e = await employee(outletA, "2040-01-02");
    await holiday("2044-04-28", "collective"); // known before filing
    await request(e.id, ["2044-04-27", "2044-04-29"], "2.0000", "approved");
    await setUsed(e.id, "2.0000");
    await applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);
    const periods = await periodsOf(e.id);
    expect(periods).toContain("2044-04-28");
    expect(Number(await usedOf(e.id, 2044))).toBe(2 + in2044(periods));
  });
});

describe("removing, moving or retyping a deducted collective day reverses it", () => {
  const countOf = async (employeeId: string, period: string) =>
    (await periodsOf(employeeId)).filter((p) => p === period).length;
  const reversedAudits = (holidayId: string) =>
    sql<{ after: { date: string; reversed: number } }>(
      `SELECT event->'maskedChanges'->'after' AS after FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'hris.leave_collective.reversed'
          AND event->>'objectId' = $2`,
      [tenantId, holidayId],
    );

  it("delete: the ledger row goes, `used` gets the day back, audited once", async () => {
    const day = await holiday("2044-04-08", "collective");
    await applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);
    expect(await countOf(eA.id, "2044-04-08")).toBe(1);
    const used = Number(await usedOf(eA.id, 2044));

    await deleteHoliday(tenantScope(), hr, day.id);
    expect(await countOf(eA.id, "2044-04-08")).toBe(0);
    expect(await countOf(eB.id, "2044-04-08")).toBe(0);
    expect(Number(await usedOf(eA.id, 2044))).toBe(used - 1);
    const audits = await reversedAudits(day.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after.date).toBe("2044-04-08");
    expect(audits[0]!.after.reversed).toBeGreaterThanOrEqual(2);

    await applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);
    expect(await countOf(eA.id, "2044-04-08")).toBe(0);
    expect(Number(await usedOf(eA.id, 2044))).toBe(used - 1);
  });

  it("move: the old date is reversed (a replay reverses nothing more), the new date deducts once", async () => {
    const day = await holiday("2044-04-09", "collective");
    await applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);
    const used = Number(await usedOf(eA.id, 2044));
    const body = {
      date: "2044-04-10",
      idempotencyKey: key(),
    } as never;
    await updateHoliday(tenantScope(), hr, day.id, body);
    expect(await countOf(eA.id, "2044-04-09")).toBe(0);
    expect(Number(await usedOf(eA.id, 2044))).toBe(used - 1);
    await updateHoliday(tenantScope(), hr, day.id, body); // replay
    expect(Number(await usedOf(eA.id, 2044))).toBe(used - 1);
    expect(await reversedAudits(day.id)).toHaveLength(1);

    await applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);
    expect(await countOf(eA.id, "2044-04-10")).toBe(1);
    expect(Number(await usedOf(eA.id, 2044))).toBe(used);
  });

  it("retype to national: reversed and never deducted again", async () => {
    const day = await holiday("2044-04-11", "collective");
    await applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);
    const used = Number(await usedOf(eA.id, 2044));
    await updateHoliday(tenantScope(), hr, day.id, {
      type: "national",
      idempotencyKey: key(),
    } as never);
    await applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);
    expect(await countOf(eA.id, "2044-04-11")).toBe(0);
    expect(Number(await usedOf(eA.id, 2044))).toBe(used - 1);
  });

  it("only staff no longer covered by another collective row on that date are reversed", async () => {
    const wide = await holiday("2044-04-14", "collective");
    await holiday("2044-04-14", "collective", outletA);
    await applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);
    const usedA = Number(await usedOf(eA.id, 2044));
    const usedB = Number(await usedOf(eB.id, 2044));

    await deleteHoliday(tenantScope(), hr, wide.id);
    expect(await countOf(eA.id, "2044-04-14")).toBe(1);
    expect(await countOf(eB.id, "2044-04-14")).toBe(0);
    expect(Number(await usedOf(eA.id, 2044))).toBe(usedA);
    expect(Number(await usedOf(eB.id, 2044))).toBe(usedB - 1);
  });
});

describe("collective day in a year whose carry-over already ran", () => {
  const carryInto2044 = (employeeId: string) =>
    sql(
      `INSERT INTO leave_accruals (tenant_id, employee_id, leave_type_id, kind, period, days)
       VALUES ($1, $2, $3, 'carry_over', '2044', '0')`,
      [tenantId, employeeId, annualTypeId],
    );
  const dropCarry = () =>
    sql(
      `DELETE FROM leave_accruals WHERE tenant_id = $1 AND kind = 'carry_over' AND period = '2044'`,
      [tenantId],
    );

  it("the job skips a previous-year day for an employee whose carry-over ran", async () => {
    await holiday("2043-11-05", "collective");
    await carryInto2044(eA.id);
    try {
      await applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);
      expect(await periodsOf(eA.id)).not.toContain("2043-11-05");
      expect(await periodsOf(eB.id)).toContain("2043-11-05");
    } finally {
      await dropCarry();
    }
  });

  it("create, move or retype into that year, or reversing a deduction there, is a 422 LEAVE_YEAR_CARRIED_OVER", async () => {
    const may = await holiday("2044-05-20", "collective");
    const national = await holiday("2043-11-10", "national");
    const [dec26] = await sql<{ id: string }>(
      `SELECT id FROM holidays WHERE tenant_id = $1 AND date = '2043-12-26'
         AND type = 'collective' AND outlet_id IS NULL`,
      [tenantId],
    );
    await carryInto2044(eA.id);
    try {
      const refused = { status: 422, code: "LEAVE_YEAR_CARRIED_OVER" };
      expect(await failure(holiday("2043-11-03", "collective"))).toEqual(
        refused,
      );
      expect(
        await failure(
          updateHoliday(tenantScope(), hr, may.id, {
            date: "2043-11-04",
            idempotencyKey: key(),
          } as never),
        ),
      ).toEqual(refused);
      expect(
        await failure(
          updateHoliday(tenantScope(), hr, national.id, {
            type: "collective",
            idempotencyKey: key(),
          } as never),
        ),
      ).toEqual(refused);
      // 2043-12-26 was deducted for eA earlier: reversing it is refused.
      expect(
        await failure(deleteHoliday(tenantScope(), hr, dec26!.id)),
      ).toEqual(refused);
      expect(await periodsOf(eA.id)).toContain("2043-12-26");
      // A national day in that year and a collective day in the open year pass.
      await holiday("2043-11-11", "national");
      await holiday("2044-05-21", "collective");
    } finally {
      await dropCarry();
    }
  });
});
