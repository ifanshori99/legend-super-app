// Tenant resolution + whitelabel brand context over the real API (TEN-02,
// TEN-05, TEN-08). HTTP only: the pure host rules live in
// tests/platform-contract.test.mjs and the DB-role isolation in
// platform-org-db.test.ts.
import { randomUUID } from "node:crypto";
import express from "express";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEVICE_TOKEN_HEADER,
  cafeLegendPlatformFixtures,
} from "@starter/shared/platform";
import { createApp } from "../app";
import { signDeviceToken } from "../lib/device-token";
import { errorHandler } from "../middleware/error-handler";
import { tlsAskGuard } from "../middleware/tls-ask";

const app = createApp();
const fixtures = cafeLegendPlatformFixtures;
const tenantId = fixtures.tenant.id;
const brandId = fixtures.brand.id;
/** Verified custom domain of the seeded Cafe Legend tenant. */
const VERIFIED_HOST = "pesan.cafelegend.example";
/** Seeded custom domain whose DNS ownership check has not passed. */
const UNVERIFIED_HOST = "wfc.cafelegend.example";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

afterAll(async () => {
  await owner.end();
});

function slug(prefix: string) {
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

async function createTenantPair(
  status: "active" | "suspended",
  label: string,
  kind: "custom" | "platform_subdomain" = "custom",
) {
  const pairTenantId = randomUUID();
  const pairBrandId = randomUUID();
  const domainId = randomUUID();
  const hostname =
    kind === "platform_subdomain"
      ? `${slug(label)}.platform.example`
      : `${slug(label)}.contoh.example`;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', $4, 'shared', '{"modules":[],"integrationProviders":[]}', $5, $6)`,
    [
      pairTenantId,
      slug(`uji-${label}`),
      `Tenant ${label}`,
      status,
      JSON.stringify(fixtures.packages[0].defaultLimits),
      randomUUID(),
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)`,
    [pairBrandId, pairTenantId, slug(`brand-${label}`), `Brand ${label}`],
  );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, $5, 'active', now())`,
    [domainId, pairTenantId, pairBrandId, hostname, kind],
  );
  return { tenantId: pairTenantId, brandId: pairBrandId, domainId, hostname };
}

async function dropTenantPair(pair: { tenantId: string; domainId: string }) {
  await owner.query("DELETE FROM tenant_domains WHERE id = $1", [
    pair.domainId,
  ]);
  await owner.query("DELETE FROM brands WHERE tenant_id = $1", [pair.tenantId]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [pair.tenantId]);
}

function deviceToken(
  overrides: Partial<Parameters<typeof signDeviceToken>[0]> = {},
  expiresAt?: number,
) {
  return signDeviceToken(
    {
      version: 1,
      tenantId,
      brandId,
      deviceId: randomUUID(),
      ...overrides,
    },
    expiresAt,
  );
}

describe("TEN-02 tenant resolution from the request host or a device token", () => {
  it("TEN-02 resolves tenant and brand from a verified custom domain", async () => {
    const response = await request(app)
      .get("/api/tenant/context")
      .set("Host", VERIFIED_HOST);
    expect(response.status).toBe(200);
    expect(response.body.data.brand).toEqual({
      id: brandId,
      slug: fixtures.brand.slug,
      name: fixtures.brand.name,
      logoMediaId: fixtures.brand.logoMediaId,
    });
    expect(response.body.data.theme.fontFamily).toBe(
      fixtures.themes[0].fontFamily,
    );
    expect(response.body.data.theme.corners).toBe(fixtures.themes[0].corners);
  });

  it("TEN-02 resolves a verified platform subdomain like a custom domain", async () => {
    const other = await createTenantPair("active", "sub", "platform_subdomain");
    try {
      const response = await request(app)
        .get("/api/tenant/context")
        .set("Host", other.hostname);
      expect(response.status).toBe(200);
      expect(response.body.data.brand.id).toBe(other.brandId);
    } finally {
      await dropTenantPair(other);
    }
  });

  it("TEN-02 ignores tenant parameters and headers sent by the client", async () => {
    const other = await createTenantPair("suspended", "klien");
    try {
      const response = await request(app)
        .get(`/api/tenant/context?tenantId=${other.tenantId}`)
        .set("Host", VERIFIED_HOST)
        .set("X-Tenant-Id", other.tenantId);
      expect(response.status).toBe(200);
      expect(response.body.data.brand.id).toBe(brandId);
    } finally {
      await dropTenantPair(other);
    }
  });

  it("TEN-02 fails closed for unverified, unknown and local hosts", async () => {
    for (const host of [
      UNVERIFIED_HOST,
      "tidak-ada.contoh.example",
      "localhost",
      "127.0.0.1",
    ]) {
      const response = await request(app)
        .get("/api/tenant/context")
        .set("Host", host);
      expect(response.status, host).toBe(404);
      expect(response.body.error.code).toBe("TENANT_NOT_FOUND");
    }
  });

  it("TEN-02 resolves tenant and brand from a signed device token", async () => {
    const response = await request(app)
      .get("/api/tenant/context")
      .set("Host", "localhost")
      .set(DEVICE_TOKEN_HEADER, deviceToken());
    expect(response.status).toBe(200);
    expect(response.body.data.brand.id).toBe(brandId);
  });

  it("TEN-02 refuses an expired or tampered device token", async () => {
    const expired = deviceToken({}, Math.floor(Date.now() / 1000) - 60);
    const tampered = `${deviceToken().slice(0, -2)}xx`;
    for (const token of [expired, tampered, "dv1.bogus.signature"]) {
      const response = await request(app)
        .get("/api/tenant/context")
        .set("Host", "localhost")
        .set(DEVICE_TOKEN_HEADER, token);
      expect(response.status, token).toBe(404);
      expect(response.body.error.code).toBe("TENANT_NOT_FOUND");
    }
  });

  it("TEN-02 rejects a token whose tenant differs from the domain tenant", async () => {
    const other = await createTenantPair("active", "lain");
    try {
      const response = await request(app)
        .get("/api/tenant/context")
        .set("Host", VERIFIED_HOST)
        .set(
          DEVICE_TOKEN_HEADER,
          deviceToken({ tenantId: other.tenantId, brandId: other.brandId }),
        );
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("TENANT_MISMATCH");
    } finally {
      await dropTenantPair(other);
    }
  });

  it("TEN-02 refuses a verified domain and token of a suspended tenant", async () => {
    const other = await createTenantPair("suspended", "tangguh");
    try {
      const response = await request(app)
        .get("/api/tenant/context")
        .set("Host", other.hostname);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("TENANT_NOT_FOUND");

      const tokenResponse = await request(app)
        .get("/api/tenant/context")
        .set("Host", "localhost")
        .set(
          DEVICE_TOKEN_HEADER,
          deviceToken({ tenantId: other.tenantId, brandId: other.brandId }),
        );
      expect(tokenResponse.status).toBe(404);
    } finally {
      await dropTenantPair(other);
    }
  });
});

