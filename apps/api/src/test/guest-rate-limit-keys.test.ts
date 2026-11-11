// Shared-store key hygiene for the public limiters (bead legend-bpvf, round 2
// findings 1 and 2).
//
// Finding 1: guest table-session polling and public reads share one Redis, so
// their buckets must not collide. Assumed names, from the round 2 design:
// publicRateLimit option `bucketPrefix` (default "public") gives buckets
// `public:ip` / `public:tenant`; guestSessionRateLimit uses `guest:ip`,
// `guest:tenant`, `guest:session`, `guest:cred-ip`; booking uses
// `booking:ip` / `booking:tenant`.
//
// Finding 2: a flood of random well-formed bearers must not create unbounded
// shared-store keys. Once the per-IP bucket has answered 429 no credential key
// exists for the request, and credential-bearing requests are capped per IP per
// window by the option `perIpCredentials` (default: the guest per-IP limit).

import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { SharedWindowStore } from "../lib/shared-window-store";
import { errorHandler, notFound } from "../middleware/error-handler";
import {
  createPublicBookingLimits,
  guestSessionRateLimit,
  publicRateLimit,
} from "../middleware/public-rate-limit";
import { tenantContext } from "../middleware/tenant";

const TENANT = randomUUID();
const HOST = "guest-keys.example.test";
const WINDOW_MS = 60_000;
const NOW = 1_000_000;

type TakeCall = { bucket: string; key: string; limit: number };

// Stands in for Redis: one fixed window per bucket/key, records every key ever
// created so a test can count them.
function recordingStore(clock: { now: number } = { now: NOW }) {
  const counts = new Map<string, number>();
  const calls: TakeCall[] = [];
  const store: SharedWindowStore = {
    async take(bucket, key, limit, windowMs) {
      calls.push({ bucket, key, limit });
      const index = Math.floor(clock.now / windowMs);
      const id = `${bucket}:${key}:${index}`;
      const used = (counts.get(id) ?? 0) + 1;
      counts.set(id, used);
      return used <= limit
        ? { allowed: true, retryAfterMs: 0 }
        : { allowed: false, retryAfterMs: (index + 1) * windowMs - clock.now };
    },
  };
  return {
    store,
    calls,
    clock,
    keyCount: () => counts.size,
    keysOf: (bucket: string) =>
      new Set(calls.filter((call) => call.bucket === bucket).map((c) => c.key)),
    // Session credential keys, whatever prefix the bucket carries.
    sessionKeys: () =>
      new Set(
        calls
          .filter((call) => call.bucket.endsWith("session"))
          .map((c) => c.key),
      ),
  };
}

function baseApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(
    tenantContext({
      required: false,
      resolveDomain: async (hostname) =>
        hostname === HOST ? { tenantId: TENANT, brandId: null } : null,
      verifyCredential: async () => null,
    }),
  );
  return app;
}

