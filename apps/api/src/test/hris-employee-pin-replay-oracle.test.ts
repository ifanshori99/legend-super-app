// Codex finding 418 #1 (P1): the HRIS idempotency replay (idempotentHrisWrite in
// hris-employee.service.ts) compared the request fingerprint, which carries the
// PIN, BEFORE any attempt was counted. A caller holding an idempotency key whose
// stored outcome was "ok" could therefore guess the current PIN without limit
// (the right guess replays 200, every other guess answers 409), also while the
// account is locked. A replay must only return the stored outcome, never tell
// the guesses apart, and every fresh key must count its attempt under the lock.
//
// Drives the payslip PIN change (`PUT /me/payslip-pin`, `currentPin` is the
// guess) over HTTP against the real Better Auth, RBAC and PostgreSQL.
import { randomUUID } from "node:crypto";
import express from "express";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { requestContext } from "../lib/request-context.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { tenantContext } from "../middleware/tenant.ts";
import { createHrisPayslipRouter } from "../routes/hris-payslip.routes.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenant = cafeLegendPlatformFixtures.tenant;
const outlet = cafeLegendPlatformFixtures.outlets[0];

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

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
    /^\/me\/payslip-pin/.test(req.path) ? gate(req, res, next) : next(),
  );
  app.use(createApp());
  return app;
}

const app = buildApp();

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const keys: string[] = [];

async function sql<R extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    const rows = (await client.query(text, params)).rows as R[];
    await client.query("COMMIT");
    return rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Client = ReturnType<typeof agent>;
type Staff = { client: Client; employeeId: string };

async function makeStaff(): Promise<Staff> {
  const client = agent(app);
  await signUp(client, "Staf Oracle PIN");
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
      `Oracle PIN ${roleId.slice(0, 8)}`,
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
     VALUES ($1, $2, $3, $4, 'Karyawan Oracle PIN', $5, 'pkwtt', '2025-03-01', 'active')`,
    [
      employeeId,
      tenant.id,
      userId,
      `OR-${employeeId.slice(0, 8).toUpperCase()}`,
      outlet.id,
    ],
  );
  return { client, employeeId };
}

const key = () => {
  const value = `ps-pin-oracle-${randomUUID()}`;
  keys.push(value);
  return value;
};
const GOOD = "739104";
const NEXT = "264801";
const AFTER = "480917";
const WRONG = "111222";

const STATUS = "/api/hris/me/payslip-pin";
const putPin = (
  staff: Staff,
  body: { pin: string; currentPin?: string; idempotencyKey: string },
) => staff.client.put(STATUS).set(originHeader).send(body);

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

/** Sets GOOD, then changes it to NEXT with `changeKey` (stored outcome: ok). */
async function staffWithStoredOk(changeKey: string): Promise<Staff> {
  const staff = await makeStaff();
  expect(
    (await putPin(staff, { pin: GOOD, idempotencyKey: key() })).status,
  ).toBe(200);
  const change = await putPin(staff, {
    pin: NEXT,
    currentPin: GOOD,
    idempotencyKey: changeKey,
  });
  expect(change.status).toBe(200);
  return staff;
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await sql(
    "DELETE FROM payslip_pins WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
    [tenant.id, createdEmployees],
  ).catch(() => undefined);
  await sql(
    "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key = ANY($2::text[])",
    [tenant.id, keys],
  ).catch(() => undefined);
  await sql(
    "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
    [tenant.id, createdEmployees],
  ).catch(() => undefined);
  await sql(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenant.id, createdUsers],
  ).catch(() => undefined);
  await sql("DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])", [
    tenant.id,
    createdRoles,
  ]).catch(() => undefined);
  await owner
    .query('DELETE FROM "user" WHERE id = ANY($1::text[])', [createdUsers])
    .catch(() => undefined);
  await owner.end();
});

describe("HRIS idempotency replay is not a PIN oracle", () => {
  it("a replay answers the stored outcome whether the guess is right or wrong, and counts nothing", async () => {
    const changeKey = key();
    const staff = await staffWithStoredOk(changeKey);

    const right = await putPin(staff, {
      pin: NEXT,
      currentPin: GOOD,
      idempotencyKey: changeKey,
    });
    const wrong = await putPin(staff, {
      pin: NEXT,
      currentPin: WRONG,
      idempotencyKey: changeKey,
    });
    expect(right.status).toBe(200);
    // Before the fix: 409 IDEMPOTENCY_KEY_REUSED, i.e. "this guess is not it".
    expect(wrong.status).toBe(right.status);
    expect(wrong.body).toEqual(right.body);
    expect((await pinRow(staff.employeeId)).failed_attempts).toBe(0);
  });

  it("a replay of a locked account does not tell guesses apart either", async () => {
    const changeKey = key();
    const staff = await staffWithStoredOk(changeKey);
    // The PIN is now NEXT. Five fresh keys with a wrong current PIN lock it.
    for (let i = 0; i < 5; i += 1)
      await putPin(staff, {
        pin: AFTER,
        currentPin: WRONG,
        idempotencyKey: key(),
      });
    const locked = await pinRow(staff.employeeId);
    expect(locked.failed_attempts).toBe(5);
    expect(locked.locked_until).not.toBeNull();

    const right = await putPin(staff, {
      pin: NEXT,
      currentPin: GOOD,
      idempotencyKey: changeKey,
    });
    const wrong = await putPin(staff, {
      pin: NEXT,
      currentPin: WRONG,
      idempotencyKey: changeKey,
    });
    expect(wrong.status).toBe(right.status);
    expect(wrong.body).toEqual(right.body);
    // Still locked with the same counter: nothing was guessed or counted.
    expect(await pinRow(staff.employeeId)).toEqual(locked);
  });

  it("parallel replays with different guesses all get the same stored answer", async () => {
    const changeKey = key();
    const staff = await staffWithStoredOk(changeKey);
    const guesses = ["111111", "222222", GOOD, "333333", "444444", "555555"];
    const responses = await Promise.all(
      guesses.map((currentPin) =>
        putPin(staff, { pin: NEXT, currentPin, idempotencyKey: changeKey }),
      ),
    );
    expect(new Set(responses.map((r) => r.status))).toEqual(new Set([200]));
    expect((await pinRow(staff.employeeId)).failed_attempts).toBe(0);
  });

  it("parallel fresh keys each count one attempt under the lock: exactly five misses, then locked", async () => {
    const staff = await makeStaff();
    expect(
      (await putPin(staff, { pin: GOOD, idempotencyKey: key() })).status,
    ).toBe(200);
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        putPin(staff, { pin: NEXT, currentPin: WRONG, idempotencyKey: key() }),
      ),
    );
    const counts = new Map<number, number>();
    for (const r of responses)
      counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    // Four counted misses, the fifth locks, every later one is refused.
    expect(counts.get(403)).toBe(4);
    expect(counts.get(423)).toBe(6);
    const row = await pinRow(staff.employeeId);
    expect(row.failed_attempts).toBe(5);
    expect(row.locked_until).not.toBeNull();
  });
});
