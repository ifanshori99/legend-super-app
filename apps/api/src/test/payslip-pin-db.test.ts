// Payslip PIN over HTTP (bead legend-2ap3, PRD v1.7 §3 D.30 "Slip Gaji
// dilindungi PIN"; contract in packages/shared/src/hris/payroll). Written from
// the brief, independent of the implementation. Runs the real Better Auth, the
// RBAC resolver and PostgreSQL against the seeded Cafe Legend tenant; the
// payslip router is mounted under `/api/hris` in a small wrapper app because
// the lead mounts it in routes/index.ts, and the wrapper lets us inject the fake
// WhatsApp sender.
//
// Assumptions (the spec leaves these open):
//  - A malformed body (PIN not 6 digits, missing reason) is answered 422, as
//    for every other HRIS route (hris-api.test.ts TEN-02).
//  - The attempt that makes the 5th failure answers 403 or 423; every later
//    attempt, even with the right PIN, answers 423 PAYSLIP_PIN_LOCKED.
//  - Set/change/reset/OTP writes answer 200 or 201.
//  - HR reset needs a payroll admin permission; the HR actor holds the whole
//    payroll set (view/run/approve/lock) plus hr.employee.manage so the test
//    does not depend on which of them the route picks.
//  - `reset-otp` takes `{ idempotencyKey }`; the number it sends to is the
//    employee's verified WhatsApp identity (user_identities, sealed as
//    identity-account.service does: AAD `user_identity:whatsapp:<hash>`).
//  - A wrong/expired/reused OTP code answers a 4xx (exact code left open);
//    the PIN must stay unchanged and the code becomes unusable after 5 tries.
//  - A replay (same idempotency key, same body) of a WRONG PIN answers the same
//    403 without burning a second attempt (contract comment on
//    viewMyPayslipInputSchema).
//  - Lock window and column names (`failed_attempts`, `locked_until`,
//    `expires_at`, `attempts`, `consumed_at`) are the ones in the brief.
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeMessagingProvider } from "@starter/shared/adapters";
import { cafeLegendPayrollFixtures } from "@starter/shared/hris/payroll";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { requestContext } from "../lib/request-context.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { tenantContext } from "../middleware/tenant.ts";
import {
  sealPayrollValue,
  PAYROLL_SEAL_KEY_VERSION,
} from "../lib/payroll-sealed.ts";
import { hrisRequestFingerprint } from "../lib/hris-pii.ts";
import { sealSecret } from "../lib/secrets.ts";
import { createHrisPayslipRouter } from "../routes/hris-payslip.routes.ts";
import type { PayslipPinOtpSender } from "../services/payslip-pin.service.ts";
import { createPayslipPinWhatsappSender } from "../services/payslip-pin-whatsapp-sender.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const tenant = cafeLegendPlatformFixtures.tenant;
const outlet = cafeLegendPlatformFixtures.outlets[0];

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

// ------------------------------------------------------------ test app

type SentOtp = { employeeId: string; phoneE164: string; code: string };
const sentOtps: SentOtp[] = [];
/** In-memory fake of the `PayslipPinOtpSender` port: never sends anything. */
const fakeOtpSender = {
  async send(
    _context: unknown,
    message: { employeeId: string; phoneE164: string; code: string },
  ) {
    sentOtps.push({ ...message });
  },
};

const PAYSLIP_PATH =
  /^\/(me\/payslips|me\/payslip-pin|employees\/[^/]+\/payslip-pin)/;

function buildApp(
  deps: { otpSender?: PayslipPinOtpSender },
  tenantId: string = tenant.id,
) {
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
  gate.use(createHrisPayslipRouter(deps));
  gate.use(errorHandler);
  const app = express();
  app.use(requestContext);
  app.use("/api/hris", (req, res, next) =>
    PAYSLIP_PATH.test(req.path) ? gate(req, res, next) : next(),
  );
  // Everything else (Better Auth sign-up, sessions) is the real app.
  app.use(createApp());
  return app;
}

const app = buildApp({ otpSender: fakeOtpSender });
const appWithoutSender = buildApp({});

// ------------------------------------------------------------ database

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdIdentities: string[] = [];

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

async function sql<R extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
  tenantId: string = tenant.id,
): Promise<R[]> {
  return asTenant(
    tenantId,
    async (client) => (await client.query(text, params)).rows as R[],
  );
}

// Payroll world: policy + a LOCKED run (payslips only exist for locked runs).
const RUN_STEPS = [
  `status = 'simulated'`,
  `status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now()`,
  `status = 'approved', approved_by_finance = 'finance-user', approved_by_finance_at = now()`,
  `status = 'locked', config_snapshot = '{"v":1}', totals = '{"t":1}', locked_by = 'lock-user', locked_at = now()`,
];

type World = {
  tenantId: string;
  entityId: string;
  policyId: string;
  runId: string;
};

async function seedPayrollWorld(
  tenantId: string,
  entityId: string,
): Promise<World> {
  const policyId = randomUUID();
  const runId = randomUUID();
  const day = (n: number) =>
    new Date(Date.UTC(2031, 0, 1 + n)).toISOString().slice(0, 10);
  const offset = Math.floor(Math.random() * 3000);
  await asTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                     employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan PIN', $4, $5, $6, 'none', 'low', '[]')`,
      [
        policyId,
        tenantId,
        entityId,
        `PIN${policyId.slice(0, 8)}`,
        JSON.stringify({ code: `PIN${policyId.slice(0, 8)}` }),
        JSON.stringify({ kind: "monthly" }),
      ],
    );
    await client.query(
      `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                                 period_start, period_end, pay_date, created_by)
       VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, 'payslip-pin-test')`,
      [runId, tenantId, entityId, policyId, day(offset), day(offset + 1)],
    );
    for (const step of RUN_STEPS)
      await client.query(`UPDATE payroll_runs SET ${step} WHERE id = $1`, [
        runId,
      ]);
  });
  return { tenantId, entityId, policyId, runId };
}

