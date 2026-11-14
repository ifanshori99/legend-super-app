// legend-qmte follow-up (502 item A, decisions L1 + M1): reversal of a collective
// leave ("cuti bersama") deduction when an accepted clock-in appears LATER.
//
// Expected behaviour comes from docs/briefs/hris-leave-guard.md section 502 item
// A and the shared contract, not from the service code:
//  - L1: a collective day is DEDUCTED while the employee's `in` log on that
//    business date is only flagged / pending review. Only a valid log
//    (validity 'valid', review_status <> 'rejected') or a flagged log whose
//    review was accepted cancels the deduction.
//  - M1: when such a log appears AFTER the deduction (flagged review accepted,
//    approved manual correction, offline/edge sync), the deduction is reversed by
//    a COMPENSATING ledger row (+1 day, never a delete) and `used_days` gets the
//    day back. Idempotent: never reversed twice. A rejected log reverses nothing.
//  - Money rule (doubt restricts payment): the balance never exceeds the
//    entitlement, and the final settlement never lists an unaccepted day as
//    remaining (payable) leave.
//
// Assumptions (the brief leaves these open):
//  - Ledger kind of the compensating row: `collective_leave_reversal`
//    (the brief says "kind e.g. collective_leave_reversal"), same `period`
//    (the holiday date) as the original `collective_leave` row, days +1.
//    Change REVERSAL_KIND below if the engineer picks another name.
//  - Flagged review accepted: reversal happens inside decideAttendanceReview
//    (no job run needed). Approved correction and edge sync need heavy
//    fixtures (approval policy + MFA, edge node), so those two are simulated by
//    the log row they end up writing (method manual_correction / outlet_device,
//    validity valid) followed by the idempotent daily collective run
//    (applyCollectiveLeaveDeductions); the run must reconcile such a log.
//  - Everything is dated 2049 and `now` is injected (2049-06-15 12:00 WIB).
//    The file runs in its own private tenant (copied from the fixture tenant
//    row, own brand, legal entity and outlet), so it may run beside other
//    files. The leave type code stays `ANNUAL`: the collective service
//    resolves the deduction type by that code, which is unique per tenant.
//  - The settlement lists a leave entry for the annual type of the year of the
//    injected `now`; remainingDays = entitled + carried - used - pending.
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
  leaveTypeInputSchema,
  type CreateOffboardingInput,
  type Employee,
} from "@starter/shared/hris";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { decideAttendanceReview } from "../services/hris-attendance-admin.service.ts";
import {
  createEmployee,
  type CreateEmployeeInput,
} from "../services/hris-employee.service.ts";
import {
  createHoliday,
  deleteHoliday,
} from "../services/hris-holiday.service.ts";
import { applyCollectiveLeaveDeductions } from "../services/hris-leave-collective.service.ts";
import { createLeaveType } from "../services/hris-leave.service.ts";
import { createOffboarding } from "../services/hris-offboarding.service.ts";
import { getFinalSettlement } from "../services/hris-settlement.service.ts";

const REVERSAL_KIND = "collective_leave_reversal";
// Private fixtures: this file never touches the shared fixture tenant rows.
const templateTenantId = cafeLegendPlatformFixtures.tenant.id;
const tenantId = tenantIdSchema.parse(randomUUID());
const outletA = outletIdSchema.parse(randomUUID());
const brandId = randomUUID();
const legalEntityId = randomUUID();
const SYSTEM = { type: "system" } as const;
const YEAR = 2049;
// 2049-06-15 05:00Z = 12:00 WIB.
const NOW = new Date("2049-06-15T05:00:00Z");
const ENTITLED = 12;

// One collective day (outlet A) per case, so cases never share a date.
const DAY = {
  accept: "2049-03-02",
  correction: "2049-03-03",
  sync: "2049-03-04",
  rejectReview: "2049-03-05",
  rejectedLater: "2049-03-06",
  idempotent: "2049-03-09",
  cap: "2049-03-10",
  settleAccept: "2049-03-11",
  settleReject: "2049-03-12",
} as const;

// Fix F3 days. Inserted straight into the table by the F3 describe: once a
// carry-over row for 2050 exists (F1 item 3), the service refuses holidays of
// 2049, and creating them up front would shift the earlier cases' day counts.
const F3 = {
  reject: "2049-05-04",
  reflag: "2049-05-05",
  flagThenReject: "2049-05-03",
  stays: "2049-05-06",
  second: "2049-05-07",
  settle: "2049-05-10",
  closed: "2049-05-11",
} as const;

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
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Cuti Bersama Reversal', $2)`,
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
      `Cuti bersama reversal ${roleId.slice(0, 8)}`,
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

