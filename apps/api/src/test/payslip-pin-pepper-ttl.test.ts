// Codex findings 4 and 5 of review 418 (card legend-fjwxo), payslip PIN.
//
// Finding 4: the staff PIN pepper (`staffPinPepper`, per outlet/tenant, sent to
// edge nodes) must never protect or verify a payslip PIN. Every payslip PIN
// path (set/change, view check, HR reset, idempotency fingerprint) must use the cloud-only `payslipPinPepper`.
//   - Stored PIN hashes verify under `payslipPinPepper` and under NO staff pepper
//     (any outlet of the tenant, any version the cloud can derive).
//   - While every path runs, `staffPinPepper` (and its null/edge variants) is
//     never called; `payslipPinPepper` is.
// Finding 5 (the reset code's expiry judged after the PIN lock) belonged to the
// outbound WhatsApp OTP, removed in legend-9h2oj; the inbound proof's grant
// window is judged in the same way (clock read after the lock) in
// payslip-pin.service completePayslipPinResetWa.
//
// Assumptions (the contract leaves them open):
//  - The tests run through HTTP like payslip-pin-db.test.ts.
//  - Peppers are inspected through the public pepper module: the staff pepper
//    of every outlet of the fixture tenant for versions 1..current.
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cafeLegendPayrollFixtures } from "@starter/shared/hris/payroll";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";

// Spies around the pepper module: the real functions run, calls are recorded.
const calls = vi.hoisted(() => ({
  staff: [] as string[],
  payslip: [] as string[],
}));
vi.mock("../services/device-pin-pepper.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/device-pin-pepper.ts")>();
  return {
    ...actual,
    staffPinPepper: (...args: Parameters<typeof actual.staffPinPepper>) => {
      calls.staff.push("staffPinPepper");
      return actual.staffPinPepper(...args);
    },
    staffPinPepperOrNull: (
      ...args: Parameters<typeof actual.staffPinPepperOrNull>
    ) => {
      calls.staff.push("staffPinPepperOrNull");
      return actual.staffPinPepperOrNull(...args);
    },
    staffPinPeppersForEdge: (
      ...args: Parameters<typeof actual.staffPinPeppersForEdge>
    ) => {
      calls.staff.push("staffPinPeppersForEdge");
      return actual.staffPinPeppersForEdge(...args);
    },
    payslipPinPepper: (...args: Parameters<typeof actual.payslipPinPepper>) => {
      calls.payslip.push("payslipPinPepper");
      return actual.payslipPinPepper(...args);
    },
  };
});

import { createApp } from "../app.ts";
import { requestContext } from "../lib/request-context.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { tenantContext } from "../middleware/tenant.ts";
import {
  sealPayrollValue,
  PAYROLL_SEAL_KEY_VERSION,
} from "../lib/payroll-sealed.ts";
import { sealSecret } from "../lib/secrets.ts";
import { createHrisPayslipRouter } from "../routes/hris-payslip.routes.ts";
import { verifyStaffPinHash } from "../services/device-pin-hash.ts";
import {
  currentStaffPinPepperVersion,
  payslipPinPepper,
  staffPinPepper,
} from "../services/device-pin-pepper.ts";
import {
  payslipFingerprintRequest,
  payslipPinBinding,
} from "../services/payslip-pin.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const tenant = cafeLegendPlatformFixtures.tenant;
const outlet = cafeLegendPlatformFixtures.outlets[0];

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

// ------------------------------------------------------------ test app

const PAYSLIP_PATH =
  /^\/(me\/payslips|me\/payslip-pin|employees\/[^/]+\/payslip-pin)/;

function buildApp() {
  const gate = express.Router();
  gate.use(
    tenantContext({
      required: false,
      resolveDomain: async () => null,
      verifyCredential: async () => null,
      fallback: async () => ({
        tenantId: tenant.id,
        brandId: null,
        source: "session" as const,
      }),
    }),
  );
  gate.use(createHrisPayslipRouter());
  gate.use(errorHandler);
  const app = express();
  app.use(requestContext);
  app.use("/api/hris", (req, res, next) =>
    PAYSLIP_PATH.test(req.path) ? gate(req, res, next) : next(),
  );
  app.use(createApp());
  return app;
}