// The sealed calculation is the fixture payslip without its row-level fields.
const baseCalculation: Record<string, unknown> & { netIdr: number } =
  Object.fromEntries(
    Object.entries(cafeLegendPayrollFixtures.payslips[0]!).filter(
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
  ) as Record<string, unknown> & { netIdr: number };

/** A sealed payslip of `employeeId` in the locked run; returns its id and net. */
async function seedPayslip(
  world: World,
  employeeId: string,
  outletId: string,
): Promise<{ id: string; netIdr: number }> {
  const id = randomUUID();
  const calculation = { ...baseCalculation, employeeId, outletId };
  const sealed = sealPayrollValue(JSON.stringify(calculation), {
    tenantId: world.tenantId,
    table: "payslips",
    rowId: id,
    field: "calculation",
  });
  await sql(
    `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id, payment_method,
                           calculation_encrypted, pii_key_version)
     VALUES ($1, $2, $3, $4, 'bank_transfer', $5, $6)`,
    [
      id,
      world.tenantId,
      world.runId,
      employeeId,
      sealed,
      PAYROLL_SEAL_KEY_VERSION,
    ],
    world.tenantId,
  );
  return { id, netIdr: calculation.netIdr };
}

// ------------------------------------------------------------ users

type Client = ReturnType<typeof agent>;

async function signedInClient(
  name: string,
  options: { mfa?: boolean; app?: ReturnType<typeof buildApp> } = {},
) {
  const client = agent(options.app ?? app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  if (options.mfa) await verifySessionMfa(email);
  return { client, userId };
}

async function grantCustomRole(
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await sql(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenant.id,
      `Payslip PIN ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify([scope.type]),
    ],
  );
  await sql(
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

async function seedEmployee(userId: string | null, tenantId = tenant.id) {
  const id = randomUUID();
  createdEmployees.push(id);
  await sql(
    `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                            employment_type, join_date, status)
     VALUES ($1, $2, $3, $4, 'Karyawan Slip PIN', $5, 'pkwtt', '2025-03-01', 'active')`,
    [id, tenantId, userId, `SP-${id.slice(0, 8).toUpperCase()}`, outlet.id],
    tenantId,
  );
  return id;
}

/** The employee's verified WhatsApp number (the OTP target; see assumptions). */
async function seedWhatsapp(userId: string): Promise<string> {
  const digits = `62812${Array.from(randomBytes(8), (b) => b % 10).join("")}`;
  const hash = randomBytes(32).toString("hex");
  const id = randomUUID();
  createdIdentities.push(id);
  await owner.query(
    `INSERT INTO user_identities (id, user_id, type, value_hash, value_encrypted, verified_at)
     VALUES ($1, $2, 'whatsapp', $3, $4, now())`,
    [
      id,
      userId,
      hash,
      sealSecret(`+${digits}`, `user_identity:whatsapp:${hash}`),
    ],
  );
  return `+${digits}`;
}

type Staff = {
  client: Client;
  userId: string;
  employeeId: string;
  payslipId: string;
  netIdr: number;
  phone: string;
};

let world: World;
let otherWorld: World; // a different tenant
let otherTenantPayslipId: string;
let otherOutletId: string;
const otherRoles: string[] = [];
let hr: { client: Client; userId: string };

/** A fresh employee with a login, a payslip and a WhatsApp number. */
async function makeStaff(
  permissions: string[] = ["self.payslip.view", "self.profile.view"],
  onApp: ReturnType<typeof buildApp> = app,
  roleOutletId: string = outlet.id,
): Promise<Staff> {
  const { client, userId } = await signedInClient("Staf Slip PIN", {
    app: onApp,
  });
  await grantCustomRole(userId, permissions, {
    type: "outlet",
    id: roleOutletId,
  });
  const employeeId = await seedEmployee(userId);
  const payslip = await seedPayslip(world, employeeId, outlet.id);
  const phone = await seedWhatsapp(userId);
  return {
    client,
    userId,
    employeeId,
    payslipId: payslip.id,
    netIdr: payslip.netIdr,
    phone,
  };
}

// ------------------------------------------------------------ requests

const key = () => `ps-pin-${randomUUID()}`;
const GOOD = "739104";
const OTHER = "580263";
const WRONG = "111222";
const NEW_PIN = "264801";

const STATUS = "/api/hris/me/payslip-pin";
const viewPath = (payslipId: string) =>
  `/api/hris/me/payslips/${payslipId}/view`;

const setPin = (
  client: Client,
  body: { pin: string; currentPin?: string; idempotencyKey?: string },
  app_: Client = client,
) =>
  app_
    .put(STATUS)
    .set(originHeader)
    .send({ idempotencyKey: key(), ...body });

const view = (
  client: Client,
  payslipId: string,
  pin: string,
  idempotencyKey: string = key(),
) =>
  client
    .post(viewPath(payslipId))
    .set(originHeader)
    .send({ pin, idempotencyKey });

const pinStatus = async (client: Client) => {
  const response = await client.get(STATUS);
  expect(response.status).toBe(200);
  return response.body.data as {
    status: "not_set" | "active" | "locked";
    lockedUntil: string | null;
  };
};

const hrReset = (employeeId: string, body: object = {}) =>
  hr.client
    .post(`/api/hris/employees/${employeeId}/payslip-pin/reset`)
    .set(originHeader)
    .send({ reason: "Karyawan lupa PIN", idempotencyKey: key(), ...body });

const requestOtp = (client: Client) =>
  client
    .post(`${STATUS}/reset-otp`)
    .set(originHeader)
    .send({ idempotencyKey: key() });

const verifyOtp = (
  client: Client,
  body: { code: string; pin: string; idempotencyKey?: string },
) =>
  client
    .post(`${STATUS}/reset-otp/verify`)
    .set(originHeader)
    .send({ idempotencyKey: key(), ...body });

const ok = (status: number) => [200, 201].includes(status);

async function pinRow(employeeId: string) {
  const rows = await sql<{
    failed_attempts: number;
    locked_until: Date | null;
    pin_hash: unknown;
  }>(
    `SELECT failed_attempts, locked_until, pin_hash FROM payslip_pins
      WHERE tenant_id = $1 AND employee_id = $2`,
    [tenant.id, employeeId],
  );
  return rows[0] ?? null;
}

async function viewedAt(payslipId: string) {
  const rows = await sql<{ viewed_at: Date | null }>(
    "SELECT viewed_at FROM payslips WHERE tenant_id = $1 AND id = $2",
    [tenant.id, payslipId],
  );
  return rows[0]!.viewed_at;
}

async function audits(action: string, actorId: string) {
  return sql<{ raw: string; sensitive: boolean | null; reason: string | null }>(
    `SELECT event::text AS raw,
            (event->>'sensitiveAccess')::boolean AS sensitive,
            event->>'reason' AS reason
       FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'actorId' = $3`,
    [tenant.id, action, actorId],
  );
}

async function challenges(employeeId: string) {
  return sql<{
    code_hash: string;
    attempts: number;
    consumed_at: Date | null;
  }>(
    `SELECT code_hash, attempts, consumed_at FROM payslip_pin_reset_challenges
      WHERE tenant_id = $1 AND employee_id = $2 ORDER BY created_at`,
    [tenant.id, employeeId],
  );
}

const lastCode = (employeeId: string) => {
  const sent = [...sentOtps].reverse().find((s) => s.employeeId === employeeId);
  if (!sent) throw new Error("No OTP was sent");
  return sent.code;
};

/** Fails the PIN `times` times in a row. */
async function failTimes(staff: Staff, times: number) {
  for (let i = 0; i < times; i += 1)
    await view(staff.client, staff.payslipId, WRONG);
}

// ------------------------------------------------------------ lifecycle

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");

  // Tenant A (the fixture tenant): its own legal entity and locked run.
  const entityId = randomUUID();
  await sql(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Slip PIN', false)`,
    [entityId, tenant.id],
  );
  world = await seedPayrollWorld(tenant.id, entityId);

  // Tenant B: a disposable tenant with one employee and one payslip.
  const otherTenantId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Slip PIN tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenantId, `slip-pin-b-${otherTenantId.slice(0, 8)}`, tenant.id],
  );
  const otherBrand = randomUUID();
  const otherEntity = randomUUID();
  const otherOutlet = randomUUID();
  otherOutletId = otherOutlet;
  await asTenant(otherTenantId, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand')`,
      [otherBrand, otherTenantId],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT B', false)`,
      [otherEntity, otherTenantId],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'B-01', 'Outlet B', 'Jl. B', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [otherOutlet, otherTenantId, otherBrand, otherEntity],
    );
  });
  otherWorld = await seedPayrollWorld(otherTenantId, otherEntity);
  const otherEmployee = randomUUID();
  await sql(
    `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                            employment_type, join_date, status)
     VALUES ($1, $2, 'SPB-1', 'Karyawan Tenant B', $3, 'pkwtt', '2025-03-01', 'active')`,
    [otherEmployee, otherTenantId, otherOutlet],
    otherTenantId,
  );
  otherTenantPayslipId = (
    await seedPayslip(otherWorld, otherEmployee, otherOutlet)
  ).id;

  hr = await signedInClient("HR Slip PIN", { mfa: true });
  await grantCustomRole(
    hr.userId,
    [
      "hr.employee.manage",
      "hr.employee.view",
      "payroll.view",
      "payroll.run",
      "payroll.approve",
      "payroll.lock",
    ],
    { type: "tenant" },
  );
});

