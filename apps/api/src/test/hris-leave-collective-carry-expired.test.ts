// legend-gxg9j: when a collective leave day is deducted AGAIN (accepted clock-in
// later rejected) after the carry-over of the following year already ran, the
// carried days that the carry-over expiry job has ALREADY forfeited must not
// absorb the cut a second time. Money rule (the employee is never short-changed
// twice for the same day, and never gets days back): a forfeited carry is
// already gone, so the re-deduction only touches the carry that is still valid.
//
// Expected behaviour comes from the card text (legend-gxg9j), docs/PROGRESS.md
// ("bila carry-over tahun itu sudah jalan, carry tahun berikut dikurangi 1,
// minimal 0"; the expiry job lowers the carry of the year to used + pending and
// writes a `carry_over_expiry` ledger row), and the sibling tests
// hris-leave-collective-carry-cut.test.ts / hris-leave-carry-expiry-db.test.ts,
// not from the service code:
//  - Carry 5 of 2050, used 2, expiry date passed, job ran: carry is 2 and the
//    ledger has one `carry_over_expiry` row of -3. Rejecting the collective day
//    of 2049 deducts the day in 2049 but leaves the carry of 2050 at 2 (not 1)
//    and writes no further expiry row.
//  - Carry not yet expired: the carry is cut by exactly 1 (5 -> 4), once, even
//    if the reject or the collective run repeats.
//  - Partly forfeited (days still held by used + pending): the held days stay.
//  - A carry that is already 0 after expiry stays 0, never negative.
//
// Assumptions:
//  - Leave type ANNUAL, annual 12 days, cap 5 days, expiry date written straight
//    into leave_balances.carry_over_expires_on (like the expiry-db test).
//  - used(2049) = 7 before the cut, so remaining(2049) = 5 = the cap: the
//    collective day was part of the carried days (same seed as the "5 -> 4"
//    case of the carry-cut test).
//  - Every case has its own outlet and employee; the expiry job is tenant-wide
//    and idempotent, so it only touches balances whose expiry date has passed.
//  - Year 2049 is the collective day's year; `now` is injected everywhere.
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
import {
  expireLeaveCarryOver as expireLeaveCarryOverEndpoint,
  leaveTypeInputSchema,
  type Employee,
} from "@starter/shared/hris";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { decideAttendanceReview } from "../services/hris-attendance-admin.service.ts";
import {
  createEmployee,
  type CreateEmployeeInput,
} from "../services/hris-employee.service.ts";
import { applyCollectiveLeaveDeductions } from "../services/hris-leave-collective.service.ts";
import {
  createLeaveType,
  expireLeaveCarryOver,
} from "../services/hris-leave.service.ts";

const templateTenantId = cafeLegendPlatformFixtures.tenant.id;
const tenantId = tenantIdSchema.parse(randomUUID());
const brandId = randomUUID();
const legalEntityId = randomUUID();
const SYSTEM = { type: "system" } as const;
const YEAR = 2049;
const NOW = new Date("2049-06-15T05:00:00Z"); // 12:00 WIB, collective run + accept
const BEFORE_EXPIRY = new Date("2050-03-01T05:00:00Z"); // carry of 2050 still valid
const AFTER_EXPIRY = new Date("2050-04-02T05:00:00Z"); // after the expiry job
const EXPIRES_ON = "2050-03-31";
const FUTURE_EXPIRES_ON = "2050-12-31";
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
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Carry Expired', $2)`,
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
      `Carry expired ${roleId.slice(0, 8)}`,
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

const key = () => `cbexp-${randomUUID()}`;
const freshNo = () =>
  `CE-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

let hr: string;
let reviewer: string;
let annualTypeId: string;

async function newOutlet(): Promise<string> {
  const id = outletIdSchema.parse(randomUUID());
  createdOutlets.push(id);
  await sql(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet CBEXP', 'Jl. CBEXP', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      id,
      tenantId,
      brandId,
      legalEntityId,
      `CBEXP-${id.replaceAll("-", "").slice(0, 10)}`.toUpperCase(),
    ],
  );
  return id;
}

async function employeeAt(outletId: string): Promise<Employee> {
  return createEmployee(tenantScope(), hr, {
    userId: null,
    legalEntityId: null,
    employeeNo: freshNo(),
    fullName: "Karyawan Carry Expired",
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
    [id, tenantId, outletId, employeeId, DAY, `cbexp-log-${id}`],
  );
  return id;
}

const decide = (logId: string, action: "accept" | "reject", now: Date) =>
  decideAttendanceReview(
    tenantScope(),
    reviewer,
    uuidToUlid(logId),
    { action, idempotencyKey: key() } as never,
    undefined,
    now,
  );

const run = () => applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);

const runExpiry = (asOf: string, now: Date) =>
  expireLeaveCarryOver(
    tenantScope(),
    expirer,
    expireLeaveCarryOverEndpoint.body.parse({ asOf }),
    now,
  );

let expirer: string;

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

async function expiryLedger(employeeId: string): Promise<number[]> {
  const rows = await sql<{ days: string }>(
    `SELECT days::text AS days FROM leave_accruals
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
        AND kind = 'carry_over_expiry'
      ORDER BY days`,
    [tenantId, employeeId, annualTypeId],
  );
  return rows.map((r) => Number(r.days));
}

/** Carry-over of `year` already ran for the employee: ledger row + balance row. */
async function seedCarry(
  employeeId: string,
  year: number,
  carried: number,
  used: number,
  pending: number,
  expiresOn: string,
) {
  await sql(
    `INSERT INTO leave_accruals (tenant_id, employee_id, leave_type_id, kind, period, days)
     VALUES ($1, $2, $3, 'carry_over', $4, $5)`,
    [tenantId, employeeId, annualTypeId, String(year), String(carried)],
  );
  await sql(
    `INSERT INTO leave_balances
       (tenant_id, employee_id, leave_type_id, period_year, entitled_days,
        carried_over_days, used_days, pending_days, carry_over_expires_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      tenantId,
      employeeId,
      annualTypeId,
      year,
      String(ENTITLED),
      String(carried),
      String(used),
      String(pending),
      expiresOn,
    ],
  );
}

