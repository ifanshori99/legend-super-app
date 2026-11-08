// Overtime on collective leave ("cuti bersama", founder decision Q7) against
// PostgreSQL: working a collective-leave day is paid at the normal workday
// tiers; a national or company holiday forces the formula's rest-day type and
// wins when it falls on the same date as a collective day.
//
// Assumptions: dates are in 2045 with a formula effective from 2045-01-01 (no
// other test file uses that year). Approval goes through the real matrix with
// an `overtime` policy routed to the outlet manager, like hris-overtime-db.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idr, outletIdSchema, userIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { Employee } from "@starter/shared/hris";
import {
  computeOvertimePay,
  type OvertimeParameters,
} from "@starter/shared/hris/payroll";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  createEmployee,
  type CreateEmployeeInput,
} from "../services/hris-employee.service.ts";
import { createHoliday } from "../services/hris-holiday.service.ts";
import {
  computeApprovedOvertimePay,
  createOvertimeFormula,
  createOvertimeRequest,
  decideOvertimeRequest,
  publishOvertimeFormula,
} from "../services/hris-overtime.service.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];

const base = () =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });
const tenantScope = () =>
  establishScopedTenantContext(base(), { kind: "tenant" });
const outletScope = (outletId: string) =>
  establishScopedTenantContext(base(), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

async function asOwner<T>(run: (client: PoolClient) => Promise<T>) {
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

async function customUser(
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Lembur CB', $2)`,
    [userId, `${userId}@example.test`],
  );
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `Lembur CB test ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await client.query(
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
  });
  return userId;
}

async function templateRoleId(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

const key = () => `otcb-${randomUUID()}`;

// PP 35/2021 tiers: workday 1.5x the first hour then 2x; rest day 2x.
const FORMULA: OvertimeParameters = {
  monthlyHoursDivisor: 173,
  tiersByDayType: {
    workday: [
      { fromHour: 0, toHour: 1, multiplier: "1.5000" },
      { fromHour: 1, toHour: null, multiplier: "2.0000" },
    ],
    rest_day_6_day_week: [
      { fromHour: 0, toHour: 7, multiplier: "2.0000" },
      { fromHour: 7, toHour: 8, multiplier: "3.0000" },
      { fromHour: 8, toHour: null, multiplier: "4.0000" },
    ],
    rest_day_5_day_week: [
      { fromHour: 0, toHour: 8, multiplier: "2.0000" },
      { fromHour: 8, toHour: 9, multiplier: "3.0000" },
      { fromHour: 9, toHour: null, multiplier: "4.0000" },
    ],
  },
  roundingMode: "half_up",
} as OvertimeParameters;
// 17.300.000 / 173 = Rp100.000 an hour.
const BASE = idr(17_300_000);
const WORKDAY_2_5H = computeOvertimePay(
  FORMULA,
  "workday",
  "2.5000" as never,
  BASE,
);
const REST_DAY_2_5H = computeOvertimePay(
  FORMULA,
  "rest_day_6_day_week",
  "2.5000" as never,
  BASE,
);

let hr: string;
let staff: string;
let manager: string;
let worker: Employee;

function holiday(
  date: string,
  type: "national" | "collective" | "company",
  outletId: string | null = null,
) {
  return createHoliday(tenantScope(), hr, {
    date,
    name: `OTCB ${type} ${date}`,
    type,
    outletId,
    idempotencyKey: key(),
  } as never);
}

function file(date: string) {
  return createOvertimeRequest(outletScope(outletA), staff, {
    outletId: outletA,
    date,
    minutes: 150,
    reason: "Stok opname saat cuti bersama.",
    idempotencyKey: key(),
  } as never);
}

const approve = (requestId: string) =>
  decideOvertimeRequest(
    outletScope(outletA),
    manager,
    requestId as never,
    { action: "approve", idempotencyKey: key() } as never,
    { mfaVerified: true },
  );

const payOn = (date: string) =>
  computeApprovedOvertimePay(tenantScope(), {
    employeeId: worker.id,
    from: date,
    to: date,
    monthlyBaseIdr: BASE,
  } as never);

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  savedPolicies = (
    await owner.query(
      `SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'overtime'`,
      [tenantId],
    )
  ).rows;
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'overtime'`,
    [tenantId],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'overtime', NULL, $2, 1)`,
    [tenantId, await templateRoleId("outlet_manager")],
  );

  hr = await customUser(["hr.employee.manage", "hr.employee.view"], {
    type: "tenant",
  });
  staff = await customUser(
    ["self.profile.view", "self.leave.request", "self.attendance.clock"],
    { type: "outlet", id: outletA },
  );
  manager = randomUUID();
  createdUsers.push(manager);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Manajer CB', $2)`,
    [manager, `${manager}@example.test`],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenantId, manager, await templateRoleId("outlet_manager"), outletA],
  );

  worker = await createEmployee(tenantScope(), hr, {
    userId: userIdSchema.parse(staff),
    legalEntityId: null,
    employeeNo: `OC-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`,
    fullName: "Lembur Cuti Bersama",
    positionId: null,
    orgUnitId: null,
    managerId: null,
    homeOutletId: outletA,
    employmentType: "pkwt",
    joinDate: "2044-01-02",
    endDate: null,
    ptkpStatus: "TK/0",
    status: "active",
  } as CreateEmployeeInput);

  const draft = await createOvertimeFormula(tenantScope(), hr, {
    effectiveFrom: "2045-01-01",
    parameters: FORMULA,
    restDayType: "rest_day_6_day_week",
    legalBasis: "PP 35/2021 Pasal 31",
    idempotencyKey: key(),
  } as never);
  await publishOvertimeFormula(
    tenantScope(),
    hr,
    draft.id as never,
    {
      idempotencyKey: key(),
    } as never,
  );
});

