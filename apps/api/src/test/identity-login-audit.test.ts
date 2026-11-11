// Audit trail of the WhatsApp login challenge (bead legend-wq3f; PRD v1.7 §3 F6,
// §6 B audit_logs; AUTH-01/02/04/06).
//
// Real Express app, Better Auth and PostgreSQL. Every milestone of a challenge
// must leave one `audit_logs` row (objectType `login_challenge`, objectId = the
// challenge id) in the right tenant, with no secret in it, and the row must
// commit or roll back together with the state change it describes.
//
// Setup (seeded tenants, integrations, owner pool, per-test cleanup) follows
// identity-login.test.ts. Tenant B is created fresh per run under its own id,
// because audit_logs is append-only: its rows cannot be cleaned up, so each
// test filters by challenge id (or by action on this run's private tenant).

// Must stay the first import: it sets TRUST_PROXY before ../app reads the env.
import {
  FILE_CLIENT_IP,
  releaseTrustedProxy,
} from "./helpers/identity-client-ip";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signKirimWebhook } from "@starter/shared/adapters";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { TenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  cancelWhatsAppChallenge,
  issueWhatsAppChallenge,
  pollWhatsAppChallenge,
} from "../services/identity-login.service";
import { processInboundWhatsApp } from "../services/identity-wa-inbound.service";
import { agent, originHeader, signUp } from "./helpers";
import {
  createIdentityScope,
  createIdentityTenant,
  setIntegrationNumber,
  uniqueDigits,
} from "./helpers/identity-isolation";

const SECRET = "test-kirim-webhook-secret";
// Own tenants, host, numbers and sender per run: this file never shares rows
// with the other identity files (legend-5opkl). Audit rows cannot be deleted
// afterwards, so the tenant ids are random.
const TENANT_A: string = randomUUID();
const TENANT_B: string = randomUUID();
const NUMBER_A = `62811${uniqueDigits(7)}`;
const NUMBER_B = `62811${uniqueDigits(7)}`;
const NUMBER_B_CHANGED = `62811${uniqueDigits(7)}`;
// Ends in 890: the masking test pins the three kept digits.
const SENDER = `62812${uniqueDigits(5)}890`;
let HOST = "";
// Data minimisation: only the last three digits of the sender are kept.
const SENDER_MASK = `•••${SENDER.slice(-3)}`;
// Distinct per file (a code is looked up across tenants, legend-5opkl).
const ISSUED_CODE = "R2S3T4V5";
const ISSUED_CODE_FORMATTED = "R2S3-T4V5";
const CLIENT_IP = "203.0.113.45";

const fileAgent = (target: Parameters<typeof agent>[0]) =>
  agent(target).set("X-Forwarded-For", FILE_CLIENT_IP);

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const app = createApp({ whatsappWebhookSecrets: [SECRET] });

type AuditEvent = {
  action: string;
  objectType: string;
  objectId: string | null;
  tenantId: string;
  actorType: string;
  actorId: string | null;
  ipHash: string | null;
  maskedChanges: { before: unknown; after: Record<string, unknown> | null };
};

function tenantContext(tenantId: string): TenantContext {
  return establishTenantContext({ tenantId, brandId: null, source: "session" });
}

function nonce(): string {
  return randomBytes(32).toString("base64url");
}

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

async function postWebhook(body: string) {
  const signature = await signKirimWebhook({ rawBody: body, secret: SECRET });
  return fileAgent(app)
    .host(HOST)
    .post("/api/webhooks/whatsapp")
    .set("Content-Type", "application/json")
    .set("X-Kirim-Signature", signature)
    .set("X-Kirim-Event-Id", "evt-" + randomUUID())
    .send(body);
}

/** Audit rows of one challenge, read through the owner pool, oldest first. */
async function auditOfChallenge(challengeId: string): Promise<AuditEvent[]> {
  const { rows } = await owner.query<{ event: AuditEvent }>(
    `SELECT event FROM audit_logs
      WHERE event->>'objectType' = 'login_challenge' AND event->>'objectId' = $1
      ORDER BY event->>'createdAt', id`,
    [challengeId],
  );
  return rows.map((row) => row.event);
}

async function auditActions(challengeId: string): Promise<string[]> {
  return (await auditOfChallenge(challengeId)).map((event) => event.action);
}

