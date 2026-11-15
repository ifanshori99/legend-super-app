// legend-esjkw (architect af2b6f37 P3): when a collective leave day is deducted
// AGAIN after carry-over of its year already ran (accepted clock-in later
// rejected), the carry-over of the following years is corrected. Money rule:
// the employee is never granted more carried days than the pool allows, and a
// day that never made it into the carry (because of the cap) is not cut.
//
// Expected behaviour comes from the card text, the carry-over cap policy
// (carried = min(remaining of the previous year, carryOverMaxDays)) and
// docs/PROGRESS.md (collective rededuction: "bila carry-over tahun itu sudah
// jalan, carry tahun berikut dikurangi 1, minimal 0"), not from service code:
//  - Y+1 (the year after the collective day): cut by 1 only when the day was
//    part of the carried days, i.e. remaining(Y) before the cut was at or below
//    the cap and the new remaining is lower than the old carry. Equivalently
//    carry(Y+1) = min(remaining(Y) after the cut, cap).
//  - Y+2: when carry(Y+1) was cut, carry(Y+2) is recomputed the same way from
//    the corrected pool of Y+1 (entitled + carry - used): it is cut by 1 only
//    when the lost day was inside the days carried into Y+2. When Y+1 was not
//    cut (cap), Y+2 is not cut either.
//  - Idempotent: a second run / second reject never cuts again.
//
// Assumptions:
//  - Leave type ANNUAL, annual 12 days, cap 5 days, no carry expiry. The cap
//    check reads "remaining" as entitled + carried - used - pending.
//  - A ledger accrual of kind `carry_over` for the period (year) marks that the
//    carry of that year ran; balances are read from leave_balances only, the
//    carry_over accrual row amounts are not asserted.
//  - Every case has its own outlet and employee, so one case's collective run
//    never touches another case's employee; holidays are inserted straight into
//    the table (the service refuses holidays of a closed year).
//  - Year 2049 is the collective day's year; `now` is injected.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  uuidToUlid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { leaveTypeInputSchema, type Employee } from "@starter/shared/hris";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { decideAttendanceReview } from "../services/hris-attendance-admin.service.ts";
import {
  createEmployee,
  type CreateEmployeeInput,
} from "../services/hris-employee.service.ts";
import { applyCollectiveLeaveDeductions } from "../services/hris-leave-collective.service.ts";
import { createLeaveType } from "../services/hris-leave.service.ts";

const templateTenantId = cafeLegendPlatformFixtures.tenant.id;
const tenantId = tenantIdSchema.parse(randomUUID());
const brandId = randomUUID();
const legalEntityId = randomUUID();
const SYSTEM = { type: "system" } as const;
const YEAR = 2049;
const NOW = new Date("2049-06-15T05:00:00Z"); // 12:00 WIB
const ENTITLED = 12;
const CAP = 5;
const DAY = "2049-05-12";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdTypes: string[] = [];
const createdOutlets: string[] = [];

const tenantScope = () =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
const workerContext = () =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );

async function sql<R extends Record<string, unknown> = Record<string, string>>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const client: PoolClient = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

async function customUser(permissions: string[]): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Carry Cut', $2)`,
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
      `Carry cut ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
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

const key = () => `cbcut-${randomUUID()}`;
const freshNo = () =>
  `CC-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

let hr: string;
let reviewer: string;
let annualTypeId: string;

async function newOutlet(): Promise<string> {
  const id = outletIdSchema.parse(randomUUID());
  createdOutlets.push(id);
  await sql(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet CBCUT', 'Jl. CBCUT', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      id,
      tenantId,
      brandId,
      legalEntityId,
      `CBCUT-${id.replaceAll("-", "").slice(0, 10)}`.toUpperCase(),
    ],
  );
  return id;
}

async function employeeAt(outletId: string): Promise<Employee> {
  return createEmployee(tenantScope(), hr, {
    userId: null,
    legalEntityId: null,
    employeeNo: freshNo(),
    fullName: "Karyawan Carry Cut",
    positionId: null,
    orgUnitId: null,
    managerId: null,
    homeOutletId: outletId,
    employmentType: "pkwt",
    joinDate: "2040-01-02",
    endDate: null,
    ptkpStatus: "TK/0",
    status: "active",
  } as CreateEmployeeInput);
}

