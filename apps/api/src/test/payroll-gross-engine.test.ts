// Gross engine (bead 8di9d, wave 538-G2). Fail-first tests for
// `computeEmployeeGross` in services/payroll-components.service.ts.
//
// Signature chosen by the test author (also recorded in
// docs/briefs/538-g2-work.md):
//
//   computeEmployeeGross(
//     ctx: ScopedTenantContext, userId: string,
//     input: {
//       employeeId: string; periodStart: BusinessDate; periodEnd: BusinessDate;
//       payslipId: string;                 // row id the sealed calculation binds to
//       overtimeParameters: OvertimeParameters;
//     },
//   ): Promise<{
//     grossIdr: number; deductionsIdr: number; netIdr: number; overtimeIdr: number;
//     overtimeMinutes: number;
//     lines: PayslipLine[];                // shared payslipLineSchema
//     sealed: { calculation: Buffer; keyVersion: number };
//   }>
//
// Rules from PRD §3 D.29/D.30, PRD §6 H (`employee_pay_components`, `payslips`)
// and the shared validators (components.ts, payslips.ts, statutory.ts):
//  - earning components add to gross, deduction components to deductions;
//    net = gross - deductions and is never negative (deductions are capped);
//  - overtime pay = computeOvertimePay over the monthly overtime base (sum of
//    the employee's earning amounts whose component has overtimeBase = true)
//    and the overtime minutes of the period's attendance logs;
//  - no duplicate component line; no negative amount;
//  - the calculation is sealed (payslips.calculation, AAD-bound to the row).
//
// Assumptions where the spec is silent:
//  A1 amount of a component for the period = the row in effect on periodEnd
//     (no proration); inactive components are skipped.
//  A2 overtime counts only on attendance logs of type 'out' inside
//     [periodStart, periodEnd] that are approved: validity 'valid' (review
//     none/accepted) or flagged-then-accepted. Pending flagged and rejected
//     logs never count. Hours are computed per business day (tiers are per
//     day) and every day is a 'workday'.
//  A3 deductions beyond gross are cut in displayOrder order (earlier lines
//     keep their full amount, the last ones shrink, then drop to 0).
//  A4 no overtime minutes -> no overtime line; no components -> zero totals
//     and no lines.
//  A5 invalid input (unknown employee, other tenant, periodEnd < periodStart)
//     rejects with an HTTP-style `status` 4xx.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { openPayrollValue } from "../lib/payroll-sealed.ts";
import * as service from "../services/payroll-components.service.ts";
import { agent, signUp } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const outlet = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdComponents: string[] = [];

const PERIOD_START = "2026-06-01";
const PERIOD_END = "2026-06-30";
const EFFECTIVE = "2026-01-01";

// Same example tiers as the shared fixtures: 173 hours divisor, workday
// 1.5x for the first hour and 2x after. 1h30 => 1*1.5 + 0.5*2 = 2.5 weighted.
const overtimeParameters = {
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
} as const;

const key = () => `gross-engine-${randomUUID()}`;
const codeOf = () =>
  `GE_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

const scope = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
const ctx = scope(tenant.id);

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
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

let actorId: string;
let reviewerId: string;

async function createUser(name: string): Promise<string> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return userId;
}

async function grantRole(userId: string, permissions: string[]) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(tenant.id, async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Gross engine ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["tenant"]),
      ],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenant.id, userId, roleId],
    );
  });
}

async function seedEmployee(): Promise<string> {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant(tenant.id, (db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, 'Karyawan Mesin Gross', $4, 'pkwtt', '2025-03-01', 'active')`,
      [id, tenant.id, `GE-${id.slice(0, 8).toUpperCase()}`, outlet],
    ),
  );
  return id;
}

type ComponentOverrides = Record<string, unknown>;

async function createComponent(overrides: ComponentOverrides = {}) {
  const created = await service.createPayComponent(ctx, actorId, {
    code: codeOf(),
    name: "Komponen mesin gross",
    category: "fixed_allowance",
    recurrence: "fixed",
    taxable: true,
    taxScheme: "gross",
    bpjsBase: false,
    overtimeBase: false,
    thrBase: false,
    displayOrder: 5,
    idempotencyKey: key(),
    ...overrides,
  } as never);
  const component = (created as { data?: { id: string } }).data ?? created;
  createdComponents.push((component as { id: string }).id);
  return component as { id: string };
}