function finish(app: express.Express) {
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

type Options = Record<string, unknown>;

// Public read limiter and guest table-session limiter on one app, one store.
function mixedApp(store: SharedWindowStore, pub: Options, guest: Options) {
  const app = baseApp();
  app.use(
    "/api/qr",
    publicRateLimit({ store, now: () => NOW, ...pub } as never),
    (_req, res) => {
      res.json({ data: { ok: true } });
    },
  );
  app.use(
    "/api/table-sessions",
    guestSessionRateLimit({ store, now: () => NOW, ...guest } as never),
    (_req, res) => {
      res.json({ data: { ok: true } });
    },
  );
  return finish(app);
}

function publicRead(app: express.Express, ip: string) {
  return request(app)
    .get("/api/qr/menu/probe")
    .set("Host", HOST)
    .set("X-Forwarded-For", ip);
}

function guestPoll(app: express.Express, ip: string, bearer?: string) {
  const req = request(app)
    .get(`/api/table-sessions/${randomUUID()}/poll`)
    .set("Host", HOST)
    .set("X-Forwarded-For", ip);
  return bearer ? req.set("Authorization", `Bearer ${bearer}`) : req;
}

const randomBearer = () => randomBytes(24).toString("base64url");

describe("guest and public limiters do not share buckets (legend-bpvf)", () => {
  it("legend-bpvf guest polling does not spend the public read budget", async () => {
    const { store } = recordingStore();
    const app = mixedApp(
      store,
      { perIp: 2, perTenant: 1000 },
      { perIp: 1000, perTenant: 1000 },
    );
    const ip = "203.0.113.101";
    for (let poll = 0; poll < 5; poll += 1)
      expect((await guestPoll(app, ip)).status).toBe(200);
    // The public budget of 2 is untouched by the 5 guest requests.
    expect((await publicRead(app, ip)).status).toBe(200);
    expect((await publicRead(app, ip)).status).toBe(200);
    expect((await publicRead(app, ip)).status).toBe(429);
  });

  it("legend-bpvf public reads do not spend the guest budget", async () => {
    const { store } = recordingStore();
    const app = mixedApp(
      store,
      { perIp: 1000, perTenant: 1000 },
      { perIp: 3, perTenant: 1000 },
    );
    const ip = "203.0.113.102";
    for (let read = 0; read < 5; read += 1)
      expect((await publicRead(app, ip)).status).toBe(200);
    for (let poll = 0; poll < 3; poll += 1)
      expect((await guestPoll(app, ip)).status).toBe(200);
    expect((await guestPoll(app, ip)).status).toBe(429);
  });

  it("legend-bpvf names buckets by limiter: public:, guest:", async () => {
    const { store, calls } = recordingStore();
    const app = mixedApp(
      store,
      { perIp: 10, perTenant: 10 },
      { perIp: 10, perTenant: 10 },
    );
    await publicRead(app, "203.0.113.103").expect(200);
    const publicBuckets = new Set(calls.map((call) => call.bucket));
    expect([...publicBuckets].sort()).toEqual(["public:ip", "public:tenant"]);

    calls.length = 0;
    await guestPoll(app, "203.0.113.103", randomBearer()).expect(200);
    const guestBuckets = new Set(calls.map((call) => call.bucket));
    expect([...guestBuckets].sort()).toEqual([
      "guest:cred-ip",
      "guest:ip",
      "guest:session",
      "guest:tenant",
    ]);
  });

  it("legend-bpvf prefixes booking buckets with booking:", async () => {
    const { store, calls } = recordingStore();
    const app = baseApp();
    const limits = createPublicBookingLimits({
      perIp: 10,
      perTenant: 10,
      perContact: 10,
      internalIps: [],
      store,
      now: () => NOW,
    });
    app.post(
      "/api/public/outlets/:outletId/reservations",
      limits.perRequest,
      (_req, res) => {
        res.status(201).json({ data: { ok: true } });
      },
    );
    finish(app);
    await request(app)
      .post(`/api/public/outlets/${randomUUID()}/reservations`)
      .set("Host", HOST)
      .set("X-Forwarded-For", "203.0.113.104")
      .send({})
      .expect(201);
    expect([...new Set(calls.map((c) => c.bucket))].sort()).toEqual([
      "booking:ip",
      "booking:tenant",
    ]);
  });

  it("legend-bpvf lets a caller choose the public bucket prefix", async () => {
    const { store, calls } = recordingStore();
    const app = baseApp();
    app.use(
      "/api/qr",
      publicRateLimit({
        perIp: 10,
        perTenant: 10,
        store,
        now: () => NOW,
        bucketPrefix: "custom",
      } as never),
      (_req, res) => {
        res.json({ data: { ok: true } });
      },
    );
    finish(app);
    await publicRead(app, "203.0.113.105").expect(200);
    expect([...new Set(calls.map((c) => c.bucket))].sort()).toEqual([
      "custom:ip",
      "custom:tenant",
    ]);
  });
});

describe("guest credential floods create bounded shared keys (legend-bpvf)", () => {
  it("legend-bpvf creates zero new keys for random bearers once the per-IP bucket answers 429", async () => {
    const rec = recordingStore();
    const app = mixedApp(
      rec.store,
      { perIp: 1000, perTenant: 1000 },
      { perIp: 2, perTenant: 1000 },
    );
    const ip = "203.0.113.110";
    expect((await guestPoll(app, ip)).status).toBe(200);
    expect((await guestPoll(app, ip)).status).toBe(200);
    expect((await guestPoll(app, ip)).status).toBe(429);
    const before = rec.keyCount();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const flood = await guestPoll(app, ip, randomBearer());
      expect(flood.status).toBe(429);
      expect(flood.body.error.code).toBe("RATE_LIMITED");
    }
    expect(rec.keyCount()).toBe(before);
    expect(rec.sessionKeys().size).toBe(0);
  });

  it("legend-bpvf creates zero new keys for random bearers once the tenant bucket answers 429", async () => {
    const rec = recordingStore();
    const app = mixedApp(
      rec.store,
      { perIp: 1000, perTenant: 1000 },
      { perIp: 1000, perTenant: 1 },
    );
    expect((await guestPoll(app, "203.0.113.111")).status).toBe(200);
    expect((await guestPoll(app, "203.0.113.111")).status).toBe(429);
    const sessionKeysBefore = rec.sessionKeys().size;
    for (let attempt = 0; attempt < 20; attempt += 1)
      expect(
        (await guestPoll(app, "203.0.113.112", randomBearer())).status,
      ).toBe(429);
    expect(rec.sessionKeys().size).toBe(sessionKeysBefore);
  });

  it("legend-bpvf caps session keys created from one IP per window at perIpCredentials", async () => {
    const rec = recordingStore();
    const app = mixedApp(
      rec.store,
      { perIp: 1000, perTenant: 1000 },
      { perIp: 1000, perTenant: 1000, perIpCredentials: 5 },
    );
    const ip = "203.0.113.120";
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 30; attempt += 1)
      statuses.push((await guestPoll(app, ip, randomBearer())).status);
    expect(
      statuses.filter((status) => status === 200).length,
    ).toBeLessThanOrEqual(5);
    expect(
      statuses.filter((status) => status === 429).length,
    ).toBeGreaterThanOrEqual(25);
    expect(rec.sessionKeys().size).toBeLessThanOrEqual(5);

    // The cap is per IP: another visitor still has their own credential budget.
    expect((await guestPoll(app, "203.0.113.121", randomBearer())).status).toBe(
      200,
    );

    // And per window: the next window opens a fresh budget.
    rec.clock.now += WINDOW_MS;
    // `now` is injected as a constant by mixedApp; rebuild with the live clock.
    const later = baseApp();
    later.use(
      "/api/table-sessions",
      guestSessionRateLimit({
        store: rec.store,
        now: () => rec.clock.now,
        perIp: 1000,
        perTenant: 1000,
        perIpCredentials: 5,
      } as never),
      (_req, res) => {
        res.json({ data: { ok: true } });
      },
    );
    finish(later);
    expect((await guestPoll(later, ip, randomBearer())).status).toBe(200);
  });

  it("legend-bpvf defaults perIpCredentials to the guest per-IP limit", async () => {
    const rec = recordingStore();
    const app = mixedApp(
      rec.store,
      { perIp: 1000, perTenant: 1000 },
      { perIp: 7, perTenant: 1000 },
    );
    await guestPoll(app, "203.0.113.130", randomBearer()).expect(200);
    const credCalls = rec.calls.filter((c) => c.bucket === "guest:cred-ip");
    expect(credCalls).toHaveLength(1);
    expect(credCalls[0]!.limit).toBe(7);
    expect(credCalls[0]!.key).toContain("203.0.113.130");
  });

  it("legend-bpvf charges credential-free requests nothing in the credential buckets", async () => {
    const rec = recordingStore();
    const app = mixedApp(
      rec.store,
      { perIp: 1000, perTenant: 1000 },
      { perIp: 1000, perTenant: 1000 },
    );
    await guestPoll(app, "203.0.113.131").expect(200);
    await guestPoll(app, "203.0.113.131", "short").expect(200);
    expect(rec.sessionKeys().size).toBe(0);
    expect(rec.keysOf("guest:cred-ip").size).toBe(0);
  });

  it("legend-bpvf still lets one table poll with its own credential up to the session limit", async () => {
    const rec = recordingStore();
    const app = mixedApp(
      rec.store,
      { perIp: 1000, perTenant: 1000 },
      { perIp: 1000, perTenant: 1000, perSession: 10 },
    );
    const ip = "203.0.113.140";
    const table = randomBearer();
    for (let poll = 0; poll < 10; poll += 1)
      expect((await guestPoll(app, ip, table)).status).toBe(200);
    // One runaway table is cut off ...
    expect((await guestPoll(app, ip, table)).status).toBe(429);
    // ... a second table behind the same NAT address is not.
    expect((await guestPoll(app, ip, randomBearer())).status).toBe(200);
    // One session key per credential, not per request.
    expect(rec.sessionKeys().size).toBe(2);
  });
});
