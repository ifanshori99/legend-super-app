// legend-9h2oj: payslip PIN reset through an INBOUND WhatsApp message
// (design rev 2.1 D-WA3, D-WA6, section 3, 5.2, 6.2). Written from the contract,
// independent of the implementation. Runs the real Express app, Better Auth,
// RBAC and PostgreSQL against the seeded Cafe Legend tenant, and posts real
// signed Kirimdev webhooks (signKirimWebhook). Nothing is ever sent out.
//
// Contract under test (all under /api/hris/me/payslip-pin/reset-wa):
//   POST ""            201 { challengeId, code, waLink, senderHint, expiresAt } + binding cookie
//                      409 PAYSLIP_PIN_RESET_WHATSAPP_UNAVAILABLE | PAYSLIP_PIN_NOT_SET
//                      429 RATE_LIMITED (5 per hour per user) | 503 SERVICE_UNAVAILABLE
//   GET  "/:id"        200 { status, expiresAt, grantExpiresAt } | 404
//   POST "/:id/pin"    200 { status: "active", lockedUntil: null } | 403 PAYSLIP_PIN_RESET_PROOF_INVALID | 422
//   POST "/:id/cancel" 204 | 404
//
// Assumptions (the spec leaves these open):
//  - Secret wiring: the happy path needs KIRIM_WEBHOOK_SECRET non-empty. The
//    suite supplies it both as the env var and as createApp's
//    `whatsappWebhookSecrets`; the 503 case empties both.
//  - "Tenant has no active WhatsApp integration" is simulated by deleting the
//    tenant's `provider = 'whatsapp'` tenant_integrations row (restored after).
//  - After cancel or an HR reset, GET answers 200 with status "cancelled"
//    (contract lists "cancelled" among the statuses; 404 is only for an id
//    that is unknown or not bound to the caller).
//  - A retry of /pin with the SAME idempotency key replays the stored 200
//    (D-WA6: /pin keeps idempotentHrisWrite) and does not change the PIN again.
//  - A malformed PIN (not 6 digits) is 422 and does not burn the proof.
//  - The audit text never contains the code, the PIN or a full phone number;
//    the reject cause (`sender_mismatch`) appears somewhere in the audit row.
//  - Audit rows written by the webhook (verified/rejected) are counted per
//    tenant and action before/after (actor is the system, not the employee).
//  - `linked_at` is aged with a direct UPDATE. While the column does not exist
//    yet (42703) the aging is skipped, so tests fail on the missing endpoint
//    (404) rather than on test setup.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signKirimWebhook } from "@starter/shared/adapters";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { sealSecret } from "../lib/secrets.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

// Founder decision (supersedes design D-WA3's 7 days): a linked WhatsApp number
// must be at least this many days old before it can prove a PIN reset. The
// shared constant (WA_PROOF_IDENTITY_MIN_AGE_DAYS) does not exist on this
// branch yet, so the suite keeps its own.
const MIN_LINK_AGE_DAYS = 3;

const SECRET = "test-wa-reset-webhook-secret";
vi.stubEnv("KIRIM_WEBHOOK_SECRET", SECRET);

const fixtures = cafeLegendPlatformFixtures;
const tenant = fixtures.tenant;
const outletId = fixtures.outlets[0].id;
const PASSWORD = "Test-password-123!";
const RESET_BASE = "/api/hris/me/payslip-pin/reset-wa";
const STATUS = "/api/hris/me/payslip-pin";
const RECEIVING_NUMBER = `62811${Array.from(randomBytes(8), (b) => b % 10).join("")}`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const app = createApp({
  whatsappWebhookSecrets: [SECRET],
  storageRuntime: null,
});
const appWithoutSecret = createApp({
  whatsappWebhookSecrets: [],
  storageRuntime: null,
});

type Client = ReturnType<typeof agent>;
type Staff = {
  client: Client;
  email: string;
  userId: string;
  employeeId: string;
  identityId: string;
  digits: string;
};

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdIdentities: string[] = [];
let previousIntegration: { config: unknown; status: string } | null = null;
let hr: { client: Client; userId: string };

// ------------------------------------------------------------ database

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
  return asTenant(async (db) => (await db.query(text, params)).rows as R[]);
}

async function seedIntegration() {
  await owner.query(
    `INSERT INTO tenant_integrations (tenant_id, provider, config, credentials_encrypted, status)
     VALUES ($1, 'whatsapp', $2, 'c2VhbGVkLXRlc3Q=', 'active')
     ON CONFLICT (tenant_id, provider) WHERE outlet_id IS NULL
     DO UPDATE SET config = EXCLUDED.config, status = EXCLUDED.status`,
    [
      tenant.id,
      JSON.stringify({ vendor: "kirimdev", receivingNumber: RECEIVING_NUMBER }),
    ],
  );
}

