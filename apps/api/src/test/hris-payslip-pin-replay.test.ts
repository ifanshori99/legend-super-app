// Codex finding 418 patterns 1 and 5 applied to opening a payslip
// (`POST /me/payslips/:id/view`, services/hris-payslip.service.ts).
//
// Pattern 1 (replay oracle): the idempotency fingerprint of a view carried an
// HMAC of the guessed PIN, so replaying a key with a different PIN answered 409
// IDEMPOTENCY_KEY_REUSED while the same PIN replayed the stored failure, and
// neither counted an attempt (also while locked). A replay must return the
// stored outcome whatever PIN it carries; every fresh key counts its attempt
// atomically under the PIN lock. A success is still never stored.
// Pattern 5 (clock): `now` (lock expiry, counters, viewedAt, audit) is read AFTER
// the per-employee PIN lock is obtained, not before the request waited for it.
//
// Runs over HTTP against the real Better Auth, RBAC and PostgreSQL. "Waiting
// for the lock" is real: the employee's advisory lock is held from a second
// connection until the in-flight request is seen waiting in pg_locks; the clock
// then moves forward with a fake `Date` only (timers stay real).
import { randomUUID } from "node:crypto";
import express from "express";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cafeLegendPayrollFixtures,
  PAYSLIP_PIN_MAX_ATTEMPTS,
} from "@starter/shared/hris/payroll";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import {
  PAYROLL_SEAL_KEY_VERSION,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";
import { requestContext } from "../lib/request-context.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { tenantContext } from "../middleware/tenant.ts";
import { createHrisPayslipRouter } from "../routes/hris-payslip.routes.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenant = cafeLegendPlatformFixtures.tenant;
const outlet = cafeLegendPlatformFixtures.outlets[0];

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const PAYSLIP_PATH = /^\/(me\/payslips|me\/payslip-pin)/;

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
  gate.use(createHrisPayslipRouter({}));
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

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];

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
    new Date(Date.UTC(2033, 0, 1 + n)).toISOString().slice(0, 10);
  const offset = Math.floor(Math.random() * 3000);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Slip Replay', false)`,
      [entityId, tenant.id],
    );
    await client.query(
      `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                     employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan Replay', $4, $5, $6, 'none', 'low', '[]')`,
      [
        policyId,
        tenant.id,
        entityId,
        `RPL${policyId.slice(0, 8)}`,
        JSON.stringify({ code: `RPL${policyId.slice(0, 8)}` }),
        JSON.stringify({ kind: "monthly" }),
      ],
    );
    await client.query(
      `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                                 period_start, period_end, pay_date, created_by)
       VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, 'payslip-replay-test')`,
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

type Client = ReturnType<typeof agent>;
type Staff = { client: Client; employeeId: string; payslipId: string };

async function makeStaff(): Promise<Staff> {
  const client = agent(app);
  await signUp(client, "Staf Replay Slip");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await sql(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenant.id,
      `Replay Slip ${roleId.slice(0, 8)}`,
      JSON.stringify(["self.payslip.view", "self.profile.view"]),
      JSON.stringify(["outlet"]),
    ],
  );
  await sql(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenant.id, userId, roleId, outlet.id],
  );
  const employeeId = randomUUID();
  createdEmployees.push(employeeId);
  await sql(
    `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                            employment_type, join_date, status)
     VALUES ($1, $2, $3, $4, 'Karyawan Replay Slip', $5, 'pkwtt', '2025-03-01', 'active')`,
    [
      employeeId,
      tenant.id,
      userId,
      `RS-${employeeId.slice(0, 8).toUpperCase()}`,
      outlet.id,
    ],
  );
  return { client, employeeId, payslipId: await seedPayslip(employeeId) };
}

const key = () => `ps-pin-replay-${randomUUID()}`;
const GOOD = "739104";
const WRONG = "111222";
const GUESSES = ["111111", "222222", "333333", "444444", "555555", "666666"];
const STATUS = "/api/hris/me/payslip-pin";

const setPin = (staff: Staff, pin: string) =>
  staff.client
    .put(STATUS)
    .set(originHeader)
    .send({ pin, idempotencyKey: key() });

