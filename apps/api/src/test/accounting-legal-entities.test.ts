// Legal-entity picker for finance screens (legend-bddb). GET
// /api/accounting/legal-entities is read with `accounting.journal.view`
// (tenant-wide) and returns only id, name, npwpLast4 and isPkp. The org route
// keeps its `org.structure.manage` guard, so a finance user still gets 403
// there. Same host-app pattern as accounting-finance-policy.test.ts.

import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { listLegalEntities } from "@starter/shared/accounting";
import { createApp } from "../app";
import { errorHandler, notFound } from "../middleware/error-handler";
import { tenantContext } from "../middleware/tenant";
import { createAccountingLegalEntitiesRouter } from "../routes/accounting-legal-entities.routes";
import { orgRouter } from "../routes/org.routes";
import { originHeader } from "./helpers";

const authApp = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUserIds: string[] = [];
const otherTenantIds: string[] = [];
const entityIds: string[] = [];
const unique = () => randomBytes(4).toString("hex");
const PATH = "/api/accounting/legal-entities";

const host = express();
host.use(
  "/api",
  tenantContext({
    required: false,
    resolveDomain: async () => null,
    verifyCredential: async () => null,
    fallback: async (req) => ({
      tenantId: req.get("x-test-tenant") ?? tenantId,
      brandId: null,
      source: "session" as const,
    }),
  }),
);
host.use("/api/accounting", createAccountingLegalEntitiesRouter());
host.use("/api/org", orgRouter);
host.use(notFound);
host.use(errorHandler);

async function signedIn(): Promise<{ cookie: string; userId: string }> {
  const email = `legal-entities-${randomUUID()}@example.com`;
  const signUp = await request(authApp)
    .post("/api/auth/sign-up/email")
    .set(originHeader)
    .send({ name: "Legal entities", email, password: "Test-password-123!" });
  if (signUp.status !== 200) throw new Error(`Sign-up ${signUp.status}`);
  const cookie = (signUp.headers["set-cookie"] as unknown as string[])
    .map((value) => value.split(";")[0])
    .join("; ");
  const session = await request(authApp)
    .get("/api/auth/get-session")
    .set("Cookie", cookie);
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  return { cookie, userId };
}

async function assignTemplate(userId: string, templateKey: string) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role template`);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, userId, rows[0].id],
  );
}

async function insertEntity(
  tenant: string,
  name: string,
  extra: { npwpLast4?: string; isPkp?: boolean } = {},
) {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO legal_entities
       (tenant_id, name, npwp_encrypted, npwp_last4, is_pkp, address)
     VALUES ($1, $2, $3, $4, $5, 'Jl. Rahasia 1') RETURNING id`,
    [
      tenant,
      name,
      extra.npwpLast4 ? "sealed-secret-value" : null,
      extra.npwpLast4 ?? null,
      extra.isPkp ?? false,
    ],
  );
  entityIds.push(rows[0]!.id);
  return rows[0]!.id;
}

const get = (cookie: string, tenantHeader?: string) => {
  const call = request(host).get(PATH).set("Cookie", cookie);
  return tenantHeader ? call.set("x-test-tenant", tenantHeader) : call;
};

let finance: { cookie: string; userId: string };
let cashier: { cookie: string; userId: string };
let nobody: { cookie: string; userId: string };
const prefix = `LE-${unique()}`;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await signedIn();
  await assignTemplate(finance.userId, "finance");
  cashier = await signedIn();
  await assignTemplate(cashier.userId, "cashier");
  nobody = await signedIn();
});

afterAll(async () => {
  if (entityIds.length > 0)
    await owner.query("DELETE FROM legal_entities WHERE id = ANY($1::uuid[])", [
      entityIds,
    ]);
  if (otherTenantIds.length > 0)
    await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      otherTenantIds,
    ]);
  if (createdUserIds.length > 0) {
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantId, createdUserIds],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUserIds,
    ]);
  }
  await owner.end();
});

describe("legend-bddb accounting legal-entity picker", () => {
  it("finance gets 200 with only id, name, npwpLast4 and isPkp, ordered by name", async () => {
    const b = await insertEntity(tenantId, `${prefix} B`, {
      npwpLast4: "1234",
      isPkp: true,
    });
    const a = await insertEntity(tenantId, `${prefix} A`);
    const response = await get(finance.cookie);
    expect(response.status).toBe(200);
    const parsed = listLegalEntities.response.parse(response.body);
    const mine = parsed.data.filter((row) => row.name.startsWith(prefix));
    expect(mine).toEqual([
      { id: a, name: `${prefix} A`, npwpLast4: null, isPkp: false },
      { id: b, name: `${prefix} B`, npwpLast4: "1234", isPkp: true },
    ]);
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain("Jl. Rahasia");
    expect(raw).not.toContain("sealed-secret-value");
    expect(raw).not.toContain("tenantId");
  });

  it("a role without accounting.journal.view gets 403", async () => {
    expect((await get(cashier.cookie)).status).toBe(403);
    expect((await get(nobody.cookie)).status).toBe(403);
  });

  it("anonymous gets 401", async () => {
    expect((await request(host).get(PATH)).status).toBe(401);
  });

  it("another tenant's user does not see this tenant's entities, and vice versa", async () => {
    const other = randomUUID();
    otherTenantIds.push(other);
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Legal entities other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [other, `le-${unique()}`, tenantId],
    );
    await insertEntity(other, `${prefix} OTHER`);
    const mine = await get(finance.cookie);
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.body)).not.toContain(`${prefix} OTHER`);
    // The finance user holds no role in the other tenant: permission denied,
    // so the other tenant's rows are not readable through this user either.
    const crossed = await get(finance.cookie, other);
    expect(crossed.status).toBe(403);
    expect(JSON.stringify(crossed.body)).not.toContain(`${prefix} OTHER`);
  });

  it("the org legal-entity route keeps its org.structure.manage guard: finance still gets 403", async () => {
    const response = await request(host)
      .get("/api/org/legal-entities")
      .set("Cookie", finance.cookie);
    expect(response.status).toBe(403);
  });
});
