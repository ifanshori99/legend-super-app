// IPv6 clients are rate-limited and counted by /64, not by full address (bead
// legend-6jgd2). One IPv6 subscriber holds at least a /64, so a per-full-address
// key would hand it an unlimited supply of fresh buckets.
//
// Covered: publicRateLimit (`ip:`), createPublicBookingLimits.perRequest
// (`write-ip:`), loginChallengeRateLimit (`ip:`) on probe apps with
// `trust proxy` set on the probe only (the client address comes from
// X-Forwarded-For), and the AUTH-04 per-IP challenge count in
// issueWhatsAppChallenge (real PostgreSQL, login_challenges.ip_hash).
//
// Failing first: every "shares one bucket" / "counts together" case fails on
// the old full-address keying, because each address got its own bucket and the
// limit was never reached. Cases about a different /64, other IPv4, the exact
// internal-IP compare and garbage input hold both before and after.
//
// Assumptions (spec is silent):
// - A constant injected clock keeps every request inside one window.
// - A client-supplied non-IP X-Forwarded-For value is still answered (never a
//   500) and is limited under its own bucket, apart from any IPv6 /64.
// - A mixed-case or zero-padded IPv6 spelling in X-Forwarded-For is what
//   Express reports as `req.ip`; the internal-IP compare stays exact.

import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { establishTenantContext } from "@starter/shared/core/server";
import type { TenantContext } from "@starter/shared/core";
import { clientIpDigest, identityDigest } from "../lib/identity-digest";
import { errorHandler, notFound } from "../middleware/error-handler";
import { loginChallengeRateLimit } from "../middleware/login-challenge-rate-limit";
import {
  createPublicBookingLimits,
  publicRateLimit,
} from "../middleware/public-rate-limit";
import { tenantContext as tenantResolver } from "../middleware/tenant";
import { issueWhatsAppChallenge } from "../services/identity-login.service";
import {
  mapKirimdevSender,
  unmapKirimdevSender,
} from "./helpers/kirimdev-sender";

const TENANT_ID = randomUUID();
const HOST = "tenant-a.example.test";
const CLOCK = 1_000_000;
const WINDOW_MS = 60_000;

// Four different addresses (spellings, compression, case, padding) inside
// 2001:db8:0:1::/64.
const SAME_64 = [
  "2001:db8:0:1::1",
  "2001:DB8:0:1:0:0:0:2",
  "2001:db8:0:1:aaaa:bbbb:cccc:dddd",
  "2001:0db8:0000:0001::4",
  "2001:db8:0:1:ffff:ffff:ffff:ffff",
  "2001:db8:0:1::6",
];
const OTHER_64 = "2001:db8:0:2::1";
const OTHER_V4 = "198.51.100.77";

function resolver() {
  return tenantResolver({
    required: false,
    resolveDomain: async (hostname) =>
      hostname === HOST ? { tenantId: TENANT_ID, brandId: null } : null,
    verifyCredential: async () => null,
  });
}

function expectLimited(res: request.Response) {
  expect(res.status).toBe(429);
  expect(res.body.error.code).toBe("RATE_LIMITED");
  expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
}

// ---------------------------------------------------------------------------
// publicRateLimit
// ---------------------------------------------------------------------------

