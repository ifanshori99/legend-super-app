// Scheduled leave jobs against PostgreSQL (bead legend-arj.1): accrual,
// carry-over and carry-over expiry run once per tenant per Asia/Jakarta day
// from the worker sweep, as the system actor, guarded by a durable
// `hris_idempotency` marker keyed `leave-jobs/YYYY-MM-DD`.
//
// Assumptions: everything runs in 2040-2047 (no other test file uses those
// years) and `now` is injected, so the real clock never matters. Services are
// called with server-minted contexts like hris-leave-db.test; rows are checked
// with the owner pool.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema, userIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { leaveTypeInputSchema, type Employee } from "@starter/shared/hris";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  createEmployee,
  type CreateEmployeeInput,
} from "../services/hris-employee.service.ts";
import { createHoliday } from "../services/hris-holiday.service.ts";
import { createLeaveType } from "../services/hris-leave.service.ts";
import { updateLeaveSettings } from "../services/hris-leave-collective.service.ts";
import { runScheduledLeaveJobs } from "../services/hris-leave-jobs.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const emptyTenant = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdTypes: string[] = [];

/** What the worker hands the sweep: tenant-wide scope minted from the job. */
const workerContext = (tenant: string = tenantId) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId: tenant, brandId: null, source: "job" }),
    { kind: "tenant" },
  );
const sessionContext = (tenant: string = tenantId) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
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
  tenant: string = tenantId,
): Promise<R[]> {
  return asOwner(
    tenant,
    async (client) => (await client.query(text, params)).rows,
  );
}

async function hrActor(): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Leave Jobs', $2)`,
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
      `Leave jobs test ${roleId.slice(0, 8)}`,
      JSON.stringify(["hr.employee.manage", "hr.employee.view"]),
      JSON.stringify(["tenant"]),
    ],
  );
  await sql(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [tenantId, userId, roleId],
  );
  return userId;
}

const holiday = (
  date: string,
  type: "national" | "collective" | "company",
  outletId: string | null = null,
) =>
  createHoliday(sessionContext(), hr, {
    date,
    name: `LJ ${type} ${date}`,
    type,
    outletId,
    idempotencyKey: randomUUID(),
  } as never);

const freshNo = () =>
  `J-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
const markerKey = (date: string) => `leave-jobs/${date}`;

const markersOf = async (tenant: string = tenantId) =>
  (
    await sql<{ key: string }>(
      "SELECT key FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'leave-jobs/%' ORDER BY key",
      [tenant],
      tenant,
    )
  ).map((row) => row.key);

let hr: string;
let employee: Employee;
let leaveTypeId: string;

const ledger = (kind?: string) =>
  sql<{ kind: string; period: string; days: string }>(
    `SELECT kind, period, days FROM leave_accruals
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
        AND ($4::text IS NULL OR kind = $4)
      ORDER BY kind, period`,
    [tenantId, employee.id, leaveTypeId, kind ?? null],
  );

const balanceOf = async (year: number) =>
  (
    await sql<{
      entitled_days: string;
      carried_over_days: string;
      used_days: string;
      expires_on: string | null;
    }>(
      `SELECT entitled_days, carried_over_days, used_days,
              to_char(carry_over_expires_on, 'YYYY-MM-DD') AS expires_on
         FROM leave_balances
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = $4`,
      [tenantId, employee.id, leaveTypeId, year],
    )
  )[0] ?? null;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Leave jobs empty tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [emptyTenant, `leave-jobs-${emptyTenant.slice(0, 8)}`, tenantId],
  );
  hr = await hrActor();
  const type = await createLeaveType(sessionContext(), hr, {
    ...leaveTypeInputSchema.parse({
      code: `JB_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`,
      name: "Cuti job",
      paid: true,
      requiresAttachment: false,
      policy: {
        annualDays: "12.0000",
        carryOverMaxDays: "5.0000",
        carryOverExpiryMonths: 2,
        tracksBalance: true,
        accrual: "upfront",
        negativeAllowanceDays: "0.0000",
      },
    }),
    idempotencyKey: randomUUID(),
  });
  leaveTypeId = type.id;
  createdTypes.push(type.id);
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Leave Jobs Staff', $2)`,
    [userId, `${userId}@example.test`],
  );
  employee = await createEmployee(sessionContext(), hr, {
    userId: userIdSchema.parse(userId),
    legalEntityId: null,
    employeeNo: freshNo(),
    fullName: "Karyawan Job",
    positionId: null,
    orgUnitId: null,
    managerId: null,
    homeOutletId: outletA,
    employmentType: "pkwt",
    joinDate: "2026-01-05",
    endDate: null,
    ptkpStatus: "TK/0",
    status: "active",
  } as CreateEmployeeInput);
  // 2040: entitled 10, used 4 -> 6 unused; the cap carries 5 into 2041, which
  // expire on 2041-03-01 (2 months into the year).
  await sql(
    `INSERT INTO leave_balances
       (id, tenant_id, employee_id, leave_type_id, period_year,
        entitled_days, carried_over_days, used_days, pending_days, updated_at)
     VALUES ($1, $2, $3, $4, 2040, '10', '0', '4', '0', now())`,
    [randomUUID(), tenantId, employee.id, leaveTypeId],
  );
});