afterAll(async () => {
  // Best effort: locked runs and payslips are immutable by design, so the
  // owner skips triggers for the cleanup only.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const w of [world, otherWorld]) {
      if (!w) continue;
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        w.tenantId,
      ]);
      for (const table of ["payslip_pin_reset_challenges", "payslip_pins"])
        await client
          .query(`DELETE FROM ${table} WHERE tenant_id = $1`, [w.tenantId])
          .catch(() => undefined);
      await client.query(`DELETE FROM payslips WHERE payroll_run_id = $1`, [
        w.runId,
      ]);
      await client.query(`DELETE FROM payroll_runs WHERE id = $1`, [w.runId]);
      await client.query(`DELETE FROM payroll_policies WHERE id = $1`, [
        w.policyId,
      ]);
    }
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      tenant.id,
    ]);
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'ps-pin-%'",
      [tenant.id],
    );
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdRoles],
    );
    if (world)
      await client.query(
        "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = $2",
        [tenant.id, world.entityId],
      );
    if (otherWorld) {
      // Savepoint: tenant B may now hold append-only audit rows (the OTP
      // isolation test), which can block dropping it; that must not undo the
      // tenant A cleanup above (disposable DB).
      await client.query("SAVEPOINT drop_tenant_b");
      try {
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [
          otherWorld.tenantId,
        ]);
        await client.query(
          "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
          [otherWorld.tenantId, createdUsers],
        );
        await client.query(
          "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
          [otherWorld.tenantId, otherRoles],
        );
        for (const table of [
          "employees",
          "outlets",
          "legal_entities",
          "brands",
        ])
          await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
            otherWorld.tenantId,
          ]);
        await client.query("DELETE FROM tenants WHERE id = $1", [
          otherWorld.tenantId,
        ]);
      } catch {
        await client.query("ROLLBACK TO SAVEPOINT drop_tenant_b");
      }
    }
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
  } finally {
    client.release();
  }
  await owner
    .query("DELETE FROM user_identities WHERE id = ANY($1::uuid[])", [
      createdIdentities,
    ])
    .catch(() => undefined);
  await owner
    .query('DELETE FROM "user" WHERE id = ANY($1::text[])', [createdUsers])
    .catch(() => undefined);
  await owner.end();
});

