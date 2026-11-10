// legend-k2l identity merge on the WhatsApp link path (brief 290b "Tes
// gagal-dulu"; design ws08 M3; AUTH-07).
//
// Scenario: signed-in account U proves a WhatsApp number that account V already
// holds. If V is WhatsApp-only the accounts merge into U; otherwise the link is
// refused and nothing changes. Driven end to end through the real routes and
// the signed KirimDev webhook.
//
// Assumptions (spec silent, recorded here and in the report):
//   - A refused link is observed by the initiating browser's poll:
//     409 IDENTITY_MERGE_NEEDS_SUPPORT (V has an email identity, a role
//     assignment or a platform_admins row) or 409 WHATSAPP_ALREADY_ON_ACCOUNT
//     (U already holds another WhatsApp number). A merged link polls as
//     `completed` with no new session, like any link success.
//   - Merge outcomes are asserted through the database rows named in the brief
//     (user.banned, user.ban_reason, user_identities, identity_merges, session).
//   - Profile-dependent cases wait for legend-111j/290a (customer_profiles,
//     onWhatsAppVerified, recordMemberConsent) and are it.todo.
//   - identity_merges is append-only (trigger), so cleanup disables user
//     triggers on that table for the owner connection only.

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { signKirimWebhook } from "@starter/shared/adapters";
import { createApp } from "../app";
import { whatsAppDigest } from "../lib/identity-digest.ts";
import { mergedReplyText } from "../services/identity-merge.service";
import { agent, originHeader, signUp } from "./helpers";

const SECRET = "test-kirim-webhook-secret";
const fixtures = cafeLegendPlatformFixtures;
const HOST = fixtures.domains[0]!.hostname;
const TENANT_A = fixtures.tenant.id;
const NUMBER_A = "628111000001";
const SENDER = "6281234567890";
const OTHER_NUMBER = "6281999000111";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const app = createApp({ whatsappWebhookSecrets: [SECRET] });
const trackedUserIds: string[] = [];

type Client = ReturnType<typeof agent>;

function browser(): Client {
  return agent(app).host(HOST);
}

function kirimPayload(eventId: string, text: string, from: string) {
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
                { id: eventId, from, type: "text", text: { body: text } },
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
    .host(HOST)
    .post("/api/webhooks/whatsapp")
    .set("Content-Type", "application/json")
    .set("X-Kirim-Signature", signature)
    .set("X-Kirim-Event-Id", "evt-" + randomUUID())
    .send(body);
}

async function issueChallenge(client: Client) {
  const issued = await client
    .post("/api/auth/login-challenges/whatsapp")
    .set(originHeader)
    .send({});
  expect(issued.status).toBe(201);
  return issued.body.data as {
    challenge: { id: string };
    codeFormatted: string;
  };
}

function sendCode(codeFormatted: string, from = SENDER) {
  return postWebhook(
    kirimPayload(
      `wamid.${randomUUID()}`,
      `MASUK LEGEND ${codeFormatted}`,
      from,
    ),
  );
}

/** Link `from` to the account signed in on `client`; returns the poll result. */
async function link(client: Client, from = SENDER) {
  const issued = await issueChallenge(client);
  const delivered = await sendCode(issued.codeFormatted, from);
  const polled = await client.get(
    `/api/auth/login-challenges/${issued.challenge.id}`,
  );
  return { delivered, polled };
}

/** V: an account that exists only because its WhatsApp number logged in. */
async function whatsAppOnlyAccount(from = SENDER) {
  const client = browser();
  const issued = await issueChallenge(client);
  const delivered = await sendCode(issued.codeFormatted, from);
  expect(delivered.body.data.completed).toBe(1);
  const polled = await client.get(
    `/api/auth/login-challenges/${issued.challenge.id}`,
  );
  expect(polled.status).toBe(200);
  const userId = polled.body.data.session.userId as string;
  trackedUserIds.push(userId);
  return { client, userId };
}

/** U: a signed-in password account. */
async function signedInAccount() {
  const client = browser();
  const email = await signUp(client, "Akun Tujuan");
  const me = await client.get("/api/auth/get-session");
  const userId = me.body.user.id as string;
  trackedUserIds.push(userId);
  return { client, email, userId };
}

async function userRow(userId: string) {
  const { rows } = await owner.query<{
    banned: boolean | null;
    ban_reason: string | null;
  }>('SELECT banned, ban_reason FROM "user" WHERE id = $1', [userId]);
  return rows[0]!;
}

