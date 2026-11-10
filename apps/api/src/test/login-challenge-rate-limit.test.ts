// HTTP rate limit of the public WhatsApp login-challenge endpoints (bead
// legend-fc0f2; AUTH-01/04).
//
// The limiter sits in front of the tenant resolver and the router, so a flood
// is answered 429 without a database transaction, a challenge row or an audit
// row. Two classes: issuing (POST /whatsapp) and polling/cancelling
// (GET /:id, POST /:id/cancel). Buckets: client IP, and the signed
// `login_binding` cookie.
//
// Whole-app cases run the real Express app with small limits and an injected
// clock (`createApp({ loginChallengeRateLimit })`). The test client reaches the
// API over loopback; no address is internal by default, so loopback is limited
// like any other client (one case proves it). The test app does not trust
// X-Forwarded-For, so IP isolation (two clients, one blocked, one served) runs on
// a probe app that mounts the real middleware with `trust proxy` set, as
// public-rate-limit.test.ts does.
//
// Assumptions (spec is silent):
// - A request without a valid binding cookie (a first visit, or a forged
//   cookie) is charged to its IP only, so the first issue of a browser does not
//   spend its binding budget.
// - Polling and cancelling share one class and one budget.
// - Retry-After is in seconds and never exceeds the window.
// - Express routes paths case-insensitively and ignores a trailing slash, so
//   those spellings reach the issue handler and must share the issue budget.

import { randomUUID } from "node:crypto";
import express from "express";
import { Pool } from "pg";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { db, pool } from "../db";
import { errorHandler, notFound } from "../middleware/error-handler";
import { loginChallengeRateLimit } from "../middleware/login-challenge-rate-limit";
import { agent, originHeader } from "./helpers";

const SECRET = "test-kirim-webhook-secret";
const fixtures = cafeLegendPlatformFixtures;
const TENANT_A = fixtures.tenant.id;
const HOST = fixtures.domains[0]!.hostname;
const UNKNOWN_HOST = "no-such-tenant.example.test";
const NUMBER_A = "628111000001";
const ISSUE = "/api/auth/login-challenges/whatsapp";
const CHALLENGES = "/api/auth/login-challenges";
const WINDOW_MS = 60_000;
const LIMITER_MESSAGE = "Terlalu banyak permintaan. Coba lagi sebentar.";

type Overrides = NonNullable<
  NonNullable<Parameters<typeof createApp>[0]>["loginChallengeRateLimit"]
>;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

let clock = 1_000_000;

function limitedApp(overrides: Overrides) {
  return createApp({
    whatsappWebhookSecrets: [SECRET],
    loginChallengeRateLimit: {
      issuePerIp: 1000,
      issuePerBinding: 1000,
      pollPerIp: 1000,
      pollPerBinding: 1000,
      windowMs: WINDOW_MS,
      now: () => clock,
      ...overrides,
    },
  });
}

type App = ReturnType<typeof createApp>;

/** A browser that has no cookie yet. */
function freshBrowser(app: App, host = HOST) {
  return agent(app).host(host);
}

function issue(browser: ReturnType<typeof freshBrowser>) {
  return browser.post(ISSUE).set(originHeader).send({});
}

function expectLimited(res: request.Response) {
  expect(res.status).toBe(429);
  expect(res.body.error.code).toBe("RATE_LIMITED");
  expect(res.body.error.message).toBe(LIMITER_MESSAGE);
  expect(res.headers["cache-control"]).toContain("no-store");
  const retryAfter = Number(res.headers["retry-after"]);
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThanOrEqual(1);
  expect(retryAfter).toBeLessThanOrEqual(WINDOW_MS / 1000);
}

/** The browser's binding cookie as the server set it: `name=value`. */
function bindingCookieOf(res: request.Response) {
  const match = String(res.headers["set-cookie"]).match(
    /([^=;,\s]*login_binding)=([^;]+)/,
  );
  if (!match) throw new Error("No login_binding cookie in the issue response");
  return { name: match[1]!, value: match[2]! };
}

async function countAuditRows(action = "login_challenge.%"): Promise<number> {
  const { rows } = await owner.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' LIKE $2`,
    [TENANT_A, action],
  );
  return rows[0]!.count;
}

async function countChallenges(): Promise<number> {
  const { rows } = await owner.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM login_challenges",
  );
  return rows[0]!.count;
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

