// Legacy rows: before security email became mandatory (PRD §3.15 Preferensi;
// shared isEmailMandatory("security") === true), a user could have saved
// security.email=false. Such a stored row must never reach the user as "off":
//  - GET /api/notifications/preferences reports security.email=true;
//  - a PUT that only changes quiet hours (no security category) succeeds, so a
//    legacy user is not locked out of saving anything else;
//  - a PUT that itself sends security.email=false is still refused with 422;
//  - other categories keep their stored email=false untouched.
//
// Assumptions: the legacy row is inserted straight into notification_preferences
// with the owner connection (the API would refuse to write it now). "PUT only
// quiet hours" is a body with `categories: {}` (the field is required by the
// shared input schema) plus a new quietHours. Auth, origin and scope are
// stubbed as in notification-security-email-mandatory.test.ts.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";

const userId = "00000000-0000-4000-8000-0000000000a1";

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
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
});
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
const legacyCategories = {
  security: channels(false),
  order_ready: channels(false),
};
const put = (payload: Record<string, unknown>) =>
  request(app)
    .put("/api/notifications/preferences")
    .set(headers)
    .send({ timeZone: "Asia/Jakarta", ...payload });
const get = () =>
  request(app).get("/api/notifications/preferences").set(headers);

async function seedLegacyRow() {
  await owner.query(
    `DELETE FROM notification_preferences WHERE tenant_id = $1 AND user_id = $2`,
    [tenant.tenantId, userId],
  );
  await owner.query(
    `INSERT INTO notification_preferences (tenant_id, user_id, categories, quiet_hours, time_zone)
     VALUES ($1, $2, $3::jsonb, NULL, 'Asia/Jakarta')`,
    [tenant.tenantId, userId, JSON.stringify(legacyCategories)],
  );
}

beforeAll(seedLegacyRow);
afterAll(async () => {
  await owner.query(
    `DELETE FROM notification_preferences WHERE tenant_id = $1 AND user_id = $2`,
    [tenant.tenantId, userId],
  );
  await owner.end();
  await pool.end();
});

describe("legacy security.email=false rows", () => {
  it("GET reports security email as on even though the stored row says off", async () => {
    await seedLegacyRow();
    const response = await get();
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.categories.security.email).toBe(true);
  });

  it("GET leaves other categories' stored email=false as they are", async () => {
    await seedLegacyRow();
    const response = await get();
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.categories.order_ready.email).toBe(false);
  });

  it("lets a legacy user save only quiet hours (no security category) with 200", async () => {
    await seedLegacyRow();
    const response = await put({
      categories: {},
      quietHours: { start: "22:00", end: "06:00" },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.quietHours).toEqual({
      start: "22:00",
      end: "06:00",
    });
    expect(response.body.data.categories.security?.email ?? true).toBe(true);
    const after = await get();
    expect(after.body.data.quietHours).toEqual({
      start: "22:00",
      end: "06:00",
    });
    // PUT replaces the categories map, so security may now be absent (the
    // catalog default applies); it must never read back as off.
    expect(after.body.data.categories.security?.email ?? true).toBe(true);
  });

  it("still refuses a PUT that itself sends security.email=false with 422", async () => {
    await seedLegacyRow();
    const response = await put({
      categories: { security: channels(false) },
      quietHours: null,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error.message).toMatch(/email/i);
  });
});