/** Backdates the identity's `linked_at`; skipped while the column is missing. */
async function ageIdentity(identityId: string, age: string) {
  try {
    await owner.query(
      `UPDATE user_identities SET linked_at = now() - $2::interval WHERE id = $1`,
      [identityId, age],
    );
  } catch (error) {
    if ((error as { code?: string }).code !== "42703") throw error;
  }
}

type StaffOptions = {
  /** Age of the WhatsApp link (default: old enough, minimum + 1 day). */
  linkedFor?: string;
  verified?: boolean;
  withWhatsapp?: boolean;
  withPin?: boolean;
  onApp?: ReturnType<typeof createApp>;
};

/** An employee with a login, a self-service role, a PIN and a WhatsApp number. */
async function seedStaff(
  name: string,
  options: StaffOptions = {},
): Promise<Staff> {
  const {
    linkedFor = `${MIN_LINK_AGE_DAYS + 1} days`,
    verified = true,
    withWhatsapp = true,
    withPin = true,
    onApp = app,
  } = options;
  const client = agent(onApp);
  const email = await signUp(client, name);
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
        `PIN WA reset ${roleId.slice(0, 8)}`,
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
       VALUES ($1, $2, $3, $4, 'Karyawan Reset WA', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        tenant.id,
        userId,
        `RW-${employeeId.slice(0, 8).toUpperCase()}`,
        outletId,
      ],
    );
  });

  const digits = `62812${Array.from(randomBytes(8), (b) => b % 10).join("")}`;
  const identityId = randomUUID();
  if (withWhatsapp) {
    const hash = randomBytes(32).toString("hex");
    createdIdentities.push(identityId);
    await owner.query(
      `INSERT INTO user_identities (id, user_id, type, value_hash, value_encrypted, verified_at)
       VALUES ($1, $2, 'whatsapp', $3, $4, ${verified ? "now()" : "NULL"})`,
      [
        identityId,
        userId,
        hash,
        sealSecret(`+${digits}`, `user_identity:whatsapp:${hash}`),
      ],
    );
    await ageIdentity(identityId, linkedFor);
  }

  const staff = { client, email, userId, employeeId, identityId, digits };
  if (withPin) {
    const set = await setPin(staff.client, OLD_PIN);
    expect([200, 201], JSON.stringify(set.body)).toContain(set.status);
  }
  return staff;
}

// ------------------------------------------------------------ requests

const key = () => `ps-pin-wa-${randomUUID()}`;
const OLD_PIN = "739104";
const NEW_PIN = "264801";

const setPin = (client: Client, pin: string) =>
  client.put(STATUS).set(originHeader).send({ pin, idempotencyKey: key() });

const requestProof = (client: Client) =>
  client.post(RESET_BASE).set(originHeader).send({});

const readProof = (client: Client, challengeId: string) =>
  client.get(`${RESET_BASE}/${challengeId}`);

const savePin = (
  client: Client,
  challengeId: string,
  body: { pin: string; idempotencyKey?: string } = { pin: NEW_PIN },
) =>
  client
    .post(`${RESET_BASE}/${challengeId}/pin`)
    .set(originHeader)
    .send({ idempotencyKey: key(), ...body });

const cancelProof = (client: Client, challengeId: string) =>
  client.post(`${RESET_BASE}/${challengeId}/cancel`).set(originHeader).send({});

const hrReset = (employeeId: string) =>
  hr.client
    .post(`/api/hris/employees/${employeeId}/payslip-pin/reset`)
    .set(originHeader)
    .send({ reason: "Karyawan lupa PIN", idempotencyKey: key() });

