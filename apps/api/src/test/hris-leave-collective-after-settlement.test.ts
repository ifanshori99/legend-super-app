// legend-jitc3 (option b, CTO decision): a collective leave day is deducted
// AGAIN (accepted clock-in later rejected) for an employee whose offboarding is
// already `completed`. The frozen settlement snapshot must NOT change, no
// receivable / money row is created automatically; instead the extra deducted
// day is recorded as an audit line and HR is notified (manual billing).
//
// Expected behaviour comes from the card text / brief, not from service code:
//  1. hris_offboardings.settlement_snapshot is byte-identical after the reject.
//  2. A new audit_logs row, action `hris.leave_collective.rededucted_after_settlement`,
//     objectType `leave_collective`, `maskedChanges.after` holds offboardingId,
//     date, periodYear and the days difference (1).
//  3. Exactly one domain_event_outbox row, destination `notification`, event name
//     `leave.rededucted_after_settlement`, even when the reject
//     is repeated or the collective job runs again. Dedup is per log / day, so a
//     second rejected day gives a second row.
//  4. No automatic receivable and no extra ledger: employee_loans stays empty and
//     the leave ledger rows equal those of a control employee without offboarding;
//     the leave balance is cut exactly as today (used_days 1).
//  5. Employee without a completed offboarding (none, or still open): no such
//     audit line and no such outbox row.
//
// Assumptions:
//  - Seed pattern of hris-leave-collective-carry-cut.test.ts: ANNUAL type, 12
//    days, year 2049, holidays inserted straight into the table, `now` injected.
//  - A completed offboarding is seeded straight into hris_offboardings (status
//    completed + settlement_snapshot, last working day after the collective day).
//    The employee row itself stays `active` so the existing rededuction path is
//    not skipped by employee status.
//  - The offboarding id inside the audit `after` and the outbox event may be the
//    UUID or the ULID form; both are accepted. The outbox payload is only
//    checked for containing the collective date.
//  - "days selisih" is 1 (one collective day deducted again); compared by
//    Number() because the field may be a number or a decimal string.
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
import { createLeaveType } from "../services/hris-leave.service.ts";

const templateTenantId = cafeLegendPlatformFixtures.tenant.id;
const tenantId = tenantIdSchema.parse(randomUUID());
const brandId = randomUUID();
const legalEntityId = randomUUID();
const SYSTEM = { type: "system" } as const;
const YEAR = 2049;
const NOW = new Date("2049-06-15T05:00:00Z"); // 12:00 WIB
const ENTITLED = 12;
const DAY = "2049-05-12";
const DAY2 = "2049-05-13";
const LAST_WORKING_DATE = "2049-05-31";
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
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'After Settlement', $2)`,
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
      `After settlement ${roleId.slice(0, 8)}`,
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

const key = () => `cbaset-${randomUUID()}`;
const freshNo = () =>
  `AS-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

let hr: string;
let reviewer: string;
let annualTypeId: string;

async function newOutlet(): Promise<string> {
  const id = outletIdSchema.parse(randomUUID());
  await sql(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet CBASET', 'Jl. CBASET', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      id,
      tenantId,
      brandId,
      legalEntityId,
      `CBASET-${id.replaceAll("-", "").slice(0, 9)}`.toUpperCase(),
    ],
  );
  return id;
}

