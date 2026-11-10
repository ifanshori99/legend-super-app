// Card w8dfz.1: customer WhatsApp login can require the person to confirm the
// masked sender number ("+62 812-****-7890") or press "Bukan saya" before any
// session is issued.
//
// Written from the decided design (coordinator brief) and the PRD login flow
// (docs/PRD.md section C, AUTH-01), not from the implementation.
//
// Design under test:
// - Create body accepts optional `requireConfirm: boolean` (default false =
//   old behaviour: the poll after the message issues the session).
// - requireConfirm=true: once the message lands, the poll shows
//   `senderMasked` and `awaitingConfirmation: true`, with NO session and NO
//   session cookie. POST /:id/confirm (bound browser only) makes the next
//   poll issue the session. POST /:id/cancel ("Bukan saya") works while
//   awaiting (204, idempotent); then no session is ever issued and a later
//   confirm is rejected.
//
// Assumptions (spec does not fix them):
// - `senderMasked` / `awaitingConfirmation` are read from `data` or, if not
//   there, from `data.challenge` (the poll view's exact nesting is not fixed).
// - The confirm success status is any 2xx; rejections are any 4xx.
// - The exact mask shape is not fixed: it must keep the last 4 digits (7890),
//   hide the middle with a mask character, and the full number must never
//   appear in any form (628..., +628..., 08...).
// - A non-boolean `requireConfirm` is rejected with a 4xx.

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { signKirimWebhook } from "@starter/shared/adapters";
import { createApp } from "../app";
import { agent, originHeader } from "./helpers";

const SECRET = "test-kirim-webhook-secret";
const fixtures = cafeLegendPlatformFixtures;
const TENANT_A = fixtures.tenant.id;
const NUMBER_A = "628111000001";
const SENDER = "6281234567890";
const SENDER_LOCAL = "081234567890";
const SENDER_LAST4 = "7890";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const app = createApp({ whatsappWebhookSecrets: [SECRET] });
const host = fixtures.domains[0]!.hostname;

function kirimPayload(input: { eventId: string; from: string; text: string }) {
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

async function sendLoginMessage(codeFormatted: string) {
  const body = kirimPayload({
    eventId: `wamid.${randomUUID()}`,
    from: SENDER,
    text: `MASUK LEGEND ${codeFormatted}`,
  });
  const signature = await signKirimWebhook({ rawBody: body, secret: SECRET });
  return agent(app)
    .host(host)
    .post("/api/webhooks/whatsapp")
    .set("Content-Type", "application/json")
    .set("X-Kirim-Signature", signature)
    .set("X-Kirim-Event-Id", "evt-" + randomUUID())
    .send(body);
}

async function newChallenge(body: Record<string, unknown> = {}) {
  const browser = agent(app).host(host);
  const issued = await browser
    .post("/api/auth/login-challenges/whatsapp")
    .set(originHeader)
    .send(body);
  expect(issued.status).toBe(201);
  const { challenge, codeFormatted } = issued.body.data;
  return {
    browser,
    codeFormatted: codeFormatted as string,
    path: `/api/auth/login-challenges/${challenge.id as string}`,
  };
}

/** A challenge whose message already landed, waiting for confirmation. */
async function awaitingChallenge() {
  const c = await newChallenge({ requireConfirm: true });
  expect((await sendLoginMessage(c.codeFormatted)).body.data.completed).toBe(1);
  return c;
}

function viewField(data: any, name: string): unknown {
  return data?.[name] ?? data?.challenge?.[name];
}

function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out));
  else if (value && typeof value === "object")
    Object.values(value).forEach((v) => allStrings(v, out));
  return out;
}

function digitsOnly(text: string): string {
  return text.replace(/\D/g, "");
}

