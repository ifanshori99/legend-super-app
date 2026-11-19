// Overtime (versioned "rumus lembur") and the holiday calendar against
// PostgreSQL with the restricted app role (RLS enforced): PRD v1.7 §3 Kelompok D
// 29 "Cuti, Izin & Lembur" (Hari Libur, Lembur), §3.7 Matriks Approval, §6 H
// `overtime_requests`, `holidays`; PAYR-02 (formula versions); TEN-01/02/03;
// bead legend-hggk section T2.
//
// Services are called directly with server-minted contexts, like hris-db.test.
// Approval goes through the real matrix: an `overtime` policy routes to the
// outlet manager role.
//
// Assumptions (the spec leaves these open):
//  - A self-service employee needs only own-record codes (self.profile.view,
//    self.leave.request, self.attendance.clock) to request overtime for
//    themself; HR on behalf is not expressible in the contract (no employeeId).
//  - Denials for an actor outside outlet reach are 403 or 404 (never success).
//  - Publishing an already published formula is refused with 409 or 422.
//  - Service signatures follow the brief:
//    fn(context, actorUserId, [id,] input, [{ mfaVerified }]).
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  encodeCursor,
  idr,
  outletIdSchema,
  userIdSchema,
} from "@starter/shared/core";
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
import { createEmployee } from "../services/hris-employee.service.ts";
import {
  cancelShiftAssignment,
  createShiftAssignment,
  publishRoster,
} from "../services/hris-scheduling-roster.service.ts";
import { createShiftTemplate } from "../services/hris-scheduling-setup.service.ts";
import type { CreateEmployeeInput } from "../services/hris-employee.service.ts";
import {
  createHoliday,
  deleteHoliday,
  listHolidays,
  updateHoliday,
} from "../services/hris-holiday.service.ts";
import {
  computeApprovedOvertimePay,
  createOvertimeFormula,
  createOvertimeRequest,
  decideOvertimeRequest,
  listOvertimeFormulas,
  listOvertimeRequests,
  publishOvertimeFormula,
  settleOvertimeRequest,
} from "../services/hris-overtime.service.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const outletB = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[1].id);
const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherEntity = randomUUID();
const otherOutlet = outletIdSchema.parse(randomUUID());

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const createdUsers: string[] = [];
const createdRoles: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];

const base = (tenant: string = tenantId) =>
  establishTenantContext({
    tenantId: tenant,
    brandId: null,
    source: "session",
  });
const tenantScope = (tenant: string = tenantId) =>
  establishScopedTenantContext(base(tenant), { kind: "tenant" });
const outletScope = (outletId: string, tenant: string = tenantId) =>
  establishScopedTenantContext(base(tenant), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
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

/** Rows the restricted app role (RLS on) sees for a tenant and outlet list. */
async function asApp<T>(
  tenant: string,
  outletIds: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
      [tenant, outletIds],
    );
    const { rows } = await client.query(sql, params);
    await client.query("COMMIT");
    return rows as T[];
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
  tenant: string = tenantId,
): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Lembur DB', $2)`,
    [userId, `${userId}@example.test`],
  );
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asOwner(tenant, async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant,
        `Lembur test ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [
        tenant,
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

/** A user holding a seeded template role (e.g. outlet_manager) at an outlet. */
async function templateUser(
  templateKey: string,
  outletId: string,
): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Manajer lembur', $2)`,
    [userId, `${userId}@example.test`],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenantId, userId, await templateRoleId(templateKey), outletId],
  );
  return userId;
}

const employeeNo = () =>
  `OT-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
function employeeInput(
  overrides: Partial<CreateEmployeeInput> = {},
): CreateEmployeeInput {
  return {
    userId: null,
    legalEntityId: null,
    employeeNo: employeeNo(),
    fullName: "Karyawan Lembur",
    positionId: null,
    orgUnitId: null,
    managerId: null,
    homeOutletId: outletA,
    employmentType: "pkwt",
    joinDate: "2026-01-05",
    endDate: null,
    ptkpStatus: "TK/0",
    status: "active",
    ...overrides,
  } as CreateEmployeeInput;
}

const key = () => `otdb-${randomUUID()}`;
const codeOf = (error: unknown) => (error as { code?: string }).code;
const statusOf = (error: unknown) => (error as { status?: number }).status;
async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return { code: codeOf(error), status: statusOf(error), error };
  }
  throw new Error("Expected the call to fail");
}

// Standard Indonesian tiers (PP 35/2021): workday 1.5x first hour then 2x;
// rest day (6-day week) 2x for 7 hours; rest day (5-day week) 2x for 8 hours.
const FORMULA_V1: OvertimeParameters = {
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
// v2 pays a richer workday: 2x the first hour, 2.5x afterwards.
const FORMULA_V2: OvertimeParameters = {
  ...FORMULA_V1,
  tiersByDayType: {
    ...FORMULA_V1.tiersByDayType,
    workday: [
      { fromHour: 0, toHour: 1, multiplier: "2.0000" },
      { fromHour: 1, toHour: null, multiplier: "2.5000" },
    ],
  },
} as OvertimeParameters;
// 17.300.000 / 173 = Rp100.000 an hour, so expected pay is exact.
const BASE_EXACT = idr(17_300_000);
// 5.000.000 / 173 is not a whole number: pay must still be whole rupiah.
const BASE_ODD = idr(5_000_000);

// Actors.
let hr: string; // tenant-wide hr.employee.manage
let hrB: string; // hr.employee.manage at outlet B only
let hrOther: string; // HR of the other tenant
let stranger: string; // no HR code at all
let staffA1: string;
let staffA2: string;
let staffB: string;
let mgrA: string; // outlet_manager template at outlet A (overtime approver)
let mgrB: string; // outlet_manager template at outlet B
// Employees.
let e1: Employee; // staffA1, outlet A
let e2: Employee; // staffA2, outlet A
let e3: Employee; // staffB, outlet B

const SELF_CODES = [
  "self.profile.view",
  "self.leave.request",
  "self.attendance.clock",
];

type OvertimeInput = Parameters<typeof createOvertimeRequest>[2];
function requestOvertime(
  user: string,
  outletId: string,
  date: string,
  minutes: number,
  extra: Record<string, unknown> = {},
) {
  return createOvertimeRequest(outletScope(outletId), user, {
    outletId,
    date,
    minutes,
    reason: "Menutup dapur lebih lama dari jadwal.",
    idempotencyKey: key(),
    ...extra,
  } as OvertimeInput);
}

function decide(
  manager: string,
  outletId: string,
  requestId: string,
  action: "approve" | "reject" | "cancel",
  idempotencyKey: string = key(),
) {
  return decideOvertimeRequest(
    outletScope(outletId),
    manager,
    requestId as never,
    {
      action,
      idempotencyKey,
      ...(action === "reject" ? { rejectionReason: "Jadwal penuh" } : {}),
    },
    { mfaVerified: true },
  );
}

const pay = (
  employeeId: string,
  date: string,
  monthlyBaseIdr = BASE_EXACT,
  to = date,
) =>
  computeApprovedOvertimePay(tenantScope(), {
    employeeId,
    from: date,
    to,
    monthlyBaseIdr,
  } as never);

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // The API bootstrap installs this; these service calls run without the app.
  setAuditWriter(coreAuditWriter);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Overtime RLS tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `ot-rls-${otherTenant.slice(0, 8)}`, tenantId],
  );
  await asOwner(otherTenant, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand B')`,
      [otherBrand, otherTenant],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT B', false)`,
      [otherEntity, otherTenant],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'B-01', 'Outlet B', 'Jl. B', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [otherOutlet, otherTenant, otherBrand, otherEntity],
    );
  });

  // §3.7 matrix: an overtime request goes to the outlet manager, one level.
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
  hrB = await customUser(["hr.employee.manage", "hr.employee.view"], {
    type: "outlet",
    id: outletB,
  });
  hrOther = await customUser(
    ["hr.employee.manage", "hr.employee.view"],
    { type: "tenant" },
    otherTenant,
  );
  stranger = await customUser(["menu.item.view"], { type: "tenant" });
  staffA1 = await customUser(SELF_CODES, { type: "outlet", id: outletA });
  staffA2 = await customUser(SELF_CODES, { type: "outlet", id: outletA });
  staffB = await customUser(SELF_CODES, { type: "outlet", id: outletB });
  mgrA = await templateUser("outlet_manager", outletA);
  mgrB = await templateUser("outlet_manager", outletB);

  e1 = await createEmployee(
    tenantScope(),
    hr,
    employeeInput({
      userId: userIdSchema.parse(staffA1),
      fullName: "Lembur Satu",
    }),
  );
  e2 = await createEmployee(
    tenantScope(),
    hr,
    employeeInput({
      userId: userIdSchema.parse(staffA2),
      fullName: "Lembur Dua",
    }),
  );
  e3 = await createEmployee(
    tenantScope(),
    hr,
    employeeInput({
      userId: userIdSchema.parse(staffB),
      homeOutletId: outletB,
      fullName: "Lembur Tiga",
    }),
  );
});