const earning = (overrides: ComponentOverrides = {}) =>
  createComponent(overrides);

const deduction = (overrides: ComponentOverrides = {}) =>
  createComponent({
    category: "custom_deduction",
    taxable: false,
    taxScheme: "gross",
    bpjsBase: false,
    overtimeBase: false,
    thrBase: false,
    ...overrides,
  });

const setAmount = (
  employeeId: string,
  componentId: string,
  amountIdr: number,
  effectiveFrom: string = EFFECTIVE,
) =>
  service.setEmployeePayComponent(ctx, actorId, employeeId, {
    componentId,
    amountIdr,
    effectiveFrom,
    idempotencyKey: key(),
  } as never);

type LogInput = {
  businessDate: string;
  overtimeMinutes: number | null;
  type?: "in" | "out";
  state?: "approved" | "accepted_after_flag" | "pending_flag" | "rejected";
};

async function seedLog(employeeId: string, input: LogInput) {
  const ulid = createUlid();
  const id = ulidToUuid(ulid);
  const state = input.state ?? "approved";
  const validity =
    state === "approved" || state === "accepted_after_flag"
      ? state === "approved"
        ? "valid"
        : "flagged"
      : state === "rejected"
        ? "rejected"
        : "flagged";
  const review =
    state === "accepted_after_flag"
      ? "accepted"
      : state === "pending_flag"
        ? "pending"
        : "none";
  const reviewed = review === "accepted";
  await asTenant(tenant.id, (db) =>
    db.query(
      `INSERT INTO attendance_logs
         (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
          validity, flag_reasons, business_date, overtime_minutes, client_event_id,
          review_status, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, $4, $5, 'selfie_geo', ($6::date + time '12:00') AT TIME ZONE 'UTC', now(),
               $7, '[]'::jsonb, $6::date, $8, $9, $10, $11, $12)`,
      [
        id,
        tenant.id,
        outlet,
        employeeId,
        input.type ?? "out",
        input.businessDate,
        validity,
        input.overtimeMinutes,
        `ge-${id}`,
        review,
        reviewed ? reviewerId : null,
        reviewed ? new Date().toISOString() : null,
      ],
    ),
  );
}

const compute = (
  employeeId: string,
  overrides: Record<string, unknown> = {},
) =>
  service.computeEmployeeGross(ctx, actorId, {
    employeeId,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    payslipId: randomUUID(),
    overtimeParameters,
    ...overrides,
  } as never);

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { status?: number; message: string };
  }
  throw new Error("Expected a failure");
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  actorId = await createUser("Gross engine actor");
  await grantRole(actorId, ["payroll.view", "payroll.run"]);
  reviewerId = await createUser("Gross engine reviewer");
});

afterAll(async () => {
  await asTenant(tenant.id, async (db) => {
    await db.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'gross-engine-%'",
      [tenant.id],
    );
    await db.query(
      "DELETE FROM attendance_logs WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await db.query(
      "DELETE FROM employee_pay_components WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await db.query(
      "DELETE FROM pay_components WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdComponents],
    );
    await db.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await db.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenant.id, createdUsers],
    );
    await db.query("DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)", [
      tenant.id,
      createdRoles,
    ]);
  });
  await owner
    .query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers])
    .catch(() => undefined);
  await owner.end();
});

