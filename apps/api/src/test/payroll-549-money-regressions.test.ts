// Regression criteria from payroll549 second-opinion brief; no payout may exceed effective history.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, outletIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
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

const key = () => `payroll-549-${randomUUID()}`;
const codeOf = () =>
  `P549_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

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
let grossEntityId: string;
let formulaId: string;

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
        `Payroll 549 ${roleId.slice(0, 8)}`,
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
                              legal_entity_id, employment_type, join_date, status)
       VALUES ($1, $2, $3, 'Karyawan Mesin Gross', $4, $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenant.id,
        `GE-${id.slice(0, 8).toUpperCase()}`,
        outlet,
        grossEntityId,
      ],
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

type OvertimeInput = {
  formulaId?: string | null;
  date: string;
  minutes: number;
  dayType?: "workday" | "rest_day_6_day_week" | "rest_day_5_day_week";
  status?: "pending" | "approved" | "rejected" | "cancelled";
};

async function seedOvertimeRequest(employeeId: string, input: OvertimeInput) {
  await asTenant(tenant.id, (db) =>
    db.query(
      `INSERT INTO overtime_requests
         (tenant_id, outlet_id, employee_id, formula_id, date, minutes, day_type, reason,
          status, requested_by, decided_by, decided_at)
       VALUES ($1, $2, $3, $10, $4::date, $5, $6, 'Payroll 549 regression', $7::varchar, $8,
               CASE WHEN $7::varchar = 'approved' THEN $9 ELSE NULL END,
               CASE WHEN $7::varchar = 'approved' THEN now() ELSE NULL END)`,
      [
        tenant.id,
        outlet,
        employeeId,
        input.date,
        input.minutes,
        input.dayType ?? "workday",
        input.status ?? "approved",
        actorId,
        reviewerId,
        input.formulaId === undefined ? formulaId : input.formulaId,
      ],
    ),
  );
}

const compute = (employeeId: string, overrides: Record<string, unknown> = {}) =>
  service.computeEmployeeGross(ctx, actorId, {
    employeeId,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    payslipId: randomUUID(),
    overtimeParameters,
    ...overrides,
  } as never);

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  actorId = await createUser("Payroll 549 actor");
  reviewerId = await createUser("Payroll 549 reviewer");
  await grantRole(actorId, ["payroll.view", "payroll.run"]);
  grossEntityId = randomUUID();
  formulaId = randomUUID();
  await asTenant(tenant.id, async (db) => {
    await db.query(
      "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Payroll 549', false)",
      [grossEntityId, tenant.id],
    );
    await db.query(
      `INSERT INTO overtime_formulas
       (id, tenant_id, version, effective_from, status, parameters, rest_day_type,
        legal_basis, published_at, published_by, created_by)
       VALUES ($1, $2, $3, '2026-01-01', 'published', $4, 'rest_day_6_day_week',
               'Payroll 549 regression', now(), $5, $5)`,
      [
        formulaId,
        tenant.id,
        1_000_000 + Math.floor(Math.random() * 1_000_000_000),
        JSON.stringify(overtimeParameters),
        actorId,
      ],
    );
  });
});

afterAll(async () => {
  await asTenant(tenant.id, async (db) => {
    await db.query("SET LOCAL session_replication_role = replica");
    await db.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'payroll-549-%'",
      [tenant.id],
    );
    for (const table of [
      "overtime_requests",
      "attendance_logs",
      "employee_pay_components",
    ])
      await db.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND employee_id = ANY($2)`,
        [tenant.id, createdEmployees],
      );
    await db.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await db.query(
      "DELETE FROM pay_components WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdComponents],
    );
    await db.query(
      "DELETE FROM overtime_formulas WHERE tenant_id = $1 AND id = $2",
      [tenant.id, formulaId],
    );
    await db.query(
      "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = $2",
      [tenant.id, grossEntityId],
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
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

async function approvedHour(employeeId: string, date: string) {
  await seedLog(employeeId, { businessDate: date, overtimeMinutes: 60 });
  await seedOvertimeRequest(employeeId, { date, minutes: 60 });
}

describe("[549-P1] overtime basis follows its business date", () => {
  it("[549-P1-BEFORE] pays zero before the component effective date", async () => {
    const employeeId = await seedEmployee();
    const component = await earning({ overtimeBase: true });
    await setAmount(employeeId, component.id, 6_000_000, "2026-06-11");
    await approvedHour(employeeId, "2026-06-10");
    const result = await compute(employeeId);
    expect(result.overtimeMinutes).toBe(60);
    expect(result.overtimeIdr).toBe(0);
    expect(result.grossIdr).toBe(4_000_000);
    expect(result.netIdr).toBe(4_000_000);
  });

  it("[549-P1-STOP] pays zero on June20 after a six-million basis stops June11", async () => {
    const employeeId = await seedEmployee();
    const component = await earning({ overtimeBase: true });
    await setAmount(employeeId, component.id, 6_000_000);
    await setAmount(employeeId, component.id, 0, "2026-06-12");
    await approvedHour(employeeId, "2026-06-20");
    const result = await compute(employeeId);
    expect(result.overtimeMinutes).toBe(60);
    expect(result.overtimeIdr).toBe(0);
    expect(result.grossIdr).toBe(2_200_000);
    expect(result.netIdr).toBe(2_200_000);
  });

  it("[549-P1-GAP] pays zero in a gap even with positive history on both sides", async () => {
    const employeeId = await seedEmployee();
    const component = await earning({ overtimeBase: true });
    await setAmount(employeeId, component.id, 6_000_000, "2026-06-01");
    await asTenant(tenant.id, async (db) => {
      await db.query(
        `UPDATE employee_pay_components SET effective_to = '2026-06-11'
       WHERE tenant_id = $1 AND employee_id = $2 AND component_id = $3
         AND effective_from = '2026-06-01'`,
        [tenant.id, employeeId, component.id],
      );
    });
    await setAmount(employeeId, component.id, 6_000_000, "2026-06-21");
    await approvedHour(employeeId, "2026-06-20");
    const result = await compute(employeeId);
    expect(result.overtimeMinutes).toBe(60);
    expect(result.overtimeIdr).toBe(0);
    expect(result.grossIdr).toBe(4_200_000);
  });

  it("[549-P1-ACTIVE] pays each day from its actual amount and never more than that basis permits", async () => {
    const employeeId = await seedEmployee();
    const component = await earning({ overtimeBase: true });
    await setAmount(employeeId, component.id, 6_000_000);
    await setAmount(employeeId, component.id, 12_000_000, "2026-06-16");
    await approvedHour(employeeId, "2026-06-10");
    await approvedHour(employeeId, "2026-06-20");
    const result = await compute(employeeId);
    expect(result.overtimeIdr).toBe(52_023 + 104_046);
    expect(result.grossIdr).toBe(9_000_000 + 52_023 + 104_046);
  });
});

describe("[549-g5v69] gross respects the request formula pin", () => {
  it("[549-g5v69-PIN] a newer expensive caller formula cannot raise an old request's payout", async () => {
    const employeeId = await seedEmployee();
    const component = await earning({ overtimeBase: true });
    await setAmount(employeeId, component.id, 6_000_000);
    await approvedHour(employeeId, "2026-06-20");
    const expensiveParameters = {
      ...overtimeParameters,
      monthlyHoursDivisor: 1,
    };
    const baseline = await compute(employeeId);
    const recomputed = await compute(employeeId, {
      overtimeParameters: expensiveParameters,
    });
    expect(baseline.overtimeIdr).toBe(52_023);
    expect(recomputed.overtimeIdr).toBe(52_023);
    expect(recomputed.grossIdr).toBe(6_052_023);
    expect(recomputed.netIdr).toBe(baseline.netIdr);
  });

  it("[549-g5v69-MISSING] refuses unpinned approved requests instead of paying caller rates", async () => {
    const employeeId = await seedEmployee();
    const component = await earning({ overtimeBase: true });
    await setAmount(employeeId, component.id, 6_000_000);
    await seedLog(employeeId, {
      businessDate: "2026-06-20",
      overtimeMinutes: 60,
    });
    await seedOvertimeRequest(employeeId, {
      date: "2026-06-20",
      minutes: 60,
      formulaId: null,
    });
    await expect(compute(employeeId)).rejects.toMatchObject({
      status: 409,
      code: "OVERTIME_FORMULA_MISSING",
    });
  });
});
