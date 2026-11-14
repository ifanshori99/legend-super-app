// legend-852 / T12 (second opinion 15 Nov, findings 1 and 2). Money rules: the
// employee never gets more leave days than he is entitled to, and a bill for
// days already paid out at settlement never disappears.
//
// Expected behaviour comes from the finding text (docs/qa/second-opinion-hris-payroll-15nov.md),
// docs/PROGRESS.md and the sibling tests hris-leave-collective-carry-expired.test.ts /
// hris-leave-collective-after-settlement.test.ts, not from the service code.
//
// Finding 1: carry 5 of 2050, used 4, expiry job forfeited 1 (ledger -1, carry 4).
//   Two collective days of 2049 get rejected. Each cut is absorbed by the
//   forfeited carry ONLY while forfeited days remain: the forfeited 1 is
//   consumed cumulatively (first reject absorbed, second reject cuts), so after
//   both rejects the carry is 3 (not 4, which gives the employee 1 day too many).
//   Check: year 2049 remaining is 12 - 9 = 3, so carry must be <= 3.
//
// Finding 2: after a completed offboarding the bill (audit `days` + outbox
//   event) is computed from the FROZEN settlement basis: days paid at settlement
//   (raw carry, before any expiry) minus the entitlement the employee has with
//   the day deducted, both on the raw carry. A carry that was forfeited by the
//   expiry job after the settlement must not make the bill 0.
//   Case: exit year 2050, entitled 12, carry 5 raw, used 0, settlement snapshot
//   leaveBalanceDays 17 (12 + 5). Expiry job then forfeits the 5; the 2049
//   collective day is rejected after the expiry date. The employee was paid 17
//   days but is entitled to 12 + 4 = 16 with the day deducted: bill 1 day.
//
// Assumptions:
//  - Seeds copy hris-leave-collective-carry-expired.test.ts: ANNUAL, 12 days,
//    cap 5, 2049 used 7 before the cut (remaining 5 = cap, so every collective
//    day was part of the carried days), `now` injected everywhere.
//  - The snapshot has the REAL shape (finalSettlementSummarySchema, built in
//    snapshotLeave/seedCompletedOffboarding): leave[] per leaveTypeId for the exit
//    year (2050), decimal strings. Bill rule: carry before = min(snapshot carry,
//    raw carry before), after = min(snapshot carry, raw carry after).
//  - The offboarding is seeded after the expiry job (settlement completed, but
//    its snapshot was frozen with the raw carry); the employee row stays active.
//  - "days" in the audit line is compared with Number() (number or decimal string).
//  - Cases marked "control" pass on the current code; they guard against regression.
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
  finalSettlementSummarySchema,
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
const NOW = new Date("2049-06-15T05:00:00Z"); // collective run + accept
const BEFORE_EXPIRY = new Date("2050-03-01T05:00:00Z");
const AFTER_EXPIRY = new Date("2050-04-02T05:00:00Z");
const EXPIRES_ON = "2050-03-31";
const FUTURE_EXPIRES_ON = "2050-12-31";
const EXIT_DATE = "2050-05-31"; // exit year 2050 = the carry year
const EXIT_YEAR = 2050;
const ENTITLED = 12;
const CAP = 5;
const DAYS = ["2049-05-12", "2049-05-13", "2049-05-14"];
const ACTION = "hris.leave_collective.rededucted_after_settlement";
const EVENT = "leave.rededucted_after_settlement";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdTypes: string[] = [];

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
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Carry Cumulative', $2)`,
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
      `Carry cumulative ${roleId.slice(0, 8)}`,
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