afterAll(async () => {
  setAuditWriter(null);
  await asOwner(async (client) => {
    const mine = `employee_id IN (SELECT id FROM employees WHERE tenant_id = $1 AND created_by = ANY($2::text[]))`;
    await client.query(
      `DELETE FROM overtime_requests WHERE tenant_id = $1 AND ${mine}`,
      [tenantId, createdUsers],
    );
    await client.query(
      `DELETE FROM overtime_formulas WHERE tenant_id = $1 AND created_by = ANY($2::text[])`,
      [tenantId, createdUsers],
    );
    await client.query(
      `DELETE FROM holidays WHERE tenant_id = $1 AND name LIKE 'OTCB %'`,
      [tenantId],
    );
    await client.query(
      `DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'otcb-%'`,
      [tenantId],
    );
    await client.query(
      `DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])`,
      [tenantId, createdUsers],
    );
    await client.query(
      `DELETE FROM employees WHERE tenant_id = $1 AND created_by = ANY($2::text[])`,
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdRoles],
    );
  });
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'overtime'`,
    [tenantId],
  );
  for (const row of savedPolicies)
    await owner.query(
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
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    createdUsers,
  ]);
  await owner.end();
});

describe("overtime on collective leave (cuti bersama)", () => {
  it("a collective-leave day is paid at the workday tiers", async () => {
    await holiday("2045-03-03", "collective");
    const created = await file("2045-03-03");
    expect(created.dayType).toBe("workday");
    const approved = await approve(created.id);
    expect(approved.dayType).toBe("workday");
    const feed = await payOn("2045-03-03");
    expect(feed.items[0]).toMatchObject({
      dayType: "workday",
      hours: "2.5000",
    });
    // 1h x 1.5 + 1.5h x 2.0 at Rp100.000.
    expect(feed.items[0]!.payIdr).toBe(450_000);
    expect(feed.items[0]!.payIdr).toBe(WORKDAY_2_5H);
  });

  it("a national holiday is paid at the rest-day tiers", async () => {
    await holiday("2045-03-04", "national");
    const created = await file("2045-03-04");
    expect(created.dayType).toBe("rest_day_6_day_week");
    await approve(created.id);
    const feed = await payOn("2045-03-04");
    expect(feed.items[0]!.payIdr).toBe(500_000);
    expect(feed.items[0]!.payIdr).toBe(REST_DAY_2_5H);
  });

  it("a company holiday on the same date as a collective day wins: rest-day pay", async () => {
    await holiday("2045-03-05", "collective");
    await holiday("2045-03-05", "company", outletA);
    const created = await file("2045-03-05");
    expect(created.dayType).toBe("rest_day_6_day_week");
    await approve(created.id);
    const feed = await payOn("2045-03-05");
    expect(feed.items[0]!.payIdr).toBe(REST_DAY_2_5H);
  });

  it("a collective day added after filing keeps workday pay at approval", async () => {
    const created = await file("2045-03-06");
    expect(created.dayType).toBe("workday");
    await holiday("2045-03-06", "collective");
    const approved = await approve(created.id);
    expect(approved.dayType).toBe("workday");
    expect((await payOn("2045-03-06")).items[0]!.payIdr).toBe(WORKDAY_2_5H);
  });
});
