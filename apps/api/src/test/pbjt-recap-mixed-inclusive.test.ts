// PBJT monthly recap with mixed price modes (bead legend-jwn6, brief 790 card A).
//
// Written from the shared recap DTO (packages/shared/src/tax/schemas.ts) and
// the tax_snapshots table contract, not from the recap implementation.
//
// The defect: the recap sums `gross_idr` per (rule code, rate) across snapshots
// whose `price_includes_tax` differs. An inclusive gross contains the tax, an
// exclusive gross does not, so the summed gross is on no basis at all and cannot
// be compared with taxBaseIdr / taxIdr. DPP (taxBaseIdr) and tax stay separate
// columns and must keep summing exactly (no tax under-reported).
//
// Assumptions (the fix design is open: "group by priceIncludesTax, or normalise"):
//  - The test accepts any of three designs and rejects only the broken one:
//      (a) one row per (code, rate) with gross normalised to an EXCLUSIVE basis
//          (inclusive gross minus its tax),
//      (b) one row per (code, rate) with gross normalised to an INCLUSIVE basis
//          (exclusive gross plus its tax),
//      (c) split rows, one per price mode, each keeping its own gross.
//    A single merged row whose gross is the raw sum of the two modes fails.
//  - service_charge_idr is 0 in every fixture so the normalisation is just
//    gross -/+ tax and the three candidate grosses are all distinct.
//  - Refunds never write negative snapshot rows (tax_snapshots_amounts_check
//    forbids them); the sale snapshot is removed when the sale is re-quoted to
//    no tax lines, so "refund" here means a voided source disappearing from the
//    recap and never inflating or leaking into it.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
  outletIdSchema,
  type BusinessDate,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  BANDUNG_REGION,
  calculateTax,
  cafeLegendTaxFixtures,
} from "@starter/shared/tax";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  createTaxRule,
  getPbjtMonthlyRecap,
  recordTaxSnapshots,
} from "../services/tax.service";

const seeded = cafeLegendPlatformFixtures.tenant;
const [outletA, outletB] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const adminUser = randomUUID();
const RATE_BP = 1000;

// Fixture amounts (rate 10%, no service charge).
const INCLUSIVE = { gross: 110_000, base: 100_000, tax: 10_000 };
const EXCLUSIVE = { gross: 100_000, base: 100_000, tax: 10_000 };
const RAW_GROSS = INCLUSIVE.gross + EXCLUSIVE.gross; // 210_000, the broken sum
const EXCLUSIVE_BASIS_GROSS = INCLUSIVE.gross - INCLUSIVE.tax + EXCLUSIVE.gross; // 200_000
const INCLUSIVE_BASIS_GROSS = INCLUSIVE.gross + EXCLUSIVE.gross + EXCLUSIVE.tax; // 220_000

const sourceIds: string[] = [];
const ruleIds: string[] = [];

function tenantContext() {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: seeded.id,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

async function asTenantOwner<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seeded.id],
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

