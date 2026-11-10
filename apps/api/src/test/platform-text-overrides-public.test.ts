// Public tenant text overrides (legend-it6p4): `GET /api/tenant/text-overrides`
// answers without a session, for the tenant of the request host only, and only
// for the `terms.*` dictionary keys. Any other override stays behind the
// authenticated /api/org/text-overrides surface.
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import {
  isPublicOverrideKey,
  textOverrideInputSchema,
} from "@starter/shared/text";
import { createApp } from "../app";
import { PUBLIC_RATE_LIMIT_PATHS } from "../middleware/public-rate-limit";
import { putTextOverride } from "../services/text-override.service";
import {
  createTestTenant,
  owner,
  removeTestTenant,
  type TestTenant,
} from "./platform-theme-helpers";

const app = createApp();
const PATH = "/api/tenant/text-overrides";

type Seeded = { tenant: TestTenant; domainId: string; hostname: string };
let a: Seeded;
let b: Seeded;

async function seedTenant(label: string): Promise<Seeded> {
  const tenant = await createTestTenant(label);
  const domainId = randomUUID();
  const hostname = `${label}-${domainId.slice(0, 8)}.contoh.example`;
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'custom', 'active', now())`,
    [domainId, tenant.tenantId, tenant.brandId, hostname],
  );
  return { tenant, domainId, hostname };
}

const put = (
  s: Seeded,
  key: string,
  value: string,
  locale: "id" | "en" = "id",
) =>
  putTextOverride(
    s.tenant.context,
    textOverrideInputSchema.parse({ locale, key, value }),
    s.tenant.actorId,
  );

beforeAll(async () => {
  a = await seedTenant("pub-a");
  b = await seedTenant("pub-b");
  await put(a, "terms.table", "Meja Kami");
  await put(a, "terms.wfcZone", "Ruang Kerja", "en");
  // Admin keys carry overrides too; they must never be served publicly.
  await put(a, "hris.home.greeting", "Rahasia admin {name}");
  await put(b, "terms.table", "Lapak B");
});

afterAll(async () => {
  for (const s of [a, b]) {
    await owner.query("DELETE FROM tenant_domains WHERE id = $1", [s.domainId]);
    await removeTestTenant(s.tenant);
  }
  await owner.end();
});

describe("legend-it6p4 public text overrides", () => {
  it("serves terms.* overrides of the host tenant with no session", async () => {
    const response = await request(app).get(PATH).set("Host", a.hostname);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual({
      data: {
        id: { "terms.table": "Meja Kami" },
        en: { "terms.wfcZone": "Ruang Kerja" },
      },
    });
  });

  it("never returns a key outside the terms allowlist", async () => {
    const response = await request(app).get(PATH).set("Host", a.hostname);
    expect(JSON.stringify(response.body)).not.toContain("hris.home.greeting");
    expect(JSON.stringify(response.body)).not.toContain("Rahasia admin");
    for (const locale of ["id", "en"] as const)
      for (const key of Object.keys(response.body.data[locale]))
        expect(isPublicOverrideKey(key), key).toBe(true);
  });

  it("returns no ids, versions, tenant or author fields", async () => {
    const response = await request(app).get(PATH).set("Host", a.hostname);
    const text = JSON.stringify(response.body);
    for (const leaked of [
      a.tenant.tenantId,
      a.tenant.actorId,
      "tenantId",
      "updatedBy",
      "version",
      "updatedAt",
    ])
      expect(text).not.toContain(leaked);
    expect(Object.keys(response.body)).toEqual(["data"]);
    expect(Object.keys(response.body.data).sort()).toEqual(["en", "id"]);
  });

  it("keeps tenants apart: each host sees only its own overrides", async () => {
    const forB = await request(app).get(PATH).set("Host", b.hostname);
    expect(forB.status).toBe(200);
    expect(forB.body.data).toEqual({
      id: { "terms.table": "Lapak B" },
      en: {},
    });
    const forA = await request(app).get(PATH).set("Host", a.hostname);
    expect(JSON.stringify(forA.body)).not.toContain("Lapak B");
  });

  it("ignores a tenant id sent by the client", async () => {
    const response = await request(app)
      .get(`${PATH}?tenantId=${b.tenant.tenantId}`)
      .set("Host", a.hostname)
      .set("X-Tenant-Id", b.tenant.tenantId);
    expect(response.status).toBe(200);
    expect(response.body.data.id).toEqual({ "terms.table": "Meja Kami" });
  });

  it("answers an empty map for a tenant without overrides", async () => {
    const c = await seedTenant("pub-c");
    try {
      const response = await request(app).get(PATH).set("Host", c.hostname);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: { id: {}, en: {} } });
    } finally {
      await owner.query("DELETE FROM tenant_domains WHERE id = $1", [
        c.domainId,
      ]);
      await removeTestTenant(c.tenant);
    }
  });

  it("fails closed on an unknown host, like the brand context", async () => {
    for (const host of ["tidak-ada.contoh.example", "localhost"]) {
      const response = await request(app).get(PATH).set("Host", host);
      expect(response.status, host).toBe(404);
      expect(response.body.error.code).toBe("TENANT_NOT_FOUND");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("is never cacheable: the tenant is not decided by Host alone", async () => {
    const response = await request(app).get(PATH).set("Host", a.hostname);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("stays no-store when a device token arrives on an unknown host", async () => {
    const response = await request(app)
      .get(PATH)
      .set("Host", "tidak-ada.contoh.example")
      .set(DEVICE_TOKEN_HEADER, "dv1.bogus.signature");
    expect(response.status).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("sits under the public rate limit prefix", () => {
    expect(
      PUBLIC_RATE_LIMIT_PATHS.some(
        (prefix) => PATH === prefix || PATH.startsWith(`${prefix}/`),
      ),
    ).toBe(true);
  });

  it("is rate limited and the 429 is not cacheable", async () => {
    const limitedApp = createApp({
      publicRateLimit: { perIp: 1, internalIps: [] },
    });
    const first = await request(limitedApp).get(PATH).set("Host", a.hostname);
    expect(first.status).toBe(200);
    const limited = await request(limitedApp).get(PATH).set("Host", a.hostname);
    expect(limited.status).toBe(429);
    expect(limited.headers["cache-control"]).toBe("no-store");
  });
});