// ------------------------------------------------------------ tests

describe("payslip PIN: set, status and change", () => {
  it("is not set at first; first set needs no current PIN; status becomes active", async () => {
    const staff = await makeStaff();
    expect(await pinStatus(staff.client)).toEqual({
      status: "not_set",
      lockedUntil: null,
    });
    const set = await setPin(staff.client, { pin: GOOD });
    expect(ok(set.status)).toBe(true);
    expect(await pinStatus(staff.client)).toEqual({
      status: "active",
      lockedUntil: null,
    });
    const audit = await audits("payslip_pin.set", staff.userId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.raw).not.toContain(GOOD);
  });

  it("answers 401 without a session", async () => {
    const response = await agent(app).get(STATUS);
    expect(response.status).toBe(401);
  });

  it("answers 422 for a PIN that is not 6 digits", async () => {
    const staff = await makeStaff();
    for (const pin of ["12345", "1234567", "12a456", ""]) {
      const response = await setPin(staff.client, { pin });
      expect(response.status).toBe(422);
    }
    expect((await pinStatus(staff.client)).status).toBe("not_set");
  });

  it("changing the PIN needs the current PIN; a wrong one counts as a failed attempt", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });

    const missing = await setPin(staff.client, { pin: NEW_PIN });
    expect(missing.status).toBeGreaterThanOrEqual(400);

    const wrong = await setPin(staff.client, {
      pin: NEW_PIN,
      currentPin: WRONG,
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe("PAYSLIP_PIN_INVALID");
    expect((await pinRow(staff.employeeId))?.failed_attempts).toBe(1);

    const changed = await setPin(staff.client, {
      pin: NEW_PIN,
      currentPin: GOOD,
    });
    expect(ok(changed.status)).toBe(true);
    expect((await pinRow(staff.employeeId))?.failed_attempts).toBe(0);

    // The old PIN no longer opens the payslip, the new one does.
    expect((await view(staff.client, staff.payslipId, GOOD)).status).toBe(403);
    expect((await view(staff.client, staff.payslipId, NEW_PIN)).status).toBe(
      200,
    );
    const audit = await audits("payslip_pin.changed", staff.userId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.raw).not.toContain(GOOD);
    expect(audit[0]!.raw).not.toContain(NEW_PIN);
  });

  it("a locked employee cannot change the PIN either (423)", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });
    await failTimes(staff, 5);
    const response = await setPin(staff.client, {
      pin: NEW_PIN,
      currentPin: GOOD,
    });
    expect(response.status).toBe(423);
    expect(response.body.error.code).toBe("PAYSLIP_PIN_LOCKED");
  });
});

describe("payslip PIN: viewing a payslip", () => {
  it("answers 409 PAYSLIP_PIN_NOT_SET before a PIN exists", async () => {
    const staff = await makeStaff();
    const response = await view(staff.client, staff.payslipId, GOOD);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("PAYSLIP_PIN_NOT_SET");
    expect(await viewedAt(staff.payslipId)).toBeNull();
  });

  it("opens the payslip with the right PIN, sets viewedAt once and audits it as sensitive", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });
    expect(await viewedAt(staff.payslipId)).toBeNull();

    const first = await view(staff.client, staff.payslipId, GOOD);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      id: staff.payslipId,
      netIdr: staff.netIdr,
      fileUrl: null,
    });
    expect(first.body.data.viewedAt).not.toBeNull();
    const stamped = await viewedAt(staff.payslipId);
    expect(stamped).not.toBeNull();

    // A second view (new key) keeps the first-view timestamp.
    const second = await view(staff.client, staff.payslipId, GOOD);
    expect(second.status).toBe(200);
    expect((await viewedAt(staff.payslipId))?.toISOString()).toBe(
      stamped!.toISOString(),
    );

    const audit = await audits("payslip.viewed", staff.userId);
    expect(audit.length).toBeGreaterThanOrEqual(1);
    for (const row of audit) {
      expect(row.sensitive).toBe(true);
      expect(row.raw).not.toContain(GOOD);
      expect(row.raw).not.toContain(String(staff.netIdr));
    }
  });

  it("a wrong PIN answers 403 PAYSLIP_PIN_INVALID and counts; the right PIN resets the counter", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });

    for (const n of [1, 2, 3]) {
      const wrong = await view(staff.client, staff.payslipId, WRONG);
      expect(wrong.status).toBe(403);
      expect(wrong.body.error.code).toBe("PAYSLIP_PIN_INVALID");
      expect((await pinRow(staff.employeeId))?.failed_attempts).toBe(n);
    }
    expect(await viewedAt(staff.payslipId)).toBeNull();
    expect((await pinStatus(staff.client)).status).toBe("active");

    const good = await view(staff.client, staff.payslipId, GOOD);
    expect(good.status).toBe(200);
    expect((await pinRow(staff.employeeId))?.failed_attempts).toBe(0);
  });

  it("the 5th wrong PIN locks for 15 minutes: even the right PIN answers 423", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });

    for (let i = 0; i < 4; i += 1) {
      const wrong = await view(staff.client, staff.payslipId, WRONG);
      expect(wrong.status).toBe(403);
    }
    const fifth = await view(staff.client, staff.payslipId, WRONG);
    expect([403, 423]).toContain(fifth.status);

    const locked = await view(staff.client, staff.payslipId, GOOD);
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe("PAYSLIP_PIN_LOCKED");
    expect(await viewedAt(staff.payslipId)).toBeNull();

    const status = await pinStatus(staff.client);
    expect(status.status).toBe("locked");
    const minutes =
      (new Date(status.lockedUntil!).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(13);
    expect(minutes).toBeLessThanOrEqual(15.5);

    const audit = await audits("payslip_pin.locked", staff.userId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.raw).not.toContain(GOOD);
    expect(audit[0]!.raw).not.toContain(WRONG);
  });

  it("the lock expires after 15 minutes and the right PIN works again", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });
    await failTimes(staff, 5);
    expect((await view(staff.client, staff.payslipId, GOOD)).status).toBe(423);

    // Move the lock into the past, as if 15 minutes went by.
    await sql(
      `UPDATE payslip_pins SET locked_until = now() - interval '1 minute'
        WHERE tenant_id = $1 AND employee_id = $2`,
      [tenant.id, staff.employeeId],
    );
    expect((await pinStatus(staff.client)).status).toBe("active");
    const again = await view(staff.client, staff.payslipId, GOOD);
    expect(again.status).toBe(200);
    expect((await pinRow(staff.employeeId))?.failed_attempts).toBe(0);
  });

  it("a malformed PIN is 422 and burns no attempt", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });
    const response = await view(staff.client, staff.payslipId, "12");
    expect(response.status).toBe(422);
    expect((await pinRow(staff.employeeId))?.failed_attempts).toBe(0);
  });

  it("an employee without self.payslip.view is refused (403)", async () => {
    const staff = await makeStaff(["self.profile.view"]);
    const response = await view(staff.client, staff.payslipId, GOOD);
    expect(response.status).toBe(403);
  });

  it("answers 401 without a session", async () => {
    const staff = await makeStaff();
    const response = await agent(app)
      .post(viewPath(staff.payslipId))
      .set(originHeader)
      .send({ pin: GOOD, idempotencyKey: key() });
    expect(response.status).toBe(401);
  });
});