afterAll(async () => {
  setAuditWriter(null);
  await asOwner(tenantId, async (client) => {
    // The jobs run for every active employee and type of the tenant, so
    // clean by year range, not by owner.
    await client.query(
      "DELETE FROM leave_accruals WHERE tenant_id = $1 AND period LIKE '204_%'",
      [tenantId],
    );
    await client.query(
      "DELETE FROM leave_balances WHERE tenant_id = $1 AND period_year BETWEEN 2040 AND 2047",
      [tenantId],
    );
    await client.query("DELETE FROM hris_leave_settings WHERE tenant_id = $1", [
      tenantId,
    ]);
    await client.query(
      "DELETE FROM holidays WHERE tenant_id = $1 AND name LIKE 'LJ %'",
      [tenantId],
    );
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND (key LIKE 'leave-jobs/204%' OR key LIKE 'leave-jobs:204%')",
      [tenantId],
    );
    await client.query(
      "DELETE FROM leave_types WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, createdTypes],
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
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdRoles],
    );
  });
  // Audit rows may be append-only; the database is disposable per run.
  await owner
    .query("DELETE FROM hris_idempotency WHERE tenant_id = $1", [emptyTenant])
    .catch(() => undefined);
  await owner
    .query("DELETE FROM tenants WHERE id = $1", [emptyTenant])
    .catch(() => undefined);
  await owner
    .query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers])
    .catch(() => undefined);
  await owner.end();
});

