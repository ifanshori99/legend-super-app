// legend-k2l member sign-in: email magic link, sign-in method gate, Google
// switch and "never link to @wa.invalid" (brief 290b "Tes gagal-dulu";
// design ws08 M2; PRD AUTH-01 for the challenge contract).
//
// Written fail-first against the agreed names in the k2l implementation brief:
//   - POST /api/auth/login-challenges/email           { email } -> 201 { data: { sent, expiresAt } }
//   - POST /api/auth/login-challenges/email/verify    { token } -> 200 { data: { userId, crossDevice } }
//   - session.auth_method / session.auth_cross_device
//   - lib/email-sender.ts: setEmailSenderForTests / EmailMessage
//
// Assumptions (spec silent, recorded here and in the report):
//   - Response bodies use the same `{ data: ... }` envelope as the WhatsApp
//     login-challenge routes.
//   - A refused `.invalid` address answers 422 (brief: "ditolak", agreed
//     implementation brief: 422 validation error).
//   - "Production without email keys" is modelled by injecting `null` through
//     setEmailSenderForTests (the port's "not configured" value); the default
//     NODE_ENV=production resolution of getEmailSender() is env-parse time and
//     is not re-evaluated here.
//   - A staff session that came from a member method is answered 403 on staff
//     routes with a code other than MFA_REQUIRED: it never reaches the
//     management tier, so the MFA step is never asked (design M2).
//   - Google OAuth cannot be exercised end to end without Google; the gate is
//     covered by flipping `session.auth_method` to `google` in the database,
//     and the "no link to @wa.invalid" guard by calling the Better Auth
//     row-side guard through `auth.options.databaseHooks.account.create.before`
//     (throws to refuse). The provider-side `mapProfileToUser` guard is a todo.
//   - The test environment sets no GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.

// Must stay the first import: it sets TRUST_PROXY before ../app reads the env.
import {
  FILE_CLIENT_IP,
  releaseTrustedProxy,
} from "./helpers/identity-client-ip";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { signKirimWebhook } from "@starter/shared/adapters";
import { createApp } from "../app";
import { db } from "../db";
import { auth } from "../lib/auth";
import { whatsAppDigest } from "../lib/identity-digest.ts";
import {
  setEmailFromResolverForTests,
  setEmailSenderForTests,
  type EmailMessage,
} from "../lib/email-sender";
import { seedTenantRoleTemplates } from "../services/access.service";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import {
  createIdentityScope,
  createIdentityTenant,
  uniqueDigits,
} from "./helpers/identity-isolation";

const SECRET = "test-kirim-webhook-secret";
// Own tenant, host, receiving number and sender per run: this file never shares
// rows with the other identity files (legend-5opkl). The tenant gets its own
// role templates so the staff-gate tests still run against a tenant where the
// account really is an owner.
const TENANT_A: string = randomUUID();
const NUMBER_A = `62811${uniqueDigits(7)}`;
const SENDER = `62812${uniqueDigits(8)}`;
let HOST = "";
const STAFF_ROUTE = "/api/org/modules";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
// The file issues more than LOGIN_ISSUE_PER_IP challenges from one test IP;
// the limiter has its own tests (login-challenge-rate-limit.test.ts).
const app = createApp({
  whatsappWebhookSecrets: [SECRET],
  loginChallengeRateLimit: { issuePerIp: 1_000, issuePerBinding: 1_000 },
});
const isolation = createIdentityScope(owner);
isolation.scope.tenantIds.push(TENANT_A);
isolation.scope.receivingNumbers.push(NUMBER_A);
isolation.scope.senders.push(SENDER);
const trackedUserIds = isolation.scope.userIds;
const outbox: EmailMessage[] = [];
// Fixed sender address returned by the resolver seam, so the test does not
// depend on EMAIL_FROM in the environment.
const RESOLVED_FROM = "masuk@brand.example.test";

type Client = ReturnType<typeof agent>;

