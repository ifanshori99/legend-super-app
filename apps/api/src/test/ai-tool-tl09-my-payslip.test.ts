// TL-09 get_my_payslip (bead legend-39d.2; PRD v1.7 §39 TL table "Karyawan
// (miliknya)", §40 Input Minimum + AIG-01, §3 D.30 "Slip Gaji dilindungi PIN").
// Fail-first: written from the PRD, docs/briefs/sub-ws12-ai.md and the shared
// contract (packages/shared/src/ai, hris/payroll), not from the handler. Real
// PostgreSQL, real payslip PIN router (PUT /api/hris/me/payslip-pin), real
// access resolver; the handler is called directly like ai-tools-read-b.test.ts.
//
// Assumptions (the spec leaves these open; stated by the coordinator after the
// engineer's work):
// - GATE: the tool input is `{ payrollMonth }` only (a PIN typed in chat would
//   reach the model). The tool answers only when the employee has a payslip PIN
//   that is active (set, not locked) AND opened THIS payslip on the screen with
//   the PIN in the last 10 minutes (real `POST /me/payslips/:id/view`, which
//   writes the audit `payslip.viewed`). Every other state is refused with
//   AiError AI_TOOL_FORBIDDEN, also a month without a slip (no leak of which
//   months exist). The session is NOT MFA-verified.
// - `payrollMonth` (YYYY-MM) matches the month of payroll_runs.period_end.
// - The 10 minute window is measured against the tool context's `now`.
// - Output carries no raw PII: no key naming nik/npwp/bank/account/rekening, no
//   digit run of 10 or more, and no employee name or number.
import { randomUUID } from "node:crypto";
import express from "express";
import { type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AI_TOOL_IO, AiError } from "@starter/shared/ai";
import {
  cafeLegendPayrollFixtures,
  PAYSLIP_PIN_MAX_ATTEMPTS,
} from "@starter/shared/hris/payroll";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { requestContext } from "../lib/request-context.ts";
import {
  PAYROLL_SEAL_KEY_VERSION,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { tenantContext } from "../middleware/tenant.ts";
import { createHrisPayslipRouter } from "../routes/hris-payslip.routes.ts";
import { readToolsB } from "../services/ai-tools/read-b/index.ts";
import type { AiToolContext } from "../services/ai-tools/types.ts";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
} from "../services/permission-resolver.ts";
import {
  app as realApp,
  asTenant,
  cleanupAcceptance,
  created,
  grantTemplateRole,
  outletA,
  ownerPool,
  tenantId,
} from "./ai-acceptance-helpers.ts";
import { createIsolatedTenant } from "./floor-test-helpers.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenant = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const workerContext = establishScopedTenantContext(tenant, { kind: "tenant" });

// ---- app with the payslip router bound to the AI test tenant ---------------

const PAYSLIP_PATH = /^\/(me\/payslips|me\/payslip-pin)/;
function buildApp() {
  const gate = express.Router();
  gate.use(
    tenantContext({
      required: false,
      resolveDomain: async () => null,
      verifyCredential: async () => null,
      fallback: async () => ({
        tenantId,
        brandId: null,
        source: "session" as const,
      }),
    }),
  );
  gate.use(createHrisPayslipRouter({}));
  gate.use(errorHandler);
  const wrapper = express();
  wrapper.use(requestContext);
  wrapper.use("/api/hris", (req, res, next) =>
    PAYSLIP_PATH.test(req.path) ? gate(req, res, next) : next(),
  );
  wrapper.use(realApp);
  return wrapper;
}
const pinApp = buildApp();

// ---- fixtures ---------------------------------------------------------------

const RUN_STEPS = [
  `status = 'simulated'`,
  `status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now()`,
  `status = 'approved', approved_by_finance = 'finance-user', approved_by_finance_at = now()`,
  `status = 'locked', config_snapshot = '{"v":1}', totals = '{"t":1}', locked_by = 'lock-user', locked_at = now()`,
];

