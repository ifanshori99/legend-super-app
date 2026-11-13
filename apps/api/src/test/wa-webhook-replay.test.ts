// Kirimdev inbound webhook hardening at the route (legend-6qyk): replay,
// signature window, secret rotation, unknown number, tenant routing and log
// hygiene. Written from docs/briefs/sub-kirim-whatsapp.md.
//
// Already covered elsewhere and NOT repeated (identity-login.test.ts):
// repeated wamid processed once, same wamid with different body counted as a
// conflict, forged/missing/stale(1 h) signature refused, a code on another
// tenant's number rejected. This file adds only what those do not pin down.
//
// Assumptions: the route keys dedupe on the message id inside the payload
// (`messages[0].id`); a delivery for an unregistered phone_number_id answers
// 200 (so Kirimdev does not retry and auto-disable the subscription) and writes
// nothing; a stale signature uses the 300 s window (tests use 301 s and 290 s
// so the wall clock moving a few ms cannot flip the outcome).

// Must stay the first import: it sets TRUST_PROXY before ../app reads the env.
import {
  FILE_CLIENT_IP,
  releaseTrustedProxy,
} from "./helpers/identity-client-ip";
import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { signKirimWebhook } from "@starter/shared/adapters";
import { establishTenantContext } from "@starter/shared/core/server";
import { createApp } from "../app";
import { issueWhatsAppChallenge } from "../services/identity-login.service";
import { createLogger } from "../lib/logger";
import { agent } from "./helpers";
import {
  createIdentityScope,
  createIdentityTenant,
  uniqueDigits,
} from "./helpers/identity-isolation";

const SECRET = "replay-secret-current";
const OLD_SECRET = "replay-secret-previous";
const TENANT_A: string = randomUUID();
const TENANT_B: string = randomUUID();
const NUMBER_A = `62811${uniqueDigits(7)}`;
const NUMBER_B = `62811${uniqueDigits(7)}`;
const UNREGISTERED = `62811${uniqueDigits(7)}`;
const SENDER = `62813${uniqueDigits(8)}`;
let HOST = "";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const app = createApp({ whatsappWebhookSecrets: [SECRET] });
const rotatingApp = createApp({ whatsappWebhookSecrets: [SECRET, OLD_SECRET] });
const fileAgent = (target: Parameters<typeof agent>[0]) =>
  agent(target).set("X-Forwarded-For", FILE_CLIENT_IP);

const isolation = createIdentityScope(owner);
isolation.scope.tenantIds.push(TENANT_A, TENANT_B);
isolation.scope.receivingNumbers.push(NUMBER_A, NUMBER_B, UNREGISTERED);
isolation.scope.senders.push(SENDER);

function payload(input: {
  wamid: string;
  phoneNumberId: string;
  text?: string;
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
                  id: input.wamid,
                  from: SENDER,
                  type: "text",
                  text: { body: input.text ?? "MASUK LEGEND AAAAAA00" },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

type Target = Parameters<typeof agent>[0];
function post(
  body: string,
  headers: { signature: string; eventId?: string },
  target: Target = app,
) {
  return fileAgent(target)
    .host(HOST)
    .post("/api/webhooks/whatsapp")
    .set("Content-Type", "application/json")
    .set("X-Kirim-Signature", headers.signature)
    .set("X-Kirim-Event-Id", headers.eventId ?? "evt-" + randomUUID())
    .send(body);
}

async function signedPost(
  body: string,
  options: { secret?: string; ageSeconds?: number; target?: Target } = {},
) {
  const signature = await signKirimWebhook({
    rawBody: body,
    secret: options.secret ?? SECRET,
    timestamp: Math.floor(Date.now() / 1000) - (options.ageSeconds ?? 0),
  });
  return post(body, { signature }, options.target);
}

const tenantContext = (tenantId: string) =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });

async function rowsFor(wamid: string) {
  const { rows } = await owner.query<{
    tenant_id: string;
    receiving_number: string;
  }>(
    "SELECT tenant_id::text, receiving_number FROM wa_inbound_messages WHERE provider_message_id = $1",
    [wamid],
  );
  return rows;
}