afterAll(async () => {
  setAuditWriter(null);
  await asOwner(tenantId, async (client) => {
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
      `DELETE FROM holidays WHERE tenant_id = $1 AND name LIKE 'OTDB %'`,
      [tenantId],
    );
    await client.query(
      `DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'otdb-%'`,
      [tenantId],
    );
    await client.query(
      `DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])`,
      [tenantId, createdUsers],
    );
    await client.query(
      `DELETE FROM shift_assignments WHERE tenant_id = $1 AND employee_id IN (SELECT id FROM employees WHERE tenant_id = $1 AND created_by = ANY($2::text[]))`,
      [tenantId, createdUsers],
    );
    await client.query(
      `DELETE FROM shift_templates WHERE tenant_id = $1 AND name LIKE 'OTROSTER %'`,
      [tenantId],
    );
    // The leave accrual job grants every active employee of a tenant, so a
    // parallel leave file can leave ledger/balance rows on ours (FK no action).
    for (const table of ["leave_accruals", "leave_balances"])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND ${mine}`,
        [tenantId, createdUsers],
      );
    await client.query(
      `DELETE FROM employees WHERE tenant_id = $1 AND created_by = ANY($2::text[])`,
      [tenantId, createdUsers],
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
  for (const tenant of [tenantId, otherTenant])
    await asOwner(tenant, async (client) => {
      await client.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
        [tenant, createdUsers],
      );
      await client.query(
        "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
        [tenant, createdRoles],
      );
    });
  // Audit rows are append-only and may reference the fixture outlet (see
  // hris-db.test.ts): leave the other tenant in place when they do.
  const referenced = await owner.query(
    "SELECT 1 FROM audit_logs WHERE tenant_id = $1 AND outlet_id IS NOT NULL LIMIT 1",
    [otherTenant],
  );
  if ((referenced.rowCount ?? 0) === 0) {
    await asOwner(otherTenant, async (client) => {
      await client.query("DELETE FROM outlets WHERE tenant_id = $1", [
        otherTenant,
      ]);
      await client.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
        otherTenant,
      ]);
      await client.query("DELETE FROM brands WHERE tenant_id = $1", [
        otherTenant,
      ]);
    });
    await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  }
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    createdUsers,
  ]);
  await owner.end();
  await appPool.end();
});

// Shared formula state, filled in order by the tests below.
let formulaV1: { id: string; version: number };
let formulaV2: { id: string; version: number };

describe("§3 D.29 Lembur: versioned formula (PAYR-02)", () => {
  it("[§29 Lembur] with no published formula an overtime request is refused with 409 OVERTIME_FORMULA_MISSING, and a draft does not count", async () => {
    const draft = await createOvertimeFormula(tenantScope(), hr, {
      effectiveFrom: "2026-01-01",
      parameters: FORMULA_V1,
      restDayType: "rest_day_6_day_week",
      legalBasis: "PP 35/2021 Pasal 31",
      idempotencyKey: key(),
    } as never);
    expect(draft).toMatchObject({
      status: "draft",
      publishedAt: null,
      publishedBy: null,
    });
    formulaV1 = { id: draft.id, version: draft.version };

    const refused = await failure(
      requestOvertime(staffA1, outletA, "2026-10-05", 90),
    );
    expect(refused.status).toBe(409);
    expect(refused.code).toBe("OVERTIME_FORMULA_MISSING");
  });

  it("[§29 Lembur] only HR with the manage permission creates or publishes a formula", async () => {
    const staffCreate = await failure(
      createOvertimeFormula(outletScope(outletA), staffA1, {
        effectiveFrom: "2026-01-01",
        parameters: FORMULA_V1,
        restDayType: "rest_day_6_day_week",
        legalBasis: "PP 35/2021",
        idempotencyKey: key(),
      } as never),
    );
    expect(staffCreate.status).toBe(403);
    const staffPublish = await failure(
      publishOvertimeFormula(
        outletScope(outletA),
        staffA1,
        formulaV1.id as never,
        {
          idempotencyKey: key(),
        } as never,
      ),
    );
    expect(staffPublish.status).toBe(403);
    const strangerPublish = await failure(
      publishOvertimeFormula(
        tenantScope(),
        stranger,
        formulaV1.id as never,
        {
          idempotencyKey: key(),
        } as never,
      ),
    );
    expect(strangerPublish.status).toBe(403);
  });

  it("[§29 Lembur] publishing makes the draft effective; a published version cannot be published again", async () => {
    const published = await publishOvertimeFormula(
      tenantScope(),
      hr,
      formulaV1.id as never,
      { idempotencyKey: key() } as never,
    );
    expect(published).toMatchObject({
      id: formulaV1.id,
      status: "published",
      publishedBy: hr,
    });
    expect(published.publishedAt).not.toBeNull();
    expect(published.parameters).toEqual(FORMULA_V1);
    const again = await failure(
      publishOvertimeFormula(
        tenantScope(),
        hr,
        formulaV1.id as never,
        {
          idempotencyKey: key(),
        } as never,
      ),
    );
    expect([409, 422]).toContain(again.status);
  });

  it("[§29 Lembur] a request dated before the formula's effective date is refused (409 OVERTIME_FORMULA_MISSING)", async () => {
    const refused = await failure(
      requestOvertime(staffA1, outletA, "2025-12-31", 60),
    );
    expect(refused.status).toBe(409);
    expect(refused.code).toBe("OVERTIME_FORMULA_MISSING");
  });
});

describe("§3 D.29 Lembur: request, approval matrix and pay", () => {
  it("[§29 Lembur] a workday request is pinned to the formula, waits in the matrix, and approval makes it payable at 1.5x then 2x in whole rupiah", async () => {
    const created = await requestOvertime(staffA1, outletA, "2026-10-12", 90);
    expect(created).toMatchObject({
      employeeId: e1.id,
      outletId: outletA,
      date: "2026-10-12",
      minutes: 90,
      status: "pending",
      dayType: "workday",
      formulaId: formulaV1.id,
      decidedBy: null,
      decidedAt: null,
    });
    // A pending request earns nothing yet.
    expect((await pay(e1.id, "2026-10-12")).items).toEqual([]);

    const approved = await decide(mgrA, outletA, created.id, "approve");
    expect(approved).toMatchObject({
      id: created.id,
      status: "approved",
      decidedBy: mgrA,
    });
    expect(approved.decidedAt).not.toBeNull();

    const feed = await pay(e1.id, "2026-10-12");
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      overtimeRequestId: created.id,
      date: "2026-10-12",
      dayType: "workday",
      hours: "1.5000",
      formulaId: formulaV1.id,
      formulaVersion: formulaV1.version,
    });
    // 1h x 1.5 + 0.5h x 2.0 = 2.5 x Rp100.000.
    expect(feed.items[0]!.payIdr).toBe(250_000);
    expect(feed.items[0]!.payIdr).toBe(
      computeOvertimePay(FORMULA_V1, "workday", "1.5000" as never, BASE_EXACT),
    );
    expect(feed.totalIdr).toBe(250_000);
  });

  it("[§29 Lembur] 2.5 workday hours pay 1.5x for the first hour and 2x after", async () => {
    const created = await requestOvertime(staffA1, outletA, "2026-10-13", 150);
    await decide(mgrA, outletA, created.id, "approve");
    const feed = await pay(e1.id, "2026-10-13");
    // 1 x 1.5 + 1.5 x 2.0 = 4.5 x Rp100.000.
    expect(feed.items[0]!.hours).toBe("2.5000");
    expect(feed.items[0]!.payIdr).toBe(450_000);
    expect(feed.totalIdr).toBe(450_000);
    // The feed sums every approved request in the range.
    const range = await pay(e1.id, "2026-10-12", BASE_EXACT, "2026-10-13");
    expect(range.items).toHaveLength(2);
    expect(range.totalIdr).toBe(250_000 + 450_000);
  });

  it("[§29 Lembur] pay is an integer number of rupiah and equals computeOvertimePay for a base that does not divide evenly", async () => {
    const feed = await pay(e1.id, "2026-10-12", BASE_ODD);
    const item = feed.items[0]!;
    const expected = computeOvertimePay(
      FORMULA_V1,
      "workday",
      "1.5000" as never,
      BASE_ODD,
    );
    expect(Number.isInteger(item.payIdr)).toBe(true);
    expect(item.payIdr).toBe(expected);
    // 5.000.000 / 173 x 2.5 = 72.254,33: whole rupiah, rounded half up.
    expect(item.payIdr).toBe(72_254);
    expect(Number.isInteger(feed.totalIdr)).toBe(true);
    expect(feed.totalIdr).toBe(72_254);
  });

  it("[§29 Hari Libur] overtime on a public holiday is paid with the rest-day tiers", async () => {
    await createHoliday(tenantScope(), hr, {
      date: "2026-10-14",
      name: "OTDB Libur nasional",
      type: "national",
      outletId: null,
      idempotencyKey: key(),
    } as never);
    const created = await requestOvertime(staffA2, outletA, "2026-10-14", 150);
    expect(created.dayType).toBe("rest_day_6_day_week");
    await decide(mgrA, outletA, created.id, "approve");
    const feed = await pay(e2.id, "2026-10-14");
    expect(feed.items[0]).toMatchObject({
      dayType: "rest_day_6_day_week",
      hours: "2.5000",
    });
    // Rest-day tiers: 2.5h x 2.0 x Rp100.000.
    expect(feed.items[0]!.payIdr).toBe(500_000);
    expect(feed.items[0]!.payIdr).toBe(
      computeOvertimePay(
        FORMULA_V1,
        "rest_day_6_day_week",
        "2.5000" as never,
        BASE_EXACT,
      ),
    );
  });

  it("[§29 Hari Libur] an outlet company holiday applies only to that outlet", async () => {
    await createHoliday(tenantScope(), hr, {
      date: "2026-10-15",
      name: "OTDB Libur outlet A",
      type: "company",
      outletId: outletA,
      idempotencyKey: key(),
    } as never);
    const inA = await requestOvertime(staffA1, outletA, "2026-10-15", 60);
    expect(inA.dayType).toBe("rest_day_6_day_week");
    const inB = await requestOvertime(staffB, outletB, "2026-10-15", 60);
    expect(inB.dayType).toBe("workday");
    // legend-arj.2: the employee's own weekly rest day is no longer chosen by
    // the employee; it comes from the published roster (see the 1057 block).
  });

  it("[§29 Lembur] a newer formula version never changes overtime that was already pinned", async () => {
    const draft = await createOvertimeFormula(tenantScope(), hr, {
      effectiveFrom: "2026-11-01",
      parameters: FORMULA_V2,
      restDayType: "rest_day_6_day_week",
      legalBasis: "Kebijakan perusahaan 2026 (lebih tinggi dari PP 35/2021)",
      idempotencyKey: key(),
    } as never);
    expect(draft.version).toBe(formulaV1.version + 1);
    await publishOvertimeFormula(
      tenantScope(),
      hr,
      draft.id as never,
      {
        idempotencyKey: key(),
      } as never,
    );
    formulaV2 = { id: draft.id, version: draft.version };

    // Dated before v2 takes effect: still v1, even though v2 is published.
    const early = await requestOvertime(staffA1, outletA, "2026-10-20", 90);
    expect(early.formulaId).toBe(formulaV1.id);
    // Dated after: v2.
    const late = await requestOvertime(staffA1, outletA, "2026-11-02", 90);
    expect(late.formulaId).toBe(formulaV2.id);
    await decide(mgrA, outletA, early.id, "approve");
    await decide(mgrA, outletA, late.id, "approve");

    // The request approved under v1 pays exactly as before.
    const oldFeed = await pay(e1.id, "2026-10-12");
    expect(oldFeed.items[0]).toMatchObject({
      formulaId: formulaV1.id,
      formulaVersion: formulaV1.version,
      payIdr: 250_000,
    });
    expect((await pay(e1.id, "2026-10-20")).items[0]!.payIdr).toBe(250_000);
    // v2: 1h x 2.0 + 0.5h x 2.5 = 3.25 x Rp100.000.
    const newFeed = await pay(e1.id, "2026-11-02");
    expect(newFeed.items[0]).toMatchObject({
      formulaId: formulaV2.id,
      formulaVersion: formulaV2.version,
      payIdr: 325_000,
    });
    expect(newFeed.items[0]!.payIdr).toBe(
      computeOvertimePay(FORMULA_V2, "workday", "1.5000" as never, BASE_EXACT),
    );

    // Both versions stay listed, and v1's parameters are untouched.
    const formulas = await listOvertimeFormulas(tenantScope(), hr, {
      limit: 100,
    } as never);
    const listed = new Map<string, (typeof formulas.data)[number]>(
      formulas.data.map((row) => [row.id as string, row]),
    );
    expect(listed.get(formulaV1.id)).toMatchObject({
      status: "published",
      parameters: FORMULA_V1,
    });
    expect(listed.get(formulaV2.id)).toMatchObject({
      status: "published",
      parameters: FORMULA_V2,
    });
  });

  it("[§3.7 Approval] a rejection ends the request unpaid; a decided request cannot be decided again", async () => {
    const created = await requestOvertime(staffA1, outletA, "2026-10-21", 60);
    const rejected = await decide(mgrA, outletA, created.id, "reject");
    expect(rejected).toMatchObject({
      status: "rejected",
      decidedBy: mgrA,
    });
    expect(rejected.decidedAt).not.toBeNull();
    expect((await pay(e1.id, "2026-10-21")).items).toEqual([]);
    expect((await pay(e1.id, "2026-10-21")).totalIdr).toBe(0);
    const again = await failure(decide(mgrA, outletA, created.id, "approve"));
    expect(again.status).toBe(409);
  });

  it("[§3.7 Approval] the requester cancels a pending request; it earns nothing", async () => {
    const created = await requestOvertime(staffA1, outletA, "2026-10-22", 60);
    const cancelled = await decide(staffA1, outletA, created.id, "cancel");
    expect(cancelled.status).toBe("cancelled");
    expect((await pay(e1.id, "2026-10-22")).items).toEqual([]);
  });

  it("[§3.7 Approval] an employee cannot approve their own overtime and a manager of another outlet cannot see it", async () => {
    const created = await requestOvertime(staffA1, outletA, "2026-10-23", 60);
    const self = await failure(decide(staffA1, outletA, created.id, "approve"));
    expect(self.status).toBe(403);
    const otherOutletManager = await failure(
      decide(mgrB, outletB, created.id, "approve"),
    );
    expect(otherOutletManager.status).toBe(404);
    const still = await listOvertimeRequests(tenantScope(), hr, {
      employeeId: e1.id,
      from: "2026-10-23",
      to: "2026-10-23",
      limit: 10,
    } as never);
    expect(still.data.map((row) => [row.id, row.status])).toEqual([
      [created.id, "pending"],
    ]);
  });

  it("[§3.7 Approval] replaying a create or a decision with the same idempotency key returns the same row", async () => {
    const createKey = key();
    const first = await requestOvertime(staffA1, outletA, "2026-10-24", 45, {
      idempotencyKey: createKey,
    });
    const replay = await requestOvertime(staffA1, outletA, "2026-10-24", 45, {
      idempotencyKey: createKey,
    });
    expect(replay.id).toBe(first.id);

    const decisionKey = key();
    const approved = await decide(
      mgrA,
      outletA,
      first.id,
      "approve",
      decisionKey,
    );
    const replayed = await decide(
      mgrA,
      outletA,
      first.id,
      "approve",
      decisionKey,
    );
    expect(replayed).toEqual(approved);
    // Approved once: a single pay line.
    expect((await pay(e1.id, "2026-10-24")).items).toHaveLength(1);
  });

  it("[§29 Lembur] listing filters by employee, status and date range; an empty range returns an empty page", async () => {
    const approved = await listOvertimeRequests(tenantScope(), hr, {
      employeeId: e1.id,
      status: "approved",
      from: "2026-10-01",
      to: "2026-10-31",
      limit: 100,
    } as never);
    expect(approved.data.length).toBeGreaterThanOrEqual(4);
    expect(
      approved.data.every(
        (row) =>
          row.employeeId === e1.id &&
          row.status === "approved" &&
          row.date >= "2026-10-01" &&
          row.date <= "2026-10-31",
      ),
    ).toBe(true);
    const empty = await listOvertimeRequests(tenantScope(), hr, {
      employeeId: e1.id,
      from: "2040-01-01",
      to: "2040-12-31",
      limit: 100,
    } as never);
    expect(empty.data).toEqual([]);
  });
});

describe("§3 D.29 Hari Libur: calendar CRUD", () => {
  it("[§29 Hari Libur] HR creates, lists, renames and deletes a holiday", async () => {
    const created = await createHoliday(tenantScope(), hr, {
      date: "2026-12-25",
      name: "OTDB Natal",
      type: "national",
      outletId: null,
      idempotencyKey: key(),
    } as never);
    expect(created).toMatchObject({
      tenantId,
      date: "2026-12-25",
      name: "OTDB Natal",
      type: "national",
      outletId: null,
    });
    const listed = await listHolidays(tenantScope(), hr, {
      year: 2026,
      limit: 100,
    } as never);
    expect(listed.data.map((row) => row.id)).toContain(created.id);

    const renamed = await updateHoliday(
      tenantScope(),
      hr,
      created.id as never,
      {
        name: "OTDB Hari Natal",
        type: "collective",
        idempotencyKey: key(),
      } as never,
    );
    expect(renamed).toMatchObject({
      id: created.id,
      name: "OTDB Hari Natal",
      type: "collective",
      date: "2026-12-25",
    });

    await deleteHoliday(tenantScope(), hr, created.id as never);
    const after = await listHolidays(tenantScope(), hr, {
      year: 2026,
      limit: 100,
    } as never);
    expect(after.data.map((row) => row.id)).not.toContain(created.id);
    expect(
      (await failure(deleteHoliday(tenantScope(), hr, created.id as never)))
        .status,
    ).toBe(404);
  });

  it("[§29 Hari Libur] the same date and outlet twice conflicts (409), including two tenant-wide rows; another outlet on that date is allowed", async () => {
    const wide = await createHoliday(tenantScope(), hr, {
      date: "2026-12-31",
      name: "OTDB Cuti bersama",
      type: "collective",
      outletId: null,
      idempotencyKey: key(),
    } as never);
    const duplicateWide = await failure(
      createHoliday(tenantScope(), hr, {
        date: "2026-12-31",
        name: "OTDB Cuti bersama lagi",
        type: "collective",
        outletId: null,
        idempotencyKey: key(),
      } as never),
    );
    expect(duplicateWide.status).toBe(409);

    await createHoliday(tenantScope(), hr, {
      date: "2026-12-24",
      name: "OTDB Outlet A tutup",
      type: "company",
      outletId: outletA,
      idempotencyKey: key(),
    } as never);
    const duplicateA = await failure(
      createHoliday(tenantScope(), hr, {
        date: "2026-12-24",
        name: "OTDB Outlet A tutup lagi",
        type: "company",
        outletId: outletA,
        idempotencyKey: key(),
      } as never),
    );
    expect(duplicateA.status).toBe(409);
    const forB = await createHoliday(tenantScope(), hr, {
      date: "2026-12-24",
      name: "OTDB Outlet B tutup",
      type: "company",
      outletId: outletB,
      idempotencyKey: key(),
    } as never);
    expect(forB.outletId).toBe(outletB);

    // Moving a holiday onto a taken date and outlet conflicts as well.
    const movable = await createHoliday(tenantScope(), hr, {
      date: "2026-12-23",
      name: "OTDB Outlet A bisa pindah",
      type: "company",
      outletId: outletA,
      idempotencyKey: key(),
    } as never);
    const clash = await failure(
      updateHoliday(
        tenantScope(),
        hr,
        movable.id as never,
        {
          date: "2026-12-24",
          idempotencyKey: key(),
        } as never,
      ),
    );
    expect(clash.status).toBe(409);
    // The tenant-wide row on 12-31 does not block an outlet-specific one.
    const moved = await updateHoliday(
      tenantScope(),
      hr,
      movable.id as never,
      {
        date: "2026-12-31",
        idempotencyKey: key(),
      } as never,
    );
    expect(moved.date).toBe("2026-12-31");
    expect(wide.outletId).toBeNull();
  });

  it("[§29 Hari Libur] a year without holidays lists an empty page", async () => {
    const empty = await listHolidays(tenantScope(), hr, {
      year: 2040,
      limit: 100,
    } as never);
    expect(empty.data).toEqual([]);
  });

  it("[§29 Hari Libur] employees read the calendar but cannot change it; a user without an HR code reads nothing", async () => {
    const list = await listHolidays(outletScope(outletA), staffA1, {
      year: 2026,
      limit: 100,
    } as never);
    expect(list.data.length).toBeGreaterThan(0);
    const create = await failure(
      createHoliday(outletScope(outletA), staffA1, {
        date: "2026-11-20",
        name: "OTDB Tidak boleh",
        type: "company",
        outletId: outletA,
        idempotencyKey: key(),
      } as never),
    );
    expect(create.status).toBe(403);
    const none = await failure(
      listHolidays(tenantScope(), stranger, { limit: 20 } as never),
    );
    expect(none.status).toBe(403);
  });
});

describe("TEN-01/TEN-03 isolation of overtime and holidays", () => {
  it("[TEN-01] another tenant's HR sees none of this tenant's holidays, formulas or overtime, and cannot change them", async () => {
    const holidays = await listHolidays(tenantScope(otherTenant), hrOther, {
      limit: 100,
    } as never);
    expect(holidays.data.every((row) => row.tenantId === otherTenant)).toBe(
      true,
    );
    const formulas = await listOvertimeFormulas(
      tenantScope(otherTenant),
      hrOther,
      { limit: 100 } as never,
    );
    expect(formulas.data.map((row) => row.id)).not.toContain(formulaV1.id);
    const requests = await listOvertimeRequests(
      tenantScope(otherTenant),
      hrOther,
      { limit: 100 } as never,
    );
    expect(requests.data.every((row) => row.tenantId === otherTenant)).toBe(
      true,
    );

    const ours = await listHolidays(tenantScope(), hr, {
      year: 2026,
      limit: 100,
    } as never);
    const someHoliday = ours.data[0]!;
    expect(
      (
        await failure(
          updateHoliday(
            tenantScope(otherTenant),
            hrOther,
            someHoliday.id as never,
            { name: "OTDB diretas", idempotencyKey: key() } as never,
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await failure(
          deleteHoliday(
            tenantScope(otherTenant),
            hrOther,
            someHoliday.id as never,
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await failure(
          publishOvertimeFormula(
            tenantScope(otherTenant),
            hrOther,
            formulaV1.id as never,
            { idempotencyKey: key() } as never,
          ),
        )
      ).status,
    ).toBe(404);
  });

  it("[TEN-01] the database itself hides this tenant's rows from another tenant (RLS)", async () => {
    for (const table of [
      "holidays",
      "overtime_formulas",
      "overtime_requests",
    ]) {
      const visible = await asApp<{ n: number }>(
        otherTenant,
        "*",
        `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(visible[0]!.n, table).toBe(0);
      const own = await asApp<{ n: number }>(
        tenantId,
        "*",
        `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(own[0]!.n, table).toBeGreaterThan(0);
    }
  });

  it("[TEN-03] a manager of outlet B lists no overtime of outlet A and sees the tenant-wide holidays but not outlet A's", async () => {
    const requests = await listOvertimeRequests(outletScope(outletB), mgrB, {
      limit: 100,
    } as never);
    expect(requests.data.every((row) => row.outletId === outletB)).toBe(true);
    expect(requests.data.map((row) => row.employeeId)).not.toContain(e1.id);

    const holidays = await listHolidays(outletScope(outletB), mgrB, {
      year: 2026,
      limit: 100,
    } as never);
    expect(holidays.data.some((row) => row.outletId === null)).toBe(true);
    expect(holidays.data.some((row) => row.outletId === outletA)).toBe(false);
  });

  it("[TEN-03] an employee lists only their own overtime", async () => {
    const own = await listOvertimeRequests(outletScope(outletA), staffA2, {
      limit: 100,
    } as never);
    expect(own.data.length).toBeGreaterThan(0);
    expect(own.data.every((row) => row.employeeId === e2.id)).toBe(true);
    const ownB = await listOvertimeRequests(outletScope(outletB), staffB, {
      limit: 100,
    } as never);
    expect(ownB.data.every((row) => row.employeeId === e3.id)).toBe(true);
  });

  it("[TEN-03] HR of outlet B manages only outlet B holidays, not outlet A's nor tenant-wide ones", async () => {
    const own = await createHoliday(outletScope(outletB), hrB, {
      date: "2026-11-25",
      name: "OTDB Outlet B sendiri",
      type: "company",
      outletId: outletB,
      idempotencyKey: key(),
    } as never);
    expect(own.outletId).toBe(outletB);

    const forA = await failure(
      createHoliday(outletScope(outletB), hrB, {
        date: "2026-11-26",
        name: "OTDB Outlet A dari B",
        type: "company",
        outletId: outletA,
        idempotencyKey: key(),
      } as never),
    );
    expect([403, 404]).toContain(forA.status);
    const wide = await failure(
      createHoliday(outletScope(outletB), hrB, {
        date: "2026-11-27",
        name: "OTDB Semua outlet dari B",
        type: "company",
        outletId: null,
        idempotencyKey: key(),
      } as never),
    );
    expect([403, 404]).toContain(wide.status);

    const outletAHoliday = (
      await listHolidays(tenantScope(), hr, { year: 2026, limit: 100 } as never)
    ).data.find((row) => row.outletId === outletA)!;
    expect(
      [403, 404].includes(
        (
          await failure(
            updateHoliday(
              outletScope(outletB),
              hrB,
              outletAHoliday.id as never,
              { name: "OTDB diretas B", idempotencyKey: key() } as never,
            ),
          )
        ).status!,
      ),
    ).toBe(true);
    expect(
      [403, 404].includes(
        (
          await failure(
            deleteHoliday(
              outletScope(outletB),
              hrB,
              outletAHoliday.id as never,
            ),
          )
        ).status!,
      ),
    ).toBe(true);
  });
});

describe("Lembur review fixes (O1-O7)", () => {
  // Dates in December 2026 fall under formula v2 (effective 2026-11-01):
  // workday 2.0x for the first hour, then 2.5x.

  it("[O1] the approver's inbox text carries the day type and the hours", async () => {
    const created = await requestOvertime(staffA1, outletA, "2026-12-01", 90);
    const { rows } = await owner.query<{ request_reason: string }>(
      "SELECT request_reason FROM approval_requests WHERE tenant_id = $1 AND object_id = $2",
      [tenantId, created.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.request_reason).toContain("workday");
    expect(rows[0]!.request_reason).toContain("1.5000 jam");
    expect(rows[0]!.request_reason).toContain("2026-12-01");
  });

  it("[O2] pending and approved overtime of one employee and date is capped at 720 minutes; a cancelled request frees its minutes", async () => {
    const date = "2026-12-02";
    await requestOvertime(staffA2, outletA, date, 600);
    const second = await requestOvertime(staffA2, outletA, date, 120);
    const over = await failure(requestOvertime(staffA2, outletA, date, 1));
    expect(over).toMatchObject({ status: 409, code: "OVERTIME_DAILY_LIMIT" });
    // Another date and another employee have their own allowance.
    await requestOvertime(staffA2, outletA, "2026-12-03", 720);
    await requestOvertime(staffA1, outletA, date, 720);

    await decide(staffA2, outletA, second.id, "cancel");
    const afterCancel = await requestOvertime(staffA2, outletA, date, 120);
    expect(afterCancel.minutes).toBe(120);
    const again = await failure(requestOvertime(staffA2, outletA, date, 1));
    expect(again.code).toBe("OVERTIME_DAILY_LIMIT");
  });

  it("[O2] a replay of an accepted request is not refused by the cap", async () => {
    const date = "2026-12-04";
    const replayKey = key();
    const first = await requestOvertime(staffA2, outletA, date, 720, {
      idempotencyKey: replayKey,
    });
    const replay = await requestOvertime(staffA2, outletA, date, 720, {
      idempotencyKey: replayKey,
    });
    expect(replay.id).toBe(first.id);
  });

  it("[O3] a chain ended by the system settles with no deciding user but a decision time, and still parses", async () => {
    const created = await requestOvertime(staffA1, outletA, "2026-12-05", 60);
    await owner.query(
      "UPDATE approval_requests SET status = 'expired', decided_by = $3, decided_at = now() - interval '1 day' WHERE tenant_id = $1 AND object_id = $2",
      [tenantId, created.id, mgrA],
    );
    const settled = await settleOvertimeRequest(
      outletScope(outletA),
      created.id,
    );
    expect(settled).toMatchObject({
      id: created.id,
      status: "rejected",
      decidedBy: null,
    });
    expect(settled!.decidedAt).not.toBeNull();
    // decidedAt is the settle time, not a stale chain decision time.
    expect(Date.now() - new Date(settled!.decidedAt!).getTime()).toBeLessThan(
      60_000,
    );
    const audit = await owner.query(
      "SELECT event->>'actorType' AS actor_type, event->>'actorId' AS actor_id FROM audit_logs WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = 'hris.overtime_request.rejected'",
      [tenantId, created.id],
    );
    expect(audit.rows).toEqual([{ actor_type: "system", actor_id: null }]);
    const listed = await listOvertimeRequests(tenantScope(), hr, {
      employeeId: e1.id,
      from: "2026-12-05",
      to: "2026-12-05",
      limit: 10,
    } as never);
    expect(listed.data.map((row) => row.id)).toEqual([created.id]);
  });

  it("[O4] minutes of one day are summed before pricing; item shares add up exactly to the day's pay", async () => {
    const date = "2026-12-06";
    // 3 x 20 minutes: 1.0000 h together, but 0.3333 h each (0.9999 h if
    // converted per request).
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await requestOvertime(staffA1, outletA, date, 20);
      await decide(mgrA, outletA, created.id, "approve");
      ids.push(created.id);
    }
    const feed = await pay(e1.id, date, BASE_ODD);
    const expected = computeOvertimePay(
      FORMULA_V2,
      "workday",
      "1.0000" as never,
      BASE_ODD,
    );
    expect(feed.items.map((item) => item.overtimeRequestId)).toEqual(ids);
    expect(feed.totalIdr).toBe(expected);
    expect(feed.items.reduce((sum, item) => sum + item.payIdr, 0)).toBe(
      expected,
    );
    expect(feed.items.every((item) => item.hours === "0.3333")).toBe(true);
    expect(feed.items.every((item) => Number.isInteger(item.payIdr))).toBe(
      true,
    );
  });

  it("[O5] replaying a create key with a different (employee-typed) day type never creates a second or different request", async () => {
    // legend-arj.2: the typed day type is no longer an input that counts, so a
    // replay is either refused (reused key) or answers the first row.
    const replayKey = key();
    const first = await requestOvertime(staffA1, outletA, "2026-12-07", 30, {
      idempotencyKey: replayKey,
      dayType: "workday",
    });
    try {
      const replay = await requestOvertime(staffA1, outletA, "2026-12-07", 30, {
        idempotencyKey: replayKey,
        dayType: "rest_day_5_day_week",
      });
      expect(replay.id).toBe(first.id);
      expect(replay.dayType).toBe("workday");
    } catch (error) {
      expect(statusOf(error)).toBeGreaterThanOrEqual(400);
      expect(statusOf(error)).toBeLessThan(500);
    }
  });

  it("[O6] a holiday added after filing is honoured when the request is approved", async () => {
    const date = "2026-12-08";
    const created = await requestOvertime(staffA1, outletA, date, 150);
    expect(created.dayType).toBe("workday");
    await createHoliday(tenantScope(), hr, {
      date,
      name: "OTDB Libur susulan",
      type: "national",
      outletId: null,
      idempotencyKey: key(),
    } as never);
    const approved = await decide(mgrA, outletA, created.id, "approve");
    expect(approved.dayType).toBe("rest_day_6_day_week");
    const feed = await pay(e1.id, date);
    expect(feed.items[0]).toMatchObject({
      dayType: "rest_day_6_day_week",
      payIdr: computeOvertimePay(
        FORMULA_V2,
        "rest_day_6_day_week",
        "2.5000" as never,
        BASE_EXACT,
      ),
    });
  });

  it("[O7] a malformed cursor is a 422 on formulas, overtime requests and holidays, never a database error", async () => {
    const id = randomUUID();
    const bad = [
      encodeCursor(["not-a-date", id]),
      encodeCursor(["2026-02-30", id]),
      encodeCursor(["2026-12-01", "not-a-uuid"]),
      encodeCursor(["abc", id]),
    ];
    for (const cursor of bad) {
      for (const call of [
        () =>
          listOvertimeRequests(tenantScope(), hr, {
            cursor,
            limit: 10,
          } as never),
        () =>
          listOvertimeFormulas(tenantScope(), hr, {
            cursor,
            limit: 10,
          } as never),
        () =>
          listHolidays(tenantScope(), hr, {
            cursor,
            limit: 10,
          } as never),
      ])
        expect((await failure(call())).status).toBe(422);
    }
  });
});

// legend-arj.2 (bead 1057 card B): the day kind of an overtime request comes
// from the employee's PUBLISHED roster, never from what the employee types.
//
// Assumptions (the spec leaves these open; source: bead legend-arj.2 text
// "Derive rest day from the published shift schedule ... and refuse
// employee-chosen rest-day tiers"):
//  - Only published shifts count. A day on which the employee has no published
//    shift, in a week where they have published shifts, is their weekly rest
//    day. No published shift at all that week (nothing rostered, or only
//    drafts) means the day cannot be shown to be a rest day: it stays
//    "workday" (fail closed: never pay the higher rest-day tiers unproven).
//  - Rest-day tier (coordinator decision): not derived from the number of
//    shift days. A roster-derived rest day takes the tenant's published
//    formula `restDayType` (here rest_day_6_day_week for formula v2).
//  - A national/company holiday still forces rest_day_6_day_week (existing
//    contract: "a holiday on `date` overrides it server side").
//  - An employee-sent rest_day_* dayType is either refused (any thrown error)
//    or ignored; it never becomes the stored or paid day type.
describe("1057 Lembur: day type from the published roster (legend-arj.2)", () => {
  // Mondays in June 2027: no seeded holidays, formula v2 is in effect.
  const WEEK_5DAY = "2027-06-07"; // e4 works Mon-Fri; Sat 12 and Sun 13 rest
  const WEEK_6DAY = "2027-06-14"; // e5 works Mon-Sat; Sun 20 rests
  const WEEK_DRAFT = "2027-06-21"; // e6 has only draft shifts
  let scheduler: string;
  let staffA3: string;
  let staffA4: string;
  let staffA5: string;
  let e4: Employee;
  let e5: Employee;
  let e6: Employee;
  let staffA6: string;
  let e7: Employee;

  const addDays = (date: string, days: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  /** The tenant formula's rest-day type, read from the published formula. */
  async function formulaRestDayType() {
    const formulas = await listOvertimeFormulas(tenantScope(), hr, {
      limit: 100,
    } as never);
    const row = formulas.data.find((f) => f.id === formulaV2.id);
    const type = (row as { restDayType?: string } | undefined)?.restDayType;
    if (!type) throw new Error("Published formula has no restDayType");
    return type as "rest_day_6_day_week" | "rest_day_5_day_week";
  }

  async function rosterShifts(
    employee: Employee,
    weekStart: string,
    workDays: number,
    publish: boolean,
  ) {
    const template = await createShiftTemplate(tenantScope(), scheduler, {
      outletId: outletA,
      name: `OTROSTER ${randomUUID().slice(0, 8)}`,
      segments: [{ startTime: "10:00", endTime: "17:00" }],
      breakMinutes: 0,
      stationId: null,
      positionId: null,
    } as never);
    const created: { id: string }[] = [];
    for (let offset = 0; offset < workDays; offset += 1)
      created.push(
        await createShiftAssignment(tenantScope(), scheduler, {
          outletId: outletA,
          employeeId: employee.id,
          businessDate: addDays(weekStart, offset),
          shiftTemplateId: template.id,
          stationId: null,
          idempotencyKey: key(),
        } as never),
      );
    if (publish)
      await publishRoster(tenantScope(), scheduler, {
        outletId: outletA,
        weekStart,
        idempotencyKey: key(),
      } as never);
    return created;
  }

  /** Either the request is refused, or it resolved to a created row. */
  async function tryRequest(
    user: string,
    date: string,
    minutes: number,
    extra: Record<string, unknown>,
  ) {
    try {
      return {
        created: await requestOvertime(user, outletA, date, minutes, extra),
      };
    } catch (error) {
      return { refused: error };
    }
  }

  beforeAll(async () => {
    scheduler = await customUser(["hr.schedule.manage"], { type: "tenant" });
    staffA3 = await customUser(SELF_CODES, { type: "outlet", id: outletA });
    staffA4 = await customUser(SELF_CODES, { type: "outlet", id: outletA });
    staffA5 = await customUser(SELF_CODES, { type: "outlet", id: outletA });
    const make = (userId: string, fullName: string) =>
      createEmployee(
        tenantScope(),
        hr,
        employeeInput({ userId: userIdSchema.parse(userId), fullName }),
      );
    e4 = await make(staffA3, "Lembur Roster 5 hari");
    e5 = await make(staffA4, "Lembur Roster 6 hari");
    e6 = await make(staffA5, "Lembur Roster draft");
    staffA6 = await customUser(SELF_CODES, { type: "outlet", id: outletA });
    e7 = await make(staffA6, "Lembur Roster batal");
    await rosterShifts(e4, WEEK_5DAY, 5, true);
    await rosterShifts(e5, WEEK_6DAY, 6, true);
    await rosterShifts(e6, WEEK_DRAFT, 5, false);
  });

  it("[legend-arj.2] a roster rest day is derived without any input and takes the formula's restDayType", async () => {
    const restType = await formulaRestDayType();
    // Wednesday: rostered, so a normal workday.
    const workday = await requestOvertime(staffA3, outletA, "2027-06-09", 60);
    expect(workday.dayType).toBe("workday");

    // Saturday: no published shift in a week that has published shifts.
    const rest = await requestOvertime(staffA3, outletA, "2027-06-12", 90);
    expect(rest.dayType).toBe(restType);
    await decide(mgrA, outletA, rest.id, "approve");
    const feed = await pay(e4.id, "2027-06-12");
    expect(feed.items[0]).toMatchObject({ dayType: restType, hours: "1.5000" });
    expect(feed.items[0]!.payIdr).toBe(
      computeOvertimePay(FORMULA_V2, restType, "1.5000" as never, BASE_EXACT),
    );
  });

  it("[legend-arj.2] the weekly rest day of a 6-day roster takes the formula's restDayType too", async () => {
    const restType = await formulaRestDayType();
    const rest = await requestOvertime(staffA4, outletA, "2027-06-20", 150);
    expect(rest.dayType).toBe(restType);
    const workday = await requestOvertime(staffA4, outletA, "2027-06-19", 60);
    expect(workday.dayType).toBe("workday");
    await decide(mgrA, outletA, rest.id, "approve");
    const feed = await pay(e5.id, "2027-06-20");
    expect(feed.items[0]!.payIdr).toBe(
      computeOvertimePay(FORMULA_V2, restType, "2.5000" as never, BASE_EXACT),
    );
  });

  it("[legend-arj.2] an employee-chosen rest-day type on a rostered workday is refused or ignored, never stored", async () => {
    const outcome = await tryRequest(staffA3, "2027-06-08", 120, {
      dayType: "rest_day_5_day_week",
    });
    if ("refused" in outcome) {
      expect(statusOf(outcome.refused) ?? 422).toBeGreaterThanOrEqual(400);
      expect(statusOf(outcome.refused) ?? 422).toBeLessThan(500);
      return;
    }
    expect(outcome.created.dayType).toBe("workday");
    // The approver's inbox shows the real day type, not the typed one.
    const { rows } = await owner.query<{ request_reason: string }>(
      "SELECT request_reason FROM approval_requests WHERE tenant_id = $1 AND object_id = $2",
      [tenantId, outcome.created.id],
    );
    expect(rows[0]!.request_reason).toContain("workday");
    expect(rows[0]!.request_reason).not.toContain("rest_day");
    // Approved, it pays workday tiers (v2: 2.0x first hour, then 2.5x).
    await decide(mgrA, outletA, outcome.created.id, "approve");
    const feed = await pay(e4.id, "2027-06-08");
    expect(feed.items[0]).toMatchObject({ dayType: "workday" });
    expect(feed.items[0]!.payIdr).toBe(
      computeOvertimePay(FORMULA_V2, "workday", "2.0000" as never, BASE_EXACT),
    );
  });

  it("[legend-arj.2] a rest-day type typed on a day with no roster proof (no shifts, or only drafts) is refused or ignored", async () => {
    for (const [user, date] of [
      [staffA5, "2027-06-26"], // week with draft shifts only
      [staffA5, "2027-07-14"], // week with nothing rostered at all
    ] as const) {
      const outcome = await tryRequest(user, date, 60, {
        dayType: "rest_day_5_day_week",
      });
      if ("refused" in outcome) {
        expect(statusOf(outcome.refused) ?? 422).toBeGreaterThanOrEqual(400);
        expect(statusOf(outcome.refused) ?? 422).toBeLessThan(500);
      } else expect(outcome.created.dayType).toBe("workday");
    }
    // Without any input the same days are plain workdays.
    expect(
      (await requestOvertime(staffA5, outletA, "2027-06-27", 60)).dayType,
    ).toBe("workday");
  });

  it("[legend-arj.2] a typed workday cannot downgrade a derived rest day", async () => {
    const outcome = await tryRequest(staffA3, "2027-06-13", 60, {
      dayType: "workday",
    });
    if ("refused" in outcome) {
      expect(statusOf(outcome.refused) ?? 422).toBeGreaterThanOrEqual(400);
      expect(statusOf(outcome.refused) ?? 422).toBeLessThan(500);
    } else expect(outcome.created.dayType).toBe(await formulaRestDayType());
  });

  it("[legend-arj.2] a national holiday still forces the rest-day type on a rostered workday, whatever the employee types", async () => {
    await createHoliday(tenantScope(), hr, {
      date: "2027-06-11",
      name: "OTDB Libur roster",
      type: "national",
      outletId: null,
      idempotencyKey: key(),
    } as never);
    const created = await requestOvertime(staffA3, outletA, "2027-06-11", 60, {
      dayType: "workday",
    });
    expect(created.dayType).toBe("rest_day_6_day_week");
  });

  // Money bug (review of 1057): an employee with NO usable shift at all in a
  // week the outlet published (office staff, a manager) must not get the
  // rest-day tiers on an ordinary working day: that would overpay. Only an
  // employee who has published shifts that week and a free day has a rest day.
  const OFFICE_WEEK = "2027-07-05"; // outlet publishes; e4 works Mon-Fri
  const CANCEL_WEEK = "2027-07-26"; // outlet publishes; e7 cancelled, e5 draft

  it("[legend-arj.2] an employee with no shift at all in a published outlet week gets workday on Monday to Friday, and the rest-day type only where they have rostered shifts and a free day", async () => {
    await rosterShifts(e4, OFFICE_WEEK, 5, true);
    for (let offset = 0; offset < 5; offset += 1) {
      const date = addDays(OFFICE_WEEK, offset);
      const created = await requestOvertime(staffA5, outletA, date, 60);
      expect(created.dayType, date).toBe("workday");
    }
    // Control: e4 has published shifts Mon-Fri that week, so Saturday is
    // their rest day and takes the formula's restDayType.
    const control = await requestOvertime(
      staffA3,
      outletA,
      addDays(OFFICE_WEEK, 5),
      60,
    );
    expect(control.dayType).toBe(await formulaRestDayType());
  });

  it("[legend-arj.2] an employee whose shifts that week are all cancelled or all still draft gets workday on a weekday", async () => {
    // e7: shifts published with the week, then every one cancelled.
    const cancelled = await rosterShifts(e7, CANCEL_WEEK, 5, false);
    await rosterShifts(e4, CANCEL_WEEK, 5, true);
    for (const shift of cancelled)
      await cancelShiftAssignment(tenantScope(), scheduler, shift.id);
    // e5: shifts created after the publication, so they stay drafts.
    await rosterShifts(e5, CANCEL_WEEK, 5, false);
    // The outlet-week is published (e4), yet neither has a usable shift.
    for (const [user, label] of [
      [staffA6, "all cancelled"],
      [staffA4, "all draft"],
    ] as const)
      for (let offset = 0; offset < 5; offset += 1) {
        const date = addDays(CANCEL_WEEK, offset);
        const created = await requestOvertime(user, outletA, date, 60);
        expect(created.dayType, `${label} ${date}`).toBe("workday");
      }
  });
});