function browser(): Client {
  return agent(app).set("X-Forwarded-For", FILE_CLIENT_IP).host(HOST);
}

function freshEmail(): string {
  return `ms-${randomUUID()}@example.com`;
}

function tokenOf(message: EmailMessage): string {
  const match = /#token=([A-Za-z0-9_-]{43})/.exec(message.text);
  if (!match) throw new Error("No #token= link in the mail text");
  return match[1]!;
}

function requestLink(client: Client, email: string) {
  return client
    .post("/api/auth/login-challenges/email")
    .set(originHeader)
    .send({ email });
}

function verifyLink(client: Client, token: string) {
  return client
    .post("/api/auth/login-challenges/email/verify")
    .set(originHeader)
    .send({ token });
}

/** Requests a link for `email` from `requester` and returns its raw token. */
async function issueToken(requester: Client, email: string): Promise<string> {
  const before = outbox.length;
  const response = await requestLink(requester, email);
  expect(response.status).toBe(201);
  expect(outbox.length).toBe(before + 1);
  return tokenOf(outbox[outbox.length - 1]!);
}

async function sessionRows(userId: string) {
  const { rows } = await owner.query<{
    kind: string;
    auth_method: string;
    auth_cross_device: boolean;
  }>(
    "SELECT kind, auth_method, auth_cross_device FROM session WHERE user_id = $1 ORDER BY created_at",
    [userId],
  );
  return rows;
}

async function userIdOf(client: Client): Promise<string> {
  const me = await client.get("/api/auth/get-session");
  const id = me.body?.user?.id as string | undefined;
  if (!id) throw new Error("No session user");
  if (!trackedUserIds.includes(id)) trackedUserIds.push(id);
  return id;
}

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [TENANT_A, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function assignOwner(userId: string): Promise<void> {
  await owner.query(
    // Backdated one minute: the test database clock may differ from Node's.
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [TENANT_A, userId, await roleIdOf("owner")],
  );
}

/** A staff account: password sign-up plus an owner role at the seeded tenant. */
async function newStaff() {
  const client = agent(app).host(HOST);
  const email = await signUp(client, "Staf Uji");
  const userId = await userIdOf(client);
  await assignOwner(userId);
  return { client, email, userId };
}

function kirimPayload(eventId: string, text: string) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-test",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: NUMBER_A },
              messages: [
                {
                  id: eventId,
                  from: SENDER,
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function postWebhook(body: string) {
  const signature = await signKirimWebhook({ rawBody: body, secret: SECRET });
  return agent(app)
    .set("X-Forwarded-For", FILE_CLIENT_IP)
    .host(HOST)
    .post("/api/webhooks/whatsapp")
    .set("Content-Type", "application/json")
    .set("X-Kirim-Signature", signature)
    .set("X-Kirim-Event-Id", "evt-" + randomUUID())
    .send(body);
}

/** Full WhatsApp reverse-OTP login for SENDER from `client`. */
async function whatsAppLogin(client: Client) {
  const issued = await client
    .post("/api/auth/login-challenges/whatsapp")
    .set(originHeader)
    .send({});
  expect(issued.status).toBe(201);
  const delivered = await postWebhook(
    kirimPayload(
      `wamid.${randomUUID()}`,
      `MASUK LEGEND ${issued.body.data.codeFormatted}`,
    ),
  );
  expect(delivered.body.data.completed).toBe(1);
  const polled = await client.get(
    `/api/auth/login-challenges/${issued.body.data.challenge.id}`,
  );
  expect(polled.status).toBe(200);
  return polled.body.data.session as { userId: string };
}

/** This file's rows only; MFA factors go first (they reference the accounts). */
async function clearState() {
  const mine = await owner.query<{ id: string }>(
    `SELECT id FROM "user" WHERE email LIKE 'ms-%@example.com'`,
  );
  for (const row of mine.rows) {
    if (!trackedUserIds.includes(row.id)) trackedUserIds.push(row.id);
  }
  const ids = await isolation.ownedUserIds();
  if (ids.length > 0) {
    await owner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [ids],
    );
  }
  await isolation.cleanup();
}

beforeAll(async () => {
  HOST = (
    await createIdentityTenant(owner, "signin", NUMBER_A, { id: TENANT_A })
  ).hostname;
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
    );
    await seedTenantRoleTemplates(tx, TENANT_A);
  });
});