beforeAll(async () => {
  HOST = (
    await createIdentityTenant(owner, "replay-a", NUMBER_A, { id: TENANT_A })
  ).hostname;
  await createIdentityTenant(owner, "replay-b", NUMBER_B, {
    id: TENANT_B,
    withDomain: false,
  });
});

beforeEach(isolation.cleanup);

afterAll(async () => {
  releaseTrustedProxy();
  await isolation.cleanup();
  await isolation.dropTenants([TENANT_A, TENANT_B]);
  await owner.end();
});

describe("Kirimdev webhook: replay and signature window", () => {
  it("AUTH-02 a byte-identical replay (same signature, same event id) is a duplicate with no second row", async () => {
    const wamid = `wamid.${randomUUID()}`;
    const body = payload({ wamid, phoneNumberId: NUMBER_A });
    const signature = await signKirimWebhook({ rawBody: body, secret: SECRET });
    const headers = { signature, eventId: wamid };

    const first = await post(body, headers);
    expect(first.status).toBe(200);
    expect(first.body.data.received).toBe(1);
    expect(first.body.data.duplicates).toBe(0);
    expect(await rowsFor(wamid)).toHaveLength(1);

    for (let replay = 0; replay < 2; replay += 1) {
      const again = await post(body, headers);
      expect(again.status).toBe(200);
      expect(again.body.data.duplicates).toBe(1);
      expect(again.body.data.conflicts).toBe(0);
    }
    expect(await rowsFor(wamid)).toHaveLength(1);
    expect(await isolation.count("user_identities")).toBe(0);
    expect(await isolation.count("session")).toBe(0);
  });

  it("AUTH-02 refuses a signature just outside the 300 s window and writes nothing", async () => {
    const wamid = `wamid.${randomUUID()}`;
    const body = payload({ wamid, phoneNumberId: NUMBER_A });
    const old = await signedPost(body, { ageSeconds: 301 });
    expect(old.status).toBe(401);
    expect(old.body.error.code).toBe("UNAUTHORIZED");

    // A timestamp from the future is refused the same way.
    const future = await signedPost(body, { ageSeconds: -301 });
    expect(future.status).toBe(401);
    expect(await rowsFor(wamid)).toHaveLength(0);
  });

  it("AUTH-02 accepts a signature still inside the window", async () => {
    const wamid = `wamid.${randomUUID()}`;
    const body = payload({ wamid, phoneNumberId: NUMBER_A });
    const late = await signedPost(body, { ageSeconds: 290 });
    expect(late.status).toBe(200);
    expect(await rowsFor(wamid)).toHaveLength(1);
  });

  it("AUTH-02 a valid signature over other bytes does not process the delivered body", async () => {
    const wamid = `wamid.${randomUUID()}`;
    const signedBody = payload({ wamid, phoneNumberId: NUMBER_A });
    const signature = await signKirimWebhook({
      rawBody: signedBody,
      secret: SECRET,
    });
    // Same JSON, different bytes (extra whitespace): re-serializing would pass.
    const delivered = JSON.stringify(JSON.parse(signedBody), null, 2);
    const refused = await post(delivered, { signature });
    expect(refused.status).toBe(401);
    expect(await rowsFor(wamid)).toHaveLength(0);
  });
});

describe("Kirimdev webhook: secret rotation", () => {
  it("AUTH-02 while rotating, both the new and the old secret are accepted", async () => {
    const wamids = [`wamid.${randomUUID()}`, `wamid.${randomUUID()}`];
    const current = await signedPost(
      payload({ wamid: wamids[0]!, phoneNumberId: NUMBER_A }),
      { secret: SECRET, target: rotatingApp },
    );
    const previous = await signedPost(
      payload({ wamid: wamids[1]!, phoneNumberId: NUMBER_A }),
      { secret: OLD_SECRET, target: rotatingApp },
    );
    expect(current.status).toBe(200);
    expect(previous.status).toBe(200);
    expect(await rowsFor(wamids[0]!)).toHaveLength(1);
    expect(await rowsFor(wamids[1]!)).toHaveLength(1);
  });

  it("AUTH-02 once the old secret is dropped, its signatures get 401 and leave no row", async () => {
    const wamid = `wamid.${randomUUID()}`;
    const refused = await signedPost(
      payload({ wamid, phoneNumberId: NUMBER_A }),
      { secret: OLD_SECRET, target: app },
    );
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe("UNAUTHORIZED");
    expect(await rowsFor(wamid)).toHaveLength(0);
  });
});

