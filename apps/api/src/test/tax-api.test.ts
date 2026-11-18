// Tax configuration, preview and PBJT recap API (PRD v1.7 §3.14 F11/F14, D13;
// ORD-03; bead legend-559). HTTP tests run the real Express app, Better Auth,
// the RBAC resolver and PostgreSQL against the seeded Cafe Legend tenant.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  calculateTax,
  cafeLegendTaxFixtures,
  type TaxCalculationResult,
} from "@starter/shared/tax";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { recordTaxSnapshots } from "../services/tax.service";
import {
  createIsolatedTenant,
  owner as fixtureOwner,
} from "./floor-test-helpers";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outlet, secondOutlet] = cafeLegendPlatformFixtures.outlets;
const taxFixtures = cafeLegendTaxFixtures;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUsers: string[] = [];

/** Today's business date in the outlet time zone, as the API computes it. */
const today = () => businessDateOf(new Date(), DEFAULT_BUSINESS_DAY_CLOCK);

async function signedInClient(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

/** The seeded Owner template: every tenant permission except platform tools. */
async function ownerClient() {
  const { client, userId } = await signedInClient("Tax Owner");
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenant.id, userId],
  );
  return { client, userId };
}

/** A custom role with exactly the given catalog codes. */
async function grantRole(
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenant.id,
      `Tax test ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify([scope.type]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenant.id,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
  return roleId;
}

const code = () =>
  `UITEST-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;

function ruleBody(overrides: Record<string, unknown> = {}) {
  return {
    outletId: null,
    code: code(),
    name: "Uji PBJT",
    taxType: "pbjt",
    rateBp: 1000,
    regionCode: "ID-JB-3273",
    channels: [],
    // Item-scoped: a published test rule must not make the fixture bill
    // ambiguous for other rules in the same tenant (engine fails closed).
    appliesTo: { itemClasses: [], categoryIds: [], itemIds: [randomUUID()] },
    includeServiceInBase: true,
    isActive: true,
    effectiveFrom: today(),
    ...overrides,
  };
}

function serviceChargeBody(overrides: Record<string, unknown> = {}) {
  return {
    outletId: outlet.id,
    code: code(),
    name: "Uji Service",
    rateBp: 500,
    // A dedicated zone: the fixture bill's Private Room rule must stay the one
    // that applies to it.
    zoneId: randomUUID(),
    orderTypes: ["dine_in"],
    itemClasses: ["food_beverage"],
    isActive: true,
    effectiveFrom: today(),
    ...overrides,
  };
}

function settingsBody(overrides: Record<string, unknown> = {}) {
  return {
    outletId: outlet.id,
    calculationOrder: "discount_service_tax",
    pricesIncludeTax: false,
    serviceRoundingMode: "half_up",
    taxRoundingMode: "half_up",
    inclusiveBaseRoundingMode: "half_up",
    billRounding: null,
    packageAllocation: "fixed_bp",
    effectiveFrom: today(),
    ...overrides,
  };
}

/** The fixture bill, recalculated by the shared engine: the expected numbers. */
const expectedPreview: TaxCalculationResult = calculateTax(
  taxFixtures.privateRoomBill,
  {
    taxRules: taxFixtures.taxRules,
    serviceChargeRules: taxFixtures.serviceChargeRules,
    settings: taxFixtures.settings,
  },
);

afterAll(async () => {
  if (createdUsers.length > 0) {
    await owner.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
      createdUsers,
    ]);
    await owner.query(
      "DELETE FROM roles WHERE name LIKE 'Tax test %' AND tenant_id = $1",
      [tenant.id],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  }
  await owner.end();
  await fixtureOwner.end();
});

describe("Tax API authorization", () => {
  it("answers 401 without a session and 403 without the permission", async () => {
    expect((await agent(app).get("/api/tax/rules")).status).toBe(401);

    const plain = await signedInClient("Tanpa Peran");
    const denied = await plain.client.get("/api/tax/rules");
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("PERMISSION_DENIED");
  });

  it("D13 keeps configuration and the PBJT report on separate permissions", async () => {
    const configOnly = await signedInClient("Config Only");
    await grantRole(configOnly.userId, ["org.tax_config.manage"], {
      type: "tenant",
    });
    expect((await configOnly.client.get("/api/tax/rules")).status).toBe(200);
    const denied = await configOnly.client.get(
      `/api/tax/reports/pbjt?outletId=${outlet.id}&period=2026-11`,
    );
    expect(denied.status).toBe(403);

    const reportOnly = await signedInClient("Report Only");
    await grantRole(reportOnly.userId, ["accounting.tax_report.manage"], {
      type: "tenant",
    });
    expect((await reportOnly.client.get("/api/tax/rules")).status).toBe(403);
    expect(
      (
        await reportOnly.client.get(
          `/api/tax/reports/pbjt?outletId=${outlet.id}&period=2026-11`,
        )
      ).status,
    ).toBe(200);
  });
});

