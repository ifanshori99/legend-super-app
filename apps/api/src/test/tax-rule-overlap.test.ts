// Tax-rule overlap guard at publish (bead legend-de3b, sub-brief 177). Mirrors
// the service-charge guard (legend-mdh0, tax-service-overlap.test.ts):
// `publishTaxRule` refuses a second active rule that would tie in
// `resolveTaxRule` with 409 TAX_RULE_AMBIGUOUS naming the other rule. The owner
// replaces a rule by publishing an inactive version of the old code first.
// Existing duplicates are not changed; `listTaxRuleConflicts` lists them.
//
// Assumptions where the brief is silent:
// - A new tenant from the Platform panel gets the default tenant-wide
//   PBJT-FNB 10% rule (legend-9obf): food_beverage, all channels, region null.
//   A tenant-wide CUSTOM-PBJT food_beverage rule with all channels and region
//   null therefore ties with it on every channel.
// - A new version of an existing code is made by POSTing a rule with the same
//   code; the API numbers it latest + 1 (as for service charge).
// - The quote used to prove pricing is POST /api/tax/preview on the takeaway
//   channel: no service charge applies there, so tax = 10% (default) or 11%
//   (CUSTOM) of Rp 100.000.
// - Error body shape is { error: { code, message } }, status 409.
// - A refused publish leaves the row a draft (the transaction rolls back), so
//   it can be published again later.
// - `listTaxRuleConflicts(context, actorUserId, {})` resolves to
//   `{ conflicts: TaxRuleConflict[] }` (the endpoint DTO). The tenant-wide
//   view lists a pair once, with ruleA/ruleB being the two rule codes in
//   either order, level "itemClass", key "food_beverage", outletId null.
//   The channel on the entry is not asserted: the brief does not say which
//   channel is reported when the pair ties on all of them.
// - The function does not exist before the fix, so it is looked up on the
//   module namespace at run time; only test 5 fails for that reason.
// - Race: two drafts for one tenant are published concurrently. The helper
//   holds a SHARE lock on tax_rules so the first publish parks on its UPDATE
//   while holding the tenant advisory lock; the second must then wait on that
//   advisory lock (non-granted row in pg_locks). The first publish (started
//   first, holding the lock) wins; the test only asserts "exactly one".

import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { Test } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
  type TenantId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { createTaxRule, publishTaxRule } from "../services/tax.service.ts";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";

const app = createApp();
const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 6,
});

const DEFAULT_CODE = "PBJT-FNB";

const OPENING_HOURS = {
  mon: { opens: "08:00", closes: "22:00" },
  tue: { opens: "08:00", closes: "22:00" },
  wed: { opens: "08:00", closes: "22:00" },
  thu: { opens: "08:00", closes: "22:00" },
  fri: { opens: "08:00", closes: "23:00" },
  sat: { opens: "08:00", closes: "23:00" },
  sun: { opens: "08:00", closes: "22:00" },
};

const limits = {
  maxOutlets: 50,
  maxActiveEmployees: 30,
  maxDevices: 10,
  aiRequestsPerMonth: 100,
  whatsappCostCapIdr: 0,
  aiCostCapIdr: 50_000,
  emailCostCapIdr: 10_000,
};

const unique = () => randomBytes(4).toString("hex");
const today = () => businessDateOf(new Date(), DEFAULT_BUSINESS_DAY_CLOCK);

const seededTenants: string[] = [];
const seededUserId = randomUUID();

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [seededUserId, "Overlap Tax Owner", `${seededUserId}@example.test`],
  );
});