describe("TEN-05/TEN-08 whitelabel brand context", () => {
  it("TEN-05 exposes exactly the modules the API gate would allow", async () => {
    const original = await owner.query<{ feature_flags: unknown }>(
      "SELECT feature_flags FROM tenants WHERE id = $1",
      [tenantId],
    );
    try {
      await owner.query(
        `UPDATE tenants SET feature_flags = '{"modules":["qr_order"],"integrationProviders":[]}' WHERE id = $1`,
        [tenantId],
      );
      const response = await request(app)
        .get("/api/tenant/context")
        .set("Host", VERIFIED_HOST);
      expect(response.status).toBe(200);
      expect(response.body.data.enabledModules).toEqual(["qr_order"]);

      // Malformed flags are "everything off", never a partial grant.
      await owner.query(
        `UPDATE tenants SET feature_flags = '{"modules":"pos"}' WHERE id = $1`,
        [tenantId],
      );
      const malformed = await request(app)
        .get("/api/tenant/context")
        .set("Host", VERIFIED_HOST);
      expect(malformed.status).toBe(200);
      expect(malformed.body.data.enabledModules).toEqual([]);
    } finally {
      await owner.query("UPDATE tenants SET feature_flags = $1 WHERE id = $2", [
        original.rows[0].feature_flags,
        tenantId,
      ]);
    }
  });

  it("TEN-08 returns no platform name, logo or link", async () => {
    const response = await request(app)
      .get("/api/tenant/context")
      .set("Host", VERIFIED_HOST);
    expect(response.status).toBe(200);
    expect(Object.keys(response.body.data).sort()).toEqual([
      "brand",
      "enabledModules",
      "theme",
    ]);
    expect(JSON.stringify(response.body).toLowerCase()).not.toContain(
      "platform",
    );
  });
});

describe("Caddy on-demand TLS ask", () => {
  it("TEN-02 issues only for verified domains of an active tenant", async () => {
    const allowed = await request(app)
      .get("/api/internal/tls/ask")
      .query({ domain: VERIFIED_HOST });
    expect(allowed.status).toBe(200);
    expect(allowed.text).toBe("");

    for (const domain of [UNVERIFIED_HOST, "tidak-ada.contoh.example"]) {
      const denied = await request(app)
        .get("/api/internal/tls/ask")
        .query({ domain });
      expect(denied.status, domain).toBe(404);
    }

    const invalid = await request(app)
      .get("/api/internal/tls/ask")
      .query({ domain: "127.0.0.1" });
    expect(invalid.status).toBe(422);
  });

  it("TEN-02 requires the shared ask token when one is configured", async () => {
    const probe = express();
    probe.get("/ask", tlsAskGuard("ask-secret-for-tests"), (_req, res) =>
      res.status(200).end(),
    );
    probe.use(errorHandler);

    expect((await request(probe).get("/ask")).status).toBe(403);
    expect(
      (await request(probe).get("/ask").set("X-Tls-Ask-Token", "salah")).status,
    ).toBe(403);
    expect(
      (
        await request(probe)
          .get("/ask")
          .set("X-Tls-Ask-Token", "ask-secret-for-tests")
      ).status,
    ).toBe(200);

    // Local development: no configured secret means the host check alone runs.
    const open = express();
    open.get("/ask", tlsAskGuard(undefined, false), (_req, res) =>
      res.status(200).end(),
    );
    expect((await request(open).get("/ask")).status).toBe(200);

    // Production without the secret fails closed instead of answering anyone.
    const unconfigured = express();
    unconfigured.get("/ask", tlsAskGuard(undefined, true), (_req, res) =>
      res.status(200).end(),
    );
    unconfigured.use(errorHandler);
    expect((await request(unconfigured).get("/ask")).status).toBe(403);
  });
});
