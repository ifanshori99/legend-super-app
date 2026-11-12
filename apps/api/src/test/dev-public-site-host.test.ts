// legend-uhp28: the local public-site alias is narrow, explicit and fail-closed.
import express, { type Request } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { developmentPublicSiteCredential } from "../lib/development-public-site";
import { errorHandler } from "../middleware/error-handler";
import {
  getTenantContext,
  requireTenantContext,
  tenantContext,
} from "../middleware/tenant";

const hostname = "fixture.example.test";
const tenant = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  brandId: "22222222-2222-4222-8222-222222222222",
};
const allowedPaths = [
  "/api/tenant/context",
  "/api/public/site",
  "/api/public/site/menu",
];

function req(
  overrides: {
    method?: string;
    url?: string;
    remoteAddress?: string;
    headers?: Record<string, string | string[] | undefined>;
  } = {},
): Request {
  const headers = { host: "localhost:4501", ...overrides.headers };
  return {
    method: overrides.method ?? "GET",
    originalUrl: overrides.url ?? "/api/public/site",
    socket: { remoteAddress: overrides.remoteAddress ?? "127.0.0.1" },
    headers,
    get(name: string) {
      return headers[name.toLowerCase() as keyof typeof headers];
    },
  } as unknown as Request;
}

function options(
  overrides: {
    enabled?: boolean;
    hostname?: string;
    resolved?: typeof tenant | null;
  } = {},
) {
  return {
    enabled: overrides.enabled ?? true,
    hostname: overrides.hostname ?? hostname,
    resolveDomain: vi.fn(async () =>
      overrides.resolved === undefined ? tenant : overrides.resolved,
    ),
  };
}

describe("legend-uhp28 development public-site alias", () => {
  for (const path of allowedPaths)
    it(`resolves only the explicitly configured verified domain for GET ${path}`, async () => {
      const config = options();
      const result = await developmentPublicSiteCredential(
        req({ url: `${path}?tenantId=attacker` }),
        config,
      );
      expect(result).toEqual({ ...tenant, source: "session" });
      expect(config.resolveDomain).toHaveBeenCalledExactlyOnceWith(hostname);
    });

  for (const local of [
    { host: "localhost:4501", remoteAddress: "127.0.0.1" },
    { host: "127.0.0.1:4501", remoteAddress: "::ffff:127.0.0.1" },
    { host: "[::1]:4501", remoteAddress: "::1" },
  ])
    it(`accepts loopback Host ${local.host} from a loopback socket`, async () => {
      expect(
        await developmentPublicSiteCredential(
          req({
            headers: { host: local.host },
            remoteAddress: local.remoteAddress,
          }),
          options(),
        ),
      ).toEqual({ ...tenant, source: "session" });
    });

  for (const invalid of [
    { method: "POST" },
    { method: "PATCH" },
    { method: "DELETE" },
    { method: "HEAD" },
    { url: "/api/public/site/" },
    { url: "/api/public/site/menu/extra" },
    { url: "/api/platform/tenants" },
    { url: "/api/tenant/site" },
    { url: "/api/customers" },
    { url: "/api/pos/orders" },
    { remoteAddress: "192.168.1.3" },
    { remoteAddress: "203.0.113.8" },
    { headers: { host: undefined } },
    { headers: { host: ["localhost", "attacker.test"] } },
    { headers: { host: "unknown.example.test" } },
    { headers: { host: "localhost.attacker.test" } },
    { headers: { host: "localhost:bad" } },
    { headers: { host: "localhost:70000" } },
    { headers: { host: "localhost,attacker.test" } },
    { headers: { host: "user@localhost" } },
    { headers: { "x-forwarded-host": "attacker.example.test" } },
    { headers: { "x-forwarded-host": "localhost, localhost" } },
    { headers: { "x-forwarded-host": ["localhost", "localhost"] } },
    { headers: { "x-forwarded-host": "localhost:bad" } },
    { headers: { "x-forwarded-host": "localhost:70000" } },
    { headers: { authorization: "Bearer another-tenant" } },
    { headers: { authorization: "" } },
    { headers: { [DEVICE_TOKEN_HEADER.toLowerCase()]: "" } },
    { headers: { [DEVICE_TOKEN_HEADER.toLowerCase()]: "invalid-device" } },
  ])
    it(`does not resolve ineligible request ${JSON.stringify(invalid)}`, async () => {
      const config = options();
      expect(
        await developmentPublicSiteCredential(req(invalid), config),
      ).toBeNull();
      expect(config.resolveDomain).not.toHaveBeenCalled();
    });

  it("permits one loopback forwarded host for the web SSR hop", async () => {
    expect(
      await developmentPublicSiteCredential(
        req({ headers: { "x-forwarded-host": "localhost:3501" } }),
        options(),
      ),
    ).toEqual({ ...tenant, source: "session" });
  });

  it("remains disabled without explicit configuration or outside development synthetic mode", async () => {
    const disabled = options({ enabled: false });
    expect(await developmentPublicSiteCredential(req(), disabled)).toBeNull();
    expect(disabled.resolveDomain).not.toHaveBeenCalled();
    const missing = { ...options(), hostname: undefined };
    expect(await developmentPublicSiteCredential(req(), missing)).toBeNull();
    expect(missing.resolveDomain).not.toHaveBeenCalled();
  });

  it("does not invent a tenant when the domain is unverified, missing or inactive", async () => {
    const config = options({ resolved: null });
    expect(await developmentPublicSiteCredential(req(), config)).toBeNull();
    expect(config.resolveDomain).toHaveBeenCalledExactlyOnceWith(hostname);
  });

  it("fails closed when the verified-domain lookup fails", async () => {
    const failure = new Error("database unavailable");
    await expect(
      developmentPublicSiteCredential(req(), {
        ...options(),
        resolveDomain: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });
});

describe("legend-uhp28 alias with tenant resolution middleware", () => {
  function app(enabled: boolean) {
    const server = express();
    const config = options({ enabled });
    server.use(
      tenantContext({
        required: false,
        resolveDomain: async (host) =>
          host === "real.example.test" ? { ...tenant, brandId: null } : null,
        verifyCredential: async () => null,
        fallback: (incoming) =>
          developmentPublicSiteCredential(incoming, config),
      }),
    );
    server.use(requireTenantContext);
    server.use((incoming, response) => {
      response.json(getTenantContext(incoming));
    });
    server.use(errorHandler);
    return { server, config };
  }

  it("serves the configured local public site and does not grant other API routes a tenant", async () => {
    const { server } = app(true);
    const publicSite = await request(server)
      .get("/api/public/site")
      .set("Host", "localhost:4501");
    expect(publicSite.status).toBe(200);
    expect(publicSite.body.tenantId).toBe(tenant.tenantId);
    await request(server)
      .get("/api/customers")
      .set("Host", "localhost:4501")
      .expect(404);
    await request(server)
      .post("/api/public/site")
      .set("Host", "localhost:4501")
      .expect(404);
  });

  it("keeps unknown production and nonlocal hosts at 404", async () => {
    await request(app(false).server)
      .get("/api/public/site")
      .set("Host", "localhost:4501")
      .expect(404);
    await request(app(true).server)
      .get("/api/public/site")
      .set("Host", "unknown.example.test")
      .expect(404);
  });

  it("never replaces an existing verified-domain tenant", async () => {
    const { server, config } = app(true);
    const response = await request(server)
      .get("/api/public/site")
      .set("Host", "real.example.test")
      .expect(200);
    expect(response.body.brandId).toBeNull();
    expect(response.body.source).toBe("domain");
    expect(config.resolveDomain).not.toHaveBeenCalled();
  });
});