describe("payslip PIN: ownership and tenant isolation", () => {
  it("employee A cannot view employee B's payslip: 404, same as a missing one", async () => {
    const a = await makeStaff();
    const b = await makeStaff();
    await setPin(a.client, { pin: GOOD });
    await setPin(b.client, { pin: OTHER });

    const crossed = await view(a.client, b.payslipId, GOOD);
    expect(crossed.status).toBe(404);
    expect(crossed.body.error.code).toBe("NOT_FOUND");
    const crossedWithTheirPin = await view(a.client, b.payslipId, OTHER);
    expect(crossedWithTheirPin.status).toBe(404);

    const missing = await view(a.client, randomUUID(), GOOD);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe(crossed.body.error.code);
    expect(await viewedAt(b.payslipId)).toBeNull();
  });

  it("a payslip of another tenant is 404", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });
    const response = await view(staff.client, otherTenantPayslipId, GOOD);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    const rows = await sql<{ viewed_at: Date | null }>(
      "SELECT viewed_at FROM payslips WHERE id = $1",
      [otherTenantPayslipId],
      otherWorld.tenantId,
    );
    expect(rows[0]!.viewed_at).toBeNull();
  });

  it("the list shows only the caller's own payslips and no amounts before the PIN", async () => {
    const a = await makeStaff();
    const b = await makeStaff();
    const list = await a.client.get("/api/hris/me/payslips");
    expect(list.status).toBe(200);
    const ids = (list.body.data as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(a.payslipId);
    expect(ids).not.toContain(b.payslipId);
    expect(ids).not.toContain(otherTenantPayslipId);
    expect(JSON.stringify(list.body)).not.toContain("netIdr");
    expect(JSON.stringify(list.body)).not.toContain("grossIdr");
  });
});