const key = () => `cbcum-${randomUUID()}`;
const freshNo = () =>
  `CU-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

let hr: string;
let reviewer: string;
let expirer: string;
let annualTypeId: string;

async function newOutlet(): Promise<string> {
  const id = outletIdSchema.parse(randomUUID());
  await sql(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet CBCUM', 'Jl. CBCUM', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      id,
      tenantId,
      brandId,
      legalEntityId,
      `CBCUM-${id.replaceAll("-", "").slice(0, 10)}`.toUpperCase(),
    ],
  );
  return id;
}

async function employeeAt(outletId: string): Promise<Employee> {
  return createEmployee(tenantScope(), hr, {
    userId: null,
    legalEntityId: null,
    employeeNo: freshNo(),
    fullName: "Karyawan Carry Cumulative",
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
  day: string,
): Promise<string> {
  const id = randomUUID();
  await sql(
    `INSERT INTO attendance_logs
       (id, tenant_id, outlet_id, employee_id, type, method, occurred_at,
        validity, flag_reasons, business_date, client_event_id,
        review_status, reviewed_by, reviewed_at)
     VALUES ($1, $2, $3, $4, 'in', 'rotating_qr', ($5::date + time '08:00') AT TIME ZONE 'Asia/Jakarta',
             'flagged', '[]'::jsonb, $5::date, $6, 'pending', NULL, NULL)`,
    [id, tenantId, outletId, employeeId, day, `cbcum-log-${id}`],
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

async function balanceCol(
  column: "carried_over_days" | "used_days",
  employeeId: string,
  year: number,
): Promise<number> {
  const rows = await sql<{ v: string }>(
    `SELECT ${column}::text AS v FROM leave_balances
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
        AND period_year = $4`,
    [tenantId, employeeId, annualTypeId, year],
  );
  return Number(rows[0]?.v ?? "0");
}
const carryOf = (employeeId: string, year: number) =>
  balanceCol("carried_over_days", employeeId, year);
const usedOf = (employeeId: string, year: number) =>
  balanceCol("used_days", employeeId, year);

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

async function seedCarry(
  employeeId: string,
  carried: number,
  used: number,
  expiresOn: string,
) {
  await sql(
    `INSERT INTO leave_accruals (tenant_id, employee_id, leave_type_id, kind, period, days)
     VALUES ($1, $2, $3, 'carry_over', $4, $5)`,
    [tenantId, employeeId, annualTypeId, String(YEAR + 1), String(carried)],
  );
  await sql(
    `INSERT INTO leave_balances
       (tenant_id, employee_id, leave_type_id, period_year, entitled_days,
        carried_over_days, used_days, pending_days, carry_over_expires_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '0', $8)`,
    [
      tenantId,
      employeeId,
      annualTypeId,
      YEAR + 1,
      String(ENTITLED),
      String(carried),
      String(used),
      expiresOn,
    ],
  );
}

const dec4 = (n: number) => n.toFixed(4);

/** One `leave[]` row of the frozen settlement summary (exit year = 2050). */
function snapshotLeave(input: {
  carry: number;
  used: number;
  pending?: number;
  typeId?: string;
}) {
  const pending = input.pending ?? 0;
  const remaining = Math.max(0, ENTITLED + input.carry - input.used - pending);
  return {
    leaveTypeId: input.typeId ?? annualTypeId,
    name: "Cuti carry cumulative test",
    periodYear: EXIT_YEAR,
    entitledDays: dec4(ENTITLED),
    carriedOverDays: dec4(input.carry),
    usedDays: dec4(input.used),
    pendingDays: dec4(pending),
    remainingDays: dec4(remaining),
  };
}

/**
 * Completed offboarding with the REAL frozen snapshot shape: the whole
 * `finalSettlementSummary` (parsed by the shared schema so the shape cannot
 * drift), with `leave[]` per leaveTypeId for the exit year.
 */
async function seedCompletedOffboarding(
  employeeId: string,
  leave: ReturnType<typeof snapshotLeave>[],
): Promise<{ id: string; snapshotText: string }> {
  const id = randomUUID();
  const snapshot = finalSettlementSummarySchema.parse({
    offboardingId: id,
    employeeId,
    exitType: "resignation",
    joinDate: "2040-01-02",
    lastWorkingDate: EXIT_DATE,
    runningSalary: {
      lastPayrollRun: null,
      unpaidFrom: null,
      unpaidTo: EXIT_DATE,
      unpaidCalendarDays: 0,
    },
    outstandingLoans: { count: 0, amountIdr: 0, loanIds: [] },
    unpaidReimbursements: { count: 0, amountIdr: 0, pendingCount: 0 },
    leave,
    pendingPayrollEngine: [],
    computedAt: "2050-05-31T05:00:00.000Z",
    frozen: true,
  });
  await sql(
    `INSERT INTO hris_offboardings
       (id, tenant_id, employee_id, exit_type, reason, last_working_date, status,
        access_revoked_at, access_revoked_by, revocation_result,
        settlement_snapshot, completed_at, completed_by, created_by)
     VALUES ($1, $2, $3, 'resignation', 'Selesai', $4, 'completed',
             now(), $5, '{}'::jsonb, $6::jsonb, now(), $5, $5)`,
    [id, tenantId, employeeId, EXIT_DATE, hr, JSON.stringify(snapshot)],
  );
  return { id, snapshotText: await snapshotTextOf(id) };
}

async function snapshotTextOf(offboardingId: string): Promise<string> {
  const rows = await sql<{ s: string }>(
    `SELECT settlement_snapshot::text AS s FROM hris_offboardings
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, offboardingId],
  );
  return rows[0]!.s;
}

