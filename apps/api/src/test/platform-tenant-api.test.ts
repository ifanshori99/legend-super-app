// Tenant resolution + whitelabel brand context over the real API (TEN-02,
// TEN-05, TEN-08). HTTP only: the pure host rules live in
// tests/platform-contract.test.mjs and the DB-role isolation in
// platform-org-db.test.ts.
import { randomUUID } from "node:crypto";
import express from "express";
import { Pool, type PoolClient } from "pg";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
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

/** A seeded Cafe Legend outlet: the registered devices of the seeded tenant live here. */
const seededOutletId = cafeLegendAccessFixtures.outletIds.bandung;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

/** Device ids registered in the seeded tenant; removed again in afterAll. */
const seededDeviceIds: string[] = [];

afterAll(async () => {
  if (seededDeviceIds.length > 0)
    await asTenant(tenantId, (client) =>
      client.query("DELETE FROM devices WHERE id = ANY($1::uuid[])", [
        seededDeviceIds,
      ]),
    );
  await owner.end();
});

/** Migration owner with the tenant settings (RLS is forced on tenant tables). */
async function asTenant<T>(
  forTenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [forTenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

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
  // A registered device needs an outlet of its own tenant (devices FK).
  const pairOutletId = randomUUID();
  await asTenant(pairTenantId, async (client) => {
    const entityId = randomUUID();
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
      [entityId, pairTenantId],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'U-01', 'Outlet Uji', 'Jl. Uji', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [pairOutletId, pairTenantId, pairBrandId, entityId],
    );
  });
  return {
    tenantId: pairTenantId,
    brandId: pairBrandId,
    outletId: pairOutletId,
    domainId,
    hostname,
  };
}

async function dropTenantPair(pair: { tenantId: string; domainId: string }) {
  await asTenant(pair.tenantId, async (client) => {
    await client.query("DELETE FROM devices WHERE tenant_id = $1", [
      pair.tenantId,
    ]);
    await client.query("DELETE FROM outlets WHERE tenant_id = $1", [
      pair.tenantId,
    ]);
    await client.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
      pair.tenantId,
    ]);
  });
  await owner.query("DELETE FROM tenant_domains WHERE id = $1", [
    pair.domainId,
  ]);
  await owner.query("DELETE FROM brands WHERE tenant_id = $1", [pair.tenantId]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [pair.tenantId]);
}

/**
 * A token for a device that is in the registry (F5, legend-165): a device row
 * of the tenant, active, with `token_issued_at` at or before the token's
 * `issuedAt`. `registry` bends the row; `token` bends the signed payload.
 */
async function registeredDeviceToken(
  options: {
    tenantId?: string;
    brandId?: string | null;
    outletId?: string;
    /** Seconds the token is issued before now (default 0). */
    issuedAgoSeconds?: number;
    /** Seconds the registry floor is in the future of the token (rotation). */
    floorAfterTokenSeconds?: number;
    revoked?: boolean;
    expiresAt?: number;
  } = {},
) {
  const forTenantId = options.tenantId ?? tenantId;
  const deviceId = randomUUID();
  const issuedAt =
    Math.floor(Date.now() / 1000) - (options.issuedAgoSeconds ?? 0);
  const floor = issuedAt + (options.floorAfterTokenSeconds ?? 0);
  await asTenant(forTenantId, async (client) => {
    await client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', 'Kasir uji', $4)`,
      [
        deviceId,
        forTenantId,
        options.outletId ?? seededOutletId,
        new Date(floor * 1000),
      ],
    );
    if (options.revoked)
      await client.query(
        `UPDATE devices SET status = 'revoked', revoked_at = now(), revoked_by = 'uji', revoke_reason = 'Hilang' WHERE id = $1`,
        [deviceId],
      );
  });
  if (forTenantId === tenantId) seededDeviceIds.push(deviceId);
  return {
    deviceId,
    token: signDeviceToken(
      {
        version: 1,
        tenantId: forTenantId as never,
        brandId: (options.brandId === undefined
          ? brandId
          : options.brandId) as never,
        deviceId,
        issuedAt,
      },
      options.expiresAt,
    ),
  };
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
      .set(DEVICE_TOKEN_HEADER, (await registeredDeviceToken()).token);
    expect(response.status).toBe(200);
    expect(response.body.data.brand.id).toBe(brandId);
  });

  it("TEN-02 refuses an expired or tampered device token", async () => {
    const expired = (
      await registeredDeviceToken({
        expiresAt: Math.floor(Date.now() / 1000) - 60,
      })
    ).token;
    const tampered = `${(await registeredDeviceToken()).token.slice(0, -2)}xx`;
    for (const token of [expired, tampered, "dv1.bogus.signature"]) {
      const response = await request(app)
        .get("/api/tenant/context")
        .set("Host", "localhost")
        .set(DEVICE_TOKEN_HEADER, token);
      expect(response.status, token).toBe(404);
      expect(response.body.error.code).toBe("TENANT_NOT_FOUND");
    }
  });

  it("F5 EDG-03 refuses a validly signed token whose device is unknown, revoked or rotated out", async () => {
    // Signed by the server key but never enrolled: no registry row.
    const unknown = signDeviceToken({
      version: 1,
      tenantId,
      brandId,
      deviceId: randomUUID(),
      issuedAt: Math.floor(Date.now() / 1000),
    });
    const revoked = (await registeredDeviceToken({ revoked: true })).token;
    // The registry floor is newer than the token: a reissue replaced it.
    const rotated = (
      await registeredDeviceToken({
        issuedAgoSeconds: 60,
        floorAfterTokenSeconds: 30,
      })
    ).token;
    for (const token of [unknown, revoked, rotated]) {
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
          (
            await registeredDeviceToken({
              tenantId: other.tenantId,
              brandId: other.brandId,
              outletId: other.outletId,
            })
          ).token,
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
          (
            await registeredDeviceToken({
              tenantId: other.tenantId,
              brandId: other.brandId,
              outletId: other.outletId,
            })
          ).token,
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