describe("payslip PIN: idempotent retries", () => {
  it("a retry of a wrong PIN with the same key does not burn a second attempt", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });
    const retryKey = key();
    const first = await view(staff.client, staff.payslipId, WRONG, retryKey);
    const replay = await view(staff.client, staff.payslipId, WRONG, retryKey);
    expect(first.status).toBe(403);
    expect(replay.status).toBe(403);
    expect((await pinRow(staff.employeeId))?.failed_attempts).toBe(1);
  });

  it("a retry of a good view with the same key runs a fresh check: right PIN opens again and is audited again", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });
    const retryKey = key();
    const first = await view(staff.client, staff.payslipId, GOOD, retryKey);
    const retry = await view(staff.client, staff.payslipId, GOOD, retryKey);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(await audits("payslip.viewed", staff.userId)).toHaveLength(2);
    const stored = await sql(
      "SELECT 1 FROM hris_idempotency WHERE tenant_id = $1 AND key = $2",
      [tenant.id, retryKey],
    );
    expect(stored).toHaveLength(0);
  });

  it("a successful view is never replayed: after a PIN change the old PIN with the same key is refused, no salary", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });
    const replayKey = key();
    const first = await view(staff.client, staff.payslipId, GOOD, replayKey);
    expect(first.status).toBe(200);

    await setPin(staff.client, { pin: NEW_PIN, currentPin: GOOD });
    const replay = await view(staff.client, staff.payslipId, GOOD, replayKey);
    expect(replay.status).toBe(403);
    expect(JSON.stringify(replay.body)).not.toContain(String(staff.netIdr));
    expect((await pinRow(staff.employeeId))?.failed_attempts).toBe(1);
  });

  it("a successful view is never replayed after an HR reset: 409, no salary", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });
    const replayKey = key();
    expect(
      (await view(staff.client, staff.payslipId, GOOD, replayKey)).status,
    ).toBe(200);
    expect(ok((await hrReset(staff.employeeId)).status)).toBe(true);
    const replay = await view(staff.client, staff.payslipId, GOOD, replayKey);
    expect(replay.status).toBe(409);
    expect(JSON.stringify(replay.body)).not.toContain(String(staff.netIdr));
  });

  it("the idempotency fingerprint does not carry the PIN or code under the plain HRIS HMAC", async () => {
    const staff = await makeStaff();
    const setKey = key();
    expect(
      ok(
        (await setPin(staff.client, { pin: GOOD, idempotencyKey: setKey }))
          .status,
      ),
    ).toBe(true);
    const viewKey = key();
    expect(
      (await view(staff.client, staff.payslipId, WRONG, viewKey)).status,
    ).toBe(403);
    const fingerprintOf = async (k: string) =>
      (
        await sql<{ fingerprint: string }>(
          "SELECT fingerprint FROM hris_idempotency WHERE tenant_id = $1 AND key = $2",
          [tenant.id, k],
        )
      )[0]!.fingerprint;

    expect(await fingerprintOf(viewKey)).not.toBe(
      hrisRequestFingerprint(tenant.id, {
        operation: "payslip.view",
        request: {
          actor: staff.userId,
          employeeId: staff.employeeId,
          payslipId: staff.payslipId,
          pin: WRONG,
        },
      }),
    );
    expect(await fingerprintOf(setKey)).not.toBe(
      hrisRequestFingerprint(tenant.id, {
        operation: "payslip_pin.set",
        request: {
          actor: staff.userId,
          employeeId: staff.employeeId,
          pin: GOOD,
        },
      }),
    );

    // OTP code too.
    await requestOtp(staff.client);
    const otpKey = key();
    await verifyOtp(staff.client, {
      code: "000000",
      pin: NEW_PIN,
      idempotencyKey: otpKey,
    });
    expect(await fingerprintOf(otpKey)).not.toBe(
      hrisRequestFingerprint(tenant.id, {
        operation: "payslip_pin.otp_verify",
        request: {
          actor: staff.userId,
          employeeId: staff.employeeId,
          code: "000000",
          pin: NEW_PIN,
        },
      }),
    );
  });

  it("a retried set of the PIN with the same key does not change it twice", async () => {
    const staff = await makeStaff();
    const retryKey = key();
    const first = await setPin(staff.client, {
      pin: GOOD,
      idempotencyKey: retryKey,
    });
    const replay = await setPin(staff.client, {
      pin: GOOD,
      idempotencyKey: retryKey,
    });
    expect(ok(first.status)).toBe(true);
    expect(ok(replay.status)).toBe(true);
    expect(await audits("payslip_pin.set", staff.userId)).toHaveLength(1);
    expect((await view(staff.client, staff.payslipId, GOOD)).status).toBe(200);
  });
});

describe("payslip PIN: HR reset", () => {
  it("clears the PIN and the lock; the employee must set a new PIN", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });
    await failTimes(staff, 5);
    expect((await pinStatus(staff.client)).status).toBe("locked");

    const reset = await hrReset(staff.employeeId, { reason: "Lupa PIN" });
    expect(ok(reset.status)).toBe(true);

    expect(await pinStatus(staff.client)).toEqual({
      status: "not_set",
      lockedUntil: null,
    });
    // Neither the old PIN nor any PIN opens the payslip until a new one is set.
    const blocked = await view(staff.client, staff.payslipId, GOOD);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("PAYSLIP_PIN_NOT_SET");

    // HR never chose a PIN: the employee sets a fresh one, old PIN is dead.
    expect(ok((await setPin(staff.client, { pin: NEW_PIN })).status)).toBe(
      true,
    );
    expect((await view(staff.client, staff.payslipId, GOOD)).status).toBe(403);
    expect((await view(staff.client, staff.payslipId, NEW_PIN)).status).toBe(
      200,
    );

    const audit = await audits("payslip_pin.reset", hr.userId);
    const mine = audit.filter((row) => row.reason === "Lupa PIN");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.raw).not.toContain(GOOD);
  });

  it("is refused for an employee, and for a missing reason", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });

    const self = await staff.client
      .post(`/api/hris/employees/${staff.employeeId}/payslip-pin/reset`)
      .set(originHeader)
      .send({ reason: "Saya mau reset", idempotencyKey: key() });
    expect(self.status).toBe(403);
    expect((await pinStatus(staff.client)).status).toBe("active");

    const noReason = await hr.client
      .post(`/api/hris/employees/${staff.employeeId}/payslip-pin/reset`)
      .set(originHeader)
      .send({ idempotencyKey: key() });
    expect(noReason.status).toBe(422);
    expect((await pinStatus(staff.client)).status).toBe("active");
  });

  it("answers 404 for an employee that does not exist in the tenant", async () => {
    const response = await hrReset(randomUUID());
    expect(response.status).toBe(404);
  });
});