const seeded = {
  runs: [] as string[],
  policies: [] as string[],
  employees: [] as { tenantId: string; id: string }[],
  entities: [] as string[],
};
let monthCounter = 0;
/** A fresh far-future month per world so no suite shares a payroll period. */
function nextMonth(): string {
  monthCounter += 1;
  const year = 2060 + Math.floor(monthCounter / 12);
  const month = (monthCounter % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

async function withOwner<T>(
  forTenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [forTenant],
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

type World = { tenantId: string; runId: string; month: string };

async function seedWorld(
  forTenant: string,
  entityId: string,
  month: string,
): Promise<World> {
  const policyId = randomUUID();
  const runId = randomUUID();
  seeded.runs.push(runId);
  seeded.policies.push(policyId);
  await withOwner(forTenant, async (client) => {
    await client.query(
      `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                     employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan TL09', $4, $5, $6, 'none', 'low', '[]')`,
      [
        policyId,
        forTenant,
        entityId,
        `T09${policyId.slice(0, 8)}`,
        JSON.stringify({ code: `T09${policyId.slice(0, 8)}` }),
        JSON.stringify({ kind: "monthly" }),
      ],
    );
    await client.query(
      `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                                 period_start, period_end, pay_date, created_by)
       VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, 'tl09-test')`,
      [runId, forTenant, entityId, policyId, `${month}-01`, `${month}-28`],
    );
    for (const step of RUN_STEPS)
      await client.query(`UPDATE payroll_runs SET ${step} WHERE id = $1`, [
        runId,
      ]);
  });
  return { tenantId: forTenant, runId, month };
}

const fixtureSlip = cafeLegendPayrollFixtures.payslips[0]!;

/** Multiply every `...Idr` amount: keeps the payslip arithmetic consistent. */
function scale(value: unknown, factor: number): unknown {
  if (Array.isArray(value)) return value.map((entry) => scale(entry, factor));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key.endsWith("Idr") && typeof entry === "number"
          ? entry * factor
          : scale(entry, factor),
      ]),
    );
  return value;
}

function calculationFor(
  world: World,
  employeeId: string,
  outlet: string,
  factor: number,
) {
  const base = Object.fromEntries(
    Object.entries(fixtureSlip).filter(
      ([field]) =>
        ![
          "id",
          "tenantId",
          "payrollRunId",
          "fileUrl",
          "viewedAt",
          "createdAt",
        ].includes(field),
    ),
  );
  return {
    ...(scale(base, factor) as Record<string, unknown>),
    employeeId,
    outletId: outlet,
    periodStart: `${world.month}-01`,
    periodEnd: `${world.month}-28`,
    payDate: `${world.month}-28`,
  } as Record<string, unknown> & {
    grossIdr: number;
    deductionsIdr: number;
    netIdr: number;
    lines: { componentCode: string; name: string; amountIdr: number }[];
  };
}

async function seedPayslip(
  world: World,
  employeeId: string,
  outlet: string,
  factor: number,
) {
  const id = randomUUID();
  const calculation = calculationFor(world, employeeId, outlet, factor);
  await withOwner(world.tenantId, (client) =>
    client.query(
      `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id, payment_method,
                             calculation_encrypted, pii_key_version)
       VALUES ($1, $2, $3, $4, 'bank_transfer', $5, $6)`,
      [
        id,
        world.tenantId,
        world.runId,
        employeeId,
        sealPayrollValue(JSON.stringify(calculation), {
          tenantId: world.tenantId,
          table: "payslips",
          rowId: id,
          field: "calculation",
        }),
        PAYROLL_SEAL_KEY_VERSION,
      ],
    ),
  );
  return { id, calculation };
}

async function seedEmployee(
  forTenant: string,
  outlet: string,
  userId: string | null,
) {
  const id = randomUUID();
  seeded.employees.push({ tenantId: forTenant, id });
  await withOwner(forTenant, (client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan TL09', $5, 'pkwtt', '2025-03-01', 'active')`,
      [id, forTenant, userId, `T9-${id.slice(0, 8).toUpperCase()}`, outlet],
    ),
  );
  return id;
}

const GOOD_PIN = "739104";
const WRONG_PIN = "111222";
const idempotency = () => `tl09-${randomUUID()}`;

type Staff = {
  userId: string;
  employeeId: string;
  client: ReturnType<typeof agent>;
};

