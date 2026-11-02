// WhatsApp reverse-OTP login: challenge, signed webhook, idempotency, rate
// limits and tenant scoping (PRD v1.7 §3 F6, §6 B; AUTH-01, AUTH-02, AUTH-04).
//
// HTTP tests run the real Express app, Better Auth and PostgreSQL against the
// disposable test database: the challenge endpoints, the KirimDev webhook with
// a real HMAC signature, and `GET /api/auth/get-session` proving the claimed
// session is an ordinary Better Auth session.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { signKirimWebhook } from "@starter/shared/adapters";
import {
  LOGIN_CODE_ALPHABET,
  LOGIN_CODE_TTL_MINUTES,
} from "@starter/shared/identity";
import { establishTenantContext } from "@starter/shared/core/server";
import type { TenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import {
  issueWhatsAppChallenge,
  pollWhatsAppChallenge,
} from "../services/identity-login.service";
import { processInboundWhatsApp } from "../services/identity-wa-inbound.service";
import { whatsAppDigest } from "../lib/identity-digest.ts";
import { agent, originHeader, signUp } from "./helpers";

const SECRET = "test-kirim-webhook-secret";
const fixtures = cafeLegendPlatformFixtures;
const TENANT_A = fixtures.tenant.id;
const TENANT_B = "b0a10000-0000-4000-8000-0000000000b1";
const NUMBER_A = "628111000001";
const NUMBER_B = "628111000002";
const SENDER = "6281234567890";
const ISSUED_CODE = "K7Q4M2XD";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const app = createApp({ whatsappWebhookSecrets: [SECRET] });

function tenantContext(tenantId: string): TenantContext {
  return establishTenantContext({ tenantId, brandId: null, source: "session" });
}

/** A fresh browser-binding nonce in the contract's shape (43 base64url chars). */
function nonce(): string {
  return randomBytes(32).toString("base64url");
}

/** KirimDev documents Meta's envelope for `message.received`. */
function kirimPayload(input: {
  eventId: string;
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
                  id: input.eventId,
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

/** Signs the exact bytes, the way KirimDev does, and posts them. */
async function postWebhook(body: string, secret = SECRET) {
  const signature = await signKirimWebhook({ rawBody: body, secret });
  return agent(app)
    .post("/api/webhooks/whatsapp")
    .set("Content-Type", "application/json")
    .set("X-Kirim-Signature", signature)
    .set("X-Kirim-Event-Id", "evt-" + randomUUID())
    .send(body);
}

function loginMessage(input: {
  eventId: string;
  text: string;
  phoneNumberId?: string;
  from?: string;
}) {
  return kirimPayload({
    eventId: input.eventId,
    from: input.from ?? SENDER,
    text: input.text,
    phoneNumberId: input.phoneNumberId ?? NUMBER_A,
  });
}

async function seedWhatsAppIntegration(
  tenantId: string,
  receivingNumber: string,
) {
  await owner.query(
    `INSERT INTO tenant_integrations (tenant_id, provider, config, credentials_encrypted, status)
     VALUES ($1, 'whatsapp', $2, 'c2VhbGVkLXRlc3Q=', 'active')
     ON CONFLICT (tenant_id, provider) WHERE outlet_id IS NULL
     DO UPDATE SET config = EXCLUDED.config, status = EXCLUDED.status`,
    [tenantId, JSON.stringify({ vendor: "kirimdev", receivingNumber })],
  );
}

beforeAll(async () => {
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, 'uji-identitas', 'Uji Identitas', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', $2, 'test')
     ON CONFLICT (id) DO NOTHING`,
    [
      TENANT_B,
      JSON.stringify({
        maxOutlets: 2,
        maxActiveEmployees: 5,
        maxDevices: 2,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
    ],
  );
  await seedWhatsAppIntegration(TENANT_A, NUMBER_A);
  await seedWhatsAppIntegration(TENANT_B, NUMBER_B);
});

beforeEach(async () => {
  // Each test owns the whole login state: the AUTH-04 windows are time based,
  // so a leftover row would make the next test flaky.
  await owner.query("DELETE FROM wa_inbound_messages");
  await owner.query("DELETE FROM login_challenges");
  await owner.query("DELETE FROM user_identities");
  await owner.query('DELETE FROM "user" WHERE email LIKE $1', ["%@wa.invalid"]);
});

afterAll(async () => {
  await owner.query("DELETE FROM wa_inbound_messages");
  await owner.query("DELETE FROM login_challenges");
  await owner.query("DELETE FROM user_identities");
  await owner.query('DELETE FROM "user" WHERE email LIKE $1', ["%@wa.invalid"]);
  await owner.query("DELETE FROM tenant_integrations WHERE tenant_id = $1", [
    TENANT_B,
  ]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [TENANT_B]);
  await owner.end();
});

describe("WhatsApp reverse-OTP login", () => {
  it("AUTH-01 issues a 40-bit code valid five minutes, bound to the asking browser", async () => {
    const browser = agent(app);
    const issued = await browser
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({});
    expect(issued.status).toBe(201);
    const { challenge, code, codeFormatted, whatsAppDeepLink } =
      issued.body.data;

    // 8 symbols from the 32-symbol Crockford alphabet = 40 bits.
    expect(code).toHaveLength(8);
    for (const symbol of code) expect(LOGIN_CODE_ALPHABET).toContain(symbol);
    expect(codeFormatted).toBe(`${code.slice(0, 4)}-${code.slice(4)}`);
    expect(
      Date.parse(challenge.expiresAt) - Date.parse(challenge.createdAt),
    ).toBe(LOGIN_CODE_TTL_MINUTES * 60_000);
    expect(challenge.channel).toBe("whatsapp_inbound");
    expect(challenge.status).toBe("pending");
    expect(challenge.tenantId).toBe(TENANT_A);
    // The per-tenant number: this tenant's own receiving number.
    expect(whatsAppDeepLink).toContain(`https://wa.me/${NUMBER_A}`);
    expect(decodeURIComponent(whatsAppDeepLink)).toContain(
      `MASUK LEGEND ${codeFormatted}`,
    );
    expect(String(issued.headers["set-cookie"])).toContain(".login_binding=");

    // Another browser that learns the challenge id gets nothing (AUTH-01).
    const other = agent(app);
    const peek = await other.get(`/api/auth/login-challenges/${challenge.id}`);
    expect(peek.status).toBe(403);
    expect(peek.body.error.code).toBe("CHALLENGE_BROWSER_MISMATCH");
  });

  it("AUTH-01 completes once and only the bound browser collects the session", async () => {
    const browser = agent(app);
    const issued = await browser
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({});
    const { challenge, codeFormatted } = issued.body.data;
    const path = `/api/auth/login-challenges/${challenge.id}`;

    // Before the message lands the browser just sees `pending`.
    const waiting = await browser.get(path);
    expect(waiting.status).toBe(200);
    expect(waiting.body.data.session).toBeNull();

    const delivered = await postWebhook(
      loginMessage({
        eventId: `wamid.${randomUUID()}`,
        text: `MASUK LEGEND ${codeFormatted}`,
      }),
    );
    expect(delivered.status).toBe(200);
    expect(delivered.body.data).toEqual({
      received: 1,
      duplicates: 0,
      completed: 1,
    });

    const claimed = await browser.get(path);
    expect(claimed.status).toBe(200);
    expect(claimed.body.data.challenge.status).toBe("completed");
    const session = claimed.body.data.session;
    expect(session).toBeTruthy();
    expect(session.kind).toBe("customer");
    expect(session.tenantId).toBe(TENANT_A);

    // It is an ordinary Better Auth session for a real account.
    const me = await browser.get("/api/auth/get-session");
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(session.userId);
    // ... and the account's WhatsApp identity was verified by this login.
    const identity = await owner.query(
      "SELECT verified_at FROM user_identities WHERE user_id = $1 AND type = $2",
      [session.userId, "whatsapp"],
    );
    expect(identity.rows[0]?.verified_at).toBeTruthy();

    // Single use: the same browser cannot collect it again (AUTH-01).
    const replay = await browser.get(path);
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe("CHALLENGE_NOT_PENDING");

    // And a different browser never could, even holding the challenge id.
    const thief = agent(app);
    expect((await thief.get(path)).status).toBe(403);
  });

  it("AUTH-07 links a verified number to the current account without issuing a new session", async () => {
    const browser = agent(app);
    await signUp(browser);
    const before = await browser.get("/api/auth/get-session");
    const issued = await browser
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({});
    expect(issued.status).toBe(201);
    const { challenge, codeFormatted } = issued.body.data;
    const delivered = await postWebhook(
      loginMessage({
        eventId: `wamid.${randomUUID()}`,
        text: `MASUK LEGEND ${codeFormatted}`,
      }),
    );
    expect(delivered.body.data.completed).toBe(1);
    const polled = await browser.get(
      `/api/auth/login-challenges/${challenge.id}`,
    );
    expect(polled.body.data.challenge.status).toBe("completed");
    expect(polled.body.data.session).toBeNull();
    const after = await browser.get("/api/auth/get-session");
    expect(after.body.user.id).toBe(before.body.user.id);
    expect(after.body.session.id).toBe(before.body.session.id);
    const identity = await owner.query(
      "SELECT user_id FROM user_identities WHERE type = 'whatsapp'",
    );
    expect(identity.rows).toEqual([{ user_id: before.body.user.id }]);
    const audit = await owner.query(
      "SELECT count(*)::int AS count FROM audit_logs WHERE event->>'action' = 'identity.linked' AND event->>'actorId' = $1",
      [before.body.user.id],
    );
    const events = await owner.query(
      "SELECT count(*)::int AS count FROM domain_event_outbox WHERE event->>'name' = 'identity.linked' AND event->'payload'->>'userId' = $1",
      [before.body.user.id],
    );
    expect(audit.rows[0].count).toBe(1);
    expect(events.rows[0].count).toBe(1);
  });

  it("AUTH-07 verifies an existing unverified WhatsApp identity on the same account", async () => {
    const browser = agent(app);
    await signUp(browser);
    const current = await browser.get("/api/auth/get-session");
    await owner.query(
      "INSERT INTO user_identities (user_id, type, value_hash, verified_at) VALUES ($1, 'whatsapp', $2, NULL)",
      [current.body.user.id, await whatsAppDigest(SENDER)],
    );
    const issued = await browser
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({});
    const delivered = await postWebhook(
      loginMessage({
        eventId: `wamid.${randomUUID()}`,
        text: `MASUK LEGEND ${issued.body.data.codeFormatted}`,
      }),
    );
    expect(delivered.body.data.completed).toBe(1);
    const rows = await owner.query(
      "SELECT user_id, verified_at FROM user_identities WHERE user_id = $1",
      [current.body.user.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].verified_at).toBeTruthy();
  });

  it("AUTH-07 rejects a number already linked to another account", async () => {
    const first = agent(app);
    await signUp(first);
    const issued = await first
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({});
    await postWebhook(
      loginMessage({
        eventId: `wamid.${randomUUID()}`,
        text: `MASUK LEGEND ${issued.body.data.codeFormatted}`,
      }),
    );
    const second = agent(app);
    await signUp(second);
    const other = await second
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({});
    const rejected = await postWebhook(
      loginMessage({
        eventId: `wamid.${randomUUID()}`,
        text: `MASUK LEGEND ${other.body.data.codeFormatted}`,
      }),
    );
    expect(rejected.body.data.completed).toBe(0);
    const rows = await owner.query(
      "SELECT count(*)::int AS count FROM user_identities WHERE type = 'whatsapp'",
    );
    expect(rows.rows[0].count).toBe(1);
    const conflict = await second.get(
      `/api/auth/login-challenges/${other.body.data.challenge.id}`,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDENTITY_ALREADY_LINKED");
  });

  it("AUTH-07 refuses linking after the initiating session is revoked", async () => {
    const browser = agent(app);
    await signUp(browser);
    const current = await browser.get("/api/auth/get-session");
    const issued = await browser
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({});
    await owner.query("DELETE FROM session WHERE id = $1", [
      current.body.session.id,
    ]);
    const rejected = await postWebhook(
      loginMessage({
        eventId: `wamid.${randomUUID()}`,
        text: `MASUK LEGEND ${issued.body.data.codeFormatted}`,
      }),
    );
    expect(rejected.body.data.completed).toBe(0);
    expect(
      (await owner.query("SELECT count(*)::int AS count FROM user_identities"))
        .rows[0].count,
    ).toBe(0);
  });

  it("AUTH-02 rejects a provider id replayed with different content", async () => {
    const eventId = `wamid.${randomUUID()}`;
    expect(
      (
        await postWebhook(
          loginMessage({ eventId, text: "MASUK LEGEND AAAAAA00" }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await postWebhook(
          loginMessage({ eventId, text: "MASUK LEGEND AAAAAA01" }),
        )
      ).status,
    ).toBe(409);
  });

  it("AUTH-02 treats a redelivery of a pre-fingerprint claim as a duplicate", async () => {
    const eventId = `wamid.${randomUUID()}`;
    const body = loginMessage({ eventId, text: "MASUK LEGEND AAAAAA02" });
    expect((await postWebhook(body)).status).toBe(200);
    // Rows claimed before migration 0029 have no request_hash.
    await owner.query(
      "UPDATE wa_inbound_messages SET request_hash = NULL WHERE provider_message_id = $1",
      [eventId],
    );
    const replay = await postWebhook(body);
    expect(replay.status).toBe(200);
    expect(replay.body.data.duplicates).toBe(1);
  });

  it("AUTH-02 rolls back a failed link claim and retries the same delivery once", async () => {
    const browser = agent(app);
    await signUp(browser);
    const issued = await browser
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({});
    const message = {
      eventId: `wamid.${randomUUID()}`,
      receivingNumber: NUMBER_A,
      sender: SENDER,
      text: `MASUK LEGEND ${issued.body.data.codeFormatted}`,
    };
    await expect(
      processInboundWhatsApp(message, {
        afterLinkWrite: async () => {
          throw new Error("injected failure");
        },
      }),
    ).rejects.toThrow("injected failure");
    expect(
      (
        await owner.query(
          "SELECT count(*)::int AS count FROM wa_inbound_messages",
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (await owner.query("SELECT count(*)::int AS count FROM user_identities"))
        .rows[0].count,
    ).toBe(0);
    expect((await processInboundWhatsApp(message)).kind).toBe("login");
    expect((await processInboundWhatsApp(message)).duplicate).toBe(true);
    expect(
      (await owner.query("SELECT count(*)::int AS count FROM user_identities"))
        .rows[0].count,
    ).toBe(1);
  });

  it("AUTH-04 serializes concurrent messages from one sender at the ten-attempt limit", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        processInboundWhatsApp({
          eventId: `wamid.${randomUUID()}`,
          receivingNumber: NUMBER_A,
          sender: SENDER,
          text: `MASUK LEGEND AAAA${i.toString().padStart(4, "0")}`,
        }),
      ),
    );
    expect(
      outcomes.filter((outcome) => outcome.kind === "rejected"),
    ).toHaveLength(10);
    expect(
      outcomes.filter((outcome) => outcome.kind === "rate_limited"),
    ).toHaveLength(10);
  });

  it("AUTH-01 stores only keyed digests, never the code or the raw number", async () => {
    const browser = agent(app);
    const issued = await browser
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({});
    const { code } = issued.body.data;
    const row = await owner.query(
      "SELECT code_hash, browser_binding_hash, ip_hash, user_agent FROM login_challenges",
    );
    const stored = JSON.stringify(row.rows);
    expect(row.rows).toHaveLength(1);
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(code.slice(0, 4));
    expect(stored).not.toContain(SENDER);
    expect(row.rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.rows[0].browser_binding_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("AUTH-01 rejects a code after its five-minute window and never signs in", async () => {
    const binding = nonce();
    const issued = await issueWhatsAppChallenge(
      tenantContext(TENANT_A),
      { bindingNonce: binding, ip: null, userAgent: "uji" },
      {
        now: new Date(Date.now() - (LOGIN_CODE_TTL_MINUTES + 1) * 60_000),
        generateCode: () => ISSUED_CODE,
      },
    );
    const outcome = await processInboundWhatsApp({
      eventId: `wamid.${randomUUID()}`,
      receivingNumber: NUMBER_A,
      sender: SENDER,
      text: `MASUK LEGEND ${issued.codeFormatted}`,
    });
    expect(outcome.kind).toBe("rejected");

    const polled = await pollWhatsAppChallenge(issued.challenge.id, {
      bindingNonce: binding,
      ip: null,
      userAgent: "uji",
    });
    expect(polled.view.challenge.status).toBe("expired");
    expect(polled.session).toBeNull();
    const sessions = await owner.query(
      'SELECT count(*)::int AS count FROM session WHERE user_id IN (SELECT id FROM "user" WHERE email LIKE $1)',
      ["%@wa.invalid"],
    );
    expect(sessions.rows[0].count).toBe(0);
  });

  it("AUTH-04 stops a device or IP at five challenges per fifteen minutes", async () => {
    // One browser (one binding cookie, one client IP) gets five, not six.
    const browser = agent(app);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const issued = await browser
        .post("/api/auth/login-challenges/whatsapp")
        .set(originHeader)
        .send({});
      expect(issued.status).toBe(201);
    }
    const blocked = await browser
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({});
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");

    // The per-device pivot alone (no IP) enforces the same ceiling.
    const device = nonce();
    for (let attempt = 0; attempt < 5; attempt += 1)
      await issueWhatsAppChallenge(tenantContext(TENANT_B), {
        bindingNonce: device,
        ip: null,
        userAgent: null,
      });
    await expect(
      issueWhatsAppChallenge(tenantContext(TENANT_B), {
        bindingNonce: device,
        ip: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("AUTH-04 stops one number at ten login messages an hour", async () => {
    const binding = nonce();
    const issued = await issueWhatsAppChallenge(
      tenantContext(TENANT_A),
      { bindingNonce: binding, ip: null, userAgent: null },
      { generateCode: () => ISSUED_CODE },
    );
    // Ten failed attempts from this number consume the window.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const outcome = await processInboundWhatsApp({
        eventId: `wamid.${randomUUID()}`,
        receivingNumber: NUMBER_A,
        sender: SENDER,
        text: `MASUK LEGEND AAAAAA${attempt.toString().padStart(2, "0")}`,
      });
      expect(outcome.kind).toBe("rejected");
    }
    // The eleventh is refused even with the right code...
    const limited = await processInboundWhatsApp({
      eventId: `wamid.${randomUUID()}`,
      receivingNumber: NUMBER_A,
      sender: SENDER,
      text: `MASUK LEGEND ${issued.codeFormatted}`,
    });
    expect(limited.kind).toBe("rate_limited");
    // ... and the challenge is still pending, so no session exists.
    const polled = await pollWhatsAppChallenge(issued.challenge.id, {
      bindingNonce: binding,
      ip: null,
      userAgent: null,
    });
    expect(polled.view.challenge.status).toBe("pending");
    expect(polled.session).toBeNull();
  });

  it("AUTH-02 verifies the KirimDev signature over the raw bytes and refuses forged deliveries", async () => {
    const body = loginMessage({
      eventId: `wamid.${randomUUID()}`,
      text: "MASUK LEGEND AAAAAA00",
    });
    const post = () =>
      agent(app)
        .post("/api/webhooks/whatsapp")
        .set("Content-Type", "application/json")
        .set("X-Kirim-Event-Id", "evt-" + randomUUID());

    // No signature, a wrong signature, and a signature over other bytes.
    expect((await post().send(body)).status).toBe(401);
    const forged = await post()
      .set(
        "X-Kirim-Signature",
        `t=${Math.floor(Date.now() / 1000)},v1=${"a".repeat(64)}`,
      )
      .send(body);
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe("UNAUTHORIZED");
    const swapped = await post()
      .set(
        "X-Kirim-Signature",
        await signKirimWebhook({
          rawBody: body.replace(SENDER, "6281299999999"),
          secret: SECRET,
        }),
      )
      .send(body);
    expect(swapped.status).toBe(401);
    // A stale timestamp is refused too (replay window is five minutes).
    const stale = await post()
      .set(
        "X-Kirim-Signature",
        await signKirimWebhook({
          rawBody: body,
          secret: SECRET,
          timestamp: Math.floor(Date.now() / 1000) - 3600,
        }),
      )
      .send(body);
    expect(stale.status).toBe(401);
    // Nothing was processed by any of the refused deliveries.
    const rows = await owner.query(
      "SELECT count(*)::int AS count FROM wa_inbound_messages",
    );
    expect(rows.rows[0].count).toBe(0);
  });

  it("AUTH-02 processes a repeated message id once", async () => {
    const browser = agent(app);
    const issued = await browser
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({});
    const body = loginMessage({
      eventId: `wamid.${randomUUID()}`,
      text: `MASUK LEGEND ${issued.body.data.codeFormatted}`,
    });
    const first = await postWebhook(body);
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({
      received: 1,
      duplicates: 0,
      completed: 1,
    });
    // A provider retry is signed again but carries the same message id.
    const retry = await postWebhook(body);
    expect(retry.status).toBe(200);
    expect(retry.body.data).toEqual({
      received: 1,
      duplicates: 1,
      completed: 0,
    });
    const completions = await owner.query(
      "SELECT count(*)::int AS count FROM login_challenges WHERE status = 'completed'",
    );
    expect(completions.rows[0].count).toBe(1);
    const claims = await owner.query(
      "SELECT count(*)::int AS count FROM login_challenges WHERE session_issued_at IS NOT NULL",
    );
    expect(claims.rows[0].count).toBe(0);
  });

  it("AUTH-02 rejects a message received on another tenant's number", async () => {
    const bindingA = nonce();
    const challengeA = await issueWhatsAppChallenge(
      tenantContext(TENANT_A),
      { bindingNonce: bindingA, ip: null, userAgent: null },
      { generateCode: () => ISSUED_CODE },
    );
    // Tenant B's number receives a message carrying tenant A's code.
    const cross = await processInboundWhatsApp({
      eventId: `wamid.${randomUUID()}`,
      receivingNumber: NUMBER_B,
      sender: SENDER,
      text: `MASUK LEGEND ${challengeA.codeFormatted}`,
    });
    expect(cross.kind).toBe("rejected");
    const stillPending = await pollWhatsAppChallenge(challengeA.challenge.id, {
      bindingNonce: bindingA,
      ip: null,
      userAgent: null,
    });
    expect(stillPending.view.challenge.status).toBe("pending");
    expect(stillPending.session).toBeNull();
    // No account was created for a rejected message.
    const identities = await owner.query(
      "SELECT count(*)::int AS count FROM user_identities",
    );
    expect(identities.rows[0].count).toBe(0);

    // And the other direction: tenant B's challenge is not completed by a
    // message on tenant A's number either.
    const bindingB = nonce();
    const challengeB = await issueWhatsAppChallenge(
      tenantContext(TENANT_B),
      { bindingNonce: bindingB, ip: null, userAgent: null },
      { generateCode: () => ISSUED_CODE },
    );
    const crossed = await processInboundWhatsApp({
      eventId: `wamid.${randomUUID()}`,
      receivingNumber: NUMBER_A,
      sender: SENDER,
      text: `MASUK LEGEND ${challengeB.codeFormatted}`,
    });
    expect(crossed.kind).toBe("rejected");
  });

  it("AUTH-02 dedupes on a globally unique provider message id without RLS on the global tables", async () => {
    const tables = await owner.query<{ relname: string; rls: boolean }>(
      `SELECT c.relname, c.relrowsecurity AS rls
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname IN ('login_challenges', 'wa_inbound_messages', 'user_identities')
       ORDER BY c.relname`,
    );
    // Coordinator decision note 4: these are global tables, service-scoped by
    // the receiving WhatsApp number, so no RLS (see docs/plan/contracts.md).
    expect(tables.rows).toEqual([
      { relname: "login_challenges", rls: false },
      { relname: "user_identities", rls: false },
      { relname: "wa_inbound_messages", rls: false },
    ]);
    const unique = await owner.query(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'public.wa_inbound_messages'::regclass AND contype = 'u'`,
    );
    expect(unique.rows.map((row: { conname: string }) => row.conname)).toEqual([
      "wa_inbound_messages_provider_id_key",
    ]);
  });

  it("AUTH-01 cancels a challenge from the asking browser only", async () => {
    const browser = agent(app);
    const issued = await browser
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({});
    const path = `/api/auth/login-challenges/${issued.body.data.challenge.id}`;
    const other = agent(app);
    const denied = await other.post(`${path}/cancel`).set(originHeader).send();
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("CHALLENGE_BROWSER_MISMATCH");
    const cancelled = await browser
      .post(`${path}/cancel`)
      .set(originHeader)
      .send();
    expect(cancelled.status).toBe(204);
    const polled = await browser.get(path);
    expect(polled.body.data.challenge.status).toBe("cancelled");
    // A cancelled code never signs anyone in, even when the message arrives.
    const outcome = await processInboundWhatsApp({
      eventId: `wamid.${randomUUID()}`,
      receivingNumber: NUMBER_A,
      sender: SENDER,
      text: `MASUK LEGEND ${issued.body.data.codeFormatted}`,
    });
    expect(outcome.kind).toBe("rejected");
  });

  it("AUTH-01 treats a message that is not a login message as no attempt at all", async () => {
    const outcome = await processInboundWhatsApp({
      eventId: `wamid.${randomUUID()}`,
      receivingNumber: NUMBER_A,
      sender: SENDER,
      text: "halo kak, mau tanya menu",
    });
    expect(outcome.kind).toBe("unknown");
    // Not counted against the AUTH-04 hourly quota.
    const row = await owner.query<{ kind: string }>(
      "SELECT kind FROM wa_inbound_messages",
    );
    expect(row.rows).toEqual([{ kind: "unknown" }]);
  });
});