describe("runScheduledLeaveJobs", () => {
  // 2041-03-15 05:00Z = 12:00 WIB the same day.
  const day1 = new Date("2041-03-15T05:00:00Z");

  it("first run grants accrual, carry-over and expiry as the system and writes the marker", async () => {
    const result = await runScheduledLeaveJobs(workerContext(), day1);
    expect(result.ran).toBe(true);
    expect(result.date).toBe("2041-03-15");
    if (!result.ran) throw new Error("unreachable");
    expect(result.accrual.granted).toBeGreaterThanOrEqual(1);
    expect(result.carryOver.granted).toBeGreaterThanOrEqual(1);
    expect(result.expiry.granted).toBeGreaterThanOrEqual(1);

    // upfront type: 12 for 2041; 2040 leftover 6 capped at 5, then forfeited
    // because the 2041-03-01 expiry is before today and nothing was taken.
    expect(await ledger()).toEqual([
      { kind: "carry_over", period: "2041", days: "5.0000" },
      { kind: "carry_over_expiry", period: "2041", days: "-5.0000" },
      { kind: "grant", period: "2041", days: "12.0000" },
    ]);
    expect(await balanceOf(2041)).toMatchObject({
      entitled_days: "12.0000",
      carried_over_days: "0.0000",
      expires_on: "2041-03-01",
    });
    expect(await markersOf()).toContain(markerKey("2041-03-15"));

    // Ledger created_by stays null and audit rows say system, no user id.
    const createdBy = await sql<{ created_by: string | null }>(
      "SELECT created_by FROM leave_accruals WHERE tenant_id = $1 AND employee_id = $2",
      [tenantId, employee.id],
    );
    expect(createdBy.every((row) => row.created_by === null)).toBe(true);
    for (const action of [
      "hris.leave_accrual.run",
      "hris.leave_carry_over.run",
      "hris.leave_carry_over.expired",
    ]) {
      const rows = await sql<{ actor_type: string; actor_id: string | null }>(
        `SELECT event->>'actorType' AS actor_type, event->>'actorId' AS actor_id
           FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = $2
            AND event->>'createdAt' = $3`,
        [tenantId, action, day1.toISOString()],
      );
      expect(rows).toEqual([{ actor_type: "system", actor_id: null }]);
    }
  });

  it("a second run on the same local day is a no-op", async () => {
    const before = await sql<{ n: string }>(
      "SELECT count(*) AS n FROM audit_logs WHERE tenant_id = $1 AND event->>'action' LIKE 'hris.leave_%'",
      [tenantId],
    );
    const result = await runScheduledLeaveJobs(
      workerContext(),
      new Date("2041-03-15T16:59:00Z"), // 23:59 WIB, still the same day
    );
    expect(result).toEqual({ ran: false, date: "2041-03-15" });
    const after = await sql<{ n: string }>(
      "SELECT count(*) AS n FROM audit_logs WHERE tenant_id = $1 AND event->>'action' LIKE 'hris.leave_%'",
      [tenantId],
    );
    expect(after).toEqual(before);
  });

  it("the next local day runs again without a double grant", async () => {
    const ledgerBefore = await ledger();
    const result = await runScheduledLeaveJobs(
      workerContext(),
      new Date("2041-03-15T17:00:00Z"), // 00:00 WIB on 2041-03-16
    );
    expect(result.ran).toBe(true);
    expect(result.date).toBe("2041-03-16");
    if (!result.ran) throw new Error("unreachable");
    expect(result.carryOver.granted).toBe(0);
    expect(result.expiry.granted).toBe(0);
    expect(await ledger()).toEqual(ledgerBefore);
    expect(await balanceOf(2041)).toMatchObject({
      entitled_days: "12.0000",
      carried_over_days: "0.0000",
    });
    expect(await markersOf()).toEqual(
      expect.arrayContaining([
        markerKey("2041-03-15"),
        markerKey("2041-03-16"),
      ]),
    );
  });

  it("uses the Asia/Jakarta business date at the year boundary", async () => {
    // 2041-12-31T17:30Z is 00:30 WIB on 2042-01-01.
    const result = await runScheduledLeaveJobs(
      workerContext(),
      new Date("2041-12-31T17:30:00Z"),
    );
    expect(result.ran).toBe(true);
    expect(result.date).toBe("2042-01-01");
    const keys = await markersOf();
    expect(keys).toContain(markerKey("2042-01-01"));
    expect(keys).not.toContain(markerKey("2041-12-31"));
    // Local year 2042: accrual for 2042, carry-over of 2041 (not 2040).
    expect(await ledger("grant")).toEqual(
      expect.arrayContaining([
        { kind: "grant", period: "2042", days: "12.0000" },
      ]),
    );
    expect(await ledger("carry_over")).toEqual(
      expect.arrayContaining([
        { kind: "carry_over", period: "2042", days: "5.0000" },
      ]),
    );
    expect((await balanceOf(2042))?.carried_over_days).toBe("5.0000");
  });

  it("a failing step leaves no marker and the next tick retries", async () => {
    const badType = randomUUID();
    // A policy the service cannot parse makes the accrual step throw.
    await sql(
      `INSERT INTO leave_types (id, tenant_id, code, name, paid, requires_attachment, policy, is_active)
       VALUES ($1, $2, 'BROKEN', 'Broken', true, false, '{}'::jsonb, true)`,
      [badType, emptyTenant],
      emptyTenant,
    );
    const now = new Date("2041-05-10T03:00:00Z");
    await expect(
      runScheduledLeaveJobs(workerContext(emptyTenant), now),
    ).rejects.toBeDefined();
    expect(await markersOf(emptyTenant)).toEqual([]);

    await sql("DELETE FROM leave_types WHERE id = $1", [badType], emptyTenant);
    const retry = await runScheduledLeaveJobs(workerContext(emptyTenant), now);
    expect(retry.ran).toBe(true);
    expect(await markersOf(emptyTenant)).toEqual([markerKey("2041-05-10")]);
  });

  it("a tenant with nothing to do still gets the marker", async () => {
    const result = await runScheduledLeaveJobs(
      workerContext(emptyTenant),
      new Date("2041-05-11T03:00:00Z"),
    );
    expect(result).toMatchObject({
      ran: true,
      date: "2041-05-11",
      accrual: { granted: 0 },
      carryOver: { granted: 0 },
      expiry: { granted: 0 },
    });
    expect(await markersOf(emptyTenant)).toContain(markerKey("2041-05-11"));
    expect(
      await runScheduledLeaveJobs(
        workerContext(emptyTenant),
        new Date("2041-05-11T09:00:00Z"),
      ),
    ).toEqual({ ran: false, date: "2041-05-11" });
  });
});

