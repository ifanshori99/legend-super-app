// Alur K (payroll bulanan) and cuti, told as stories from docs/PRD.md
// (WS-13, brief 91, potongan 5). Expected behaviour comes from the PRD, not
// from what the code happens to do: Kelompok D "29. Cuti, Izin & Lembur",
// "30. Payroll", Alur K (§4), and the criteria HR-01, HR-03, PAYR-01..05.
//
// Two stories:
//  1. Cuti (runs today): an employee asks for leave, HR decides, the balance
//     follows. Uses the real Express app, Better Auth and PostgreSQL.
//  2. Payroll (PENDING-BRANCH): HR simulates the run, HR then Finance approve,
//     the run is locked, a balanced journal / payslips / bank file appear, the
//     employee opens the payslip with a PIN, a second run is reversed.
//     The run, approval, lock, payslip and bank-file routes are not in
//     milestone/m1 yet (only the shared contract is). Endpoint paths and bodies
//     below follow packages/shared/src/hris/payroll/endpoints.ts.
//
// Assumptions (the PRD leaves these open):
//  - Leave approval: the PRD says "rantai approval sesuai matriks" and gives
//    the HR template role "cuti" in its remit. The fixture tenant has no
//    approval-matrix row for leave, so this story seeds one level whose
//    approver is the HR template role (as brief 91 asks: HR approves/rejects).
//  - A request that exceeds the balance is refused with 409; an invalid or
//    reversed date range with 422 (same as the contract tests for leave).
//  - Payroll: cut-off and pay day come from the payroll policy; the run period
//    is derived from `referenceDate` (contract comment). Run totals include
//    every employee the policy covers, so the story asserts internal
//    consistency of totals plus the figures of its own employee.
//  - Payroll: a "lock before both approvals" attempt is refused with 409
//    (either PAYROLL_RUN_NOT_APPROVED or PAYROLL_RUN_INVALID_TRANSITION).
//  - Payroll: the contract has no endpoint to set an employee's payslip PIN, so
//    the story checks that amounts are hidden before the PIN and that a wrong
//    PIN is refused (403 PAYSLIP_PIN_INVALID), not the success path.
//  - Payroll: the fixture legal entity (cafeLegendPayrollFixtures.legalEntityId)
//    is the tenant's entity for the payroll journal.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { FakeObjectStorage } from "@starter/shared/adapters";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  cafeLegendPayrollFixtures,
  payrollRunIdSchema,
} from "@starter/shared/hris/payroll";
import { createApp } from "../../app.ts";
import { NoopMalwareScanner } from "../../services/core-image.ts";
import type { StorageRuntime } from "../../services/core-storage-runtime.ts";
import { createBankTransferFile } from "../../services/payroll-export.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "../helpers.ts";
import { describeUntilBuilt } from "./pending-branch.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outlet] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdRunIds: string[] = [];
const SUFFIX = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
const LEAVE_CODE = `AZK${SUFFIX}`;
let savedLeavePolicies: Record<string, unknown>[] = [];

type Client = ReturnType<typeof agent>;

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
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

async function signedInClient(name: string, options: { mfa?: boolean } = {}) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  if (options.mfa) await verifySessionMfa(email);
  return { client, userId };
}

type Scope = { type: "tenant" } | { type: "outlet"; id: string };

async function assign(
  db: PoolClient,
  userId: string,
  roleId: string,
  scope: Scope,
) {
  await db.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [
      tenant.id,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
}

async function grantCustomRole(
  userId: string,
  permissions: string[],
  scope: Scope,
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Alur K ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await assign(db, userId, roleId, scope);
  });
}

async function templateRoleId(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenant.id, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function grantTemplateRole(
  userId: string,
  templateKey: string,
  scope: Scope,
) {
  const roleId = await templateRoleId(templateKey);
  await asTenant((db) => assign(db, userId, roleId, scope));
}

async function seedEmployee(input: {
  userId: string | null;
  outletId: string;
  name: string;
}) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenant.id,
        input.userId,
        `AZK-${id.slice(0, 8).toUpperCase()}`,
        input.name,
        input.outletId,
      ],
    ),
  );
  return id;
}

const key = () => `az-k-${randomUUID()}`;
const post = (client: Client, path: string, body: unknown = {}) =>
  client
    .post(path)
    .set(originHeader)
    .send(body as object);
const put = (client: Client, path: string, body: unknown) =>
  client
    .put(path)
    .set(originHeader)
    .send(body as object);