/** A draft PBJT rule the snapshots can point at (item-scoped, never matches other tests' bills). */
async function makePbjtRule() {
  const rule = await createTaxRule(tenantContext(), adminUser, {
    outletId: null,
    code: `MIXREC-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    name: "Rekap campur",
    taxType: "pbjt" as const,
    rateBp: RATE_BP,
    regionCode: BANDUNG_REGION,
    channels: [],
    appliesTo: { itemClasses: [], categoryIds: [], itemIds: [randomUUID()] },
    includeServiceInBase: true,
    isActive: true,
    effectiveFrom: businessDateOf(new Date(), DEFAULT_BUSINESS_DAY_CLOCK),
  });
  ruleIds.push(rule.id);
  return rule;
}

type RuleRef = Awaited<ReturnType<typeof makePbjtRule>>;

async function insertSnapshot(args: {
  outletId: string;
  rule: RuleRef;
  businessDate: BusinessDate;
  includesTax: boolean;
  amounts: { gross: number; base: number; tax: number };
  sourceId?: string;
}) {
  const sourceId = args.sourceId ?? randomUUID();
  sourceIds.push(sourceId);
  await asTenantOwner((client) =>
    client.query(
      `INSERT INTO tax_snapshots
         (tenant_id, outlet_id, source_type, source_id, business_date,
          tax_rule_id, tax_rule_code, tax_rule_version, tax_type, rate_bp,
          price_includes_tax, gross_idr, tax_base_idr, service_charge_idr, tax_idr)
       VALUES ($1, $2, 'order', $3, $4, $5, $6, $7, 'pbjt', $8, $9, $10, $11, 0, $12)`,
      [
        seeded.id,
        args.outletId,
        sourceId,
        args.businessDate,
        args.rule.id,
        args.rule.code,
        args.rule.version,
        args.rule.rateBp,
        args.includesTax,
        args.amounts.gross,
        args.amounts.base,
        args.amounts.tax,
      ],
    ),
  );
  return sourceId;
}

function recap(outletId: string, period: string) {
  return getPbjtMonthlyRecap(tenantContext(), adminUser, { outletId, period });
}

/**
 * Gross must be on one consistent basis per row. Accepts the exclusive-basis,
 * inclusive-basis or split-by-price-mode designs; rejects the raw mixed sum.
 */
function expectConsistentMixedGross(
  rows: Awaited<ReturnType<typeof recap>>["rows"],
  code: string,
) {
  const mine = rows.filter((row) => row.taxRuleCode === code);
  expect(mine.length).toBeGreaterThan(0);
  // Whatever the design, tax and DPP are never lost or double counted.
  expect(mine.reduce((sum, row) => sum + row.taxIdr, 0)).toBe(
    INCLUSIVE.tax + EXCLUSIVE.tax,
  );
  expect(mine.reduce((sum, row) => sum + row.taxBaseIdr, 0)).toBe(
    INCLUSIVE.base + EXCLUSIVE.base,
  );
  expect(mine.reduce((sum, row) => sum + row.transactionCount, 0)).toBe(2);
  for (const row of mine) expect(row.rateBp).toBe(RATE_BP);

  if (mine.length === 1) {
    // Normalised: gross is exclusive-basis or inclusive-basis, never the raw sum.
    expect(mine[0].grossSalesIdr).not.toBe(RAW_GROSS);
    expect([EXCLUSIVE_BASIS_GROSS, INCLUSIVE_BASIS_GROSS]).toContain(
      mine[0].grossSalesIdr,
    );
  } else {
    // Split by price mode: each row keeps its own mode's gross.
    expect(mine).toHaveLength(2);
    expect(mine.map((row) => row.grossSalesIdr).sort((a, b) => a - b)).toEqual(
      [EXCLUSIVE.gross, INCLUSIVE.gross].sort((a, b) => a - b),
    );
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'PBJT mixed admin', $2)`,
    [adminUser, `${adminUser}@example.test`],
  );
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      roleId,
      seeded.id,
      `PBJT mixed ${roleId.slice(0, 8)}`,
      JSON.stringify(["org.tax_config.manage", "accounting.tax_report.manage"]),
      JSON.stringify(["tenant"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [seeded.id, adminUser, roleId],
  );
});

afterAll(async () => {
  await asTenantOwner(async (client) => {
    await client.query(
      "DELETE FROM tax_snapshots WHERE tenant_id = $1 AND source_id = ANY($2)",
      [seeded.id, sourceIds],
    );
    await client.query(
      "DELETE FROM tax_rules WHERE tenant_id = $1 AND id = ANY($2)",
      [seeded.id, ruleIds],
    );
    await client.query("DELETE FROM role_assignments WHERE user_id = $1", [
      adminUser,
    ]);
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND name LIKE 'PBJT mixed %'",
      [seeded.id],
    );
  });
  await owner.query('DELETE FROM "user" WHERE id = $1', [adminUser]);
  await owner.end();
});