const key = () => `cbrev-${randomUUID()}`;
const freshNo = () =>
  `CR-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

let hr: string;
let reviewer: string;
let annualTypeId: string;

async function annualType(): Promise<string> {
  const type = await createLeaveType(tenantScope(), hr, {
    ...leaveTypeInputSchema.parse({
      code: "ANNUAL",
      name: "Cuti reversal test",
      paid: true,
      requiresAttachment: false,
      policy: {
        annualDays: "12.0000",
        carryOverMaxDays: "0.0000",
        carryOverExpiryMonths: 0,
        tracksBalance: true,
      },
    }),
    idempotencyKey: key(),
  });
  createdTypes.push(type.id);
  return type.id;
}

/** Fresh employee with an entitlement of 12 and nothing used. */
async function employee(): Promise<Employee> {
  const created = await createEmployee(tenantScope(), hr, {
    userId: null,
    legalEntityId: null,
    employeeNo: freshNo(),
    fullName: "Karyawan Reversal Cuti Bersama",
    positionId: null,
    orgUnitId: null,
    managerId: null,
    homeOutletId: outletA,
    employmentType: "pkwt",
    joinDate: "2040-01-02",
    endDate: null,
    ptkpStatus: "TK/0",
    status: "active",
  } as CreateEmployeeInput);
  await sql(
    `INSERT INTO leave_balances
       (tenant_id, employee_id, leave_type_id, period_year, entitled_days, used_days)
     VALUES ($1, $2, $3, $4, $5, '0')
     ON CONFLICT (tenant_id, employee_id, leave_type_id, period_year)
     DO UPDATE SET used_days = '0', entitled_days = EXCLUDED.entitled_days`,
    [tenantId, created.id, annualTypeId, YEAR, String(ENTITLED)],
  );
  return created;
}

const holiday = (date: string) =>
  createHoliday(tenantScope(), hr, {
    date,
    name: `CBREV collective ${date}`,
    type: "collective",
    outletId: outletA,
    idempotencyKey: key(),
  } as never);

const run = () => applyCollectiveLeaveDeductions(workerContext(), NOW, SYSTEM);

type LedgerRow = { kind: string; days: number };
async function ledger(employeeId: string, date: string): Promise<LedgerRow[]> {
  const rows = await sql<{ kind: string; days: string }>(
    `SELECT kind, days FROM leave_accruals
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
        AND period = $4 AND kind IN ('collective_leave', $5)
      ORDER BY kind`,
    [tenantId, employeeId, annualTypeId, date, REVERSAL_KIND],
  );
  return rows.map((row) => ({ kind: row.kind, days: Number(row.days) }));
}
const DEDUCTED: LedgerRow = { kind: "collective_leave", days: -1 };
const REVERSED: LedgerRow = { kind: REVERSAL_KIND, days: 1 };

const usedOf = async (employeeId: string) =>
  Number(
    (
      await sql<{ used_days: string }>(
        `SELECT used_days FROM leave_balances
          WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = $4`,
        [tenantId, employeeId, annualTypeId, YEAR],
      )
    )[0]?.used_days ?? "0",
  );

/** Net days still deducted in the year according to the ledger. */
async function netDeducted(employeeId: string): Promise<number> {
  const [row] = await sql<{ net: string | null }>(
    `SELECT sum(days)::text AS net FROM leave_accruals
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
        AND period LIKE '2049%' AND kind IN ('collective_leave', $4)`,
    [tenantId, employeeId, annualTypeId, REVERSAL_KIND],
  );
  // 0 - n, not -n: a zero net must be +0 for toBe (Object.is).
  return 0 - Number(row?.net ?? "0");
}

/** Money invariant: used follows the ledger and never leaves 0..entitlement. */
async function expectBalanceConsistent(employeeId: string) {
  const used = await usedOf(employeeId);
  expect(used).toBe(await netDeducted(employeeId));
  expect(used).toBeGreaterThanOrEqual(0);
  // available = entitled - used must never exceed the entitlement.
  expect(ENTITLED - used).toBeLessThanOrEqual(ENTITLED);
}

async function writeLog(
  employeeId: string,
  date: string,
  input: {
    validity?: "valid" | "flagged" | "rejected";
    review?: "none" | "pending" | "accepted" | "rejected";
    method?: "rotating_qr" | "manual_correction" | "outlet_device";
  } = {},
): Promise<string> {
  const review = input.review ?? "none";
  const reviewed = review === "accepted" || review === "rejected";
  const id = randomUUID();
  await sql(
    `INSERT INTO attendance_logs
       (id, tenant_id, outlet_id, employee_id, type, method, occurred_at,
        validity, flag_reasons, business_date, client_event_id,
        review_status, reviewed_by, reviewed_at)
     VALUES ($1, $2, $3, $4, 'in', $5, ($6::date + time '08:00') AT TIME ZONE 'Asia/Jakarta',
             $7, '[]'::jsonb, $6::date, $8, $9, $10,
             CASE WHEN $11::boolean THEN now() END)`,
    [
      id,
      tenantId,
      outletA,
      employeeId,
      input.method ?? "rotating_qr",
      date,
      input.validity ?? "valid",
      `cbrev-log-${id}`,
      review,
      reviewed ? "reviewer" : null,
      reviewed,
    ],
  );
  return id;
}

const review = (logId: string, action: "accept" | "reject", idem = key()) =>
  // The review service takes the log's public ULID, not the stored uuid.
  // `now` is the test clock: the collective days are in 2049.
  decideAttendanceReview(
    tenantScope(),
    reviewer,
    uuidToUlid(logId),
    { action, idempotencyKey: idem } as never,
    undefined,
    NOW,
  );

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Cuti bersama reversal tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantId, `cbrev-${tenantId.slice(0, 8)}`, templateTenantId],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'cbrev', 'CBREV')",
    [brandId, tenantId],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Entity CBREV', false)",
    [legalEntityId, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet CBREV', 'Jl. CBREV', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      outletA,
      tenantId,
      brandId,
      legalEntityId,
      `CBREV-${tenantId.slice(0, 8)}`.toUpperCase(),
    ],
  );
  hr = await customUser(["hr.employee.manage", "hr.employee.view"]);
  reviewer = await customUser([
    "hr.attendance.manage",
    "hr.employee.view",
    "hr.employee.manage",
  ]);
  annualTypeId = await annualType();
  for (const date of Object.values(DAY)) await holiday(date);
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
      `DELETE FROM hris_checklist_task_actions WHERE tenant_id = $1 AND task_id IN
         (SELECT id FROM hris_checklist_tasks WHERE tenant_id = $1 AND employee_id IN ${mine})`,
      [tenantId, createdUsers],
    );
    await client.query(
      `DELETE FROM hris_checklist_tasks WHERE tenant_id = $1 AND employee_id IN ${mine}`,
      [tenantId, createdUsers],
    );
    await client.query(
      `DELETE FROM hris_offboardings WHERE tenant_id = $1 AND employee_id IN ${mine}`,
      [tenantId, createdUsers],
    );
    await client.query(
      `DELETE FROM attendance_logs WHERE tenant_id = $1 AND employee_id IN ${mine}`,
      [tenantId, createdUsers],
    );
    await client.query(
      `DELETE FROM leave_accruals WHERE tenant_id = $1
         AND leave_type_id = ANY($2::uuid[])`,
      [tenantId, createdTypes],
    );
    await client.query(
      `DELETE FROM leave_balances WHERE tenant_id = $1
         AND leave_type_id = ANY($2::uuid[])`,
      [tenantId, createdTypes],
    );
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'cbrev-%'",
      [tenantId],
    );
    await client.query(
      "DELETE FROM holidays WHERE tenant_id = $1 AND name LIKE 'CBREV %'",
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
  // Private tenant rows (children first); the tenant itself last. Best effort,
  // like the other private-tenant tests.
  await owner
    .query("DELETE FROM outlets WHERE tenant_id = $1", [tenantId])
    .catch(() => undefined);
  await owner
    .query("DELETE FROM legal_entities WHERE tenant_id = $1", [tenantId])
    .catch(() => undefined);
  await owner
    .query("DELETE FROM brands WHERE tenant_id = $1", [tenantId])
    .catch(() => undefined);
  await owner
    .query("DELETE FROM tenants WHERE id = $1", [tenantId])
    .catch(() => undefined);
  await owner
    .query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers])
    .catch(() => undefined);
  await owner.end();
});

describe("L1: flagged / pending clock-in does not protect the collective day", () => {
  it("a flagged, pending-review clock-in is deducted on the first run", async () => {
    const e = await employee();
    await writeLog(e.id, DAY.accept, {
      validity: "flagged",
      review: "pending",
    });
    await run();
    expect(await ledger(e.id, DAY.accept)).toEqual([DEDUCTED]);
    await expectBalanceConsistent(e.id);
  });
});

describe("M1: reversal when an accepted clock-in appears after the deduction", () => {
  it("flagged review accepted: compensating +1 ledger row, used_days back, original row kept", async () => {
    const e = await employee();
    const logId = await writeLog(e.id, DAY.accept, {
      validity: "flagged",
      review: "pending",
    });
    await run();
    expect(await ledger(e.id, DAY.accept)).toEqual([DEDUCTED]);
    const usedDeducted = await usedOf(e.id);
    expect(usedDeducted).toBeGreaterThanOrEqual(1);

    await review(logId, "accept");

    // Compensating row, never a delete: both rows exist and net to zero.
    expect(await ledger(e.id, DAY.accept)).toEqual([DEDUCTED, REVERSED]);
    expect(await usedOf(e.id)).toBe(usedDeducted - 1);
    await expectBalanceConsistent(e.id);
  });

  it("approved manual correction (valid in-log appears later): reversed on the next reconcile", async () => {
    const e = await employee();
    await run();
    expect(await ledger(e.id, DAY.correction)).toEqual([DEDUCTED]);
    const usedDeducted = await usedOf(e.id);

    // What an approved correction writes: a valid manual_correction `in` log.
    await writeLog(e.id, DAY.correction, { method: "manual_correction" });
    await run();

    expect(await ledger(e.id, DAY.correction)).toEqual([DEDUCTED, REVERSED]);
    expect(await usedOf(e.id)).toBe(usedDeducted - 1);
    await expectBalanceConsistent(e.id);
  });

  it("offline / edge sync (valid in-log appears later): reversed on the next reconcile", async () => {
    const e = await employee();
    await run();
    expect(await ledger(e.id, DAY.sync)).toEqual([DEDUCTED]);
    const usedDeducted = await usedOf(e.id);

    // What the edge `attendance.logged` applier writes for an outlet device.
    await writeLog(e.id, DAY.sync, { method: "outlet_device" });
    await run();

    expect(await ledger(e.id, DAY.sync)).toEqual([DEDUCTED, REVERSED]);
    expect(await usedOf(e.id)).toBe(usedDeducted - 1);
    await expectBalanceConsistent(e.id);
  });
});

describe("M1: a log that never became accepted reverses nothing", () => {
  it("flagged review rejected: day stays deducted, no compensating row", async () => {
    const e = await employee();
    const logId = await writeLog(e.id, DAY.rejectReview, {
      validity: "flagged",
      review: "pending",
    });
    await run();
    const usedDeducted = await usedOf(e.id);

    await review(logId, "reject");
    await run();

    expect(await ledger(e.id, DAY.rejectReview)).toEqual([DEDUCTED]);
    expect(await usedOf(e.id)).toBe(usedDeducted);
    await expectBalanceConsistent(e.id);
  });

  it("a rejected in-log that shows up later (sync) reverses nothing", async () => {
    const e = await employee();
    await run();
    const usedDeducted = await usedOf(e.id);

    await writeLog(e.id, DAY.rejectedLater, {
      validity: "rejected",
      review: "rejected",
      method: "outlet_device",
    });
    await run();
    await run();

    expect(await ledger(e.id, DAY.rejectedLater)).toEqual([DEDUCTED]);
    expect(await usedOf(e.id)).toBe(usedDeducted);
    await expectBalanceConsistent(e.id);
  });
});

describe("M1: idempotent and capped by the entitlement", () => {
  it("never reverses twice: replayed accept and repeated runs leave exactly one reversal row", async () => {
    const e = await employee();
    const logId = await writeLog(e.id, DAY.idempotent, {
      validity: "flagged",
      review: "pending",
    });
    await run();
    const usedDeducted = await usedOf(e.id);
    const idem = key();
    await review(logId, "accept", idem);
    expect(await ledger(e.id, DAY.idempotent)).toEqual([DEDUCTED, REVERSED]);

    // A replay of the same decision may answer the stored result or be
    // refused; either way nothing is reversed again.
    await review(logId, "accept", idem).catch(() => undefined);
    await review(logId, "accept").catch(() => undefined);
    await run();
    await run();

    expect(await ledger(e.id, DAY.idempotent)).toEqual([DEDUCTED, REVERSED]);
    expect(await usedOf(e.id)).toBe(usedDeducted - 1);
    await expectBalanceConsistent(e.id);
  });

  it("the balance never goes above the entitlement, even when every protected day is reversed", async () => {
    const e = await employee();
    await run();
    // Every collective day of this file is now deducted for this employee.
    const all = Object.values(DAY);
    expect(await usedOf(e.id)).toBe(all.length);
    for (const date of all) await writeLog(e.id, date);
    await run();
    await run();

    for (const date of all)
      expect(await ledger(e.id, date)).toEqual([DEDUCTED, REVERSED]);
    expect(await usedOf(e.id)).toBe(0);
    await expectBalanceConsistent(e.id);
    const [balance] = await sql<{ avail: string; entitled: string }>(
      `SELECT (entitled_days + carried_over_days - used_days - pending_days)::text AS avail,
              entitled_days::text AS entitled
         FROM leave_balances
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = $4`,
      [tenantId, e.id, annualTypeId, YEAR],
    );
    expect(Number(balance!.avail)).toBeLessThanOrEqual(
      Number(balance!.entitled),
    );
  });
});

describe("final settlement does not pay a day that was not accepted", () => {
  async function leaver(employeeId: string) {
    const offboarding = await createOffboarding(tenantScope(), hr, employeeId, {
      exitType: "termination",
      reason: "Akhir hubungan kerja uji.",
      lastWorkingDate: "2049-12-31",
    } as CreateOffboardingInput);
    return offboarding.id;
  }
  async function remaining(offboardingId: string): Promise<number> {
    const summary = await getFinalSettlement(
      tenantScope(),
      hr,
      offboardingId,
      NOW,
    );
    const entry = summary.leave.find(
      (item) => item.leaveTypeId === annualTypeId && item.periodYear === YEAR,
    );
    expect(entry, "settlement lists the annual leave balance").toBeDefined();
    return Number(entry!.remainingDays);
  }

  it("flagged day: not payable while unaccepted, restored (never above entitlement) once accepted", async () => {
    const e = await employee();
    const logId = await writeLog(e.id, DAY.settleAccept, {
      validity: "flagged",
      review: "pending",
    });
    await run();
    const offboardingId = await leaver(e.id);

    const whileUnaccepted = await remaining(offboardingId);
    // Deducted days are not paid: remaining = entitlement - everything deducted.
    expect(whileUnaccepted).toBe(ENTITLED - (await usedOf(e.id)));
    expect(whileUnaccepted).toBeLessThanOrEqual(ENTITLED);

    await review(logId, "accept");
    const afterAccept = await remaining(offboardingId);
    expect(afterAccept).toBe(whileUnaccepted + 1);
    expect(afterAccept).toBeLessThanOrEqual(ENTITLED);
  });

  it("rejected day: the settlement never pays it, before or after the rejection", async () => {
    const e = await employee();
    const logId = await writeLog(e.id, DAY.settleReject, {
      validity: "flagged",
      review: "pending",
    });
    await run();
    const offboardingId = await leaver(e.id);
    const before = await remaining(offboardingId);

    await review(logId, "reject");
    await run();
    const after = await remaining(offboardingId);

    expect(after).toBe(before);
    expect(after).toBe(ENTITLED - (await usedOf(e.id)));
    expect(after).toBeLessThanOrEqual(ENTITLED);
  });
});

// ---- fix F1 (tier K, money): reversal x holiday removal, lock order, closed year

const reviewAt = (logId: string, now: Date) =>
  decideAttendanceReview(
    tenantScope(),
    reviewer,
    uuidToUlid(logId),
    { action: "accept", idempotencyKey: key() } as never,
    undefined,
    now,
  );

describe("F1 item 1: removing a holiday whose day was already reversed", () => {
  it("gives the day back once: used equals the value before the deduction, no ledger row left, a re-added day deducts and reverses once", async () => {
    const date = "2049-04-06";
    const e = await employee();
    const logId = await writeLog(e.id, date, {
      validity: "flagged",
      review: "pending",
    });
    const added = await holiday(date);
    await run();
    expect(await ledger(e.id, date)).toEqual([DEDUCTED]);
    const base = (await usedOf(e.id)) - 1;

    await review(logId, "accept");
    expect(await ledger(e.id, date)).toEqual([DEDUCTED, REVERSED]);
    expect(await usedOf(e.id)).toBe(base);

    await deleteHoliday(tenantScope(), hr, added.id, NOW);
    expect(await ledger(e.id, date)).toEqual([]);
    expect(await usedOf(e.id)).toBe(base);
    await expectBalanceConsistent(e.id);

    // The day comes back with the log pending again: one deduction, one reversal.
    await sql(
      `UPDATE attendance_logs SET validity = 'flagged', review_status = 'pending',
              reviewed_by = NULL, reviewed_at = NULL WHERE id = $1`,
      [logId],
    );
    await holiday(date);
    await run();
    await run();
    expect(await ledger(e.id, date)).toEqual([DEDUCTED]);
    expect(await usedOf(e.id)).toBe(base + 1);
    await review(logId, "accept");
    expect(await ledger(e.id, date)).toEqual([DEDUCTED, REVERSED]);
    expect(await usedOf(e.id)).toBe(base);
    await expectBalanceConsistent(e.id);
  });
});

describe("F1 item 2: one lock order (employee lock, log row, balance, ledger)", () => {
  const lockName = (employeeId: string) =>
    `hris:leave-attendance:${tenantId}:${employeeId.toLowerCase()}`;
  const waitersOn = async (employeeId: string): Promise<number> => {
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
      [lockName(employeeId)],
    );
    return rows[0]!.n;
  };

  /**
   * Tx A holds the employee lock; `startB` must queue on it while holding no
   * row lock that `probe` (run on A) tries with NOWAIT: a NOWAIT failure means
   * B took that row before the employee lock (inverted order).
   */
  async function behindEmployeeLock(
    employeeId: string,
    startB: () => Promise<unknown>,
    probe: string,
    probeParams: unknown[],
  ): Promise<void> {
    const a = await owner.connect();
    let finished = false;
    let b: Promise<unknown> = Promise.resolve();
    try {
      await a.query("BEGIN");
      await a.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      await a.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        lockName(employeeId),
      ]);
      b = startB().finally(() => {
        finished = true;
      });
      b.catch(() => undefined);
      const deadline = Date.now() + 15_000;
      while (!finished && (await waitersOn(employeeId)) === 0) {
        if (Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(
        finished,
        "B finished while A held the employee lock: the path does not take lockEmployeeLeaveAttendance",
      ).toBe(false);
      expect(await waitersOn(employeeId)).toBeGreaterThan(0);
      await a.query(probe, probeParams);
    } finally {
      await a.query("COMMIT").catch(() => undefined);
      a.release();
    }
    await b;
  }

  it("review accept waits for the employee lock before it locks the log row", async () => {
    const e = await employee();
    const logId = await writeLog(e.id, DAY.accept, {
      validity: "flagged",
      review: "pending",
    });
    await run();
    await behindEmployeeLock(
      e.id,
      () => review(logId, "accept"),
      "SELECT id FROM attendance_logs WHERE id = $1 FOR UPDATE NOWAIT",
      [logId],
    );
    expect(await ledger(e.id, DAY.accept)).toEqual([DEDUCTED, REVERSED]);
    await expectBalanceConsistent(e.id);
  });

  it("the daily reconcile waits for the employee lock before it touches the balance or the ledger", async () => {
    const e = await employee();
    await run();
    await writeLog(e.id, DAY.correction, { method: "manual_correction" });
    await behindEmployeeLock(
      e.id,
      () => run(),
      `SELECT id FROM leave_balances
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
          AND period_year = $4 FOR UPDATE NOWAIT`,
      [tenantId, e.id, annualTypeId, YEAR],
    );
    expect(await ledger(e.id, DAY.correction)).toEqual([DEDUCTED, REVERSED]);
    await expectBalanceConsistent(e.id);
  });

  it("a daily run racing review accepts of the same employee never deadlocks", async () => {
    const e = await employee();
    const days = [DAY.accept, DAY.correction, DAY.sync, DAY.rejectReview];
    const logs: string[] = [];
    for (const date of days)
      logs.push(
        await writeLog(e.id, date, { validity: "flagged", review: "pending" }),
      );
    await run();
    // Three days become reconcilable for the run, the fourth is accepted by a
    // reviewer at the same time.
    for (const date of days.slice(1))
      await writeLog(e.id, date, { method: "outlet_device" });
    const results = await Promise.allSettled([
      run(),
      review(logs[0]!, "accept"),
      run(),
    ]);
    for (const result of results)
      if (result.status === "rejected")
        expect(String(result.reason)).not.toMatch(/deadlock|40P01/i);
    for (const date of days)
      expect(await ledger(e.id, date)).toEqual([DEDUCTED, REVERSED]);
    expect(await usedOf(e.id)).toBe(await netDeducted(e.id));
  });
});

describe("F1 item 3: a closed collective year stays closed", () => {
  it("carry-over of the collective day's year already ran: an accept two years later reverses nothing", async () => {
    const date = "2049-04-07";
    const e = await employee();
    const logId = await writeLog(e.id, date, {
      validity: "flagged",
      review: "pending",
    });
    await holiday(date);
    await run();
    expect(await ledger(e.id, date)).toEqual([DEDUCTED]);
    const used = await usedOf(e.id);
    // Carry-over of 2049 into 2050 ran for this employee.
    await sql(
      `INSERT INTO leave_accruals (tenant_id, employee_id, leave_type_id, kind, period, days)
       VALUES ($1, $2, $3, 'carry_over', '2050', '0')`,
      [tenantId, e.id, annualTypeId],
    );

    await reviewAt(logId, new Date("2051-06-15T05:00:00Z"));

    expect(await ledger(e.id, date)).toEqual([DEDUCTED]);
    expect(await usedOf(e.id)).toBe(used);
  });
});

// ---- fix F3 (tier K, money): an accepted log later rejected / re-flagged

const REDEDUCTION_KIND = "collective_leave_rededuction";
const REDEDUCED: LedgerRow = { kind: REDEDUCTION_KIND, days: -1 };
const KIND_ORDER = ["collective_leave", REVERSAL_KIND, REDEDUCTION_KIND];

/** Deduction, reversal and rededuction rows of one employee and date, in that order. */
async function chain(employeeId: string, date: string): Promise<LedgerRow[]> {
  const rows = await sql<{ kind: string; days: string }>(
    `SELECT kind, days FROM leave_accruals
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
        AND period = $4 AND kind = ANY($5)`,
    [tenantId, employeeId, annualTypeId, date, KIND_ORDER],
  );
  return rows
    .map((row) => ({ kind: row.kind, days: Number(row.days) }))
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}
const DRX = [DEDUCTED, REVERSED, REDEDUCED];

/** Used must equal the ledger net (D + R + X) of the year and stay in 0..pool. */
async function expectChainConsistent(employeeId: string) {
  const [row] = await sql<{ net: string | null }>(
    `SELECT sum(days)::text AS net FROM leave_accruals
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
        AND period LIKE '2049%' AND kind = ANY($4)`,
    [tenantId, employeeId, annualTypeId, KIND_ORDER],
  );
  const used = await usedOf(employeeId);
  expect(used).toBe(0 - Number(row?.net ?? "0"));
  expect(used).toBeGreaterThanOrEqual(0);
  expect(ENTITLED - used).toBeLessThanOrEqual(ENTITLED);
}

const decide = (
  logId: string,
  action: "accept" | "reject" | "flag",
  idem = key(),
) =>
  decideAttendanceReview(
    tenantScope(),
    reviewer,
    uuidToUlid(logId),
    { action, idempotencyKey: idem } as never,
    undefined,
    NOW,
  );

describe("F3: an accepted day whose log is later rejected or re-flagged is deducted again", () => {
  beforeAll(async () => {
    for (const date of new Set(Object.values(F3)))
      await sql(
        `INSERT INTO holidays (tenant_id, outlet_id, date, name, type)
         VALUES ($1, $2, $3, $4, 'collective')
         ON CONFLICT DO NOTHING`,
        [tenantId, outletA, date, `CBREV collective ${date}`],
      );
  });

  it("accepted then rejected: one rededuction row, used back, D and R kept, replays add nothing", async () => {
    const e = await employee();
    const logId = await writeLog(e.id, F3.reject, {
      validity: "flagged",
      review: "pending",
    });
    await run();
    const deducted = await usedOf(e.id);
    await decide(logId, "accept");
    expect(await chain(e.id, F3.reject)).toEqual([DEDUCTED, REVERSED]);
    expect(await usedOf(e.id)).toBe(deducted - 1);

    const idem = key();
    await decide(logId, "reject", idem);

    expect(await chain(e.id, F3.reject)).toEqual(DRX);
    expect(await usedOf(e.id)).toBe(deducted);
    await expectChainConsistent(e.id);

    // Replays: same key, new key (409 on a rejected log), daily runs.
    await decide(logId, "reject", idem).catch(() => undefined);
    await expect(decide(logId, "reject")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await run();
    await run();
    expect(await chain(e.id, F3.reject)).toEqual(DRX);
    expect(await usedOf(e.id)).toBe(deducted);
    await expectChainConsistent(e.id);
  });

  it("accepted then re-flagged (pending): no rededuction, ledger stays D,R and used is unchanged (Q42)", async () => {
    const e = await employee();
    const logId = await writeLog(e.id, F3.reflag, {
      validity: "flagged",
      review: "pending",
    });
    await run();
    const deducted = await usedOf(e.id);
    await decide(logId, "accept");
    expect(await usedOf(e.id)).toBe(deducted - 1);

    await decide(logId, "flag");

    expect(await chain(e.id, F3.reflag)).toEqual([DEDUCTED, REVERSED]);
    expect(await usedOf(e.id)).toBe(deducted - 1);
    await run();
    expect(await chain(e.id, F3.reflag)).toEqual([DEDUCTED, REVERSED]);
    expect(await usedOf(e.id)).toBe(deducted - 1);
    await expectChainConsistent(e.id);
  });

  it("accepted, flagged (no X), then rejected: the rededuction is written exactly once (Q42)", async () => {
    const e = await employee();
    const logId = await writeLog(e.id, F3.flagThenReject, {
      validity: "flagged",
      review: "pending",
    });
    await run();
    const deducted = await usedOf(e.id);
    await decide(logId, "accept");
    await decide(logId, "flag");
    expect(await chain(e.id, F3.flagThenReject)).toEqual([DEDUCTED, REVERSED]);
    expect(await usedOf(e.id)).toBe(deducted - 1);

    const idem = key();
    await decide(logId, "reject", idem);

    expect(await chain(e.id, F3.flagThenReject)).toEqual(DRX);
    expect(await usedOf(e.id)).toBe(deducted);
    await decide(logId, "reject", idem).catch(() => undefined);
    await run();
    expect(await chain(e.id, F3.flagThenReject)).toEqual(DRX);
    expect(await usedOf(e.id)).toBe(deducted);
    await expectChainConsistent(e.id);
  });

  it("after the rededuction the day stays deducted: a rejected log cannot be accepted (409) and even a reset log reverses nothing", async () => {
    const e = await employee();
    const logId = await writeLog(e.id, F3.stays, {
      validity: "flagged",
      review: "pending",
    });
    await run();
    const deducted = await usedOf(e.id);
    await decide(logId, "accept");
    await decide(logId, "reject");
    await expect(decide(logId, "accept")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await usedOf(e.id)).toBe(deducted);

    // Even a log put back to flagged / pending by hand and accepted again
    // cannot give the day back a second time (reversal is once per day).
    await sql(
      `UPDATE attendance_logs SET validity = 'flagged', review_status = 'pending',
              reviewed_by = NULL, reviewed_at = NULL WHERE id = $1`,
      [logId],
    );
    await decide(logId, "accept");
    await run();
    expect(await chain(e.id, F3.stays)).toEqual(DRX);
    expect(await usedOf(e.id)).toBe(deducted);
    await expectChainConsistent(e.id);
  });

  it("a second qualifying in-log on the day keeps the reversal: rejecting one log takes nothing back", async () => {
    const e = await employee();
    const first = await writeLog(e.id, F3.second, {
      validity: "flagged",
      review: "pending",
    });
    await run();
    const deducted = await usedOf(e.id);
    await decide(first, "accept");
    await writeLog(e.id, F3.second, { method: "outlet_device" });

    await decide(first, "reject");

    expect(await chain(e.id, F3.second)).toEqual([DEDUCTED, REVERSED]);
    expect(await usedOf(e.id)).toBe(deducted - 1);
    await expectChainConsistent(e.id);
  });

  it("a log rejected without ever being accepted adds no rededuction", async () => {
    const e = await employee();
    const logId = await writeLog(e.id, F3.second, {
      validity: "flagged",
      review: "pending",
    });
    await run();
    const deducted = await usedOf(e.id);
    await decide(logId, "reject");
    expect(await chain(e.id, F3.second)).toEqual([DEDUCTED]);
    expect(await usedOf(e.id)).toBe(deducted);
  });

  it("settlement: the day is not paid after the rededuction (same payout as before the accept)", async () => {
    const e = await employee();
    const logId = await writeLog(e.id, F3.settle, {
      validity: "flagged",
      review: "pending",
    });
    await run();
    // Every collective day of this file is deducted: a bigger entitlement keeps
    // the payable remainder above the zero floor so the comparison means something.
    await sql(
      `UPDATE leave_balances SET entitled_days = '40'
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = $4`,
      [tenantId, e.id, annualTypeId, YEAR],
    );
    const offboarding = await createOffboarding(tenantScope(), hr, e.id, {
      exitType: "termination",
      reason: "Akhir hubungan kerja uji.",
      lastWorkingDate: "2049-12-31",
    } as CreateOffboardingInput);
    const remaining = async () => {
      const summary = await getFinalSettlement(
        tenantScope(),
        hr,
        offboarding.id,
        NOW,
      );
      return Number(
        summary.leave.find(
          (item) =>
            item.leaveTypeId === annualTypeId && item.periodYear === YEAR,
        )!.remainingDays,
      );
    };
    const beforeAccept = await remaining();

    await decide(logId, "accept");
    expect(await remaining()).toBe(beforeAccept + 1);
    await decide(logId, "reject");

    expect(await remaining()).toBe(beforeAccept);
    expect(beforeAccept).toBe(40 - (await usedOf(e.id)));
    expect(beforeAccept).toBeLessThanOrEqual(40);
  });

  it("closed year (carry-over ran after the reversal): used +1 in the day's year and the next year's carry loses the day", async () => {
    const e = await employee();
    const logId = await writeLog(e.id, F3.closed, {
      validity: "flagged",
      review: "pending",
    });
    await run();
    const deducted = await usedOf(e.id);
    await decide(logId, "accept");
    expect(await usedOf(e.id)).toBe(deducted - 1);
    // Carry-over of 2049 into 2050 ran after the day was given back: 3 days.
    // The carry is min(remaining, cap): remaining was exactly 3 then, so the
    // given-back day really sat inside the carry (legend-esjkw: a day the cap
    // kept out of the carry is not cut again).
    await sql(
      `UPDATE leave_balances
          SET entitled_days = used_days + pending_days + 3 - carried_over_days
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
          AND period_year = $4`,
      [tenantId, e.id, annualTypeId, YEAR],
    );
    await sql(
      `INSERT INTO leave_accruals (tenant_id, employee_id, leave_type_id, kind, period, days)
       VALUES ($1, $2, $3, 'carry_over', '2050', '3')`,
      [tenantId, e.id, annualTypeId],
    );
    await sql(
      `INSERT INTO leave_balances
         (tenant_id, employee_id, leave_type_id, period_year, entitled_days, carried_over_days)
       VALUES ($1, $2, $3, 2050, '12', '3')`,
      [tenantId, e.id, annualTypeId],
    );
    const carryOf = async () =>
      Number(
        (
          await sql<{ c: string }>(
            `SELECT carried_over_days::text AS c FROM leave_balances
              WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
                AND period_year = 2050`,
            [tenantId, e.id, annualTypeId],
          )
        )[0]!.c,
      );

    await decide(logId, "reject");

    expect(await chain(e.id, F3.closed)).toEqual(DRX);
    expect(await usedOf(e.id)).toBe(deducted);
    expect(await carryOf()).toBe(2);
    await run();
    await decide(logId, "reject").catch(() => undefined);
    expect(await carryOf()).toBe(2);
    expect(await usedOf(e.id)).toBe(deducted);
  });
});

describe("F3: the review refuses a log that changed employee between the read and the row lock", () => {
  it("409 ATTENDANCE_REVIEW_CHANGED, nothing changes", async () => {
    const e = await employee();
    const other = await employee();
    const logId = await writeLog(e.id, F3.reject, {
      validity: "flagged",
      review: "pending",
    });
    const a = await owner.connect();
    let b: Promise<unknown> = Promise.resolve();
    try {
      await a.query("BEGIN");
      await a.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      const { rows: pidRows } = await a.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const aPid = pidRows[0]!.pid;
      // A holds the log row; B reads the log, takes the employee lock, then
      // waits for the row lock.
      await a.query(
        "UPDATE attendance_logs SET employee_id = $2 WHERE id = $1",
        [logId, other.id],
      );
      b = decide(logId, "reject");
      b.catch(() => undefined);
      const deadline = Date.now() + 15_000;
      for (;;) {
        const { rows } = await owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND wait_event = 'transactionid'
              AND $1::int = ANY(pg_blocking_pids(pid))
              AND query ILIKE '%attendance_logs%'`,
          [aPid],
        );
        if (rows[0]!.n > 0 || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await a.query("COMMIT").catch(() => undefined);
      a.release();
    }
    await expect(b).rejects.toMatchObject({
      status: 409,
      code: "ATTENDANCE_REVIEW_CHANGED",
    });
    const [log] = await sql<{ validity: string; review_status: string }>(
      "SELECT validity, review_status FROM attendance_logs WHERE id = $1",
      [logId],
    );
    expect(log).toMatchObject({
      validity: "flagged",
      review_status: "pending",
    });
  });
});