/** The view shows a masked rendering of the number and never the whole. */
function expectMaskedNumberOnly(data: unknown) {
  const masked = viewField(data, "senderMasked");
  expect(typeof masked, "senderMasked must be a string").toBe("string");
  const text = masked as string;
  expect(text).toContain(SENDER_LAST4);
  expect(text).toMatch(/[*•xX#]/);
  // Masked means the middle digits are hidden: fewer digits than the number.
  expect(digitsOnly(text).length).toBeLessThan(SENDER.length - 2);
  const serialized = JSON.stringify(data);
  expect(serialized).not.toContain(SENDER);
  expect(serialized).not.toContain(SENDER_LOCAL);
  expect(serialized).not.toContain(SENDER.slice(2));
  for (const s of allStrings(data)) {
    expect(digitsOnly(s)).not.toContain(SENDER.slice(2));
  }
}

function expectNoSession(res: { body: any; headers: any }) {
  expect(res.body.data?.session ?? null).toBeNull();
  expect(res.headers["set-cookie"]).toBeUndefined();
}

async function wipe() {
  await owner.query("DELETE FROM wa_inbound_messages");
  await owner.query("DELETE FROM login_challenges");
  await owner.query("DELETE FROM user_identities");
  await owner.query(
    `DELETE FROM role_assignments
      WHERE user_id IN (SELECT id FROM "user" WHERE email LIKE $1)
         OR assigned_by IN (SELECT id FROM "user" WHERE email LIKE $1)`,
    ["%@wa.invalid"],
  );
  await owner.query('DELETE FROM "user" WHERE email LIKE $1', ["%@wa.invalid"]);
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
});

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await owner.end();
});

