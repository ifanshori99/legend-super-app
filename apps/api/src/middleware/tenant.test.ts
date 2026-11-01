import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { isTrustedTenantContext } from "@starter/shared/core";
import { errorHandler } from "./error-handler";
import {
  developmentTenantContext,
  getTenantContext,
  requireTenantContext,
  tenantContext,
} from "./tenant";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const domainTenant = { tenantId: tenantA, brandId: null };

function app() {
  const app = express();
  app.use(
    tenantContext({
      resolveDomain: async (host) =>
        host === "a.example.com" ? domainTenant : null,
      verifyCredential: async (req) =>
        req.get("authorization") === "Bearer verified"
          ? { tenantId: tenantB, brandId: null, source: "device" as const }
          : null,
    }),
  );
  app.get("/", (req, res) => {
    const tenant = getTenantContext(req);
    res.json({
      tenantId: tenant.tenantId,
      source: tenant.source,
      trusted: isTrustedTenantContext(tenant),
    });
  });
  app.use(errorHandler);
  return app;
}

describe("TEN-02 tenant resolution", () => {
  it("mints the context from the registered domain and ignores tenant headers", async () => {
    const response = await request(app())
      .get("/")
      .set("Host", "a.example.com")
      .set("X-Tenant-Id", tenantB);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      tenantId: tenantA,
      source: "domain",
      trusted: true,
    });
  });
  it("uses a verified credential on an unregistered host", async () => {
    const response = await request(app())
      .get("/")
      .set("Host", "api.example.com")
      .set("Authorization", "Bearer verified");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      tenantId: tenantB,
      source: "device",
      trusted: true,
    });
  });
  it("fails closed when neither domain nor credential resolves", async () => {
    const response = await request(app())
      .get("/?tenantId=" + tenantA)
      .set("Host", "unknown.example.com")
      .set("X-Tenant-Id", tenantA);
    expect(response.status).toBe(404);
  });
  it("rejects a credential belonging to a different registered domain", async () => {
    const response = await request(app())
      .get("/")
      .set("Host", "a.example.com")
      .set("Authorization", "Bearer verified");
    expect(response.status).toBe(403);
  });
  it("preserves a brand pinned by the verified credential on a tenant-wide domain", async () => {
    const brandId = "33333333-3333-4333-8333-333333333333";
    const scoped = express();
    scoped.use(
      tenantContext({
        resolveDomain: async () => domainTenant,
        verifyCredential: async () => ({
          tenantId: tenantA,
          brandId,
          source: "session",
        }),
      }),
    );
    scoped.get("/", (req, res) =>
      res.json({ brandId: getTenantContext(req).brandId }),
    );
    const response = await request(scoped).get("/");
    expect(response.body.brandId).toBe(brandId);
  });
  it("does not trust a forwarded host without Express proxy trust", async () => {
    const response = await request(app())
      .get("/")
      .set("Host", "unknown.example.com")
      .set("X-Forwarded-Host", "a.example.com");
    expect(response.status).toBe(404);
  });
  it("mounts globally without a tenant and lets routes demand one", async () => {
    const server = express();
    server.use(
      tenantContext({
        required: false,
        resolveDomain: async () => null,
        verifyCredential: async () => null,
      }),
    );
    server.get("/global", (_req, res) => res.sendStatus(200));
    server.get("/tenant", requireTenantContext, (_req, res) =>
      res.sendStatus(200),
    );
    server.use(errorHandler);
    expect((await request(server).get("/global")).status).toBe(200);
    expect((await request(server).get("/tenant")).status).toBe(404);
  });
  it("runs the development fallback only when no real source resolved", async () => {
    let fallbackCalls = 0;
    const server = express();
    server.use(
      tenantContext({
        resolveDomain: async (host) =>
          host === "a.example.com" ? domainTenant : null,
        verifyCredential: async () => null,
        fallback: async () => {
          fallbackCalls += 1;
          return { tenantId: tenantB, brandId: null, source: "session" };
        },
      }),
    );
    server.get("/", (req, res) =>
      res.json({ tenantId: getTenantContext(req).tenantId }),
    );
    expect(
      (await request(server).get("/").set("Host", "a.example.com")).body
        .tenantId,
    ).toBe(tenantA);
    expect(fallbackCalls).toBe(0);
    expect(
      (await request(server).get("/").set("Host", "unknown.example.com")).body
        .tenantId,
    ).toBe(tenantB);
    expect(fallbackCalls).toBe(1);
  });
});

describe("development session tenant resolver", () => {
  it("mints the lookup tenant only for a verified session", async () => {
    const server = express();
    server.use(
      developmentTenantContext({
        enabled: true,
        hasSession: async (req) => req.get("Authorization") === "verified",
        lookup: async () => domainTenant,
      }),
    );
    server.get("/", (req, res) => {
      const tenant = getTenantContext(req);
      res.json({ tenantId: tenant.tenantId, source: tenant.source });
    });
    server.use(errorHandler);
    expect(
      (await request(server).get("/").set("Authorization", "verified")).body,
    ).toEqual({ tenantId: tenantA, source: "session" });
    expect(
      (await request(server).get("/").set("X-Tenant-Id", tenantA)).status,
    ).toBe(500);
  });
  it("never resolves development tenants when disabled", async () => {
    let lookupCalled = false;
    const server = express();
    server.use(
      developmentTenantContext({
        enabled: false,
        hasSession: async () => true,
        lookup: async () => {
          lookupCalled = true;
          return domainTenant;
        },
      }),
    );
    server.get("/", (req, res) =>
      res.json({ trusted: isTrustedTenantContext(getTenantContext(req)) }),
    );
    server.use(errorHandler);
    expect((await request(server).get("/")).status).toBe(500);
    expect(lookupCalled).toBe(false);
  });
  it("rejects authenticated sessions when the lookup has no tenant", async () => {
    const server = express();
    server.use(
      developmentTenantContext({
        enabled: true,
        hasSession: async () => true,
        lookup: async () => null,
      }),
    );
    server.get("/", (_req, res) => res.sendStatus(200));
    server.use(errorHandler);
    expect((await request(server).get("/")).status).toBe(404);
  });
});
