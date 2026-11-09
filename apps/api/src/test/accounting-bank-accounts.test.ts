// Bank accounts — HTTP + service tests (bead legend-fnxl.2, WS-07; PRD v1.7
// §3.19 Kas & Bank; TEN-01/02/03). Real Better Auth, RLS and PostgreSQL on the
// disposable test DB. The router is mounted on a small host app (same tenant
// resolver as the API, pinned to the seeded tenant or, via x-test-tenant, to a
// second one); registering it in routes/index.ts is the engineer's step.
//
// Covers: the account number never leaves the database in clear (response,
// stored row, audit rows), sealing binds to tenant + row (AAD), duplicate
// number per legal entity answers 409 (also under a race), GL account checks,
// tenant isolation (404) and permissions (403).

import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  outletIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { createApp } from "../app";
import { openSecret } from "../lib/secrets";
import { errorHandler, notFound } from "../middleware/error-handler";
import { tenantContext } from "../middleware/tenant";
import { createAccountingBankAccountsRouter } from "../routes/accounting-bank-accounts.routes";
import { createBankAccount } from "../services/accounting-bank-accounts.service";
import { originHeader } from "./helpers";

const authApp = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUserIds: string[] = [];
const otherTenantIds: string[] = [];
const entityIds: string[] = [];
const unique = () => randomBytes(4).toString("hex");
/** A fresh 12-digit account number per call so tests never collide. */
const newNumber = () =>
  String(Math.floor(Math.random() * 9e11) + 1e11).padStart(12, "1");

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
host.use("/api/accounting", createAccountingBankAccountsRouter());
host.use(notFound);
host.use(errorHandler);

const listPath = (entity: string) =>
  `/api/accounting/legal-entities/${entity}/bank-accounts`;
const CREATE_PATH = "/api/accounting/bank-accounts";