describe("runScheduledLeaveJobs with collective leave", () => {
  const useJobType = () =>
    sql(
      `INSERT INTO hris_leave_settings (tenant_id, collective_leave_deducts_annual, annual_leave_type_id)
       VALUES ($1, true, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET annual_leave_type_id = EXCLUDED.annual_leave_type_id`,
      [tenantId, leaveTypeId],
    );
  const clearSettings = () =>
    sql("DELETE FROM hris_leave_settings WHERE tenant_id = $1", [tenantId]);
  const balanceRow = (employeeId: string, year: number) =>
    sql<{ carried_over_days: string; used_days: string }>(
      `SELECT carried_over_days, used_days FROM leave_balances
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = $4`,
      [tenantId, employeeId, leaveTypeId, year],
    ).then((rows) => rows[0] ?? null);

  it("a collective day on 31 Dec is deducted before carry-over computes the leftover", async () => {
    await useJobType();
    try {
      // 2045: entitled 10, used 7 -> 3 left; the 2045-12-31 collective day
      // makes it 2, so 2 (not 3) carries into 2046.
      await sql(
        `INSERT INTO leave_balances
           (id, tenant_id, employee_id, leave_type_id, period_year,
            entitled_days, carried_over_days, used_days, pending_days, updated_at)
         VALUES ($1, $2, $3, $4, 2045, '10', '0', '7', '0', now())`,
        [randomUUID(), tenantId, employee.id, leaveTypeId],
      );
      await holiday("2045-12-31", "collective");
      // 2045-12-31T17:30Z is 00:30 WIB on 2046-01-01.
      const result = await runScheduledLeaveJobs(
        workerContext(),
        new Date("2045-12-31T17:30:00Z"),
      );
      expect(result.ran).toBe(true);
      expect(result.date).toBe("2046-01-01");
      expect(await ledger("collective_leave")).toEqual([
        { kind: "collective_leave", period: "2045-12-31", days: "-1.0000" },
      ]);
      expect(await ledger("carry_over")).toEqual(
        expect.arrayContaining([
          { kind: "carry_over", period: "2046", days: "2.0000" },
        ]),
      );
      expect(await balanceRow(employee.id, 2045)).toMatchObject({
        used_days: "8.0000",
      });
      expect(await balanceRow(employee.id, 2046)).toMatchObject({
        carried_over_days: "2.0000",
      });
    } finally {
      await clearSettings();
    }
  });

  it("a collective day before the carry-over expiry date counts as used, so expiry forfeits one day less", async () => {
    await useJobType();
    try {
      const staff = await createEmployee(sessionContext(), hr, {
        userId: null,
        legalEntityId: null,
        employeeNo: freshNo(),
        fullName: "Karyawan Job Kedua",
        positionId: null,
        orgUnitId: null,
        managerId: null,
        homeOutletId: outletA,
        employmentType: "pkwt",
        joinDate: "2026-01-05",
        endDate: null,
        ptkpStatus: "TK/0",
        status: "active",
      } as CreateEmployeeInput);
      // 5 carried days expiring 2047-03-01, nothing taken yet.
      await sql(
        `INSERT INTO leave_balances
           (id, tenant_id, employee_id, leave_type_id, period_year,
            entitled_days, carried_over_days, used_days, pending_days,
            carry_over_expires_on, updated_at)
         VALUES ($1, $2, $3, $4, 2047, '12', '5', '0', '0', '2047-03-01', now())`,
        [randomUUID(), tenantId, staff.id, leaveTypeId],
      );
      await holiday("2047-02-28", "collective");
      // 2047-03-01 05:00Z = 12:00 WIB, the expiry date itself.
      const result = await runScheduledLeaveJobs(
        workerContext(),
        new Date("2047-03-01T05:00:00Z"),
      );
      expect(result.ran).toBe(true);
      const expiry = await sql<{ days: string }>(
        `SELECT days FROM leave_accruals
          WHERE tenant_id = $1 AND employee_id = $2 AND kind = 'carry_over_expiry'`,
        [tenantId, staff.id],
      );
      expect(expiry).toEqual([{ days: "-4.0000" }]);
      expect(await balanceRow(staff.id, 2047)).toMatchObject({
        carried_over_days: "1.0000",
        used_days: "1.0000",
      });
    } finally {
      await clearSettings();
    }
  });

  it("a user write with the key `leave-jobs:<date>` does not block that day's job", async () => {
    const date = "2047-04-01";
    await updateLeaveSettings(sessionContext(), hr, {
      collectiveLeaveDeductsAnnual: true,
      annualLeaveTypeId: null,
      idempotencyKey: `leave-jobs:${date}`,
    });
    try {
      expect(
        await sql(
          "SELECT 1 FROM hris_idempotency WHERE tenant_id = $1 AND key = $2",
          [tenantId, `leave-jobs:${date}`],
        ),
      ).toHaveLength(1);
      // 2047-04-01 05:00Z = 12:00 WIB.
      const result = await runScheduledLeaveJobs(
        workerContext(),
        new Date("2047-04-01T05:00:00Z"),
      );
      expect(result).toMatchObject({ ran: true, date });
      expect(await markersOf()).toContain(markerKey(date));
    } finally {
      await clearSettings();
    }
  });
});
