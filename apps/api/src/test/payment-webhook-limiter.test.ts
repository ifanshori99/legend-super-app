// The webhook failed-verification limiter is keyed by (IP, tenant), not IP
// alone (review round 2, R4). DOIT delivers every tenant's webhooks from one
// shared egress IP, so one tenant with a mismatched secret must not lock the
// others out. The service is replaced by a fake, so no database is involved.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { CoreError } from "@starter/shared/core";
import { errorHandler } from "../middleware/error-handler";
import {
  WEBHOOK_FAILED_VERIFICATIONS_PER_IP,
  createPaymentWebhookRouter,
  resetPaymentWebhookRateLimits,
} from "../routes/payment-webhook.routes";

const tenantA = randomUUID();
const tenantB = randomUUID();

// A tenant whose id is in `forged` fails verification; the rest are accepted.
const forged = new Set<string>();

function buildApp() {
  const app = express();
  app.use(
    "/api/webhooks/payments",
    createPaymentWebhookRouter({
      receive: async ({ tenantId }) => {
        if (forged.has(tenantId))
          throw new CoreError("UNAUTHORIZED", "bad signature");
        return { status: "processed", eventId: "evt_1" };
      },
    }),
  );
  app.use(errorHandler);
  return app;
}

const app = buildApp();

// supertest always connects from the loopback address: one shared IP.
function deliver(tenantId: string) {
  return request(app)
    .post(`/api/webhooks/payments/doit/${tenantId}`)
    .set("Content-Type", "application/json")
    .send("{}");
}

beforeEach(() => {
  forged.clear();
  resetPaymentWebhookRateLimits();
});

async function exhaust(tenantId: string) {
  for (
    let attempt = 0;
    attempt < WEBHOOK_FAILED_VERIFICATIONS_PER_IP + 1;
    attempt++
  )
    expect((await deliver(tenantId)).status).toBe(401);
}

describe("webhook limiter is keyed by IP and tenant", () => {
  it("a tenant that exhausts its quota is throttled itself", async () => {
    forged.add(tenantA);
    await exhaust(tenantA);
    const blocked = await deliver(tenantA);
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("another tenant on the same IP is not locked out", async () => {
    forged.add(tenantA);
    await exhaust(tenantA);
    expect((await deliver(tenantA)).status).toBe(429);
    const other = await deliver(tenantB);
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ received: true, status: "processed" });
  });

  it("another tenant's own failures still count separately", async () => {
    forged.add(tenantA);
    forged.add(tenantB);
    await exhaust(tenantA);
    // B has used none of its quota.
    expect((await deliver(tenantB)).status).toBe(401);
    expect((await deliver(tenantA)).status).toBe(429);
  });

  it("the tenant id letter case does not open a second bucket", async () => {
    forged.add(tenantA);
    await exhaust(tenantA);
    expect((await deliver(tenantA.toUpperCase())).status).toBe(429);
  });

  it("the quota resets with a fresh window", async () => {
    let now = 1_000_000;
    resetPaymentWebhookRateLimits(() => now);
    forged.add(tenantA);
    await exhaust(tenantA);
    expect((await deliver(tenantA)).status).toBe(429);
    now += 61_000;
    expect((await deliver(tenantA)).status).toBe(401);
  });
});