beforeEach(async () => {
  clock = 1_000_000;
  // AUTH-04 windows are time based: each test owns the whole login state.
  await owner.query("DELETE FROM wa_inbound_messages");
  await owner.query("DELETE FROM login_challenges");
  await owner.query("DELETE FROM user_identities");
  // Dropping the identities alone orphans the invited-admin accounts that
  // earlier files created through POST /api/platform/tenants (email
  // <digest>@wa.invalid). A later file that provisions the same WhatsApp number
  // would then claim a fresh identity, hit the taken email and get 409 "first
  // admin's contact is already used" (legend-5tmye). Remove those accounts too,
  // as identity-login.test.ts does.
  await owner.query(
    `DELETE FROM role_assignments
      WHERE user_id IN (SELECT id FROM "user" WHERE email LIKE $1)
         OR assigned_by IN (SELECT id FROM "user" WHERE email LIKE $1)`,
    ["%@wa.invalid"],
  );
  await owner.query('DELETE FROM "user" WHERE email LIKE $1', ["%@wa.invalid"]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await owner.query("DELETE FROM login_challenges");
  await owner.end();
});

describe("login challenge HTTP rate limit (legend-fc0f2)", () => {
  it("AUTH-04 answers a flood with 429 and touches no database state", async () => {
    const app = limitedApp({ issuePerIp: 3 });
    for (let attempt = 0; attempt < 3; attempt += 1)
      expect((await issue(freshBrowser(app))).status).toBe(201);

    const auditBefore = await countAuditRows();
    const challengesBefore = await countChallenges();
    const transaction = vi.spyOn(db, "transaction");
    const query = vi.spyOn(pool, "query");
    const connect = vi.spyOn(pool, "connect");

    for (let attempt = 0; attempt < 5; attempt += 1)
      expectLimited(await issue(freshBrowser(app)));
    // The limiter runs before tenant resolution: a host that resolves to no
    // tenant is refused with 429 as well, not with a tenant-not-found error.
    expectLimited(await issue(freshBrowser(app, UNKNOWN_HOST)));

    expect(transaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(await countAuditRows()).toBe(auditBefore);
    expect(await countChallenges()).toBe(challengesBefore);
    expect(challengesBefore).toBe(3);
  });

  it("AUTH-04 answers blocked requests carrying a junk session cookie without touching the database", async () => {
    // A blocked request must be refused before any session lookup: Better Auth
    // session cookie (junk) and a valid binding cookie, on both classes.
    const app = limitedApp({ issuePerIp: 2, pollPerIp: 2 });
    const browser = freshBrowser(app);
    const first = await issue(browser);
    expect(first.status).toBe(201);
    expect((await issue(browser)).status).toBe(201);
    const { name, value } = bindingCookieOf(first);
    // Same cookie prefix (the app id) as the binding cookie, as Better Auth sets it.
    const sessionName = name.replace(/login_binding$/, "session_token");
    const junk = `${sessionName}=junk`;
    const withBinding = `${junk}; ${name}=${value}`;
    const path = `${CHALLENGES}/${first.body.data.challenge.id}`;
    expect((await browser.get(path)).status).toBe(200);
    expect((await browser.get(path)).status).toBe(200);

    const transaction = vi.spyOn(db, "transaction");
    const query = vi.spyOn(pool, "query");
    const connect = vi.spyOn(pool, "connect");
    const auditBefore = await countAuditRows();
    const challengesBefore = await countChallenges();

    const fresh = () => freshBrowser(app);
    expectLimited(
      await fresh().post(ISSUE).set(originHeader).set("Cookie", junk).send({}),
    );
    expectLimited(
      await fresh()
        .post(ISSUE)
        .set(originHeader)
        .set("Cookie", withBinding)
        .send({}),
    );
    expectLimited(await fresh().get(path).set("Cookie", junk));
    expectLimited(await fresh().get(path).set("Cookie", withBinding));
    expectLimited(
      await fresh()
        .post(`${path}/cancel`)
        .set(originHeader)
        .set("Cookie", withBinding)
        .send(),
    );
    expectLimited(
      await freshBrowser(app, UNKNOWN_HOST)
        .post(ISSUE)
        .set(originHeader)
        .set("Cookie", junk)
        .send({}),
    );

    expect(transaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(await countAuditRows()).toBe(auditBefore);
    expect(await countChallenges()).toBe(challengesBefore);
  });

  it("AUTH-04 counts every spelling of the issue path against one issue budget", async () => {
    const app = limitedApp({ issuePerIp: 4 });
    const paths = [
      "/api/auth/login-challenges/whatsapp",
      "/api/auth/login-challenges/WhatsApp",
      "/api/auth/login-challenges/WHATSAPP/",
      "/API/Auth/Login-Challenges/whatsapp",
    ];
    for (const path of paths) {
      const res = await freshBrowser(app).post(path).set(originHeader).send({});
      expect(res.status, path).toBe(201);
    }
    // Same IP, any spelling: the fifth issue is refused.
    for (const path of [paths[0]!, paths[1]!, paths[2]!, paths[3]!]) {
      const res = await freshBrowser(app).post(path).set(originHeader).send({});
      expectLimited(res);
    }
    expect(await countChallenges()).toBe(4);
  });

  it("AUTH-04 limits a loopback client by IP when no internal IP is configured", async () => {
    // No `internalIps` override: the default skips nobody, not even loopback.
    const app = createApp({
      whatsappWebhookSecrets: [SECRET],
      loginChallengeRateLimit: {
        issuePerIp: 2,
        windowMs: WINDOW_MS,
        now: () => clock,
      },
    });
    expect((await issue(freshBrowser(app))).status).toBe(201);
    expect((await issue(freshBrowser(app))).status).toBe(201);
    expectLimited(await issue(freshBrowser(app)));
  });

  it("AUTH-04 refuses one client IP but still serves another", async () => {
    // Probe app with one trusted proxy hop: the client address comes from
    // X-Forwarded-For, which the whole-app test setup does not trust.
    const probe = express();
    probe.set("trust proxy", 1);
    probe.use(
      CHALLENGES,
      loginChallengeRateLimit({
        issuePerIp: 2,
        issuePerBinding: 1000,
        pollPerIp: 1000,
        pollPerBinding: 1000,
        internalIps: ["198.51.100.9"],
        windowMs: WINDOW_MS,
        now: () => clock,
      }),
      (_req, res) => {
        res.status(201).json({ data: { ok: true } });
      },
    );
    probe.use(notFound);
    probe.use(errorHandler);
    const post = (ip: string) =>
      request(probe)
        .post("/api/auth/login-challenges/whatsapp")
        .set("X-Forwarded-For", ip);

    expect((await post("198.51.100.1")).status).toBe(201);
    expect((await post("198.51.100.1")).status).toBe(201);
    expectLimited(await post("198.51.100.1"));
    // A second client is untouched while the first is blocked.
    expect((await post("198.51.100.2")).status).toBe(201);
    expectLimited(await post("198.51.100.1"));
    // The web server's own address (internal IP) skips the IP bucket.
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect((await post("198.51.100.9")).status).toBe(201);
  });

  it("AUTH-04 limits a browser by its signed binding cookie, not by a forged one", async () => {
    const app = limitedApp({ issuePerBinding: 2 });
    const browser = freshBrowser(app);
    const statuses: number[] = [];
    let blocked: request.Response | null = null;
    for (let attempt = 0; attempt < 4 && blocked === null; attempt += 1) {
      const res = await issue(browser);
      statuses.push(res.status);
      if (res.status === 429) blocked = res;
    }
    // The first issue carries no cookie yet, so only later ones spend the
    // binding budget; the limit of two is reached within four issues.
    expect(statuses.slice(0, 2)).toEqual([201, 201]);
    expect(blocked).not.toBeNull();
    expectLimited(blocked!);
    const created = statuses.filter((status) => status === 201).length;
    expect(await countChallenges()).toBe(created);

    // Another browser (no cookie) from the same IP is still served.
    expect((await issue(freshBrowser(app))).status).toBe(201);
  });

  it("AUTH-04 charges a forged binding cookie to its IP only", async () => {
    const app = limitedApp({ pollPerBinding: 1, pollPerIp: 4 });
    const issued = await issue(freshBrowser(app));
    const { name } = bindingCookieOf(issued);
    const poll = (cookieValue: string) =>
      freshBrowser(app)
        .get(`${CHALLENGES}/${randomUUID()}`)
        .set("Cookie", `${name}=${cookieValue}`);
    const forged = (index: number) =>
      `${String(index).repeat(43)}.${"B".repeat(43)}`;

    // A binding limit of one would stop a cookie-keyed client at its second
    // poll; a forged cookie is never a key, so the IP budget (four) decides.
    for (let attempt = 0; attempt < 4; attempt += 1)
      expect((await poll(forged(attempt))).status).not.toBe(429);
    expectLimited(await poll(forged(9)));
  });

  it("AUTH-04 keeps poll and cancel apart from the issue budget", async () => {
    const app = limitedApp({ issuePerIp: 1 });
    const browser = freshBrowser(app);
    const issued = await issue(browser);
    expect(issued.status).toBe(201);
    expectLimited(await issue(browser));

    const path = `${CHALLENGES}/${issued.body.data.challenge.id}`;
    const polled = await browser.get(path);
    expect(polled.status).toBe(200);
    expect(polled.body.data.challenge.status).toBe("pending");
    const cancelled = await browser
      .post(`${path}/cancel`)
      .set(originHeader)
      .send();
    expect(cancelled.status).toBe(204);
  });

  it("AUTH-04 has its own poll budget per IP and per binding, shared with cancel", async () => {
    // Per IP.
    const ipApp = limitedApp({ pollPerIp: 2 });
    const browser = freshBrowser(ipApp);
    const issued = await issue(browser);
    expect(issued.status).toBe(201);
    const path = `${CHALLENGES}/${issued.body.data.challenge.id}`;
    expect((await browser.get(path)).status).toBe(200);
    expect((await browser.get(path)).status).toBe(200);
    expectLimited(await browser.get(path));
    expectLimited(
      await browser.post(`${path}/cancel`).set(originHeader).send(),
    );
    // Issuing is a different class and stays open.
    expect((await issue(freshBrowser(ipApp))).status).toBe(201);

    // Per binding: another browser keeps polling when this one is spent.
    const bindingApp = limitedApp({ pollPerBinding: 2 });
    const first = freshBrowser(bindingApp);
    const firstIssued = await issue(first);
    const firstPath = `${CHALLENGES}/${firstIssued.body.data.challenge.id}`;
    expect((await first.get(firstPath)).status).toBe(200);
    expect((await first.get(firstPath)).status).toBe(200);
    expectLimited(await first.get(firstPath));

    const second = freshBrowser(bindingApp);
    const secondIssued = await issue(second);
    const secondPath = `${CHALLENGES}/${secondIssued.body.data.challenge.id}`;
    expect((await second.get(secondPath)).status).toBe(200);
  });

  it("AUTH-04 reopens the window after windowMs", async () => {
    const app = limitedApp({ issuePerIp: 3 });
    for (let attempt = 0; attempt < 3; attempt += 1)
      expect((await issue(freshBrowser(app))).status).toBe(201);
    expectLimited(await issue(freshBrowser(app)));

    clock += WINDOW_MS - 1;
    expectLimited(await issue(freshBrowser(app)));

    clock += 1;
    expect((await issue(freshBrowser(app))).status).toBe(201);
  });

  it("AUTH-04 never charges an OPTIONS preflight", async () => {
    const app = limitedApp({ issuePerIp: 1 });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const preflight = await freshBrowser(app)
        .options(ISSUE)
        .set(originHeader)
        .set("Access-Control-Request-Method", "POST");
      expect(preflight.status).toBeLessThan(300);
    }
    expect((await issue(freshBrowser(app))).status).toBe(201);
    expectLimited(await issue(freshBrowser(app)));
  });

  it("AUTH-04 still stops a sixth challenge with its own service rule when the limiter is not the cause", async () => {
    // Default limits (30 per IP, 10 per binding per minute): five issues from
    // one browser are accepted, the sixth is the existing AUTH-04 rule.
    const app = createApp({ whatsappWebhookSecrets: [SECRET] });
    const browser = freshBrowser(app);
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect((await issue(browser)).status).toBe(201);

    const limitedAuditBefore = await countAuditRows(
      "login_challenge.rate_limited",
    );
    const sixth = await issue(browser);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe("RATE_LIMITED");
    // Only the service writes this audit row; the HTTP limiter never does.
    expect(await countAuditRows("login_challenge.rate_limited")).toBe(
      limitedAuditBefore + 1,
    );
    expect(await countChallenges()).toBe(5);
  });
});