/**
 * The collective day of 2049 is deducted, given back by an accepted clock-in,
 * year 2049 gets 7 days of other leave (remaining 5 = cap) and the carry-over
 * of 2050 ran with `carried` days (used / pending as given). When `expired`,
 * the expiry date has passed and the expiry job ran before the reject.
 * Returns a `reject` the test fires itself (possibly several times).
 */
async function scenario(input: {
  carried: number;
  used: number;
  pending?: number;
  expired: boolean;
  /** Default true. false: the expiry date passed but the job did not run yet. */
  runJob?: boolean;
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
    [tenantId, outletId, DAY, `CBEXP collective ${outletId}`],
  );
  await run();
  expect(await usedOf(e.id, YEAR)).toBe(1);
  await decide(logId, "accept", NOW);
  expect(await usedOf(e.id, YEAR)).toBe(0);

  await sql(
    `UPDATE leave_balances SET used_days = '7'
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = $4`,
    [tenantId, e.id, annualTypeId, YEAR],
  );
  await seedCarry(
    e.id,
    YEAR + 1,
    input.carried,
    input.used,
    input.pending ?? 0,
    input.expired ? EXPIRES_ON : FUTURE_EXPIRES_ON,
  );
  if (input.expired && input.runJob !== false)
    await runExpiry("2050-04-01", AFTER_EXPIRY);

  const reject = () =>
    decide(logId, "reject", input.expired ? AFTER_EXPIRY : BEFORE_EXPIRY);
  return { e, reject };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Carry expired tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantId, `cbexp-${tenantId.slice(0, 8)}`, templateTenantId],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'cbexp', 'CBEXP')",
    [brandId, tenantId],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Entity CBEXP', false)",
    [legalEntityId, tenantId],
  );
  hr = await customUser(["hr.employee.manage", "hr.employee.view"]);
  expirer = await customUser([
    "hr.employee.manage",
    "hr.employee.view",
    "hr.leave.approve",
  ]);
  reviewer = await customUser([
    "hr.attendance.manage",
    "hr.employee.view",
    "hr.employee.manage",
  ]);
  const type = await createLeaveType(tenantScope(), hr, {
    ...leaveTypeInputSchema.parse({
      code: "ANNUAL",
      name: "Cuti carry expired test",
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'cbexp-%'",
      [tenantId],
    );
    await client.query(
      "DELETE FROM holidays WHERE tenant_id = $1 AND name LIKE 'CBEXP %'",
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

describe("legend-gxg9j: forfeited carry does not absorb the re-deduction", () => {
  it("carry 5, used 2, expiry job cut it to 2 (ledger -3): reject keeps carry at 2, not 1", async () => {
    const { e, reject } = await scenario({
      carried: 5,
      used: 2,
      expired: true,
    });
    expect(await carryOf(e.id, YEAR + 1)).toBe(2);
    expect(await expiryLedger(e.id)).toEqual([-3]);

    await reject();

    expect(await usedOf(e.id, YEAR)).toBe(8); // the day is deducted again
    expect(await carryOf(e.id, YEAR + 1)).toBe(2);
    expect(await expiryLedger(e.id)).toEqual([-3]); // no extra expiry row
  });

  it("repeated reject and collective run after expiry: carry stays 2, the day is deducted once", async () => {
    const { e, reject } = await scenario({
      carried: 5,
      used: 2,
      expired: true,
    });
    await reject();
    await run();
    await reject().catch(() => undefined);
    await run();
    expect(await usedOf(e.id, YEAR)).toBe(8);
    expect(await carryOf(e.id, YEAR + 1)).toBe(2);
    expect(await expiryLedger(e.id)).toEqual([-3]);
  });

  it("partly forfeited (carry 5, used 1, pending 2 held): carry stays 3 after the reject", async () => {
    const { e, reject } = await scenario({
      carried: 5,
      used: 1,
      pending: 2,
      expired: true,
    });
    expect(await carryOf(e.id, YEAR + 1)).toBe(3);
    expect(await expiryLedger(e.id)).toEqual([-2]);

    await reject();

    expect(await usedOf(e.id, YEAR)).toBe(8);
    expect(await carryOf(e.id, YEAR + 1)).toBe(3);
    expect(await expiryLedger(e.id)).toEqual([-2]);
  });

  it("everything forfeited (carry 5, used 0): carry stays 0, never negative", async () => {
    const { e, reject } = await scenario({
      carried: 5,
      used: 0,
      expired: true,
    });
    expect(await carryOf(e.id, YEAR + 1)).toBe(0);
    expect(await expiryLedger(e.id)).toEqual([-5]);

    await reject();
    await reject().catch(() => undefined);

    expect(await carryOf(e.id, YEAR + 1)).toBe(0);
    expect(await expiryLedger(e.id)).toEqual([-5]);
  });
});

// Brief 3 / T1: a carry past its expiry date is cut by max(0, 1 - F), where F is
// the |days| of the `carry_over_expiry` ledger row of that year (0 when the job
// has not run, or ran but forfeited nothing because used + pending held it all).
// Carry 5 with used 5 loses nothing to the job, so the cut must still reach it.
describe("legend-gxg9j: nothing forfeited, so the cut still applies after the expiry date", () => {
  it("carry 5, used 5, expiry date passed, job NOT run (F=0): reject cuts carry 5 -> 4", async () => {
    const { e, reject } = await scenario({
      carried: 5,
      used: 5,
      expired: true,
      runJob: false,
    });
    expect(await carryOf(e.id, YEAR + 1)).toBe(5);
    expect(await expiryLedger(e.id)).toEqual([]);

    await reject();

    expect(await usedOf(e.id, YEAR)).toBe(8);
    expect(await carryOf(e.id, YEAR + 1)).toBe(4);
    expect(await expiryLedger(e.id)).toEqual([]);
  });

  it("carry 5, used 5, expiry date passed, job ran with F=0 (no ledger row): reject cuts carry 5 -> 4", async () => {
    const { e, reject } = await scenario({
      carried: 5,
      used: 5,
      expired: true,
    });
    // Job ran but used 5 holds the whole carry: nothing forfeited (the job
    // only claims a ledger row with 0 days).
    expect(await carryOf(e.id, YEAR + 1)).toBe(5);
    expect(await expiryLedger(e.id)).toEqual([0]);

    await reject();

    expect(await usedOf(e.id, YEAR)).toBe(8);
    expect(await carryOf(e.id, YEAR + 1)).toBe(4);
    expect(await expiryLedger(e.id)).toEqual([0]);
  });

  it("job not run, repeated reject and collective run: cut once only (5 -> 4)", async () => {
    const { e, reject } = await scenario({
      carried: 5,
      used: 5,
      expired: true,
      runJob: false,
    });
    await reject();
    await run();
    await reject().catch(() => undefined);
    await run();
    expect(await usedOf(e.id, YEAR)).toBe(8);
    expect(await carryOf(e.id, YEAR + 1)).toBe(4);
  });
});

describe("legend-gxg9j: carry still valid is cut exactly once", () => {
  it("carry 5, used 2, expiry date not reached: reject cuts 5 -> 4", async () => {
    const { e, reject } = await scenario({
      carried: 5,
      used: 2,
      expired: false,
    });
    await reject();
    expect(await usedOf(e.id, YEAR)).toBe(8);
    expect(await carryOf(e.id, YEAR + 1)).toBe(4);
    expect(await expiryLedger(e.id)).toEqual([]);
  });

  it("repeated reject and collective run never cut twice", async () => {
    const { e, reject } = await scenario({
      carried: 5,
      used: 2,
      expired: false,
    });
    await reject();
    await run();
    await reject().catch(() => undefined);
    await run();
    expect(await usedOf(e.id, YEAR)).toBe(8);
    expect(await carryOf(e.id, YEAR + 1)).toBe(4);
  });

  it("carry 5, used 2, job runs after the cut: only the cut carry is forfeited (4 -> 2, ledger -2)", async () => {
    const { e, reject } = await scenario({
      carried: 5,
      used: 2,
      expired: false,
    });
    await reject();
    expect(await carryOf(e.id, YEAR + 1)).toBe(4);
    await runExpiry("2051-01-01", new Date("2051-01-01T05:00:00Z"));
    expect(await carryOf(e.id, YEAR + 1)).toBe(2);
    expect(await expiryLedger(e.id)).toEqual([-2]);
  });
});
