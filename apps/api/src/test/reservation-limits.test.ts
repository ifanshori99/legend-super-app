// Public booking write limits (bead legend-t8bz): the booking POST has its own
// per-IP / per-tenant budget and a cap per guest contact, apart from the read
// limiter. The probe app mounts the real limiter middleware, tenant resolver,
// body parser and error handler without a database, with a controlled clock.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { jsonBody } from "../middleware/body";
import { errorHandler, notFound } from "../middleware/error-handler";
import {
  createPublicBookingLimits,
  publicRateLimit,
  type PublicWriteRateLimitOptions,
} from "../middleware/public-rate-limit";
import { tenantContext } from "../middleware/tenant";

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const HOST_A = "tenant-a.example.test";
const HOST_B = "tenant-b.example.test";
const OUTLET = randomUUID();

function probeApp(options: Partial<PublicWriteRateLimitOptions>) {
  const app = express();
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
  const limits = createPublicBookingLimits({
    perIp: 1000,
    perTenant: 1000,
    perContact: 1000,
    ...options,
  });
  const router = express.Router();
  router.get("/public/outlets/:outletId/reservation-availability", (_q, r) => {
    r.json({ data: { ok: true } });
  });
  router.post(
    "/public/outlets/:outletId/reservations",
    limits.perRequest,
    jsonBody,
    limits.perContact,
    (_q, r) => {
      r.status(201).json({ data: { ok: true } });
    },
  );
  // Same stack as app.ts: the read limiter sits in front of the whole prefix.
  app.use(
    "/api/public/outlets",
    publicRateLimit({ perIp: 1000, perTenant: 1000 }),
  );
  app.use("/api", router);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

function book(
  app: express.Express,
  ip: string,
  phone = "081234567890",
  host = HOST_A,
  key = `rsv-${randomUUID()}`,
) {
  return request(app)
    .post(`/api/public/outlets/${OUTLET}/reservations`)
    .set("Host", host)
    .set("X-Forwarded-For", ip)
    .set("Idempotency-Key", key)
    .send({ contactPhone: phone });
}

function availability(app: express.Express, ip: string) {
  return request(app)
    .get(`/api/public/outlets/${OUTLET}/reservation-availability`)
    .set("Host", HOST_A)
    .set("X-Forwarded-For", ip);
}

describe("public booking write limits (legend-t8bz)", () => {
  it("legend-t8bz the booking POST trips at N+1 per IP while availability reads still pass", async () => {
    const app = probeApp({ perIp: 2 });
    const ip = "203.0.113.10";
    expect((await book(app, ip, "081111111111")).status).toBe(201);
    expect((await book(app, ip, "082222222222")).status).toBe(201);
    const limited = await book(app, ip, "083333333333");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect((await availability(app, ip)).status).toBe(200);
    expect((await book(app, "203.0.113.11", "084444444444")).status).toBe(201);
  });

  it("legend-t8bz the per-tenant write budget is shared across IPs and isolated per tenant", async () => {
    const app = probeApp({ perTenant: 2 });
    expect((await book(app, "198.51.100.1", "081111111111")).status).toBe(201);
    expect((await book(app, "198.51.100.2", "082222222222")).status).toBe(201);
    expect((await book(app, "198.51.100.3", "083333333333")).status).toBe(429);
    const other = await book(app, "198.51.100.4", "084444444444", HOST_B);
    expect(other.status).toBe(201);
  });

  it("legend-t8bz the per-contact cap trips for one number across IPs but not for another", async () => {
    const app = probeApp({ perContact: 2 });
    expect((await book(app, "192.0.2.1")).status).toBe(201);
    // Another format of the same number is the same contact.
    expect((await book(app, "192.0.2.2", "+62 812-3456-7890")).status).toBe(
      201,
    );
    const limited = await book(app, "192.0.2.3");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    expect(limited.headers["retry-after"]).toBeDefined();
    expect((await book(app, "192.0.2.3", "085555555555")).status).toBe(201);
  });

  it("legend-t8bz the contact cap is isolated per tenant and recovers after its window", async () => {
    let now = 1_000_000;
    const app = probeApp({ perContact: 1, now: () => now });
    expect((await book(app, "192.0.2.1")).status).toBe(201);
    expect((await book(app, "192.0.2.1")).status).toBe(429);
    expect((await book(app, "192.0.2.1", "081234567890", HOST_B)).status).toBe(
      201,
    );
    now += 60 * 60_000;
    expect((await book(app, "192.0.2.1")).status).toBe(201);
  });

  it("legend-t8bz an Idempotency-Key replay does not burn the contact cap twice", async () => {
    const app = probeApp({ perContact: 1 });
    const key = `rsv-${randomUUID()}`;
    expect((await book(app, "192.0.2.1", undefined, HOST_A, key)).status).toBe(
      201,
    );
    expect((await book(app, "192.0.2.1", undefined, HOST_A, key)).status).toBe(
      201,
    );
    expect((await book(app, "192.0.2.1")).status).toBe(429);
  });

  it("legend-t8bz an invalid phone skips the contact bucket and is left to the contract", async () => {
    const app = probeApp({ perContact: 1 });
    expect((await book(app, "192.0.2.1", "not-a-number")).status).toBe(201);
    expect((await book(app, "192.0.2.1", "not-a-number")).status).toBe(201);
  });
});
