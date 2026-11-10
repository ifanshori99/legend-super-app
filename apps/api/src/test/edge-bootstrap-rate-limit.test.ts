// Edge bootstrap pre-authentication rate limit (bead legend-aor4). GET
// /api/edge-sync/bootstrap must answer 429 before verifyEdgeCredential (DB
// reads) once a client IP or presented credential is over its budget. No
// database: the verifier is a counting stub and the bundle builder is mocked.
// legend-uznb: /masters has its own, higher limiter (per IP and per IP + edge
// node id), and createApp runs the limiter before tenant resolution, so a
// limited request never reaches the tenant-domain query (resolveHostname is a
// counting stub here).
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { mintEdgeCredential } from "../edge/credential.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import {
  createEdgeBootstrapRouter,
  EDGE_BOOTSTRAP_PER_CREDENTIAL,
  EDGE_BOOTSTRAP_PER_IP,
  EDGE_MASTERS_PER_DEVICE,
  EDGE_MASTERS_PER_IP,
} from "../routes/edge-bootstrap.routes.ts";
import {
  setEdgeCredentialVerifier,
  type VerifiedEdgeNode,
} from "../services/staff-pin-sync.ts";

vi.mock("../services/edge-bootstrap.service.ts", () => ({
  buildEdgeBootstrapBundle: async () => ({ bundle: {}, signature: "stub" }),
}));
vi.mock("../services/edge-master-sync.service.ts", () => ({
  buildEdgeMasterSnapshot: async () => ({ snapshot: {}, signature: "stub" }),
}));

/** Tenant-domain lookups (the tenant_domains JOIN tenants query). */
const domainQueries = vi.hoisted(() => ({ count: 0 }));
vi.mock("../services/org-resolve.service.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../services/org-resolve.service.ts")
  >()),
  resolveHostname: async () => {
    domainQueries.count += 1;
    return { ok: false, reason: "unknown_host" };
  },
}));

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletId = cafeLegendAccessFixtures.outletIds.bandung;
const path = "/api/edge-sync/bootstrap";

function credential(edgeNodeId: string = randomUUID()): string {
  return mintEdgeCredential({ tenantId, outletId, edgeNodeId }).token;
}

/** Well-formed token whose secret is random: the flood the bead describes. */
function forgedCredential(edgeNodeId?: string): string {
  const parts = credential(edgeNodeId).split(".");
  parts[4] = randomBytes(32).toString("base64url");
  return parts.join(".");
}

afterEach(() => {
  setEdgeCredentialVerifier(null);
});