describe("computeEmployeeGross: earnings and deductions", () => {
  it("[EARN-DEDUCT] sums earnings into gross, deductions apart, net = gross - deductions", async () => {
    const employeeId = await seedEmployee();
    const salary = await earning({ displayOrder: 1 });
    const meal = await earning({
      category: "meal_allowance",
      displayOrder: 2,
    });
    const loan = await deduction({ displayOrder: 10 });
    await setAmount(employeeId, salary.id, 5_000_000);
    await setAmount(employeeId, meal.id, 600_000);
    await setAmount(employeeId, loan.id, 250_000);

    const result = await compute(employeeId);

    expect(result.grossIdr).toBe(5_600_000);
    expect(result.deductionsIdr).toBe(250_000);
    expect(result.netIdr).toBe(5_350_000);
    expect(result.overtimeIdr).toBe(0);
    const earnings = result.lines.filter((l) => l.kind === "earning");
    const deductions = result.lines.filter((l) => l.kind === "deduction");
    expect(earnings.map((l) => l.amountIdr).sort()).toEqual([
      600_000, 5_000_000,
    ]);
    expect(deductions.map((l) => l.amountIdr)).toEqual([250_000]);
    // Line totals agree with the payslip arithmetic of the shared validator.
    expect(earnings.reduce((s, l) => s + l.amountIdr, 0)).toBe(
      result.grossIdr,
    );
    expect(deductions.reduce((s, l) => s + l.amountIdr, 0)).toBe(
      result.deductionsIdr,
    );
    // Taxable flag follows the component.
    expect(earnings.every((l) => l.taxable)).toBe(true);
    expect(deductions.every((l) => !l.taxable)).toBe(true);
  });

  it("[EARN-DEDUCT] uses the amount in effect at period end and skips inactive components", async () => {
    const employeeId = await seedEmployee();
    const raise = await earning({ displayOrder: 1 });
    const stopped = await earning({ displayOrder: 2 });
    const future = await earning({ displayOrder: 3 });
    await setAmount(employeeId, raise.id, 1_000_000);
    await setAmount(employeeId, raise.id, 1_200_000, "2026-06-11");
    await setAmount(employeeId, stopped.id, 700_000);
    await service.updatePayComponent(ctx, actorId, stopped.id, {
      isActive: false,
      idempotencyKey: key(),
    } as never);
    await setAmount(employeeId, future.id, 900_000, "2026-07-01");

    const result = await compute(employeeId);

    expect(result.grossIdr).toBe(1_200_000);
    expect(result.lines.map((l) => l.amountIdr)).toEqual([1_200_000]);
  });

  it("[EMPTY] employee without components or attendance gets zero totals and no lines", async () => {
    const employeeId = await seedEmployee();

    const result = await compute(employeeId);

    expect(result).toMatchObject({
      grossIdr: 0,
      deductionsIdr: 0,
      netIdr: 0,
      overtimeIdr: 0,
    });
    expect(result.lines).toEqual([]);
  });
});

