// legend-k2l follow-up: per-address throttle and login audit for the email
// magic link (AUTH-01/04). Service-level, real PostgreSQL and Better Auth, mock
// mail transport as in member-signin.test.ts.
//
// audit_logs is append-only, so rows of earlier runs stay: every audit read
// filters by challenge id, or by `createdAt >= STARTED` for rows that have no
// challenge (a throttled request creates none).

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { establishTenantContext } from "@starter/shared/core/server";
import type { TenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import {
  setEmailFromResolverForTests,
  setEmailSenderForTests,
  type EmailMessage,
} from "../lib/email-sender";
import {
  EMAIL_LINK_THROTTLE_LIMIT,
  EMAIL_LINK_THROTTLE_WINDOW_MS,
} from "../lib/email-link-throttle";
import {
  requestEmailMagicLink,
  verifyEmailMagicLink,
} from "../services/identity-email-login.service";
import { agent, signUp } from "./helpers";

const TENANT_A = cafeLegendPlatformFixtures.tenant.id;
const STARTED = new Date().toISOString();
const IP = "203.0.113.77";
const app = createApp();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const outbox: EmailMessage[] = [];
const trackedUserIds: string[] = [];

type AuditEvent = {
  action: string;
  objectType: string;
  objectId: string | null;
  actorType: string;
  actorId: string | null;
  ipHash: string | null;
  maskedChanges: { before: unknown; after: Record<string, unknown> | null };
};

function tenant(): TenantContext {
  return establishTenantContext({
    tenantId: TENANT_A,
    brandId: null,
    source: "session",
  });
}

function freshEmail(): string {
  return `ta-${randomUUID()}@example.com`;
}

function tokenOf(message: EmailMessage): string {
  const match = /#token=([A-Za-z0-9_-]{43})/.exec(message.text);
  if (!match) throw new Error("No #token= link in the mail text");
  return match[1]!;
}

function request(email: string, now?: Date) {
  return requestEmailMagicLink(
    tenant(),
    {
      email,
      bindingNonce: randomBytes(32).toString("base64url"),
      linkOrigin: "https://app.example.test",
      ip: IP,
      userAgent: "vitest",
    },
    now ? { now } : {},
  );
}

function verify(token: string, now?: Date) {
  return verifyEmailMagicLink(
    tenant(),
    { token, bindingNonce: null, ip: IP, userAgent: "vitest" },
    now ? { now } : {},
  );
}

async function challengeCount(): Promise<number> {
  const { rows } = await owner.query(
    "SELECT count(*)::int AS count FROM login_challenges WHERE channel = 'email_magic_link'",
  );
  return rows[0].count;
}

async function challengeIdOf(token: string): Promise<string> {
  const { magicLinkTokenDigest } = await import("../lib/identity-digest");
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM login_challenges WHERE code_hash = $1",
    [magicLinkTokenDigest(token)],
  );
  return rows[0]!.id;
}

async function auditOf(challengeId: string): Promise<AuditEvent[]> {
  const { rows } = await owner.query<{ event: AuditEvent }>(
    `SELECT event FROM audit_logs
      WHERE event->>'objectType' = 'login_challenge' AND event->>'objectId' = $1
      ORDER BY event->>'createdAt',
        CASE event->>'action'
          WHEN 'login_challenge.created' THEN 0
          WHEN 'login_challenge.completed' THEN 1
          ELSE 2
        END,
        id`,
    [challengeId],
  );
  return rows.map((row) => row.event);
}