async function whatsappIdentities() {
  const { rows } = await owner.query<{
    user_id: string;
    verified_at: Date | null;
  }>(
    "SELECT user_id, verified_at FROM user_identities WHERE type = 'whatsapp'",
  );
  return rows;
}

async function merges() {
  const { rows } = await owner.query<{
    survivor_user_id: string;
    absorbed_user_id: string;
    trigger: string;
    identity_ids: string[];
    profile_moves: unknown;
  }>("SELECT * FROM identity_merges");
  return rows;
}

async function resetState() {
  await owner.query("DELETE FROM wa_inbound_messages");
  await owner.query("DELETE FROM login_challenges");
  // identity_merges is append-only; the owner connection may switch the guard
  // off only for this cleanup, then it is switched back on.
  await owner.query("ALTER TABLE identity_merges DISABLE TRIGGER USER");
  try {
    await owner.query("DELETE FROM identity_merges");
  } finally {
    await owner.query("ALTER TABLE identity_merges ENABLE TRIGGER USER");
  }
  await owner.query("DELETE FROM user_identities");
  const placeholders = await owner.query<{ id: string }>(
    `SELECT id FROM "user" WHERE email LIKE '%@wa.invalid'`,
  );
  const ids = [
    ...new Set([...trackedUserIds, ...placeholders.rows.map((r) => r.id)]),
  ];
  if (ids.length > 0) {
    await owner.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[]) OR assigned_by = ANY($1::text[])",
      [ids],
    );
    await owner.query(
      "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
      [ids],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [ids]);
  }
  trackedUserIds.length = 0;
}

async function ownerRoleId(): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
    [TENANT_A],
  );
  if (!rows[0]) throw new Error("No owner role");
  return rows[0].id;
}

beforeAll(async () => {
  await owner.query(
    `INSERT INTO tenant_integrations (tenant_id, provider, config, credentials_encrypted, status)
     VALUES ($1, 'whatsapp', $2, 'c2VhbGVkLXRlc3Q=', 'active')
     ON CONFLICT (tenant_id, provider) WHERE outlet_id IS NULL
     DO UPDATE SET config = EXCLUDED.config, status = EXCLUDED.status`,
    [
      TENANT_A,
      JSON.stringify({ vendor: "kirimdev", receivingNumber: NUMBER_A }),
    ],
  );
  await resetState();
});

beforeEach(resetState);

afterAll(async () => {
  await resetState();
  await owner.end();
});