let hrClient: Client;
let hrUserId: string;
let staffClient: Client;
let otherStaffClient: Client;
let managerAClient: Client;
let ownEmployee: string;

beforeAll(async () => {
  // Alur cuti: one approval level, approver = the HR role (see assumptions).
  savedLeavePolicies = (
    await owner.query(
      `SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'`,
      [tenant.id],
    )
  ).rows;
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'`,
    [tenant.id],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'leave', NULL, $2, 1)`,
    [tenant.id, await templateRoleId("hr")],
  );

  const hr = await signedInClient("HR Alur K", { mfa: true });
  await grantTemplateRole(hr.userId, "hr", { type: "tenant" });
  hrClient = hr.client;
  hrUserId = hr.userId;

  const staff = await signedInClient("Karyawan Alur K");
  await grantCustomRole(
    staff.userId,
    ["self.profile.view", "self.leave.request", "self.payslip.view"],
    { type: "outlet", id: outlet.id },
  );
  staffClient = staff.client;

  const otherStaff = await signedInClient("Karyawan Lain Alur K");
  await grantCustomRole(
    otherStaff.userId,
    ["self.profile.view", "self.leave.request", "self.payslip.view"],
    { type: "outlet", id: outlet.id },
  );
  otherStaffClient = otherStaff.client;

  const managerA = await signedInClient("Manajer Alur K", { mfa: true });
  await grantTemplateRole(managerA.userId, "outlet_manager", {
    type: "outlet",
    id: outlet.id,
  });
  managerAClient = managerA.client;

  ownEmployee = await seedEmployee({
    userId: staff.userId,
    outletId: outlet.id,
    name: "Karyawan Alur K",
  });
  await seedEmployee({
    userId: otherStaff.userId,
    outletId: outlet.id,
    name: "Karyawan Lain Alur K",
  });
});

afterAll(async () => {
  // Payroll rows first (best effort: those tables exist only once the payroll
  // branch is merged; locked runs may be immutable and are then left behind,
  // keyed by this file's unique employees).
  for (const statement of [
    "DELETE FROM payslips WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
    "DELETE FROM employee_pay_components WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
  ])
    await owner.query(statement, [tenant.id, createdEmployees]).catch(() => {});
  await asTenant(async (db) => {
    const types = `SELECT id FROM leave_types WHERE tenant_id = $1 AND code = $2`;
    await db.query(
      `DELETE FROM leave_requests WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])`,
      [tenant.id, createdEmployees],
    );
    await db.query(
      `DELETE FROM leave_requests WHERE tenant_id = $1 AND leave_type_id IN (${types})`,
      [tenant.id, LEAVE_CODE],
    );
    await db.query(
      `DELETE FROM leave_balances WHERE tenant_id = $1 AND leave_type_id IN (${types})`,
      [tenant.id, LEAVE_CODE],
    );
    await db.query(
      `DELETE FROM leave_accruals WHERE tenant_id = $1 AND leave_type_id IN (${types})`,
      [tenant.id, LEAVE_CODE],
    );
    await db.query(
      `DELETE FROM leave_types WHERE tenant_id = $1 AND code = $2`,
      [tenant.id, LEAVE_CODE],
    );
    await db.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'az-k-%'",
      [tenant.id],
    );
    await db.query(
      `DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])`,
      [tenant.id, createdUsers],
    );
    await db.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await db.query(
      `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'`,
      [tenant.id],
    );
    for (const row of savedLeavePolicies)
      await db.query(
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
    await db.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await db.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdRoles],
    );
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  await owner.end();
});

// ---------------------------------------------------------------------------
// Story 1: cuti
// ---------------------------------------------------------------------------

const YEAR = 2034;
let leaveTypeId: string;
let approvedRequestId: string;

const leaveBody = (overrides: Record<string, unknown> = {}) => ({
  leaveTypeId,
  startDate: `${YEAR}-03-13`,
  endDate: `${YEAR}-03-15`,
  reason: "Acara keluarga",
  attachmentUploadRef: null,
  idempotencyKey: key(),
  ...overrides,
});

