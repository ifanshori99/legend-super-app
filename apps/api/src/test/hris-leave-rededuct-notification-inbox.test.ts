// legend-852 T3b (architect finding): end-to-end inbox visibility of
// `leave.rededucted_after_settlement`.
//
// Flow: collective leave day deducted, an accepted clock-in gives it back, the
// offboarding is completed, then the clock-in is REJECTED (re-deduction). The
// resulting outbox event is consumed by the real notification consumer with the
// real recipient resolver. HR users read their inbox through the notification
// service with their own outlet scope (notifications.outlet_id IN scope).
//
// Expected (brief 852 finding 3 + inbox rule of the notification center):
//  - The settlement detail goes to HR of the employee's CURRENT HOME outlet.
//  - Such an HR user whose scope is ONLY the home outlet sees the notification
//    in the inbox and in the unread count, even when the rejected attendance
//    log belongs to another outlet. So the stored notification outlet must be
//    the home outlet, not the outlet of the attendance log.
//  - HR scoped only to the old attendance outlet sees nothing.
//
// Assumptions (spec is silent, stated explicitly):
//  - "izin settlement" = `hr.employee.manage` (guards GET
//    /api/hris/offboardings/:id/settlement), seeded as an outlet-scoped role.
//  - The collective holiday is seeded at the employee's home outlet only; the
//    flagged log is at another outlet. If the collective job does not deduct in
//    that shape the setup assertions below fail (setup, not the behaviour).
//  - Outbox consumption uses the production consumer + resolver with
//    `authorize` always true (authorization of the job is not under test).
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
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
import * as schema from "../db/schema/index.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { consumeOutbox } from "../services/core-outbox.ts";
import { decideAttendanceReview } from "../services/hris-attendance-admin.service.ts";
import {
  createEmployee,
  type CreateEmployeeInput,
} from "../services/hris-employee.service.ts";
import { applyCollectiveLeaveDeductions } from "../services/hris-leave-collective.service.ts";
import { createLeaveType } from "../services/hris-leave.service.ts";
import { createNotificationService } from "../services/notification-center.ts";
import { createNotificationConsumer } from "../services/notification-consumer.ts";
import { createNotificationRecipientResolver } from "../worker/notification-adapters.ts";

const templateTenantId = cafeLegendPlatformFixtures.tenant.id;
const tenantId = tenantIdSchema.parse(randomUUID());
const brandId = randomUUID();
const legalEntityId = randomUUID();
const SYSTEM = { type: "system" } as const;
const YEAR = 2049;
const NOW = new Date("2049-06-15T05:00:00Z"); // 12:00 WIB
const ENTITLED = 12;
const DAY = "2049-05-12";
const LAST_WORKING_DATE = "2049-05-31";
const EVENT = "leave.rededucted_after_settlement";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(appPool, { schema });
const inbox = createNotificationService(database, async () => true);
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
const outletScope = (outletId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
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

/** Outlet-scoped (or tenant-scoped when outletId is null) user with a custom role. */
async function user(
  label: string,
  outletId: string | null,
  permissions: string[],
): Promise<string> {
  const scope = outletId ? "outlet" : "tenant";
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
    [userId, label, `${userId}@example.test`],
  );
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await sql(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4::jsonb, $5::jsonb)`,
    [
      roleId,
      tenantId,
      `${label} ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify([scope]),
    ],
  );
  await sql(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $5, $4, now() - interval '1 hour', $2)`,
    [tenantId, userId, roleId, outletId, scope],
  );
  return userId;
}

const key = () => `cbinbox-${randomUUID()}`;
const freshNo = () =>
  `IB-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

let actor: string;
let reviewer: string;
let annualTypeId: string;

async function newOutlet(): Promise<string> {
  const id = outletIdSchema.parse(randomUUID());
  await sql(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet CBINBOX', 'Jl. CBINBOX', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      id,
      tenantId,
      brandId,
      legalEntityId,
      `CBINBOX-${id.replaceAll("-", "").slice(0, 8)}`.toUpperCase(),
    ],
  );
  return id;
}

