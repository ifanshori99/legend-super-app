// Tax service isolation and side effects (TEN-01/02/03, PRD R21; bead
// legend-559). Service-level tests mint contexts the way the API middleware
// does, so they can prove the second authorization layer (permission on the
// row's target + outlet reach) and the cross-tenant wall that RLS adds on top.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateOf,
  idr,
  outletIdSchema,
  type TenantId,
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
import { db } from "../db";
import { auditLogs, domainEventOutbox } from "../db/schema";
import { withTenant } from "../db/tenant";
import {
  createTaxRule,
  listTaxRules,
  previewTaxCalculation,
  publishTaxRule,
  recordTaxSnapshots,
  updateTaxRule,
} from "../services/tax.service";

const seeded = cafeLegendPlatformFixtures.tenant;
const [outletA, outletB] = cafeLegendPlatformFixtures.outlets;
const taxFixtures = cafeLegendTaxFixtures;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const tenantB = randomUUID() as TenantId;
const userA = randomUUID();
const userAAdmin = randomUUID();
const userB = randomUUID();

function tenantContext(tenantId: TenantId) {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

function outletContext(tenantId: TenantId, outletId: string) {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );
}

function ruleInput(overrides: Record<string, unknown> = {}) {
  return {
    outletId: null,
    code: `UITEST-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    name: "Uji Isolasi",
    taxType: "pbjt" as const,
    rateBp: 1000,
    regionCode: null,
    channels: [],
    // Item-scoped so a published isolation rule never matches the Cafe Legend
    // fixture bill another test file previews in the same database.
    appliesTo: {
      itemClasses: [],
      categoryIds: [],
      itemIds: [randomUUID()],
    },
    includeServiceInBase: true,
    isActive: true,
    // R21: a version may not be published before today (outlet business date).
    effectiveFrom: businessDateOf(new Date()),
    ...overrides,
  };
}

/** Runs `run` as the migration owner with the tenant context RLS requires. */
async function asTenantOwner<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      tenantId,
    ]);
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

/** A custom role in `tenantId` with the given catalog codes. */
async function grantRole(
  tenantId: string,
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      roleId,
      tenantId,
      `Tax isolation ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify([scope.type]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenantId,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Tax isolation tenant', 'lengkap', 'active', 'shared', '{"modules":[]}', '{}', $3)`,
    [tenantB, `tax-${tenantB}`, userB],
  );
  await insertUser(userA, "Tax A");
  await insertUser(userAAdmin, "Tax A Admin");
  await insertUser(userB, "Tax B");
  // Tenant A: an outlet-scoped config role on outlet A only, and a separate
  // tenant-level administrator for the listing assertions.
  await grantRole(seeded.id, userA, ["org.tax_config.manage"], {
    type: "outlet",
    id: outletA.id,
  });
  await grantRole(
    seeded.id,
    userAAdmin,
    ["org.tax_config.manage", "accounting.tax_report.manage"],
    { type: "tenant" },
  );
  // Tenant B: tenant-level config and report.
  await grantRole(
    tenantB,
    userB,
    ["org.tax_config.manage", "accounting.tax_report.manage"],
    { type: "tenant" },
  );
});

afterAll(async () => {
  await asTenantOwner(tenantB, async (client) => {
    await client.query("DELETE FROM tax_snapshots WHERE tenant_id = $1", [
      tenantB,
    ]);
    await client.query("DELETE FROM tax_settings WHERE tenant_id = $1", [
      tenantB,
    ]);
    await client.query(
      "DELETE FROM service_charge_rules WHERE tenant_id = $1",
      [tenantB],
    );
    await client.query("DELETE FROM tax_rules WHERE tenant_id = $1", [tenantB]);
    await client.query("DELETE FROM role_assignments WHERE tenant_id = $1", [
      tenantB,
    ]);
    await client.query("DELETE FROM roles WHERE tenant_id = $1", [tenantB]);
  });
  await asTenantOwner(seeded.id, async (client) => {
    await client.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
      [userA, userAAdmin],
    ]);
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND name LIKE 'Tax isolation %'",
      [seeded.id],
    );
  });
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [
    [userA, userAAdmin, userB],
  ]);
  await owner.end();
});