describe("Kirimdev webhook: routing by phone_number_id", () => {
  it("AUTH-02 an unregistered phone_number_id answers 200 and attaches to no tenant", async () => {
    const wamid = `wamid.${randomUUID()}`;
    const response = await signedPost(
      payload({ wamid, phoneNumberId: UNREGISTERED }),
    );
    // 200, not 4xx: Kirimdev disables a subscription after 20 failures in a row.
    expect(response.status).toBe(200);
    // Observed: a dedupe row may exist, but it belongs to no tenant.
    for (const row of await rowsFor(wamid)) expect(row.tenant_id).toBeNull();
    expect(await isolation.count("login_challenges")).toBe(0);
    expect(await isolation.count("user_identities")).toBe(0);
    expect(await isolation.count("session")).toBe(0);
  });

  it("AUTH-02 each phone_number_id completes only its own tenant's challenge", async () => {
    const bindingA = randomBytes(32).toString("base64url");
    const bindingB = randomBytes(32).toString("base64url");
    const challengeA = await issueWhatsAppChallenge(
      tenantContext(TENANT_A),
      { bindingNonce: bindingA, ip: null, userAgent: null },
      { generateCode: () => "R7T2VWXY" },
    );
    const challengeB = await issueWhatsAppChallenge(
      tenantContext(TENANT_B),
      { bindingNonce: bindingB, ip: null, userAgent: null },
      { generateCode: () => "K4M5NPQR" },
    );
    const statusOf = async (id: string) =>
      (
        await owner.query<{ status: string }>(
          "SELECT status FROM login_challenges WHERE id = $1",
          [id],
        )
      ).rows[0]?.status;

    // A's code arrives on A's number: only A completes.
    const first = await signedPost(
      payload({
        wamid: `wamid.${randomUUID()}`,
        phoneNumberId: NUMBER_A,
        text: `MASUK LEGEND ${challengeA.codeFormatted}`,
      }),
    );
    expect(first.status).toBe(200);
    expect(first.body.data.completed).toBe(1);
    expect(await statusOf(challengeA.challenge.id)).toBe("completed");
    expect(await statusOf(challengeB.challenge.id)).toBe("pending");

    // B's code arrives on B's number (even through A's host): only B completes.
    const second = await signedPost(
      payload({
        wamid: `wamid.${randomUUID()}`,
        phoneNumberId: NUMBER_B,
        text: `MASUK LEGEND ${challengeB.codeFormatted}`,
      }),
    );
    expect(second.status).toBe(200);
    expect(second.body.data.completed).toBe(1);
    expect(await statusOf(challengeB.challenge.id)).toBe("completed");
  });
});

describe("Kirimdev webhook: log hygiene", () => {
  it("AUTH-02 never writes the sender number, message text or secret to the logs", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const loggedApp = createApp({
      whatsappWebhookSecrets: [SECRET],
      logger: createLogger({ level: "debug", destination: stream }),
    });
    const text = "MASUK LEGEND KODERAHASIA99";
    const wamid = `wamid.${randomUUID()}`;
    const body = payload({ wamid, phoneNumberId: NUMBER_A, text });

    const accepted = await signedPost(body, { target: loggedApp });
    expect(accepted.status).toBe(200);
    const replay = await signedPost(body, { target: loggedApp });
    expect(replay.status).toBe(200);
    // Failed deliveries are logged too: forged signature and stale timestamp.
    const forged = await post(
      body,
      { signature: `t=${Math.floor(Date.now() / 1000)},v1=${"b".repeat(64)}` },
      loggedApp,
    );
    expect(forged.status).toBe(401);
    const stale = await signedPost(body, {
      target: loggedApp,
      ageSeconds: 3600,
    });
    expect(stale.status).toBe(401);

    // pino-http writes when the response finishes: wait for the access lines.
    await vi.waitFor(() => {
      expect(lines.join("").length).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const output = lines.join("");
    expect(output).not.toContain(SENDER);
    expect(output).not.toContain(SENDER.slice(2));
    expect(output).not.toContain("KODERAHASIA99");
    expect(output).not.toContain("MASUK LEGEND");
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(OLD_SECRET);
  });
});
