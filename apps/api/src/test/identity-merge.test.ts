// legend-k2l identity merge on the WhatsApp link path (brief 290b "Tes
// gagal-dulu"; design ws08 M3; AUTH-07).
//
// Scenario: signed-in account U proves a WhatsApp number that account V already
// holds. If V is WhatsApp-only the accounts merge and the OLDER account (by
// createdAt; tie: smaller id) survives, the other is absorbed; otherwise the
// link is refused and nothing changes. Driven end to end through the real
// routes and the signed KirimDev webhook.
//
// Assumptions (spec silent, recorded here and in the report):
//   - A refused link is observed by the initiating browser's poll:
//     409 IDENTITY_MERGE_NEEDS_SUPPORT (V has an email identity, a role
//     assignment or a platform_admins row) or 409 WHATSAPP_ALREADY_ON_ACCOUNT
//     (U already holds another WhatsApp number). A merged link polls as
//     `completed` with no new session, like any link success.
//   - Merge outcomes are asserted through the database rows named in the brief
//     (user.banned, user.ban_reason, user_identities, identity_merges, session).
//   - When U (the signed-in account) is the absorbed one, its sessions are
//     deleted, so the bound browser's poll claims one session for the survivor.
//   - identity_merges is append-only (trigger), so cleanup disables user
//     triggers on that table for the owner connection only.

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { signKirimWebhook } from "@starter/shared/adapters";
import { createApp } from "../app";
import { db } from "../db";
import { whatsAppDigest } from "../lib/identity-digest.ts";
import {
  mergeAbsorbedIntoSurvivor,
  mergedReplyText,
} from "../services/identity-merge.service";
import { agent, originHeader, signUp } from "./helpers";
import {
  asTenant,
  createWorld,
  ensureConsentPolicies,
  hex64,
  ledgerOf,
  seedConsent,
  seedOrder,
  seedProgram,
  type World,
} from "./member-loyalty-helpers";
import { grantPoints } from "./member-rewards-helpers";

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
const app = createApp({
  whatsappWebhookSecrets: [SECRET],
  loginChallengeRateLimit: { issuePerIp: 1_000, issuePerBinding: 1_000 },
});
const trackedUserIds: string[] = [];
const trackedProfiles: { tenantId: string; id: string }[] = [];

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
  // Member profiles cannot be deleted (ledger FK, closed-not-deleted rule), so
  // the ones this file seeded are closed and lose the number hash: a later
  // test may prove the same number without meeting a leftover unique key.
  for (const { tenantId, id } of trackedProfiles)
    await asTenant(tenantId, (client) =>
      client.query(
        `UPDATE customer_profiles
            SET membership_status = 'closed', whatsapp_hash = NULL, user_id = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      ),
    );
  trackedProfiles.length = 0;
}

async function ownerRoleId(): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
    [TENANT_A],
  );
  if (!rows[0]) throw new Error("No owner role");
  return rows[0].id;
}

/** Pins the age of an account: the older one survives a merge. */
async function makeOlder(older: { userId: string }, newer: { userId: string }) {
  await owner.query('UPDATE "user" SET created_at = $2 WHERE id = $1', [
    older.userId,
    "2020-01-01T00:00:00Z",
  ]);
  await owner.query('UPDATE "user" SET created_at = $2 WHERE id = $1', [
    newer.userId,
    "2021-01-01T00:00:00Z",
  ]);
}

/**
 * Turns the password account U into a Google-style one (no credential
 * account, an `account` row for Google, a verified e-mail identity): the only
 * kind of signed-in account that may be absorbed.
 */
async function toGoogleAccount(userId: string) {
  await owner.query(
    `DELETE FROM "account" WHERE user_id = $1 AND provider_id = 'credential'`,
    [userId],
  );
  await owner.query(
    `INSERT INTO "account" (id, account_id, provider_id, user_id)
     VALUES ($1, $2, 'google', $3)`,
    [randomUUID(), `g-${randomUUID()}`, userId],
  );
  await owner.query("DELETE FROM user_identities WHERE user_id = $1", [userId]);
  const identity = await owner.query<{ id: string }>(
    `INSERT INTO user_identities (user_id, type, value_hash, verified_at, is_primary)
     VALUES ($1, 'email', $2, now(), true) RETURNING id`,
    [userId, hex64()],
  );
  return { emailIdentityId: identity.rows[0]!.id };
}

async function accountOwner(userId: string) {
  const { rows } = await owner.query<{ email: string; name: string }>(
    'SELECT email, name FROM "user" WHERE id = $1',
    [userId],
  );
  return rows[0]!;
}

async function sessionCount(userId: string) {
  const { rows } = await owner.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM session WHERE user_id = $1",
    [userId],
  );
  return rows[0]!.count;
}

/** The two ids, smaller first, the way the tie-break compares them. */
function byTieBreak(a: string, b: string): [string, string] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

async function seedMemberProfile(
  tenantId: string,
  userId: string,
  options: { whatsappHash?: string | null; status?: string } = {},
) {
  const id = randomUUID();
  const whatsappHash = options.whatsappHash ?? null;
  await asTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO customer_profiles
         (id, tenant_id, user_id, whatsapp_hash, name, membership_status, whatsapp_verified_at)
       VALUES ($1, $2, $3, $4, 'Member Uji', $5, $6)`,
      [
        id,
        tenantId,
        userId,
        whatsappHash,
        options.status ?? (whatsappHash ? "active" : "pending_verification"),
        whatsappHash ? "2026-01-02T00:00:00Z" : null,
      ],
    ),
  );
  trackedProfiles.push({ tenantId, id });
  return id;
}