describe("F11 versioned tax rules", () => {
  it("creates a draft that inherits exclusive prices, edits it, then publishes", async () => {
    const { client } = await ownerClient();
    const body = ruleBody();
    const created = await client
      .post("/api/tax/rules")
      .set(originHeader)
      .send(body);
    expect(created.status).toBe(201);
    expect(created.headers.location).toBe(
      `/api/tax/rules/${created.body.data.id}`,
    );
    expect(created.body.data).toMatchObject({
      code: body.code,
      version: 1,
      status: "draft",
      // Owner decision (2026-11-01): the default is exclusive; the rule
      // inherits it from the published calculation settings.
      priceIncludesTax: false,
      publishedAt: null,
      publishedBy: null,
    });

    const patched = await client
      .patch(`/api/tax/rules/${created.body.data.id}`)
      .set(originHeader)
      .send({ rateBp: 900, name: "Uji PBJT 9%" });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ rateBp: 900, status: "draft" });

    const published = await client
      .post(`/api/tax/rules/${created.body.data.id}/publish`)
      .set(originHeader)
      .send({ idempotencyKey: "publish-tax-rule-1" });
    expect(published.status).toBe(200);
    expect(published.body.data.status).toBe("published");
    expect(published.body.data.publishedBy).not.toBeNull();

    // R21: a published version is immutable; a retry returns it, no second
    // version or event.
    const again = await client
      .post(`/api/tax/rules/${created.body.data.id}/publish`)
      .set(originHeader)
      .send({ idempotencyKey: "publish-tax-rule-2" });
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(created.body.data.id);
    const blocked = await client
      .patch(`/api/tax/rules/${created.body.data.id}`)
      .set(originHeader)
      .send({ rateBp: 800 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("TAX_RULE_IMMUTABLE");

    // A change is a new version of the same code.
    const next = await client
      .post("/api/tax/rules")
      .set(originHeader)
      .send({ ...body, rateBp: 1100 });
    expect(next.status).toBe(201);
    expect(next.body.data.version).toBe(2);
    expect(next.body.data.status).toBe("draft");
  });

  it("R21 refuses a backdated publish but allows a future-dated draft", async () => {
    const { client } = await ownerClient();
    const created = await client
      .post("/api/tax/rules")
      .set(originHeader)
      .send(ruleBody({ effectiveFrom: "2026-01-01" }));
    expect(created.status).toBe(201);
    const published = await client
      .post(`/api/tax/rules/${created.body.data.id}/publish`)
      .set(originHeader)
      .send({ idempotencyKey: "publish-backdated" });
    expect(published.status).toBe(422);
    expect(published.body.error.code).toBe("TAX_RULE_BACKDATED");
  });

  it("lists versions with a keyset cursor and filters by code", async () => {
    const { client } = await ownerClient();
    const body = ruleBody({ effectiveFrom: today() });
    const first = await client
      .post("/api/tax/rules")
      .set(originHeader)
      .send(body);
    await client
      .post("/api/tax/rules")
      .set(originHeader)
      .send({ ...body, rateBp: 1200 });
    const listed = await client.get(`/api/tax/rules?code=${body.code}&limit=1`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.meta.nextCursor).toEqual(expect.any(String));
    const rest = await client.get(
      `/api/tax/rules?code=${body.code}&limit=1&cursor=${listed.body.meta.nextCursor}`,
    );
    expect(rest.body.data).toHaveLength(1);
    expect(rest.body.meta.nextCursor).toBeNull();
    expect(new Set([listed.body.data[0].id, rest.body.data[0].id]).size).toBe(
      2,
    );
    expect(first.body.data.version).toBe(1);

    const tampered = await client.get("/api/tax/rules?cursor=not-a-cursor");
    expect(tampered.status).toBe(422);
    expect(tampered.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("validates bodies strictly: tenant fields and out-of-range rates are refused", async () => {
    const { client } = await ownerClient();
    const withTenant = await client
      .post("/api/tax/rules")
      .set(originHeader)
      .send({ ...ruleBody(), tenantId: tenant.id });
    expect(withTenant.status).toBe(422);
    expect(withTenant.body.error.code).toBe("VALIDATION_ERROR");

    const badRate = await client
      .post("/api/tax/rules")
      .set(originHeader)
      .send(ruleBody({ rateBp: 20_000 }));
    expect(badRate.status).toBe(422);
  });
});

describe("F11 service-charge rules and calculation settings", () => {
  it("publishes a zone service-charge rule", async () => {
    const { client } = await ownerClient();
    const created = await client
      .post("/api/tax/service-charge-rules")
      .set(originHeader)
      .send(serviceChargeBody());
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: "draft", version: 1 });
    const published = await client
      .post(`/api/tax/service-charge-rules/${created.body.data.id}/publish`)
      .set(originHeader)
      .send({ idempotencyKey: "publish-service-charge-1" });
    expect(published.status).toBe(200);
    expect(published.body.data.status).toBe("published");
  });

  it("publishes a new calculation-settings version", async () => {
    const { client } = await ownerClient();
    // Effective tomorrow: publishing it must not change today's preview, which
    // the fixture bill asserts against the seeded configuration.
    const tomorrow = businessDateOf(
      new Date(Date.now() + 86_400_000),
      DEFAULT_BUSINESS_DAY_CLOCK,
    );
    const created = await client
      .post("/api/tax/settings")
      .set(originHeader)
      .send(
        settingsBody({
          billRounding: { incrementIdr: 100, mode: "half_up" },
          effectiveFrom: tomorrow,
        }),
      );
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      status: "draft",
      billRounding: { incrementIdr: 100, mode: "half_up" },
    });
    const published = await client
      .post(`/api/tax/settings/${created.body.data.id}/publish`)
      .set(originHeader)
      .send({ idempotencyKey: "publish-tax-settings-1" });
    expect(published.status).toBe(200);
    expect(published.body.data.status).toBe("published");
    const listed = await client.get(`/api/tax/settings?limit=100`);
    expect(listed.status).toBe(200);
    expect(
      listed.body.data.some(
        (row: { id: string }) => row.id === created.body.data.id,
      ),
    ).toBe(true);
  });
});