const view = (staff: Staff, pin: string, idempotencyKey: string = key()) =>
  staff.client
    .post(`/api/hris/me/payslips/${staff.payslipId}/view`)
    .set(originHeader)
    .send({ pin, idempotencyKey });

/** The error answer without the per-request id. */
const answer = (body: { error?: Record<string, unknown> }) => ({
  ...body,
  error: { ...body.error, requestId: undefined },
});

async function staffWithPin(): Promise<Staff> {
  const staff = await makeStaff();
  expect((await setPin(staff, GOOD)).status).toBe(200);
  return staff;
}

async function pinRow(employeeId: string) {
  const rows = await sql<{
    failed_attempts: number;
    locked_until: Date | null;
  }>(
    `SELECT failed_attempts, locked_until FROM payslip_pins
      WHERE tenant_id = $1 AND employee_id = $2`,
    [tenant.id, employeeId],
  );
  return rows[0]!;
}

async function viewedAt(payslipId: string) {
  const rows = await sql<{ viewed_at: Date | null }>(
    "SELECT viewed_at FROM payslips WHERE tenant_id = $1 AND id = $2",
    [tenant.id, payslipId],
  );
  return rows[0]!.viewed_at;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  world = await seedPayrollWorld();
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
    await client.query(
      `DELETE FROM payslip_pins WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])`,
      [tenant.id, createdEmployees],
    );
    await client.query(`DELETE FROM payslips WHERE payroll_run_id = $1`, [
      world.runId,
    ]);
    await client.query(`DELETE FROM payroll_runs WHERE id = $1`, [world.runId]);
    await client.query(`DELETE FROM payroll_policies WHERE id = $1`, [
      world.policyId,
    ]);
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'ps-pin-replay-%'",
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
    .query('DELETE FROM "user" WHERE id = ANY($1::text[])', [createdUsers])
    .catch(() => undefined);
  await owner.end();
});

describe("payslip view: an idempotency replay is not a PIN oracle", () => {
  it("a replay of a stored miss answers the same for the right, the same and any other PIN, and counts nothing", async () => {
    const staff = await staffWithPin();
    const missKey = key();
    const first = await view(staff, WRONG, missKey);
    expect(first.status).toBe(403);
    expect((await pinRow(staff.employeeId)).failed_attempts).toBe(1);

    const same = await view(staff, WRONG, missKey);
    const other = await view(staff, "222333", missKey);
    const right = await view(staff, GOOD, missKey);
    // Before the fix: 409 IDEMPOTENCY_KEY_REUSED for `other` and `right`.
    for (const replay of [same, other, right]) {
      expect(replay.status).toBe(first.status);
      expect(answer(replay.body)).toEqual(answer(first.body));
    }
    expect((await pinRow(staff.employeeId)).failed_attempts).toBe(1);
    expect(await viewedAt(staff.payslipId)).toBeNull();
  });

  it("a replay of a stored miss on a locked account does not tell guesses apart and changes nothing", async () => {
    const staff = await staffWithPin();
    const missKey = key();
    expect((await view(staff, WRONG, missKey)).status).toBe(403);
    for (let i = 1; i < PAYSLIP_PIN_MAX_ATTEMPTS; i += 1)
      await view(staff, WRONG);
    const locked = await pinRow(staff.employeeId);
    expect(locked.failed_attempts).toBe(PAYSLIP_PIN_MAX_ATTEMPTS);
    expect(locked.locked_until).not.toBeNull();

    const wrong = await view(staff, WRONG, missKey);
    const right = await view(staff, GOOD, missKey);
    expect(right.status).toBe(wrong.status);
    expect(answer(right.body)).toEqual(answer(wrong.body));
    expect(await pinRow(staff.employeeId)).toEqual(locked);
  });

  it("six parallel requests on one new key with different guesses count one attempt and get one answer", async () => {
    const staff = await staffWithPin();
    const sharedKey = key();
    const responses = await Promise.all(
      GUESSES.map((pin) => view(staff, pin, sharedKey)),
    );
    expect(new Set(responses.map((r) => r.status))).toEqual(new Set([403]));
    expect(
      new Set(responses.map((r) => JSON.stringify(answer(r.body)))).size,
    ).toBe(1);
    expect((await pinRow(staff.employeeId)).failed_attempts).toBe(1);
  });

  it("parallel fresh keys each count one attempt under the lock: exactly five misses, then locked", async () => {
    const staff = await staffWithPin();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => view(staff, WRONG)),
    );
    const counts = new Map<number, number>();
    for (const r of responses)
      counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    expect(counts.get(403)).toBe(PAYSLIP_PIN_MAX_ATTEMPTS - 1);
    expect(counts.get(423)).toBe(10 - (PAYSLIP_PIN_MAX_ATTEMPTS - 1));
    const row = await pinRow(staff.employeeId);
    expect(row.failed_attempts).toBe(PAYSLIP_PIN_MAX_ATTEMPTS);
    expect(row.locked_until).not.toBeNull();
  });

  it("a success is not stored: the same key checks the PIN afresh", async () => {
    const staff = await staffWithPin();
    const reused = key();
    expect((await view(staff, GOOD, reused)).status).toBe(200);
    // Not a replay of the success and not a 409: a fresh, counted miss.
    expect((await view(staff, WRONG, reused)).status).toBe(403);
    expect((await pinRow(staff.employeeId)).failed_attempts).toBe(1);
    expect((await view(staff, GOOD)).status).toBe(200);
  });
});

