// Fixed asset register (bead legend-dux2): register code (`FA-nnnnn`, unique
// per tenant + legal entity), tenant asset categories, and the revaluation
// summary (original cost, surplus, loss) derived from the append-only
// `fixed_asset_revaluations` history. Runs the real Express app and PostgreSQL
// against the disposable test DB; every test owns a fresh legal entity.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  tenantIdSchema,
  userIdSchema,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  POSTING_ACCOUNT_ROLES,
  fixedAssetSchema,
} from "@starter/shared/accounting";
import { createApp } from "../app";
import {
  createAssetCategory,
  listAssetCategories,
} from "../services/accounting-asset-categories.service";
import {
  createFixedAsset,
  getFixedAsset,
  listFixedAssets,
  revalueFixedAsset,
  runDepreciation,
} from "../services/accounting-fixed-assets.service";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUserIds: string[] = [];
const otherTenantIds: string[] = [];
const unique = () => randomBytes(4).toString("hex");
const key = (prefix: string) => `${prefix}-${unique()}-${unique()}`;
/** Fixed "now" for service calls: every test date below is in the past. */
const NOW = new Date("2026-11-03T03:00:00Z");
const actor: UserId = userIdSchema.parse(randomUUID());

function tenantScope(tenant = tenantId): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

async function createEntity(name: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id",
    [tenantId, `${name} ${unique()}`],
  );
  return rows[0]!.id;
}

/** Chart + posting-role mappings that depreciation and revaluation post through. */
async function setupLedger(entity: string): Promise<void> {
  const rows: [string, string, string, string, string][] = [
    ["fixed_assets", "1501", "Aset Tetap", "asset", "non_current_asset"],
    [
      "accumulated_depreciation",
      "1502",
      "Akumulasi Penyusutan",
      "asset",
      "non_current_asset",
    ],
    ["revaluation_surplus", "3201", "Surplus Revaluasi", "equity", "equity"],
    [
      "depreciation_expense",
      "6101",
      "Beban Penyusutan",
      "expense",
      "operating_expense",
    ],
    [
      "asset_revaluation_loss",
      "6102",
      "Rugi Revaluasi",
      "expense",
      "other_expense",
    ],
  ];
  for (const [role, code, label, type, group] of rows) {
    const { rows: inserted } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, entity, code, label, type, group],
    );
    if (!(role in POSTING_ACCOUNT_ROLES)) continue;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, entity, role, inserted[0]!.id],
    );
  }
}

async function asset(
  entity: string,
  input: Partial<{
    code: string;
    categoryId: string | null;
    name: string;
    costIdr: number;
  }> = {},
  context = tenantScope(),
) {
  return createFixedAsset(
    context,
    {
      legalEntityId: entity,
      outletId: outletA,
      name: "Mesin espresso",
      acquiredOn: "2026-01-05",
      costIdr: 12_000_000,
      residualValueIdr: 0,
      usefulLifeMonths: 12,
      depreciationStartPeriod: "2026-01",
      sourceDocumentId: null,
      idempotencyKey: key("fa"),
      ...input,
    },
    actor,
    NOW,
  );
}

const revalue = (
  fixedAssetId: string,
  revaluedOn: string,
  newCarryingAmountIdr: number,
) =>
  revalueFixedAsset(
    tenantScope(),
    fixedAssetId,
    {
      revaluedOn,
      newCarryingAmountIdr,
      reason: "Penilaian KJPP",
      idempotencyKey: key("reval"),
    },
    actor,
    NOW,
  );

const category = (name = `Kategori ${unique()}`, context = tenantScope()) =>
  createAssetCategory(context, { name }, actor);