async function balance(client: Client) {
  const response = await client.get(
    `/api/hris/leave/balances?employeeId=${ownEmployee}&year=${YEAR}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data.find(
    (row: { leaveTypeId: string }) => row.leaveTypeId === leaveTypeId,
  ) as { entitledDays: string; usedDays: string; pendingDays: string };
}

describe("Alur K cuti: karyawan mengajukan, HR memutuskan, saldo mengikuti [HR-01]", () => {
  it("HR sets up an annual leave type with 12 days and the accrual gives the employee a balance", async () => {
    const created = await post(hrClient, "/api/hris/leave/types", {
      code: LEAVE_CODE,
      name: "Cuti tahunan Alur K",
      paid: true,
      requiresAttachment: false,
      policy: {
        annualDays: "12.0000",
        carryOverMaxDays: "0.0000",
        carryOverExpiryMonths: 3,
        tracksBalance: true,
        accrual: "upfront",
        negativeAllowanceDays: "0.0000",
      },
      idempotencyKey: key(),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    leaveTypeId = created.body.data.id;

    const accrual = await post(hrClient, "/api/hris/leave/accruals/run", {
      period: `${YEAR}-01`,
    });
    expect(accrual.status, JSON.stringify(accrual.body)).toBeLessThan(300);

    // The employee sees their own balance on their phone.
    const own = await staffClient.get(`/api/hris/leave/balances?year=${YEAR}`);
    expect(own.status).toBe(200);
    const mine = own.body.data.find(
      (row: { leaveTypeId: string }) => row.leaveTypeId === leaveTypeId,
    );
    expect(mine).toMatchObject({
      employeeId: ownEmployee,
      entitledDays: "12.0000",
      usedDays: "0.0000",
      pendingDays: "0.0000",
    });
  });

  it("the employee asks for 3 days: the request waits and the days are held as pending", async () => {
    const created = await post(
      staffClient,
      "/api/hris/leave/requests",
      leaveBody(),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      employeeId: ownEmployee,
      leaveTypeId,
      days: "3.0000",
      status: "pending",
      decidedBy: null,
    });
    approvedRequestId = created.body.data.id;
    expect(await balance(hrClient)).toMatchObject({
      entitledDays: "12.0000",
      pendingDays: "3.0000",
      usedDays: "0.0000",
    });
  });

  it("only the matrix approver decides: the employee, a colleague and an outlet manager cannot approve", async () => {
    const path = `/api/hris/leave/requests/${approvedRequestId}/decision`;
    const decision = { action: "approve" };
    expect(
      (await post(staffClient, path, { ...decision, idempotencyKey: key() }))
        .status,
    ).toBe(403);
    expect([403, 404]).toContain(
      (
        await post(otherStaffClient, path, {
          ...decision,
          idempotencyKey: key(),
        })
      ).status,
    );
    expect([403, 404]).toContain(
      (await post(managerAClient, path, { ...decision, idempotencyKey: key() }))
        .status,
    );
    // Still pending: nothing was consumed.
    expect(await balance(hrClient)).toMatchObject({
      pendingDays: "3.0000",
      usedDays: "0.0000",
    });
  });

  it("HR approves: pending days become used days and the employee sees the approved request", async () => {
    const approved = await post(
      hrClient,
      `/api/hris/leave/requests/${approvedRequestId}/decision`,
      { action: "approve", idempotencyKey: key() },
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({
      id: approvedRequestId,
      status: "approved",
      decidedBy: hrUserId,
    });
    expect(approved.body.data.decidedAt).not.toBeNull();
    expect(await balance(staffClient)).toMatchObject({
      entitledDays: "12.0000",
      usedDays: "3.0000",
      pendingDays: "0.0000",
    });

    const mine = await staffClient.get(
      `/api/hris/leave/requests?status=approved&limit=100`,
    );
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((row: { id: string }) => row.id)).toContain(
      approvedRequestId,
    );
  });

  it("HR rejects a second request: the held days return to the balance", async () => {
    const created = await post(
      staffClient,
      "/api/hris/leave/requests",
      leaveBody({ startDate: `${YEAR}-06-05`, endDate: `${YEAR}-06-06` }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.days).toBe("2.0000");
    expect((await balance(hrClient)).pendingDays).toBe("2.0000");

    const rejected = await post(
      hrClient,
      `/api/hris/leave/requests/${created.body.data.id}/decision`,
      {
        action: "reject",
        rejectionReason: "Jadwal penuh",
        idempotencyKey: key(),
      },
    );
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.data).toMatchObject({
      status: "rejected",
      decidedBy: hrUserId,
    });
    expect(await balance(hrClient)).toMatchObject({
      usedDays: "3.0000",
      pendingDays: "0.0000",
    });
  });

  it("a decided request cannot be decided the other way (409)", async () => {
    const again = await post(
      hrClient,
      `/api/hris/leave/requests/${approvedRequestId}/decision`,
      {
        action: "reject",
        rejectionReason: "Jadwal penuh",
        idempotencyKey: key(),
      },
    );
    expect(again.status).toBe(409);
  });

  it("errors: more days than the balance, overlapping dates and a backwards range are refused and hold nothing", async () => {
    // 12 entitled, 3 used: 10 more days do not fit.
    const tooMany = await post(
      staffClient,
      "/api/hris/leave/requests",
      leaveBody({ startDate: `${YEAR}-08-07`, endDate: `${YEAR}-08-18` }),
    );
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe("INSUFFICIENT_LEAVE_BALANCE");

    const overlap = await post(
      staffClient,
      "/api/hris/leave/requests",
      leaveBody({ startDate: `${YEAR}-03-14`, endDate: `${YEAR}-03-16` }),
    );
    expect(overlap.status, JSON.stringify(overlap.body)).toBe(409);
    expect(overlap.body.error.code).toBe("LEAVE_OVERLAP");

    const backwards = await post(
      staffClient,
      "/api/hris/leave/requests",
      leaveBody({ startDate: `${YEAR}-04-05`, endDate: `${YEAR}-04-01` }),
    );
    expect(backwards.status, JSON.stringify(backwards.body)).toBe(422);
    expect(backwards.body.error.code).toBe("VALIDATION_ERROR");

    expect(await balance(hrClient)).toMatchObject({
      usedDays: "3.0000",
      pendingDays: "0.0000",
    });
  });

  it("the employee cancels an approved future leave and gets the days back", async () => {
    const cancelled = await post(
      staffClient,
      `/api/hris/leave/requests/${approvedRequestId}/decision`,
      { action: "cancel", idempotencyKey: key() },
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.status).toBe("cancelled");
    expect(await balance(hrClient)).toMatchObject({
      usedDays: "0.0000",
      pendingDays: "0.0000",
    });
  });

  it("[HR-01] an employee sees only their own balance and requests; a year without balances is an empty list", async () => {
    const other = await otherStaffClient.get(
      "/api/hris/leave/requests?limit=100",
    );
    expect(other.status).toBe(200);
    expect(other.body.data).toEqual([]);

    // The colleague cannot read the first employee's balance by asking for it.
    const peek = await otherStaffClient.get(
      `/api/hris/leave/balances?employeeId=${ownEmployee}&year=${YEAR}`,
    );
    // Own-rows filter: the colleague gets an empty list, never the balance.
    expect(peek.status, JSON.stringify(peek.body)).toBe(200);
    expect(peek.body.data).toEqual([]);

    const empty = await staffClient.get("/api/hris/leave/balances?year=2041");
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual([]);

    const anonymous = await agent(app).get("/api/hris/leave/requests");
    expect(anonymous.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Story 2: payroll bulanan (Alur K)
// ---------------------------------------------------------------------------

const PAYROLL = "/api/hris/payroll";
const BASE_SALARY_IDR = 6_000_000;
// Business dates are Asia/Jakarta calendar days, not the UTC date.
const jakartaDate = (at: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(at);
const today = jakartaDate(new Date());
const tomorrow = jakartaDate(new Date(Date.now() + 86_400_000));

describeUntilBuilt(
  "legend-07eg (PPh21 engine: ws/payroll-pph21-tests)",
  "Alur K payroll bulanan: simulasi, dua approval, kunci, jurnal, slip, pembatalan [PAYR-01][PAYR-02][PAYR-03][PAYR-04][PAYR-05][HR-01][HR-03]",
  () => {
    let financeClient: Client;
    let financeUserId: string;
    let policyId: string;
    let baseSalaryComponentId: string;
    let runId: string;
    let lockedTotals: Record<string, number>;
    let lockedSnapshot: unknown;

    const run = (id: string, action: string, body: object = {}) =>
      post(hrClient, `${PAYROLL}/runs/${id}/${action}`, {
        ...body,
        idempotencyKey: key(),
      });

    async function createRun(referenceDate: string) {
      const created = await post(hrClient, `${PAYROLL}/runs`, {
        payrollPolicyId: policyId,
        runType: "regular",
        referenceDate,
        thrScheduleId: null,
        idempotencyKey: key(),
      });
      expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
      createdRunIds.push(created.body.data.id);
      return created.body.data as { id: string; status: string };
    }

    // Brings a new run through simulation and both approvals to "locked".
    async function lockedRun(referenceDate: string) {
      const draft = await createRun(referenceDate);
      for (const [client, action] of [
        [hrClient, "simulate"],
        [hrClient, "hr-approval"],
        [financeClient, "final-approval"],
        [financeClient, "lock"],
      ] as const) {
        const step = await post(
          client,
          `${PAYROLL}/runs/${draft.id}/${action}`,
          { idempotencyKey: key() },
        );
        expect(step.status, `${action}: ${JSON.stringify(step.body)}`).toBe(
          200,
        );
      }
      return draft.id;
    }

    const journalsOf = async (sourceId: string) => {
      const list = await hrClient.get(
        `/api/accounting/journals?legalEntityId=${cafeLegendPayrollFixtures.legalEntityId}` +
          `&from=2000-01-01&to=2099-12-31&sourceType=payroll&limit=100`,
      );
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      return (
        list.body.data as { id: string; sourceId: string; totalIdr: number }[]
      ).filter((entry) => entry.sourceId === sourceId);
    };

    beforeAll(async () => {
      // HR: runs and edits payroll; also holds payroll.approve like the PRD HR
      // template, so the "different second approver" rule is really tested.
      await grantCustomRole(
        hrUserId,
        ["payroll.view", "payroll.run", "payroll.approve", "hr.employee.view"],
        { type: "tenant" },
      );
      // Finance: second approval, lock, reversal decision.
      const finance = await signedInClient("Finance Alur K", { mfa: true });
      await grantCustomRole(
        finance.userId,
        [
          "payroll.view",
          "payroll.approve",
          "payroll.lock",
          "payroll.cancel.approve",
          "approval.request.decide",
        ],
        { type: "tenant" },
      );
      financeClient = finance.client;
      financeUserId = finance.userId;

      // Rates in force: publish a table version for every type that has none.
      const existing = await hrClient.get(
        `${PAYROLL}/statutory-tables?limit=100`,
      );
      expect(existing.status, JSON.stringify(existing.body)).toBe(200);
      const haveType = new Set(
        (existing.body.data as { type: string; status: string }[])
          .filter((row) => row.status === "published")
          .map((row) => row.type),
      );
      for (const table of cafeLegendPayrollFixtures.statutoryTables) {
        if (haveType.has(table.type)) continue;
        const draft = await post(hrClient, `${PAYROLL}/statutory-tables`, {
          draft: { type: table.type, parameters: table.parameters },
          effectiveFrom: today,
          legalBasis: table.legalBasis,
          idempotencyKey: key(),
        });
        expect(draft.status, JSON.stringify(draft.body)).toBeLessThan(300);
        const published = await post(
          hrClient,
          `${PAYROLL}/statutory-tables/${draft.body.data.id}/publish`,
          { idempotencyKey: key() },
        );
        expect(published.status).toBeLessThan(300);
      }

      const policies = await hrClient.get(`${PAYROLL}/policies?limit=100`);
      expect(policies.status).toBe(200);
      const monthly = (
        policies.body.data as {
          id: string;
          isActive: boolean;
          cycle: { frequency: string };
        }[]
      ).find((p) => p.isActive && p.cycle.frequency === "monthly");
      if (monthly) policyId = monthly.id;
      else {
        const fixture = cafeLegendPayrollFixtures.payrollPolicies[0]!;
        const created = await post(hrClient, `${PAYROLL}/policies`, {
          legalEntityId: fixture.legalEntityId,
          name: `Payroll Alur K ${SUFFIX}`,
          employeeGroup: fixture.employeeGroup,
          cycle: fixture.cycle,
          payDateAdjustment: fixture.payDateAdjustment,
          jkkRiskClass: fixture.jkkRiskClass,
          bpjsProgrammes: fixture.bpjsProgrammes,
          idempotencyKey: key(),
        });
        expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
        policyId = created.body.data.id;
      }

      const components = await hrClient.get(`${PAYROLL}/components?limit=100`);
      expect(components.status).toBe(200);
      const base = (
        components.body.data as { id: string; category: string }[]
      ).find((c) => c.category === "base_salary");
      expect(base, "tenant has a base salary component").toBeDefined();
      baseSalaryComponentId = base!.id;

      const salary = await put(
        hrClient,
        `${PAYROLL}/employees/${ownEmployee}/components`,
        {
          componentId: baseSalaryComponentId,
          amountIdr: BASE_SALARY_IDR,
          effectiveFrom: "2025-03-01",
          idempotencyKey: key(),
        },
      );
      expect(salary.status, JSON.stringify(salary.body)).toBeLessThan(300);
    });

    it("[PAYR-01] HR creates the run and simulates it twice: same result, no payslip, no journal", async () => {
      const draft = await createRun("2034-02-10");
      runId = draft.id;
      expect(draft.status).toBe("draft");

      const first = await run(runId, "simulate");
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.data).toMatchObject({
        status: "simulated",
        simulationCount: 1,
      });
      const second = await run(runId, "simulate");
      expect(second.status).toBe(200);
      expect(second.body.data.simulationCount).toBe(2);
      expect(second.body.data.totals).toEqual(first.body.data.totals);

      // Simulation has no side effect.
      const slips = await hrClient.get(`${PAYROLL}/runs/${runId}/payslips`);
      expect(slips.status).toBe(200);
      expect(slips.body.data).toEqual([]);
      expect(await journalsOf(runId)).toEqual([]);
    });

    it("HR reviews the run per employee: the employee's own gross, deductions and net add up", async () => {
      const review = await hrClient.get(
        `${PAYROLL}/runs/${runId}/employees?limit=100`,
      );
      expect(review.status, JSON.stringify(review.body)).toBe(200);
      const row = (
        review.body.data as {
          employeeId: string;
          grossIdr: number;
          deductionsIdr: number;
          netIdr: number;
          netChangeIdr: number | null;
        }[]
      ).find((r) => r.employeeId === ownEmployee);
      expect(row, "the employee is part of the simulated run").toBeDefined();
      expect(row!.grossIdr).toBe(BASE_SALARY_IDR);
      expect(row!.netIdr).toBe(row!.grossIdr - row!.deductionsIdr);
    });

    it("[PAYR-03] spot check: the monthly PPh 21 withheld for the employee follows the TER rate on the taxable gross", async () => {
      // Not the 30-case reference suite (payroll-pph21-ter.test.ts); a guard
      // that the figure on the review row is the rate applied to the base.
      // Assumption: rounding to whole rupiah, so we allow 1 rupiah.
      const review = await hrClient.get(
        `${PAYROLL}/runs/${runId}/employees?limit=100`,
      );
      const row = (
        review.body.data as {
          employeeId: string;
          tax: {
            method: string;
            terRateBp: number | null;
            taxableGrossIdr: number;
            pph21WithheldIdr: number;
          };
        }[]
      ).find((r) => r.employeeId === ownEmployee)!;
      expect(row.tax.method).toBe("ter");
      expect(row.tax.terRateBp).not.toBeNull();
      const expected = Math.round(
        (row.tax.taxableGrossIdr * (row.tax.terRateBp as number)) / 10_000,
      );
      expect(Math.abs(row.tax.pph21WithheldIdr - expected)).toBeLessThanOrEqual(
        1,
      );
    });

    it("[PAYR-01] a run cannot be locked before both approvals, and employees cannot touch payroll [HR-03]", async () => {
      const early = await post(financeClient, `${PAYROLL}/runs/${runId}/lock`, {
        idempotencyKey: key(),
      });
      expect(early.status).toBe(409);

      // HR-03: salary and run data are for payroll roles only.
      const denied = [
        await staffClient.get(`${PAYROLL}/runs`),
        await managerAClient.get(`${PAYROLL}/runs`),
        await staffClient.get(`${PAYROLL}/employees/${ownEmployee}/components`),
        await post(staffClient, `${PAYROLL}/runs/${runId}/hr-approval`, {
          idempotencyKey: key(),
        }),
      ];
      for (const response of denied) {
        expect(response.status, JSON.stringify(response.body)).toBe(403);
        expect(response.body.error.code).toBe("FORBIDDEN");
      }
      expect((await agent(app).get(`${PAYROLL}/runs`)).status).toBe(401);
    });

    it("[PAYR-01] HR approves first; the same person cannot give the second approval; Finance can", async () => {
      const hrApproval = await run(runId, "hr-approval");
      expect(hrApproval.status, JSON.stringify(hrApproval.body)).toBe(200);
      expect(hrApproval.body.data).toMatchObject({
        status: "hr_approved",
        approvedByHr: hrUserId,
      });

      const sameUser = await run(runId, "final-approval");
      expect(sameUser.status).toBe(403);
      expect(sameUser.body.error.code).toBe("PAYROLL_APPROVER_NOT_DISTINCT");

      const finance = await post(
        financeClient,
        `${PAYROLL}/runs/${runId}/final-approval`,
        { idempotencyKey: key() },
      );
      expect(finance.status, JSON.stringify(finance.body)).toBe(200);
      expect(finance.body.data.status).toBe("approved");
      expect(finance.body.data.approvedByFinance).not.toBe(hrUserId);
    });

    it("[PAYR-01] only a locker locks: HR (no lock permission) is refused, Finance locks", async () => {
      const refused = await run(runId, "lock");
      expect(refused.status).toBe(403);

      const locked = await post(
        financeClient,
        `${PAYROLL}/runs/${runId}/lock`,
        {
          idempotencyKey: key(),
        },
      );
      expect(locked.status, JSON.stringify(locked.body)).toBe(200);
      expect(locked.body.data.status).toBe("locked");
      expect(locked.body.data.lockedAt).not.toBeNull();
      expect(locked.body.data.configSnapshot).not.toBeNull();
      lockedTotals = locked.body.data.totals;
      lockedSnapshot = locked.body.data.configSnapshot;
    });

    it("a locked run is frozen: it cannot be simulated or sent back to draft (409)", async () => {
      const resimulate = await run(runId, "simulate");
      expect(resimulate.status).toBe(409);
      const back = await run(runId, "return-to-draft", { reason: "Salah" });
      expect(back.status).toBe(409);
    });

    it("[PAYR-04] locking posts one balanced payroll journal that matches the run totals", async () => {
      const entries = await journalsOf(runId);
      expect(entries).toHaveLength(1);
      const detail = await hrClient.get(
        `/api/accounting/journals/${entries[0]!.id}`,
      );
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      const lines = detail.body.data.entry.lines as {
        debitIdr: number;
        creditIdr: number;
      }[];
      const debit = lines.reduce((sum, l) => sum + l.debitIdr, 0);
      const credit = lines.reduce((sum, l) => sum + l.creditIdr, 0);
      expect(debit).toBe(credit);
      // Salary expense = gross pay + the employer's BPJS (PRD "Jurnal Payroll":
      // biaya gaji, utang gaji, utang BPJS, utang PPh 21).
      expect(debit).toBe(lockedTotals.grossIdr! + lockedTotals.bpjsCompanyIdr!);
    });

    it("[PAYR-04] the bank transfer file holds the bank payslips and its total equals the net pay", async () => {
      // The legacy POST route is closed (legend-yjbjb); the file builder is
      // exercised directly with the same permission holder.
      const refused = await post(
        financeClient,
        `${PAYROLL}/runs/${runId}/bank-transfer-files`,
        { format: "generic_csv", idempotencyKey: key() },
      );
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error.code).toBe("LEGACY_BANK_EXPORT_DISABLED");

      const storageRuntime: StorageRuntime = {
        storage: new FakeObjectStorage(),
        scanner: new NoopMalwareScanner(),
        fileSigner: async () => null,
        hrisDocumentSigner: async () => null,
      };
      const file = await createBankTransferFile(
        establishScopedTenantContext(
          establishTenantContext({
            tenantId: tenant.id,
            brandId: null,
            source: "session",
          }),
          { kind: "tenant" },
        ),
        financeUserId,
        payrollRunIdSchema.parse(runId),
        { format: "generic_csv", idempotencyKey: key() },
        storageRuntime,
      );
      expect(file.totalIdr).toBe(lockedTotals.bankTransferIdr);
      expect(file.rowCount).toBeGreaterThanOrEqual(1);
      expect(lockedTotals.netIdr).toBe(
        lockedTotals.bankTransferIdr! + lockedTotals.cashIdr!,
      );
      expect(file.fileUrl).toMatch(/^https?:\/\//);
    });

    it("the employee finds the payslip in the app, sees no amounts before the PIN, and a wrong PIN is refused [HR-01]", async () => {
      const mine = await staffClient.get("/api/hris/me/payslips");
      expect(mine.status, JSON.stringify(mine.body)).toBe(200);
      const slip = (
        mine.body.data as { id: string; payrollRunId: string }[]
      ).find((s) => s.payrollRunId === runId);
      expect(slip, "own payslip is listed").toBeDefined();
      expect(JSON.stringify(slip)).not.toMatch(/netIdr|grossIdr/);

      const wrongPin = await post(
        staffClient,
        `/api/hris/me/payslips/${slip!.id}/view`,
        { pin: "000000", idempotencyKey: key() },
      );
      expect(wrongPin.status).toBe(403);
      expect(wrongPin.body.error.code).toBe("PAYSLIP_PIN_INVALID");

      // The colleague sees none of it and cannot open the slip.
      const colleague = await otherStaffClient.get("/api/hris/me/payslips");
      expect(colleague.status).toBe(200);
      expect(
        (colleague.body.data as { id: string }[]).map((s) => s.id),
      ).not.toContain(slip!.id);
      const stolen = await post(
        otherStaffClient,
        `/api/hris/me/payslips/${slip!.id}/view`,
        { pin: "000000", idempotencyKey: key() },
      );
      expect([403, 404]).toContain(stolen.status);
    });

    it("[PAYR-02] publishing a new rate version afterwards does not change the locked run", async () => {
      const tables = await hrClient.get(
        `${PAYROLL}/statutory-tables?type=jht&limit=100`,
      );
      expect(tables.status).toBe(200);
      const current = (
        tables.body.data as {
          status: string;
          parameters: unknown;
          legalBasis: string;
        }[]
      ).find((t) => t.status === "published")!;
      const draft = await post(hrClient, `${PAYROLL}/statutory-tables`, {
        draft: { type: "jht", parameters: current.parameters },
        effectiveFrom: tomorrow,
        legalBasis: current.legalBasis,
        idempotencyKey: key(),
      });
      expect(draft.status, JSON.stringify(draft.body)).toBeLessThan(300);
      const published = await post(
        hrClient,
        `${PAYROLL}/statutory-tables/${draft.body.data.id}/publish`,
        { idempotencyKey: key() },
      );
      expect(published.status).toBeLessThan(300);

      const after = await hrClient.get(`${PAYROLL}/runs/${runId}`);
      expect(after.status).toBe(200);
      expect(after.body.data.totals).toEqual(lockedTotals);
      expect(after.body.data.configSnapshot).toEqual(lockedSnapshot);
    });

    it("Finance marks the run as paid after the bank transfer (Alur K.5), and a paid run can no longer be reversed", async () => {
      const paid = await post(
        financeClient,
        `${PAYROLL}/runs/${runId}/mark-paid`,
        {
          idempotencyKey: key(),
        },
      );
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
      expect(paid.body.data.status).toBe("paid");
      expect(paid.body.data.paidAt).not.toBeNull();

      // A paid run is not reversed (money has left); the PRD does not allow it.
      const reversal = await run(runId, "reversal", { reason: "Salah bayar" });
      expect(reversal.status).toBe(409);
    });

    it("[PAYR-05] cancelling a locked run needs a different approver and posts a reversing journal", async () => {
      const second = await lockedRun("2034-03-10");

      // Requesting is not the same as cancelling: the run stays locked.
      const requested = await run(second, "reversal", {
        reason: "Gaji pokok salah input",
      });
      expect(requested.status, JSON.stringify(requested.body)).toBeLessThan(
        300,
      );
      expect(requested.body.data.status).toBe("locked");
      expect(requested.body.data.reversal).toMatchObject({
        status: "pending",
        reason: "Gaji pokok salah input",
      });

      // The requester cannot approve their own request.
      const selfApproval = await post(
        hrClient,
        `${PAYROLL}/runs/${second}/reversal/decision`,
        { action: "approve", idempotencyKey: key() },
      );
      expect(selfApproval.status).toBe(403);

      const approved = await post(
        financeClient,
        `${PAYROLL}/runs/${second}/reversal/decision`,
        { action: "approve", idempotencyKey: key() },
      );
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body.data.status).toBe("reversed");

      // The original journal stays; a balanced reversing journal mirrors it.
      const original = (await journalsOf(second))[0];
      expect(original, "payroll journal of the cancelled run").toBeDefined();
      const reversals = await hrClient.get(
        `/api/accounting/journals?legalEntityId=${cafeLegendPayrollFixtures.legalEntityId}` +
          `&from=2000-01-01&to=2099-12-31&sourceType=reversal&limit=100`,
      );
      expect(reversals.status).toBe(200);
      const mirror = (
        reversals.body.data as { id: string; reversalOf: string | null }[]
      ).find((entry) => entry.reversalOf === original!.id);
      expect(mirror, "reversing journal").toBeDefined();
      const detail = await hrClient.get(
        `/api/accounting/journals/${mirror!.id}`,
      );
      const lines = detail.body.data.entry.lines as {
        debitIdr: number;
        creditIdr: number;
      }[];
      expect(lines.reduce((s, l) => s + l.debitIdr, 0)).toBe(
        lines.reduce((s, l) => s + l.creditIdr, 0),
      );
    });

    it("[PAYR-05] an empty case: before any request, a locked run carries no reversal", async () => {
      const third = await lockedRun("2034-04-10");
      const detail = await hrClient.get(`${PAYROLL}/runs/${third}`);
      expect(detail.status).toBe(200);
      expect(detail.body.data.reversal).toBeNull();
    });
  },
);
