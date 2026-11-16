// Tenant finance policy — HTTP + service tests (bead legend-pxcs; PRD v1.7
// §3.19, ACC-04 matching date tolerance, ACC-05 "batas hari" for undeposited
// cash; TEN-01/02/03). Runs the real Better Auth, RLS and PostgreSQL against the
// disposable test DB.
//
// The router is exercised through a small host app that installs the same
// tenant resolver as the API, pinned to the seeded tenant (or, via the
// x-test-tenant header, to a second tenant). Mounting the router in
// routes/index.ts is the squad lead's step, so this file does not depend on it.

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
  idr,
  tenantIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  DEFAULT_FINANCE_POLICY,
  undepositedCashAlerts,
  type CashCollection,
} from "@starter/shared/accounting";
import { createApp } from "../app";
import { errorHandler, notFound } from "../middleware/error-handler";
import { tenantContext } from "../middleware/tenant";
import { createAccountingFinancePolicyRouter } from "../routes/accounting-finance-policy.routes";
import {
  getFinancePolicy,
  loadCashDepositPolicy,
  loadMatchingPolicy,
  putFinancePolicy,
} from "../services/accounting-finance-policy.service";
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
const unique = () => randomBytes(4).toString("hex");
const actor = userIdSchema.parse(randomUUID());
const PATH = "/api/accounting/finance-policy";

// Host app: same tenant resolver contract as createApp, pinned for the test.
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
host.use("/api/accounting", createAccountingFinancePolicyRouter());
host.use(notFound);
host.use(errorHandler);

function scope(tenant = tenantId): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

/** Signs up through the real app and returns the session cookie + user id. */
async function signedIn(): Promise<{ cookie: string; userId: string }> {
  const email = `policy-${randomUUID()}@example.com`;
  const signUp = await request(authApp)
    .post("/api/auth/sign-up/email")
    .set(originHeader)
    .send({ name: "Finance policy", email, password: "Test-password-123!" });
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

const get = (cookie: string, tenantHeader?: string) => {
  const call = request(host).get(PATH).set("Cookie", cookie);
  return tenantHeader ? call.set("x-test-tenant", tenantHeader) : call;
};
const put = (cookie: string, body: unknown, tenantHeader?: string) => {
  const call = request(host)
    .put(PATH)
    .set(originHeader)
    .set("Cookie", cookie)
    .send(body as object);
  return tenantHeader ? call.set("x-test-tenant", tenantHeader) : call;
};
// legend-fnxl.9: the policy also carries reconciliationPolicy.caseDueDays (the
// bank reconciliation case due-days, default 7, 1..60 like
// reconciliationPolicySchema). Assumption: PUT replaces the whole policy, so the
// body must carry it too; the helper therefore always sends it (default 7).
const policy = (
  maxDaysUndeposited: number,
  dateToleranceDays: number,
  caseDueDays = 7,
) => ({
  cashDepositPolicy: { maxDaysUndeposited },
  matchingPolicy: { dateToleranceDays },
  reconciliationPolicy: { caseDueDays },
});

async function newTenant() {
  const id = tenantIdSchema.parse(randomUUID());
  otherTenantIds.push(id);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Finance policy other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [id, `fpol-${unique()}`, tenantId],
  );
  return id;
}

async function dueDaysColumn(tenant: string): Promise<number | null> {
  const { rows } = await owner.query<{ recon_case_due_days: number }>(
    "SELECT recon_case_due_days FROM finance_policies WHERE tenant_id = $1",
    [tenant],
  );
  return rows[0]?.recon_case_due_days ?? null;
}

async function policyRow(tenant: string) {
  const { rows } = await owner.query<{
    bank_matching_date_tolerance_days: number;
    max_days_undeposited: number;
    updated_by: string | null;
  }>(
    `SELECT bank_matching_date_tolerance_days, max_days_undeposited, updated_by
       FROM finance_policies WHERE tenant_id = $1`,
    [tenant],
  );
  return rows[0] ?? null;
}

