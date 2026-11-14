// Fail-first tests for bead legend-wqorb: an auditor warning on a tax report
// line (non-PBJT tax left out of the PBJT figures) moves out of `references`
// into its own `warnings` field of the shared contract (`taxReportLineSchema`).
// `references` then holds source document numbers only.
//
// Assumptions (the bead does not pin these down):
// - `warnings` is `string[]`, each at most 200 characters, default `[]`, so a
//   report line stored before this change (no `warnings` key) still parses.
// - The warning text keeps mentioning "non-PBJT Rp<amount>" (the wording the
//   powk0 tests already pin); the exact "Peringatan:" prefix is not required.
// - The Coretax XML never carries a warning, whatever the field it sits in.
// - The first block is pure (no database); the last block reuses the fixtures
//   of accounting-tax-line-source.test.ts against the disposable PostgreSQL.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  createUlid,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  taxReportLineSchema,
  type TaxReportLine,
} from "@starter/shared/accounting";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { defaultTaxLineSource } from "../services/accounting-tax-line-source";
import { buildCoretaxXml } from "../services/accounting-coretax-xml";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletId = cafeLegendPlatformFixtures.outlets[0].id;
const WARNING = "Peringatan: pajak non-PBJT Rp2000 tidak ikut";

const baseLine = () => ({
  subjectType: "outlet" as const,
  subjectId: randomUUID(),
  subjectName: "Outlet Satu",
  taxIdMasked: null,
  outletId,
  baseIdr: 100_000,
  taxIdr: 10_000,
  references: ["INV-001"],
});

// ---- Contract ------------------------------------------------------------------

describe("legend-wqorb taxReportLineSchema warnings", () => {
  it("reads a line stored before the change: warnings defaults to an empty list", () => {
    const parsed = taxReportLineSchema.parse(baseLine());
    expect(parsed.warnings).toEqual([]);
    expect(parsed.references).toEqual(["INV-001"]);
  });

  it("keeps the warnings it is given, apart from the references", () => {
    const parsed = taxReportLineSchema.parse({
      ...baseLine(),
      warnings: [WARNING],
    });
    expect(parsed.warnings).toEqual([WARNING]);
    expect(parsed.references).toEqual(["INV-001"]);
  });

  it("refuses a warning longer than 200 characters", () => {
    const tooLong = taxReportLineSchema.safeParse({
      ...baseLine(),
      warnings: ["x".repeat(201)],
    });
    expect(tooLong.success).toBe(false);
    const atLimit = taxReportLineSchema.safeParse({
      ...baseLine(),
      warnings: ["x".repeat(200)],
    });
    expect(atLimit.success).toBe(true);
  });

  it("refuses a warnings value that is not a list of text", () => {
    expect(
      taxReportLineSchema.safeParse({ ...baseLine(), warnings: "oops" })
        .success,
    ).toBe(false);
    expect(
      taxReportLineSchema.safeParse({ ...baseLine(), warnings: [1] }).success,
    ).toBe(false);
  });
});

// ---- Coretax XML ---------------------------------------------------------------

describe("legend-wqorb Coretax XML leaves out warnings", () => {
  const xmlOf = (lines: unknown[]) =>
    buildCoretaxXml({
      id: randomUUID(),
      tenantId: randomUUID(),
      legalEntityId: randomUUID(),
      type: "pbjt",
      period: "2026-11",
      revisionNo: 0,
      amountIdr: 10_000,
      lines,
      finalizedAt: new Date("2026-12-01T00:00:00Z"),
    } as never);

  it("never writes a warning into the XML and keeps the real references", () => {
    const xml = xmlOf([
      {
        ...baseLine(),
        references: ["INV-001", "INV-002"],
        warnings: [WARNING],
      },
    ]);
    expect(xml).not.toContain("Peringatan");
    expect(xml).not.toContain("non-PBJT");
    expect(xml).toContain("<Reference>INV-001</Reference>");
    expect(xml).toContain("<Reference>INV-002</Reference>");
  });

  it("builds a line without a warnings key (stored before the change)", () => {
    const xml = xmlOf([baseLine()]);
    expect(xml).toContain("<Reference>INV-001</Reference>");
  });
});

// ---- Line source against the database ----------------------------------------------

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const unique = () => randomBytes(4).toString("hex");
const createdRuleIds: string[] = [];

