// legend-8y5fc: one tenant/domain DNS budget survives API instances and restart.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { setDomainTxtResolver } from "../services/org.service";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";

const fixtures = cafeLegendPlatformFixtures;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const clients: ReturnType<typeof agent>[] = [];
const domains: string[] = [];
const foreignTenantId = randomUUID();
const foreignBrandId = randomUUID();
const foreignDomainId = randomUUID();
let brandId: string;
let lookups = 0;

async function adminClient() {
  const client = agent(createApp());
  const email = await signUp(client, "Domain Limit Admin");
  await setRole(email, "admin");
  const session = await client.get("/api/auth/get-session");
  const userId: string = session.body.user.id;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [fixtures.tenant.id, userId],
  );
  await verifySessionMfa(email);
  return client;
}

async function newDomain() {
  const response = await clients[0]
    .post("/api/org/domains")
    .set(originHeader)
    .send({ brandId, hostname: `limit-${randomUUID()}.example.com` });
  expect(response.status).toBe(201);
  const id: string = response.body.data.id;
  domains.push(id);
  lookups = 0;
  setDomainTxtResolver(async () => {
    lookups++;
    throw Object.assign(new Error("DNS timeout"), { code: "ETIMEOUT" });
  });
  return `/api/org/domains/${id}/verify`;
}

beforeAll(async () => {
  clients.push(await adminClient(), await adminClient());
  brandId = (await clients[0].get("/api/org/brands")).body.data[0].id;
  await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Foreign Domain Owner', plan, status, deployment_mode,
       feature_flags, limits, created_by FROM tenants WHERE id = $3`,
    [foreignTenantId, `domain-limit-${foreignTenantId}`, fixtures.tenant.id],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [foreignBrandId, foreignTenantId],
  );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind)
     VALUES ($1, $2, $3, $4, 'custom')`,
    [
      foreignDomainId,
      foreignTenantId,
      foreignBrandId,
      `foreign-${foreignDomainId}.example.com`,
    ],
  );
});

afterEach(() => setDomainTxtResolver(null));
afterAll(async () => {
  await owner.query("DELETE FROM tenant_domains WHERE id = ANY($1::uuid[])", [
    [...domains, foreignDomainId],
  ]);
  await owner.query("DELETE FROM brands WHERE id = $1", [foreignBrandId]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [foreignTenantId]);
  await owner.end();
});

describe("shared tenant domain verification limit", () => {
  it("shares five DNS attempts between API instances and a newly created app", async () => {
    const path = await newDomain();
    for (let i = 0; i < 5; i++) {
      const response = await clients[i % 2].post(path).set(originHeader);
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe("DOMAIN_VERIFICATION_FAILED");
    }
    const restarted = await adminClient();
    const response = await restarted.post(path).set(originHeader);
    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("DOMAIN_VERIFICATION_RATE_LIMITED");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(response.headers["retry-after"])).toBeLessThanOrEqual(600);
    expect(lookups).toBe(5);

    // A different domain of the same tenant retains its own budget.
    const otherPath = await newDomain();
    expect((await clients[0].post(otherPath).set(originHeader)).status).toBe(
      422,
    );
    expect(lookups).toBe(1);
  });

  it("admits at most five concurrent requests across instances", async () => {
    const path = await newDomain();
    const responses = await Promise.all(
      Array.from({ length: 14 }, (_, i) =>
        clients[i % 2].post(path).set(originHeader),
      ),
    );
    expect(
      responses.filter((response) => response.status === 422),
    ).toHaveLength(5);
    expect(
      responses.filter((response) => response.status === 429),
    ).toHaveLength(9);
    expect(lookups).toBe(5);
    const stored = await owner.query(
      "SELECT verification_attempts FROM tenant_domains WHERE id = $1",
      [domains.at(-1)],
    );
    expect(stored.rows[0].verification_attempts).toBe(5);
  });

  it("loads an existing DB window and reopens it only after ten minutes", async () => {
    const path = await newDomain();
    const domainId = domains.at(-1);
    // This state comes from another connection, as it would after API restart.
    await owner.query(
      `UPDATE tenant_domains SET verification_attempts = 5,
       verification_window_started_at = now() - interval '9 minutes 30 seconds'
       WHERE id = $1`,
      [domainId],
    );
    const limited = await clients[1].post(path).set(originHeader);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(28);
    expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(30);
    expect(lookups).toBe(0);

    await owner.query(
      `UPDATE tenant_domains SET
       verification_window_started_at = now() - interval '10 minutes'
       WHERE id = $1`,
      [domainId],
    );
    expect((await clients[0].post(path).set(originHeader)).status).toBe(422);
    const stored = await owner.query(
      `SELECT verification_attempts,
       verification_window_started_at > now() - interval '10 seconds' AS fresh
       FROM tenant_domains WHERE id = $1`,
      [domainId],
    );
    expect(stored.rows[0]).toEqual({ verification_attempts: 1, fresh: true });
    expect(lookups).toBe(1);
  });

  it("keeps foreign domains and requests without a trusted origin outside the budget", async () => {
    const path = await newDomain();
    expect((await clients[0].post(path)).status).toBe(403);
    const foreign = await clients[0]
      .post(`/api/org/domains/${foreignDomainId}/verify`)
      .set(originHeader);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("NOT_FOUND");
    const missing = await clients[0]
      .post(`/api/org/domains/${randomUUID()}/verify`)
      .set(originHeader);
    expect(missing.status).toBe(404);
    expect(lookups).toBe(0);
    const stored = await owner.query(
      `SELECT verification_attempts, verification_window_started_at
       FROM tenant_domains WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[foreignDomainId, domains.at(-1)]],
    );
    expect(stored.rows).toEqual([
      { verification_attempts: 0, verification_window_started_at: null },
      { verification_attempts: 0, verification_window_started_at: null },
    ]);
    expect((await clients[0].post(path).set(originHeader)).status).toBe(422);
    expect(lookups).toBe(1);
  });
});