describe("payslip PIN: reset by WhatsApp OTP", () => {
  it("without a configured sender the request answers 503 and nothing changes", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });
    // Same session cookie, app mounted without an OTP sender.
    const noSender = agent(appWithoutSender);
    const email = await signUp(noSender, "Staf Tanpa Sender");
    void email;
    const session = await noSender.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    createdUsers.push(userId);
    await grantCustomRole(userId, ["self.payslip.view", "self.profile.view"], {
      type: "outlet",
      id: outlet.id,
    });
    const employeeId = await seedEmployee(userId);
    await seedWhatsapp(userId);
    const response = await noSender
      .post(`${STATUS}/reset-otp`)
      .set(originHeader)
      .send({ idempotencyKey: key() });
    expect(response.status).toBe(503);
    expect(await challenges(employeeId)).toHaveLength(0);
  });

  it("caps code requests at 3 per employee per hour: the 4th answers 429 and adds no challenge", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });
    for (let i = 0; i < 3; i += 1)
      expect(ok((await requestOtp(staff.client)).status)).toBe(true);
    const sentBefore = sentOtps.length;
    const fourth = await requestOtp(staff.client);
    expect(fourth.status).toBe(429);
    expect(sentOtps.length).toBe(sentBefore);
    expect(await challenges(staff.employeeId)).toHaveLength(3);
  });

  it("sends a 6-digit code to the employee's WhatsApp number; the right code sets a new PIN", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });
    const before = sentOtps.length;

    const requested = await requestOtp(staff.client);
    expect(ok(requested.status)).toBe(true);
    expect(sentOtps.length).toBe(before + 1);
    const sent = sentOtps[sentOtps.length - 1]!;
    expect(sent.employeeId).toBe(staff.employeeId);
    expect(sent.phoneE164).toBe(staff.phone);
    expect(sent.code).toMatch(/^\d{6}$/);

    // The code is stored hashed only, and the request body never echoes it.
    const stored = await challenges(staff.employeeId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.code_hash).not.toContain(sent.code);
    expect(JSON.stringify(requested.body)).not.toContain(sent.code);

    const verified = await verifyOtp(staff.client, {
      code: sent.code,
      pin: NEW_PIN,
    });
    expect(ok(verified.status)).toBe(true);

    expect((await view(staff.client, staff.payslipId, GOOD)).status).toBe(403);
    expect((await view(staff.client, staff.payslipId, NEW_PIN)).status).toBe(
      200,
    );
    expect((await challenges(staff.employeeId))[0]!.consumed_at).not.toBeNull();

    for (const action of [
      "payslip_pin.otp_requested",
      "payslip_pin.otp_reset",
    ]) {
      const audit = await audits(action, staff.userId);
      expect(audit).toHaveLength(1);
      expect(audit[0]!.raw).not.toContain(sent.code);
      expect(audit[0]!.raw).not.toContain(NEW_PIN);
      expect(audit[0]!.raw).not.toContain(staff.phone);
    }
  });

  it("a wrong code is refused, counts an attempt, and the PIN stays; the right code still works", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });
    await requestOtp(staff.client);
    const code = lastCode(staff.employeeId);
    const wrongCode = code === "000000" ? "000001" : "000000";

    const wrong = await verifyOtp(staff.client, {
      code: wrongCode,
      pin: NEW_PIN,
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(wrong.status).toBeLessThan(500);
    expect((await challenges(staff.employeeId))[0]!.attempts).toBe(1);
    expect((await view(staff.client, staff.payslipId, GOOD)).status).toBe(200);

    const right = await verifyOtp(staff.client, { code, pin: NEW_PIN });
    expect(ok(right.status)).toBe(true);
  });

  it("an expired code is refused and the PIN stays", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });
    await requestOtp(staff.client);
    const code = lastCode(staff.employeeId);
    await sql(
      `UPDATE payslip_pin_reset_challenges SET expires_at = now() - interval '1 minute'
        WHERE tenant_id = $1 AND employee_id = $2`,
      [tenant.id, staff.employeeId],
    );
    const expired = await verifyOtp(staff.client, { code, pin: NEW_PIN });
    expect(expired.status).toBeGreaterThanOrEqual(400);
    expect(expired.status).toBeLessThan(500);
    expect((await view(staff.client, staff.payslipId, GOOD)).status).toBe(200);
    expect((await view(staff.client, staff.payslipId, NEW_PIN)).status).toBe(
      403,
    );
  });

  it("a code works once: reusing it is refused", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });
    await requestOtp(staff.client);
    const code = lastCode(staff.employeeId);
    expect(
      ok((await verifyOtp(staff.client, { code, pin: NEW_PIN })).status),
    ).toBe(true);
    const reused = await verifyOtp(staff.client, { code, pin: OTHER });
    expect(reused.status).toBeGreaterThanOrEqual(400);
    expect(reused.status).toBeLessThan(500);
    // The PIN from the first, valid reset is untouched by the replay.
    expect((await view(staff.client, staff.payslipId, NEW_PIN)).status).toBe(
      200,
    );
    expect((await view(staff.client, staff.payslipId, OTHER)).status).toBe(403);
  });

  it("five wrong codes burn the challenge: the right code is then refused", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });
    await requestOtp(staff.client);
    const code = lastCode(staff.employeeId);
    const wrongCode = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i += 1)
      await verifyOtp(staff.client, { code: wrongCode, pin: NEW_PIN });
    const late = await verifyOtp(staff.client, { code, pin: NEW_PIN });
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(late.status).toBeLessThan(500);
    expect((await view(staff.client, staff.payslipId, GOOD)).status).toBe(200);
  });

  it("verify with a malformed new PIN is 422", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });
    await requestOtp(staff.client);
    const response = await verifyOtp(staff.client, {
      code: lastCode(staff.employeeId),
      pin: "12",
    });
    expect(response.status).toBe(422);
  });
});