describe("computeEmployeeGross: overtime from attendance minutes", () => {
  it("[OVERTIME] pays tiered overtime on the overtimeBase components only", async () => {
    const employeeId = await seedEmployee();
    // Overtime base = 15,000,000 + 2,300,000 = 17,300,000 -> 100,000 / hour.
    const base = await earning({ overtimeBase: true, displayOrder: 1 });
    const allowance = await earning({ overtimeBase: true, displayOrder: 2 });
    const transport = await earning({
      category: "transport_allowance",
      overtimeBase: false,
      displayOrder: 3,
    });
    await setAmount(employeeId, base.id, 15_000_000);
    await setAmount(employeeId, allowance.id, 2_300_000);
    await setAmount(employeeId, transport.id, 500_000);
    // Day 1: 90 min = 1.5 h -> 1 x 1.5 + 0.5 x 2.0 = 2.5 -> 250,000.
    await seedLog(employeeId, {
      businessDate: "2026-06-03",
      overtimeMinutes: 90,
    });
    // Day 2: 30 min = 0.5 h -> 0.5 x 1.5 = 0.75 -> 75,000.
    await seedLog(employeeId, {
      businessDate: "2026-06-04",
      overtimeMinutes: 30,
    });

    const result = await compute(employeeId);

    expect(result.overtimeIdr).toBe(325_000);
    expect(result.overtimeMinutes).toBe(120);
    expect(result.grossIdr).toBe(15_000_000 + 2_300_000 + 500_000 + 325_000);
    const overtimeLines = result.lines.filter((l) => l.category === "overtime");
    expect(overtimeLines).toHaveLength(1);
    expect(overtimeLines[0]).toMatchObject({
      kind: "earning",
      amountIdr: 325_000,
      quantity: "2.0000",
    });
  });

  it("[OVERTIME] counts only approved minutes inside the period", async () => {
    const employeeId = await seedEmployee();
    const base = await earning({ overtimeBase: true });
    await setAmount(employeeId, base.id, 17_300_000); // 100,000 / hour
    // Counted: valid, and flagged-then-accepted (30 min each = 75,000 each).
    await seedLog(employeeId, {
      businessDate: "2026-06-05",
      overtimeMinutes: 30,
    });
    await seedLog(employeeId, {
      businessDate: "2026-06-06",
      overtimeMinutes: 30,
      state: "accepted_after_flag",
    });
    // Never counted: pending review, rejected, outside the period, a clock-in
    // row, and a row without minutes.
    await seedLog(employeeId, {
      businessDate: "2026-06-07",
      overtimeMinutes: 600,
      state: "pending_flag",
    });
    await seedLog(employeeId, {
      businessDate: "2026-06-08",
      overtimeMinutes: 600,
      state: "rejected",
    });
    await seedLog(employeeId, {
      businessDate: "2026-05-31",
      overtimeMinutes: 600,
    });
    await seedLog(employeeId, {
      businessDate: "2026-07-01",
      overtimeMinutes: 600,
    });
    await seedLog(employeeId, {
      businessDate: "2026-06-09",
      overtimeMinutes: 600,
      type: "in",
    });
    await seedLog(employeeId, {
      businessDate: "2026-06-10",
      overtimeMinutes: null,
    });

    const result = await compute(employeeId);

    expect(result.overtimeMinutes).toBe(60);
    expect(result.overtimeIdr).toBe(150_000);
  });

  it("[OVERTIME] attendance without any pay components yields no overtime (no base)", async () => {
    const employeeId = await seedEmployee();
    await seedLog(employeeId, {
      businessDate: "2026-06-03",
      overtimeMinutes: 120,
    });

    const result = await compute(employeeId);

    expect(result.overtimeIdr).toBe(0);
    expect(result.grossIdr).toBe(0);
    expect(result.lines.filter((l) => l.category === "overtime")).toEqual([]);
  });

  it("[OVERTIME] no overtime minutes means no overtime line", async () => {
    const employeeId = await seedEmployee();
    const base = await earning({ overtimeBase: true });
    await setAmount(employeeId, base.id, 4_000_000);

    const result = await compute(employeeId);

    expect(result.overtimeIdr).toBe(0);
    expect(result.lines.some((l) => l.category === "overtime")).toBe(false);
  });
});

describe("computeEmployeeGross: money guards", () => {
  it("[NET-NOT-NEGATIVE] caps deductions at gross, cutting later lines first", async () => {
    const employeeId = await seedEmployee();
    const salary = await earning({ displayOrder: 1 });
    const first = await deduction({ displayOrder: 10 });
    const second = await deduction({ displayOrder: 20 });
    const third = await deduction({ displayOrder: 30 });
    await setAmount(employeeId, salary.id, 1_000_000);
    await setAmount(employeeId, first.id, 600_000);
    await setAmount(employeeId, second.id, 700_000);
    await setAmount(employeeId, third.id, 300_000);

    const result = await compute(employeeId);

    expect(result.grossIdr).toBe(1_000_000);
    expect(result.deductionsIdr).toBe(1_000_000);
    expect(result.netIdr).toBe(0);
    expect(
      result.lines
        .filter((l) => l.kind === "deduction")
        .map((l) => l.amountIdr),
    ).toEqual([600_000, 400_000]); // third is dropped entirely
    expect(result.lines.every((l) => l.amountIdr >= 0)).toBe(true);
  });

  it("[NET-NOT-NEGATIVE] deductions with no earnings at all never produce negative net", async () => {
    const employeeId = await seedEmployee();
    const loan = await deduction();
    await setAmount(employeeId, loan.id, 500_000);

    const result = await compute(employeeId);

    expect(result.grossIdr).toBe(0);
    expect(result.deductionsIdr).toBe(0);
    expect(result.netIdr).toBe(0);
    expect(result.lines.every((l) => l.amountIdr >= 0)).toBe(true);
  });

  it("[NO-DUPLICATE] a component changed mid-period appears once, and recomputing gives the same result", async () => {
    const employeeId = await seedEmployee();
    const salary = await earning({ displayOrder: 1 });
    await setAmount(employeeId, salary.id, 3_000_000);
    await setAmount(employeeId, salary.id, 3_300_000, "2026-06-15");

    const first = await compute(employeeId);
    const second = await compute(employeeId);

    expect(first.lines).toHaveLength(1);
    expect(first.grossIdr).toBe(3_300_000);
    expect(second.grossIdr).toBe(first.grossIdr);
    expect(second.lines).toEqual(first.lines);
  });

  it("[NO-DUPLICATE] the same component code never yields two lines even with two history rows in the period", async () => {
    const employeeId = await seedEmployee();
    const salary = await earning();
    await setAmount(employeeId, salary.id, 2_000_000, "2026-03-01");
    await setAmount(employeeId, salary.id, 2_100_000, "2026-06-02");
    await setAmount(employeeId, salary.id, 2_200_000, "2026-06-20");

    const result = await compute(employeeId);

    expect(result.lines.filter((l) => l.kind === "earning")).toHaveLength(1);
    expect(result.grossIdr).toBe(2_200_000);
  });
});