/** Rows that carry no challenge id (a rate-limited request created none). */
async function auditByAction(
  tenantId: string,
  action: string,
): Promise<AuditEvent[]> {
  const { rows } = await owner.query<{ event: AuditEvent }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2 ORDER BY id`,
    [tenantId, action],
  );
  return rows.map((row) => row.event);
}

/** No secret, whole or in part, may appear anywhere in the stored events. */
function expectNoSecrets(events: AuditEvent[], secrets: string[]) {
  const stored = JSON.stringify(events);
  for (const secret of secrets) {
    expect(secret.length).toBeGreaterThan(3);
    expect(stored).not.toContain(secret);
  }
  // The full sender is never stored; only the masked form may be.
  expect(stored).not.toContain(SENDER);
  expect(stored).not.toContain(SENDER.slice(4));
  for (const event of events) {
    expect(event.ipHash === null || /^[a-f0-9]{64}$/.test(event.ipHash)).toBe(
      true,
    );
  }
}

/**
 * Makes the audit insert itself fail for one tenant and action, the way a
 * broken audit store would. Returns the clean-up. The owner pool creates the
 * trigger; the append-only trigger on audit_logs is untouched.
 */
async function failAuditWhen(tenantId: string, action: string) {
  const name = `fail_audit_${randomBytes(6).toString("hex")}`;
  await owner.query(
    `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW.tenant_id = '${tenantId}' AND NEW.event->>'action' = '${action}' THEN
         RAISE EXCEPTION 'injected audit failure';
       END IF;
       RETURN NEW;
     END $$`,
  );
  await owner.query(
    `CREATE TRIGGER ${name} BEFORE INSERT ON public.audit_logs
     FOR EACH ROW EXECUTE FUNCTION public.${name}()`,
  );
  return async () => {
    await owner.query(`DROP TRIGGER IF EXISTS ${name} ON public.audit_logs`);
    await owner.query(`DROP FUNCTION IF EXISTS public.${name}()`);
  };
}

const isolation = createIdentityScope(owner);
isolation.scope.tenantIds.push(TENANT_A, TENANT_B);
isolation.scope.receivingNumbers.push(NUMBER_A, NUMBER_B, NUMBER_B_CHANGED);
isolation.scope.senders.push(SENDER);
const cleanLoginState = isolation.cleanup;

beforeAll(async () => {
  HOST = (
    await createIdentityTenant(owner, "audit-a", NUMBER_A, { id: TENANT_A })
  ).hostname;
  await createIdentityTenant(owner, "audit-b", NUMBER_B, {
    id: TENANT_B,
    withDomain: false,
  });
});

beforeEach(cleanLoginState);

afterAll(async () => {
  releaseTrustedProxy();
  await cleanLoginState();
  // Audit rows stay: audit_logs is append-only and has no tenant FK.
  await isolation.dropTenants([TENANT_A, TENANT_B]);
  await owner.end();
});

describe("WhatsApp login audit trail (legend-wq3f)", () => {
  it("AUTH-01 records created, completed and claimed for a full login, with no secret in any row", async () => {
    const browser = fileAgent(app).host(HOST);
    const issued = await browser
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({});
    expect(issued.status).toBe(201);
    const { challenge, code, codeFormatted } = issued.body.data;
    const bindingCookie = String(issued.headers["set-cookie"]).match(
      /login_binding=([^;]+)/,
    )?.[1];
    expect(bindingCookie).toBeTruthy();

    expect(await auditActions(challenge.id)).toEqual([
      "login_challenge.created",
    ]);

    const delivered = await postWebhook(
      kirimPayload({
        eventId: `wamid.${randomUUID()}`,
        from: SENDER,
        text: `MASUK LEGEND ${codeFormatted}`,
        phoneNumberId: NUMBER_A,
      }),
    );
    expect(delivered.body.data.completed).toBe(1);
    const confirmed = await browser
      .post(`/api/auth/login-challenges/${challenge.id}/confirm`)
      .set(originHeader)
      .send();
    expect(confirmed.status).toBeLessThan(300);
    const claimed = await browser.get(
      `/api/auth/login-challenges/${challenge.id}`,
    );
    expect(claimed.status).toBe(200);
    const session = claimed.body.data.session;
    expect(session).toBeTruthy();

    const events = await auditOfChallenge(challenge.id);
    expect(events.map((event) => event.action).sort()).toEqual([
      "login_challenge.claimed",
      "login_challenge.completed",
      "login_challenge.confirmed",
      "login_challenge.created",
    ]);
    for (const event of events) {
      expect(event.tenantId).toBe(TENANT_A);
      expect(event.objectType).toBe("login_challenge");
      expect(event.objectId).toBe(challenge.id);
    }
    const byAction = (action: string) =>
      events.find((event) => event.action === action)!;
    // The guest is anonymous until the webhook matches an account.
    expect(byAction("login_challenge.created").actorType).toBe("system");
    expect(byAction("login_challenge.created").actorId).toBeNull();
    expect(
      byAction("login_challenge.created").maskedChanges.after,
    ).toMatchObject({ channel: "whatsapp_inbound", status: "pending" });
    const completed = byAction("login_challenge.completed");
    expect(completed.actorType).toBe("user");
    expect(completed.actorId).toBe(session.userId);
    expect(completed.maskedChanges.after).toMatchObject({
      status: "completed",
      matchedUserId: session.userId,
      senderMasked: SENDER_MASK,
    });
    expect(SENDER_MASK).not.toBe(SENDER);
    expect(SENDER_MASK).toBe("•••890");
    // Not even the leading digits of the sender survive in any row.
    expect(JSON.stringify(events)).not.toContain("628123");
    expect(byAction("login_challenge.claimed").actorId).toBe(session.userId);
    // The claim row carries the claiming request's keyed IP digest.
    expect(byAction("login_challenge.claimed").ipHash).toMatch(
      /^[a-f0-9]{64}$/,
    );

    // The browser's cookie value, the session id and token never appear.
    const cookieParts = decodeURIComponent(bindingCookie!).split(".");
    expectNoSecrets(events, [
      code,
      codeFormatted,
      code.slice(0, 4),
      ...cookieParts.filter((part) => part.length > 8),
      ...(typeof session.id === "string" ? [session.id] : []),
    ]);
  });

  it("AUTH-01 hashes the client IP and never stores it", async () => {
    const withIp = await issueWhatsAppChallenge(
      tenantContext(TENANT_A),
      { bindingNonce: nonce(), ip: CLIENT_IP, userAgent: "uji" },
      { generateCode: () => ISSUED_CODE },
    );
    const withoutIp = await issueWhatsAppChallenge(
      tenantContext(TENANT_A),
      { bindingNonce: nonce(), ip: null, userAgent: "uji" },
      { generateCode: () => "M3N4P5Q6" },
    );
    const [hashed] = await auditOfChallenge(withIp.challenge.id);
    const [bare] = await auditOfChallenge(withoutIp.challenge.id);
    expect(hashed!.ipHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bare!.ipHash).toBeNull();
    expect(JSON.stringify([hashed, bare])).not.toContain(CLIENT_IP);
    expectNoSecrets(
      [hashed!, bare!],
      [ISSUED_CODE, ISSUED_CODE_FORMATTED, "M3N4P5Q6"],
    );
  });

  it("AUTH-01 records expired when the browser polls after the five-minute window", async () => {
    const binding = nonce();
    const issued = await issueWhatsAppChallenge(
      tenantContext(TENANT_A),
      { bindingNonce: binding, ip: CLIENT_IP, userAgent: "uji" },
      {
        now: new Date(Date.now() - 6 * 60_000),
        generateCode: () => ISSUED_CODE,
      },
    );
    const polled = await pollWhatsAppChallenge(issued.challenge.id, {
      bindingNonce: binding,
      ip: CLIENT_IP,
      userAgent: "uji",
    });
    expect(polled.view.challenge.status).toBe("expired");

    const events = await auditOfChallenge(issued.challenge.id);
    expect(events.map((event) => event.action)).toEqual([
      "login_challenge.created",
      "login_challenge.expired",
    ]);
    const expired = events[1]!;
    expect(expired.tenantId).toBe(TENANT_A);
    expect(expired.objectId).toBe(issued.challenge.id);
    expect(expired.maskedChanges.after).toMatchObject({ status: "expired" });
    expectNoSecrets(events, [
      ISSUED_CODE,
      issued.codeFormatted,
      binding,
      polled.session?.id ?? "no-session",
    ]);
  });

  it("AUTH-01 records expired when the WhatsApp message arrives after the window", async () => {
    const issued = await issueWhatsAppChallenge(
      tenantContext(TENANT_A),
      { bindingNonce: nonce(), ip: null, userAgent: null },
      {
        now: new Date(Date.now() - 6 * 60_000),
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

    const events = await auditOfChallenge(issued.challenge.id);
    expect(events.map((event) => event.action)).toEqual([
      "login_challenge.created",
      "login_challenge.expired",
    ]);
    expect(events[1]!.tenantId).toBe(TENANT_A);
    expectNoSecrets(events, [ISSUED_CODE, issued.codeFormatted]);
  });

  it("AUTH-01 records cancelled when the asking browser says it was not them", async () => {
    const binding = nonce();
    const issued = await issueWhatsAppChallenge(
      tenantContext(TENANT_A),
      { bindingNonce: binding, ip: CLIENT_IP, userAgent: "uji" },
      { generateCode: () => ISSUED_CODE },
    );
    await cancelWhatsAppChallenge(issued.challenge.id, binding);
    // A second cancel changes nothing, so it must not add a second row.
    await cancelWhatsAppChallenge(issued.challenge.id, binding);

    const events = await auditOfChallenge(issued.challenge.id);
    expect(events.map((event) => event.action)).toEqual([
      "login_challenge.created",
      "login_challenge.cancelled",
    ]);
    expect(events[1]!.tenantId).toBe(TENANT_A);
    expect(events[1]!.maskedChanges.after).toMatchObject({
      status: "cancelled",
    });
    expectNoSecrets(events, [ISSUED_CODE, issued.codeFormatted, binding]);
  });

  it("AUTH-04 records rate_limited for the sixth challenge in fifteen minutes", async () => {
    const binding = nonce();
    const ids: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const issued = await issueWhatsAppChallenge(tenantContext(TENANT_B), {
        bindingNonce: binding,
        ip: CLIENT_IP,
        userAgent: "uji",
      });
      ids.push(issued.challenge.id);
    }
    await expect(
      issueWhatsAppChallenge(tenantContext(TENANT_B), {
        bindingNonce: binding,
        ip: CLIENT_IP,
        userAgent: "uji",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    // A flood of refusals from the same device must not flood the append-only
    // audit log: still one row for the whole window.
    for (let flood = 0; flood < 3; flood += 1)
      await expect(
        issueWhatsAppChallenge(tenantContext(TENANT_B), {
          bindingNonce: binding,
          ip: CLIENT_IP,
          userAgent: "uji",
        }),
      ).rejects.toMatchObject({ code: "RATE_LIMITED" });

    // The refused request created no challenge, so its row has no object id.
    const limited = await auditByAction(
      TENANT_B,
      "login_challenge.rate_limited",
    );
    expect(limited).toHaveLength(1);
    expect(limited[0]!.tenantId).toBe(TENANT_B);
    expect(limited[0]!.objectType).toBe("login_challenge");
    expect(limited[0]!.objectId).toBeNull();
    expect(limited[0]!.ipHash).toMatch(/^[a-f0-9]{64}$/);
    expectNoSecrets(limited, [binding]);

    // Exactly the five accepted requests were recorded as created.
    for (const id of ids)
      expect(await auditActions(id)).toEqual(["login_challenge.created"]);
    expect(
      (
        await owner.query(
          "SELECT count(*)::int AS count FROM login_challenges WHERE tenant_id = $1",
          [TENANT_B],
        )
      ).rows[0].count,
    ).toBe(5);
  });

  it("AUTH-02 records rejected when a found challenge is refused because the tenant number changed", async () => {
    const issued = await issueWhatsAppChallenge(
      tenantContext(TENANT_B),
      { bindingNonce: nonce(), ip: null, userAgent: null },
      { generateCode: () => ISSUED_CODE },
    );
    // The tenant moved to another receiving number after the code was issued.
    await setIntegrationNumber(owner, TENANT_B, NUMBER_B_CHANGED);
    try {
      const outcome = await processInboundWhatsApp({
        eventId: `wamid.${randomUUID()}`,
        receivingNumber: NUMBER_B,
        sender: SENDER,
        text: `MASUK LEGEND ${issued.codeFormatted}`,
      });
      expect(outcome.kind).toBe("rejected");
    } finally {
      await setIntegrationNumber(owner, TENANT_B, NUMBER_B);
    }

    const events = await auditOfChallenge(issued.challenge.id);
    expect(events.map((event) => event.action)).toEqual([
      "login_challenge.created",
      "login_challenge.rejected",
    ]);
    const rejected = events[1]!;
    expect(rejected.tenantId).toBe(TENANT_B);
    expect(rejected.objectId).toBe(issued.challenge.id);
    expect(rejected.maskedChanges.after).toMatchObject({
      senderMasked: SENDER_MASK,
    });
    expectNoSecrets(events, [ISSUED_CODE, issued.codeFormatted]);
    // The challenge is untouched: still pending, nobody signed in.
    const row = await owner.query(
      "SELECT status FROM login_challenges WHERE id = $1",
      [issued.challenge.id],
    );
    expect(row.rows[0].status).toBe("pending");
  });

  it("AUTH-02 writes no tenant row for a code that matches no challenge", async () => {
    const before = await owner.query(
      "SELECT count(*)::int AS count FROM audit_logs WHERE event->>'objectType' = 'login_challenge' AND tenant_id = ANY($1)",
      [[TENANT_A, TENANT_B]],
    );
    const outcome = await processInboundWhatsApp({
      eventId: `wamid.${randomUUID()}`,
      receivingNumber: NUMBER_A,
      sender: SENDER,
      text: "MASUK LEGEND ZZZZ-ZZZZ",
    });
    expect(outcome.kind).toBe("rejected");
    const after = await owner.query(
      "SELECT count(*)::int AS count FROM audit_logs WHERE event->>'objectType' = 'login_challenge' AND tenant_id = ANY($1)",
      [[TENANT_A, TENANT_B]],
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it("AUTH-01 records claim_failed when the session cannot be created, and the browser can retry", async () => {
    const binding = nonce();
    const issued = await issueWhatsAppChallenge(
      tenantContext(TENANT_A),
      { bindingNonce: binding, ip: CLIENT_IP, userAgent: "uji" },
      { generateCode: () => ISSUED_CODE },
    );
    const outcome = await processInboundWhatsApp({
      eventId: `wamid.${randomUUID()}`,
      receivingNumber: NUMBER_A,
      sender: SENDER,
      text: `MASUK LEGEND ${issued.codeFormatted}`,
    });
    expect(outcome.kind).toBe("login");

    await expect(
      pollWhatsAppChallenge(
        issued.challenge.id,
        { bindingNonce: binding, ip: CLIENT_IP, userAgent: "uji" },
        {
          createSession: async () => {
            throw new Error("session store down");
          },
        },
      ),
    ).rejects.toThrow("session store down");

    const events = await auditOfChallenge(issued.challenge.id);
    const failed = events.find(
      (event) => event.action === "login_challenge.claim_failed",
    );
    expect(failed).toBeDefined();
    expect(failed!.tenantId).toBe(TENANT_A);
    expect(failed!.objectId).toBe(issued.challenge.id);
    expect(failed!.actorType).toBe("user");
    expect(failed!.actorId).toBeTruthy();
    expectNoSecrets(events, [ISSUED_CODE, issued.codeFormatted, binding]);

    // The failed claim was released, so the same browser can still collect.
    const retry = await pollWhatsAppChallenge(issued.challenge.id, {
      bindingNonce: binding,
      ip: CLIENT_IP,
      userAgent: "uji",
    });
    expect(retry.session).not.toBeNull();
  });

  it("AUTH-01 hides tenant A's login audit rows from tenant B's connection", async () => {
    const issued = await issueWhatsAppChallenge(
      tenantContext(TENANT_A),
      { bindingNonce: nonce(), ip: CLIENT_IP, userAgent: "uji" },
      { generateCode: () => ISSUED_CODE },
    );
    const read = (tenantId: string) =>
      withTenant(
        db,
        establishScopedTenantContext(tenantContext(tenantId), {
          kind: "tenant",
        }),
        async (tx) => {
          const result = await tx.execute(
            sql`SELECT event FROM audit_logs
                 WHERE event->>'objectType' = 'login_challenge'`,
          );
          return result.rows as { event: AuditEvent }[];
        },
      );

    // Control: tenant A's own connection sees its row (so the check is not vacuous).
    const own = await read(TENANT_A);
    expect(own.some((row) => row.event.objectId === issued.challenge.id)).toBe(
      true,
    );

    const foreign = await read(TENANT_B);
    expect(
      foreign.some((row) => row.event.objectId === issued.challenge.id),
    ).toBe(false);
    expect(foreign.every((row) => row.event.tenantId === TENANT_B)).toBe(true);
  });

  it("AUTH-01 rolls the challenge back when its created audit row cannot be written", async () => {
    // Earlier tests leave append-only rows on this tenant: compare counts.
    const createdBefore = (
      await auditByAction(TENANT_B, "login_challenge.created")
    ).length;
    const restore = await failAuditWhen(TENANT_B, "login_challenge.created");
    try {
      await expect(
        issueWhatsAppChallenge(tenantContext(TENANT_B), {
          bindingNonce: nonce(),
          ip: null,
          userAgent: null,
        }),
      ).rejects.toThrow();
    } finally {
      await restore();
    }
    const rows = await owner.query(
      "SELECT count(*)::int AS count FROM login_challenges WHERE tenant_id = $1",
      [TENANT_B],
    );
    expect(rows.rows[0].count).toBe(0);
    expect(
      (await auditByAction(TENANT_B, "login_challenge.created")).length,
    ).toBe(createdBefore);
  });

  it("AUTH-02 rolls the whole delivery back when the completed audit row cannot be written", async () => {
    const binding = nonce();
    const issued = await issueWhatsAppChallenge(
      tenantContext(TENANT_B),
      { bindingNonce: binding, ip: null, userAgent: null },
      { generateCode: () => ISSUED_CODE },
    );
    const message = {
      eventId: `wamid.${randomUUID()}`,
      receivingNumber: NUMBER_B,
      sender: SENDER,
      text: `MASUK LEGEND ${issued.codeFormatted}`,
    };
    const restore = await failAuditWhen(TENANT_B, "login_challenge.completed");
    try {
      await expect(processInboundWhatsApp(message)).rejects.toThrow();
    } finally {
      await restore();
    }
    // No half state: the challenge is still pending, no account, no claim row.
    const challenge = await owner.query(
      "SELECT status, matched_user_id FROM login_challenges WHERE id = $1",
      [issued.challenge.id],
    );
    expect(challenge.rows[0]).toEqual({
      status: "pending",
      matched_user_id: null,
    });
    // The claim row of the delivery rolled back with it (an account made by
    // resolveWhatsAppAccount lives on its own connection and is reused on retry).
    expect(await isolation.count("wa_inbound_messages")).toBe(0);
    expect(await auditActions(issued.challenge.id)).toEqual([
      "login_challenge.created",
    ]);

    // The provider redelivers the same message: now it completes, once.
    expect((await processInboundWhatsApp(message)).kind).toBe("login");
    expect(await auditActions(issued.challenge.id)).toEqual([
      "login_challenge.created",
      "login_challenge.completed",
    ]);
    expect(await isolation.count("user_identities")).toBe(1);
  });

  it("AUTH-07 rolls the linking audit row back with a failed link write", async () => {
    const browser = fileAgent(app).host(HOST);
    await signUp(browser);
    const issued = await browser
      .post("/api/auth/login-challenges/whatsapp")
      .set(originHeader)
      .send({});
    expect(issued.status).toBe(201);
    const { challenge, codeFormatted } = issued.body.data;
    const message = {
      eventId: `wamid.${randomUUID()}`,
      receivingNumber: NUMBER_A,
      sender: SENDER,
      text: `MASUK LEGEND ${codeFormatted}`,
    };
    await expect(
      processInboundWhatsApp(message, {
        afterLinkWrite: async () => {
          throw new Error("injected failure");
        },
      }),
    ).rejects.toThrow("injected failure");

    // The completion row was written inside the failed transaction: gone.
    expect(await auditActions(challenge.id)).toEqual([
      "login_challenge.created",
    ]);
    expect(
      (
        await owner.query("SELECT status FROM login_challenges WHERE id = $1", [
          challenge.id,
        ])
      ).rows[0].status,
    ).toBe("pending");

    expect((await processInboundWhatsApp(message)).kind).toBe("login");
    const events = await auditOfChallenge(challenge.id);
    expect(events.map((event) => event.action)).toEqual([
      "login_challenge.created",
      "login_challenge.completed",
    ]);
    expect(events[1]!.maskedChanges.after).toMatchObject({
      linking: true,
      senderMasked: SENDER_MASK,
    });
    expectNoSecrets(events, [codeFormatted, codeFormatted.replace("-", "")]);
  });
});