async function signInAgain(client: Client, email: string) {
  const response = await client
    .post("/api/auth/sign-in/email")
    .set(originHeader)
    .send({ email, password: PASSWORD });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

type Issued = {
  challengeId: string;
  code: string;
  waLink: string;
  senderHint: string;
  expiresAt: string;
  setCookie: string[];
};

/** Requests a proof and asserts it was issued (201). */
async function startReset(staff: Staff): Promise<Issued> {
  const response = await requestProof(staff.client);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return {
    ...(response.body.data as Omit<Issued, "setCookie">),
    setCookie: (response.headers["set-cookie"] ?? []) as unknown as string[],
  };
}

// ------------------------------------------------------------ webhook

function kirimPayload(input: {
  messageId: string;
  from: string;
  text: string;
  phoneNumberId: string;
}) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-test",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: input.phoneNumberId },
              messages: [
                {
                  id: input.messageId,
                  from: input.from,
                  type: "text",
                  text: { body: input.text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

/** Signs the exact bytes, the way Kirimdev does, and posts them. */
async function sendWhatsapp(input: {
  from: string;
  text: string;
  phoneNumberId?: string;
}) {
  const body = kirimPayload({
    messageId: `wamid-${randomUUID()}`,
    from: input.from,
    text: input.text,
    phoneNumberId: input.phoneNumberId ?? RECEIVING_NUMBER,
  });
  const signature = await signKirimWebhook({ rawBody: body, secret: SECRET });
  return (
    agent(app)
      .host(fixtures.domains[0]!.hostname)
      .post("/api/webhooks/whatsapp")
      .set("Content-Type", "application/json")
      .set("X-Kirim-Signature", signature)
      // Kirimdev always sends it and verifyKirimWebhook requires it.
      .set("X-Kirim-Event-Id", `evt-${randomUUID()}`)
      .send(body)
  );
}

/** The employee sends `RESET PIN <code>` from their own number. */
const sendProof = async (staff: Staff, code: string) => {
  const response = await sendWhatsapp({
    from: staff.digits,
    text: `RESET PIN ${code}`,
  });
  expect(response.status).toBe(200);
};

async function statusOf(staff: Staff, challengeId: string) {
  const response = await readProof(staff.client, challengeId);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as {
    status: string;
    expiresAt: string;
    grantExpiresAt: string | null;
  };
}

/** Issue, then verify through the webhook from the employee's own number. */
async function verifiedReset(staff: Staff): Promise<Issued> {
  const issued = await startReset(staff);
  await sendProof(staff, issued.code);
  expect((await statusOf(staff, issued.challengeId)).status).toBe("verified");
  return issued;
}

// ------------------------------------------------------------ inspection

async function pinHash(employeeId: string): Promise<string | null> {
  const rows = await sql<{ h: string | null }>(
    `SELECT encode(pin_hash::bytea, 'hex') AS h FROM payslip_pins
      WHERE tenant_id = $1 AND employee_id = $2`,
    [tenant.id, employeeId],
  );
  return rows[0]?.h ?? null;
}

async function auditCount(action: string): Promise<number> {
  const rows = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2`,
    [tenant.id, action],
  );
  return rows[0]!.n;
}

async function auditRows(action: string): Promise<string[]> {
  const rows = await sql<{ raw: string }>(
    `SELECT event::text AS raw FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2`,
    [tenant.id, action],
  );
  return rows.map((row) => row.raw);
}

const cookieNamed = (setCookie: string[], name: string) =>
  setCookie.find((cookie) => cookie.split("=")[0]!.endsWith(name));

// ------------------------------------------------------------ lifecycle

beforeAll(async () => {
  const existing = await owner.query(
    `SELECT config, status FROM tenant_integrations
      WHERE tenant_id = $1 AND provider = 'whatsapp' AND outlet_id IS NULL`,
    [tenant.id],
  );
  previousIntegration =
    (existing.rows[0] as typeof previousIntegration) ?? null;
  await seedIntegration();

  const client = agent(app);
  const email = await signUp(client, "HR Reset WA");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  await verifySessionMfa(email);
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await sql(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, '["tenant"]')`,
    [
      roleId,
      tenant.id,
      `PIN WA reset HR ${roleId.slice(0, 8)}`,
      JSON.stringify([
        "hr.employee.manage",
        "hr.employee.view",
        "payroll.view",
        "payroll.run",
        "payroll.approve",
        "payroll.lock",
      ]),
    ],
  );
  await sql(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [tenant.id, userId, roleId],
  );
  hr = { client, userId };
});

afterAll(async () => {
  vi.unstubAllEnvs();
  // Best effort cleanup (disposable DB); audit rows are append-only.
  await owner
    .query(
      `DELETE FROM login_challenges WHERE link_user_id = ANY($1::text[])`,
      [createdUsers],
    )
    .catch(() => undefined);
  if (previousIntegration)
    await owner
      .query(
        `UPDATE tenant_integrations SET config = $2, status = $3
          WHERE tenant_id = $1 AND provider = 'whatsapp' AND outlet_id IS NULL`,
        [tenant.id, previousIntegration.config, previousIntegration.status],
      )
      .catch(() => undefined);
  else
    await owner
      .query(
        `DELETE FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'whatsapp' AND outlet_id IS NULL`,
        [tenant.id],
      )
      .catch(() => undefined);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      tenant.id,
    ]);
    await client
      .query(
        `DELETE FROM payslip_pins WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])`,
        [tenant.id, createdEmployees],
      )
      .catch(() => undefined);
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'ps-pin-wa-%'",
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

// ------------------------------------------------------------ tests

describe("PIN reset by WhatsApp: issuing a proof (POST reset-wa)", () => {
  it("201 returns the code, a wa.me link with the RESET PIN text, a 4-digit sender hint and a scoped binding cookie", async () => {
    const staff = await seedStaff("Staf WA Terbit");
    const before = Date.now();
    const issued = await startReset(staff);

    expect(issued.challengeId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(issued.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(issued.waLink).toBe(
      `https://wa.me/${RECEIVING_NUMBER}?text=${encodeURIComponent(`RESET PIN ${issued.code}`)}`,
    );
    expect(issued.senderHint).toBe(staff.digits.slice(-4));
    const expiresIn = new Date(issued.expiresAt).getTime() - before;
    expect(expiresIn).toBeGreaterThan(4 * 60_000);
    expect(expiresIn).toBeLessThanOrEqual(5 * 60_000 + 10_000);

    const binding = cookieNamed(issued.setCookie, ".pin_reset_binding");
    expect(binding, JSON.stringify(issued.setCookie)).toBeDefined();
    expect(binding).toMatch(
      /Path=\/api\/hris\/me\/payslip-pin\/reset-wa(;|$)/i,
    );
    expect(binding).toMatch(/HttpOnly/i);
  });

  it("a new request cancels the earlier pending one and gives a different code", async () => {
    const staff = await seedStaff("Staf WA Dua Kali");
    const first = await startReset(staff);
    const second = await startReset(staff);
    expect(second.code).not.toBe(first.code);
    expect(second.challengeId).not.toBe(first.challengeId);
    expect((await statusOf(staff, first.challengeId)).status).toBe("cancelled");
    expect((await statusOf(staff, second.challengeId)).status).toBe("pending");
    // The cancelled code no longer verifies anything.
    await sendProof(staff, first.code);
    expect((await statusOf(staff, first.challengeId)).status).toBe("cancelled");
  });

  it("never stores the code in clear: not in the challenge row, not in HRIS idempotency", async () => {
    const staff = await seedStaff("Staf WA Rahasia");
    const issued = await startReset(staff);
    const rows = await owner.query(
      `SELECT count(*)::int AS n FROM login_challenges c
        WHERE c.id = $1 AND row_to_json(c)::text ILIKE '%' || $2 || '%'`,
      [issued.challengeId, issued.code.replace("-", "")],
    );
    expect(rows.rows[0].n).toBe(0);
    const stored = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM hris_idempotency h
        WHERE tenant_id = $1 AND to_jsonb(h)::text LIKE '%' || $2 || '%'`,
      [tenant.id, issued.code],
    );
    expect(stored[0]!.n).toBe(0);
  });

  it("409 PAYSLIP_PIN_RESET_WHATSAPP_UNAVAILABLE without a WhatsApp number", async () => {
    const staff = await seedStaff("Staf WA Tanpa Nomor", {
      withWhatsapp: false,
    });
    const response = await requestProof(staff.client);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe(
      "PAYSLIP_PIN_RESET_WHATSAPP_UNAVAILABLE",
    );
  });

  it("409 PAYSLIP_PIN_RESET_WHATSAPP_UNAVAILABLE when the number is not verified", async () => {
    const staff = await seedStaff("Staf WA Belum Verifikasi", {
      verified: false,
    });
    const response = await requestProof(staff.client);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe(
      "PAYSLIP_PIN_RESET_WHATSAPP_UNAVAILABLE",
    );
  });

  it("409 PAYSLIP_PIN_RESET_WHATSAPP_UNAVAILABLE when the number was linked less than the minimum age ago, and nothing is stored", async () => {
    const staff = await seedStaff("Staf WA Baru Tertaut", {
      linkedFor: `${MIN_LINK_AGE_DAYS - 1} days 23 hours`,
    });
    const response = await requestProof(staff.client);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe(
      "PAYSLIP_PIN_RESET_WHATSAPP_UNAVAILABLE",
    );
    const rows = await owner.query(
      `SELECT count(*)::int AS n FROM login_challenges
        WHERE link_user_id = $1 AND purpose = 'payslip_pin_reset'`,
      [staff.userId],
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("a number linked just over the minimum age ago is accepted", async () => {
    const staff = await seedStaff("Staf WA Tepat Batas Umur", {
      linkedFor: `${MIN_LINK_AGE_DAYS} days 1 hour`,
    });
    expect((await requestProof(staff.client)).status).toBe(201);
  });

  it("409 PAYSLIP_PIN_NOT_SET when the employee has no PIN yet", async () => {
    const staff = await seedStaff("Staf WA Tanpa PIN", { withPin: false });
    const response = await requestProof(staff.client);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe("PAYSLIP_PIN_NOT_SET");
  });

  it("429 RATE_LIMITED on the 6th request within an hour", async () => {
    const staff = await seedStaff("Staf WA Banjir");
    for (let i = 0; i < 5; i += 1) await startReset(staff);
    const sixth = await requestProof(staff.client);
    expect(sixth.status, JSON.stringify(sixth.body)).toBe(429);
    expect(sixth.body.error.code).toBe("RATE_LIMITED");
  });

  it("401 without a session", async () => {
    const response = await agent(app)
      .post(RESET_BASE)
      .set(originHeader)
      .send({});
    expect(response.status).toBe(401);
  });

  it("503 SERVICE_UNAVAILABLE when the webhook secret is empty, and nothing is stored", async () => {
    vi.stubEnv("KIRIM_WEBHOOK_SECRET", "");
    try {
      const staff = await seedStaff("Staf WA Tanpa Secret", {
        onApp: appWithoutSecret,
      });
      const response = await requestProof(staff.client);
      expect(response.status, JSON.stringify(response.body)).toBe(503);
      expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
      const rows = await owner.query(
        `SELECT count(*)::int AS n FROM login_challenges
          WHERE link_user_id = $1 AND purpose = 'payslip_pin_reset'`,
        [staff.userId],
      );
      expect(rows.rows[0].n).toBe(0);
    } finally {
      vi.stubEnv("KIRIM_WEBHOOK_SECRET", SECRET);
    }
  });

  it("503 SERVICE_UNAVAILABLE when the tenant has no active WhatsApp integration", async () => {
    const staff = await seedStaff("Staf WA Tanpa Integrasi");
    await owner.query(
      `DELETE FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'whatsapp' AND outlet_id IS NULL`,
      [tenant.id],
    );
    try {
      const response = await requestProof(staff.client);
      expect(response.status, JSON.stringify(response.body)).toBe(503);
      expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
    } finally {
      await seedIntegration();
    }
  });
});

describe("PIN reset by WhatsApp: verification by the inbound message (GET reset-wa/:id)", () => {
  it("is pending at first, then verified with a 10 minute grant after the signed RESET PIN message from the right number", async () => {
    const staff = await seedStaff("Staf WA Verifikasi");
    const issued = await startReset(staff);

    const pending = await statusOf(staff, issued.challengeId);
    expect(pending.status).toBe("pending");
    expect(pending.grantExpiresAt).toBeNull();
    expect(new Date(pending.expiresAt).toISOString()).toBe(
      new Date(issued.expiresAt).toISOString(),
    );

    const before = Date.now();
    await sendProof(staff, issued.code);
    const verified = await statusOf(staff, issued.challengeId);
    expect(verified.status).toBe("verified");
    const grantIn = new Date(verified.grantExpiresAt!).getTime() - before;
    expect(grantIn).toBeGreaterThan(9 * 60_000);
    expect(grantIn).toBeLessThanOrEqual(10 * 60_000 + 10_000);
  });

  it("a message from a different number leaves the proof pending", async () => {
    const staff = await seedStaff("Staf WA Pengirim Salah");
    const issued = await startReset(staff);
    const stranger = `62813${Array.from(randomBytes(8), (b) => b % 10).join("")}`;
    const response = await sendWhatsapp({
      from: stranger,
      text: `RESET PIN ${issued.code}`,
    });
    expect(response.status).toBe(200);
    expect((await statusOf(staff, issued.challengeId)).status).toBe("pending");
    // The right number can still finish it afterwards.
    await sendProof(staff, issued.code);
    expect((await statusOf(staff, issued.challengeId)).status).toBe("verified");
  });

  it("the login keyword instead of RESET PIN leaves the proof pending", async () => {
    const staff = await seedStaff("Staf WA Kata Salah");
    const issued = await startReset(staff);
    const response = await sendWhatsapp({
      from: staff.digits,
      text: `MASUK LEGEND ${issued.code}`,
    });
    expect(response.status).toBe(200);
    expect((await statusOf(staff, issued.challengeId)).status).toBe("pending");
  });

  it("a message to another receiving number leaves the proof pending", async () => {
    const staff = await seedStaff("Staf WA Nomor Penerima Lain");
    const issued = await startReset(staff);
    const response = await sendWhatsapp({
      from: staff.digits,
      text: `RESET PIN ${issued.code}`,
      phoneNumberId: `62819${Array.from(randomBytes(7), (b) => b % 10).join("")}`,
    });
    expect([200, 404]).toContain(response.status);
    expect((await statusOf(staff, issued.challengeId)).status).toBe("pending");
  });

  it("an expired proof reads as expired and a late message does not verify it", async () => {
    const staff = await seedStaff("Staf WA Kedaluwarsa");
    const issued = await startReset(staff);
    await owner.query(
      `UPDATE login_challenges
          SET created_at = created_at - interval '6 minutes',
              expires_at = expires_at - interval '6 minutes'
        WHERE id = $1`,
      [issued.challengeId],
    );
    await sendProof(staff, issued.code);
    expect((await statusOf(staff, issued.challengeId)).status).toBe("expired");
  });

  it("the proof is bound to its owner: another employee, another id or no session gets 404", async () => {
    const owner1 = await seedStaff("Staf WA Pemilik");
    const other = await seedStaff("Staf WA Orang Lain");
    const issued = await startReset(owner1);
    expect((await readProof(other.client, issued.challengeId)).status).toBe(
      404,
    );
    expect((await readProof(owner1.client, randomUUID())).status).toBe(404);
    expect(
      (await agent(app).get(`${RESET_BASE}/${issued.challengeId}`)).status,
    ).toBe(401);
  });

  it("answers 404 when the browser binding cookie is missing (a second sign-in of the same employee)", async () => {
    const staff = await seedStaff("Staf WA Tanpa Cookie");
    const issued = await startReset(staff);
    const elsewhere = agent(app);
    await signInAgain(elsewhere, staff.email);
    expect((await readProof(elsewhere, issued.challengeId)).status).toBe(404);
  });
});

describe("PIN reset by WhatsApp: saving the new PIN (POST reset-wa/:id/pin)", () => {
  it("200 {status: active, lockedUntil: null}, replaces the PIN and clears the lock", async () => {
    const staff = await seedStaff("Staf WA Simpan PIN");
    await sql(
      `UPDATE payslip_pins SET failed_attempts = 5, locked_until = now() + interval '15 minutes'
        WHERE tenant_id = $1 AND employee_id = $2`,
      [tenant.id, staff.employeeId],
    );
    const hashBefore = await pinHash(staff.employeeId);
    expect(hashBefore).not.toBeNull();

    const issued = await verifiedReset(staff);
    const saved = await savePin(staff.client, issued.challengeId);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data).toEqual({ status: "active", lockedUntil: null });

    expect(await pinHash(staff.employeeId)).not.toBe(hashBefore);
    const status = await staff.client.get(STATUS);
    expect(status.body.data).toEqual({ status: "active", lockedUntil: null });
    const row = await sql<{
      failed_attempts: number;
      locked_until: Date | null;
    }>(
      `SELECT failed_attempts, locked_until FROM payslip_pins
        WHERE tenant_id = $1 AND employee_id = $2`,
      [tenant.id, staff.employeeId],
    );
    expect(row[0]).toMatchObject({ failed_attempts: 0, locked_until: null });
    expect((await statusOf(staff, issued.challengeId)).status).toBe("used");
  });

  it("works once: the second save with the same proof answers 403 PAYSLIP_PIN_RESET_PROOF_INVALID", async () => {
    const staff = await seedStaff("Staf WA Sekali Pakai");
    const issued = await verifiedReset(staff);
    expect((await savePin(staff.client, issued.challengeId)).status).toBe(200);
    const hashAfterFirst = await pinHash(staff.employeeId);

    const second = await savePin(staff.client, issued.challengeId, {
      pin: "135792",
    });
    expect(second.status, JSON.stringify(second.body)).toBe(403);
    expect(second.body.error.code).toBe("PAYSLIP_PIN_RESET_PROOF_INVALID");
    expect(await pinHash(staff.employeeId)).toBe(hashAfterFirst);
  });

  it("a retry with the same idempotency key replays the 200 and does not change the PIN again", async () => {
    const staff = await seedStaff("Staf WA Ulang");
    const issued = await verifiedReset(staff);
    const idempotencyKey = key();
    const first = await savePin(staff.client, issued.challengeId, {
      pin: NEW_PIN,
      idempotencyKey,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const hashAfterFirst = await pinHash(staff.employeeId);
    const retry = await savePin(staff.client, issued.challengeId, {
      pin: NEW_PIN,
      idempotencyKey,
    });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.data).toEqual({ status: "active", lockedUntil: null });
    expect(await pinHash(staff.employeeId)).toBe(hashAfterFirst);
  });

  it("403 while the proof is still pending, and the PIN stays", async () => {
    const staff = await seedStaff("Staf WA Belum Terverifikasi");
    const issued = await startReset(staff);
    const hashBefore = await pinHash(staff.employeeId);
    const response = await savePin(staff.client, issued.challengeId);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error.code).toBe("PAYSLIP_PIN_RESET_PROOF_INVALID");
    expect(await pinHash(staff.employeeId)).toBe(hashBefore);
  });

  it("403 for another employee's proof", async () => {
    const staff = await seedStaff("Staf WA Pemilik Bukti");
    const thief = await seedStaff("Staf WA Pencuri Bukti");
    const issued = await verifiedReset(staff);
    const hashBefore = await pinHash(thief.employeeId);
    const response = await savePin(thief.client, issued.challengeId);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error.code).toBe("PAYSLIP_PIN_RESET_PROOF_INVALID");
    expect(await pinHash(thief.employeeId)).toBe(hashBefore);
    expect(await pinHash(staff.employeeId)).not.toBeNull();
  });

  it("403 from another browser (same employee, no binding cookie)", async () => {
    const staff = await seedStaff("Staf WA Browser Lain");
    const issued = await verifiedReset(staff);
    const elsewhere = agent(app);
    await signInAgain(elsewhere, staff.email);
    const response = await savePin(elsewhere, issued.challengeId);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error.code).toBe("PAYSLIP_PIN_RESET_PROOF_INVALID");
    // The proof was not burned by the failed attempt: the original browser can still save.
    expect((await savePin(staff.client, issued.challengeId)).status).toBe(200);
  });

  it("403 from another session with the same binding cookie (signed in again in the same browser)", async () => {
    const staff = await seedStaff("Staf WA Sesi Lain");
    const issued = await verifiedReset(staff);
    await signInAgain(staff.client, staff.email);
    const response = await savePin(staff.client, issued.challengeId);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error.code).toBe("PAYSLIP_PIN_RESET_PROOF_INVALID");
  });

  it("403 once the 10 minute grant has passed", async () => {
    const staff = await seedStaff("Staf WA Izin Habis");
    const issued = await verifiedReset(staff);
    const hashBefore = await pinHash(staff.employeeId);
    await owner.query(
      `UPDATE login_challenges
          SET created_at = created_at - interval '11 minutes',
              expires_at = expires_at - interval '11 minutes',
              completed_at = completed_at - interval '11 minutes'
        WHERE id = $1`,
      [issued.challengeId],
    );
    const response = await savePin(staff.client, issued.challengeId);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error.code).toBe("PAYSLIP_PIN_RESET_PROOF_INVALID");
    expect(await pinHash(staff.employeeId)).toBe(hashBefore);
  });

  it("403 when the number's link is renewed after the proof was verified; the proof stays verified and the PIN stays", async () => {
    const staff = await seedStaff("Staf WA Tautan Diperbarui");
    const issued = await verifiedReset(staff);
    const hashBefore = await pinHash(staff.employeeId);
    // A merge or re-verification restarts linked_at (trigger); the identity no
    // longer qualifies, so the recheck in /pin must refuse.
    await owner.query(
      `UPDATE user_identities SET linked_at = now() WHERE user_id = $1`,
      [staff.userId],
    );
    const response = await savePin(staff.client, issued.challengeId);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error.code).toBe("PAYSLIP_PIN_RESET_PROOF_INVALID");
    expect(await pinHash(staff.employeeId)).toBe(hashBefore);
    expect((await statusOf(staff, issued.challengeId)).status).toBe("verified");
  });

  it("403 for a proof that does not exist", async () => {
    const staff = await seedStaff("Staf WA Bukti Tak Ada");
    const response = await savePin(staff.client, randomUUID());
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error.code).toBe("PAYSLIP_PIN_RESET_PROOF_INVALID");
  });

  it("422 for a PIN that is not 6 digits, and the proof is not burned", async () => {
    const staff = await seedStaff("Staf WA PIN Salah Format");
    const issued = await verifiedReset(staff);
    const response = await savePin(staff.client, issued.challengeId, {
      pin: "12345",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect((await savePin(staff.client, issued.challengeId)).status).toBe(200);
  });

  it("answers 401 without a session", async () => {
    const response = await agent(app)
      .post(`${RESET_BASE}/${randomUUID()}/pin`)
      .set(originHeader)
      .send({ pin: NEW_PIN, idempotencyKey: key() });
    expect(response.status).toBe(401);
  });
});

describe("PIN reset by WhatsApp: cancelling (POST reset-wa/:id/cancel)", () => {
  it("204, the proof reads as cancelled and its code no longer verifies", async () => {
    const staff = await seedStaff("Staf WA Batal");
    const issued = await startReset(staff);
    const response = await cancelProof(staff.client, issued.challengeId);
    expect(response.status, JSON.stringify(response.body)).toBe(204);
    expect((await statusOf(staff, issued.challengeId)).status).toBe(
      "cancelled",
    );
    await sendProof(staff, issued.code);
    expect((await statusOf(staff, issued.challengeId)).status).toBe(
      "cancelled",
    );
    expect((await savePin(staff.client, issued.challengeId)).status).toBe(403);
  });

  it("cancelling a proof that was already used changes nothing and writes no audit", async () => {
    const staff = await seedStaff("Staf WA Batal Sudah Dipakai");
    const issued = await verifiedReset(staff);
    expect((await savePin(staff.client, issued.challengeId)).status).toBe(200);
    const before = await auditCount("payslip_pin.wa_proof_cancelled");
    expect((await cancelProof(staff.client, issued.challengeId)).status).toBe(
      204,
    );
    expect(await auditCount("payslip_pin.wa_proof_cancelled")).toBe(before);
    expect((await statusOf(staff, issued.challengeId)).status).toBe("used");
  });

  it("404 for an unknown id and for someone else's proof, which stays pending", async () => {
    const staff = await seedStaff("Staf WA Batal Pemilik");
    const other = await seedStaff("Staf WA Batal Orang Lain");
    const issued = await startReset(staff);
    expect((await cancelProof(staff.client, randomUUID())).status).toBe(404);
    expect((await cancelProof(other.client, issued.challengeId)).status).toBe(
      404,
    );
    expect((await statusOf(staff, issued.challengeId)).status).toBe("pending");
  });
});

describe("PIN reset by WhatsApp: HR reset cancels open proofs", () => {
  it("a pending proof is cancelled by an HR reset", async () => {
    const staff = await seedStaff("Staf WA HR Pending");
    const issued = await startReset(staff);
    const reset = await hrReset(staff.employeeId);
    expect([200, 201], JSON.stringify(reset.body)).toContain(reset.status);
    expect((await statusOf(staff, issued.challengeId)).status).toBe(
      "cancelled",
    );
    // The late message verifies nothing.
    await sendProof(staff, issued.code);
    expect((await statusOf(staff, issued.challengeId)).status).toBe(
      "cancelled",
    );
  });

  it("a verified but unused proof is cancelled too: the PIN cannot be set with it", async () => {
    const staff = await seedStaff("Staf WA HR Terverifikasi");
    const issued = await verifiedReset(staff);
    const reset = await hrReset(staff.employeeId);
    expect([200, 201], JSON.stringify(reset.body)).toContain(reset.status);
    expect((await staff.client.get(STATUS)).body.data.status).toBe("not_set");

    const response = await savePin(staff.client, issued.challengeId);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error.code).toBe("PAYSLIP_PIN_RESET_PROOF_INVALID");
    expect((await staff.client.get(STATUS)).body.data.status).toBe("not_set");
  });

  it("the cancellation is audited", async () => {
    const staff = await seedStaff("Staf WA HR Audit");
    await startReset(staff);
    const before = await auditCount("payslip_pin.wa_proof_cancelled");
    expect((await hrReset(staff.employeeId)).status).toBeLessThan(300);
    expect(await auditCount("payslip_pin.wa_proof_cancelled")).toBe(before + 1);
  });
});

describe("PIN reset by WhatsApp: audit trail", () => {
  it("records requested, rejected (sender_mismatch), verified, wa_reset and cancelled without the code, PIN or a full number", async () => {
    const staff = await seedStaff("Staf WA Audit");
    const counts = async () => ({
      requested: await auditCount("payslip_pin.wa_proof_requested"),
      verified: await auditCount("payslip_pin.wa_proof_verified"),
      rejected: await auditCount("payslip_pin.wa_proof_rejected"),
      reset: await auditCount("payslip_pin.wa_reset"),
      cancelled: await auditCount("payslip_pin.wa_proof_cancelled"),
    });
    const start = await counts();

    // Request, then a wrong sender (rejected), then the right sender (verified).
    const first = await startReset(staff);
    const stranger = `62814${Array.from(randomBytes(8), (b) => b % 10).join("")}`;
    expect(
      (
        await sendWhatsapp({
          from: stranger,
          text: `RESET PIN ${first.code}`,
        })
      ).status,
    ).toBe(200);
    await sendProof(staff, first.code);
    expect((await savePin(staff.client, first.challengeId)).status).toBe(200);

    // A second proof cancelled by the employee.
    const second = await startReset(staff);
    expect((await cancelProof(staff.client, second.challengeId)).status).toBe(
      204,
    );

    const end = await counts();
    expect(end.requested - start.requested).toBe(2);
    expect(end.rejected - start.rejected).toBe(1);
    expect(end.verified - start.verified).toBe(1);
    expect(end.reset - start.reset).toBe(1);
    expect(end.cancelled - start.cancelled).toBe(1);

    const rejected = await auditRows("payslip_pin.wa_proof_rejected");
    expect(rejected.some((raw) => raw.includes("sender_mismatch"))).toBe(true);

    const everything = [
      ...(await auditRows("payslip_pin.wa_proof_requested")),
      ...(await auditRows("payslip_pin.wa_proof_verified")),
      ...rejected,
      ...(await auditRows("payslip_pin.wa_reset")),
      ...(await auditRows("payslip_pin.wa_proof_cancelled")),
    ].join("\n");
    for (const secret of [
      first.code,
      first.code.replace("-", ""),
      NEW_PIN,
      staff.digits,
      stranger,
    ])
      expect(everything).not.toContain(secret);
  });
});

describe("PIN reset by WhatsApp: the old OTP endpoints are gone", () => {
  it("POST reset-otp and reset-otp/verify answer 404", async () => {
    const staff = await seedStaff("Staf WA OTP Lama");
    const request = await staff.client
      .post(`${STATUS}/reset-otp`)
      .set(originHeader)
      .send({ idempotencyKey: key() });
    expect(request.status).toBe(404);
    const verify = await staff.client
      .post(`${STATUS}/reset-otp/verify`)
      .set(originHeader)
      .send({ code: "123456", pin: NEW_PIN, idempotencyKey: key() });
    expect(verify.status).toBe(404);
  });
});