async function writeFlaggedLog(
  employeeId: string,
  outletId: string,
): Promise<string> {
  const id = randomUUID();
  await sql(
    `INSERT INTO attendance_logs
       (id, tenant_id, outlet_id, employee_id, type, method, occurred_at,
        validity, flag_reasons, business_date, client_event_id,
        review_status, reviewed_by, reviewed_at)
     VALUES ($1, $2, $3, $4, 'in', 'rotating_qr', ($5::date + time '08:00') AT TIME ZONE 'Asia/Jakarta',
             'flagged', '[]'::jsonb, $5::date, $6, 'pending', NULL, NULL)`,
    [id, tenantId, outletId, employeeId, DAY, `cbcut-log-${id}`],
  );
  return id;
}

const decide = (logId: string, action: "accept" | "reject") =>
  decideAttendanceReview(
    tenantScope(),
    reviewer,
    uuidToUlid(logId),
    { action, idempotencyKey: key() } as never,
    undefined,
    NOW,
  );

const run = () => applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);

async function carryOf(
  employeeId: string,
  year: number,
): Promise<number | null> {
  const rows = await sql<{ c: string }>(
    `SELECT carried_over_days::text AS c FROM leave_balances
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
        AND period_year = $4`,
    [tenantId, employeeId, annualTypeId, year],
  );
  return rows[0] ? Number(rows[0].c) : null;
}

async function usedOf(employeeId: string, year: number): Promise<number> {
  const rows = await sql<{ u: string }>(
    `SELECT used_days::text AS u FROM leave_balances
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
        AND period_year = $4`,
    [tenantId, employeeId, annualTypeId, year],
  );
  return Number(rows[0]?.u ?? "0");
}