const app = buildApp();

// ------------------------------------------------------------ database

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdIdentities: string[] = [];

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

async function sql<R extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  return asTenant(
    async (client) => (await client.query(text, params)).rows as R[],
  );
}

type World = { entityId: string; policyId: string; runId: string };
let world: World;

const RUN_STEPS = [
  `status = 'simulated'`,
  `status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now()`,
  `status = 'approved', approved_by_finance = 'finance-user', approved_by_finance_at = now()`,
  `status = 'locked', config_snapshot = '{"v":1}', totals = '{"t":1}', locked_by = 'lock-user', locked_at = now()`,
];

async function seedPayrollWorld(): Promise<World> {
  const entityId = randomUUID();
  const policyId = randomUUID();
  const runId = randomUUID();
  const day = (n: number) =>
    new Date(Date.UTC(2032, 0, 1 + n)).toISOString().slice(0, 10);
  const offset = Math.floor(Math.random() * 3000);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Slip Pepper', false)`,
      [entityId, tenant.id],
    );
    await client.query(
      `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                     employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan Pepper', $4, $5, $6, 'none', 'low', '[]')`,
      [
        policyId,
        tenant.id,
        entityId,
        `PEP${policyId.slice(0, 8)}`,
        JSON.stringify({ code: `PEP${policyId.slice(0, 8)}` }),
        JSON.stringify({ kind: "monthly" }),
      ],
    );
    await client.query(
      `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                                 period_start, period_end, pay_date, created_by)
       VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, 'payslip-pepper-test')`,
      [runId, tenant.id, entityId, policyId, day(offset), day(offset + 1)],
    );
    for (const step of RUN_STEPS)
      await client.query(`UPDATE payroll_runs SET ${step} WHERE id = $1`, [
        runId,
      ]);
  });
  return { entityId, policyId, runId };
}

const baseCalculation: Record<string, unknown> = Object.fromEntries(
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
);

async function seedPayslip(employeeId: string): Promise<string> {
  const id = randomUUID();
  const calculation = { ...baseCalculation, employeeId, outletId: outlet.id };
  const sealed = sealPayrollValue(JSON.stringify(calculation), {
    tenantId: tenant.id,
    table: "payslips",
    rowId: id,
    field: "calculation",
  });
  await sql(
    `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id, payment_method,
                           calculation_encrypted, pii_key_version)
     VALUES ($1, $2, $3, $4, 'bank_transfer', $5, $6)`,
    [id, tenant.id, world.runId, employeeId, sealed, PAYROLL_SEAL_KEY_VERSION],
  );
  return id;
}

// ------------------------------------------------------------ users

type Client = ReturnType<typeof agent>;

async function signedInClient(name: string, options: { mfa?: boolean } = {}) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  if (options.mfa) await verifySessionMfa(email);
  return { client, userId };
}