// legend-qih2m: the REAL WhatsApp adapter over FakeMessagingProvider (nothing
// is ever sent). Assumptions: the message text carries the 6-digit code once
// and "5 menit"; the recipient is the seeded number without the "+"; the 4th
// request in an hour is 429 (existing cap test) and no 4th message is sent.
// The 503-without-provider case is already covered above ("without a
// configured sender ..."), and by payslip-pin-wire.test.ts through createApp.
describe("payslip PIN: reset code through the WhatsApp adapter", () => {
  const provider = new FakeMessagingProvider();
  const appWhatsapp = buildApp({
    otpSender: createPayslipPinWhatsappSender(provider),
  });
  const digitsOf = (phone: string) => phone.replace(/^\+/, "");
  const sentTo = (phone: string) =>
    provider.sent.filter((message) => message.recipient === digitsOf(phone));
  const codeIn = (text: string) => {
    const found = text.match(/(?<!\d)\d{6}(?!\d)/);
    if (!found) throw new Error("No 6-digit code in the message");
    return found[0];
  };

  it("sends one WhatsApp message with the code; that code sets a new PIN", async () => {
    const staff = await makeStaff(undefined, appWhatsapp);
    await setPin(staff.client, { pin: GOOD });

    const requested = await requestOtp(staff.client);
    expect(ok(requested.status), JSON.stringify(requested.body)).toBe(true);

    const messages = sentTo(staff.phone);
    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    expect(message.tenantId).toBe(tenant.id);
    expect(message.outletId).toBe(outlet.id);
    expect(message.text).toContain("5 menit");
    const code = codeIn(message.text);
    expect(JSON.stringify(requested.body)).not.toContain(code);

    const verified = await verifyOtp(staff.client, { code, pin: NEW_PIN });
    expect(ok(verified.status), JSON.stringify(verified.body)).toBe(true);
    expect((await view(staff.client, staff.payslipId, GOOD)).status).toBe(403);
    expect((await view(staff.client, staff.payslipId, NEW_PIN)).status).toBe(
      200,
    );
  });

  // The employee's home outlet is A (the seeded employee row) but the role
  // that carries self.payslip.view is assigned at outlet B, so the caller's
  // OutletScope is {outlets:[B]}. Assumption: the code is then sent under the
  // outlet the caller is actually scoped to (B), not the home outlet (A).
  it("sends the code under the role's outlet when it differs from the home outlet", async () => {
    const outletB = cafeLegendPlatformFixtures.outlets[1]!.id;
    expect(outletB).not.toBe(outlet.id);
    const staff = await makeStaff(undefined, appWhatsapp, outletB);
    await setPin(staff.client, { pin: GOOD });

    const requested = await requestOtp(staff.client);
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);

    const messages = sentTo(staff.phone);
    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    expect(message.tenantId).toBe(tenant.id);
    expect(message.outletId).toBe(outletB);

    const verified = await verifyOtp(staff.client, {
      code: codeIn(message.text),
      pin: NEW_PIN,
    });
    expect(ok(verified.status), JSON.stringify(verified.body)).toBe(true);
    expect((await view(staff.client, staff.payslipId, NEW_PIN)).status).toBe(
      200,
    );
  });

  it("never prints the code or the phone number, and never stores them in audit rows", async () => {
    const staff = await makeStaff(undefined, appWhatsapp);
    await setPin(staff.client, { pin: GOOD });

    const written: string[] = [];
    const capture = (chunk: unknown) => {
      written.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk as Uint8Array).toString(),
      );
      return true;
    };
    const spies = [
      vi.spyOn(process.stdout, "write").mockImplementation(capture),
      vi.spyOn(process.stderr, "write").mockImplementation(capture),
      ...(["log", "info", "warn", "error", "debug"] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          written.push(args.map(String).join(" "));
        }),
      ),
    ];
    let requested;
    try {
      requested = await requestOtp(staff.client);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(ok(requested.status), JSON.stringify(requested.body)).toBe(true);

    const message = sentTo(staff.phone)[0]!;
    const code = codeIn(message.text);
    const output = written.join("\n");
    expect(output).not.toContain(code);
    expect(output).not.toContain(digitsOf(staff.phone));

    const rows = await sql<{ raw: string }>(
      `SELECT event::text AS raw FROM audit_logs
        WHERE tenant_id = $1 AND event->>'actorId' = $2`,
      [tenant.id, staff.userId],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.raw).not.toContain(code);
      expect(row.raw).not.toContain(digitsOf(staff.phone));
    }
  });

  it("sends only 3 messages in an hour: the 4th request answers 429", async () => {
    const staff = await makeStaff(undefined, appWhatsapp);
    await setPin(staff.client, { pin: GOOD });
    for (let i = 0; i < 3; i += 1)
      expect(ok((await requestOtp(staff.client)).status)).toBe(true);
    expect(sentTo(staff.phone)).toHaveLength(3);

    const fourth = await requestOtp(staff.client);
    expect(fourth.status).toBe(429);
    expect(sentTo(staff.phone)).toHaveLength(3);
    expect(await challenges(staff.employeeId)).toHaveLength(3);
  });

  it("sends a second tenant's employee code under that tenant, not the first", async () => {
    const appTenantB = buildApp(
      { otpSender: createPayslipPinWhatsappSender(provider) },
      otherWorld.tenantId,
    );
    const { client, userId } = await signedInClient("Staf Tenant B", {
      app: appTenantB,
    });
    const roleId = randomUUID();
    otherRoles.push(roleId);
    await sql(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, '["outlet"]')`,
      [
        roleId,
        otherWorld.tenantId,
        `Payslip PIN B ${roleId.slice(0, 8)}`,
        JSON.stringify(["self.payslip.view", "self.profile.view"]),
      ],
      otherWorld.tenantId,
    );
    await sql(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [otherWorld.tenantId, userId, roleId, otherOutletId],
      otherWorld.tenantId,
    );
    const employeeId = randomUUID();
    await sql(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Tenant B OTP', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        otherWorld.tenantId,
        userId,
        `SPB-${employeeId.slice(0, 8).toUpperCase()}`,
        otherOutletId,
      ],
      otherWorld.tenantId,
    );
    await seedPayslip(otherWorld, employeeId, otherOutletId);
    const phone = await seedWhatsapp(userId);
    expect(ok((await setPin(client, { pin: GOOD })).status)).toBe(true);

    const requested = await requestOtp(client);
    expect(ok(requested.status), JSON.stringify(requested.body)).toBe(true);
    const messages = sentTo(phone);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.tenantId).toBe(otherWorld.tenantId);
    expect(messages[0]!.tenantId).not.toBe(tenant.id);
    expect(messages[0]!.outletId).toBe(otherOutletId);
  });
});
