// Public, session-free API reads are rate limited per client IP and per
// resolved tenant (bead legend-wd4b): the guest QR scan and menu, the brand
// website and its menu, the SSR brand context and customer payment links.
//
// The probe app mounts the real middleware, tenant resolver and error handler
// without a database, which keeps the limiter arithmetic (windows, buckets,
// Retry-After) testable with a controlled clock. The wiring cases run the real
// Express app, so a limiter mounted too broadly — over health or Better Auth —
// fails them.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import type { SharedWindowStore } from "../lib/shared-window-store";
import { errorHandler, notFound } from "../middleware/error-handler";
import {
  createFixedWindowCounter,
  publicRateLimit,
  type PublicRateLimitOptions,
} from "../middleware/public-rate-limit";
import { tenantContext } from "../middleware/tenant";
import { agent } from "./helpers";

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const HOST_A = "tenant-a.example.test";
const HOST_B = "tenant-b.example.test";

function probeApp(options: Partial<PublicRateLimitOptions>) {
  const app = express();
  // One trusted proxy hop, as TRUST_PROXY does in production: the test names
  // the client address in X-Forwarded-For, and nothing else may.
  app.set("trust proxy", 1);
  app.use(
    tenantContext({
      required: false,
      resolveDomain: async (hostname) =>
        hostname === HOST_A
          ? { tenantId: TENANT_A, brandId: null }
          : hostname === HOST_B
            ? { tenantId: TENANT_B, brandId: null }
            : null,
      verifyCredential: async () => null,
    }),
  );
  app.use(
    "/api/qr",
    publicRateLimit({ perIp: 1000, perTenant: 1000, ...options }),
    (_req, res) => {
      res.json({ data: { ok: true } });
    },
  );
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

function publicRead(app: express.Express, ip: string, host = HOST_A) {
  return request(app)
    .get("/api/qr/menu/probe")
    .set("Host", host)
    .set("X-Forwarded-For", ip);
}

describe("public read rate limit (legend-wd4b)", () => {
  it("legend-wd4b limits a public read per client IP", async () => {
    const app = probeApp({ perIp: 2 });
    const read = () => publicRead(app, "203.0.113.10");
    expect((await read()).status).toBe(200);
    expect((await read()).status).toBe(200);
    const limited = await read();
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });

  it("legend-wd4b counts separate client IPs independently", async () => {
    const app = probeApp({ perIp: 1 });
    expect((await publicRead(app, "203.0.113.10")).status).toBe(200);
    expect((await publicRead(app, "203.0.113.10")).status).toBe(429);
    // A second address keeps its own untouched window.
    expect((await publicRead(app, "203.0.113.11")).status).toBe(200);
    expect((await publicRead(app, "203.0.113.10")).status).toBe(429);
  });

  it("legend-wd4b gives each tenant its own bucket", async () => {
    const app = probeApp({ perIp: 1000, perTenant: 2 });
    const readTenantA = (ip: string) => publicRead(app, ip, HOST_A);
    const readTenantB = (ip: string) => publicRead(app, ip, HOST_B);
    expect((await readTenantA("203.0.113.20")).status).toBe(200);
    expect((await readTenantA("203.0.113.20")).status).toBe(200);
    // Tenant A's window is spent, even from an address that never asked.
    expect((await readTenantA("203.0.113.21")).status).toBe(429);
    // Tenant B is unaffected, same address as the blocked request.
    expect((await readTenantB("203.0.113.21")).status).toBe(200);
  });

  it("legend-wd4b answers 429 with Retry-After covering the rest of the window", async () => {
    const now = 1_000_000;
    const app = probeApp({ perIp: 1, windowMs: 30_000, now: () => now });
    expect((await publicRead(app, "203.0.113.30")).status).toBe(200);
    const limited = await publicRead(app, "203.0.113.30");
    expect(limited.status).toBe(429);
    // Whole seconds left in the fixed window: the client may retry after that.
    expect(limited.headers["retry-after"]).toBe("30");
    // A cache must never replay the 429 past its window.
    expect(limited.headers["cache-control"]).toBe("no-store");
  });

  it("legend-wd4b reopens the window once it has elapsed", async () => {
    let now = 1_000_000;
    const app = probeApp({ perIp: 1, now: () => now });
    expect((await publicRead(app, "203.0.113.40")).status).toBe(200);
    expect((await publicRead(app, "203.0.113.40")).status).toBe(429);
    now += 60_000;
    expect((await publicRead(app, "203.0.113.40")).status).toBe(200);
  });

  it("legend-wd4b keeps the store bounded, evicting the oldest key", async () => {
    const counter = createFixedWindowCounter({
      limit: 1,
      windowMs: 60_000,
      capacity: 2,
    });
    expect(counter.take("ip:first", 0)).toBeNull();
    expect(counter.take("ip:second", 0)).toBeNull();
    // A third key evicts the least recently used one instead of growing.
    expect(counter.take("ip:third", 0)).toBeNull();
    expect(counter.size()).toBe(2);
  });
});

describe("public read rate limit wiring (legend-wd4b)", () => {
  const hostname = cafeLegendPlatformFixtures.domains[0].hostname as string;

  it("legend-wd4b limits the SSR brand context in the real app and leaves health and auth alone", async () => {
    // One request per IP: a limiter mounted over the whole API would answer
    // the later probes with 429.
    const app = createApp({ publicRateLimit: { perIp: 1, internalIps: [] } });
    const client = agent(app);
    await client.get("/api/health").expect(200);
    await client.get("/api/health").expect(200);
    await client.get("/api/auth/get-session").expect(200);
    await client.get("/api/auth/get-session").expect(200);
    // The public read is mounted: first answer passes, the next is limited.
    const first = await client.get("/api/tenant/context").set("Host", hostname);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const limited = await client
      .get("/api/tenant/context")
      .set("Host", hostname);
    expect(limited.status, JSON.stringify(limited.body)).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("legend-wd4b limits the website menu in the real app", async () => {
    const app = createApp({ publicRateLimit: { perIp: 1, internalIps: [] } });
    const client = agent(app);
    // The seeded test tenant has no published website menu yet, so the read
    // itself answers 404 — it was counted once, and the next read is limited,
    // which is what proves the /api/public/site prefix is mounted.
    const first = await client
      .get("/api/public/site/menu")
      .set("Host", hostname);
    expect(first.status, JSON.stringify(first.body)).toBe(404);
    const limited = await client
      .get("/api/public/site/menu")
      .set("Host", hostname);
    expect(limited.status, JSON.stringify(limited.body)).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });

  it("legend-wd4b lets the web server's SSR address skip the per-IP bucket, not the tenant one", async () => {
    // SSR calls carry no visitor IP: without the exemption every visitor of
    // the site would share the web server's one per-IP bucket.
    const app = probeApp({
      perIp: 1,
      perTenant: 3,
      internalIps: ["10.0.0.5"],
    });
    await publicRead(app, "10.0.0.5").expect(200);
    await publicRead(app, "10.0.0.5").expect(200);
    await publicRead(app, "10.0.0.5").expect(200);
    // The tenant bucket still caps the SSR traffic.
    await publicRead(app, "10.0.0.5").expect(429);
    // A visitor address is still limited per IP (tenant B, fresh bucket).
    await publicRead(app, "203.0.113.9", HOST_B).expect(200);
    await publicRead(app, "203.0.113.9", HOST_B).expect(429);
  });

  it("legend-wd4b never limits authenticated payment admin routes", async () => {
    const app = createApp({ publicRateLimit: { perIp: 1, internalIps: [] } });
    const client = agent(app);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await client
        .get("/api/payments/admin/routing")
        .set("Host", hostname);
      expect(response.status).not.toBe(429);
    }
  });

  it("limits only the public subscription-plans GET, never staff writes or sub-paths", async () => {
    const app = createApp({ publicRateLimit: { perIp: 1, internalIps: [] } });
    const client = agent(app);
    const path = "/api/facility/subscription-plans";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const post = await client.post(path).set("Host", hostname).send({});
      expect(post.status).not.toBe(429);
      const patch = await client
        .patch(`${path}/${randomUUID()}`)
        .set("Host", hostname)
        .send({});
      expect(patch.status).not.toBe(429);
    }
    // Staff calls spent nothing: the first public GET passes, the next is limited.
    const first = await client.get(path).set("Host", hostname);
    expect(first.status, JSON.stringify(first.body)).not.toBe(429);
    const limited = await client.get(path).set("Host", hostname);
    expect(limited.status, JSON.stringify(limited.body)).toBe(429);
  });

  it("legend-wd4b limits the guest QR read in the real app", async () => {
    const app = createApp({ publicRateLimit: { perIp: 1, internalIps: [] } });
    const client = agent(app);
    // An unknown table token is NOT_FOUND/422, never 429: it was counted once.
    const first = await client
      .get("/api/qr/menu/unknown-token")
      .set("Host", hostname);
    expect(first.status).not.toBe(429);
    const limited = await client
      .get("/api/qr/menu/unknown-token")
      .set("Host", hostname)
      .expect(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });
});

// Shared window seam (bead legend-bpvf). Assumptions, from the card design:
// `options.store` is an async SharedWindowStore; when set it replaces the
// in-process counters, and the limiter keeps the same limits, messages and
// headers. A store that rejects must never cause a 5xx: the limiter falls back
// to its in-process counter for that instance (fail open per instance).

type TakeCall = {
  bucket: string;
  key: string;
  limit: number;
  windowMs: number;
};

// One fixed window per bucket/key, shared by whoever holds the same instance:
// stands in for Redis.
function fakeSharedStore(now = () => 1_000_000) {
  const counts = new Map<string, number>();
  const calls: TakeCall[] = [];
  const store: SharedWindowStore = {
    async take(bucket, key, limit, windowMs) {
      calls.push({ bucket, key, limit, windowMs });
      const index = Math.floor(now() / windowMs);
      const id = `${bucket}:${key}:${index}`;
      const used = (counts.get(id) ?? 0) + 1;
      counts.set(id, used);
      return used <= limit
        ? { allowed: true, retryAfterMs: 0 }
        : { allowed: false, retryAfterMs: (index + 1) * windowMs - now() };
    },
  };
  return { store, calls };
}

describe("public read rate limit shared store (legend-bpvf)", () => {
  it("legend-bpvf counts two API instances sharing one store as one limit", async () => {
    const { store } = fakeSharedStore();
    const instanceOne = probeApp({ perIp: 2, store });
    const instanceTwo = probeApp({ perIp: 2, store });
    expect((await publicRead(instanceOne, "203.0.113.60")).status).toBe(200);
    expect((await publicRead(instanceTwo, "203.0.113.60")).status).toBe(200);
    // Without the shared window each instance would still have one read left.
    const limitedOne = await publicRead(instanceOne, "203.0.113.60");
    const limitedTwo = await publicRead(instanceTwo, "203.0.113.60");
    expect(limitedOne.status).toBe(429);
    expect(limitedTwo.status).toBe(429);
    expect(limitedOne.body.error.code).toBe("RATE_LIMITED");
  });

  it("legend-bpvf shares the per-tenant window across instances too", async () => {
    const { store } = fakeSharedStore();
    const instanceOne = probeApp({ perIp: 1000, perTenant: 2, store });
    const instanceTwo = probeApp({ perIp: 1000, perTenant: 2, store });
    expect((await publicRead(instanceOne, "203.0.113.61")).status).toBe(200);
    expect((await publicRead(instanceTwo, "203.0.113.62")).status).toBe(200);
    expect((await publicRead(instanceOne, "203.0.113.63")).status).toBe(429);
    // Another tenant has its own shared window.
    expect((await publicRead(instanceTwo, "203.0.113.63", HOST_B)).status).toBe(
      200,
    );
  });

  it("legend-bpvf charges the store with the configured limit, window, client IP and tenant id", async () => {
    const { store, calls } = fakeSharedStore();
    const app = probeApp({ perIp: 7, perTenant: 9, windowMs: 45_000, store });
    expect((await publicRead(app, "203.0.113.64")).status).toBe(200);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const ipCall = calls.find((call) => call.limit === 7);
    const tenantCall = calls.find((call) => call.limit === 9);
    expect(ipCall?.key).toContain("203.0.113.64");
    expect(ipCall?.windowMs).toBe(45_000);
    expect(tenantCall?.key).toContain(TENANT_A);
    expect(tenantCall?.windowMs).toBe(45_000);
    expect(ipCall?.bucket).not.toBe(tenantCall?.bucket);
  });

  it("legend-bpvf answers 429 with Retry-After taken from the store", async () => {
    const store: SharedWindowStore = {
      async take() {
        return { allowed: false, retryAfterMs: 12_000 };
      },
    };
    const limited = await publicRead(probeApp({ store }), "203.0.113.65");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    expect(limited.headers["retry-after"]).toBe("12");
    expect(limited.headers["cache-control"]).toBe("no-store");
  });

  it("legend-bpvf never answers 5xx when the store fails, and still limits in-process", async () => {
    const store: SharedWindowStore = {
      async take() {
        throw new Error("redis down");
      },
    };
    const app = probeApp({ perIp: 1, store });
    const first = await publicRead(app, "203.0.113.66");
    expect(first.status).toBe(200);
    // Fell back to this instance's own counter: the limit still holds here.
    const second = await publicRead(app, "203.0.113.66");
    expect(second.status).toBe(429);
    // A different visitor is unaffected.
    expect((await publicRead(app, "203.0.113.67")).status).toBe(200);
  });

  it("legend-bpvf still works with no store: in-memory path as before", async () => {
    const app = probeApp({ perIp: 1 });
    expect((await publicRead(app, "203.0.113.68")).status).toBe(200);
    expect((await publicRead(app, "203.0.113.68")).status).toBe(429);
  });
});