async function throttledAudit(): Promise<AuditEvent[]> {
  const { rows } = await owner.query<{ event: AuditEvent }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = 'login_challenge.rate_limited'
        AND event->'maskedChanges'->'after'->>'cause' = 'email_throttled'
        AND event->>'createdAt' >= $2
      ORDER BY id`,
    [TENANT_A, STARTED],
  );
  return rows.map((row) => row.event);
}

function expectClean(events: AuditEvent[], secrets: string[]) {
  const stored = JSON.stringify(events);
  for (const secret of secrets) {
    expect(secret.length).toBeGreaterThan(3);
    expect(stored).not.toContain(secret);
  }
  for (const event of events) {
    expect(event.objectType).toBe("login_challenge");
    expect(event.ipHash === null || /^[a-f0-9]{64}$/.test(event.ipHash)).toBe(
      true,
    );
    expect(event.maskedChanges.after?.channel).toBe("email_magic_link");
  }
}

beforeEach(() => {
  outbox.length = 0;
  setEmailFromResolverForTests(async () => "masuk@brand.example.test");
  setEmailSenderForTests({
    async send(message) {
      outbox.push(message);
    },
  });
});

afterEach(() => {
  setEmailSenderForTests(undefined);
  setEmailFromResolverForTests(undefined);
});

afterAll(async () => {
  await owner.query(
    `DELETE FROM login_challenges WHERE channel = 'email_magic_link'`,
  );
  const users = await owner.query<{ id: string }>(
    `SELECT id FROM "user" WHERE email LIKE 'ta-%@example.com'`,
  );
  const ids = [...new Set([...trackedUserIds, ...users.rows.map((r) => r.id)])];
  if (ids.length > 0) {
    await owner.query("DELETE FROM user_identities WHERE user_id = ANY($1)", [
      ids,
    ]);
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [ids]);
  }
  await owner.end();
});

describe("email magic link: throttle per address", () => {
  it("sends the first limit requests, then answers the same and does nothing", async () => {
    expect(EMAIL_LINK_THROTTLE_LIMIT).toBe(3);
    expect(EMAIL_LINK_THROTTLE_WINDOW_MS).toBe(15 * 60_000);
    const email = freshEmail();
    const now = new Date();
    const answers = [];
    for (let i = 0; i < EMAIL_LINK_THROTTLE_LIMIT; i += 1)
      answers.push(await request(email, now));
    expect(outbox).toHaveLength(EMAIL_LINK_THROTTLE_LIMIT);
    const before = await challengeCount();

    const throttled = await request(email, now);
    expect(outbox).toHaveLength(EMAIL_LINK_THROTTLE_LIMIT);
    expect(await challengeCount()).toBe(before);
    expect(throttled.sent).toBe(true);
    expect(Object.keys(throttled).sort()).toEqual(
      Object.keys(answers[0]!).sort(),
    );
    expect(Date.parse(throttled.expiresAt)).toBe(
      Date.parse(answers[0]!.expiresAt),
    );
  });

  it("counts the normalised address: case and spaces do not dodge it", async () => {
    const email = freshEmail();
    const now = new Date();
    await request(email, now);
    await request(email.toUpperCase(), now);
    await request(`  ${email}  `, now);
    await request(email, now);
    expect(outbox).toHaveLength(3);
  });

  it("treats an unknown and a known address the same", async () => {
    const known = agent(app);
    const knownEmail = await signUp(known, "Sudah Ada");
    const now = new Date();
    for (const email of [knownEmail, freshEmail()]) {
      const before = outbox.length;
      for (let i = 0; i < 5; i += 1) {
        const answer = await request(email, now);
        expect(answer.sent).toBe(true);
      }
      expect(outbox.length - before).toBe(3);
    }
  });

  it("does not affect another address", async () => {
    const first = freshEmail();
    const now = new Date();
    for (let i = 0; i < 4; i += 1) await request(first, now);
    const before = outbox.length;
    await request(freshEmail(), now);
    expect(outbox.length).toBe(before + 1);
  });

  it("frees the address when the window ends", async () => {
    const email = freshEmail();
    const now = new Date();
    for (let i = 0; i < 4; i += 1) await request(email, now);
    expect(outbox).toHaveLength(3);

    const later = new Date(now.getTime() + EMAIL_LINK_THROTTLE_WINDOW_MS + 1);
    await request(email, later);
    expect(outbox).toHaveLength(4);
  });

  it("audits a throttled address once per window, without the address", async () => {
    const email = freshEmail();
    const now = new Date();
    const before = (await throttledAudit()).length;
    for (let i = 0; i < 6; i += 1) await request(email, now);
    const rows = await throttledAudit();
    // Three refused requests, one row: audit_logs is append-only.
    expect(rows).toHaveLength(before + 1);
    const row = rows[rows.length - 1]!;
    expect(row.objectId).toBeNull();
    expect(row.actorId).toBeNull();
    expectClean(rows, [email, email.split("@")[0]!]);
  });
});

describe("email magic link: login audit", () => {
  it("records created at issue, with no address, token or link", async () => {
    const email = freshEmail();
    const issued = await request(email);
    const token = tokenOf(outbox[0]!);
    const events = await auditOf(await challengeIdOf(token));

    expect(events.map((e) => e.action)).toEqual(["login_challenge.created"]);
    expect(events[0]!.maskedChanges.after?.status).toBe("pending");
    expect(events[0]!.maskedChanges.after?.expiresAt).toBe(issued.expiresAt);
    expect(events[0]!.actorId).toBeNull();
    expect(events[0]!.ipHash).toMatch(/^[a-f0-9]{64}$/);
    expectClean(events, [email, token, "#token="]);
  });

  it("records cancelled with cause email_send_failed when the mail fails", async () => {
    setEmailSenderForTests({
      async send() {
        throw new Error("EAUTH");
      },
    });
    const email = freshEmail();
    const { rows: before } = await owner.query<{ id: string }>(
      "SELECT id FROM login_challenges WHERE channel = 'email_magic_link'",
    );
    const answer = await request(email);
    expect(answer.sent).toBe(true);
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM login_challenges WHERE channel = 'email_magic_link' AND status = 'cancelled'",
    );
    const known = new Set(before.map((r) => r.id));
    const created = rows.find((r) => !known.has(r.id))!;
    const events = await auditOf(created.id);
    expect(events.map((e) => e.action)).toEqual([
      "login_challenge.created",
      "login_challenge.cancelled",
    ]);
    expect(events[1]!.maskedChanges.after?.cause).toBe("email_send_failed");
    expectClean(events, [email]);
  });

  it("records completed and claimed for the matched user on a good link", async () => {
    const email = freshEmail();
    await request(email);
    const token = tokenOf(outbox[0]!);
    const challengeId = await challengeIdOf(token);

    const result = await verify(token);
    trackedUserIds.push(result.view.userId);
    const events = await auditOf(challengeId);

    expect(events.map((e) => e.action)).toEqual([
      "login_challenge.created",
      "login_challenge.completed",
      "login_challenge.claimed",
    ]);
    for (const event of events.slice(1)) {
      expect(event.actorId).toBe(result.view.userId);
      expect(event.actorType).toBe("user");
      expect(event.maskedChanges.after?.matchedUserId).toBe(result.view.userId);
    }
    expect(events[1]!.ipHash).toMatch(/^[a-f0-9]{64}$/);
    expectClean(events, [email, token, result.session.token]);
  });

  it("records expired with cause ttl_elapsed", async () => {
    const email = freshEmail();
    const now = new Date();
    await request(email, now);
    const token = tokenOf(outbox[0]!);
    const challengeId = await challengeIdOf(token);

    await expect(
      verify(token, new Date(now.getTime() + 16 * 60_000)),
    ).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
    const events = await auditOf(challengeId);
    expect(events.map((e) => e.action)).toEqual([
      "login_challenge.created",
      "login_challenge.expired",
    ]);
    expect(events[1]!.maskedChanges.after?.cause).toBe("ttl_elapsed");
    expectClean(events, [email, token]);
  });

  it("records cancelled with a cause when the account is banned", async () => {
    const email = freshEmail();
    await request(email);
    const first = await verify(tokenOf(outbox[0]!));
    trackedUserIds.push(first.view.userId);
    await owner.query('UPDATE "user" SET banned = true WHERE id = $1', [
      first.view.userId,
    ]);

    await request(email, new Date(Date.now() + 1));
    const token = tokenOf(outbox[1]!);
    const challengeId = await challengeIdOf(token);
    await expect(verify(token)).rejects.toMatchObject({
      code: "CHALLENGE_NOT_PENDING",
    });
    const events = await auditOf(challengeId);
    expect(events.map((e) => e.action)).toEqual([
      "login_challenge.created",
      "login_challenge.cancelled",
    ]);
    expect(events[1]!.maskedChanges.after?.cause).toBe("account_refused");
    expectClean(events, [email, token]);
  });

  it("records rejected with cause already_linked for an unverified password account", async () => {
    const existing = agent(app);
    const email = await signUp(existing, "Pendaftar Awal");
    await request(email);
    const token = tokenOf(outbox[0]!);
    const challengeId = await challengeIdOf(token);

    await expect(verify(token)).rejects.toMatchObject({
      code: "IDENTITY_ALREADY_LINKED",
    });
    const events = await auditOf(challengeId);
    expect(events.map((e) => e.action)).toEqual([
      "login_challenge.created",
      "login_challenge.rejected",
    ]);
    expect(events[1]!.maskedChanges.after?.cause).toBe("already_linked");
    expectClean(events, [email, token]);
  });
});