const idForms = (offboardingId: string) => [
  offboardingId,
  uuidToUlid(offboardingId),
];

async function auditsFor(offboardingId: string) {
  return sql<{ after: Record<string, unknown> }>(
    `SELECT event->'maskedChanges'->'after' AS after
       FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2
        AND event->'maskedChanges'->'after'->>'offboardingId' = ANY($3::text[])`,
    [tenantId, ACTION, idForms(offboardingId)],
  );
}

async function outboxFor(offboardingId: string) {
  return sql<{ destination: string; event: Record<string, unknown> }>(
    `SELECT destination, event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2
        AND (event::text LIKE '%' || $3 || '%' OR event::text LIKE '%' || $4 || '%')`,
    [tenantId, EVENT, ...idForms(offboardingId)],
  );
}

/**
 * Collective days of 2049 deducted and given back by accepted clock-ins, year
 * 2049 gets 7 days of other leave (remaining 5 = cap), the carry-over of 2050
 * ran (`carried`, `used`), and when `expired` the expiry job ran after the date.
 * Returns `reject(i)`, which rejects the i-th day at the matching review time.
 */
async function scenario(input: {
  days: number;
  carried: number;
  used: number;
  expired: boolean;
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
  const days = DAYS.slice(0, input.days);
  const logs: string[] = [];
  for (const day of days) {
    logs.push(await writeFlaggedLog(e.id, outletId, day));
    await sql(
      `INSERT INTO holidays (tenant_id, outlet_id, date, name, type)
       VALUES ($1, $2, $3, $4, 'collective')`,
      [tenantId, outletId, day, `CBCUM collective ${outletId} ${day}`],
    );
  }
  await run();
  expect(await usedOf(e.id, YEAR)).toBe(days.length);
  for (const logId of logs) await decide(logId, "accept", NOW);
  expect(await usedOf(e.id, YEAR)).toBe(0);

  await sql(
    `UPDATE leave_balances SET used_days = '7'
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = $4`,
    [tenantId, e.id, annualTypeId, YEAR],
  );
  await seedCarry(
    e.id,
    input.carried,
    input.used,
    input.expired ? EXPIRES_ON : FUTURE_EXPIRES_ON,
  );
  if (input.expired) await runExpiry("2050-04-01", AFTER_EXPIRY);

  const reviewAt = input.expired ? AFTER_EXPIRY : BEFORE_EXPIRY;
  const reject = (i: number) => decide(logs[i]!, "reject", reviewAt);
  return { e, days, reject };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Carry cumulative tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantId, `cbcum-${tenantId.slice(0, 8)}`, templateTenantId],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'cbcum', 'CBCUM')",
    [brandId, tenantId],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Entity CBCUM', false)",
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
      name: "Cuti carry cumulative test",
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
      `DELETE FROM hris_offboardings WHERE tenant_id = $1 AND employee_id IN ${mine}`,
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'cbcum-%'",
      [tenantId],
    );
    await client.query(
      "DELETE FROM holidays WHERE tenant_id = $1 AND name LIKE 'CBCUM %'",
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
  // Best effort, like the other private-tenant tests (audit_logs is append-only).
  for (const statement of [
    "DELETE FROM domain_event_outbox WHERE tenant_id = $1",
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

describe("legend-852 finding 1: forfeited carry is consumed cumulatively", () => {
  it("carry 5, used 4, forfeited 1: first reject is absorbed, second reject cuts, carry ends at 3 (not 4)", async () => {
    const { e, reject } = await scenario({
      days: 2,
      carried: 5,
      used: 4,
      expired: true,
    });
    expect(await carryOf(e.id, YEAR + 1)).toBe(4);
    expect(await expiryLedger(e.id)).toEqual([-1]);

    await reject(0);
    expect(await usedOf(e.id, YEAR)).toBe(8);
    expect(await carryOf(e.id, YEAR + 1)).toBe(4); // the forfeited day absorbs this cut

    await reject(1);
    expect(await usedOf(e.id, YEAR)).toBe(9);
    // 2049 remaining is 12 - 9 = 3: carry may not be higher than that.
    expect(await carryOf(e.id, YEAR + 1)).toBe(3);
    expect(await expiryLedger(e.id)).toEqual([-1]); // no extra expiry row
  });

  it("repeating the rejects and the collective run does not change the result (carry stays 3)", async () => {
    const { e, reject } = await scenario({
      days: 2,
      carried: 5,
      used: 4,
      expired: true,
    });
    await reject(0);
    await reject(1);
    await reject(0).catch(() => undefined);
    await reject(1).catch(() => undefined);
    await run();
    expect(await usedOf(e.id, YEAR)).toBe(9);
    expect(await carryOf(e.id, YEAR + 1)).toBe(3);
  });

  it("carry 5, used 3, forfeited 2, three rejects: two absorbed, third cuts, carry ends at 2", async () => {
    const { e, reject } = await scenario({
      days: 3,
      carried: 5,
      used: 3,
      expired: true,
    });
    expect(await carryOf(e.id, YEAR + 1)).toBe(3);
    expect(await expiryLedger(e.id)).toEqual([-2]);

    await reject(0);
    expect(await carryOf(e.id, YEAR + 1)).toBe(3);
    await reject(1);
    expect(await carryOf(e.id, YEAR + 1)).toBe(3);
    await reject(2);

    expect(await usedOf(e.id, YEAR)).toBe(10);
    expect(await carryOf(e.id, YEAR + 1)).toBe(2); // 12 - 10 = 2
    expect(await expiryLedger(e.id)).toEqual([-2]);
  });

  it("control: everything forfeited (carry 5, used 0): two rejects keep carry at 0, never negative", async () => {
    const { e, reject } = await scenario({
      days: 2,
      carried: 5,
      used: 0,
      expired: true,
    });
    await reject(0);
    await reject(1);
    expect(await carryOf(e.id, YEAR + 1)).toBe(0);
    expect(await expiryLedger(e.id)).toEqual([-5]);
  });

  it("control: carry not expired, two rejects cut it once each (5 -> 4 -> 3)", async () => {
    const { e, reject } = await scenario({
      days: 2,
      carried: 5,
      used: 4,
      expired: false,
    });
    await reject(0);
    expect(await carryOf(e.id, YEAR + 1)).toBe(4);
    await reject(1);
    expect(await carryOf(e.id, YEAR + 1)).toBe(3);
  });
});

// Correct bill rule (architect review): carry before = min(snapshot carry, raw
// carry before), carry after = min(snapshot carry, raw carry after); the bill is
// the difference. Assumption: a bill of 0 writes no audit line and no outbox
// event (nothing to tell anyone); the audit check below is tolerant of a 0 line.
async function expectNoBill(offboardingId: string) {
  const audits = await auditsFor(offboardingId);
  for (const a of audits) expect(Number(a.after.days)).toBe(0);
  expect(await outboxFor(offboardingId)).toHaveLength(0);
}

describe("legend-852 finding 2: the bill after settlement comes from the frozen snapshot basis", () => {
  it("carry 5 fully forfeited after the settlement (snapshot 17 days): the extra day is billed, days 1 and one outbox row", async () => {
    const { e, reject } = await scenario({
      days: 1,
      carried: 5,
      used: 0,
      expired: true,
    });
    expect(await carryOf(e.id, YEAR + 1)).toBe(0); // forfeited, now invisible
    // Settlement frozen BEFORE the expiry date: carry 5 raw, remaining 17.
    const offboarding = await seedCompletedOffboarding(e.id, [
      snapshotLeave({ carry: 5, used: 0 }),
    ]);

    await reject(0);

    expect(await usedOf(e.id, YEAR)).toBe(8);
    expect(await snapshotTextOf(offboarding.id)).toBe(offboarding.snapshotText);
    const audits = await auditsFor(offboarding.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after.date).toBe(DAYS[0]);
    expect(Number(audits[0]!.after.days)).toBe(1);
    const outbox = await outboxFor(offboarding.id);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.destination).toBe("notification");
  });

  it("carry 5, used 4, forfeited 1 (snapshot 13 days): the extra day is still billed (days 1), never more", async () => {
    const { e, reject } = await scenario({
      days: 1,
      carried: 5,
      used: 4,
      expired: true,
    });
    expect(await carryOf(e.id, YEAR + 1)).toBe(4);
    // Frozen before the expiry date: carry 5 raw, used 4, remaining 13.
    const offboarding = await seedCompletedOffboarding(e.id, [
      snapshotLeave({ carry: 5, used: 4 }),
    ]);

    await reject(0);

    const audits = await auditsFor(offboarding.id);
    expect(audits).toHaveLength(1);
    expect(Number(audits[0]!.after.days)).toBe(1);
    expect(await outboxFor(offboarding.id)).toHaveLength(1);
  });

  it("control: carry not yet expired (snapshot 17 days): days 1 and one outbox row", async () => {
    const { e, reject } = await scenario({
      days: 1,
      carried: 5,
      used: 0,
      expired: false,
    });
    const offboarding = await seedCompletedOffboarding(e.id, [
      snapshotLeave({ carry: 5, used: 0 }),
    ]);

    await reject(0);

    const audits = await auditsFor(offboarding.id);
    expect(audits).toHaveLength(1);
    expect(Number(audits[0]!.after.days)).toBe(1);
    expect(await outboxFor(offboarding.id)).toHaveLength(1);
  });

  it("(a) exit AFTER the expiry date: carry 5, used 4, forfeited 1, snapshot carry 4: one reject bills 0", async () => {
    const { e, reject } = await scenario({
      days: 1,
      carried: 5,
      used: 4,
      expired: true,
    });
    expect(await expiryLedger(e.id)).toEqual([-1]);
    // The snapshot already saw the forfeiture: carry 4, remaining 12.
    const offboarding = await seedCompletedOffboarding(e.id, [
      snapshotLeave({ carry: 4, used: 4 }),
    ]);

    await reject(0);

    expect(await usedOf(e.id, YEAR)).toBe(8);
    await expectNoBill(offboarding.id);
  });

  it("(b) snapshot remaining 0, carry forfeited after: the forfeiture does not raise the balance into a bill (0)", async () => {
    const { e, reject } = await scenario({
      days: 1,
      carried: 5,
      used: 0,
      expired: true,
    });
    expect(await expiryLedger(e.id)).toEqual([-5]);
    // Employee had nothing left at settlement: carry 0, used 12, remaining 0.
    const offboarding = await seedCompletedOffboarding(e.id, [
      snapshotLeave({ carry: 0, used: 12 }),
    ]);

    await reject(0);

    await expectNoBill(offboarding.id);
  });

  it("(c) carry lowered without a ledger row (not via the expiry job): the bill of 1 day is not lost", async () => {
    const { e, reject } = await scenario({
      days: 1,
      carried: 5,
      used: 4,
      expired: false,
    });
    // Carry 5 -> 4 with NO carry_over_expiry row (as the reverse/move paths do).
    await sql(
      `UPDATE leave_balances SET carried_over_days = '4'
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = $4`,
      [tenantId, e.id, annualTypeId, YEAR + 1],
    );
    expect(await expiryLedger(e.id)).toEqual([]);
    const offboarding = await seedCompletedOffboarding(e.id, [
      snapshotLeave({ carry: 5, used: 4 }),
    ]);

    await reject(0);

    // raw carry 4 -> 3 on a snapshot carry of 5: min(5,4) - min(5,3) = 1.
    const audits = await auditsFor(offboarding.id);
    expect(audits).toHaveLength(1);
    expect(Number(audits[0]!.after.days)).toBe(1);
    expect(await outboxFor(offboarding.id)).toHaveLength(1);
  });

  it("(d) no snapshot row for this leave type: nothing was paid out, bill 0", async () => {
    const { e, reject } = await scenario({
      days: 1,
      carried: 5,
      used: 0,
      expired: false,
    });
    // Decoy: a row of ANOTHER leave type with a big carry must not be used.
    const offboarding = await seedCompletedOffboarding(e.id, [
      snapshotLeave({ carry: 5, used: 0, typeId: randomUUID() }),
    ]);

    await reject(0);

    await expectNoBill(offboarding.id);
  });
});

// legend-852 / T12, architect round 2: the bill must be capped by what was PAID
// at settlement, not by the live balance. Rule (architect): paid = snapshot
// remainingDays; bill = min(remBefore, paid) - min(remAfter, paid), where
// remBefore / remAfter are the live exit-year remaining days (entitled + usable
// carry - used - pending, floored at 0) around the re-deduction. A balance that
// rose AFTER settlement (given-back day, rejected pending leave) is days the
// employee was never paid for, so cutting it again must not bill.
//
// Assumptions:
//  - Assumption: a bill of 0 writes no outbox event; a 0 audit line is tolerated
//    (expectNoBill above). Controls (bill 1) pass on the current code.
//  - (a), (b) and the control use a collective day INSIDE the exit year 2050 (the
//    cut hits the exit-year used_days directly). In (a) the day is accepted after
//    the settlement (give-back), then rejected. In (b) the pending leave request
//    being rejected is simulated by setting pending_days to 0 (the bill only
//    reads the balance).
describe("legend-852: the bill is capped by the days paid at settlement (snapshot remainingDays)", () => {
  const EXIT_DAY = "2050-04-14";
  const EXIT_NOW = new Date("2050-04-20T05:00:00Z");

  async function exitYearScenario(input: { used: number; pending: number }) {
    const outletId = await newOutlet();
    const e = await employeeAt(outletId);
    await sql(
      `INSERT INTO leave_balances
         (tenant_id, employee_id, leave_type_id, period_year, entitled_days, used_days)
       VALUES ($1, $2, $3, $4, $5, '0')
       ON CONFLICT (tenant_id, employee_id, leave_type_id, period_year)
       DO UPDATE SET used_days = '0', entitled_days = EXCLUDED.entitled_days`,
      [tenantId, e.id, annualTypeId, EXIT_YEAR, String(ENTITLED)],
    );
    const logId = await writeFlaggedLog(e.id, outletId, EXIT_DAY);
    await sql(
      `INSERT INTO holidays (tenant_id, outlet_id, date, name, type)
       VALUES ($1, $2, $3, $4, 'collective')`,
      [
        tenantId,
        outletId,
        EXIT_DAY,
        `CBCUM collective ${outletId} ${EXIT_DAY}`,
      ],
    );
    await applyCollectiveLeaveDeductions(workerContext(), EXIT_NOW, SYSTEM);
    expect(await usedOf(e.id, EXIT_YEAR)).toBe(1);
    await decide(logId, "accept", EXIT_NOW);
    expect(await usedOf(e.id, EXIT_YEAR)).toBe(0);
    await sql(
      `UPDATE leave_balances SET used_days = $5, pending_days = $6
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = $4`,
      [
        tenantId,
        e.id,
        annualTypeId,
        EXIT_YEAR,
        String(input.used),
        String(input.pending),
      ],
    );
    const offboarding = await seedCompletedOffboarding(e.id, [
      snapshotLeave({ carry: 0, used: input.used, pending: input.pending }),
    ]);
    return { e, offboarding, reject: () => decide(logId, "reject", EXIT_NOW) };
  }

  // (a) The day is accepted AFTER the settlement: the cut is given back, the
  // exit-year remaining rises from 5 (paid) to 6, and the later reject cuts it
  // back to 5. The employee never got the 6th day paid, so the bill is 0.
  it("(a) day accepted AFTER settlement (given back), then rejected: paid 5, remaining 6 -> 5, bill 0", async () => {
    const outletId = await newOutlet();
    const e = await employeeAt(outletId);
    await sql(
      `INSERT INTO leave_balances
         (tenant_id, employee_id, leave_type_id, period_year, entitled_days, used_days)
       VALUES ($1, $2, $3, $4, $5, '0')
       ON CONFLICT (tenant_id, employee_id, leave_type_id, period_year)
       DO UPDATE SET used_days = '0', entitled_days = EXCLUDED.entitled_days`,
      [tenantId, e.id, annualTypeId, EXIT_YEAR, String(ENTITLED)],
    );
    const logId = await writeFlaggedLog(e.id, outletId, EXIT_DAY);
    await sql(
      `INSERT INTO holidays (tenant_id, outlet_id, date, name, type)
       VALUES ($1, $2, $3, $4, 'collective')`,
      [
        tenantId,
        outletId,
        EXIT_DAY,
        `CBCUM collective ${outletId} ${EXIT_DAY}`,
      ],
    );
    await applyCollectiveLeaveDeductions(workerContext(), EXIT_NOW, SYSTEM);
    // 6 other days + the collective day = 7 used, remaining 5 = days paid.
    await sql(
      `UPDATE leave_balances SET used_days = '7'
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = $4`,
      [tenantId, e.id, annualTypeId, EXIT_YEAR],
    );
    const offboarding = await seedCompletedOffboarding(e.id, [
      snapshotLeave({ carry: 0, used: 7 }),
    ]);

    await decide(logId, "accept", EXIT_NOW);
    expect(await usedOf(e.id, EXIT_YEAR)).toBe(6);

    await decide(logId, "reject", EXIT_NOW);

    expect(await usedOf(e.id, EXIT_YEAR)).toBe(7);
    // min(6, 5) - min(5, 5) = 0: the given-back day was never paid out.
    await expectNoBill(offboarding.id);
  });

  it("(b) entitled 12, used 10, pending 2, snapshot remaining 0: pending rejected, then the day rejected: bill 0", async () => {
    const { e, offboarding, reject } = await exitYearScenario({
      used: 10,
      pending: 2,
    });
    // The pending leave request gets rejected: the balance rises to 2 days.
    await sql(
      `UPDATE leave_balances SET pending_days = '0'
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = $4`,
      [tenantId, e.id, annualTypeId, EXIT_YEAR],
    );

    await reject();

    expect(await usedOf(e.id, EXIT_YEAR)).toBe(11);
    // paid 0: min(2, 0) - min(1, 0) = 0.
    await expectNoBill(offboarding.id);
  });

  it("control: snapshot remaining 5, one reject: bill 1 stays (days 1, one outbox row)", async () => {
    const { e, offboarding, reject } = await exitYearScenario({
      used: 7,
      pending: 0,
    });

    await reject();

    expect(await usedOf(e.id, EXIT_YEAR)).toBe(8);
    // paid 5: min(5, 5) - min(4, 5) = 1.
    const audits = await auditsFor(offboarding.id);
    expect(audits).toHaveLength(1);
    expect(Number(audits[0]!.after.days)).toBe(1);
    expect(await outboxFor(offboarding.id)).toHaveLength(1);
  });
});