/** Carry-over of `year` already ran for the employee: ledger row + balance row. */
async function seedCarry(
  employeeId: string,
  year: number,
  carried: number,
  used: number,
) {
  await sql(
    `INSERT INTO leave_accruals (tenant_id, employee_id, leave_type_id, kind, period, days)
     VALUES ($1, $2, $3, 'carry_over', $4, $5)`,
    [tenantId, employeeId, annualTypeId, String(year), String(carried)],
  );
  await sql(
    `INSERT INTO leave_balances
       (tenant_id, employee_id, leave_type_id, period_year, entitled_days, carried_over_days, used_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      tenantId,
      employeeId,
      annualTypeId,
      year,
      String(ENTITLED),
      String(carried),
      String(used),
    ],
  );
}

/**
 * The collective day of 2049 is deducted, then given back by an accepted
 * clock-in (used back to 0), then year 2049 gets `usedY` days of other leave
 * (so remaining(2049) = 12 - usedY) and carry-over of 2050 (and optionally
 * 2051) ran. Finally the log is rejected: the day is deducted again.
 */
async function scenario(input: {
  usedY: number;
  carry2050: number;
  used2050?: number;
  carry2051?: number;
  /** Policy cap changed after the carry ran (ledger rows keep the old cap). */
  capAfterCarry?: number;
}) {
  const outletId = await newOutlet();
  const e = await employeeAt(outletId);
  await sql(
    `INSERT INTO leave_balances
       (tenant_id, employee_id, leave_type_id, period_year, entitled_days, used_days)
     VALUES ($1, $2, $3, $4, $5, '0')
     ON CONFLICT (tenant_id, employee_id, leave_type_id, period_year)
     DO UPDATE SET used_days = '0', entitled_days = EXCLUDED.entitled_days`,
    [tenantId, e.id, annualTypeId, YEAR, String(ENTITLED)],
  );
  const logId = await writeFlaggedLog(e.id, outletId);
  await sql(
    `INSERT INTO holidays (tenant_id, outlet_id, date, name, type)
     VALUES ($1, $2, $3, $4, 'collective')`,
    [tenantId, outletId, DAY, `CBCUT collective ${outletId}`],
  );
  await run();
  expect(await usedOf(e.id, YEAR)).toBe(1);
  await decide(logId, "accept");
  expect(await usedOf(e.id, YEAR)).toBe(0);

  await sql(
    `UPDATE leave_balances SET used_days = $4
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = $5`,
    [tenantId, e.id, annualTypeId, String(input.usedY), YEAR],
  );
  await seedCarry(e.id, YEAR + 1, input.carry2050, input.used2050 ?? 0);
  if (input.carry2051 !== undefined)
    await seedCarry(e.id, YEAR + 2, input.carry2051, 0);

  if (input.capAfterCarry !== undefined)
    await sql(
      `UPDATE leave_types
          SET policy = jsonb_set(policy, '{carryOverMaxDays}', to_jsonb($3::text))
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, annualTypeId, `${input.capAfterCarry}.0000`],
    );
  try {
    await decide(logId, "reject");
  } finally {
    if (input.capAfterCarry !== undefined)
      await sql(
        `UPDATE leave_types
            SET policy = jsonb_set(policy, '{carryOverMaxDays}', to_jsonb($3::text))
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, annualTypeId, `${CAP}.0000`],
      );
  }
  return { e, logId, outletId };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Carry cut tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantId, `cbcut-${tenantId.slice(0, 8)}`, templateTenantId],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'cbcut', 'CBCUT')",
    [brandId, tenantId],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Entity CBCUT', false)",
    [legalEntityId, tenantId],
  );
  hr = await customUser(["hr.employee.manage", "hr.employee.view"]);
  reviewer = await customUser([
    "hr.attendance.manage",
    "hr.employee.view",
    "hr.employee.manage",
  ]);
  const type = await createLeaveType(tenantScope(), hr, {
    ...leaveTypeInputSchema.parse({
      code: "ANNUAL",
      name: "Cuti carry cut test",
      paid: true,
      requiresAttachment: false,
      policy: {
        annualDays: "12.0000",
        carryOverMaxDays: `${CAP}.0000`,
        carryOverExpiryMonths: 0,
        tracksBalance: true,
      },
    }),
    idempotencyKey: key(),
  });
  createdTypes.push(type.id);
  annualTypeId = type.id;
}, 60_000);

afterAll(async () => {
  setAuditWriter(null);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const mine = `(SELECT id FROM employees WHERE tenant_id = $1 AND created_by = ANY($2))`;
    await client.query(
      `DELETE FROM attendance_logs WHERE tenant_id = $1 AND employee_id IN ${mine}`,
      [tenantId, createdUsers],
    );
    await client.query(
      `DELETE FROM leave_accruals WHERE tenant_id = $1 AND leave_type_id = ANY($2::uuid[])`,
      [tenantId, createdTypes],
    );
    await client.query(
      `DELETE FROM leave_balances WHERE tenant_id = $1 AND leave_type_id = ANY($2::uuid[])`,
      [tenantId, createdTypes],
    );
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'cbcut-%'",
      [tenantId],
    );
    await client.query(
      "DELETE FROM holidays WHERE tenant_id = $1 AND name LIKE 'CBCUT %'",
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
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  // Best effort, like the other private-tenant tests.
  for (const statement of [
    "DELETE FROM outlets WHERE tenant_id = $1",
    "DELETE FROM legal_entities WHERE tenant_id = $1",
    "DELETE FROM brands WHERE tenant_id = $1",
  ])
    await owner.query(statement, [tenantId]).catch(() => undefined);
  await owner
    .query("DELETE FROM tenants WHERE id = $1", [tenantId])
    .catch(() => undefined);
  await owner
    .query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers])
    .catch(() => undefined);
  await owner.end();
});

describe("legend-esjkw: carry of year Y+1 is cut only when the day was carried", () => {
  it("day inside the carry (remaining 4 <= cap 5): carry 4 becomes 3, no 2051 row appears", async () => {
    const { e } = await scenario({ usedY: 8, carry2050: 4 });
    expect(await carryOf(e.id, YEAR + 1)).toBe(3);
    expect(await carryOf(e.id, YEAR + 2)).toBeNull();
  });

  it("remaining exactly at the cap after the cut (5 -> 4): carry 5 becomes 4", async () => {
    const { e } = await scenario({ usedY: 7, carry2050: 5 });
    expect(await carryOf(e.id, YEAR + 1)).toBe(4);
  });

  it("capped carry, remaining far above cap (10 -> 9): the day was not carried, carry stays 5", async () => {
    const { e } = await scenario({ usedY: 2, carry2050: 5 });
    expect(await carryOf(e.id, YEAR + 1)).toBe(5);
  });

  it("remaining still at the cap after the cut (6 -> 5): carry stays 5", async () => {
    const { e } = await scenario({ usedY: 6, carry2050: 5 });
    expect(await carryOf(e.id, YEAR + 1)).toBe(5);
  });
});

describe("legend-esjkw: carry of year Y+2 follows when Y+1 carry already ran", () => {
  it("Y+1 and Y+2 both uncapped: carry 4 -> 3 and carry 4 -> 3, and a second reject or run cuts nothing more", async () => {
    const { e, logId } = await scenario({
      usedY: 8,
      carry2050: 4,
      used2050: 12, // pool 12 + 4 - 12 = 4 remaining, carried on into 2051
      carry2051: 4,
    });
    expect(await carryOf(e.id, YEAR + 1)).toBe(3);
    expect(await carryOf(e.id, YEAR + 2)).toBe(3);
    await run();
    await decide(logId, "reject").catch(() => undefined);
    expect(await carryOf(e.id, YEAR + 1)).toBe(3);
    expect(await carryOf(e.id, YEAR + 2)).toBe(3);
    expect(await usedOf(e.id, YEAR)).toBe(9);
  });

  it("Y+2 remaining at the cap after the cut would be 4: carry 5 -> 4 (boundary)", async () => {
    const { e } = await scenario({
      usedY: 8,
      carry2050: 4,
      used2050: 11, // remaining 5 before the cut, 4 after
      carry2051: 5,
    });
    expect(await carryOf(e.id, YEAR + 1)).toBe(3);
    expect(await carryOf(e.id, YEAR + 2)).toBe(4);
  });

  it("Y+2 capped (remaining 11 -> 10, cap 5): Y+1 is cut, Y+2 stays 5", async () => {
    const { e } = await scenario({
      usedY: 8,
      carry2050: 4,
      used2050: 5,
      carry2051: 5,
    });
    expect(await carryOf(e.id, YEAR + 1)).toBe(3);
    expect(await carryOf(e.id, YEAR + 2)).toBe(5);
  });

  it("Y+1 capped (day never carried): neither Y+1 nor Y+2 is cut", async () => {
    const { e } = await scenario({
      usedY: 2,
      carry2050: 5,
      used2050: 12, // remaining 5 carried into 2051
      carry2051: 5,
    });
    expect(await carryOf(e.id, YEAR + 1)).toBe(5);
    expect(await carryOf(e.id, YEAR + 2)).toBe(5);
  });

  it("Y+2 carry already 0 (pool fully used): never goes negative", async () => {
    const { e } = await scenario({
      usedY: 8,
      carry2050: 4,
      used2050: 16,
      carry2051: 0,
    });
    expect(await carryOf(e.id, YEAR + 1)).toBe(3);
    expect(await carryOf(e.id, YEAR + 2)).toBe(0);
  });
});

describe("legend-esjkw: cap is the carry ledger row of the year, not the policy now", () => {
  it("policy cap raised 5 -> 12 after carry (ledger 5), remaining 10 -> 9: carry stays 5", async () => {
    const { e } = await scenario({
      usedY: 2,
      carry2050: 5,
      capAfterCarry: 12,
    });
    expect(await carryOf(e.id, YEAR + 1)).toBe(5);
  });

  it("policy cap lowered to 0 after carry (ledger 4), remaining 4 -> 3: carry 4 becomes 3", async () => {
    const { e } = await scenario({
      usedY: 8,
      carry2050: 4,
      capAfterCarry: 0,
    });
    expect(await carryOf(e.id, YEAR + 1)).toBe(3);
  });
});