let finance: { cookie: string; userId: string };

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query("DELETE FROM finance_policies WHERE tenant_id = $1", [
    tenantId,
  ]);
  finance = await signedIn();
  await assignTemplate(finance.userId, "finance");
});

afterAll(async () => {
  await owner.query("DELETE FROM finance_policies WHERE tenant_id = $1", [
    tenantId,
  ]);
  if (otherTenantIds.length > 0) {
    await owner.query(
      "DELETE FROM finance_policies WHERE tenant_id = ANY($1::uuid[])",
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

describe("legend-pxcs finance policy (ACC-04 tolerance, ACC-05 batas hari)", () => {
  it("GET answers the 2/2 defaults while no policy is saved, and never writes a row", async () => {
    const response = await get(finance.cookie);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: policy(2, 2) });
    expect(response.body.data).toEqual(DEFAULT_FINANCE_POLICY);
    expect(await policyRow(tenantId)).toBeNull();
  });

  it("PUT saves the policy and GET reads it back; a second PUT replaces it (one row, audited)", async () => {
    const saved = await put(finance.cookie, policy(5, 7));
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ data: policy(5, 7) });
    expect((await get(finance.cookie)).body).toEqual({ data: policy(5, 7) });

    const row = await policyRow(tenantId);
    expect(row).toMatchObject({
      bank_matching_date_tolerance_days: 7,
      max_days_undeposited: 5,
      updated_by: finance.userId,
    });

    // Boundaries of the contract: 0..30 days and 0..14 days are both valid.
    expect((await put(finance.cookie, policy(0, 0))).status).toBe(200);
    expect((await put(finance.cookie, policy(30, 14))).status).toBe(200);
    expect((await get(finance.cookie)).body).toEqual({ data: policy(30, 14) });
    const { rows } = await owner.query(
      "SELECT 1 FROM finance_policies WHERE tenant_id = $1",
      [tenantId],
    );
    expect(rows).toHaveLength(1);

    const audit = await owner.query<{ event: Record<string, unknown> }>(
      `SELECT event FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'accounting.finance_policy.updated'
          AND event->>'objectId' = $1::text
          AND event->>'actorId' = $2
        ORDER BY event->>'createdAt' DESC, id DESC`,
      [tenantId, finance.userId],
    );
    expect(audit.rowCount).toBe(3);
    expect(audit.rows[0]!.event).toMatchObject({
      actorId: finance.userId,
      maskedChanges: {
        before: { maxDaysUndeposited: 0, dateToleranceDays: 0 },
        after: { maxDaysUndeposited: 30, dateToleranceDays: 14 },
      },
    });
  });

  it("ACC-05 the alert uses the limit read back from the policy, not a fixed 2", async () => {
    const collections: CashCollection[] = [
      {
        outletId: outletA,
        businessDate: "2026-11-01",
        cashIdr: idr(1_000_000),
      },
    ];
    const asOf = "2026-11-04"; // 3 days outstanding
    const alertsFor = async () =>
      undepositedCashAlerts(
        collections,
        [],
        asOf,
        await loadCashDepositPolicy(scope()),
      );

    await put(finance.cookie, policy(2, 2));
    expect(await alertsFor()).toEqual([
      expect.objectContaining({
        daysOutstanding: 3,
        undepositedIdr: 1_000_000,
      }),
    ]);

    // A looser limit silences the alert...
    await put(finance.cookie, policy(5, 2));
    expect(await alertsFor()).toEqual([]);
    // ...and a stricter one raises it again for cash only 3 days old.
    await put(finance.cookie, policy(0, 2));
    expect(await alertsFor()).toHaveLength(1);
    await put(finance.cookie, policy(3, 2));
    expect(await alertsFor()).toEqual([]);

    // The same stored row feeds the ACC-04 tolerance consumer.
    await put(finance.cookie, policy(3, 9));
    expect(await loadMatchingPolicy(scope())).toEqual({ dateToleranceDays: 9 });
    expect(await loadCashDepositPolicy(scope())).toEqual({
      maxDaysUndeposited: 3,
    });
  });

  it("PUT outside the limits or with foreign fields is refused and changes nothing", async () => {
    await put(finance.cookie, policy(4, 6));
    const bad: unknown[] = [
      policy(31, 2),
      policy(-1, 2),
      policy(2, 15),
      policy(2, -1),
      policy(1.5, 2),
      { ...policy(2, 2), tenantId: randomUUID() },
      {
        cashDepositPolicy: { maxDaysUndeposited: 2, extra: true },
        matchingPolicy: { dateToleranceDays: 2 },
      },
      { cashDepositPolicy: { maxDaysUndeposited: 2 } },
      { matchingPolicy: { dateToleranceDays: 2 } },
      { cashDepositPolicy: { maxDaysUndeposited: "2" }, matchingPolicy: {} },
      {},
    ];
    for (const body of bad) {
      const response = await put(finance.cookie, body);
      // ZodError maps to 422 VALIDATION_ERROR in the shared error handler.
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(response.body.error?.code ?? response.body.code).toBe(
        "VALIDATION_ERROR",
      );
    }
    expect((await get(finance.cookie)).body).toEqual({ data: policy(4, 6) });
  });

  it("TEN-01 policies are per tenant: another tenant keeps the defaults and its own writes stay its own", async () => {
    await put(finance.cookie, policy(9, 11));
    const other = await newTenant();
    expect(await getFinancePolicy(scope(other))).toEqual(policy(2, 2));
    expect(await policyRow(other)).toBeNull();

    // Same row key, other tenant: RLS keeps both apart.
    await putFinancePolicy(scope(other), policy(1, 1), actor);
    expect(await getFinancePolicy(scope(other))).toEqual(policy(1, 1));
    expect(await getFinancePolicy(scope())).toEqual(policy(9, 11));
    expect(await policyRow(tenantId)).toMatchObject({
      max_days_undeposited: 9,
      bank_matching_date_tolerance_days: 11,
    });
  });

  it("TEN-02 the tenant comes from the server: a tenantId in the body is refused, never obeyed", async () => {
    const other = await newTenant();
    const response = await put(finance.cookie, {
      ...policy(12, 12),
      tenantId: other,
    });
    expect(response.status).toBe(422);
    expect(await policyRow(other)).toBeNull();
  });

  it("TEN-03 without the permission GET and PUT answer 403; without a session 401", async () => {
    const stranger = await signedIn(); // no role assignment at all
    expect((await get(stranger.cookie)).status).toBe(403);
    const denied = await put(stranger.cookie, policy(20, 3));
    expect(denied.status).toBe(403);

    expect((await request(host).get(PATH)).status).toBe(401);
    expect(
      (await request(host).put(PATH).set(originHeader).send(policy(20, 3)))
        .status,
    ).toBe(401);

    // Nothing the stranger sent was stored.
    expect(await policyRow(tenantId)).toMatchObject({
      max_days_undeposited: 9,
    });
  });

  it("a cross-site PUT is refused before the body is read (origin check)", async () => {
    const response = await request(host)
      .put(PATH)
      .set("Origin", "https://evil.example")
      .set("Cookie", finance.cookie)
      .send(policy(1, 1));
    expect(response.status).toBe(403);
    expect(await policyRow(tenantId)).toMatchObject({
      max_days_undeposited: 9,
    });
  });

  // ---------------------------------------------------------------- legend-fnxl.9
  it("fnxl.9 GET defaults reconciliationPolicy.caseDueDays to 7 and the shared default carries it", async () => {
    await owner.query("DELETE FROM finance_policies WHERE tenant_id = $1", [
      tenantId,
    ]);
    expect(DEFAULT_FINANCE_POLICY.reconciliationPolicy).toEqual({
      caseDueDays: 7,
    });
    const response = await get(finance.cookie);
    expect(response.status).toBe(200);
    expect(response.body.data.reconciliationPolicy).toEqual({ caseDueDays: 7 });
    expect(await policyRow(tenantId)).toBeNull();
  });

  it("fnxl.9 PUT stores caseDueDays in recon_case_due_days, accepts the 1 and 60 limits, GET reads it back", async () => {
    const saved = await put(finance.cookie, policy(2, 2, 14));
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ data: policy(2, 2, 14) });
    expect(await dueDaysColumn(tenantId)).toBe(14);
    expect((await get(finance.cookie)).body).toEqual({
      data: policy(2, 2, 14),
    });

    expect((await put(finance.cookie, policy(2, 2, 1))).status).toBe(200);
    expect(await dueDaysColumn(tenantId)).toBe(1);
    expect((await put(finance.cookie, policy(2, 2, 60))).status).toBe(200);
    expect(await dueDaysColumn(tenantId)).toBe(60);
    expect((await get(finance.cookie)).body).toEqual({
      data: policy(2, 2, 60),
    });
  });

  it("fnxl.9 PUT with caseDueDays outside 1..60, fractional, text or a foreign field is refused (422) and changes nothing", async () => {
    await put(finance.cookie, policy(4, 6, 10));
    const withDue = (reconciliationPolicy: unknown) => ({
      cashDepositPolicy: { maxDaysUndeposited: 4 },
      matchingPolicy: { dateToleranceDays: 6 },
      reconciliationPolicy,
    });
    const bad: unknown[] = [
      policy(4, 6, 0),
      policy(4, 6, 61),
      policy(4, 6, -3),
      policy(4, 6, 7.5),
      withDue({ caseDueDays: "7" }),
      withDue({ caseDueDays: null }),
      withDue({}),
      withDue({ caseDueDays: 7, extra: true }),
      {
        cashDepositPolicy: { maxDaysUndeposited: 4 },
        matchingPolicy: { dateToleranceDays: 6 },
      },
    ];
    for (const body of bad) {
      const response = await put(finance.cookie, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
    expect(await dueDaysColumn(tenantId)).toBe(10);
    expect((await get(finance.cookie)).body).toEqual({
      data: policy(4, 6, 10),
    });
  });

  it("fnxl.9 the database refuses recon_case_due_days outside 1..60 (CHECK) and defaults a new row to 7", async () => {
    const other = await newTenant();
    await owner.query("INSERT INTO finance_policies (tenant_id) VALUES ($1)", [
      other,
    ]);
    expect(await dueDaysColumn(other)).toBe(7);
    for (const value of [0, 61]) {
      await expect(
        owner.query(
          "UPDATE finance_policies SET recon_case_due_days = $2 WHERE tenant_id = $1",
          [other, value],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
    expect(await dueDaysColumn(other)).toBe(7);
  });

  it("fnxl.9 caseDueDays is per tenant: another tenant keeps 7 and its own value stays its own", async () => {
    await put(finance.cookie, policy(2, 2, 21));
    const other = await newTenant();
    expect((await getFinancePolicy(scope(other))).reconciliationPolicy).toEqual(
      { caseDueDays: 7 },
    );
    await putFinancePolicy(scope(other), policy(2, 2, 3), actor);
    expect(await getFinancePolicy(scope(other))).toEqual(policy(2, 2, 3));
    expect(await getFinancePolicy(scope())).toEqual(policy(2, 2, 21));
    expect(await dueDaysColumn(tenantId)).toBe(21);
    expect(await dueDaysColumn(other)).toBe(3);
  });

  it("fnxl.9 without the permission a PUT of caseDueDays answers 403 and stores nothing (no new role, accounting.reconcile unchanged)", async () => {
    await put(finance.cookie, policy(2, 2, 9));
    const stranger = await signedIn();
    expect((await put(stranger.cookie, policy(2, 2, 30))).status).toBe(403);
    expect((await get(stranger.cookie)).status).toBe(403);
    expect(await dueDaysColumn(tenantId)).toBe(9);
  });
});
