// Discarding tax drafts (legend-woc1): a draft rule or settings version can be
// archived, a published one never can (R21), and tenant isolation holds for the
// archive and settings-draft PATCH paths.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
  idr,
  type TenantId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  archiveTaxRule,
  archiveTaxSettings,
  createTaxRule,
  createTaxSettings,
  publishTaxRule,
  publishTaxSettings,
  updateTaxSettings,
} from "../services/tax.service";

const seeded = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const tenantB = randomUUID() as TenantId;
const userA = randomUUID();
const userB = randomUUID();

function tenantContext(tenantId: TenantId) {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

const today = () => businessDateOf(new Date(), DEFAULT_BUSINESS_DAY_CLOCK);

function ruleInput() {
  return {
    outletId: null,
    code: `ARCH-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    name: "Uji Buang Draf",
    taxType: "pbjt" as const,
    rateBp: 1000,
    regionCode: null,
    channels: [],
    // Item-scoped so a published test rule never matches another test's bill.
    appliesTo: { itemClasses: [], categoryIds: [], itemIds: [randomUUID()] },
    includeServiceInBase: true,
    isActive: true,
    effectiveFrom: today(),
  };
}

function settingsInput() {
  return {
    outletId: null,
    calculationOrder: "discount_service_tax" as const,
    pricesIncludeTax: false,
    serviceRoundingMode: "half_up" as const,
    taxRoundingMode: "half_up" as const,
    inclusiveBaseRoundingMode: "half_up" as const,
    billRounding: null,
    packageAllocation: "fixed_bp" as const,
    effectiveFrom: today(),
  };
}

async function asTenantOwner<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

async function insertUser(id: string, name: string) {
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
    [id, name, `${id}@example.test`],
  );
}

async function grantTenantConfig(tenantId: string, userId: string) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      roleId,
      tenantId,
      `Tax archive ${roleId.slice(0, 8)}`,
      JSON.stringify(["org.tax_config.manage"]),
      JSON.stringify(["tenant"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId],
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Tax archive tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantB, `tax-archive-${tenantB}`, userB],
  );
  await insertUser(userA, "Tax Archive A");
  await insertUser(userB, "Tax Archive B");
  await grantTenantConfig(seeded.id, userA);
  await grantTenantConfig(tenantB, userB);
});

afterAll(async () => {
  await asTenantOwner(tenantB, async (client) => {
    await client.query("DELETE FROM tax_settings WHERE tenant_id = $1", [
      tenantB,
    ]);
    await client.query("DELETE FROM tax_rules WHERE tenant_id = $1", [tenantB]);
    await client.query("DELETE FROM role_assignments WHERE tenant_id = $1", [
      tenantB,
    ]);
    await client.query("DELETE FROM roles WHERE tenant_id = $1", [tenantB]);
  });
  await asTenantOwner(seeded.id, async (client) => {
    await client.query("DELETE FROM role_assignments WHERE user_id = $1", [
      userA,
    ]);
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND name LIKE 'Tax archive %'",
      [seeded.id],
    );
  });
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [[userA, userB]]);
  await owner.end();
});

describe("archive a tax rule draft", () => {
  it("archives a draft and the archived version can no longer be published", async () => {
    const context = tenantContext(seeded.id);
    const draft = await createTaxRule(context, userA, ruleInput());
    const archived = await archiveTaxRule(context, userA, draft.id);
    expect(archived).toMatchObject({ id: draft.id, status: "archived" });

    const publish = await publishTaxRule(
      context,
      userA,
      draft.id,
      "publish-archived-draft",
    ).catch((error: unknown) => error);
    expect(publish).toMatchObject({ code: "TAX_INVALID_TRANSITION" });
  });

  it("refuses to archive a published version: published history is immutable", async () => {
    const context = tenantContext(seeded.id);
    const draft = await createTaxRule(context, userA, ruleInput());
    await publishTaxRule(context, userA, draft.id, "publish-then-archive");
    const error = await archiveTaxRule(context, userA, draft.id).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ status: 409, code: "TAX_RULE_IMMUTABLE" });
  });

  it("TEN-01 another tenant cannot archive this tenant's draft", async () => {
    const draft = await createTaxRule(
      tenantContext(seeded.id),
      userA,
      ruleInput(),
    );
    const error = await archiveTaxRule(
      tenantContext(tenantB),
      userB,
      draft.id,
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 404 });
  });
});

describe("tax settings drafts", () => {
  it("edits a draft, then archives it", async () => {
    const context = tenantContext(seeded.id);
    const draft = await createTaxSettings(context, userA, settingsInput());
    const edited = await updateTaxSettings(context, userA, draft.id, {
      pricesIncludeTax: true,
      billRounding: { incrementIdr: idr(100), mode: "half_up" },
    });
    expect(edited).toMatchObject({
      id: draft.id,
      status: "draft",
      pricesIncludeTax: true,
      billRounding: { incrementIdr: 100, mode: "half_up" },
    });
    const archived = await archiveTaxSettings(context, userA, draft.id);
    expect(archived.status).toBe("archived");
  });

  it("refuses to edit or archive a published settings version", async () => {
    const context = tenantContext(tenantB);
    const draft = await createTaxSettings(context, userB, settingsInput());
    await publishTaxSettings(context, userB, draft.id, "publish-settings");
    const edit = await updateTaxSettings(context, userB, draft.id, {
      pricesIncludeTax: true,
    }).catch((caught: unknown) => caught);
    expect(edit).toMatchObject({ status: 409, code: "TAX_RULE_IMMUTABLE" });
    const archive = await archiveTaxSettings(context, userB, draft.id).catch(
      (caught: unknown) => caught,
    );
    expect(archive).toMatchObject({ status: 409, code: "TAX_RULE_IMMUTABLE" });
  });

  it("TEN-01 another tenant cannot edit or archive this tenant's settings draft", async () => {
    const draft = await createTaxSettings(
      tenantContext(seeded.id),
      userA,
      settingsInput(),
    );
    const edit = await updateTaxSettings(
      tenantContext(tenantB),
      userB,
      draft.id,
      { pricesIncludeTax: true },
    ).catch((caught: unknown) => caught);
    expect(edit).toMatchObject({ status: 404 });
    const archive = await archiveTaxSettings(
      tenantContext(tenantB),
      userB,
      draft.id,
    ).catch((caught: unknown) => caught);
    expect(archive).toMatchObject({ status: 404 });
  });
});