describe("AUTH-07 merge of a WhatsApp-only account into the signed-in account", () => {
  it("moves the WhatsApp identity, bans the absorbed account and writes identity_merges", async () => {
    const v = await whatsAppOnlyAccount();
    const u = await signedInAccount();

    const { delivered, polled } = await link(u.client);
    expect(delivered.body.data.completed).toBe(1);
    expect(polled.status).toBe(200);
    expect(polled.body.data.challenge.status).toBe("completed");
    // A link never issues a new session: U keeps the one it has.
    expect(polled.body.data.session).toBeNull();

    const identities = await whatsappIdentities();
    expect(identities).toHaveLength(1);
    expect(identities[0]!.user_id).toBe(u.userId);
    expect(identities[0]!.verified_at).toBeTruthy();
    const heldByV = await owner.query(
      "SELECT count(*)::int AS count FROM user_identities WHERE user_id = $1",
      [v.userId],
    );
    expect(heldByV.rows[0].count).toBe(0);

    expect(await userRow(v.userId)).toEqual({
      banned: true,
      ban_reason: "merged",
    });
    expect((await userRow(u.userId)).banned).not.toBe(true);
    const vSessions = await owner.query(
      "SELECT count(*)::int AS count FROM session WHERE user_id = $1",
      [v.userId],
    );
    expect(vSessions.rows[0].count).toBe(0);
    expect((await u.client.get("/api/auth/get-session")).body.user.id).toBe(
      u.userId,
    );

    const rows = await merges();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      survivor_user_id: u.userId,
      absorbed_user_id: v.userId,
      trigger: "whatsapp_link",
    });
    expect(rows[0]!.identity_ids).toHaveLength(1);
    expect(Array.isArray(rows[0]!.profile_moves)).toBe(true);
  });

  it("refuses with IDENTITY_MERGE_NEEDS_SUPPORT when the absorbed account has an email identity", async () => {
    const v = await whatsAppOnlyAccount();
    await owner.query(
      "INSERT INTO user_identities (user_id, type, value_hash, verified_at) VALUES ($1, 'email', $2, now())",
      [v.userId, "e".repeat(64)],
    );
    const u = await signedInAccount();

    const { delivered, polled } = await link(u.client);
    expect(delivered.body.data.completed).toBe(0);
    expect(polled.status).toBe(409);
    expect(polled.body.error.code).toBe("IDENTITY_MERGE_NEEDS_SUPPORT");

    expect(await merges()).toHaveLength(0);
    expect((await userRow(v.userId)).banned).not.toBe(true);
    const identities = await whatsappIdentities();
    expect(identities).toHaveLength(1);
    expect(identities[0]!.user_id).toBe(v.userId);
  });

  // F1 (architect review): pre-k2l password accounts and Google users whose
  // identity write failed hold only a whatsapp identity row, so "WhatsApp-only"
  // must also look at the user email and Better Auth account rows. Assumption:
  // the absorbed account's sessions are kept as proof that nothing was touched.
  async function expectRefusedAndUntouched(
    v: { userId: string },
    u: { client: Client },
  ) {
    const { delivered, polled } = await link(u.client);
    expect(delivered.body.data.completed).toBe(0);
    expect(polled.status).toBe(409);
    expect(polled.body.error.code).toBe("IDENTITY_MERGE_NEEDS_SUPPORT");
    expect(await merges()).toHaveLength(0);
    expect((await userRow(v.userId)).banned).not.toBe(true);
    const vSessions = await owner.query(
      "SELECT count(*)::int AS count FROM session WHERE user_id = $1",
      [v.userId],
    );
    expect(vSessions.rows[0].count).toBeGreaterThan(0);
    const identities = await whatsappIdentities();
    expect(identities).toHaveLength(1);
    expect(identities[0]!.user_id).toBe(v.userId);
  }

  it("refuses with IDENTITY_MERGE_NEEDS_SUPPORT when the absorbed account has a real email and only a WhatsApp identity", async () => {
    const v = await whatsAppOnlyAccount();
    await owner.query('UPDATE "user" SET email = $2 WHERE id = $1', [
      v.userId,
      `real-${randomUUID()}@example.com`,
    ]);
    const u = await signedInAccount();
    await expectRefusedAndUntouched(v, u);
  });

  it("refuses with IDENTITY_MERGE_NEEDS_SUPPORT when the absorbed account has a credential account", async () => {
    const v = await whatsAppOnlyAccount();
    await owner.query(
      `INSERT INTO "account" (id, account_id, provider_id, user_id, password)
       VALUES ($1, $2, 'credential', $2, 'x')`,
      [randomUUID(), v.userId],
    );
    const u = await signedInAccount();
    await expectRefusedAndUntouched(v, u);
  });

  it("refuses with IDENTITY_MERGE_NEEDS_SUPPORT when the absorbed account has a role assignment", async () => {
    const v = await whatsAppOnlyAccount();
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
      [TENANT_A, v.userId, await ownerRoleId()],
    );
    const u = await signedInAccount();

    const { polled } = await link(u.client);
    expect(polled.status).toBe(409);
    expect(polled.body.error.code).toBe("IDENTITY_MERGE_NEEDS_SUPPORT");
    expect(await merges()).toHaveLength(0);
    expect((await userRow(v.userId)).banned).not.toBe(true);
    expect((await whatsappIdentities())[0]!.user_id).toBe(v.userId);
  });

  it("refuses with IDENTITY_MERGE_NEEDS_SUPPORT when the absorbed account is a platform admin", async () => {
    const v = await whatsAppOnlyAccount();
    await owner.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [
      v.userId,
    ]);
    const u = await signedInAccount();

    const { polled } = await link(u.client);
    expect(polled.status).toBe(409);
    expect(polled.body.error.code).toBe("IDENTITY_MERGE_NEEDS_SUPPORT");
    expect(await merges()).toHaveLength(0);
    expect((await userRow(v.userId)).banned).not.toBe(true);
    expect((await whatsappIdentities())[0]!.user_id).toBe(v.userId);
  });

  it("refuses with WHATSAPP_ALREADY_ON_ACCOUNT when the signed-in account holds another number", async () => {
    const v = await whatsAppOnlyAccount();
    const u = await signedInAccount();
    await owner.query(
      "INSERT INTO user_identities (user_id, type, value_hash, verified_at) VALUES ($1, 'whatsapp', $2, now())",
      [u.userId, await whatsAppDigest(OTHER_NUMBER)],
    );

    const { polled } = await link(u.client);
    expect(polled.status).toBe(409);
    expect(polled.body.error.code).toBe("WHATSAPP_ALREADY_ON_ACCOUNT");
    expect(await merges()).toHaveLength(0);
    expect((await userRow(v.userId)).banned).not.toBe(true);
    const held = await owner.query(
      "SELECT user_id FROM user_identities WHERE type = 'whatsapp' ORDER BY user_id",
    );
    expect(held.rows.map((r) => r.user_id).sort()).toEqual(
      [u.userId, v.userId].sort(),
    );
  });

  it("refuses with WHATSAPP_ALREADY_ON_ACCOUNT when linking a free number to an account that has one", async () => {
    const u = await signedInAccount();
    await owner.query(
      "INSERT INTO user_identities (user_id, type, value_hash, verified_at) VALUES ($1, 'whatsapp', $2, now())",
      [u.userId, await whatsAppDigest(OTHER_NUMBER)],
    );

    const { polled } = await link(u.client, SENDER);
    expect(polled.status).toBe(409);
    expect(polled.body.error.code).toBe("WHATSAPP_ALREADY_ON_ACCOUNT");
    const held = await whatsappIdentities();
    expect(held).toHaveLength(1);
    expect(held[0]!.user_id).toBe(u.userId);
  });

  it("lets the database refuse a second WhatsApp identity for one user, with a clear index name", async () => {
    const u = await signedInAccount();
    await owner.query(
      "INSERT INTO user_identities (user_id, type, value_hash, verified_at) VALUES ($1, 'whatsapp', $2, now())",
      [u.userId, await whatsAppDigest(SENDER)],
    );
    await expect(
      owner.query(
        "INSERT INTO user_identities (user_id, type, value_hash, verified_at) VALUES ($1, 'whatsapp', $2, now())",
        [u.userId, await whatsAppDigest(OTHER_NUMBER)],
      ),
    ).rejects.toThrow(/user_identities_one_whatsapp_per_user/);
  });

  it("gives one result when two merges for the same pair run at once", async () => {
    const v = await whatsAppOnlyAccount();
    const u = await signedInAccount();
    // A second browser signed in as the same U, so two links race.
    const second = browser();
    const signedIn = await second
      .post("/api/auth/sign-in/email")
      .set(originHeader)
      .send({ email: u.email, password: "Test-password-123!" });
    expect(signedIn.status).toBe(200);

    const [a, b] = await Promise.all([
      issueChallenge(u.client),
      issueChallenge(second),
    ]);
    const [first, other] = await Promise.all([
      sendCode(a.codeFormatted),
      sendCode(b.codeFormatted),
    ]);
    expect(first.status).toBe(200);
    expect(other.status).toBe(200);

    const rows = await merges();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      survivor_user_id: u.userId,
      absorbed_user_id: v.userId,
    });
    expect(await userRow(v.userId)).toEqual({
      banned: true,
      ban_reason: "merged",
    });
    const identities = await whatsappIdentities();
    expect(identities).toHaveLength(1);
    expect(identities[0]!.user_id).toBe(u.userId);
  });

  describe("merge reply text", () => {
    it("names the masked destination account when there is one", () => {
      const text = mergedReplyText("a***@example.com");
      expect(text).toContain("a***@example.com");
      expect(text).not.toMatch(/undefined|null/);
    });

    it("still reads cleanly when the destination has no email", () => {
      const text = mergedReplyText(null);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/undefined|null/);
    });
  });

  // Profile-dependent cases need customer_profiles, onWhatsAppVerified and
  // recordMemberConsent from legend-111j / 290a.
  it.todo(
    "moves the absorbed member profile per tenant to the survivor (waits for legend-111j/290a)",
  );
  it.todo(
    "closes U's profile with merged_into_profile_id only when it is pending_verification with no ledger and no WhatsApp hash, otherwise refuses (waits for legend-111j/290a)",
  );
  it.todo(
    "clears user_id on the closed U profile (waits for legend-111j/290a)",
  );
  it.todo(
    "refuses the merge when U's profile holds a voucher or an order (waits for legend-111j/290a)",
  );
  it.todo("re-records U's consent on V's profile (waits for legend-111j/290a)");
  it.todo(
    "a successful WhatsApp link and a merge call onWhatsAppVerified, and a pending_verification profile becomes active when loyalty consent is on (waits for legend-111j/290a)",
  );
});