async function profileRow(tenantId: string, id: string) {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<{
      user_id: string | null;
      membership_status: string;
      merged_into_profile_id: string | null;
      whatsapp_hash: string | null;
      whatsapp_verified_at: Date | null;
      marketing_opt_in: boolean;
    }>(
      `SELECT user_id, membership_status, merged_into_profile_id, whatsapp_hash,
              whatsapp_verified_at, marketing_opt_in
         FROM customer_profiles WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return rows[0]!;
  });
}

async function consentRows(tenantId: string, profileId: string) {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<{
      purpose: string;
      decision: string;
      policy_version: string;
      source: string;
    }>(
      `SELECT purpose, decision, policy_version, source FROM consents
        WHERE tenant_id = $1 AND subject_id = $2 ORDER BY seq`,
      [tenantId, profileId],
    );
    return rows;
  });
}

async function auditRows(tenantId: string, action: string) {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<{
      actor_id: string | null;
      masked_changes: { after: Record<string, unknown> };
    }>(
      `SELECT event->>'actorId' AS actor_id, event->'maskedChanges' AS masked_changes
         FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = $2`,
      [tenantId, action],
    );
    return rows;
  });
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
  it("U older: moves the WhatsApp identity to U, bans V and writes identity_merges", async () => {
    const v = await whatsAppOnlyAccount();
    const u = await signedInAccount();
    await makeOlder(u, v);

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
    await makeOlder(u, v);
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

  describe("older account survives", () => {
    it("V older: V survives, U (Google-style) is absorbed and its browser gets one session for V", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await makeOlder(v, u);
      const { emailIdentityId } = await toGoogleAccount(u.userId);
      await owner.query(
        'UPDATE "user" SET email_verified = true WHERE id = $1',
        [u.userId],
      );
      const claimedFor = async (userId: string) =>
        (await auditRows(TENANT_A, "login_challenge.claimed")).filter(
          (row) => row.masked_changes.after.matchedUserId === userId,
        ).length;
      const claimedBefore = await claimedFor(v.userId);

      const { delivered, polled } = await link(u.client);
      expect(delivered.body.data.completed).toBe(1);
      expect(polled.status).toBe(200);
      expect(polled.body.data.challenge.status).toBe("completed");
      // U's sessions were deleted, so the bound browser is handed V's.
      expect(polled.body.data.session.userId).toBe(v.userId);
      expect((await u.client.get("/api/auth/get-session")).body.user.id).toBe(
        v.userId,
      );
      expect(await sessionCount(v.userId)).toBe(1);

      // Claimed once: the same browser polling again gets nothing more.
      const again = await u.client.get(
        `/api/auth/login-challenges/${polled.body.data.challenge.id}`,
      );
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("CHALLENGE_NOT_PENDING");
      expect(await sessionCount(v.userId)).toBe(1);
      // Review F1: V's own earlier browser (a previous owner of the number)
      // must not read the merged account: its session is gone.
      const oldV = await v.client.get("/api/auth/get-session");
      expect(oldV.body?.user?.id).toBeUndefined();

      const rows = await merges();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        survivor_user_id: v.userId,
        absorbed_user_id: u.userId,
        trigger: "whatsapp_link",
      });
      expect(rows[0]!.identity_ids).toEqual([emailIdentityId]);

      // U is closed, V holds U's e-mail (U gets a unique placeholder first).
      expect(await userRow(u.userId)).toEqual({
        banned: true,
        ban_reason: "merged",
      });
      expect((await accountOwner(u.userId)).email).toBe(
        `merged+${u.userId}@merged.invalid`,
      );
      const survivor = await accountOwner(v.userId);
      expect(survivor.email).toBe(u.email);
      expect(survivor.name).toBe("Akun Tujuan");
      const verified = await owner.query(
        'SELECT email_verified FROM "user" WHERE id = $1',
        [v.userId],
      );
      expect(verified.rows[0].email_verified).toBe(true);

      // U's identities and Google account follow to V; V's number stays on V
      // and stays the primary identity.
      const identities = await owner.query<{
        id: string;
        user_id: string;
        type: string;
        is_primary: boolean;
      }>("SELECT id, user_id, type, is_primary FROM user_identities");
      expect(identities.rows.every((row) => row.user_id === v.userId)).toBe(
        true,
      );
      expect(
        identities.rows.find((row) => row.id === emailIdentityId)?.is_primary,
      ).toBe(false);
      expect(identities.rows.filter((row) => row.is_primary)).toHaveLength(1);
      const accounts = await owner.query(
        `SELECT user_id FROM "account" WHERE provider_id = 'google' AND user_id IN ($1, $2)`,
        [u.userId, v.userId],
      );
      expect(accounts.rows.map((row) => row.user_id)).toEqual([v.userId]);
      expect(await sessionCount(u.userId)).toBe(0);

      // The trail names both accounts, and the claim is audited for V.
      // (audit_logs is append-only and shared, so rows are picked by user id.)
      const merged = (await auditRows(TENANT_A, "identity.merged")).filter(
        (row) => row.masked_changes.after.absorbedUserId === u.userId,
      );
      expect(merged).toHaveLength(1);
      expect(merged[0]!.masked_changes.after).toMatchObject({
        survivorUserId: v.userId,
        absorbedUserId: u.userId,
      });
      expect(await claimedFor(v.userId)).toBe(claimedBefore + 1);
    });

    it("V survives with U's data: V's completed but unclaimed challenges are cancelled in every tenant, claimed and foreign ones stay", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      const bystander = await signedInAccount();
      await makeOlder(v, u);
      await toGoogleAccount(u.userId);
      const second = await createWorld();
      const seedChallenge = async (
        tenantId: string,
        matchedUserId: string,
        issued: boolean,
      ) => {
        const id = randomUUID();
        await owner.query(
          `INSERT INTO login_challenges
             (id, tenant_id, channel, code_hash, browser_binding_hash, matched_user_id,
              status, expires_at, completed_at, session_issued_at)
           VALUES ($1, $2, 'whatsapp_inbound', $3, $4, $5, 'completed',
                   now() + interval '1 hour', now(), $6)`,
          [
            id,
            tenantId,
            hex64(),
            hex64(),
            matchedUserId,
            issued ? new Date() : null,
          ],
        );
        return id;
      };
      const sameTenant = await seedChallenge(TENANT_A, v.userId, false);
      const otherTenant = await seedChallenge(second.tenantId, v.userId, false);
      const claimed = await seedChallenge(second.tenantId, v.userId, true);
      const foreign = await seedChallenge(
        second.tenantId,
        bystander.userId,
        false,
      );
      const statusOf = async (id: string) =>
        (
          await owner.query<{ status: string }>(
            "SELECT status FROM login_challenges WHERE id = $1",
            [id],
          )
        ).rows[0]!.status;

      const { delivered } = await link(u.client);
      expect(delivered.body.data.completed).toBe(1);

      expect(await statusOf(sameTenant)).toBe("cancelled");
      expect(await statusOf(otherTenant)).toBe("cancelled");
      expect(await statusOf(claimed)).toBe("completed");
      expect(await statusOf(foreign)).toBe("completed");
    });

    it("breaks an age tie with the smaller id, in either direction", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await toGoogleAccount(u.userId);
      for (const id of [u.userId, v.userId])
        await owner.query('UPDATE "user" SET created_at = $2 WHERE id = $1', [
          id,
          "2020-01-01T00:00:00Z",
        ]);
      const [smaller, larger] = byTieBreak(u.userId, v.userId);

      await link(u.client);
      const rows = await merges();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        survivor_user_id: smaller,
        absorbed_user_id: larger,
      });
    });

    it("U older, V absorbed: the identity.linked trail and the challenge use U", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await makeOlder(u, v);

      await link(u.client);
      const merged = (await auditRows(TENANT_A, "identity.merged")).filter(
        (row) => row.masked_changes.after.absorbedUserId === v.userId,
      );
      expect(merged).toHaveLength(1);
      expect(merged[0]!.masked_changes.after).toMatchObject({
        survivorUserId: u.userId,
        absorbedUserId: v.userId,
      });
      const linked = await auditRows(TENANT_A, "identity.linked");
      expect(linked.some((row) => row.actor_id === u.userId)).toBe(true);
      const challenge = await owner.query(
        "SELECT matched_user_id, status FROM login_challenges WHERE link_user_id = $1",
        [u.userId],
      );
      expect(challenge.rows[0]).toMatchObject({
        matched_user_id: u.userId,
        status: "completed",
      });
    });
  });

  describe("guards on the absorbed signed-in account U", () => {
    async function expectRefusedAndUntouchedU(
      v: { userId: string },
      u: { client: Client; userId: string; email: string },
    ) {
      const sessionsBefore = await sessionCount(u.userId);
      const { delivered, polled } = await link(u.client);
      expect(delivered.body.data.completed).toBe(0);
      expect(polled.status).toBe(409);
      expect(polled.body.error.code).toBe("IDENTITY_MERGE_NEEDS_SUPPORT");
      expect(await merges()).toHaveLength(0);
      expect((await userRow(u.userId)).banned).not.toBe(true);
      expect((await userRow(v.userId)).banned).not.toBe(true);
      expect((await accountOwner(u.userId)).email).toBe(u.email);
      expect(await sessionCount(u.userId)).toBe(sessionsBefore);
      expect((await whatsappIdentities())[0]!.user_id).toBe(v.userId);
    }

    it("refuses when U has a role assignment", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await makeOlder(v, u);
      await toGoogleAccount(u.userId);
      await owner.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
         VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
        [TENANT_A, u.userId, await ownerRoleId()],
      );
      await expectRefusedAndUntouchedU(v, u);
    });

    it("refuses when U is a platform admin", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await makeOlder(v, u);
      await toGoogleAccount(u.userId);
      await owner.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [
        u.userId,
      ]);
      await expectRefusedAndUntouchedU(v, u);
    });

    it("refuses when U has a credential (password) account", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await makeOlder(v, u);
      await expectRefusedAndUntouchedU(v, u);
    });

    it("refuses with WHATSAPP_ALREADY_ON_ACCOUNT when U already holds a WhatsApp number", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await makeOlder(v, u);
      await toGoogleAccount(u.userId);
      const [proven] = await owner
        .query<{ id: string }>(
          "SELECT id FROM user_identities WHERE user_id = $1 AND type = 'whatsapp'",
          [v.userId],
        )
        .then((result) => result.rows);
      await owner.query(
        "INSERT INTO user_identities (user_id, type, value_hash, verified_at) VALUES ($1, 'whatsapp', $2, now())",
        [u.userId, await whatsAppDigest(OTHER_NUMBER)],
      );

      const outcome = await db.transaction((tx) =>
        mergeAbsorbedIntoSurvivor(tx, {
          survivorUserId: v.userId,
          absorbedUserId: u.userId,
          whatsappIdentityId: proven!.id,
          trigger: "whatsapp_link",
          actorUserId: u.userId,
          now: new Date(),
        }),
      );
      expect(outcome).toMatchObject({
        kind: "refused",
        code: "WHATSAPP_ALREADY_ON_ACCOUNT",
      });
      expect(await merges()).toHaveLength(0);
      expect((await userRow(u.userId)).banned).not.toBe(true);
    });
  });

  describe("member profiles move with the merge", () => {
    let world: World;
    beforeAll(async () => {
      world = await createWorld();
      await seedProgram(world.tenantId);
      await ensureConsentPolicies();
    });

    it("repoints the absorbed profile of every tenant to the survivor and leaves the ledger untouched", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await makeOlder(u, v);
      const profileA = await seedMemberProfile(TENANT_A, v.userId, {
        whatsappHash: hex64(),
      });
      const profileB = await seedMemberProfile(world.tenantId, v.userId, {
        whatsappHash: hex64(),
      });
      await grantPoints(world.tenantId, profileB, 120);
      const ledgerText = () =>
        asTenant(world.tenantId, async (client) => {
          const { rows } = await client.query<{ row: string }>(
            "SELECT t::text AS row FROM point_ledger t WHERE customer_profile_id = $1 ORDER BY posting_seq",
            [profileB],
          );
          return rows.map((row) => row.row);
        });
      const ledgerBefore = await ledgerText();
      expect(ledgerBefore).toHaveLength(1);
      const balance = () =>
        asTenant(world.tenantId, async (client) => {
          const { rows } = await client.query<{ points_balance: string }>(
            "SELECT points_balance::text FROM customer_profiles WHERE id = $1",
            [profileB],
          );
          return rows[0]!.points_balance;
        });
      expect(await balance()).toBe("120");

      const { delivered } = await link(u.client);
      expect(delivered.body.data.completed).toBe(1);

      expect((await profileRow(TENANT_A, profileA)).user_id).toBe(u.userId);
      expect((await profileRow(world.tenantId, profileB)).user_id).toBe(
        u.userId,
      );
      // Ledger rows follow the profile id: same bytes, same count, same balance.
      expect(await ledgerText()).toEqual(ledgerBefore);
      expect((await ledgerOf(world.tenantId, profileB)).length).toBe(1);
      expect(await balance()).toBe("120");

      const [row] = await merges();
      expect(row!.profile_moves).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tenantId: TENANT_A,
            profileId: profileA,
            action: "moved_to_survivor",
          }),
          expect.objectContaining({
            tenantId: world.tenantId,
            profileId: profileB,
            action: "moved_to_survivor",
          }),
        ]),
      );
    });

    it("closes the absorbed U's empty profile into V's, clears user_id and re-records U's consent on V's profile", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await makeOlder(v, u);
      await toGoogleAccount(u.userId);
      const survivorProfile = await seedMemberProfile(TENANT_A, v.userId, {
        whatsappHash: hex64(),
      });
      const emptyProfile = await seedMemberProfile(TENANT_A, u.userId);
      await seedConsent(TENANT_A, emptyProfile, {
        purpose: "loyalty",
        decision: "granted",
        policyVersion: "2026-01",
      });
      await seedConsent(TENANT_A, emptyProfile, {
        purpose: "marketing",
        decision: "granted",
        policyVersion: "2026-01",
      });

      const { delivered } = await link(u.client);
      expect(delivered.body.data.completed).toBe(1);

      expect(await profileRow(TENANT_A, emptyProfile)).toMatchObject({
        membership_status: "closed",
        user_id: null,
        merged_into_profile_id: survivorProfile,
      });
      const kept = await profileRow(TENANT_A, survivorProfile);
      expect(kept.user_id).toBe(v.userId);
      expect(kept.marketing_opt_in).toBe(true);
      expect(await consentRows(TENANT_A, survivorProfile)).toEqual([
        {
          purpose: "loyalty",
          decision: "granted",
          policy_version: "2026-01",
          source: "member_pwa",
        },
        {
          purpose: "marketing",
          decision: "granted",
          policy_version: "2026-01",
          source: "member_pwa",
        },
      ]);
      const [row] = await merges();
      expect(row!.profile_moves).toEqual([
        {
          tenantId: TENANT_A,
          profileId: emptyProfile,
          action: "closed_into_survivor",
        },
      ]);
    });

    async function expectProfileConflict(
      v: { userId: string },
      u: { client: Client; userId: string },
    ) {
      const { delivered, polled } = await link(u.client);
      expect(delivered.body.data.completed).toBe(0);
      expect(polled.status).toBe(409);
      expect(polled.body.error.code).toBe("IDENTITY_MERGE_NEEDS_SUPPORT");
      expect(await merges()).toHaveLength(0);
      expect((await userRow(u.userId)).banned).not.toBe(true);
      expect((await userRow(v.userId)).banned).not.toBe(true);
      expect((await whatsappIdentities())[0]!.user_id).toBe(v.userId);
    }

    it("refuses, writing nothing, when the absorbed U's profile holds a voucher", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await makeOlder(v, u);
      await toGoogleAccount(u.userId);
      // V's profile holds a consent, so it is not empty either: both have content.
      const vProfile = await seedMemberProfile(TENANT_A, v.userId, {
        whatsappHash: hex64(),
      });
      await seedConsent(TENANT_A, vProfile, { purpose: "loyalty" });
      const uProfile = await seedMemberProfile(TENANT_A, u.userId);
      // A profile of U in another tenant that alone could be moved: the refusal
      // must leave it untouched too.
      const otherTenantProfile = await seedMemberProfile(
        world.tenantId,
        u.userId,
      );
      await asTenant(TENANT_A, (client) =>
        client.query(
          `INSERT INTO vouchers (tenant_id, customer_profile_id, code_hash, source, status, value_idr, valid_from)
           VALUES ($1, $2, $3, 'manual', 'issued', 10000, now())`,
          [TENANT_A, uProfile, hex64()],
        ),
      );

      await expectProfileConflict(v, u);
      expect((await profileRow(TENANT_A, uProfile)).user_id).toBe(u.userId);
      expect(
        (await profileRow(world.tenantId, otherTenantProfile)).user_id,
      ).toBe(u.userId);
      await asTenant(TENANT_A, (client) =>
        client.query("DELETE FROM vouchers WHERE customer_profile_id = $1", [
          uProfile,
        ]),
      );
    });

    it("refuses when the absorbed U's profile is the referee of a referral", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await makeOlder(v, u);
      await toGoogleAccount(u.userId);
      const vProfile = await seedMemberProfile(TENANT_A, v.userId, {
        whatsappHash: hex64(),
      });
      await seedConsent(TENANT_A, vProfile, { purpose: "loyalty" });
      const uProfile = await seedMemberProfile(TENANT_A, u.userId);
      // `referrals` names the profile in referrer_profile_id/referee_profile_id,
      // not customer_profile_id, so only an explicit check sees it.
      await asTenant(TENANT_A, (client) =>
        client.query(
          `INSERT INTO referrals (tenant_id, referrer_profile_id, referee_profile_id, code, referrer_points, referee_points)
           VALUES ($1, $2, $3, 'REFTEST1', 0, 0)`,
          [TENANT_A, vProfile, uProfile],
        ),
      );

      await expectProfileConflict(v, u);
      expect((await profileRow(TENANT_A, uProfile)).user_id).toBe(u.userId);
      await asTenant(TENANT_A, (client) =>
        client.query("DELETE FROM referrals WHERE referee_profile_id = $1", [
          uProfile,
        ]),
      );
    });

    it("refuses when the absorbed U's profile holds an order", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await makeOlder(v, u);
      await toGoogleAccount(u.userId);
      // V's profile holds a consent, so it is not empty either: both have content.
      const vProfile = await seedMemberProfile(world.tenantId, v.userId, {
        whatsappHash: hex64(),
      });
      await seedConsent(world.tenantId, vProfile, { purpose: "loyalty" });
      const uProfile = await seedMemberProfile(world.tenantId, u.userId);
      await seedOrder(world.tenantId, {
        outletId: world.outletA,
        profileId: uProfile,
      });

      await expectProfileConflict(v, u);
      expect((await profileRow(world.tenantId, uProfile)).user_id).toBe(
        u.userId,
      );
    });

    it("refuses when both accounts have a profile, the absorbed V's holds a WhatsApp number and the survivor U's holds a consent", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await makeOlder(u, v);
      const vProfile = await seedMemberProfile(TENANT_A, v.userId, {
        whatsappHash: hex64(),
      });
      const uProfile = await seedMemberProfile(TENANT_A, u.userId);
      await seedConsent(TENANT_A, uProfile, {
        purpose: "loyalty",
        decision: "granted",
        policyVersion: "2026-01",
      });

      await expectProfileConflict(v, u);
      expect((await profileRow(TENANT_A, vProfile)).user_id).toBe(v.userId);
      expect(await profileRow(TENANT_A, uProfile)).toMatchObject({
        user_id: u.userId,
        membership_status: "pending_verification",
        merged_into_profile_id: null,
      });
    });

    it("survivor U's profile is empty and absorbed V's holds points: V's profile follows U, U's is closed into it, the ledger is untouched", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await makeOlder(u, v);
      const uProfile = await seedMemberProfile(world.tenantId, u.userId);
      const vProfile = await seedMemberProfile(world.tenantId, v.userId, {
        whatsappHash: hex64(),
      });
      await grantPoints(world.tenantId, vProfile, 80);
      const ledgerBefore = await ledgerOf(world.tenantId, vProfile);
      expect(ledgerBefore).toHaveLength(1);

      const { delivered } = await link(u.client);
      expect(delivered.body.data.completed).toBe(1);

      expect(await profileRow(world.tenantId, uProfile)).toMatchObject({
        membership_status: "closed",
        user_id: null,
        merged_into_profile_id: vProfile,
      });
      const kept = await profileRow(world.tenantId, vProfile);
      expect(kept.user_id).toBe(u.userId);
      expect(kept.membership_status).not.toBe("closed");
      // Ledger: same rows on V's profile, none on the closed one.
      expect(await ledgerOf(world.tenantId, vProfile)).toEqual(ledgerBefore);
      expect(await ledgerOf(world.tenantId, uProfile)).toHaveLength(0);

      const [row] = await merges();
      expect(row!.profile_moves).toEqual([
        {
          tenantId: world.tenantId,
          profileId: uProfile,
          action: "survivor_closed_into_absorbed",
          intoProfileId: vProfile,
        },
      ]);
    });

    it("refuses when the survivor U's profile is empty but suspended: closing it would drop the suspension", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await makeOlder(u, v);
      const uProfile = await seedMemberProfile(world.tenantId, u.userId, {
        whatsappHash: hex64(),
        status: "suspended",
      });
      const vProfile = await seedMemberProfile(world.tenantId, v.userId, {
        whatsappHash: hex64(),
      });
      await grantPoints(world.tenantId, vProfile, 40);

      await expectProfileConflict(v, u);
      expect(await profileRow(world.tenantId, uProfile)).toMatchObject({
        user_id: u.userId,
        membership_status: "suspended",
        merged_into_profile_id: null,
      });
      expect((await profileRow(world.tenantId, vProfile)).user_id).toBe(
        v.userId,
      );
    });

    it("an empty survivor profile with a WhatsApp number and active status still counts as empty, and the number does not collide", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await makeOlder(u, v);
      // U's profile holds the very number V proves: onWhatsAppVerified later
      // sets that hash on V's profile, so U's must be out of the unique index.
      const uProfile = await seedMemberProfile(TENANT_A, u.userId, {
        whatsappHash: await whatsAppDigest(SENDER),
      });
      const vProfile = await seedMemberProfile(TENANT_A, v.userId, {
        whatsappHash: hex64(),
      });

      const { delivered } = await link(u.client);
      expect(delivered.body.data.completed).toBe(1);

      expect(await profileRow(TENANT_A, uProfile)).toMatchObject({
        membership_status: "closed",
        user_id: null,
        merged_into_profile_id: vProfile,
      });
      // V's profile carries a number, so it has content; hash only is enough.
      const kept = await profileRow(TENANT_A, vProfile);
      expect(kept.user_id).toBe(u.userId);
      expect(kept.whatsapp_hash).toBe(await whatsAppDigest(SENDER));
    });

    it("a survivor profile closed in another tenant than the webhook's hands its verified WhatsApp number to the kept profile", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await makeOlder(u, v);
      // The webhook runs in TENANT_A: onWhatsAppVerified only reaches that
      // tenant, so the other tenant's number must travel with the merge itself.
      const digest = await whatsAppDigest(SENDER);
      const uProfile = await seedMemberProfile(world.tenantId, u.userId, {
        whatsappHash: digest,
      });
      const vProfile = await seedMemberProfile(world.tenantId, v.userId);
      await seedConsent(world.tenantId, vProfile, {
        purpose: "loyalty",
        decision: "granted",
        policyVersion: "2026-01",
      });
      await grantPoints(world.tenantId, vProfile, 60);

      const { delivered } = await link(u.client);
      expect(delivered.body.data.completed).toBe(1);

      expect(await profileRow(world.tenantId, uProfile)).toMatchObject({
        membership_status: "closed",
        user_id: null,
        merged_into_profile_id: vProfile,
      });
      const kept = await profileRow(world.tenantId, vProfile);
      expect(kept.user_id).toBe(u.userId);
      expect(kept.whatsapp_hash).toBe(digest);
      expect(kept.whatsapp_verified_at).toBeTruthy();
      expect(kept.membership_status).toBe("active");
    });

    it("waits for an in-flight insert on the survivor U's profile and then refuses: no row is stranded on a closed profile", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await makeOlder(u, v);
      const uProfile = await seedMemberProfile(world.tenantId, u.userId);
      const vProfile = await seedMemberProfile(world.tenantId, v.userId, {
        whatsappHash: hex64(),
      });
      await grantPoints(world.tenantId, vProfile, 80);

      // An open transaction inserts a voucher on U's profile: the foreign key
      // takes a key-share lock on the row, which FOR NO KEY UPDATE does not
      // wait for. The merge must queue behind it (FOR UPDATE), see the
      // committed row, and refuse instead of closing a profile that now holds it.
      let linking: ReturnType<typeof link> | undefined;
      let sawWaiter = false;
      await asTenant(world.tenantId, async (client) => {
        await client.query(
          `INSERT INTO vouchers (tenant_id, customer_profile_id, code_hash, source, status, value_idr, valid_from)
           VALUES ($1, $2, $3, 'manual', 'issued', 10000, now())`,
          [world.tenantId, uProfile, hex64()],
        );
        linking = link(u.client);
        for (let attempt = 0; attempt < 100 && !sawWaiter; attempt += 1) {
          const { rows } = await owner.query(
            `SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          );
          sawWaiter = rows.length > 0;
          if (!sawWaiter)
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
      });
      expect(sawWaiter).toBe(true);

      const { delivered, polled } = await linking!;
      expect(delivered.body.data.completed).toBe(0);
      expect(polled.status).toBe(409);
      expect(polled.body.error.code).toBe("IDENTITY_MERGE_NEEDS_SUPPORT");
      expect(await merges()).toHaveLength(0);
      expect(await profileRow(world.tenantId, uProfile)).toMatchObject({
        user_id: u.userId,
        membership_status: "pending_verification",
        merged_into_profile_id: null,
      });
      expect((await profileRow(world.tenantId, vProfile)).user_id).toBe(
        v.userId,
      );
      await asTenant(world.tenantId, (client) =>
        client.query("DELETE FROM vouchers WHERE customer_profile_id = $1", [
          uProfile,
        ]),
      );
    });

    it("refuses, writing nothing, when both profiles hold points", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await makeOlder(u, v);
      const uProfile = await seedMemberProfile(world.tenantId, u.userId);
      const vProfile = await seedMemberProfile(world.tenantId, v.userId, {
        whatsappHash: hex64(),
      });
      await grantPoints(world.tenantId, uProfile, 30);
      await grantPoints(world.tenantId, vProfile, 80);

      await expectProfileConflict(v, u);
      expect(await profileRow(world.tenantId, uProfile)).toMatchObject({
        user_id: u.userId,
        membership_status: "pending_verification",
        merged_into_profile_id: null,
      });
      expect((await profileRow(world.tenantId, vProfile)).user_id).toBe(
        v.userId,
      );
      expect(await ledgerOf(world.tenantId, uProfile)).toHaveLength(1);
      expect(await ledgerOf(world.tenantId, vProfile)).toHaveLength(1);
    });

    it("a plain link calls onWhatsAppVerified: a pending profile becomes active when loyalty consent is on", async () => {
      const u = await signedInAccount();
      const profile = await seedMemberProfile(TENANT_A, u.userId);
      await seedConsent(TENANT_A, profile, {
        purpose: "loyalty",
        decision: "granted",
        policyVersion: "2026-01",
      });

      const { delivered } = await link(u.client);
      expect(delivered.body.data.completed).toBe(1);

      expect(await profileRow(TENANT_A, profile)).toMatchObject({
        membership_status: "active",
        whatsapp_hash: await whatsAppDigest(SENDER),
      });
    });

    it("a merge calls onWhatsAppVerified for the survivor", async () => {
      const v = await whatsAppOnlyAccount();
      const u = await signedInAccount();
      await makeOlder(u, v);
      const profile = await seedMemberProfile(TENANT_A, u.userId);
      await seedConsent(TENANT_A, profile, {
        purpose: "loyalty",
        decision: "granted",
        policyVersion: "2026-01",
      });

      const { delivered } = await link(u.client);
      expect(delivered.body.data.completed).toBe(1);

      const row = await profileRow(TENANT_A, profile);
      expect(row.membership_status).toBe("active");
      expect(row.whatsapp_hash).toBe(await whatsAppDigest(SENDER));
      expect(row.whatsapp_verified_at).toBeTruthy();
    });
  });
});