describe("ORD-03 server-side calculation preview", () => {
  it("returns the shared engine's numbers for the Private Room bill", async () => {
    const { client } = await ownerClient();
    const response = await client
      .post("/api/tax/preview")
      .set(originHeader)
      .send(taxFixtures.privateRoomBill);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(expectedPreview);
    // The guest-visible amounts: 10% PBJT on the discounted net + Private
    // Room 5% service charge, exactly as the contract fixture calculated.
    expect(response.body.data.serviceChargeIdr).toBe(
      expectedPreview.serviceChargeIdr,
    );
    expect(response.body.data.taxIdr).toBe(expectedPreview.taxIdr);
  });

  it("ORD-03 refuses a client-supplied total in the body", async () => {
    const { client } = await ownerClient();
    const response = await client
      .post("/api/tax/preview")
      .set(originHeader)
      .send({ ...taxFixtures.privateRoomBill, totalIdr: 1 });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("ORD-03 fails closed when no rule matches the line's region", async () => {
    const { client, userId } = await signedInClient("Tax isolated preview");
    const isolated = await createIsolatedTenant(
      `tax-${randomUUID().slice(0, 8)}`,
    );
    const overlappingRuleIds = [randomUUID(), randomUUID()];
    const isolatedRuleId = randomUUID();
    const settingsId = randomUUID();
    const bill = {
      ...taxFixtures.privateRoomBill,
      outletId: isolated.outletId,
      zoneId: null,
    };
    try {
      await owner.query(
        "UPDATE roles SET permissions = $1 WHERE tenant_id = $2 AND id = $3",
        [
          JSON.stringify(["org.tax_config.manage"]),
          isolated.tenantId,
          isolated.roleId,
        ],
      );
      await owner.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
         VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
        [isolated.tenantId, userId, isolated.roleId],
      );
      await owner.query(
        `INSERT INTO tax_settings
           (id, tenant_id, outlet_id, calculation_order, prices_include_tax,
            service_rounding_mode, tax_rounding_mode, inclusive_base_rounding_mode,
            bill_rounding, package_allocation, version, effective_from, status,
            published_at, published_by)
         VALUES ($1, $2, NULL, 'discount_service_tax', false,
                 'half_up', 'half_up', 'half_up', NULL, 'fixed_bp', 1,
                 '2026-01-01', 'published', now(), $3)`,
        [settingsId, isolated.tenantId, userId],
      );
      await owner.query(
        `INSERT INTO tax_rules
           (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code,
            channels, applies_to, price_includes_tax, include_service_in_base,
            is_active, version, effective_from, status, published_at, published_by)
         VALUES ($1, $2, NULL, $3, 'Regional preview rule', 'pbjt', 1000, $4,
                 '[]', '{"itemClasses":["food_beverage","facility"],"categoryIds":[],"itemIds":[]}',
                 false, true, true, 1, '2026-01-01', 'published', now(), $5)`,
        [isolatedRuleId, isolated.tenantId, code(), bill.regionCode, userId],
      );
      // Finance suites publish tenant-wide PBJT rules on the shared seed.
      // Keep that realistic overlap present while exercising the missing rule.
      for (const id of overlappingRuleIds) {
        await owner.query(
          `INSERT INTO tax_rules
             (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code,
              channels, applies_to, price_includes_tax, include_service_in_base,
              is_active, version, effective_from, status, published_at, published_by)
           VALUES ($1, $2, NULL, $3, 'PBJT overlap regression', 'pbjt', 1000, NULL,
                   '[]', '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
                   false, true, true, 1, '2026-01-01', 'published', now(), $4)`,
          [id, cafeLegendPlatformFixtures.tenant.id, code(), userId],
        );
      }
      const control = await client
        .post("/api/tax/preview")
        .set(originHeader)
        .set("Host", isolated.hostname)
        .send(bill);
      expect(control.status).toBe(200);
      const response = await client
        .post("/api/tax/preview")
        .set(originHeader)
        .set("Host", isolated.hostname)
        .send({ ...bill, regionCode: "ID-JK" });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe("TAX_RULE_NOT_FOUND");
    } finally {
      await owner.query("DELETE FROM tax_rules WHERE id = ANY($1::uuid[])", [
        [...overlappingRuleIds, isolatedRuleId],
      ]);
      await owner.query("DELETE FROM tax_settings WHERE id = $1", [settingsId]);
      await owner.query("DELETE FROM role_assignments WHERE tenant_id = $1", [
        isolated.tenantId,
      ]);
      await owner.query("DELETE FROM roles WHERE tenant_id = $1", [
        isolated.tenantId,
      ]);
      await owner.query("DELETE FROM tenant_domains WHERE tenant_id = $1", [
        isolated.tenantId,
      ]);
      await owner.query("DELETE FROM outlets WHERE id = $1", [
        isolated.outletId,
      ]);
      await owner.query("DELETE FROM brands WHERE id = $1", [isolated.brandId]);
      await owner.query("DELETE FROM legal_entities WHERE id = $1", [
        isolated.legalEntityId,
      ]);
      await owner.query("DELETE FROM tenants WHERE id = $1", [
        isolated.tenantId,
      ]);
    }
  });
});

describe("F11 PBJT monthly recap", () => {
  async function recordBill(): Promise<{
    period: string;
    result: TaxCalculationResult;
  }> {
    const context = establishContext();
    // The second outlet has no service-charge rule, so its own calculation is
    // what a sale there would record. Keeping this test on its own outlet also
    // isolates its period totals from bills other tests record.
    const bill = {
      ...taxFixtures.privateRoomBill,
      outletId: secondOutlet.id,
      zoneId: null,
    };
    const result = calculateTax(bill, {
      taxRules: taxFixtures.taxRules,
      serviceChargeRules: taxFixtures.serviceChargeRules,
      settings: taxFixtures.settings,
    });
    await withTenant(db, context, (tx) =>
      recordTaxSnapshots(tx, context, {
        sourceType: "order",
        sourceId: randomUUID(),
        outletId: secondOutlet.id,
        businessDate: bill.businessDate,
        result,
      }),
    );
    return { period: bill.businessDate.slice(0, 7), result };
  }

  function establishContext() {
    return establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenant.id,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
  }

  it("sums the recorded sales per rule for the period and outlet", async () => {
    const { client } = await ownerClient();
    const { period, result } = await recordBill();
    const response = await client.get(
      `/api/tax/reports/pbjt?outletId=${secondOutlet.id}&period=${period}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      tenantId: tenant.id,
      outletId: secondOutlet.id,
      period,
      regionCode: "ID-JB-3273",
    });
    const rows = response.body.data.rows as {
      taxRuleCode: string;
      taxIdr: number;
      taxBaseIdr: number;
    }[];
    expect(rows.map((row) => row.taxRuleCode).sort()).toEqual([
      "PBJT-FASILITAS",
      "PBJT-FNB",
    ]);
    expect(rows.reduce((total, row) => total + row.taxIdr, 0)).toBe(
      result.taxIdr,
    );
    expect(response.body.data.totalTaxIdr).toBe(result.taxIdr);
    expect(response.body.data.totalTaxBaseIdr).toBe(
      rows.reduce((total, row) => total + row.taxBaseIdr, 0),
    );
  });

  it("returns an empty recap for a period without sales", async () => {
    const { client } = await ownerClient();
    const response = await client.get(
      `/api/tax/reports/pbjt?outletId=${outlet.id}&period=2020-01`,
    );
    expect(response.status).toBe(200);
    expect(response.body.data.rows).toEqual([]);
    expect(response.body.data.totalTaxIdr).toBe(0);
    expect(response.body.data.totalTaxBaseIdr).toBe(0);
  });
});
