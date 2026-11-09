// Edge bootstrap pre-authentication rate limit (bead legend-aor4). GET
// /api/edge-sync/bootstrap must answer 429 before verifyEdgeCredential (DB
// reads) once a client IP or presented credential is over its budget. No
// database: the verifier is a counting stub and the bundle builder is mocked.
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
  EDGE_BOOTSTRAP_PER_IP,
} from "../routes/edge-bootstrap.routes.ts";
import {
  setEdgeCredentialVerifier,
  type VerifiedEdgeNode,
} from "../services/staff-pin-sync.ts";

vi.mock("../services/edge-bootstrap.service.ts", () => ({
  buildEdgeBootstrapBundle: async () => ({ bundle: {}, signature: "stub" }),
}));

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletId = cafeLegendAccessFixtures.outletIds.bandung;
const path = "/api/edge-sync/bootstrap";

function credential(edgeNodeId: string = randomUUID()): string {
  return mintEdgeCredential({ tenantId, outletId, edgeNodeId }).token;
}

/** Well-formed token whose secret is random: the flood the bead describes. */
function forgedCredential(): string {
  const parts = credential().split(".");
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

  // Mounted app (routes/index.ts), default limits: proves the real path is
  // limited, not just the factory. A fresh forged secret per request keeps the
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