afterAll(async () => {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "tax_rules",
      "tax_settings",
      "service_charge_rules",
      "domain_event_outbox",
      "audit_logs",
      "role_assignments",
      "roles",
      "legal_entities",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1)`, [
        seededTenants,
      ]);
    await client.query("DELETE FROM tenants WHERE id = ANY($1)", [
      seededTenants,
    ]);
    await client.query('DELETE FROM "user" WHERE id = $1', [seededUserId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.query("DELETE FROM platform_admins");
    await owner.end();
  }
});

// ------------------------------------------------------- HTTP tenant helpers

async function adminClient() {
  const client = agent(app);
  const email = await signUp(client, "Tax Overlap Admin");
  await setRole(email, "admin");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [userId],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [seededTenantId, userId],
  );
  await verifySessionMfa(email);
  return { client, userId };
}

/** Creates a tenant through the Platform panel API (default tax config). */
async function createTenantViaPanel() {
  const { client: platform } = await adminClient();
  const created = await platform
    .post("/api/platform/tenants")
    .set(originHeader)
    .send({
      slug: `txo-${unique()}`,
      name: "Uji Overlap Pajak",
      plan: "lengkap",
      deploymentMode: "shared",
      featureFlags: { modules: ["pos"], integrationProviders: [] },
      limits,
      firstAdmin: {
        name: "Admin Pertama",
        whatsapp: "6281234567890",
        email: null,
      },
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

/** Signed-in owner of the tenant; the Host header resolves the tenant. */
async function tenantOwnerClient(tenantId: string) {
  const client = agent(app);
  const email = await signUp(client, "Tax Overlap Owner");
  await setRole(email, "admin");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenantId, userId],
  );
  await verifySessionMfa(email);
  const hostname = `txo-${unique()}.contoh.example`;
  const brandId = randomUUID();
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand domain')",
    [brandId, tenantId, `dom-${unique()}`],
  );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'custom', 'active', now())`,
    [randomUUID(), tenantId, brandId, hostname],
  );
  const methods = new Set(["get", "post", "put", "patch", "delete"]);
  const hosted = new Proxy(client, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && methods.has(prop))
        return (url: string) =>
          (target as unknown as Record<string, (u: string) => Test>)[prop]!(
            url,
          ).set("Host", hostname);
      return Reflect.get(target, prop, receiver);
    },
  });
  return { client: hosted, brandId, userId };
}

type OwnerClient = Awaited<ReturnType<typeof tenantOwnerClient>>;