async function employeeAt(outletId: string): Promise<Employee> {
  return createEmployee(tenantScope(), hr, {
    userId: null,
    legalEntityId: null,
    employeeNo: freshNo(),
    fullName: "Karyawan After Settlement",
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
    [id, tenantId, outletId, employeeId, day, `cbaset-log-${id}`],
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

async function usedOf(employeeId: string): Promise<number> {
  const rows = await sql<{ u: string }>(
    `SELECT used_days::text AS u FROM leave_balances
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
        AND period_year = $4`,
    [tenantId, employeeId, annualTypeId, YEAR],
  );
  return Number(rows[0]?.u ?? "0");
}

/** Comparable view of the leave ledger of one employee (no ids, no times). */
async function ledgerOf(employeeId: string): Promise<string[]> {
  const rows = await sql<{ k: string; p: string; d: string }>(
    `SELECT kind AS k, period AS p, days::text AS d FROM leave_accruals
      WHERE tenant_id = $1 AND employee_id = $2 ORDER BY kind, period`,
    [tenantId, employeeId],
  );
  return rows.map((r) => `${r.k}|${r.p}|${Number(r.d)}`);
}

async function loanCount(employeeId: string): Promise<number> {
  const rows = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM employee_loans
      WHERE tenant_id = $1 AND employee_id = $2`,
    [tenantId, employeeId],
  );
  return rows[0]!.n;
}

async function seedOffboarding(
  employeeId: string,
  status: "completed" | "open",
  lastWorkingDate: string = LAST_WORKING_DATE,
): Promise<{ id: string; snapshot: Record<string, unknown> | null }> {
  const id = randomUUID();
  // Real frozen shape (finalSettlementSummarySchema): the bill reads leave[].
  const snapshot = finalSettlementSummarySchema.parse({
    offboardingId: id,
    employeeId,
    exitType: "resignation",
    joinDate: "2040-01-02",
    lastWorkingDate,
    runningSalary: {
      lastPayrollRun: null,
      unpaidFrom: null,
      unpaidTo: lastWorkingDate,
      unpaidCalendarDays: 0,
    },
    outstandingLoans: { count: 0, amountIdr: 0, loanIds: [] },
    unpaidReimbursements: { count: 0, amountIdr: 0, pendingCount: 0 },
    leave: [
      {
        leaveTypeId: annualTypeId,
        name: "Cuti after settlement test",
        periodYear: Number(lastWorkingDate.slice(0, 4)),
        entitledDays: ENTITLED.toFixed(4),
        carriedOverDays: "0.0000",
        usedDays: "0.0000",
        pendingDays: "0.0000",
        remainingDays: ENTITLED.toFixed(4),
      },
    ],
    pendingPayrollEngine: [],
    computedAt: "2049-05-31T05:00:00.000Z",
    frozen: true,
  });
  if (status === "completed")
    await sql(
      `INSERT INTO hris_offboardings
         (id, tenant_id, employee_id, exit_type, reason, last_working_date, status,
          access_revoked_at, access_revoked_by, revocation_result,
          settlement_snapshot, completed_at, completed_by, created_by)
       VALUES ($1, $2, $3, 'resignation', 'Selesai', $4, 'completed',
               now(), $5, '{}'::jsonb, $6::jsonb, now(), $5, $5)`,
      [id, tenantId, employeeId, lastWorkingDate, hr, JSON.stringify(snapshot)],
    );
  else
    await sql(
      `INSERT INTO hris_offboardings
         (id, tenant_id, employee_id, exit_type, reason, last_working_date, status, created_by)
       VALUES ($1, $2, $3, 'resignation', 'Masih berjalan', $4, 'open', $5)`,
      [id, tenantId, employeeId, lastWorkingDate, hr],
    );
  return { id, snapshot: status === "completed" ? snapshot : null };
}

async function snapshotText(offboardingId: string): Promise<string | null> {
  const rows = await sql<{ s: string | null }>(
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
  return sql<{ after: Record<string, unknown>; object_type: string | null }>(
    `SELECT event->'maskedChanges'->'after' AS after,
            event->>'objectType' AS object_type
       FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2
        AND event->'maskedChanges'->'after'->>'offboardingId' = ANY($3::text[])`,
    [tenantId, ACTION, idForms(offboardingId)],
  );
}

/** Every audit line of the action for the tenant, to prove "no new line". */
async function auditCountAll(): Promise<number> {
  const rows = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2`,
    [tenantId, ACTION],
  );
  return rows[0]!.n;
}

async function outboxFor(offboardingId: string) {
  return sql<{ destination: string; event: Record<string, unknown> }>(
    `SELECT destination, event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2
        AND (event::text LIKE '%' || $3 || '%' OR event::text LIKE '%' || $4 || '%')`,
    [tenantId, EVENT, ...idForms(offboardingId)],
  );
}

async function outboxCountAll(): Promise<number> {
  const rows = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2`,
    [tenantId, EVENT],
  );
  return rows[0]!.n;
}

/**
 * Collective day(s) deducted, given back by an accepted clock-in (used 0),
 * then optionally the offboarding is seeded; nothing is rejected yet.
 */
async function prepare(opts: {
  offboarding: "completed" | "open" | null;
  days?: string[];
  lastWorkingDate?: string;
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
  const days = opts.days ?? [DAY];
  const logs: string[] = [];
  for (const day of days) {
    logs.push(await writeFlaggedLog(e.id, outletId, day));
    await sql(
      `INSERT INTO holidays (tenant_id, outlet_id, date, name, type)
       VALUES ($1, $2, $3, $4, 'collective')`,
      [tenantId, outletId, day, `CBASET collective ${outletId} ${day}`],
    );
  }
  await run();
  expect(await usedOf(e.id)).toBe(days.length);
  for (const logId of logs) await decide(logId, "accept");
  expect(await usedOf(e.id)).toBe(0);
  const offboarding = opts.offboarding
    ? await seedOffboarding(e.id, opts.offboarding, opts.lastWorkingDate)
    : null;
  return { e, logs, offboarding };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'After settlement tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantId, `cbaset-${tenantId.slice(0, 8)}`, templateTenantId],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'cbaset', 'CBASET')",
    [brandId, tenantId],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Entity CBASET', false)",
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
      name: "Cuti after settlement test",
      paid: true,
      requiresAttachment: false,
      policy: {
        annualDays: "12.0000",
        carryOverMaxDays: "5.0000",
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'cbaset-%'",
      [tenantId],
    );
    await client.query(
      "DELETE FROM holidays WHERE tenant_id = $1 AND name LIKE 'CBASET %'",
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
  // Best effort, like the other private-tenant tests (audit_logs is append-only
  // and references outlets, so the tenant may stay in the disposable DB).
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

describe("legend-jitc3: rejected collective day after a completed offboarding", () => {
  it("keeps the settlement snapshot byte-identical and still cuts the leave balance", async () => {
    const { e, logs, offboarding } = await prepare({
      offboarding: "completed",
    });
    const before = await snapshotText(offboarding!.id);
    expect(before).not.toBeNull();

    await decide(logs[0]!, "reject");

    expect(await snapshotText(offboarding!.id)).toBe(before);
    // Existing behaviour stays: the day is deducted from the balance again.
    expect(await usedOf(e.id)).toBe(1);
  });

  it("records one audit line with offboardingId, date, periodYear and the days difference", async () => {
    const { logs, offboarding } = await prepare({ offboarding: "completed" });
    expect(await auditsFor(offboarding!.id)).toHaveLength(0);

    await decide(logs[0]!, "reject");

    const audits = await auditsFor(offboarding!.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.object_type).toBe("leave_collective");
    const after = audits[0]!.after;
    expect(idForms(offboarding!.id)).toContain(after.offboardingId);
    expect(after.date).toBe(DAY);
    expect(Number(after.periodYear)).toBe(YEAR);
    expect(Number(after.days)).toBe(1);
  });

  it("queues exactly one notification outbox row, and a repeated reject or job run adds none", async () => {
    const { logs, offboarding } = await prepare({ offboarding: "completed" });
    expect(await outboxFor(offboarding!.id)).toHaveLength(0);

    await decide(logs[0]!, "reject");

    const rows = await outboxFor(offboarding!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.destination).toBe("notification");
    expect(JSON.stringify(rows[0]!.event)).toContain(DAY);

    // Same log rejected again (refused as already decided), and the collective
    // job running again: still one outbox row and one audit line.
    await decide(logs[0]!, "reject").catch(() => undefined);
    await run();
    expect(await outboxFor(offboarding!.id)).toHaveLength(1);
    expect(await auditsFor(offboarding!.id)).toHaveLength(1);
  });

  it("dedups per log and day: a second rejected day gives a second row and audit line", async () => {
    const { e, logs, offboarding } = await prepare({
      offboarding: "completed",
      days: [DAY, DAY2],
    });

    await decide(logs[0]!, "reject");
    expect(await outboxFor(offboarding!.id)).toHaveLength(1);
    await decide(logs[1]!, "reject");

    const rows = await outboxFor(offboarding!.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.destination === "notification")).toBe(true);
    const audits = await auditsFor(offboarding!.id);
    expect(audits.map((a) => a.after.date).sort()).toEqual([DAY, DAY2]);
    expect(await usedOf(e.id)).toBe(2);
  });

  it("creates no receivable and no extra ledger: same leave ledger as a control employee, no loan row", async () => {
    const settled = await prepare({ offboarding: "completed" });
    const control = await prepare({ offboarding: null });

    await decide(settled.logs[0]!, "reject");
    await decide(control.logs[0]!, "reject");

    expect(await usedOf(settled.e.id)).toBe(1);
    expect(await usedOf(control.e.id)).toBe(1);
    expect(await ledgerOf(settled.e.id)).toEqual(await ledgerOf(control.e.id));
    expect(await loanCount(settled.e.id)).toBe(0);
  });
});

// Brief 3 / T2: the settlement snapshot only counts the leave left in the exit
// year (entitled + usable carry - used - pending, floored at 0). The extra day
// matters to HR only if it changes that number: days = remaining(exit year)
// before the cut minus after it. days 0 -> audit line only (days 0), no outbox
// row, no notification.
//
// Assumptions: exit year comes from the offboarding's last_working_date. The
// "day before the exit year" case uses a 2050 exit year with a 2049 collective
// day (the collective job only looks back a short time from NOW); no carry-over
// row exists, so the 2049 cut cannot reach 2050. The exit-year balance row of
// 2050 is seeded (entitled 12, used 0) so the zero comes from the rule, not
// from a missing row.
describe("legend-jitc3: days = change in the exit-year remaining leave", () => {
  const EXIT_YEAR_LATER = "2050-05-31";

  it("normal case (collective day in the exit year, leave left): days 1, one audit line, one outbox row", async () => {
    const { logs, offboarding } = await prepare({ offboarding: "completed" });

    await decide(logs[0]!, "reject");

    const audits = await auditsFor(offboarding!.id);
    expect(audits).toHaveLength(1);
    expect(Number(audits[0]!.after.days)).toBe(1);
    expect(await outboxFor(offboarding!.id)).toHaveLength(1);
  });

  it("collective day in a year before the exit year: audit line with days 0, no outbox row", async () => {
    const { e, logs, offboarding } = await prepare({
      offboarding: "completed",
      lastWorkingDate: EXIT_YEAR_LATER,
    });
    await sql(
      `INSERT INTO leave_balances
         (tenant_id, employee_id, leave_type_id, period_year, entitled_days, used_days)
       VALUES ($1, $2, $3, 2050, $4, '0')
       ON CONFLICT (tenant_id, employee_id, leave_type_id, period_year)
       DO UPDATE SET used_days = '0', entitled_days = EXCLUDED.entitled_days`,
      [tenantId, e.id, annualTypeId, String(ENTITLED)],
    );
    const before = await snapshotText(offboarding!.id);

    await decide(logs[0]!, "reject");

    expect(await usedOf(e.id)).toBe(1); // the day is still deducted in 2049
    expect(await snapshotText(offboarding!.id)).toBe(before);
    const audits = await auditsFor(offboarding!.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.object_type).toBe("leave_collective");
    expect(audits[0]!.after.date).toBe(DAY);
    expect(Number(audits[0]!.after.days)).toBe(0);
    expect(await outboxFor(offboarding!.id)).toHaveLength(0);

    // Repeating the reject / job still adds nothing.
    await decide(logs[0]!, "reject").catch(() => undefined);
    await run();
    expect(await auditsFor(offboarding!.id)).toHaveLength(1);
    expect(await outboxFor(offboarding!.id)).toHaveLength(0);
  });

  it("exit-year remaining leave already 0: audit line with days 0, no outbox row", async () => {
    const { e, logs, offboarding } = await prepare({
      offboarding: "completed",
    });
    // Whole entitlement of the exit year used up before the day is deducted again.
    await sql(
      `UPDATE leave_balances SET used_days = entitled_days
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
          AND period_year = $4`,
      [tenantId, e.id, annualTypeId, YEAR],
    );
    const before = await snapshotText(offboarding!.id);

    await decide(logs[0]!, "reject");

    expect(await snapshotText(offboarding!.id)).toBe(before);
    const audits = await auditsFor(offboarding!.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after.date).toBe(DAY);
    expect(Number(audits[0]!.after.days)).toBe(0);
    expect(await outboxFor(offboarding!.id)).toHaveLength(0);
  });
});

describe("legend-jitc3: employees without a completed offboarding", () => {
  it("no offboarding at all: the day is cut as before, no audit line and no outbox row", async () => {
    const auditsBefore = await auditCountAll();
    const outboxBefore = await outboxCountAll();
    const { e, logs } = await prepare({ offboarding: null });

    await decide(logs[0]!, "reject");

    expect(await usedOf(e.id)).toBe(1);
    expect(await auditCountAll()).toBe(auditsBefore);
    expect(await outboxCountAll()).toBe(outboxBefore);
  });

  it("offboarding still open (not completed): no audit line and no outbox row", async () => {
    const { e, logs, offboarding } = await prepare({ offboarding: "open" });
    const auditsBefore = await auditCountAll();
    const outboxBefore = await outboxCountAll();

    await decide(logs[0]!, "reject");

    expect(await usedOf(e.id)).toBe(1);
    expect(await auditsFor(offboarding!.id)).toHaveLength(0);
    expect(await outboxFor(offboarding!.id)).toHaveLength(0);
    expect(await auditCountAll()).toBe(auditsBefore);
    expect(await outboxCountAll()).toBe(outboxBefore);
  });
});