describe("legend-jwn6 PBJT recap with mixed inclusive and exclusive snapshots", () => {
  it("legend-jwn6 keeps gross on one basis when one rule and rate mixes both price modes", async () => {
    const period = "2031-05";
    const businessDate = "2031-05-10" as BusinessDate;
    const rule = await makePbjtRule();
    await insertSnapshot({
      outletId: outletB.id,
      rule,
      businessDate,
      includesTax: true,
      amounts: INCLUSIVE,
    });
    await insertSnapshot({
      outletId: outletB.id,
      rule,
      businessDate,
      includesTax: false,
      amounts: EXCLUSIVE,
    });

    const result = await recap(outletB.id, period);
    expectConsistentMixedGross(result.rows, rule.code);
    // Report totals are DPP and tax only and stay exact.
    expect(result.totalTaxIdr).toBe(INCLUSIVE.tax + EXCLUSIVE.tax);
    expect(result.totalTaxBaseIdr).toBe(INCLUSIVE.base + EXCLUSIVE.base);
  });

  it("legend-jwn6 guard: a single price mode still reports exact tax, DPP and count", async () => {
    const period = "2031-06";
    const businessDate = "2031-06-10" as BusinessDate;
    const rule = await makePbjtRule();
    for (let sale = 0; sale < 2; sale += 1) {
      await insertSnapshot({
        outletId: outletB.id,
        rule,
        businessDate,
        includesTax: false,
        amounts: EXCLUSIVE,
      });
    }
    const result = await recap(outletB.id, period);
    const mine = result.rows.filter((row) => row.taxRuleCode === rule.code);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      rateBp: RATE_BP,
      transactionCount: 2,
      taxBaseIdr: 2 * EXCLUSIVE.base,
      taxIdr: 2 * EXCLUSIVE.tax,
    });
    // Same basis on every row: the gross is not touched by a normaliser that
    // only has one mode to read, so it is the plain sum of the exclusive grosses.
    expect(mine[0].grossSalesIdr).toBeGreaterThanOrEqual(2 * EXCLUSIVE.base);
  });

  it("legend-jwn6 refund: a voided inclusive sale drops out and the exclusive sale alone stays consistent", async () => {
    const period = "2031-07";
    const businessDate = "2031-07-10" as BusinessDate;
    const rule = await makePbjtRule();
    const voidedSource = await insertSnapshot({
      outletId: outletB.id,
      rule,
      businessDate,
      includesTax: true,
      amounts: INCLUSIVE,
    });
    await insertSnapshot({
      outletId: outletB.id,
      rule,
      businessDate,
      includesTax: false,
      amounts: EXCLUSIVE,
    });
    const before = await recap(outletB.id, period);
    expectConsistentMixedGross(before.rows, rule.code);

    // Re-quote the voided sale to no tax lines (the same call the sale path
    // makes): its snapshot rows are removed, never turned into negative rows.
    const context = tenantContext();
    const emptied = {
      ...calculateTax(cafeLegendTaxFixtures.privateRoomBill, {
        taxRules: cafeLegendTaxFixtures.taxRules,
        serviceChargeRules: cafeLegendTaxFixtures.serviceChargeRules,
        settings: cafeLegendTaxFixtures.settings,
      }),
      taxes: [],
      lines: [],
    };
    await withTenant(db, context, (tx) =>
      recordTaxSnapshots(tx, context, {
        sourceType: "order",
        sourceId: voidedSource,
        outletId: outletB.id,
        businessDate,
        result: emptied,
      }),
    );

    const after = await recap(outletB.id, period);
    const mine = after.rows.filter((row) => row.taxRuleCode === rule.code);
    expect(mine.reduce((sum, row) => sum + row.taxIdr, 0)).toBe(EXCLUSIVE.tax);
    expect(mine.reduce((sum, row) => sum + row.taxBaseIdr, 0)).toBe(
      EXCLUSIVE.base,
    );
    expect(mine.reduce((sum, row) => sum + row.transactionCount, 0)).toBe(1);
    expect(after.totalTaxIdr).toBe(EXCLUSIVE.tax);
    // Only the exclusive sale is left: the voided sale's gross must not remain
    // (raw mixed sum) and nothing may go negative. The row gross is its own
    // exclusive gross (100_000) or that gross on an inclusive basis (110_000).
    for (const row of mine) {
      expect(row.grossSalesIdr).not.toBe(RAW_GROSS);
      expect([EXCLUSIVE.gross, EXCLUSIVE.gross + EXCLUSIVE.tax]).toContain(
        row.grossSalesIdr,
      );
    }
  });

  it("legend-jwn6 two outlets: each recap holds only its own outlet's mixed sales", async () => {
    const period = "2031-08";
    const businessDate = "2031-08-10" as BusinessDate;
    const rule = await makePbjtRule();
    // Outlet B: one inclusive + one exclusive. Outlet A: only a larger exclusive.
    await insertSnapshot({
      outletId: outletB.id,
      rule,
      businessDate,
      includesTax: true,
      amounts: INCLUSIVE,
    });
    await insertSnapshot({
      outletId: outletB.id,
      rule,
      businessDate,
      includesTax: false,
      amounts: EXCLUSIVE,
    });
    const aOnly = { gross: 500_000, base: 500_000, tax: 50_000 };
    await insertSnapshot({
      outletId: outletA.id,
      rule,
      businessDate,
      includesTax: false,
      amounts: aOnly,
    });

    const forB = await recap(outletB.id, period);
    expect(forB.outletId).toBe(outletIdSchema.parse(outletB.id));
    expectConsistentMixedGross(forB.rows, rule.code);
    expect(forB.totalTaxIdr).toBe(INCLUSIVE.tax + EXCLUSIVE.tax);
    expect(forB.totalTaxBaseIdr).toBe(INCLUSIVE.base + EXCLUSIVE.base);

    const forA = await recap(outletA.id, period);
    expect(forA.outletId).toBe(outletIdSchema.parse(outletA.id));
    const mineA = forA.rows.filter((row) => row.taxRuleCode === rule.code);
    expect(mineA).toHaveLength(1);
    expect(mineA[0]).toMatchObject({
      transactionCount: 1,
      taxBaseIdr: aOnly.base,
      taxIdr: aOnly.tax,
      grossSalesIdr: aOnly.gross,
    });
    // Outlet B's sales never leak into outlet A's totals.
    expect(forA.totalTaxIdr).toBe(aOnly.tax);
    expect(forA.totalTaxBaseIdr).toBe(aOnly.base);
  });
});