describe("legend-aor4 edge bootstrap rate limit (before credential check)", () => {
  function appWith(options: Parameters<typeof createEdgeBootstrapRouter>[0]) {
    const app = express();
    app.set("trust proxy", true);
    app.use(path, createEdgeBootstrapRouter(options));
    app.use(errorHandler);
    return app;
  }

  function stubVerifier(validToken?: string, node?: VerifiedEdgeNode) {
    const calls = { count: 0 };
    setEdgeCredentialVerifier(async (input) => {
      calls.count += 1;
      return validToken !== undefined && input.credential === validToken
        ? (node ?? null)
        : null;
    });
    return calls;
  }

  it("answers 429 after the per-IP limit for a flood of well-formed fake credentials, without reaching the verifier", async () => {
    const calls = stubVerifier();
    const app = appWith({
      perIp: 3,
      perCredential: 1_000,
      windowMs: 60_000,
      now: () => 1_000_000,
    });
    const get = (ip: string) =>
      request(app)
        .get(path)
        .set("X-Forwarded-For", ip)
        .set("Authorization", `Bearer ${forgedCredential()}`);

    for (let i = 0; i < 3; i += 1)
      expect((await get("10.0.0.1")).status).toBe(401);
    expect(calls.count).toBe(3);

    const limited = await get("10.0.0.1");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.headers["cache-control"]).toBe("no-store");
    expect(calls.count).toBe(3);
  });

  it("caps one presented credential, leaving another credential alone", async () => {
    const calls = stubVerifier();
    const app = appWith({
      perIp: 1_000,
      perCredential: 2,
      windowMs: 60_000,
      now: () => 1_000_000,
    });
    const a = forgedCredential();
    const b = forgedCredential();
    const get = (token: string) =>
      request(app).get(path).set("Authorization", `Bearer ${token}`);
    expect((await get(a)).status).toBe(401);
    expect((await get(a)).status).toBe(401);
    expect((await get(a)).status).toBe(429);
    expect(calls.count).toBe(2);
    expect((await get(b)).status).toBe(401);
    expect(calls.count).toBe(3);
  });

  it("a valid node from another IP still bootstraps while the flooding IP is limited", async () => {
    const good = credential();
    const calls = stubVerifier(good, {
      tenantId,
      outletId,
      edgeNodeId: randomUUID(),
    } as VerifiedEdgeNode);
    const app = appWith({
      perIp: 2,
      perCredential: 1_000,
      windowMs: 60_000,
      now: () => 1_000_000,
    });
    const flood = () =>
      request(app)
        .get(path)
        .set("X-Forwarded-For", "10.0.0.9")
        .set("Authorization", `Bearer ${forgedCredential()}`);
    await flood();
    await flood();
    expect((await flood()).status).toBe(429);
    const before = calls.count;

    const ok = await request(app)
      .get(path)
      .set("X-Forwarded-For", "10.0.0.2")
      .set("Authorization", `Bearer ${good}`);
    expect(ok.status).toBe(200);
    expect(ok.headers["cache-control"]).toMatch(/no-store/);
    expect(calls.count).toBe(before + 1);
  });

  it("reopens after the window", async () => {
    stubVerifier();
    let clock = 1_000_000;
    const app = appWith({
      perIp: 1,
      windowMs: 60_000,
      now: () => clock,
    });
    const get = () =>
      request(app)
        .get(path)
        .set("Authorization", `Bearer ${forgedCredential()}`);
    expect((await get()).status).toBe(401);
    expect((await get()).status).toBe(429);
    clock += 61_000;
    expect((await get()).status).toBe(401);
  });

  // Mounted app (createApp mounts the limiter, app.ts), default limits: proves
  // the real path is limited, not just the factory. A fresh forged secret per request keeps the
  // per-credential bucket out of the way, so the IP bucket must trip.
  it("limits the mounted /api/edge-sync/bootstrap route: 429 within PER_IP+1 requests, verifier not called past the limit", async () => {
    const calls = stubVerifier();
    const app = createApp();
    // Ceiling well above the limit, so old unlimited code fails on "no 429"
    // rather than on a missing constant.
    let firstLimited = -1;
    for (let i = 0; i < 100 && firstLimited === -1; i += 1) {
      const response = await request(app)
        .get(path)
        .set("Authorization", `Bearer ${forgedCredential()}`);
      if (response.status === 429) firstLimited = i;
      else expect(response.status).toBe(401);
    }
    expect(firstLimited).toBe(EDGE_BOOTSTRAP_PER_IP);
    expect(calls.count).toBe(EDGE_BOOTSTRAP_PER_IP);
  });
});