// ------------------------------------------------------------ clock

/** Holds the employee's PIN lock, the way the service takes it. */
async function holdPinLock(employeeId: string) {
  const client = await owner.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `payslip-pin:${tenant.id}:${employeeId}`,
  ]);
  return {
    async release() {
      try {
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    },
  };
}

/** Resolves once a session is blocked waiting for that employee's PIN lock. */
async function waitForLockWaiter(employeeId: string) {
  await expect
    .poll(
      async () =>
        (
          await owner.query<{ n: number }>(
            `SELECT count(*)::int AS n
               FROM pg_locks l,
                    (SELECT hashtextextended($1, 0) AS k) h
              WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
                AND l.classid::text::bigint = ((h.k >> 32) & 4294967295)
                AND l.objid::text::bigint = (h.k & 4294967295)`,
            [`payslip-pin:${tenant.id}:${employeeId}`],
          )
        ).rows[0]!.n,
      { timeout: 15_000, interval: 25 },
    )
    .toBeGreaterThan(0);
}

/** Sends a view, makes it wait on the PIN lock, moves the clock, then releases. */
async function viewWhileLocked(
  staff: Staff,
  pin: string,
  jumpMs: number,
): Promise<{ status: number; movedTo: number }> {
  const lock = await holdPinLock(staff.employeeId);
  let response: Promise<{ status: number }> | undefined;
  const movedTo = Date.now() + jumpMs;
  try {
    response = view(staff, pin).then((r) => r);
    await waitForLockWaiter(staff.employeeId);
    vi.useFakeTimers({ toFake: ["Date"], now: movedTo });
  } finally {
    await lock.release();
  }
  try {
    return { status: (await response!).status, movedTo };
  } finally {
    vi.useRealTimers();
  }
}

describe("payslip view: time is read after the PIN lock is obtained", () => {
  it("viewedAt is the time the lock was obtained, not the time the request started", async () => {
    const staff = await staffWithPin();
    const { status, movedTo } = await viewWhileLocked(staff, GOOD, 30 * 60_000);
    expect(status).toBe(200);
    const stamped = await viewedAt(staff.payslipId);
    expect(stamped).not.toBeNull();
    // Before the fix: the clock read before waiting (about 30 minutes earlier).
    expect(stamped!.getTime()).toBeGreaterThanOrEqual(movedTo);
  });

  it("a lock that runs out while the request waits is judged at the later time", async () => {
    const staff = await staffWithPin();
    // Locked for one more minute when the request starts.
    await sql(
      `UPDATE payslip_pins SET failed_attempts = $3, locked_until = $4
        WHERE tenant_id = $1 AND employee_id = $2`,
      [
        tenant.id,
        staff.employeeId,
        PAYSLIP_PIN_MAX_ATTEMPTS,
        new Date(Date.now() + 60_000),
      ],
    );
    const { status } = await viewWhileLocked(staff, GOOD, 30 * 60_000);
    // Before the fix: 423, the lock was judged against the stale clock.
    expect(status).toBe(200);
    expect((await pinRow(staff.employeeId)).failed_attempts).toBe(0);
  });
});
