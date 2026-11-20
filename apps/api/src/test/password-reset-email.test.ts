// Customer password reset by email (legend-1255, founder decision 21 Nov:
// email first, WhatsApp later). Better Auth owns the token (single use, one
// hour); this suite pins what Legend adds on top:
//   - POST /api/auth/request-password-reset answers the same for a known and
//     an unknown address, and sends mail only for a real account;
//   - the emailed link points at the web page (/reset-password?token=...);
//   - a token works once and not after it expired;
//   - without a mail sender the request answers 503 EMAIL_NOT_CONFIGURED and
//     GET /api/auth/password-reset/status says the feature is off, so the web
//     hides the "Lupa kata sandi" link.

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { setEmailSenderForTests, type EmailMessage } from "../lib/email-sender";
import { agent, originHeader, signUp } from "./helpers";

const PASSWORD = "Test-password-123!";
const NEW_PASSWORD = "Another-password-456!";

let sent: EmailMessage[] = [];
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

beforeEach(() => {
  sent = [];
  setEmailSenderForTests({
    async send(message) {
      sent.push(message);
    },
  });
});

afterEach(() => {
  setEmailSenderForTests(undefined);
});

afterAll(async () => {
  await pool.end();
});

function requestReset(client: ReturnType<typeof agent>, email: string) {
  return client
    .post("/api/auth/request-password-reset")
    .set(originHeader)
    .send({ email });
}

function tokenOf(message: EmailMessage): string {
  const match = /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(message.text);
  if (!match) throw new Error("no reset link in the mail");
  return match[1]!;
}

function signIn(
  client: ReturnType<typeof agent>,
  email: string,
  password: string,
) {
  return client
    .post("/api/auth/sign-in/email")
    .set(originHeader)
    .send({ email, password });
}

describe("password reset by email", () => {
  it("sends a one-hour link, sets the new password, and the token works once", async () => {
    const client = agent();
    const email = await signUp(client);

    const asked = await requestReset(client, email);
    expect(asked.status).toBe(200);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.to).toBe(email);
    expect(sent[0]!.text).toMatch(/\/reset-password\?token=/);
    expect(sent[0]!.html).toContain("/reset-password?token=");
    const token = tokenOf(sent[0]!);

    const reset = await agent()
      .post("/api/auth/reset-password")
      .set(originHeader)
      .send({ token, newPassword: NEW_PASSWORD });
    expect(reset.status).toBe(200);

    expect((await signIn(agent(), email, NEW_PASSWORD)).status).toBe(200);
    expect((await signIn(agent(), email, PASSWORD)).status).toBe(401);

    const again = await agent()
      .post("/api/auth/reset-password")
      .set(originHeader)
      .send({ token, newPassword: "Third-password-789!" });
    expect(again.status).toBe(400);
    expect((await signIn(agent(), email, NEW_PASSWORD)).status).toBe(200);
  });

  it("refuses an expired token", async () => {
    const client = agent();
    const email = await signUp(client);
    await requestReset(client, email);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const token = tokenOf(sent[0]!);

    await pool.query(
      "UPDATE verification SET expires_at = now() - interval '1 minute' WHERE identifier = $1",
      [`reset-password:${token}`],
    );
    const reset = await agent()
      .post("/api/auth/reset-password")
      .set(originHeader)
      .send({ token, newPassword: NEW_PASSWORD });
    expect(reset.status).toBe(400);
    expect((await signIn(agent(), email, PASSWORD)).status).toBe(200);
  });

  it("answers an unknown address exactly like a known one and sends nothing", async () => {
    const client = agent();
    const known = await signUp(client);
    const knownAnswer = await requestReset(client, known);
    const unknownAnswer = await requestReset(
      client,
      `nobody-${randomUUID()}@example.com`,
    );
    expect(unknownAnswer.status).toBe(knownAnswer.status);
    expect(unknownAnswer.body).toEqual(knownAnswer.body);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.to).toBe(known);
  });

  it("does not mail a WhatsApp-only placeholder address", async () => {
    const answer = await requestReset(
      agent(),
      `628123456789-${randomUUID()}@wa.invalid`,
    );
    expect(answer.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it("reports the feature as on when a sender exists", async () => {
    const status = await agent().get("/api/auth/password-reset/status");
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ data: { enabled: true } });
  });

  describe("without a mail sender (SMTP not configured)", () => {
    beforeEach(() => setEmailSenderForTests(null));

    it("answers 503 and the status says the feature is off", async () => {
      const client = agent();
      const email = await signUp(client);
      const asked = await requestReset(client, email);
      expect(asked.status).toBe(503);
      expect(asked.body.code).toBe("EMAIL_NOT_CONFIGURED");
      expect(sent).toHaveLength(0);

      const status = await agent().get("/api/auth/password-reset/status");
      expect(status.status).toBe(200);
      expect(status.body).toEqual({ data: { enabled: false } });
    });
  });
});