afterAll(async () => {
  try {
    if (createdRuleIds.length > 0) {
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
          [tenantId],
        );
        await client.query(
          "DELETE FROM tax_snapshots WHERE tenant_id = $1 AND tax_rule_id = ANY($2)",
          [tenantId, createdRuleIds],
        );
        await client.query(
          "DELETE FROM tax_rules WHERE tenant_id = $1 AND id = ANY($2)",
          [tenantId, createdRuleIds],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await owner.end();
  }
});

const scopedContext = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

type World = {
  entity: string;
  cash: string;
  revenue: string;
  tax: string;
  ruleId: string;
  ppnRuleId: string;
  nov: string;
};

async function makeWorld(): Promise<World> {
  const entity = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenantId, `Tax warnings ${unique()}`],
  );
  const [cash, revenue, tax] = [randomUUID(), randomUUID(), randomUUID()];
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $4, $5, '1101', 'Kas', 'asset', 'current_asset'),
            ($2, $4, $5, '4101', 'Penjualan', 'revenue', 'revenue'),
            ($3, $4, $5, '2104', 'Utang PBJT', 'liability', 'current_liability')`,
    [cash, revenue, tax, tenantId, entity],
  );
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, 'tax_payable_pbjt', $3),
            ($1, $2, 'sales_revenue', $4),
            ($1, $2, 'cash_on_hand', $5)`,
    [tenantId, entity, tax, revenue, cash],
  );
  const periods = await owner.query<{ id: string }>(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, '2026-11') RETURNING id`,
    [tenantId, entity],
  );
  const publisher = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Tax warnings', $2)`,
    [publisher, `${publisher}@example.test`],
  );
  const rule = async (type: "pbjt" | "ppn", rateBp: number) => {
    const id = randomUUID();
    createdRuleIds.push(id);
    await owner.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $7)`,
      [
        id,
        tenantId,
        `${type.toUpperCase()}-LW-${unique()}`.toUpperCase(),
        `${type} uji`,
        type,
        rateBp,
        publisher,
      ],
    );
    return id;
  };
  return {
    entity,
    cash,
    revenue,
    tax,
    ruleId: await rule("pbjt", 1000),
    ppnRuleId: await rule("ppn", 200),
    nov: periods.rows[0]!.id,
  };
}

async function seedSnapshot(
  world: World,
  orderId: string,
  taxType: "pbjt" | "ppn",
  tax: number,
) {
  await owner.query(
    `INSERT INTO tax_snapshots
       (id, tenant_id, outlet_id, source_type, source_id, business_date, tax_rule_id, tax_rule_code,
        tax_rule_version, tax_type, rate_bp, price_includes_tax, gross_idr, tax_base_idr,
        service_charge_idr, tax_idr)
     VALUES ($1, $2, $3, 'order', $4, '2026-11-05', $5, $6, 1, $7, $8, false, 100000, 100000, 0, $9)`,
    [
      randomUUID(),
      tenantId,
      outletId,
      ulidToUuid(orderId),
      taxType === "ppn" ? world.ppnRuleId : world.ruleId,
      `${taxType.toUpperCase()}-LW`,
      taxType,
      taxType === "ppn" ? 200 : 1000,
      tax,
    ],
  );
}

async function postSale(world: World, orderId: string, creditTotal: number) {
  const client: PoolClient = await owner.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, outlet_id, entry_date, fiscal_period_id, source_type,
          source_id, description, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, '2026-11-05', $4, 'sale', $5, 'Tax warnings test', $6, $7)
       RETURNING id`,
      [
        tenantId,
        world.entity,
        outletId,
        world.nov,
        orderId,
        `tw-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    const entryId = rows[0]!.id;
    const postings: [string, number, number][] = [
      [world.cash, 100_000 + creditTotal, 0],
      [world.revenue, 0, 100_000],
      [world.tax, 0, creditTotal],
    ];
    let lineNo = 1;
    for (const [account, debit, credit] of postings)
      await client.query(
        `INSERT INTO journal_lines (tenant_id, entry_id, account_id, outlet_id, line_no, debit_idr, credit_idr)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, entryId, account, outletId, lineNo++, debit, credit],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const novLines = (world: World): Promise<TaxReportLine[]> =>
  withTenant(db, scopedContext(), (tx) =>
    defaultTaxLineSource(tx, {
      tenantId,
      legalEntityId: world.entity,
      type: "pbjt",
      period: "2026-11",
    }),
  ) as Promise<TaxReportLine[]>;

describe("legend-wqorb PBJT line source fills warnings, not references", () => {
  it("puts the non-PBJT warning in warnings and leaves references empty", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    await seedSnapshot(world, orderId, "pbjt", 10_000);
    await seedSnapshot(world, orderId, "ppn", 2_000);
    // PBJT 10_000 plus PPN 2_000 credited to the same payable account.
    await postSale(world, orderId, 12_000);

    const lines = await novLines(world);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ taxIdr: 10_000, baseIdr: 100_000 });
    expect(lines[0]!.warnings).toHaveLength(1);
    expect(lines[0]!.warnings[0]).toMatch(/non-PBJT Rp2000/);
    expect(lines[0]!.references).toEqual([]);
  });

  it("has an empty warnings list when the sales carry PBJT only", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    await seedSnapshot(world, orderId, "pbjt", 10_000);
    await postSale(world, orderId, 10_000);

    const lines = await novLines(world);

    expect(lines).toHaveLength(1);
    expect(lines[0]!.warnings).toEqual([]);
    expect(lines[0]!.references).toEqual([]);
  });
});