async function employeeHomedAt(outletId: string): Promise<Employee> {
  return createEmployee(tenantScope(), actor, {
    userId: null,
    legalEntityId: null,
    employeeNo: freshNo(),
    fullName: "Karyawan Inbox Settlement",
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
    [id, tenantId, outletId, employeeId, day, `cbinbox-log-${id}`],
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

async function seedCompletedOffboarding(employeeId: string): Promise<string> {
  const id = randomUUID();
  const snapshot = finalSettlementSummarySchema.parse({
    offboardingId: id,
    employeeId,
    exitType: "resignation",
    joinDate: "2040-01-02",
    lastWorkingDate: LAST_WORKING_DATE,
    runningSalary: {
      lastPayrollRun: null,
      unpaidFrom: null,
      unpaidTo: LAST_WORKING_DATE,
      unpaidCalendarDays: 0,
    },
    outstandingLoans: { count: 0, amountIdr: 0, loanIds: [] },
    unpaidReimbursements: { count: 0, amountIdr: 0, pendingCount: 0 },
    leave: [
      {
        leaveTypeId: annualTypeId,
        name: "Cuti inbox settlement test",
        periodYear: YEAR,
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
  await sql(
    `INSERT INTO hris_offboardings
       (id, tenant_id, employee_id, exit_type, reason, last_working_date, status,
        access_revoked_at, access_revoked_by, revocation_result,
        settlement_snapshot, completed_at, completed_by, created_by)
     VALUES ($1, $2, $3, 'resignation', 'Selesai', $4, 'completed',
             now(), $5, '{}'::jsonb, $6::jsonb, now(), $5, $5)`,
    [
      id,
      tenantId,
      employeeId,
      LAST_WORKING_DATE,
      actor,
      JSON.stringify(snapshot),
    ],
  );
  return id;
}

/**
 * Employee homed at `homeOutlet`, collective day at the home outlet, flagged
 * log at `attendanceOutlet`; deducted, given back by accept, offboarding
 * completed, then REJECTED (re-deduction). Returns the offboarding id.
 */
async function rejectAfterSettlement(
  homeOutlet: string,
  attendanceOutlet: string,
) {
  const e = await employeeHomedAt(homeOutlet);
  await sql(
    `INSERT INTO leave_balances
       (tenant_id, employee_id, leave_type_id, period_year, entitled_days, used_days)
     VALUES ($1, $2, $3, $4, $5, '0')
     ON CONFLICT (tenant_id, employee_id, leave_type_id, period_year)
     DO UPDATE SET used_days = '0', entitled_days = EXCLUDED.entitled_days`,
    [tenantId, e.id, annualTypeId, YEAR, String(ENTITLED)],
  );
  const logId = await writeFlaggedLog(e.id, attendanceOutlet, DAY);
  await sql(
    `INSERT INTO holidays (tenant_id, outlet_id, date, name, type)
     VALUES ($1, $2, $3, $4, 'collective')`,
    [tenantId, homeOutlet, DAY, `CBINBOX collective ${homeOutlet}`],
  );
  await run();
  expect(await usedOf(e.id)).toBe(1);
  await decide(logId, "accept");
  expect(await usedOf(e.id)).toBe(0);
  const offboardingId = await seedCompletedOffboarding(e.id);
  await decide(logId, "reject");
  expect(await usedOf(e.id)).toBe(1);
  return { employee: e, offboardingId };
}

/** Consume the notification outbox row of the re-deduction through the real consumer. */
async function consumeRededuction(offboardingId: string): Promise<void> {
  const rows = await sql<{ id: string }>(
    `SELECT id FROM domain_event_outbox
      WHERE tenant_id = $1 AND destination = 'notification'
        AND event->>'name' = $2
        AND (event::text LIKE '%' || $3 || '%' OR event::text LIKE '%' || $4 || '%')`,
    [tenantId, EVENT, offboardingId, uuidToUlid(offboardingId)],
  );
  expect(rows).toHaveLength(1);
  const context = workerContext();
  expect(
    await consumeOutbox(database, context, {
      outboxId: uuidToUlid(rows[0]!.id),
      authorize: async () => true,
      deliver: createNotificationConsumer(
        context,
        createNotificationRecipientResolver({ email: true, push: true }),
      ),
    }),
  ).toBe(true);
}

const unread = async (outletId: string, userId: string) =>
  (await inbox.execute(outletScope(outletId), userId, "unreadCount", {})) as {
    data: { unread: number };
  };
const listed = async (outletId: string, userId: string) =>
  (await inbox.execute(outletScope(outletId), userId, "list", {
    query: { limit: 25 },
  })) as { data: unknown[] };

async function storedOutlets(userId: string): Promise<(string | null)[]> {
  const rows = await sql<{ outlet_id: string | null }>(
    `SELECT outlet_id FROM notifications WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
  return rows.map((r) => r.outlet_id);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Rededuct inbox tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantId, `cbinbox-${tenantId.slice(0, 8)}`, templateTenantId],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'cbinbox', 'CBINBOX')",
    [brandId, tenantId],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Entity CBINBOX', false)",
    [legalEntityId, tenantId],
  );
  actor = await user("Actor inbox", null, [
    "hr.employee.manage",
    "hr.employee.view",
  ]);
  reviewer = await user("Reviewer inbox", null, [
    "hr.attendance.manage",
    "hr.employee.view",
    "hr.employee.manage",
  ]);
  const type = await createLeaveType(tenantScope(), actor, {
    ...leaveTypeInputSchema.parse({
      code: "ANNUAL",
      name: "Cuti inbox settlement test",
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
    await client.query(`DELETE FROM delivery_attempts WHERE tenant_id = $1`, [
      tenantId,
    ]);
    await client.query(`DELETE FROM notifications WHERE tenant_id = $1`, [
      tenantId,
    ]);
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'cbinbox-%'",
      [tenantId],
    );
    await client.query(
      "DELETE FROM holidays WHERE tenant_id = $1 AND name LIKE 'CBINBOX %'",
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
  await appPool.end();
});

describe("legend-852 T3b: re-deduction notification reaches the home-outlet HR inbox", () => {
  it("legend-852 attendance rejected at outlet A, employee homed at B: HR scoped only to B sees it unread; HR scoped only to A does not", async () => {
    const outletA = await newOutlet(); // where the rejected log was
    const outletB = await newOutlet(); // employee's home
    const hrB = await user("HR rumah B", outletB, ["hr.employee.manage"]);
    const hrA = await user("HR absen A", outletA, ["hr.employee.manage"]);

    const { offboardingId } = await rejectAfterSettlement(outletB, outletA);
    await consumeRededuction(offboardingId);

    // What HR B actually sees with an outlet-B-only scope.
    expect(await unread(outletB, hrB)).toEqual({ data: { unread: 1 } });
    expect((await listed(outletB, hrB)).data).toHaveLength(1);
    // Stored notification belongs to the home outlet, not the attendance outlet.
    expect(await storedOutlets(hrB)).toEqual([outletB]);
    // HR A (old attendance outlet) is not an audience: nothing stored, nothing visible.
    expect(await storedOutlets(hrA)).toEqual([]);
    expect(await unread(outletA, hrA)).toEqual({ data: { unread: 0 } });
    expect((await listed(outletA, hrA)).data).toHaveLength(0);
  });

  it("legend-852 control: attendance outlet equals home outlet, HR of that outlet sees it unread", async () => {
    const outletB = await newOutlet();
    const hrB = await user("HR rumah B kontrol", outletB, [
      "hr.employee.manage",
    ]);

    const { offboardingId } = await rejectAfterSettlement(outletB, outletB);
    await consumeRededuction(offboardingId);

    expect(await storedOutlets(hrB)).toEqual([outletB]);
    expect(await unread(outletB, hrB)).toEqual({ data: { unread: 1 } });
    expect((await listed(outletB, hrB)).data).toHaveLength(1);
  });
});