async function financeUser() {
  const client = agent(app);
  await signUp(client, "Finance register");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'finance'",
    [tenantId],
  );
  if (!rows[0]) throw new Error("No finance role template");
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, userId, rows[0].id],
  );
  return client;
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  if (otherTenantIds.length > 0) {
    for (const table of ["fixed_assets", "asset_categories", "legal_entities"])
      await owner.query(
        `DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`,
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

describe("legend-dux2 asset register code", () => {
  it("assigns the next FA-nnnnn per entity; another entity starts again at 00001", async () => {
    const entityA = await createEntity("Register A");
    const entityB = await createEntity("Register B");
    expect((await asset(entityA)).code).toBe("FA-00001");
    expect((await asset(entityA)).code).toBe("FA-00002");
    expect((await asset(entityB)).code).toBe("FA-00001");
    // An empty code means "generate", same as omitting it.
    expect((await asset(entityA, { code: "  " })).code).toBe("FA-00003");
  });

  it("keeps a supplied code, continues after it, and rejects a duplicate inside the entity only", async () => {
    const entityA = await createEntity("Register code A");
    const entityB = await createEntity("Register code B");
    const custom = await asset(entityA, { code: "  MESIN-01 " });
    expect(custom.code).toBe("MESIN-01");
    expect((await asset(entityA, { code: "FA-00010" })).code).toBe("FA-00010");
    expect((await asset(entityA)).code).toBe("FA-00011");
    await expect(asset(entityA, { code: "MESIN-01" })).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
    });
    // The same code is free in another entity.
    expect((await asset(entityB, { code: "MESIN-01" })).code).toBe("MESIN-01");
    const { rows } = await owner.query(
      "SELECT 1 FROM fixed_assets WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantId, entityA],
    );
    expect(rows).toHaveLength(3);
  });

  it("gives concurrent registrations distinct codes (advisory lock, no unique-violation 500)", async () => {
    const entity = await createEntity("Register race");
    const created = await Promise.all(
      Array.from({ length: 5 }, () => asset(entity)),
    );
    expect(new Set(created.map((row) => row.code)).size).toBe(5);
    expect(created.map((row) => row.code).sort()).toEqual([
      "FA-00001",
      "FA-00002",
      "FA-00003",
      "FA-00004",
      "FA-00005",
    ]);
  });

  it("rejects an over-long code and an unknown field at the contract", async () => {
    const entity = await createEntity("Register strict");
    await expect(asset(entity, { code: "X".repeat(41) })).rejects.toMatchObject(
      { name: "ZodError" },
    );
    await expect(
      createFixedAsset(
        tenantScope(),
        {
          legalEntityId: entity,
          outletId: null,
          name: "x",
          acquiredOn: "2026-01-05",
          costIdr: 1,
          residualValueIdr: 0,
          usefulLifeMonths: 12,
          depreciationStartPeriod: "2026-01",
          sourceDocumentId: null,
          idempotencyKey: key("fa"),
          categoryName: "smuggled",
        },
        actor,
        NOW,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});

describe("legend-dux2 asset categories", () => {
  it("creates and lists tenant categories; a name is unique ignoring case", async () => {
    const name = `Kendaraan ${unique()}`;
    const created = await category(name);
    expect(created).toMatchObject({ tenantId, name });
    await expect(category(name.toUpperCase())).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
    });
    const { data } = await listAssetCategories(tenantScope());
    expect(data.map((row) => row.id)).toContain(created.id);
  });

  it("links an asset to a category and shows its name; another tenant's or an unknown category is refused", async () => {
    const entity = await createEntity("Register category");
    const mine = await category();
    const linked = await asset(entity, { categoryId: mine.id });
    expect(linked.categoryId).toBe(mine.id);
    expect(linked.categoryName).toBe(mine.name);
    const plain = await asset(entity);
    expect(plain.categoryId).toBeNull();
    expect(plain.categoryName).toBeNull();

    const otherTenant = tenantIdSchema.parse(randomUUID());
    const foreignCategory = randomUUID();
    otherTenantIds.push(otherTenant);
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Register other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [otherTenant, `reg-${unique()}`, tenantId],
    );
    await owner.query(
      "INSERT INTO asset_categories (id, tenant_id, name) VALUES ($1, $2, 'Kategori lain')",
      [foreignCategory, otherTenant],
    );
    for (const categoryId of [foreignCategory, randomUUID()])
      await expect(asset(entity, { categoryId })).rejects.toMatchObject({
        status: 404,
        code: "NOT_FOUND",
      });
    // Tenant isolation: the foreign category never shows in this tenant's list.
    const { data } = await listAssetCategories(tenantScope());
    expect(data.map((row) => row.id)).not.toContain(foreignCategory);
    expect(
      (await listAssetCategories(tenantScope(otherTenant))).data.map(
        (row) => row.name,
      ),
    ).toEqual(["Kategori lain"]);

    const detail = await getFixedAsset(tenantScope(), linked.id);
    expect(detail.asset.categoryName).toBe(mine.name);
    const listed = await listFixedAssets(tenantScope(), entity);
    const byId = new Map(listed.data.map((row) => [row.id, row]));
    expect(byId.get(linked.id)?.categoryName).toBe(mine.name);
    expect(byId.get(plain.id)?.categoryName).toBeNull();
  });
});

describe("legend-dux2 revaluation summary", () => {
  it("shows surplus above cost after an upward revaluation (list and get)", async () => {
    const entity = await createEntity("Register surplus");
    await setupLedger(entity);
    const revalued = await asset(entity);
    const untouched = await asset(entity);
    await runDepreciation(
      tenantScope(),
      { legalEntityId: entity, period: "2026-01", idempotencyKey: key("run") },
      actor,
      NOW,
    );
    await runDepreciation(
      tenantScope(),
      { legalEntityId: entity, period: "2026-02", idempotencyKey: key("run") },
      actor,
      NOW,
    );
    // Carrying 12M − 2M = 10M; new carrying 15M: surplus 5M, cost restated.
    const result = await revalue(revalued.id, "2026-02-25", 15_000_000);
    expect(result.costIdr).toBe(15_000_000);
    expect(result.originalCostIdr).toBe(12_000_000);
    expect(result.revaluationSurplusIdr).toBe(5_000_000);
    expect(result.revaluationLossIdr).toBe(0);

    const detail = await getFixedAsset(tenantScope(), revalued.id);
    expect(detail.asset.costIdr).toBeGreaterThan(detail.asset.originalCostIdr);
    expect(detail.asset.revaluationSurplusIdr).toBe(5_000_000);

    const listed = await listFixedAssets(tenantScope(), entity);
    const byId = new Map(listed.data.map((row) => [row.id, row]));
    expect(byId.get(revalued.id)).toMatchObject({
      costIdr: 15_000_000,
      originalCostIdr: 12_000_000,
      revaluationSurplusIdr: 5_000_000,
      revaluationLossIdr: 0,
    });
    // Never revalued: original cost is the cost, nothing to report.
    expect(byId.get(untouched.id)).toMatchObject({
      costIdr: 12_000_000,
      originalCostIdr: 12_000_000,
      revaluationSurplusIdr: 0,
      revaluationLossIdr: 0,
    });
    for (const row of listed.data) fixedAssetSchema.parse(row);
  });

  it("shows a loss after a downward revaluation, and sums surplus and loss over several revaluations", async () => {
    const entity = await createEntity("Register loss");
    await setupLedger(entity);
    const down = await asset(entity);
    // Jan depreciation 1M is caught up first: carrying 11M → 9M is a 2M loss.
    const lossOnly = await revalue(down.id, "2026-01-25", 9_000_000);
    expect(lossOnly.revaluationLossIdr).toBe(2_000_000);
    expect(lossOnly.revaluationSurplusIdr).toBe(0);
    expect(lossOnly.originalCostIdr).toBe(12_000_000);
    expect(lossOnly.costIdr).toBe(9_000_000);

    const both = await asset(entity);
    await revalue(both.id, "2026-02-25", 15_000_000);
    // March catch-up: 15M over the 10 remaining months, 1.5M; carrying 13.5M.
    const second = await revalue(both.id, "2026-03-25", 10_000_000);
    expect(second.originalCostIdr).toBe(12_000_000);
    // First revaluation: Jan + Feb depreciation (2M) left carrying 10M → 15M.
    expect(second.revaluationSurplusIdr).toBe(5_000_000);
    expect(second.revaluationLossIdr).toBe(3_500_000);
    expect(second.costIdr).toBe(10_000_000);
  });
});

describe("legend-dux2 HTTP", () => {
  it("lists and creates categories with the right permissions; a duplicate name is 409", async () => {
    const anonymous = agent(app);
    expect(
      (await anonymous.get("/api/accounting/asset-categories")).status,
    ).toBe(401);
    const stranger = agent(app);
    await signUp(stranger, "No accounting role");
    const session = await stranger.get("/api/auth/get-session");
    createdUserIds.push(session.body.user.id as string);
    expect(
      (await stranger.get("/api/accounting/asset-categories")).status,
    ).toBe(403);
    expect(
      (
        await stranger
          .post("/api/accounting/asset-categories")
          .set(originHeader)
          .send({ name: "Tanpa izin" })
      ).status,
    ).toBe(403);

    const finance = await financeUser();
    const name = `Peralatan ${unique()}`;
    const created = await finance
      .post("/api/accounting/asset-categories")
      .set(originHeader)
      .send({ name });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ tenantId, name });
    expect(
      (
        await finance
          .post("/api/accounting/asset-categories")
          .set(originHeader)
          .send({ name: name.toLowerCase() })
      ).status,
    ).toBe(409);
    // Strict body: tenantId cannot be smuggled (TEN-02).
    expect(
      (
        await finance
          .post("/api/accounting/asset-categories")
          .set(originHeader)
          .send({ name: `${name} 2`, tenantId: randomUUID() })
      ).status,
    ).toBe(422);
    const listed = await finance.get("/api/accounting/asset-categories");
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((row: { id: string }) => row.id)).toContain(
      created.body.data.id,
    );
  });

  it("creates an asset over HTTP with a generated code and a category", async () => {
    const entity = await createEntity("Register HTTP");
    const finance = await financeUser();
    const mine = await category();
    const response = await finance
      .post("/api/accounting/fixed-assets")
      .set(originHeader)
      .send({
        legalEntityId: entity,
        outletId: null,
        name: "Freezer",
        acquiredOn: "2026-01-05",
        costIdr: 6_000_000,
        residualValueIdr: 0,
        usefulLifeMonths: 12,
        depreciationStartPeriod: "2026-01",
        sourceDocumentId: null,
        categoryId: mine.id,
        idempotencyKey: key("fa"),
      });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      code: "FA-00001",
      categoryId: mine.id,
      categoryName: mine.name,
      originalCostIdr: 6_000_000,
    });
    const duplicate = await finance
      .post("/api/accounting/fixed-assets")
      .set(originHeader)
      .send({
        legalEntityId: entity,
        outletId: null,
        name: "Freezer 2",
        code: "FA-00001",
        acquiredOn: "2026-01-05",
        costIdr: 6_000_000,
        residualValueIdr: 0,
        usefulLifeMonths: 12,
        depreciationStartPeriod: "2026-01",
        sourceDocumentId: null,
        idempotencyKey: key("fa"),
      });
    expect(duplicate.status).toBe(409);
  });
});