async function grantRole(
  userId: string,
  permissions: string[],
  tenantWide: boolean,
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await sql(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenant.id,
      `Slip Pepper ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify([tenantWide ? "tenant" : "outlet"]),
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
      tenantWide ? "tenant" : "outlet",
      tenantWide ? null : outlet.id,
    ],
  );
}

async function seedEmployee(userId: string) {
  const id = randomUUID();
  createdEmployees.push(id);
  await sql(
    `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                            employment_type, join_date, status)
     VALUES ($1, $2, $3, $4, 'Karyawan Slip Pepper', $5, 'pkwtt', '2025-03-01', 'active')`,
    [id, tenant.id, userId, `SPP-${id.slice(0, 8).toUpperCase()}`, outlet.id],
  );
  return id;
}

async function seedWhatsapp(userId: string) {
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
}

type Staff = {
  client: Client;
  userId: string;
  employeeId: string;
  payslipId: string;
};
let hr: { client: Client; userId: string };

async function makeStaff(): Promise<Staff> {
  const { client, userId } = await signedInClient("Staf Slip Pepper");
  await grantRole(userId, ["self.payslip.view", "self.profile.view"], false);
  const employeeId = await seedEmployee(userId);
  const payslipId = await seedPayslip(employeeId);
  await seedWhatsapp(userId);
  return { client, userId, employeeId, payslipId };
}

// ------------------------------------------------------------ requests

const key = () => `ps-pin-${randomUUID()}`;
const GOOD = "739104";
const OTHER = "580263";
const WRONG = "111222";
const NEW_PIN = "264801";
const STATUS = "/api/hris/me/payslip-pin";

const setPin = (client: Client, body: { pin: string; currentPin?: string }) =>
  client
    .put(STATUS)
    .set(originHeader)
    .send({ idempotencyKey: key(), ...body });

const view = (client: Client, payslipId: string, pin: string) =>
  client
    .post(`/api/hris/me/payslips/${payslipId}/view`)
    .set(originHeader)
    .send({ pin, idempotencyKey: key() });

const hrReset = (employeeId: string) =>
  hr.client
    .post(`/api/hris/employees/${employeeId}/payslip-pin/reset`)
    .set(originHeader)
    .send({ reason: "Karyawan lupa PIN", idempotencyKey: key() });

const ok = (status: number) => [200, 201].includes(status);

async function storedPin(employeeId: string) {
  const rows = await sql<{
    pin_salt: string;
    pin_hash: string;
    kdf_n: number;
    kdf_r: number;
    kdf_p: number;
    pepper_version: number;
  }>(
    `SELECT pin_salt, pin_hash, kdf_n, kdf_r, kdf_p, pepper_version FROM payslip_pins
      WHERE tenant_id = $1 AND employee_id = $2`,
    [tenant.id, employeeId],
  );
  const row = rows[0];
  if (!row) throw new Error("No payslip PIN row");
  return {
    version: row.pepper_version,
    stored: {
      salt: row.pin_salt,
      pinHash: row.pin_hash,
      params: {
        N: row.kdf_n,
        r: row.kdf_r,
        p: row.kdf_p,
        keyLength: 32 as const,
      },
    },
  };
}

// ------------------------------------------------------------ lifecycle

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  world = await seedPayrollWorld();
  hr = await signedInClient("HR Slip Pepper", { mfa: true });
  await grantRole(
    hr.userId,
    [
      "hr.employee.manage",
      "hr.employee.view",
      "payroll.view",
      "payroll.run",
      "payroll.approve",
      "payroll.lock",
    ],
    true,
  );
});

beforeEach(() => {
  calls.staff.length = 0;
  calls.payslip.length = 0;
});

afterAll(async () => {
  vi.useRealTimers();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      tenant.id,
    ]);
    for (const table of ["payslip_pins"])
      await client
        .query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])`,
          [tenant.id, createdEmployees],
        )
        .catch(() => undefined);
    await client.query(`DELETE FROM payslips WHERE payroll_run_id = $1`, [
      world.runId,
    ]);
    await client.query(`DELETE FROM payroll_runs WHERE id = $1`, [world.runId]);
    await client.query(`DELETE FROM payroll_policies WHERE id = $1`, [
      world.policyId,
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
    await client.query(
      "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = $2",
      [tenant.id, world.entityId],
    );
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

// ------------------------------------------------------------ finding 4

describe("payslip PIN pepper: the staff PIN pepper never protects a payslip PIN", () => {
  it("a stored payslip PIN verifies under the payslip pepper and under no staff pepper", async () => {
    const staff = await makeStaff();
    expect(ok((await setPin(staff.client, { pin: GOOD })).status)).toBe(true);
    const { version, stored } = await storedPin(staff.employeeId);
    const binding = payslipPinBinding(tenant.id, staff.employeeId);

    expect(
      await verifyStaffPinHash({
        pepper: payslipPinPepper(tenant.id, version),
        binding,
        pin: GOOD,
        stored,
      }),
    ).toBe(true);

    // Every staff pepper the cloud can derive: each outlet, versions 1..current.
    for (let v = 1; v <= currentStaffPinPepperVersion(); v += 1) {
      for (const { id: outletId } of cafeLegendPlatformFixtures.outlets) {
        expect(
          await verifyStaffPinHash({
            pepper: staffPinPepper(tenant.id, outletId, v),
            binding,
            pin: GOOD,
            stored,
          }),
          `staff pepper v${v} outlet ${outletId}`,
        ).toBe(false);
        // Also with the staff PIN binding of that outlet.
        expect(
          await verifyStaffPinHash({
            pepper: staffPinPepper(tenant.id, outletId, v),
            binding: { tenantId: tenant.id, outletId, userId: staff.userId },
            pin: GOOD,
            stored,
          }),
        ).toBe(false);
      }
    }
  });

  it("a changed PIN, or one set after an HR reset, is also hashed under the payslip pepper only", async () => {
    const staff = await makeStaff();
    await setPin(staff.client, { pin: GOOD });
    expect(
      ok(
        (await setPin(staff.client, { pin: NEW_PIN, currentPin: GOOD })).status,
      ),
    ).toBe(true);

    const binding = payslipPinBinding(tenant.id, staff.employeeId);
    const afterChange = await storedPin(staff.employeeId);
    expect(
      await verifyStaffPinHash({
        pepper: payslipPinPepper(tenant.id, afterChange.version),
        binding,
        pin: NEW_PIN,
        stored: afterChange.stored,
      }),
    ).toBe(true);

    expect(ok((await hrReset(staff.employeeId)).status)).toBe(true);
    expect(ok((await setPin(staff.client, { pin: OTHER })).status)).toBe(true);
    const afterHr = await storedPin(staff.employeeId);
    expect(
      await verifyStaffPinHash({
        pepper: payslipPinPepper(tenant.id, afterHr.version),
        binding,
        pin: OTHER,
        stored: afterHr.stored,
      }),
    ).toBe(true);
    for (const { id: outletId } of cafeLegendPlatformFixtures.outlets)
      for (const [pin, stored] of [
        [NEW_PIN, afterChange.stored],
        [OTHER, afterHr.stored],
      ] as const)
        expect(
          await verifyStaffPinHash({
            pepper: staffPinPepper(
              tenant.id,
              outletId,
              currentStaffPinPepperVersion(),
            ),
            binding,
            pin,
            stored,
          }),
        ).toBe(false);
  });

  it("no payslip PIN path (set, change, view, HR reset) touches the staff pepper", async () => {
    const staff = await makeStaff();
    expect(ok((await setPin(staff.client, { pin: GOOD })).status)).toBe(true);
    expect((await view(staff.client, staff.payslipId, GOOD)).status).toBe(200);
    expect((await view(staff.client, staff.payslipId, WRONG)).status).toBe(403);
    expect(
      ok((await setPin(staff.client, { pin: OTHER, currentPin: GOOD })).status),
    ).toBe(true);
    expect((await view(staff.client, staff.payslipId, OTHER)).status).toBe(200);
    expect(ok((await hrReset(staff.employeeId)).status)).toBe(true);
    expect(ok((await setPin(staff.client, { pin: GOOD })).status)).toBe(true);

    expect(calls.staff).toEqual([]);
    expect(calls.payslip.length).toBeGreaterThan(0);
  });

  it("the idempotency fingerprint of a payslip PIN request does not use the staff pepper", () => {
    const fingerprinted = payslipFingerprintRequest(tenant.id, {
      pin: GOOD,
      currentPin: OTHER,
      code: "123456",
    });
    expect(calls.staff).toEqual([]);
    expect(calls.payslip.length).toBeGreaterThan(0);
    // The secrets are not in the clear.
    expect(JSON.stringify(fingerprinted)).not.toContain(GOOD);
    expect(JSON.stringify(fingerprinted)).not.toContain(OTHER);
  });
});