/** A signed-in employee (employee template role at the outlet, no MFA). */
async function makeStaff(options: { pin?: string } = {}): Promise<Staff> {
  const client = agent(pinApp);
  await signUp(client, "Staf TL09");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  created.users.push(userId);
  await grantTemplateRole(userId, "employee", { type: "outlet", id: outletA });
  const employeeId = await seedEmployee(tenantId, outletA, userId);
  if (options.pin) {
    const res = await client
      .put("/api/hris/me/payslip-pin")
      .set(originHeader)
      .send({ pin: options.pin, idempotencyKey: idempotency() });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  return { userId, employeeId, client };
}

async function ctxOf(
  userId: string,
  now: Date = new Date(),
): Promise<AiToolContext> {
  const data = await loadTenantAccess(workerContext, userId);
  return {
    access: resolveAccessSnapshot({
      tenant,
      userId,
      ...data,
      mfaVerified: false,
      now,
    }),
    channel: "tanya_ai",
    mcpClientId: null,
    now,
  };
}

async function callTool(
  userId: string,
  input: Record<string, unknown>,
  now?: Date,
) {
  const handler = readToolsB["TL-09"];
  if (!handler) throw new Error("No handler for TL-09");
  return handler(await ctxOf(userId, now), input);
}

/** Opens the payslip on the screen with the PIN (writes audit payslip.viewed). */
async function unlock(staff: Staff, payslipId: string, pin: string) {
  return staff.client
    .post(`/api/hris/me/payslips/${payslipId}/view`)
    .set(originHeader)
    .send({ pin, idempotencyKey: idempotency() });
}

/** A staff member with a PIN, a slip in `world`, and (optionally) the slip opened. */
async function staffWithSlip(
  world: World,
  factor: number,
  options: { pin?: string; open?: boolean } = {},
) {
  const staff = await makeStaff(
    options.pin === undefined ? { pin: GOOD_PIN } : { pin: options.pin },
  );
  const slip = await seedPayslip(world, staff.employeeId, outletA, factor);
  if (options.open) {
    const res = await unlock(staff, slip.id, GOOD_PIN);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  return { staff, slip };
}

function parseOut(raw: unknown) {
  return AI_TOOL_IO["TL-09"].output.parse(raw);
}

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, entry]) => [
      key,
      ...keysOf(entry),
    ]);
  return [];
}

// ---- shared worlds ------------------------------------------------------------

let mine: Staff;
let colleague: Staff;
let ownWorld: World; // A and a colleague both have a slip
let colleagueOnlyWorld: World; // only the colleague has a slip
let foreignOnlyWorld: World; // only the same login in ANOTHER tenant has a slip
let ownSlip: Awaited<ReturnType<typeof seedPayslip>>;
let colleagueSlip: Awaited<ReturnType<typeof seedPayslip>>;
let colleagueOnlySlip: Awaited<ReturnType<typeof seedPayslip>>;
let foreignSlip: Awaited<ReturnType<typeof seedPayslip>>;
let entityId: string;
let foreignTenantId: string;

beforeAll(async () => {
  const entity = await ownerPool.query<{ legal_entity_id: string }>(
    "SELECT legal_entity_id FROM outlets WHERE id = $1",
    [outletA],
  );
  entityId = entity.rows[0]!.legal_entity_id;

  mine = await makeStaff({ pin: GOOD_PIN });
  colleague = await makeStaff({ pin: "482915" });

  ownWorld = await seedWorld(tenantId, entityId, nextMonth());
  ownSlip = await seedPayslip(ownWorld, mine.employeeId, outletA, 1);
  colleagueSlip = await seedPayslip(ownWorld, colleague.employeeId, outletA, 3);
  for (const [staff, slip, pin] of [
    [mine, ownSlip, GOOD_PIN],
    [colleague, colleagueSlip, "482915"],
  ] as const) {
    const res = await unlock(staff, slip.id, pin);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  colleagueOnlyWorld = await seedWorld(tenantId, entityId, nextMonth());
  colleagueOnlySlip = await seedPayslip(
    colleagueOnlyWorld,
    colleague.employeeId,
    outletA,
    5,
  );
  {
    const res = await unlock(colleague, colleagueOnlySlip.id, "482915");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  // The same login is also an employee of another tenant with a bigger slip.
  const foreign = await createIsolatedTenant(
    `tl09${randomUUID().replaceAll("-", "").slice(0, 8)}`,
  );
  foreignTenantId = foreign.tenantId;
  seeded.entities.push(foreign.legalEntityId);
  const foreignEmployee = await seedEmployee(
    foreign.tenantId,
    foreign.outletId,
    mine.userId,
  );
  foreignOnlyWorld = await seedWorld(
    foreign.tenantId,
    foreign.legalEntityId,
    nextMonth(),
  );
  foreignSlip = await seedPayslip(
    foreignOnlyWorld,
    foreignEmployee,
    foreign.outletId,
    7,
  );
}, 120_000);

afterAll(async () => {
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const run of seeded.runs)
      await client.query("DELETE FROM payslips WHERE payroll_run_id = $1", [
        run,
      ]);
    await client.query(
      "DELETE FROM payslip_pins WHERE employee_id = ANY($1::uuid[])",
      [seeded.employees.map((e) => e.id)],
    );
    await client.query("DELETE FROM payroll_runs WHERE id = ANY($1::uuid[])", [
      seeded.runs,
    ]);
    await client.query(
      "DELETE FROM payroll_policies WHERE id = ANY($1::uuid[])",
      [seeded.policies],
    );
    await client.query("DELETE FROM hris_idempotency WHERE key LIKE 'tl09-%'");
    await client.query("DELETE FROM employees WHERE id = ANY($1::uuid[])", [
      seeded.employees.map((e) => e.id),
    ]);
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
  } finally {
    client.release();
  }
  await cleanupAcceptance().catch(() => undefined);
  await ownerPool
    .query('DELETE FROM "user" WHERE id = ANY($1::text[])', [created.users])
    .catch(() => undefined);
  await ownerPool.end();
});