function scope(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

async function signedIn(): Promise<{ cookie: string; userId: string }> {
  const email = `bank-acc-${randomUUID()}@example.com`;
  const signUp = await request(authApp)
    .post("/api/auth/sign-up/email")
    .set(originHeader)
    .send({ name: "Bank accounts", email, password: "Test-password-123!" });
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

async function newEntity(tenant = tenantId): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id",
    [tenant, `Bank PT ${unique()}`],
  );
  if (tenant === tenantId) entityIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function newAccount(
  entity: string,
  code: string,
  options: { parentId?: string; isActive?: boolean; tenant?: string } = {},
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts
       (tenant_id, legal_entity_id, code, name, type, report_group, parent_id, is_active)
     VALUES ($1, $2, $3, 'Bank', 'asset', 'cash_and_equivalents', $4, $5)
     RETURNING id`,
    [
      options.tenant ?? tenantId,
      entity,
      code,
      options.parentId ?? null,
      options.isActive ?? true,
    ],
  );
  return rows[0]!.id;
}

async function newTenant(): Promise<string> {
  const id = randomUUID();
  otherTenantIds.push(id);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Bank accounts other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [id, `bnkacc-${unique()}`, tenantId],
  );
  return id;
}

const post = (cookie: string, body: unknown, tenantHeader?: string) => {
  const call = request(host)
    .post(CREATE_PATH)
    .set(originHeader)
    .set("Cookie", cookie)
    .send(body as object);
  return tenantHeader ? call.set("x-test-tenant", tenantHeader) : call;
};
const list = (cookie: string, entity: string, tenantHeader?: string) => {
  const call = request(host).get(listPath(entity)).set("Cookie", cookie);
  return tenantHeader ? call.set("x-test-tenant", tenantHeader) : call;
};
const body = (
  legalEntityId: string,
  glAccountId: string,
  accountNumber = newNumber(),
  extra: Record<string, unknown> = {},
) => ({
  legalEntityId,
  bank: "BCA",
  accountName: "Kas Operasional",
  accountNumber,
  glAccountId,
  ...extra,
});

let finance: { cookie: string; userId: string };
let entity: string;
let gl: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await signedIn();
  await assignTemplate(finance.userId, "finance");
  entity = await newEntity();
  gl = await newAccount(entity, "1103");
});

afterAll(async () => {
  const tenants = [tenantId, ...otherTenantIds];
  await owner.query(
    "DELETE FROM bank_accounts WHERE tenant_id = ANY($1::uuid[])",
    [tenants],
  );
  for (const table of ["chart_of_accounts"])
    await owner.query(
      `DELETE FROM ${table} WHERE legal_entity_id = ANY($1::uuid[]) OR tenant_id = ANY($2::uuid[])`,
      [entityIds, otherTenantIds],
    );
  await owner.query("DELETE FROM legal_entities WHERE id = ANY($1::uuid[])", [
    entityIds,
  ]);
  if (otherTenantIds.length > 0) {
    await owner.query(
      "DELETE FROM legal_entities WHERE tenant_id = ANY($1::uuid[])",
      [otherTenantIds],
    );
    await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      otherTenantIds,
    ]);
  }
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

describe("legend-fnxl.2 bank accounts", () => {
  it("creates an account: masked response, number sealed at rest, listed back, audited without the number", async () => {
    const number = newNumber();
    const created = await post(finance.cookie, body(entity, gl, number));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const account = created.body.data;
    expect(account).toEqual({
      id: expect.any(String),
      tenantId,
      legalEntityId: entity,
      bank: "BCA",
      accountName: "Kas Operasional",
      accountNumberMasked: `****${number.slice(-4)}`,
      glAccountId: gl,
      isActive: true,
    });
    expect(JSON.stringify(created.body)).not.toContain(number);

    const listed = await list(finance.cookie, entity);
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((row: { id: string }) => row.id)).toContain(
      account.id,
    );
    expect(JSON.stringify(listed.body)).not.toContain(number);

    const { rows } = await owner.query<{
      account_number_encrypted: Buffer;
      account_number_hmac: string;
      account_number_last4: string;
      account_number_key_version: number;
      created_by: string;
    }>("SELECT * FROM bank_accounts WHERE id = $1", [account.id]);
    const row = rows[0]!;
    expect(row.account_number_last4).toBe(number.slice(-4));
    expect(row.account_number_hmac).toMatch(/^[a-f0-9]{64}$/);
    expect(row.account_number_key_version).toBe(1);
    expect(row.created_by).toBe(finance.userId);
    expect(row.account_number_encrypted.toString("utf8")).not.toContain(number);
    expect(row.account_number_encrypted.toString("hex")).not.toContain(
      Buffer.from(number).toString("hex"),
    );
    // Sealed for this exact tenant + row: opens with its AAD, fails with another.
    const sealed = row.account_number_encrypted.toString("base64");
    const aad = `bank:bank_accounts:${tenantId.toLowerCase()}:${account.id.toLowerCase()}:account_number:k1`;
    expect(openSecret(sealed, aad)).toBe(number);
    expect(() => openSecret(sealed, aad.replace(account.id, randomUUID()))).toThrow();

    const audit = await owner.query<{ event: Record<string, unknown> }>(
      `SELECT event FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'accounting.bank_account.created'
          AND event->>'objectId' = $2`,
      [tenantId, account.id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]!.event).toMatchObject({
      actorId: finance.userId,
      objectType: "bank_account",
    });
    const auditText = JSON.stringify(audit.rows[0]!.event);
    expect(auditText).not.toContain(number);
    expect(auditText).not.toContain(number.slice(-4));

    // No audit row of this tenant mentions the number anywhere.
    const leak = await owner.query(
      "SELECT 1 FROM audit_logs WHERE tenant_id = $1 AND event::text LIKE $2",
      [tenantId, `%${number}%`],
    );
    expect(leak.rowCount).toBe(0);
  });

  it("a duplicate number in the same legal entity answers 409; another entity may reuse it; a different number works", async () => {
    const number = newNumber();
    expect((await post(finance.cookie, body(entity, gl, number))).status).toBe(
      201,
    );
    const duplicate = await post(
      finance.cookie,
      body(entity, gl, number, { bank: "Mandiri", accountName: "Lain" }),
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("CONFLICT");
    expect(JSON.stringify(duplicate.body)).not.toContain(number);

    const otherEntity = await newEntity();
    const otherGl = await newAccount(otherEntity, "1103");
    expect(
      (await post(finance.cookie, body(otherEntity, otherGl, number))).status,
    ).toBe(201);
    expect((await post(finance.cookie, body(entity, gl))).status).toBe(201);
  });

  it("two concurrent creates of one number: exactly one 201, the other 409, never 500", async () => {
    const number = newNumber();
    const results = await Promise.all([
      post(finance.cookie, body(entity, gl, number)),
      post(finance.cookie, body(entity, gl, number)),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
    const { rowCount } = await owner.query(
      "SELECT 1 FROM bank_accounts WHERE tenant_id = $1 AND account_number_last4 = $2 AND legal_entity_id = $3",
      [tenantId, number.slice(-4), entity],
    );
    expect(rowCount).toBeGreaterThanOrEqual(1);
  });

  it("GL account must be active, postable and of the same entity", async () => {
    const inactive = await newAccount(entity, "1190", { isActive: false });
    const header = await newAccount(entity, "1180");
    await newAccount(entity, "1181", { parentId: header });
    const otherEntity = await newEntity();
    const foreign = await newAccount(otherEntity, "1103");

    const inactiveRes = await post(finance.cookie, body(entity, inactive));
    expect(inactiveRes.status).toBe(422);
    expect(inactiveRes.body.error.code).toBe("ACCOUNT_INACTIVE");

    const headerRes = await post(finance.cookie, body(entity, header));
    expect(headerRes.status).toBe(422);
    expect(headerRes.body.error.code).toBe("ACCOUNT_NOT_POSTABLE");

    const foreignRes = await post(finance.cookie, body(entity, foreign));
    expect(foreignRes.status).toBe(422);
    expect(foreignRes.body.error.code).toBe("ACCOUNT_ENTITY_MISMATCH");

    const missing = await post(finance.cookie, body(entity, randomUUID()));
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");

    const none = await owner.query(
      "SELECT 1 FROM bank_accounts WHERE gl_account_id = ANY($1::uuid[])",
      [[inactive, header, foreign]],
    );
    expect(none.rowCount).toBe(0);
  });

  it("rejects malformed bodies (422) and unknown fields", async () => {
    expect(
      (await post(finance.cookie, body(entity, gl, "12ab56"))).status,
    ).toBe(422);
    expect(
      (await post(finance.cookie, body(entity, gl, "12345"))).status,
    ).toBe(422);
    expect(
      (
        await post(
          finance.cookie,
          body(entity, gl, newNumber(), { tenantId: randomUUID() }),
        )
      ).status,
    ).toBe(422);
  });

  it("TEN-01 tenant isolation: another tenant's entity or GL account is 404; its rows are invisible", async () => {
    const other = await newTenant();
    const otherEntity = await newEntity(other);
    const otherGl = await newAccount(otherEntity, "1103", { tenant: other });

    // Seeded-tenant caller asks for the other tenant's entity / GL account.
    expect((await list(finance.cookie, otherEntity)).status).toBe(404);
    expect((await post(finance.cookie, body(otherEntity, otherGl))).status).toBe(
      404,
    );
    expect((await post(finance.cookie, body(entity, otherGl))).status).toBe(404);

    // The same finance user pinned to the other tenant has no role there (403),
    // and cannot reach this tenant's entity or its accounts either.
    expect((await list(finance.cookie, entity, other)).status).toBe(403);
    expect((await post(finance.cookie, body(entity, gl), other)).status).toBe(
      403,
    );

    // This tenant's account list never includes rows of another tenant.
    await owner.query(
      `INSERT INTO bank_accounts
         (tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
          account_number_hmac, account_number_last4, account_number_key_version,
          gl_account_id, created_by)
       VALUES ($1, $2, 'BNI', 'Other', '\\x00', $3, '0000', 1, $4, $5)`,
      [other, otherEntity, "a".repeat(64), otherGl, finance.userId],
    );
    const mine = await list(finance.cookie, entity);
    expect(JSON.stringify(mine.body)).not.toContain("Other");
    expect(
      (
        await owner.query(
          "SELECT 1 FROM bank_accounts WHERE tenant_id = $1",
          [other],
        )
      ).rowCount,
    ).toBe(1);
  });

  it("TEN-03 without the permission both routes answer 403; without a session 401", async () => {
    const stranger = await signedIn();
    expect((await list(stranger.cookie, entity)).status).toBe(403);
    const denied = await post(stranger.cookie, body(entity, gl));
    expect(denied.status).toBe(403);
    expect(
      (await owner.query("SELECT 1 FROM bank_accounts WHERE created_by = $1", [
        stranger.userId,
      ])).rowCount,
    ).toBe(0);
    expect((await request(host).get(listPath(entity))).status).toBe(401);
    expect(
      (await request(host).post(CREATE_PATH).set(originHeader).send(body(entity, gl)))
        .status,
    ).toBe(401);
  });

  it("a cashier role (no finance permission) is refused 403; an outlet-scoped caller is refused by the service", async () => {
    const cashier = await signedIn();
    await assignTemplate(cashier.userId, "cashier");
    expect((await list(cashier.cookie, entity)).status).toBe(403);
    expect((await post(cashier.cookie, body(entity, gl))).status).toBe(403);

    const outletScoped = establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "session" }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(outletA)] },
    );
    await expect(
      createBankAccount(
        outletScoped,
        body(entity, gl),
        userIdSchema.parse(finance.userId),
      ),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    // And the tenant-scope service path works for the same input.
    await expect(
      createBankAccount(scope(), body(entity, gl), userIdSchema.parse(finance.userId)),
    ).resolves.toMatchObject({ legalEntityId: entity });
  });
});