// ---- fix F4 (tier K, money): the daily job read "worked" before the employee
// lock; a log rejected in between must not be given back as a reversal.

const F4 = { rejected: "2049-05-12", accepted: "2049-05-13" } as const;

describe("F4: the daily run re-reads the log under the employee lock", () => {
  const lockName = (employeeId: string) =>
    `hris:leave-attendance:${tenantId}:${employeeId.toLowerCase()}`;
  const waitersOn = async (employeeId: string): Promise<number> => {
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
      [lockName(employeeId)],
    );
    return rows[0]!.n;
  };

  /**
   * Deducted day D (log flagged/pending at deduction), then the log becomes
   * qualifying (valid). Tx A takes the employee lock and, when `rejectIt`,
   * rejects the log without committing. The daily run (B) reads the log as
   * qualifying, then queues on the employee lock; A commits; B finishes.
   */
  async function raceJobAgainstReview(date: string, rejectIt: boolean) {
    await sql(
      `INSERT INTO holidays (tenant_id, outlet_id, date, name, type)
       VALUES ($1, $2, $3, $4, 'collective')
       ON CONFLICT DO NOTHING`,
      [tenantId, outletA, date, `CBREV collective ${date}`],
    );
    const e = await employee();
    const logId = await writeLog(e.id, date, {
      validity: "flagged",
      review: "pending",
    });
    await run();
    expect(await ledger(e.id, date)).toEqual([DEDUCTED]);
    const used = await usedOf(e.id);
    // Qualifying at the job's read time (route outside the review hook).
    await sql(
      `UPDATE attendance_logs SET validity = 'valid', review_status = 'none',
              reviewed_by = NULL, reviewed_at = NULL WHERE id = $1`,
      [logId],
    );

    const a = await owner.connect();
    let finished = false;
    let b: Promise<unknown> = Promise.resolve();
    try {
      await a.query("BEGIN");
      await a.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      await a.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        lockName(e.id),
      ]);
      if (rejectIt)
        await a.query(
          `UPDATE attendance_logs SET validity = 'rejected', review_status = 'rejected',
                  reviewed_by = 'reviewer', reviewed_at = now() WHERE id = $1`,
          [logId],
        );
      b = run().finally(() => {
        finished = true;
      });
      b.catch(() => undefined);
      const deadline = Date.now() + 15_000;
      while (!finished && (await waitersOn(e.id)) === 0) {
        if (Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(finished, "the run must wait for the employee lock").toBe(false);
      expect(await waitersOn(e.id)).toBeGreaterThan(0);
    } finally {
      await a.query("COMMIT").catch(() => undefined);
      a.release();
    }
    await b;
    return { e, used };
  }

  it("log rejected while the run waits for the lock: no reversal, used unchanged", async () => {
    const { e, used } = await raceJobAgainstReview(F4.rejected, true);
    expect(await ledger(e.id, F4.rejected)).toEqual([DEDUCTED]);
    expect(await usedOf(e.id)).toBe(used);
    await expectBalanceConsistent(e.id);
  });

  it("control: log still accepted after the wait: reversed once", async () => {
    const { e, used } = await raceJobAgainstReview(F4.accepted, false);
    expect(await ledger(e.id, F4.accepted)).toEqual([DEDUCTED, REVERSED]);
    expect(await usedOf(e.id)).toBe(used - 1);
    await run();
    expect(await ledger(e.id, F4.accepted)).toEqual([DEDUCTED, REVERSED]);
    await expectBalanceConsistent(e.id);
  });
});