void asTenant;
void foreignTenantId;

// ---- tests ----------------------------------------------------------------------

const forbidden = { code: "AI_TOOL_FORBIDDEN" };

describe("TL-09 get_my_payslip", () => {
  it("is registered", () => {
    expect(readToolsB["TL-09"]).toBeTypeOf("function");
  });

  it("returns the caller's own slip for the month after the PIN unlock", async () => {
    const out = parseOut(
      await callTool(mine.userId, { payrollMonth: ownWorld.month }),
    );
    expect(out.payslipId).toBe(ownSlip.id);
    expect(out.month).toBe(ownWorld.month);
    expect(out.grossIdr).toBe(ownSlip.calculation.grossIdr);
    expect(out.deductionsIdr).toBe(ownSlip.calculation.deductionsIdr);
    expect(out.netIdr).toBe(ownSlip.calculation.netIdr);
    expect(out.lines.map((l) => l.amountIdr).sort()).toEqual(
      ownSlip.calculation.lines.map((l) => l.amountIdr).sort(),
    );
  });

  it("has no employee, user, slip or PIN input in the contract", () => {
    for (const extra of ["employeeId", "userId", "payslipId", "pin"])
      expect(() =>
        AI_TOOL_IO["TL-09"].input.parse({
          payrollMonth: ownWorld.month,
          [extra]: randomUUID(),
        }),
      ).toThrow();
  });

  it("a colleague's unlock does not open my slip, and mine shows only mine", async () => {
    // Same run, same month: X has not opened the slip, Y has (Y's slip is x3).
    const x = await staffWithSlip(ownWorld, 2);
    const y = await staffWithSlip(ownWorld, 3, { open: true });
    await expect(
      callTool(x.staff.userId, { payrollMonth: ownWorld.month }),
    ).rejects.toMatchObject(forbidden);
    // After X opens their own slip, X gets X's slip, never Y's.
    expect((await unlock(x.staff, x.slip.id, GOOD_PIN)).status).toBe(200);
    const out = parseOut(
      await callTool(x.staff.userId, { payrollMonth: ownWorld.month }),
    );
    expect(out.payslipId).toBe(x.slip.id);
    expect(out.netIdr).toBe(x.slip.calculation.netIdr);
    const text = JSON.stringify(out);
    expect(text).not.toContain(y.slip.id);
    expect(text).not.toContain(String(y.slip.calculation.netIdr));
  });

  it("refuses a month where only a colleague has a slip (even opened by them), and leaks nothing", async () => {
    const error = await callTool(mine.userId, {
      payrollMonth: colleagueOnlyWorld.month,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect(error).toMatchObject(forbidden);
    const text = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(text).not.toContain(colleagueOnlySlip.id);
    expect(text).not.toContain(String(colleagueOnlySlip.calculation.netIdr));
  });

  it("refuses a month where only the same login in another tenant has a slip", async () => {
    const error = await callTool(mine.userId, {
      payrollMonth: foreignOnlyWorld.month,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect(error).toMatchObject(forbidden);
    const text = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(text).not.toContain(foreignSlip.id);
    expect(text).not.toContain(String(foreignSlip.calculation.netIdr));
  });

  it("refuses a month with no slip at all", async () => {
    await expect(
      callTool(mine.userId, { payrollMonth: "2999-01" }),
    ).rejects.toMatchObject(forbidden);
  });

  it("output carries no raw PII (rekening, NIK, NPWP), no name or number, no other person's data", async () => {
    const out = parseOut(
      await callTool(mine.userId, { payrollMonth: ownWorld.month }),
    );
    for (const key of keysOf(out))
      expect(key).not.toMatch(/nik|npwp|bank|account|rekening|pin|name/i);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/\d{10,}/);
    expect(text).not.toContain(colleague.employeeId);
    expect(text).not.toContain(String(fixtureSlip.employeeName));
    expect(text).not.toContain(String(fixtureSlip.employeeNo));
  });

  describe("PIN gate (set PIN + payslip opened with it in the last 10 minutes)", () => {
    it("refuses when the slip was never opened (PIN set, same month)", async () => {
      const world = await seedWorld(tenantId, entityId, nextMonth());
      const { staff, slip } = await staffWithSlip(world, 1);
      const error = await callTool(staff.userId, {
        payrollMonth: world.month,
      }).catch((e: unknown) => e);
      expect(error).toMatchObject(forbidden);
      expect(
        JSON.stringify(error, Object.getOwnPropertyNames(error)),
      ).not.toContain(String(slip.calculation.netIdr));
    });

    it("a wrong PIN on the screen does not unlock the tool", async () => {
      const world = await seedWorld(tenantId, entityId, nextMonth());
      const { staff, slip } = await staffWithSlip(world, 1);
      expect((await unlock(staff, slip.id, WRONG_PIN)).status).toBe(403);
      await expect(
        callTool(staff.userId, { payrollMonth: world.month }),
      ).rejects.toMatchObject(forbidden);
    });

    it("refuses an employee who never set a payslip PIN", async () => {
      const world = await seedWorld(tenantId, entityId, nextMonth());
      const { staff, slip } = await staffWithSlip(world, 1, { pin: "" });
      void slip;
      await expect(
        callTool(staff.userId, { payrollMonth: world.month }),
      ).rejects.toMatchObject(forbidden);
    });

    it("an unlock opens only that payslip, not another month of the same employee", async () => {
      const first = await seedWorld(tenantId, entityId, nextMonth());
      const second = await seedWorld(tenantId, entityId, nextMonth());
      const { staff } = await staffWithSlip(first, 1, { open: true });
      await seedPayslip(second, staff.employeeId, outletA, 4);
      expect(
        parseOut(await callTool(staff.userId, { payrollMonth: first.month }))
          .month,
      ).toBe(first.month);
      await expect(
        callTool(staff.userId, { payrollMonth: second.month }),
      ).rejects.toMatchObject(forbidden);
    });

    it("the unlock expires after 10 minutes", async () => {
      const world = await seedWorld(tenantId, entityId, nextMonth());
      const { staff } = await staffWithSlip(world, 1, { open: true });
      const now = new Date();
      expect(
        parseOut(
          await callTool(
            staff.userId,
            { payrollMonth: world.month },
            new Date(now.getTime() + 5 * 60_000),
          ),
        ).month,
      ).toBe(world.month);
      await expect(
        callTool(
          staff.userId,
          { payrollMonth: world.month },
          new Date(now.getTime() + 11 * 60_000),
        ),
      ).rejects.toMatchObject(forbidden);
    });

    it("a locked PIN closes the tool even after a recent unlock", async () => {
      const world = await seedWorld(tenantId, entityId, nextMonth());
      const { staff, slip } = await staffWithSlip(world, 1, { open: true });
      for (let attempt = 0; attempt < PAYSLIP_PIN_MAX_ATTEMPTS; attempt += 1)
        await unlock(staff, slip.id, WRONG_PIN);
      await expect(
        callTool(staff.userId, { payrollMonth: world.month }),
      ).rejects.toMatchObject(forbidden);
    });

    it("refuses a caller without the employee role", async () => {
      const client = agent(pinApp);
      await signUp(client, "Tanpa Peran TL09");
      const session = await client.get("/api/auth/get-session");
      const userId = session.body.user.id as string;
      created.users.push(userId);
      await expect(
        callTool(userId, { payrollMonth: ownWorld.month }),
      ).rejects.toMatchObject(forbidden);
    });
  });
});