beforeEach(async () => {
  outbox.length = 0;
  setEmailFromResolverForTests(async () => RESOLVED_FROM);
  setEmailSenderForTests({
    async send(message) {
      outbox.push(message);
    },
  });
  await clearState();
});

afterEach(() => {
  setEmailSenderForTests(undefined);
  setEmailFromResolverForTests(undefined);
});

afterAll(async () => {
  releaseTrustedProxy();
  await clearState();
  await owner.query("DELETE FROM approval_policies WHERE tenant_id = $1", [
    TENANT_A,
  ]);
  await owner.query("DELETE FROM roles WHERE tenant_id = $1", [TENANT_A]);
  await isolation.dropTenants([TENANT_A]);
  await owner.end();
});

describe("AUTH-01 email magic link: request", () => {
  it("sends one link valid 15 minutes and stores only a token digest", async () => {
    const email = freshEmail();
    const client = browser();
    const response = await requestLink(client, email);

    expect(response.status).toBe(201);
    expect(response.body.data.sent).toBe(true);
    const ttl = Date.parse(response.body.data.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000 - 60_000);
    expect(ttl).toBeLessThan(15 * 60_000 + 60_000);
    expect(String(response.headers["set-cookie"])).toContain(".login_binding=");

    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe(email);
    // The sender address comes from the per-tenant resolver.
    expect(outbox[0]!.from).toBe(RESOLVED_FROM);
    const token = tokenOf(outbox[0]!);
    expect(outbox[0]!.html).toContain(token);
    // The token rides in the fragment so it stays out of server logs.
    expect(outbox[0]!.text).toContain("/masuk/email#token=");

    const rows = await owner.query(
      "SELECT * FROM login_challenges WHERE channel = 'email_magic_link' AND tenant_id = $1",
      [TENANT_A],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe("pending");
    expect(rows.rows[0].tenant_id).toBe(TENANT_A);
    const dump = JSON.stringify(rows.rows[0]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(email);
  });

  it("answers the same for a known and an unknown address", async () => {
    const known = agent(app);
    const knownEmail = await signUp(known, "Sudah Ada");
    await userIdOf(known);

    const a = await requestLink(browser(), knownEmail);
    const b = await requestLink(browser(), freshEmail());
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(Object.keys(a.body.data).sort()).toEqual(
      Object.keys(b.body.data).sort(),
    );
    expect(a.body.data.sent).toBe(true);
    expect(b.body.data.sent).toBe(true);
  });

  it("rejects a .invalid address with 422 and sends nothing", async () => {
    for (const email of ["someone@wa.invalid", "Someone@WA.INVALID"]) {
      const response = await requestLink(browser(), email);
      expect(response.status).toBe(422);
    }
    expect(outbox).toHaveLength(0);
    const rows = await owner.query(
      "SELECT count(*)::int AS count FROM login_challenges WHERE channel = 'email_magic_link' AND tenant_id = $1",
      [TENANT_A],
    );
    expect(rows.rows[0].count).toBe(0);
  });

  it("answers 503 EMAIL_NOT_CONFIGURED when no mail provider is configured", async () => {
    setEmailSenderForTests(null);
    const response = await requestLink(browser(), freshEmail());

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("EMAIL_NOT_CONFIGURED");
    // Refused before any write: no challenge row is left behind.
    const rows = await owner.query(
      "SELECT count(*)::int AS count FROM login_challenges WHERE channel = 'email_magic_link' AND tenant_id = $1",
      [TENANT_A],
    );
    expect(rows.rows[0].count).toBe(0);
  });

  it("answers 503 EMAIL_NOT_CONFIGURED when the tenant has no sender address", async () => {
    // Sender is configured but the resolver finds no "from" for the tenant.
    setEmailFromResolverForTests(async () => null);
    const response = await requestLink(browser(), freshEmail());

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("EMAIL_NOT_CONFIGURED");
    expect(outbox).toHaveLength(0);
    // Refused before any write: no challenge row is left behind.
    const rows = await owner.query(
      "SELECT count(*)::int AS count FROM login_challenges WHERE channel = 'email_magic_link' AND tenant_id = $1",
      [TENANT_A],
    );
    expect(rows.rows[0].count).toBe(0);
  });
});

describe("AUTH-01 email magic link: verify", () => {
  it("signs the asking browser in with a customer session marked email_magic_link", async () => {
    const email = freshEmail();
    const client = browser();
    const token = await issueToken(client, email);

    const verified = await verifyLink(client, token);
    expect(verified.status).toBe(200);
    expect(verified.body.data.crossDevice).toBe(false);
    const userId = verified.body.data.userId as string;
    trackedUserIds.push(userId);

    const me = await client.get("/api/auth/get-session");
    expect(me.body.user.id).toBe(userId);
    expect(me.body.user.email).toBe(email);
    expect(await sessionRows(userId)).toEqual([
      {
        kind: "customer",
        auth_method: "email_magic_link",
        auth_cross_device: false,
      },
    ]);

    const identity = await owner.query(
      "SELECT verified_at FROM user_identities WHERE user_id = $1 AND type = 'email'",
      [userId],
    );
    expect(identity.rows).toHaveLength(1);
    expect(identity.rows[0].verified_at).toBeTruthy();
    const user = await owner.query(
      'SELECT email_verified FROM "user" WHERE id = $1',
      [userId],
    );
    expect(user.rows[0].email_verified).toBe(true);
  });

  it("signs in the existing account that has the same email instead of creating another", async () => {
    const existing = agent(app);
    const email = await signUp(existing, "Pemilik Email");
    const existingId = await userIdOf(existing);
    // Pre-registration takeover guard: an unverified self-signed-up password
    // account is refused (next test). Only a verified email may be signed in
    // to by magic link, so mark this owner's email as verified first.
    await owner.query('UPDATE "user" SET email_verified = true WHERE id = $1', [
      existingId,
    ]);

    const client = browser();
    const verified = await verifyLink(client, await issueToken(client, email));
    expect(verified.status).toBe(200);
    expect(verified.body.data.userId).toBe(existingId);
    const count = await owner.query(
      'SELECT count(*)::int AS count FROM "user" WHERE lower(email) = $1',
      [email],
    );
    expect(count.rows[0].count).toBe(1);
  });

  it("refuses with IDENTITY_ALREADY_LINKED an unverified self-signed-up password account and opens no session for it", async () => {
    // Pre-registration takeover guard: email_verified=false + password
    // credential + no role assignment => 409, never signed in. Sign-up leaves
    // email_verified false (assumed default; asserted below).
    const existing = agent(app);
    const email = await signUp(existing, "Pendaftar Awal");
    const existingId = await userIdOf(existing);
    const flag = await owner.query(
      'SELECT email_verified FROM "user" WHERE id = $1',
      [existingId],
    );
    expect(flag.rows[0].email_verified).toBe(false);
    const sessionsBefore = (await sessionRows(existingId)).length;

    const client = browser();
    const refused = await verifyLink(client, await issueToken(client, email));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("IDENTITY_ALREADY_LINKED");

    // No session for the magic-link browser, none added to the account.
    const me = await client.get("/api/auth/get-session");
    expect(me.body?.user?.id).toBeUndefined();
    const rows = await sessionRows(existingId);
    expect(rows).toHaveLength(sessionsBefore);
    expect(rows.map((r) => r.auth_method)).not.toContain("email_magic_link");
    // No second user was created for the same email.
    const count = await owner.query(
      'SELECT count(*)::int AS count FROM "user" WHERE lower(email) = $1',
      [email],
    );
    expect(count.rows[0].count).toBe(1);
  });

  it("does not exempt a staff user whose only role assignment has expired (409 IDENTITY_ALREADY_LINKED)", async () => {
    // F3: the takeover-guard staff exemption counts only currently active
    // assignments. newStaff() is an unverified password account with an owner
    // role; ending the window in the past removes the exemption.
    const staff = await newStaff();
    await owner.query(
      "UPDATE role_assignments SET valid_until = now() - interval '10 seconds' WHERE user_id = $1",
      [staff.userId],
    );
    const sessionsBefore = (await sessionRows(staff.userId)).length;

    const client = browser();
    const refused = await verifyLink(
      client,
      await issueToken(client, staff.email),
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("IDENTITY_ALREADY_LINKED");
    const me = await client.get("/api/auth/get-session");
    expect(me.body?.user?.id).toBeUndefined();
    expect(await sessionRows(staff.userId)).toHaveLength(sessionsBefore);
  });

  it("gives a banned user no session from a magic link", async () => {
    // F4: Assumption: the exact refusal status is not fixed by the spec, so
    // assert any 4xx plus the observable outcome (no session).
    const email = freshEmail();
    const first = browser();
    const verified = await verifyLink(first, await issueToken(first, email));
    expect(verified.status).toBe(200);
    const userId = verified.body.data.userId as string;
    trackedUserIds.push(userId);
    await owner.query('UPDATE "user" SET banned = true WHERE id = $1', [
      userId,
    ]);
    const sessionsBefore = (await sessionRows(userId)).length;

    const client = browser();
    const refused = await verifyLink(client, await issueToken(client, email));
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    const me = await client.get("/api/auth/get-session");
    expect(me.body?.user?.id).toBeUndefined();
    expect(await sessionRows(userId)).toHaveLength(sessionsBefore);
  });

  it("is single use: a replay is refused and opens no second session", async () => {
    const client = browser();
    const token = await issueToken(client, freshEmail());
    const first = await verifyLink(client, token);
    expect(first.status).toBe(200);
    trackedUserIds.push(first.body.data.userId);

    const replay = await verifyLink(browser(), token);
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe("CHALLENGE_NOT_PENDING");
    expect(await sessionRows(first.body.data.userId)).toHaveLength(1);
  });

  it("refuses a token that was never issued", async () => {
    const response = await verifyLink(
      browser(),
      randomBytes(32).toString("base64url"),
    );
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CHALLENGE_NOT_PENDING");
  });

  it("refuses a link after its 15 minutes and never signs in", async () => {
    const email = freshEmail();
    const client = browser();
    const token = await issueToken(client, email);
    // Five minutes of margin so database and API clock skew cannot matter.
    await owner.query(
      "UPDATE login_challenges SET expires_at = now() - interval '5 minutes' WHERE channel = 'email_magic_link'",
    );

    const expired = await verifyLink(client, token);
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe("CHALLENGE_EXPIRED");
    const state = await owner.query(
      "SELECT status FROM login_challenges WHERE channel = 'email_magic_link' AND tenant_id = $1",
      [TENANT_A],
    );
    expect(state.rows[0].status).toBe("expired");
    const sessions = await owner.query(
      `SELECT count(*)::int AS count FROM session s JOIN "user" u ON u.id = s.user_id WHERE u.email = $1`,
      [email],
    );
    expect(sessions.rows[0].count).toBe(0);
  });
});

describe("AUTH-01 email magic link: another browser", () => {
  it("marks a cross-device session and refuses WhatsApp linking from it with IDENTITY_LINK_REAUTH_REQUIRED", async () => {
    const email = freshEmail();
    const requester = browser();
    const token = await issueToken(requester, email);

    // The link is opened in a browser that never asked for it.
    const other = browser();
    const verified = await verifyLink(other, token);
    expect(verified.status).toBe(200);
    expect(verified.body.data.crossDevice).toBe(true);
    const userId = verified.body.data.userId as string;
    trackedUserIds.push(userId);
    expect(await sessionRows(userId)).toEqual([
      {
        kind: "customer",
        auth_method: "email_magic_link",
        auth_cross_device: true,
      },
    ]);

    // Every member feature but WhatsApp linking: the session is real.
    expect((await other.get("/api/auth/get-session")).body.user.id).toBe(
      userId,
    );
    const link = await other
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({});
    expect(link.status).toBe(403);
    expect(link.body.error.code).toBe("IDENTITY_LINK_REAUTH_REQUIRED");
    const challenges = await owner.query(
      "SELECT count(*)::int AS count FROM login_challenges WHERE channel = 'whatsapp_inbound' AND tenant_id = $1",
      [TENANT_A],
    );
    expect(challenges.rows[0].count).toBe(0);
  });

  it("lets a same-browser email session start WhatsApp linking", async () => {
    const client = browser();
    const verified = await verifyLink(
      client,
      await issueToken(client, freshEmail()),
    );
    expect(verified.body.data.crossDevice).toBe(false);
    trackedUserIds.push(verified.body.data.userId);

    const link = await client
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({});
    expect(link.status).toBe(201);
  });
});

describe("AUTH-01 banned user", () => {
  it("gets no session from WhatsApp login", async () => {
    // F4: Assumption: the webhook may answer completed 0 or 1, so assert only
    // the user-visible outcome: the poll yields no session and none is stored.
    const known = await whatsAppLogin(browser());
    trackedUserIds.push(known.userId);
    await owner.query('UPDATE "user" SET banned = true WHERE id = $1', [
      known.userId,
    ]);
    const sessionsBefore = (await sessionRows(known.userId)).length;

    const client = browser();
    const issued = await client
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({});
    expect(issued.status).toBe(201);
    await postWebhook(
      kirimPayload(
        `wamid.${randomUUID()}`,
        `MASUK LEGEND ${issued.body.data.codeFormatted}`,
      ),
    );
    const polled = await client.get(
      `/api/auth/login-challenges/${issued.body.data.challenge.id}`,
    );
    expect(polled.body?.data?.session ?? null).toBeNull();
    const me = await client.get("/api/auth/get-session");
    expect(me.body?.user?.id).toBeUndefined();
    expect(await sessionRows(known.userId)).toHaveLength(sessionsBefore);
  });
});

describe("AUTH-05 sign-in method gate: member methods never become management", () => {
  async function expectCustomerOnly(client: Client, userId: string) {
    const response = await client.get(STAFF_ROUTE);
    expect(response.status).toBe(403);
    // Not the MFA challenge: the session was never upgraded to management.
    expect(response.body.error.code).not.toBe("MFA_REQUIRED");
    const rows = await sessionRows(userId);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.kind).toBe("customer");
  }

  it("keeps a staff user's email login session customer-only (403 on staff routes)", async () => {
    const staff = await newStaff();
    const client = browser();
    const verified = await verifyLink(
      client,
      await issueToken(client, staff.email),
    );
    expect(verified.status).toBe(200);
    expect(verified.body.data.userId).toBe(staff.userId);
    await expectCustomerOnly(client, staff.userId);
    // The password session of the same user is untouched by this check.
    const methods = (await sessionRows(staff.userId)).map((r) => r.auth_method);
    expect(methods).toContain("email_magic_link");
  });

  it("keeps a staff user's WhatsApp login session customer-only (403 on staff routes)", async () => {
    const staff = await newStaff();
    await owner.query(
      "INSERT INTO user_identities (user_id, type, value_hash, verified_at) VALUES ($1, 'whatsapp', $2, now())",
      [staff.userId, await whatsAppDigest(SENDER)],
    );
    const client = browser();
    const session = await whatsAppLogin(client);
    expect(session.userId).toBe(staff.userId);
    await expectCustomerOnly(client, staff.userId);
    const methods = (await sessionRows(staff.userId)).map((r) => r.auth_method);
    expect(methods).toContain("whatsapp");
  });

  it("keeps a staff user's Google session customer-only (403 on staff routes)", async () => {
    const staff = await newStaff();
    // No live Google here: relabel the staff password session as a Google one.
    await owner.query(
      "UPDATE session SET auth_method = 'google' WHERE user_id = $1",
      [staff.userId],
    );
    await expectCustomerOnly(staff.client, staff.userId);
  });

  it("still upgrades a staff password session to management", async () => {
    const staff = await newStaff();
    await verifySessionMfa(staff.email);
    const response = await staff.client.get(STAFF_ROUTE);
    expect(response.status).toBe(200);
    const rows = await sessionRows(staff.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      kind: "management",
      auth_method: "password",
      auth_cross_device: false,
    });
  });

  it("keeps a member session without role denied on staff routes with PERMISSION_DENIED", async () => {
    // Asked for in k2l §M1: keep this green.
    const member = agent(app);
    await signUp(member, "Member Biasa");
    await userIdOf(member);
    const response = await member.get(STAFF_ROUTE);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("PERMISSION_DENIED");
  });
});

describe("Google sign-in and account linking", () => {
  const hooks = auth.options.databaseHooks;

  async function refuses(run: () => unknown): Promise<boolean> {
    try {
      return (await run()) === false;
    } catch {
      return true;
    }
  }

  it("is off when the Google env is empty", async () => {
    expect(auth.options.socialProviders?.google).toBeUndefined();
    const response = await agent(app)
      .post("/api/auth/sign-in/social")
      .set(originHeader)
      .send({ provider: "google", callbackURL: `${originHeader.Origin}/` });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(response.body?.url).toBeUndefined();
  });

  it("links a verified Google email to the existing account with the same email", () => {
    // Merge-by-email is Better Auth's accountLinking; Google is trusted for it.
    expect(auth.options.account?.accountLinking?.enabled).toBe(true);
    expect(auth.options.account?.accountLinking?.trustedProviders).toContain(
      "google",
    );
  });

  // The provider-side guard (an unverified or @wa.invalid Google profile) is
  // the google provider's `mapProfileToUser` in auth.ts. It exists only when
  // the Google env is set (this suite runs without it, see the "is off" test)
  // and is not exported, so it cannot be called here. `user.validateUserInfo`
  // is deliberately not used (it breaks internal createUser callers).
  it.todo(
    "mapProfileToUser refuses an @wa.invalid or unverified Google profile (needs an exported guard or a Google env in the test run)",
  );

  it("refuses to link a Google account to a user whose email is @wa.invalid or unverified with a password", async () => {
    // The row-side guard is `databaseHooks.account.create.before`: it throws to
    // refuse and returns nothing to allow.
    const before = hooks?.account?.create?.before;
    expect(before).toBeTypeOf("function");
    const placeholder = agent(app);
    await signUp(placeholder, "Placeholder");
    const placeholderId = await userIdOf(placeholder);
    await owner.query('UPDATE "user" SET email = $2 WHERE id = $1', [
      placeholderId,
      `${randomUUID()}@wa.invalid`,
    ]);
    const normal = agent(app);
    await signUp(normal, "Normal");
    const normalId = await userIdOf(normal);
    // A password sign-up leaves the email unverified, and linking Google to it
    // is refused (pre-registration takeover guard). Verified email: allowed.
    await owner.query('UPDATE "user" SET email_verified = true WHERE id = $1', [
      normalId,
    ]);
    const unverified = agent(app);
    await signUp(unverified, "Unverified");
    const unverifiedId = await userIdOf(unverified);

    const account = (userId: string) =>
      ({ providerId: "google", accountId: randomUUID(), userId }) as never;
    expect(await refuses(() => before!(account(placeholderId)))).toBe(true);
    expect(await refuses(() => before!(account(unverifiedId)))).toBe(true);
    expect(await refuses(() => before!(account(normalId)))).toBe(false);
  });

  it.todo(
    "Google callback with a verified email signs in the email-login user with the same email (needs a mocked Google provider)",
  );
});