describe("legend-uznb edge /masters limiter and limit before tenant resolution", () => {
  const mastersPath = `${path}/masters`;

  function appWith(options: Parameters<typeof createEdgeBootstrapRouter>[0]) {
    const app = express();
    app.set("trust proxy", true);
    app.use(path, createEdgeBootstrapRouter(options));
    app.use(errorHandler);
    return app;
  }

  function stubVerifier() {
    const calls = { count: 0 };
    setEdgeCredentialVerifier(async () => {
      calls.count += 1;
      return null;
    });
    return calls;
  }

  const masters = (app: express.Express, token: string, ip = "10.0.0.1") =>
    request(app)
      .get(mastersPath)
      .set("X-Forwarded-For", ip)
      .set("Authorization", `Bearer ${token}`);

  it("defaults /masters above the bootstrap limits", () => {
    expect(EDGE_MASTERS_PER_IP).toBeGreaterThan(EDGE_BOOTSTRAP_PER_IP);
    expect(EDGE_MASTERS_PER_DEVICE).toBeGreaterThan(
      EDGE_BOOTSTRAP_PER_CREDENTIAL,
    );
  });

  it("keeps a separate bucket per device on one IP", async () => {
    const calls = stubVerifier();
    const app = appWith({
      mastersPerIp: 1_000,
      mastersPerDevice: 2,
      windowMs: 60_000,
      now: () => 1_000_000,
    });
    const a = randomUUID();
    const tokenA = forgedCredential(a);
    // One device always presents the same credential: its bucket is the
    // hashed bearer on this IP.
    expect((await masters(app, tokenA)).status).toBe(401);
    expect((await masters(app, tokenA)).status).toBe(401);
    expect((await masters(app, tokenA)).status).toBe(429);
    expect(calls.count).toBe(2);
    expect((await masters(app, forgedCredential())).status).toBe(401);
    // Same device from another IP: another bucket.
    expect((await masters(app, tokenA, "10.0.0.2")).status).toBe(401);
    expect(calls.count).toBe(4);
  });

  it("a host that knows a node's id but not its secret cannot exhaust that node's bucket", async () => {
    stubVerifier();
    const app = appWith({
      mastersPerIp: 1_000,
      mastersPerDevice: 2,
      windowMs: 60_000,
      now: () => 1_000_000,
    });
    const nodeId = randomUUID();
    const real = forgedCredential(nodeId);
    // The forger floods with the real node's id and fresh secrets.
    for (let i = 0; i < 5; i += 1)
      expect((await masters(app, forgedCredential(nodeId))).status).toBe(401);
    // The real node's own credential still has its whole budget.
    expect((await masters(app, real)).status).toBe(401);
    expect((await masters(app, real)).status).toBe(401);
    expect((await masters(app, real)).status).toBe(429);
  });

  it("caps one IP across devices, leaving other IPs alone", async () => {
    const calls = stubVerifier();
    const app = appWith({
      mastersPerIp: 3,
      mastersPerDevice: 1_000,
      windowMs: 60_000,
      now: () => 1_000_000,
    });
    for (let i = 0; i < 3; i += 1)
      expect((await masters(app, forgedCredential())).status).toBe(401);
    const limited = await masters(app, forgedCredential());
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // A bearer that does not parse is charged to the IP bucket too.
    expect((await masters(app, "not-a-credential")).status).toBe(429);
    expect(calls.count).toBe(3);
    expect((await masters(app, forgedCredential(), "10.0.0.2")).status).toBe(
      401,
    );
  });

  it("uses buckets apart from the bootstrap route", async () => {
    stubVerifier();
    const app = appWith({
      perIp: 1,
      mastersPerIp: 1_000,
      mastersPerDevice: 1_000,
      windowMs: 60_000,
      now: () => 1_000_000,
    });
    const get = () =>
      request(app)
        .get(path)
        .set("X-Forwarded-For", "10.0.0.1")
        .set("Authorization", `Bearer ${forgedCredential()}`);
    expect((await get()).status).toBe(401);
    expect((await get()).status).toBe(429);
    expect((await masters(app, forgedCredential())).status).toBe(401);
  });

  it("mounted bootstrap route: a flood from one IP gets 429 with no further tenant-domain queries", async () => {
    const calls = stubVerifier();
    const app = createApp();
    domainQueries.count = 0;
    let firstLimited = -1;
    for (let i = 0; i < 100 && firstLimited === -1; i += 1) {
      const response = await request(app)
        .get(path)
        .set("Authorization", `Bearer ${forgedCredential()}`);
      if (response.status === 429) firstLimited = i;
      else expect(response.status).toBe(401);
    }
    expect(firstLimited).toBe(EDGE_BOOTSTRAP_PER_IP);
    expect(domainQueries.count).toBe(EDGE_BOOTSTRAP_PER_IP);
    for (let i = 0; i < 5; i += 1) {
      const response = await request(app)
        .get(path)
        .set("Authorization", `Bearer ${forgedCredential()}`);
      expect(response.status).toBe(429);
    }
    expect(domainQueries.count).toBe(EDGE_BOOTSTRAP_PER_IP);
    expect(calls.count).toBe(EDGE_BOOTSTRAP_PER_IP);
  });

  it("mounted /masters: one device passes the bootstrap credential limit, is refused at its own limit, with no further tenant-domain queries", async () => {
    const calls = stubVerifier();
    const app = createApp();
    domainQueries.count = 0;
    // One device = one bearer: the device bucket is keyed on the hashed bearer.
    const token = forgedCredential(randomUUID());
    const get = () =>
      request(app).get(mastersPath).set("Authorization", `Bearer ${token}`);
    let firstLimited = -1;
    for (let i = 0; i < 200 && firstLimited === -1; i += 1) {
      const response = await get();
      if (response.status === 429) firstLimited = i;
      else expect(response.status).toBe(401);
    }
    expect(firstLimited).toBe(EDGE_MASTERS_PER_DEVICE);
    expect(firstLimited).toBeGreaterThan(EDGE_BOOTSTRAP_PER_CREDENTIAL);
    expect(domainQueries.count).toBe(EDGE_MASTERS_PER_DEVICE);
    expect((await get()).status).toBe(429);
    expect(domainQueries.count).toBe(EDGE_MASTERS_PER_DEVICE);
    expect(calls.count).toBe(EDGE_MASTERS_PER_DEVICE);
    // Another device on the same IP still gets through to the credential check.
    expect(
      (
        await request(app)
          .get(mastersPath)
          .set("Authorization", `Bearer ${forgedCredential()}`)
      ).status,
    ).toBe(401);
  });
});
