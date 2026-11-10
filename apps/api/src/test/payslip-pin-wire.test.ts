// legend-qih2m: the production-mounted app hands the payslip PIN reset code to
// the WhatsApp adapter built from `createApp({ messagingProvider })`. With a
// messaging provider, POST /api/hris/me/payslip-pin/reset-otp sends one
// message through it (200); without one the reset answers 503 and nothing is
// stored. Only FakeMessagingProvider is used: nothing is ever sent. Runs the
// real Express app, Better Auth, RBAC and PostgreSQL against the seeded Cafe
// Legend tenant. Message content and the full flow are covered by
// payslip-pin-db.test.ts and payslip-pin-whatsapp-sender.test.ts.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { FakeMessagingProvider } from "@starter/shared/adapters";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { sealSecret } from "../lib/secrets.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenant = cafeLegendPlatformFixtures.tenant;
const outletId = cafeLegendPlatformFixtures.outlets[0].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const provider = new FakeMessagingProvider();
const appWithMessaging = createApp({
  messagingProvider: provider,
  storageRuntime: null,
});
const appWithoutMessaging = createApp({ storageRuntime: null });

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

/** An employee with a login, a self-service role and a verified WhatsApp number. */
async function seedStaff(app: ReturnType<typeof createApp>, name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);

  const roleId = randomUUID();
  const employeeId = randomUUID();
  createdRoles.push(roleId);
  createdEmployees.push(employeeId);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, '["outlet"]')`,
      [
        roleId,
        tenant.id,
        `PIN wire ${roleId.slice(0, 8)}`,
        JSON.stringify(["self.payslip.view", "self.profile.view"]),
      ],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenant.id, userId, roleId, outletId],
    );
    await db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan PIN Wire', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        tenant.id,
        userId,
        `PW-${employeeId.slice(0, 8).toUpperCase()}`,
        outletId,
      ],
    );
  });

  const digits = `62812${Array.from(randomBytes(8), (b) => b % 10).join("")}`;
  const hash = randomBytes(32).toString("hex");
  const identityId = randomUUID();
  createdIdentities.push(identityId);
  await owner.query(
    `INSERT INTO user_identities (id, user_id, type, value_hash, value_encrypted, verified_at)
     VALUES ($1, $2, 'whatsapp', $3, $4, now())`,
    [
      identityId,
      userId,
      hash,
      sealSecret(`+${digits}`, `user_identity:whatsapp:${hash}`),
    ],
  );
  return { client, userId, employeeId, digits };
}

const requestOtp = (client: ReturnType<typeof agent>) =>
  client
    .post("/api/hris/me/payslip-pin/reset-otp")
    .set(originHeader)
    .send({ idempotencyKey: `ps-pin-wire-${randomUUID()}` });

async function challengeCount(employeeId: string) {
  return asTenant(async (db) => {
    const result = await db.query(
      `SELECT count(*)::int AS n FROM payslip_pin_reset_challenges
        WHERE tenant_id = $1 AND employee_id = $2`,
      [tenant.id, employeeId],
    );
    return result.rows[0].n as number;
  });
}

afterAll(async () => {
  // Best effort cleanup (disposable DB); audit rows are append-only.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      tenant.id,
    ]);
    for (const table of ["payslip_pin_reset_challenges", "payslip_pins"])
      await client
        .query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])`,
          [tenant.id, createdEmployees],
        )
        .catch(() => undefined);
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'ps-pin-wire-%'",
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

describe("createApp with a messaging provider", () => {
  it("sends the payslip PIN reset code through it", async () => {
    const staff = await seedStaff(appWithMessaging, "Staf PIN Wire Ada");
    const response = await requestOtp(staff.client);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const messages = provider.sent.filter(
      (message) => message.recipient === staff.digits,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.tenantId).toBe(tenant.id);
    expect(await challengeCount(staff.employeeId)).toBe(1);
  });
});

describe("createApp without a messaging provider", () => {
  it("answers 503 to the reset code request and stores no challenge", async () => {
    const staff = await seedStaff(appWithoutMessaging, "Staf PIN Wire Tanpa");
    const response = await requestOtp(staff.client);
    expect(response.status, JSON.stringify(response.body)).toBe(503);
    expect(await challengeCount(staff.employeeId)).toBe(0);
    expect(
      provider.sent.filter((message) => message.recipient === staff.digits),
    ).toHaveLength(0);
  });
});
