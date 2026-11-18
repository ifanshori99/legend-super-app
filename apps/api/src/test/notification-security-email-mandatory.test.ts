// legend-6vnbh: security email cannot be switched off (PRD §3.15 Preferensi;
// shared isEmailMandatory("security") === true, legend-307w3). The user's own
// preference PUT /api/notifications/preferences must refuse a body that turns
// the security category's email off: 422 with a clear message, nothing saved.
// Other categories (and the other security channels) keep their normal opt-outs.
//
// Assumptions: the refusal is a 422 envelope { error: { code, message } } and
// the message names "email" (language not fixed by the contract). Real service
// and PostgreSQL behind the real notification router; auth, origin and scope
// are stubbed as in notification-routes.test.ts.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";

vi.mock("../middleware/auth.ts", () => {
  const requireAuth = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (!req.get("x-test-auth")) return res.status(401).end();
    next();
  };
  return {
    requireAuth,
    // 1012: the notification router opts some operations in to shared devices.
    requireAuthAllowSharedDevice: requireAuth,
    getAuth: () => ({ user: { id: "00000000-0000-4000-8000-0000000000a1" } }),
  };
});
vi.mock("../middleware/origin.ts", () => ({
  requireTrustedOrigin: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));
vi.mock("../middleware/tenant.ts", () => ({ getTenantContext: () => tenant }));

import * as schema from "../db/schema/index.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { createNotificationRouter } from "../routes/notification.routes.ts";
import { createNotificationService } from "../services/notification-center.ts";

const tenant = establishTenantContext({
  tenantId: randomUUID(),
  brandId: null,
  source: "session",
});
const scoped = establishScopedTenantContext(tenant, { kind: "tenant" });
const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(pool, { schema });
const service = createNotificationService(database, async () => true);

const app = express();
app.use(express.json());
app.use(
  "/api/notifications",
  createNotificationRouter({
    resolveScope: async () => scoped,
    authorize: async () => true,
    service,
  }),
);
app.use(errorHandler);

const headers = { "x-test-auth": "yes", origin: "https://trusted.example" };
const channels = (email: boolean, webPush = true) => ({
  web_push: webPush,
  email,
  whatsapp: false,
});
const body = (categories: Record<string, unknown>) => ({
  categories,
  quietHours: null,
  timeZone: "Asia/Jakarta",
});
const put = (categories: Record<string, unknown>) =>
  request(app)
    .put("/api/notifications/preferences")
    .set(headers)
    .send(body(categories));
const saved = async () =>
  (await request(app).get("/api/notifications/preferences").set(headers)).body
    .data.categories as Record<string, { email: boolean }>;

afterAll(async () => pool.end());

describe("legend-6vnbh security email is mandatory", () => {
  it("lets a non-mandatory category switch its email off", async () => {
    const response = await put({ order_ready: channels(false) });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await saved()).order_ready.email).toBe(false);
  });

  it("refuses to switch the security email off with a clear 422", async () => {
    const response = await put({ security: channels(false) });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error.message).toMatch(/email/i);
  });

  it("refuses the whole request, saving nothing, when security email is off next to a valid change", async () => {
    const response = await put({
      order_ready: channels(false),
      security: channels(false),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    const after = await saved();
    expect(after.security?.email ?? true).toBe(true);
  });

  it("accepts security with email on and still lets the other channels opt out", async () => {
    const response = await put({ security: channels(true, false) });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await saved()).security.email).toBe(true);
  });
});