describe("WhatsApp login: confirm the masked number or Bukan saya", () => {
  it("AUTH-01 with requireConfirm shows the masked number and waits, issuing no session", async () => {
    const { browser, codeFormatted, path } = await newChallenge({
      requireConfirm: true,
    });

    // Before any message there is no number to show and nothing to confirm.
    const waiting = await browser.get(path);
    expect(waiting.status).toBe(200);
    expect(viewField(waiting.body.data, "awaitingConfirmation")).not.toBe(true);
    expect(JSON.stringify(waiting.body.data)).not.toContain(SENDER_LAST4);

    expect((await sendLoginMessage(codeFormatted)).body.data.completed).toBe(1);

    // Polling any number of times keeps waiting; none of them logs in.
    for (let i = 0; i < 2; i++) {
      const polled = await browser.get(path);
      expect(polled.status).toBe(200);
      expect(viewField(polled.body.data, "awaitingConfirmation")).toBe(true);
      expectMaskedNumberOnly(polled.body.data);
      expectNoSession(polled);
    }
    const me = await browser.get("/api/auth/get-session");
    expect(me.body?.user ?? null).toBeNull();
  });

  it("AUTH-01 confirm from the bound browser issues the session on the next poll", async () => {
    const { browser, path } = await awaitingChallenge();

    const confirmed = await browser
      .post(`${path}/confirm`)
      .set(originHeader)
      .send();
    expect(confirmed.status).toBeGreaterThanOrEqual(200);
    expect(confirmed.status).toBeLessThan(300);

    const polled = await browser.get(path);
    expect(polled.status).toBe(200);
    expect(polled.body.data.challenge.status).toBe("completed");
    expect(polled.body.data.session).toBeTruthy();
    expect(polled.body.data.session.kind).toBe("customer");
    expect(viewField(polled.body.data, "awaitingConfirmation")).not.toBe(true);

    const me = await browser.get("/api/auth/get-session");
    expect(me.body.user.id).toBe(polled.body.data.session.userId);
  });

  it("AUTH-01 another browser cannot confirm or peek at the masked number", async () => {
    const { browser, path } = await awaitingChallenge();
    const other = agent(app).host(host);

    const confirm = await other.post(`${path}/confirm`).set(originHeader).send();
    expect(confirm.status).toBe(403);
    expect(confirm.body.error.code).toBe("CHALLENGE_BROWSER_MISMATCH");
    const peek = await other.get(path);
    expect(peek.status).toBe(403);
    expect(JSON.stringify(peek.body)).not.toContain(SENDER_LAST4);

    // The bound browser is still waiting, not logged in.
    const polled = await browser.get(path);
    expect(viewField(polled.body.data, "awaitingConfirmation")).toBe(true);
    expectNoSession(polled);
  });

  it("AUTH-01 Bukan saya while awaiting cancels it and no session is ever issued", async () => {
    const { browser, path } = await awaitingChallenge();

    const cancelled = await browser
      .post(`${path}/cancel`)
      .set(originHeader)
      .send();
    expect(cancelled.status).toBe(204);

    const polled = await browser.get(path);
    expect(polled.body.data.challenge.status).toBe("cancelled");
    expect(viewField(polled.body.data, "awaitingConfirmation")).not.toBe(true);
    expectNoSession(polled);

    // Confirming afterwards is rejected and still yields no session.
    const late = await browser.post(`${path}/confirm`).set(originHeader).send();
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(late.status).toBeLessThan(500);
    const after = await browser.get(path);
    expect(after.body.data.challenge.status).toBe("cancelled");
    expectNoSession(after);
    const me = await browser.get("/api/auth/get-session");
    expect(me.body?.user ?? null).toBeNull();
  });

  it("AUTH-01 Bukan saya is idempotent", async () => {
    const { browser, path } = await awaitingChallenge();

    const first = await browser.post(`${path}/cancel`).set(originHeader).send();
    const second = await browser
      .post(`${path}/cancel`)
      .set(originHeader)
      .send();
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);

    const polled = await browser.get(path);
    expect(polled.body.data.challenge.status).toBe("cancelled");
    expectNoSession(polled);
  });

  it("AUTH-01 a browser cannot cancel another browser's awaiting challenge", async () => {
    const mine = await newChallenge({ requireConfirm: true });
    const theirs = await awaitingChallenge();

    const denied = await mine.browser
      .post(`${theirs.path}/cancel`)
      .set(originHeader)
      .send();
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("CHALLENGE_BROWSER_MISMATCH");

    // Theirs is untouched: still awaiting, and it can still be confirmed.
    const polled = await theirs.browser.get(theirs.path);
    expect(viewField(polled.body.data, "awaitingConfirmation")).toBe(true);
    expectNoSession(polled);
    const confirmed = await theirs.browser
      .post(`${theirs.path}/confirm`)
      .set(originHeader)
      .send();
    expect(confirmed.status).toBeLessThan(300);
    const done = await theirs.browser.get(theirs.path);
    expect(done.body.data.session).toBeTruthy();
  });

  it("AUTH-01 without requireConfirm the old flow still issues the session at the poll", async () => {
    const { browser, codeFormatted, path } = await newChallenge();
    await sendLoginMessage(codeFormatted);

    const polled = await browser.get(path);
    expect(polled.status).toBe(200);
    expect(polled.body.data.challenge.status).toBe("completed");
    expect(polled.body.data.session).toBeTruthy();
    expect(viewField(polled.body.data, "awaitingConfirmation")).not.toBe(true);
    const me = await browser.get("/api/auth/get-session");
    expect(me.body.user.id).toBe(polled.body.data.session.userId);
  });

  it("AUTH-01 requireConfirm: false behaves like the default", async () => {
    const { browser, codeFormatted, path } = await newChallenge({
      requireConfirm: false,
    });
    await sendLoginMessage(codeFormatted);
    const polled = await browser.get(path);
    expect(polled.body.data.session).toBeTruthy();
    expect(viewField(polled.body.data, "awaitingConfirmation")).not.toBe(true);
  });

  it("AUTH-01 rejects a non-boolean requireConfirm", async () => {
    const res = await agent(app)
      .host(host)
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({ requireConfirm: "yes" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
