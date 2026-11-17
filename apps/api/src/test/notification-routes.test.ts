import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    // legend-3z0ds: the router opts push removal/key into shared devices.
    requireAuthAllowSharedDevice: requireAuth,
    getAuth: () => ({ user: { id: "verified-user" } }),
  };
});
vi.mock("../middleware/origin.ts", () => ({
  requireTrustedOrigin: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.get("origin") !== "https://trusted.example")
      return res.status(403).end();
    next();
  },
}));
vi.mock("../middleware/tenant.ts", () => ({ getTenantContext: () => tenant }));

import { createNotificationRouter } from "../routes/notification.routes.ts";
import { errorHandler } from "../middleware/error-handler.ts";

const tenant = establishTenantContext({
  tenantId: "11111111-1111-4111-8111-111111111111",
  brandId: null,
  source: "session",
});
const context = establishScopedTenantContext(tenant, { kind: "tenant" });
const execute = vi.fn();
const allow = vi.fn();
const resolveScope = vi.fn();
function app(options = true) {
  const result = express();
  result.use(
    "/api/notifications",
    createNotificationRouter(
      options
        ? { resolveScope, authorize: allow, service: { execute } }
        : undefined,
    ),
  );
  result.use(errorHandler);
  return result;
}
const headers = { "x-test-auth": "yes", origin: "https://trusted.example" };

beforeEach(() => {
  vi.resetAllMocks();
  allow.mockResolvedValue(true);
  resolveScope.mockResolvedValue(context);
  execute.mockResolvedValue({ data: { unread: 2 } });
});
describe("notification routes (PRD §3.15, TEN-02)", () => {
  it("denies by default when no tenant role resolvers are configured", async () => {
    expect(
      (
        await request(app(false))
          .get("/api/notifications/unread-count")
          .set(headers)
      ).status,
    ).toBe(403);
  });
  it("passes only the verified user and resolved scoped context to the service", async () => {
    const response = await request(app())
      .get("/api/notifications/unread-count")
      .set(headers);
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(
      context,
      "verified-user",
      "unreadCount",
      {},
    );
    expect(response.body).toEqual({ data: { unread: 2 } });
  });
  it("rejects unexpected tenant input and does not call the service", async () => {
    const response = await request(app())
      .put("/api/notifications/preferences")
      .set(headers)
      .send({
        categories: {},
        quietHours: null,
        timeZone: "Asia/Jakarta",
        tenantId: "attacker",
      });
    expect(response.status).toBe(422);
    expect(execute).not.toHaveBeenCalled();
  });
  it("requires authentication and a trusted origin before invoking the service", async () => {
    expect(
      (await request(app()).get("/api/notifications/unread-count")).status,
    ).toBe(401);
    expect(
      (
        await request(app())
          .get("/api/notifications/unread-count")
          .set({ "x-test-auth": "yes", origin: "https://evil.example" })
      ).status,
    ).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects a trusted scope from a different tenant", async () => {
    const other = establishTenantContext({
      tenantId: "22222222-2222-4222-8222-222222222222",
      brandId: null,
      source: "session",
    });
    resolveScope.mockResolvedValue(
      establishScopedTenantContext(other, { kind: "tenant" }),
    );
    expect(
      (await request(app()).get("/api/notifications").set(headers)).status,
    ).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });
  it("denies when the resolver or permission port refuses access", async () => {
    allow.mockResolvedValue(false);
    expect(
      (await request(app()).get("/api/notifications").set(headers)).status,
    ).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });
});