async function createOutletApi({
  client,
  brandId,
}: OwnerClient): Promise<string> {
  const entity = await client
    .post("/api/org/legal-entities")
    .set(originHeader)
    .send({
      name: `PT Pajak ${unique()}`,
      npwp: null,
      isPkp: false,
      address: "Kota Bandung",
    });
  expect(entity.status, JSON.stringify(entity.body)).toBe(201);
  const response = await client
    .post("/api/org/outlets")
    .set(originHeader)
    .send({
      brandId,
      legalEntityId: entity.body.data.id as string,
      code: `TXO-${unique()}`.toUpperCase(),
      name: "Outlet Pajak",
      address: "Jl. Pajak No. 1, Kota Bandung",
      regionId: null,
      geofence: null,
      timeZone: "Asia/Jakarta",
      openingHours: OPENING_HOURS,
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

async function newTenantWithOutlet() {
  const tenantId = await createTenantViaPanel();
  const ownerClient = await tenantOwnerClient(tenantId);
  const outletId = await createOutletApi(ownerClient);
  return { tenantId, ownerClient, outletId };
}

function ruleBody(overrides: Record<string, unknown> = {}) {
  return {
    outletId: null,
    code: `TX-${unique()}`.toUpperCase(),
    name: "Uji overlap pajak",
    taxType: "pbjt",
    rateBp: 1100,
    regionCode: null,
    channels: [],
    appliesTo: { itemClasses: ["food_beverage"], categoryIds: [], itemIds: [] },
    includeServiceInBase: true,
    isActive: true,
    effectiveFrom: today(),
    ...overrides,
  };
}

async function createRule(
  ownerClient: OwnerClient,
  overrides: Record<string, unknown> = {},
) {
  const created = await ownerClient.client
    .post("/api/tax/rules")
    .set(originHeader)
    .send(ruleBody(overrides));
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

function publishRule(ownerClient: OwnerClient, id: string) {
  return ownerClient.client
    .post(`/api/tax/rules/${id}/publish`)
    .set(originHeader)
    .send({ idempotencyKey: `publish-${id}` });
}

async function createAndPublish(
  ownerClient: OwnerClient,
  overrides: Record<string, unknown> = {},
) {
  const id = await createRule(ownerClient, overrides);
  const published = await publishRule(ownerClient, id);
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return id;
}

const statusOf = (id: string) =>
  owner
    .query<{ status: string }>("SELECT status FROM tax_rules WHERE id = $1", [
      id,
    ])
    .then((r) => r.rows[0]!.status);

const publishedCodes = (tenantId: string) =>
  owner
    .query<{ code: string; version: number }>(
      `SELECT code, version FROM tax_rules
        WHERE tenant_id = $1 AND status = 'published' AND is_active
        ORDER BY code, version`,
      [tenantId],
    )
    .then((r) => r.rows.map((row) => row.code));

function quote(
  ownerClient: OwnerClient,
  outletId: string,
  channel: "dine_in" | "takeaway" = "takeaway",
) {
  return ownerClient.client
    .post("/api/tax/preview")
    .set(originHeader)
    .send({
      outletId,
      businessDate: today(),
      channel,
      zoneId: null,
      regionCode: null,
      orderDiscountIdr: 0,
      lines: [
        {
          lineId: "L1",
          itemId: randomUUID(),
          categoryId: null,
          itemClass: "food_beverage",
          grossIdr: 100_000,
          discountIdr: 0,
          components: [],
        },
      ],
    });
}

// ------------------------------------------------ service-level tenant helpers

const scopeOf = (tenantId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantId as TenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

/** A bare tenant (no tax config) whose owner may manage tax config. */
async function seedTenant(): Promise<string> {
  const tenantId = randomUUID();
  seededTenants.push(tenantId);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Overlap Pajak', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [tenantId, `txo-${unique()}`, seededUserId, seededTenantId],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji Overlap', false)`,
    [randomUUID(), tenantId],
  );
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, permissions, allowed_scope_types)
     VALUES ($1, $2, 'Pemilik overlap', $3, '["tenant"]')`,
    [roleId, tenantId, JSON.stringify(["org.tax_config.manage"])],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, seededUserId, roleId],
  );
  return tenantId;
}

function draftInput(code: string, overrides: Record<string, unknown> = {}) {
  return {
    outletId: null,
    code,
    name: `Pajak ${code}`,
    taxType: "pbjt" as const,
    rateBp: 1000,
    regionCode: null,
    channels: [],
    appliesTo: {
      itemClasses: ["food_beverage" as const],
      categoryIds: [],
      itemIds: [],
    },
    includeServiceInBase: true,
    isActive: true,
    effectiveFrom: today(),
    ...overrides,
  };
}

/** Raw published row, as a pre-fix tenant would hold it. */
async function insertPublishedRule(
  tenantId: string,
  code: string,
  version: number,
  isActive: boolean,
) {
  await owner.query(
    `INSERT INTO tax_rules
       (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
        price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
        published_at, published_by)
     VALUES ($1, $2, NULL, $3, $3, 'pbjt', 1000, NULL, '[]', $4,
             false, true, $5, $6, '2026-01-01', 'published', now(), $7)`,
    [
      randomUUID(),
      tenantId,
      code,
      JSON.stringify({
        itemClasses: ["food_beverage"],
        categoryIds: [],
        itemIds: [],
      }),
      isActive,
      version,
      seededUserId,
    ],
  );
}

// ---------------------------------------------------------- pg_locks helpers

async function advisoryLockStates(key: string): Promise<boolean[]> {
  const { rows } = await owner.query<{ granted: boolean }>(
    `SELECT granted FROM pg_locks
      WHERE locktype = 'advisory'
        AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
    [key],
  );
  return rows.map((row) => row.granted);
}

async function relationWaiters(table: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'relation' AND NOT granted
        AND relation = to_regclass($1)`,
    [`public.${table}`],
  );
  return rows[0]!.n;
}

/** Polls (no fixed sleep) until `check` holds or 10 s pass. */
async function waitFor(check: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

// -------------------------------------------------------------------- tests

describe("legend-de3b publish refuses a tax rule that ties with a rule in force", () => {
  // 0. The failure the guard prevents: once two tying rules are both in force
  // (here written straight to the table, as data from before the guard), every
  // quote for a matching line fails 409 TAX_RULE_AMBIGUOUS.
  it("0. two tying published rules make every matching quote fail 409 TAX_RULE_AMBIGUOUS", async () => {
    const { tenantId, ownerClient, outletId } = await newTenantWithOutlet();
    expect(await publishedCodes(tenantId)).toEqual([DEFAULT_CODE]);
    await insertPublishedRule(tenantId, "LEGACY-PBJT", 1, true);

    const response = await quote(ownerClient, outletId);

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe("TAX_RULE_AMBIGUOUS");
  });

  // 1. Repro of the bug: the owner adds their own tenant-wide PBJT next to the
  // default one, publish used to succeed and every quote then failed 409.
  it("1. a second tenant-wide food rule is refused with 409 TAX_RULE_AMBIGUOUS naming PBJT-FNB; nothing is published and quotes still work", async () => {
    const { tenantId, ownerClient, outletId } = await newTenantWithOutlet();
    expect(await publishedCodes(tenantId)).toContain(DEFAULT_CODE);
    const id = await createRule(ownerClient, { code: "CUSTOM-PBJT" });

    const response = await publishRule(ownerClient, id);

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe("TAX_RULE_AMBIGUOUS");
    expect(response.body.error.message).toContain(DEFAULT_CODE);
    expect(await statusOf(id)).toBe("draft");
    expect(await publishedCodes(tenantId)).toEqual([DEFAULT_CODE]);

    const after = await quote(ownerClient, outletId);
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(after.body.data.taxIdr).toBe(10_000);
  });

  // 2. Fix path: switch the old rule off first, then the new one publishes.
  it("2. refused first, then publishing an inactive PBJT-FNB version lets CUSTOM-PBJT publish and quotes use its rate", async () => {
    const { ownerClient, outletId } = await newTenantWithOutlet();
    const customId = await createRule(ownerClient, {
      code: "CUSTOM-PBJT",
      rateBp: 1100,
    });
    const refused = await publishRule(ownerClient, customId);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("TAX_RULE_AMBIGUOUS");

    // The owner publishes v2 of PBJT-FNB with isActive false (tombstone).
    const tombstone = await createRule(ownerClient, {
      code: DEFAULT_CODE,
      isActive: false,
    });
    const tombstoned = await publishRule(ownerClient, tombstone);
    expect(tombstoned.status, JSON.stringify(tombstoned.body)).toBe(200);

    const published = await publishRule(ownerClient, customId);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(await statusOf(customId)).toBe("published");

    const priced = await quote(ownerClient, outletId);
    expect(priced.status, JSON.stringify(priced.body)).toBe(200);
    expect(priced.body.data.taxIdr).toBe(11_000);
  });
});

describe("legend-de3b publishes that do not tie are accepted", () => {
  // The rules below never tie with the default or with each other, so one
  // tenant serves all cases.
  let ctx: Awaited<ReturnType<typeof newTenantWithOutlet>>;
  beforeAll(async () => {
    ctx = await newTenantWithOutlet();
  });

  it("3a. an outlet-scoped rule next to the tenant-wide default", async () => {
    await createAndPublish(ctx.ownerClient, {
      code: "OUTLET-PBJT",
      outletId: ctx.outletId,
    });
  });

  it("3b. an item-level rule next to the item-class default", async () => {
    await createAndPublish(ctx.ownerClient, {
      code: "ITEM-PBJT",
      appliesTo: {
        itemClasses: [],
        categoryIds: [],
        itemIds: [randomUUID()],
      },
    });
  });

  it("3c. rules with different explicit channel sets (dine-in only, takeaway only)", async () => {
    await createAndPublish(ctx.ownerClient, {
      code: "DINEIN-PBJT",
      channels: ["dine_in"],
    });
    await createAndPublish(ctx.ownerClient, {
      code: "TAKEAWAY-PBJT",
      channels: ["takeaway"],
    });
  });

  it("3d. an inactive version never ties", async () => {
    await createAndPublish(ctx.ownerClient, {
      code: "OFF-PBJT",
      isActive: false,
    });
  });

  it("3e. quotes still work after all of the above", async () => {
    const response = await quote(ctx.ownerClient, ctx.outletId, "dine_in");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });
});

describe("legend-de3b concurrent publishes of tying rules", () => {
  it("4. exactly one succeeds, the other gets TAX_RULE_AMBIGUOUS, and it waited on the tenant tax advisory lock", async () => {
    const tenantId = await seedTenant();
    const context = scopeOf(tenantId);
    const first = await createTaxRule(
      context,
      seededUserId,
      draftInput(`RACE-A-${unique()}`.toUpperCase()),
    );
    const second = await createTaxRule(
      context,
      seededUserId,
      draftInput(`RACE-B-${unique()}`.toUpperCase()),
    );

    const helper: PoolClient = await owner.connect();
    let released = false;
    const release = async (action: "COMMIT" | "ROLLBACK") => {
      if (released) return;
      released = true;
      try {
        await helper.query(action);
      } finally {
        helper.release();
      }
    };
    let advisoryStates: boolean[] = [];
    let results: PromiseSettledResult<unknown>[];
    try {
      await helper.query("BEGIN");
      // Blocks every write to tax_rules; reads and row locks still pass.
      await helper.query("LOCK TABLE tax_rules IN SHARE MODE");

      const publishFirst = publishTaxRule(
        context,
        seededUserId,
        first.id,
        `race-${first.id}`,
      );
      // The first publish holds the tenant advisory lock and is parked on its
      // UPDATE of tax_rules.
      await waitFor(
        async () => (await relationWaiters("tax_rules")) >= 1,
        "first publish parked on tax_rules",
      );
      const publishSecond = publishTaxRule(
        context,
        seededUserId,
        second.id,
        `race-${second.id}`,
      );
      // The second publish must wait on the same tenant advisory lock.
      await waitFor(
        async () =>
          (await advisoryLockStates(`tax:provisioning:${tenantId}`)).includes(
            false,
          ),
        "second publish waiting on the advisory lock",
      );
      advisoryStates = await advisoryLockStates(`tax:provisioning:${tenantId}`);

      await release("COMMIT");
      results = await Promise.allSettled([publishFirst, publishSecond]);
    } finally {
      await release("ROLLBACK");
    }

    expect(advisoryStates).toContain(false);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(fulfilled, JSON.stringify(results)).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({
      code: "TAX_RULE_AMBIGUOUS",
      status: 409,
    });
    const { rows } = await owner.query<{ id: string; status: string }>(
      "SELECT id, status FROM tax_rules WHERE tenant_id = $1",
      [tenantId],
    );
    expect(rows.filter((row) => row.status === "published")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "draft")).toHaveLength(1);
  });
});

describe("legend-de3b existing duplicates are listed, not changed", () => {
  type Conflict = {
    ruleA: { id: string; code: string; version: number };
    ruleB: { id: string; code: string; version: number };
    outletId: string | null;
    level: string;
    key: string;
  };
  type ListFn = (
    context: ScopedTenantContext,
    actorUserId: string,
    query: { outletId?: string },
  ) => Promise<{ conflicts: Conflict[] }>;

  async function listConflicts(tenantId: string) {
    // Looked up at run time: the function does not exist before the fix.
    const service = (await import("../services/tax.service.ts")) as Record<
      string,
      unknown
    >;
    const list = service.listTaxRuleConflicts as ListFn | undefined;
    expect(list, "tax.service exports listTaxRuleConflicts").toBeTypeOf(
      "function",
    );
    return (await list!(scopeOf(tenantId), seededUserId, {})).conflicts;
  }

  it("5. two published rules that tie are listed as one pair; after tombstoning one the list is empty", async () => {
    const tenantId = await seedTenant();
    await insertPublishedRule(tenantId, "DUP-A", 1, true);
    await insertPublishedRule(tenantId, "DUP-B", 1, true);

    const conflicts = await listConflicts(tenantId);

    expect(conflicts).toHaveLength(1);
    const [pair] = conflicts;
    expect([pair!.ruleA.code, pair!.ruleB.code].sort()).toEqual([
      "DUP-A",
      "DUP-B",
    ]);
    expect(pair!.outletId).toBeNull();
    expect(pair!.level).toBe("itemClass");
    expect(pair!.key).toBe("food_beverage");

    // Owner switches DUP-B off: an inactive v2 of the same code.
    await insertPublishedRule(tenantId, "DUP-B", 2, false);
    expect(await listConflicts(tenantId)).toEqual([]);
  });
});