describe("computeEmployeeGross: sealed result", () => {
  it("[SEAL] seals the calculation bound to the payslip row and keeps it unreadable in the clear", async () => {
    const employeeId = await seedEmployee();
    const salary = await earning({ overtimeBase: true });
    const loan = await deduction({ displayOrder: 10 });
    await setAmount(employeeId, salary.id, 17_300_000);
    await setAmount(employeeId, loan.id, 125_000);
    await seedLog(employeeId, {
      businessDate: "2026-06-03",
      overtimeMinutes: 90,
    });
    const payslipId = randomUUID();

    const result = await compute(employeeId, { payslipId });

    expect(result.grossIdr).toBe(17_550_000);
    expect(result.netIdr).toBe(17_425_000);
    const sealed = result.sealed.calculation;
    expect(Buffer.isBuffer(sealed)).toBe(true);
    expect(sealed.toString("utf8")).not.toContain("17550000");
    expect(sealed.toString("utf8")).not.toContain("17425000");

    const binding = {
      tenantId: tenant.id,
      table: "payslips",
      rowId: payslipId,
      field: "calculation",
    } as const;
    const opened = JSON.parse(
      openPayrollValue(sealed, binding, result.sealed.keyVersion),
    );
    expect(opened).toMatchObject({
      grossIdr: 17_550_000,
      deductionsIdr: 125_000,
      netIdr: 17_425_000,
      overtimeIdr: 250_000,
    });
    expect(opened.lines).toEqual(result.lines);

    // Bound to its row and tenant: another payslip id or tenant cannot open it.
    expect(() =>
      openPayrollValue(
        sealed,
        { ...binding, rowId: randomUUID() },
        result.sealed.keyVersion,
      ),
    ).toThrow();
    expect(() =>
      openPayrollValue(
        sealed,
        { ...binding, tenantId: randomUUID() },
        result.sealed.keyVersion,
      ),
    ).toThrow();
    // Tampering is detected (fail closed).
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    expect(() =>
      openPayrollValue(tampered, binding, result.sealed.keyVersion),
    ).toThrow();
  });
});

describe("computeEmployeeGross: invalid input", () => {
  it("[ERROR] rejects an unknown employee, another tenant's employee and a reversed period", async () => {
    const employeeId = await seedEmployee();

    const unknown = await failure(compute(randomUUID()));
    expect(unknown.status).toBe(404);

    const otherTenant = scope(randomUUID());
    const crossTenant = await failure(
      service.computeEmployeeGross(otherTenant, actorId, {
        employeeId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        payslipId: randomUUID(),
        overtimeParameters,
      } as never),
    );
    expect(crossTenant.status).toBe(404);

    const reversed = await failure(
      compute(employeeId, {
        periodStart: PERIOD_END,
        periodEnd: PERIOD_START,
      }),
    );
    expect(reversed.status).toBeGreaterThanOrEqual(400);
    expect(reversed.status).toBeLessThan(500);
  });
});