function publicApp(options: {
  perIp: number;
  internalIps?: string[];
  forceIp?: string;
}) {
  const app = express();
  app.set("trust proxy", true);
  app.use(resolver());
  if (options.forceIp !== undefined) {
    const forced = options.forceIp;
    app.use((req, _res, next) => {
      Object.defineProperty(req, "ip", { value: forced, configurable: true });
      next();
    });
  }
  app.use(
    "/api/qr",
    publicRateLimit({
      perIp: options.perIp,
      perTenant: 1_000_000,
      internalIps: options.internalIps ?? [],
      windowMs: WINDOW_MS,
      now: () => CLOCK,
    }),
    (_req, res) => {
      res.json({ data: { ok: true } });
    },
  );
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

function read(app: express.Express, ip: string) {
  return request(app)
    .get("/api/qr/menu/probe")
    .set("Host", HOST)
    .set("X-Forwarded-For", ip);
}

describe("public read limit keys IPv6 by /64 (legend-6jgd2)", () => {
  it("legend-6jgd2 shares one bucket across addresses of one /64", async () => {
    const app = publicApp({ perIp: 3 });
    for (const ip of SAME_64.slice(0, 3))
      expect((await read(app, ip)).status).toBe(200);
    expectLimited(await read(app, SAME_64[3]!));
    // Rotating to still more addresses in the /64 does not help.
    expectLimited(await read(app, SAME_64[4]!));
    expectLimited(await read(app, SAME_64[5]!));
  });

  it("legend-6jgd2 still serves another /64 and an IPv4 client while one /64 is blocked", async () => {
    const app = publicApp({ perIp: 3 });
    for (const ip of SAME_64.slice(0, 3)) await read(app, ip);
    expectLimited(await read(app, SAME_64[3]!));
    expect((await read(app, OTHER_64)).status).toBe(200);
    expect((await read(app, OTHER_V4)).status).toBe(200);
  });

  it("legend-6jgd2 keeps the same address in the same bucket", async () => {
    const app = publicApp({ perIp: 2 });
    expect((await read(app, SAME_64[0]!)).status).toBe(200);
    expect((await read(app, SAME_64[0]!)).status).toBe(200);
    expectLimited(await read(app, SAME_64[0]!));
  });

  it("legend-6jgd2 counts an IPv4-mapped IPv6 address and the plain IPv4 together", async () => {
    const app = publicApp({ perIp: 3 });
    expect((await read(app, "::ffff:9.9.9.9")).status).toBe(200);
    expect((await read(app, "9.9.9.9")).status).toBe(200);
    expect((await read(app, "::ffff:909:909")).status).toBe(200);
    expectLimited(await read(app, "9.9.9.9"));
    expectLimited(await read(app, "0:0:0:0:0:ffff:909:909"));
  });

  it("legend-6jgd2 does not merge different IPv4 addresses", async () => {
    const app = publicApp({ perIp: 1 });
    expect((await read(app, "9.9.9.9")).status).toBe(200);
    expect((await read(app, "9.9.9.10")).status).toBe(200);
    expectLimited(await read(app, "9.9.9.9"));
  });

  it("legend-6jgd2 compares internal addresses exactly: the skip does not cover the rest of the /64", async () => {
    const app = publicApp({ perIp: 1, internalIps: [SAME_64[0]!] });
    // The internal address is never charged to the per-IP bucket.
    for (let i = 0; i < 4; i += 1)
      expect((await read(app, SAME_64[0]!)).status).toBe(200);
    // A neighbour in the same /64 is an ordinary client.
    expect((await read(app, "2001:db8:0:1::2")).status).toBe(200);
    expectLimited(await read(app, "2001:db8:0:1::3"));
  });

  it("legend-6jgd2 answers a non-IP client address and limits it apart from IPv6 /64 buckets", async () => {
    const app = publicApp({ perIp: 2 });
    expect((await read(app, "not-an-ip")).status).toBe(200);
    expect((await read(app, "not-an-ip")).status).toBe(200);
    expectLimited(await read(app, "not-an-ip"));
    // The garbage bucket is not a shared IPv6 bucket.
    expect((await read(app, SAME_64[0]!)).status).toBe(200);
    // A very long garbage value is answered too.
    expect((await read(app, "z".repeat(300))).status).toBe(200);
  });

  it("legend-6jgd2 answers a request whose resolved address is empty", async () => {
    const app = publicApp({ perIp: 5, forceIp: "" });
    const res = await request(app).get("/api/qr/menu/probe").set("Host", HOST);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// createPublicBookingLimits.perRequest (`write-ip:`)
// ---------------------------------------------------------------------------

function bookingApp(perIp: number) {
  const app = express();
  app.set("trust proxy", true);
  app.use(resolver());
  const limits = createPublicBookingLimits({
    perIp,
    perTenant: 1_000_000,
    perContact: 1_000_000,
    internalIps: [],
    windowMs: WINDOW_MS,
    now: () => CLOCK,
  });
  app.post(
    "/api/public/outlets/:outletId/reservations",
    limits.perRequest,
    (_q, r) => {
      r.status(201).json({ data: { ok: true } });
    },
  );
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

function book(app: express.Express, ip: string) {
  return request(app)
    .post(`/api/public/outlets/${randomUUID()}/reservations`)
    .set("Host", HOST)
    .set("X-Forwarded-For", ip)
    .send({});
}

describe("public booking write limit keys IPv6 by /64 (legend-6jgd2)", () => {
  it("legend-6jgd2 shares the write-ip bucket across addresses of one /64", async () => {
    const app = bookingApp(3);
    for (const ip of SAME_64.slice(0, 3))
      expect((await book(app, ip)).status).toBe(201);
    expectLimited(await book(app, SAME_64[3]!));
    expect((await book(app, OTHER_64)).status).toBe(201);
    expect((await book(app, OTHER_V4)).status).toBe(201);
  });

  it("legend-6jgd2 counts IPv4-mapped IPv6 and plain IPv4 together", async () => {
    const app = bookingApp(2);
    expect((await book(app, "::ffff:9.9.9.9")).status).toBe(201);
    expect((await book(app, "9.9.9.9")).status).toBe(201);
    expectLimited(await book(app, "::ffff:909:909"));
  });

  it("legend-6jgd2 answers a non-IP client address", async () => {
    const app = bookingApp(1);
    expect((await book(app, "not-an-ip")).status).toBe(201);
    expectLimited(await book(app, "not-an-ip"));
  });
});

// ---------------------------------------------------------------------------
// loginChallengeRateLimit
// ---------------------------------------------------------------------------

function loginApp(issuePerIp: number, forceIp?: string) {
  const app = express();
  app.set("trust proxy", true);
  if (forceIp !== undefined)
    app.use((req, _res, next) => {
      Object.defineProperty(req, "ip", { value: forceIp, configurable: true });
      next();
    });
  app.use(
    "/api/auth/login-challenges",
    loginChallengeRateLimit({
      issuePerIp,
      issuePerBinding: 1_000_000,
      pollPerIp: 1_000_000,
      pollPerBinding: 1_000_000,
      internalIps: [],
      windowMs: WINDOW_MS,
      now: () => CLOCK,
    }),
    (_req, res) => {
      res.status(201).json({ data: { ok: true } });
    },
  );
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

function issueFrom(app: express.Express, ip: string) {
  return request(app)
    .post("/api/auth/login-challenges/whatsapp")
    .set("X-Forwarded-For", ip);
}

describe("login challenge limit keys IPv6 by /64 (legend-6jgd2)", () => {
  it("legend-6jgd2 shares the issue bucket across addresses of one /64", async () => {
    const app = loginApp(3);
    for (const ip of SAME_64.slice(0, 3))
      expect((await issueFrom(app, ip)).status).toBe(201);
    expectLimited(await issueFrom(app, SAME_64[3]!));
    expectLimited(await issueFrom(app, SAME_64[4]!));
  });

  it("legend-6jgd2 still serves another /64 and other IPv4 clients", async () => {
    const app = loginApp(3);
    for (const ip of SAME_64.slice(0, 3)) await issueFrom(app, ip);
    expectLimited(await issueFrom(app, SAME_64[3]!));
    expect((await issueFrom(app, OTHER_64)).status).toBe(201);
    expect((await issueFrom(app, OTHER_V4)).status).toBe(201);
  });

  it("legend-6jgd2 counts IPv4-mapped IPv6 and plain IPv4 together", async () => {
    const app = loginApp(3);
    expect((await issueFrom(app, "::ffff:9.9.9.9")).status).toBe(201);
    expect((await issueFrom(app, "9.9.9.9")).status).toBe(201);
    expect((await issueFrom(app, "::ffff:909:909")).status).toBe(201);
    expectLimited(await issueFrom(app, "9.9.9.9"));
  });

  it("legend-6jgd2 answers a non-IP client address and an empty resolved address", async () => {
    const garbage = loginApp(1);
    expect((await issueFrom(garbage, "not-an-ip")).status).toBe(201);
    expectLimited(await issueFrom(garbage, "not-an-ip"));

    const empty = loginApp(5, "");
    const res = await request(empty).post(
      "/api/auth/login-challenges/whatsapp",
    );
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// AUTH-04: five challenges per fifteen minutes per client IP, counted by /64
// ---------------------------------------------------------------------------

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const NUMBER = "628111000081";
// The tenant is private to this file, so cleanup never touches other tests'
// challenges. Its audit rows stay: audit_logs is append-only.
const AUTH_TENANT = randomUUID();

function ctx(): TenantContext {
  return establishTenantContext({
    tenantId: AUTH_TENANT,
    brandId: null,
    source: "session",
  });
}

function freshNonce(): string {
  return randomBytes(32).toString("base64url");
}

/** One challenge request from `ip` with its own binding nonce. */
async function challengeFrom(ip: string) {
  return issueWhatsAppChallenge(ctx(), {
    bindingNonce: freshNonce(),
    ip,
    userAgent: "uji",
  });
}

async function ipHashOf(challengeId: string): Promise<string | null> {
  const { rows } = await owner.query<{ ip_hash: string | null }>(
    "SELECT ip_hash FROM login_challenges WHERE id = $1",
    [challengeId],
  );
  return rows[0]!.ip_hash;
}

async function fiveFrom(ips: string[]) {
  expect(ips).toHaveLength(5);
  const ids: string[] = [];
  for (const ip of ips) ids.push((await challengeFrom(ip)).challenge.id);
  return ids;
}

beforeAll(async () => {
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji IPv6 Masuk', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', $3, 'test')
     ON CONFLICT (id) DO NOTHING`,
    [
      AUTH_TENANT,
      `uji-ipv6-${AUTH_TENANT.slice(0, 8)}`,
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
  await owner.query(
    `INSERT INTO tenant_integrations (tenant_id, provider, config, credentials_encrypted, status)
     VALUES ($1, 'whatsapp', $2, 'c2VhbGVkLXRlc3Q=', 'active')
     ON CONFLICT (tenant_id, provider) WHERE outlet_id IS NULL
     DO UPDATE SET config = EXCLUDED.config, status = EXCLUDED.status`,
    [
      AUTH_TENANT,
      JSON.stringify({ vendor: "kirimdev", receivingNumber: NUMBER }),
    ],
  );
  // Issuing a challenge needs the platform-written sender mapping, else it
  // fails closed (legend-52tdq).
  await mapKirimdevSender(AUTH_TENANT, NUMBER);
});

beforeEach(async () => {
  await owner.query("DELETE FROM login_challenges WHERE tenant_id = $1", [
    AUTH_TENANT,
  ]);
});

afterAll(async () => {
  await owner.query("DELETE FROM login_challenges WHERE tenant_id = $1", [
    AUTH_TENANT,
  ]);
  await unmapKirimdevSender(AUTH_TENANT);
  await owner.query("DELETE FROM tenant_integrations WHERE tenant_id = $1", [
    AUTH_TENANT,
  ]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [AUTH_TENANT]);
  await owner.end();
});

describe("AUTH-04 counts IPv6 clients by /64 (legend-6jgd2)", () => {
  it("AUTH-04 refuses the sixth challenge from a sixth address in the same /64", async () => {
    await fiveFrom(SAME_64.slice(0, 5));
    await expect(challengeFrom(SAME_64[5]!)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("AUTH-04 still serves another /64 and another IPv4 client", async () => {
    await fiveFrom(SAME_64.slice(0, 5));
    await expect(challengeFrom(SAME_64[5]!)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    const other64 = await challengeFrom(OTHER_64);
    expect(other64.challenge.id).toBeTruthy();
    const otherV4 = await challengeFrom(OTHER_V4);
    expect(otherV4.challenge.id).toBeTruthy();
  });

  it("AUTH-04 counts an IPv4-mapped IPv6 address and the same IPv4 together", async () => {
    await fiveFrom([
      "::ffff:203.0.113.7",
      "203.0.113.7",
      "::ffff:cb00:7107",
      "::FFFF:203.0.113.7",
      "0:0:0:0:0:ffff:cb00:7107",
    ]);
    await expect(challengeFrom("203.0.113.7")).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    await expect(challengeFrom("::ffff:203.0.113.7")).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    // A different IPv4 client is served.
    expect((await challengeFrom("203.0.113.8")).challenge.id).toBeTruthy();
  });

  it("AUTH-04 stores one ip_hash for every address of a /64, equal to clientIpDigest", async () => {
    const [first, second] = await fiveFrom(SAME_64.slice(0, 5));
    const hashFirst = await ipHashOf(first!);
    const hashSecond = await ipHashOf(second!);
    expect(hashFirst).toMatch(/^[a-f0-9]{64}$/);
    expect(hashFirst).toBe(hashSecond);
    expect(hashFirst).toBe(clientIpDigest(SAME_64[5]!));
    // A different /64 hashes differently.
    expect(clientIpDigest(OTHER_64)).not.toBe(hashFirst);
  });

  it("AUTH-04 keeps the IPv4 digest unchanged from before the /64 change", async () => {
    const issued = await challengeFrom("203.0.113.45");
    expect(await ipHashOf(issued.challenge.id)).toBe(
      identityDigest("client-ip", "203.0.113.45"),
    );
    expect(clientIpDigest("203.0.113.45")).toBe(
      identityDigest("client-ip", "203.0.113.45"),
    );
    // The mapped form hashes like the IPv4 client.
    expect(clientIpDigest("::ffff:203.0.113.45")).toBe(
      identityDigest("client-ip", "203.0.113.45"),
    );
  });

  it("AUTH-04 answers an empty or non-IP client address without crashing", async () => {
    const empty = await challengeFrom("");
    expect(await ipHashOf(empty.challenge.id)).toBeNull();
    const garbage = await challengeFrom("not-an-ip");
    expect(await ipHashOf(garbage.challenge.id)).toMatch(/^[a-f0-9]{64}$/);
  });
});
