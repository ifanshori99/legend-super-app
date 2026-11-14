import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { brandIdSchema } from "@starter/shared/core";
import {
  isVerifiedTenantHost,
  resolveHostname,
} from "../services/org-resolve.service";
import { createApp } from "../app";
import { env } from "../config/env";
import { resolveDevLocalTenantHost } from "../services/dev-local-tenant-resolve.service";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
const runFile = promisify(execFile);
const localHosts = ["localhost", "127.0.0.1"];
const originalFlag = env.DEV_LOCAL_TENANT_HOSTS;

beforeEach(() => {
  env.DEV_LOCAL_TENANT_HOSTS = true;
});

afterEach(() => {
  env.DEV_LOCAL_TENANT_HOSTS = originalFlag;
});

afterAll(async () => {
  await owner.end();
});

describe("legend-vq14 development seed domains", () => {
  it.each(localHosts)(
    "refuses a reserved local domain assigned to another brand: %s",
    async (host) => {
      const otherBrand = brandIdSchema.parse(randomUUID());
      await owner.query(
        "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Other local seed test brand')",
        [
          otherBrand,
          cafeLegendPlatformFixtures.tenant.id,
          `local-${otherBrand}`,
        ],
      );
      try {
        await owner.query(
          "UPDATE tenant_domains SET brand_id = $2 WHERE hostname = $1",
          [host, otherBrand],
        );
        expect(await resolveDevLocalTenantHost(`${host}:3000`)).toBeNull();
      } finally {
        await owner.query(
          "UPDATE tenant_domains SET brand_id = $2 WHERE hostname = $1",
          [host, cafeLegendPlatformFixtures.brand.id],
        );
        await owner.query("DELETE FROM brands WHERE id = $1", [otherBrand]);
      }
    },
  );

  it.each(localHosts)("resolves seeded tenant from %s:3000", async (host) => {
    const response = await request(createApp())
      .get("/api/tenant/context")
      .set("Host", `${host}:3000`);
    expect(response.status).toBe(200);
    expect(response.body.data.brand.id).toBe(
      cafeLegendPlatformFixtures.brand.id,
    );
  });

  it.each(localHosts)(
    "keeps WhatsApp login closed for %s when flag is off",
    async (host) => {
      env.DEV_LOCAL_TENANT_HOSTS = false;
      const response = await request(createApp())
        .post("/api/auth/login-challenges/whatsapp")
        .set("Host", `${host}:3000`)
        .set("Origin", process.env.WEB_URL!)
        .send({});
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("TENANT_NOT_FOUND");
    },
  );

  it.each(["localhost", "localhost:4000", "127.0.0.1:65535"])(
    "resolves an enabled local host with omitted or valid port: %s",
    async (host) => {
      const response = await request(createApp())
        .get("/api/tenant/context")
        .set("Host", host);
      expect(response.status).toBe(200);
    },
  );

  it("refuses local host resolution in a production runtime even if env is mutated", async () => {
    const originalNodeEnv = env.NODE_ENV;
    try {
      env.NODE_ENV = "production";
      const response = await request(createApp())
        .get("/api/tenant/context")
        .set("Host", "localhost:3000");
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("TENANT_NOT_FOUND");
    } finally {
      env.NODE_ENV = originalNodeEnv;
    }
  });

  it.each(localHosts)(
    "finds WhatsApp tenant for %s when explicitly enabled",
    async (host) => {
      const response = await request(createApp())
        .post("/api/auth/login-challenges/whatsapp")
        .set("Host", `${host}:3000`)
        .set("Origin", process.env.WEB_URL!)
        .send({ unexpected: true });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    },
  );

  it.each([
    "unknown.example",
    "wfc.cafelegend.example",
    "localhost.example",
    "127.0.0.2",
    "127.1",
    "2130706433",
    "[::1]",
  ])("fails closed for %s with the local flag enabled", async (host) => {
    const response = await request(createApp())
      .get("/api/tenant/context")
      .set("Host", host);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("TENANT_NOT_FOUND");
  });

  it.each(localHosts)(
    "leaves the production resolver closed for %s",
    async (host) => {
      expect(await resolveHostname(`${host}:3000`)).toEqual({
        ok: false,
        reason: "invalid_host",
      });
    },
  );

  it.each(localHosts)(
    "keeps TLS issuance disabled for %s even with local tenant hosts enabled",
    async (host) => {
      expect(env.DEV_LOCAL_TENANT_HOSTS).toBe(true);
      expect(await isVerifiedTenantHost(`${host}:3000`)).toBe(false);
    },
  );

  it.each(localHosts)(
    "refuses %s when its local seed domain row is missing",
    async (host) => {
      const { rows } = await owner.query<{ id: string }>(
        "UPDATE tenant_domains SET hostname = $2 WHERE hostname = $1 RETURNING id",
        [host, `${host}.missing-seed.example`],
      );
      try {
        expect(rows).toHaveLength(1);
        const response = await request(createApp())
          .get("/api/tenant/context")
          .set("Host", `${host}:3000`);
        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe("TENANT_NOT_FOUND");
      } finally {
        for (const row of rows) {
          await owner.query(
            "UPDATE tenant_domains SET hostname = $2 WHERE id = $1",
            [row.id, host],
          );
        }
      }
    },
  );

  it.each(localHosts)(
    "refuses an unverified seeded local domain %s",
    async (host) => {
      const { rows } = await owner.query<{ verified_at: Date }>(
        "SELECT verified_at FROM tenant_domains WHERE hostname = $1",
        [host],
      );
      try {
        expect(rows).toHaveLength(1);
        await owner.query(
          "UPDATE tenant_domains SET verified_at = NULL WHERE hostname = $1",
          [host],
        );
        const response = await request(createApp())
          .get("/api/tenant/context")
          .set("Host", `${host}:3000`);
        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe("TENANT_NOT_FOUND");
      } finally {
        await owner.query(
          "UPDATE tenant_domains SET verified_at = $2 WHERE hostname = $1",
          [host, rows[0]?.verified_at],
        );
      }
    },
  );

  it("refuses seeded local domains of an inactive tenant", async () => {
    try {
      await owner.query(
        "UPDATE tenants SET status = 'suspended' WHERE id = $1",
        [cafeLegendPlatformFixtures.tenant.id],
      );
      const response = await request(createApp())
        .get("/api/tenant/context")
        .set("Host", "localhost:3000");
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("TENANT_NOT_FOUND");
    } finally {
      await owner.query("UPDATE tenants SET status = 'active' WHERE id = $1", [
        cafeLegendPlatformFixtures.tenant.id,
      ]);
    }
  });

  it("keeps exactly one verified domain per local host when seeded again", async () => {
    for (let run = 0; run < 2; run++) {
      await runFile(
        process.execPath,
        ["--import", "tsx", "src/db/seed-dev-tenant.ts"],
        { cwd: new URL("../..", import.meta.url), env: process.env },
      );
    }

    const { rows } = await owner.query<{
      hostname: string;
      tenant_id: string;
      brand_id: string;
      tls_status: string;
      verified: boolean;
    }>(
      `SELECT hostname, tenant_id, brand_id, tls_status,
              verified_at IS NOT NULL AS verified
         FROM tenant_domains
        WHERE hostname = ANY($1::text[])
        ORDER BY hostname`,
      [localHosts],
    );
    expect(rows).toEqual(
      [...localHosts].sort().map((hostname) => ({
        hostname,
        tenant_id: cafeLegendPlatformFixtures.tenant.id,
        brand_id: cafeLegendPlatformFixtures.brand.id,
        tls_status: "active",
        verified: true,
      })),
    );
    for (const host of localHosts) {
      const response = await request(createApp())
        .get("/api/tenant/context")
        .set("Host", `${host}:3000`);
      expect(response.status).toBe(200);
    }
  });
});