describe("TEN-03 service-layer permission and outlet reach", () => {
  it("an outlet-scoped grant manages its own outlet's rule, not another outlet's or a tenant-wide one", async () => {
    const context = outletContext(seeded.id, outletA.id);
    const mine = await createTaxRule(context, userA, {
      ...ruleInput(),
      outletId: outletIdSchema.parse(outletA.id),
    });
    expect(mine.outletId).toBe(outletA.id);

    const otherOutlet = await createTaxRule(tenantContext(seeded.id), userA, {
      ...ruleInput(),
      outletId: outletIdSchema.parse(outletB.id),
    }).catch((error: unknown) => error);
    expect(otherOutlet).toMatchObject({ status: 403, code: "FORBIDDEN" });

    const tenantWide = await createTaxRule(tenantContext(seeded.id), userA, {
      ...ruleInput(),
    }).catch((error: unknown) => error);
    expect(tenantWide).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  it("TEN-01 keeps another tenant's rules invisible and unreachable", async () => {
    const ruleB = await createTaxRule(
      tenantContext(tenantB),
      userB,
      ruleInput(),
    );
    expect(ruleB.tenantId).toBe(tenantB);

    const listed = await listTaxRules(tenantContext(seeded.id), userAAdmin, {
      limit: 100,
      code: ruleB.code,
    });
    expect(listed.data).toEqual([]);

    const update = await updateTaxRule(
      tenantContext(seeded.id),
      userAAdmin,
      ruleB.id,
      { name: "Cross-tenant" },
    ).catch((error: unknown) => error);
    expect(update).toMatchObject({ status: 404 });
  });

  it("TEN-02 a tenant cannot preview against another tenant's outlet", async () => {
    // The outlet is outside tenant B's org tree, so the scope check fails
    // closed: deny by default, never a cross-tenant lookup.
    const error = await previewTaxCalculation(tenantContext(tenantB), userB, {
      ...taxFixtures.privateRoomBill,
      outletId: outletIdSchema.parse(outletA.id),
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  it("F11 a date before the published configuration fails closed", async () => {
    const error = await previewTaxCalculation(
      tenantContext(seeded.id),
      userAAdmin,
      {
        ...taxFixtures.privateRoomBill,
        outletId: outletIdSchema.parse(outletB.id),
        businessDate: "2026-10-01",
      },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      status: 422,
      code: "TAX_SETTINGS_NOT_FOUND",
    });
  });
});

describe("R21 publish side effects", () => {
  it("appends the catalogued event and the audit row in the publish transaction", async () => {
    const context = tenantContext(seeded.id);
    const rule = await createTaxRule(context, userAAdmin, ruleInput());
    const published = await publishTaxRule(
      context,
      userAAdmin,
      rule.id,
      "publish-isolation-test",
    );
    expect(published.status).toBe("published");

    const events = await withTenant(db, context, (tx) =>
      tx
        .select({ event: domainEventOutbox.event })
        .from(domainEventOutbox)
        .where(
          and(
            eq(domainEventOutbox.tenantId, seeded.id),
            eq(domainEventOutbox.aggregateId, rule.id),
          ),
        ),
    );
    expect(events).toHaveLength(1);
    expect(events[0].event).toMatchObject({
      name: "tax_rule.published",
      aggregateType: "tax_rule",
      payload: {
        taxRuleId: rule.id,
        code: rule.code,
        rateBp: 1000,
        isActive: true,
        version: 1,
      },
    });

    const audits = await withTenant(db, context, (tx) =>
      tx
        .select({ event: auditLogs.event })
        .from(auditLogs)
        .where(eq(auditLogs.tenantId, seeded.id)),
    );
    expect(
      audits.some(
        (row) =>
          row.event.action === "tax_rule.published" &&
          row.event.objectId === rule.id,
      ),
    ).toBe(true);
  });
});

describe("PBJT snapshot port", () => {
  const bill = taxFixtures.privateRoomBill;
  const result: TaxCalculationResult = calculateTax(bill, {
    taxRules: taxFixtures.taxRules,
    serviceChargeRules: taxFixtures.serviceChargeRules,
    settings: taxFixtures.settings,
  });

  it("records one row per rule and a re-quote updates instead of double counting", async () => {
    const context = tenantContext(seeded.id);
    const sourceId = randomUUID();
    const record = (scaled: number) =>
      withTenant(db, context, (tx) =>
        recordTaxSnapshots(tx, context, {
          sourceType: "order",
          sourceId,
          outletId: bill.outletId,
          businessDate: bill.businessDate,
          result:
            scaled === 1
              ? result
              : {
                  ...result,
                  taxes: result.taxes.map((row) => ({
                    ...row,
                    taxBaseIdr: idr(row.taxBaseIdr * scaled),
                    taxIdr: idr(row.taxIdr * scaled),
                  })),
                },
        }),
      );

    await record(1);
    await record(2);
    // A re-quote of the same source updates its rows: one row per rule, with
    // the latest amounts, so a period total never counts the bill twice.
    const snapshots = await withTenant(db, context, (tx) =>
      tx.execute(
        sql`SELECT count(*)::int AS count, max(tax_idr)::text AS tax
            FROM tax_snapshots
            WHERE tenant_id = ${seeded.id} AND source_id = ${sourceId}`,
      ),
    );
    const row = snapshots.rows[0] as { count: number; tax: string };
    expect(row.count).toBe(result.taxes.length);
    const largest = Math.max(...result.taxes.map((entry) => entry.taxIdr));
    expect(Number(row.tax)).toBe(largest * 2);
  });

  it("TEN-03 refuses a snapshot for an outlet outside the context's reach", async () => {
    const context = outletContext(seeded.id, outletA.id);
    const error = await withTenant(db, context, (tx) =>
      recordTaxSnapshots(tx, context, {
        sourceType: "order",
        sourceId: randomUUID(),
        outletId: outletB.id,
        businessDate: bill.businessDate,
        result,
      }),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 404 });
  });
});
