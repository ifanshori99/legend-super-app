// PBJT tax line source (bead legend-powk0; PRD v1.7 §3.19 "Pajak"). Runs
// defaultTaxLineSource inside withTenant against the disposable PostgreSQL
// database; ledger and tax_snapshots rows are seeded as the migration owner.
//
// Rules under test (from the bead):
// - Line tax = credit minus debit of the account mapped to tax_payable_pbjt,
//   counting only journal entries whose effective source is 'sale' or 'refund'
//   (a reversal counts as the entry it reverses). Remittances (source_type
//   'manual') and 'opening_balance' entries never count.
// - Line base = sum of tax_snapshots.tax_base_idr (tax_type 'pbjt') for the sale
//   entries, matched on snapshot.source_id = ulidToUuid(entry.source_id). A
//   reversal of a sale subtracts it.
// - Ledger sale tax per outlet must equal the snapshot tax, else generation
//   fails with TAX_REPORT_SOURCE_UNAVAILABLE.
// - A refund's base is its tax grossed up by the period sales' base/tax ratio.
//
// Assumptions:
// - Sale and refund entries use a ULID source_id (the order id); a reversal entry carries no
//   source_id of its own (it is resolved through reversal_of).
// - The line is per outlet; entries and lines carry the fixture outlet.
// - "Nets to no line" means an empty array (no outlet row with zero tax).

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
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { defaultTaxLineSource } from "../services/accounting-tax-line-source";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletId = cafeLegendPlatformFixtures.outlets[0].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const unique = () => randomBytes(4).toString("hex");

/** Published PBJT/PPN rules inserted by makeWorld. They sit in the shared seeded
 *  tenant with no region, so left behind they match every later bill there
 *  (tax-api's ORD-03 preview). Removed by id in afterAll. */
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
        // tax_snapshots reference the rules (tax_snapshots_rule_fk): rows first.
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

// ---- Fixtures ----------------------------------------------------------------

type World = {
  entity: string;
  cash: string;
  revenue: string;
  discount: string;
  tax: string;
  ruleId: string;
  ppnRuleId: string;
  oct: string;
  nov: string;
};

async function makeWorld(): Promise<World> {
  const entity = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenantId, `Tax line source ${unique()}`],
  );
  const accounts = {
    cash: randomUUID(),
    revenue: randomUUID(),
    discount: randomUUID(),
    tax: randomUUID(),
  };
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $5, $6, '1101', 'Kas', 'asset', 'current_asset'),
            ($2, $5, $6, '4101', 'Penjualan', 'revenue', 'revenue'),
            ($3, $5, $6, '4102', 'Diskon Penjualan', 'revenue', 'revenue'),
            ($4, $5, $6, '2104', 'Utang PBJT', 'liability', 'current_liability')`,
    [
      accounts.cash,
      accounts.revenue,
      accounts.discount,
      accounts.tax,
      tenantId,
      entity,
    ],
  );
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, 'tax_payable_pbjt', $3),
            ($1, $2, 'sales_revenue', $4),
            ($1, $2, 'sales_discount', $5),
            ($1, $2, 'cash_on_hand', $6)`,
    [
      tenantId,
      entity,
      accounts.tax,
      accounts.revenue,
      accounts.discount,
      accounts.cash,
    ],
  );
  const periods = await owner.query<{ id: string; period: string }>(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, '2026-10'), ($1, $2, '2026-11') RETURNING id, period`,
    [tenantId, entity],
  );
  const periodId = (period: string) =>
    periods.rows.find((row) => row.period === period)!.id;
  const ruleId = randomUUID();
  createdRuleIds.push(ruleId);
  const publisher = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Tax line source', $2)`,
    [publisher, `${publisher}@example.test`],
  );
  await owner.query(
    `INSERT INTO tax_rules
       (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
        price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
        published_at, published_by)
     VALUES ($1, $2, NULL, $3, 'PBJT uji', 'pbjt', 1000, NULL, '[]',
             '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
             false, true, true, 1, '2026-01-01', 'published', now(), $4)`,
    [ruleId, tenantId, `PBJT-LS-${unique()}`.toUpperCase(), publisher],
  );
  const ppnRuleId = randomUUID();
  createdRuleIds.push(ppnRuleId);
  await owner.query(
    `INSERT INTO tax_rules
       (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
        price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
        published_at, published_by)
     VALUES ($1, $2, NULL, $3, 'PPN uji', 'ppn', 200, NULL, '[]',
             '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
             false, true, true, 1, '2026-01-01', 'published', now(), $4)`,
    [ppnRuleId, tenantId, `PPN-LS-${unique()}`.toUpperCase(), publisher],
  );
  return {
    entity,
    ...accounts,
    ruleId,
    ppnRuleId,
    oct: periodId("2026-10"),
    nov: periodId("2026-11"),
  };
}

type Posting = [account: string, debitIdr: number, creditIdr: number];

/** One balanced journal entry in its own transaction, tagged with the outlet. */
async function postEntry(
  world: World,
  input: {
    period: string;
    entryDate: string;
    sourceType: "sale" | "refund" | "manual" | "opening_balance" | "reversal";
    sourceId?: string | null;
    reversalOf?: string;
    lines: Posting[];
  },
): Promise<string> {
  const client: PoolClient = await owner.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, outlet_id, entry_date, fiscal_period_id, source_type,
          source_id, description, reversal_of, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Tax line source test', $8, $9, $10)
       RETURNING id`,
      [
        tenantId,
        world.entity,
        outletId,
        input.entryDate,
        input.period,
        input.sourceType,
        input.sourceId ?? null,
        input.reversalOf ?? null,
        `tls-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    const entryId = rows[0]!.id;
    let lineNo = 1;
    for (const [account, debit, credit] of input.lines) {
      await client.query(
        `INSERT INTO journal_lines (tenant_id, entry_id, account_id, outlet_id, line_no, debit_idr, credit_idr)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, entryId, account, outletId, lineNo++, debit, credit],
      );
    }
    await client.query("COMMIT");
    return entryId;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedSnapshot(
  world: World,
  orderId: string,
  amounts: { gross: number; base: number; tax: number },
  businessDate = "2026-11-05",
  {
    taxType = "pbjt",
    rateBp = 1000,
  }: { taxType?: "pbjt" | "ppn"; rateBp?: number } = {},
) {
  await owner.query(
    `INSERT INTO tax_snapshots
       (id, tenant_id, outlet_id, source_type, source_id, business_date, tax_rule_id, tax_rule_code,
        tax_rule_version, tax_type, rate_bp, price_includes_tax, gross_idr, tax_base_idr,
        service_charge_idr, tax_idr)
     VALUES ($1, $2, $3, 'order', $4, $5, $6, $10, 1, $11, $12, false, $7, $8, 0, $9)`,
    [
      randomUUID(),
      tenantId,
      outletId,
      ulidToUuid(orderId),
      businessDate,
      taxType === "ppn" ? world.ppnRuleId : world.ruleId,
      amounts.gross,
      amounts.base,
      amounts.tax,
      `${taxType.toUpperCase()}-LS`,
      taxType,
      rateBp,
    ],
  );
}

const novLines = (world: World, period = "2026-11") =>
  withTenant(db, scopedContext(), (tx) =>
    defaultTaxLineSource(tx, {
      tenantId,
      legalEntityId: world.entity,
      type: "pbjt",
      period,
    }),
  );

/** A November sale: cash in, revenue and PBJT out. */
async function postSale(
  world: World,
  orderId: string,
  revenue: number,
  tax: number,
  when: { period: string; date: string } = {
    period: world.nov,
    date: "2026-11-05",
  },
) {
  await seedSnapshot(
    world,
    orderId,
    { gross: revenue, base: revenue, tax },
    when.date,
  );
  return postEntry(world, {
    period: when.period,
    entryDate: when.date,
    sourceType: "sale",
    sourceId: orderId,
    lines: [
      [world.cash, revenue + tax, 0],
      [world.revenue, 0, revenue],
      [world.tax, 0, tax],
    ],
  });
}

// ---- Tests ---------------------------------------------------------------------

describe("legend-powk0 PBJT tax line source", () => {
  it("legend-powk0 reports only collected sale tax, never remittances", async () => {
    const world = await makeWorld();
    await postSale(world, createUlid(), 10_000_000, 1_000_000);
    // October remittance (different period) and a November manual remittance.
    await postEntry(world, {
      period: world.oct,
      entryDate: "2026-10-20",
      sourceType: "manual",
      lines: [
        [world.tax, 800_000, 0],
        [world.cash, 0, 800_000],
      ],
    });
    await postEntry(world, {
      period: world.nov,
      entryDate: "2026-11-20",
      sourceType: "manual",
      lines: [
        [world.tax, 300_000, 0],
        [world.cash, 0, 300_000],
      ],
    });

    const lines = await novLines(world);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      subjectType: "outlet",
      subjectId: outletId,
      outletId,
      taxIdr: 1_000_000,
      baseIdr: 10_000_000,
    });
  });

  it("legend-powk0 takes the base from the tax snapshot, after the discount", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    // Sale Rp100.000 with discount Rp20.000: PBJT 10% on the discounted 80.000.
    await seedSnapshot(world, orderId, {
      gross: 100_000,
      base: 80_000,
      tax: 8_000,
    });
    await postEntry(world, {
      period: world.nov,
      entryDate: "2026-11-05",
      sourceType: "sale",
      sourceId: orderId,
      lines: [
        [world.cash, 88_000, 0],
        [world.discount, 20_000, 0],
        [world.revenue, 0, 100_000],
        [world.tax, 0, 8_000],
      ],
    });

    const lines = await novLines(world);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ baseIdr: 80_000, taxIdr: 8_000 });
  });

  it("legend-powk0 leaves out an outlet whose sale was reversed in the same period", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    const sale = await postSale(world, orderId, 100_000, 10_000);
    await postEntry(world, {
      period: world.nov,
      entryDate: "2026-11-06",
      sourceType: "reversal",
      reversalOf: sale,
      lines: [
        [world.cash, 0, 110_000],
        [world.revenue, 100_000, 0],
        [world.tax, 10_000, 0],
      ],
    });

    expect(await novLines(world)).toEqual([]);
  });

  it("legend-powk0 keeps the other sales when one sale is reversed", async () => {
    const world = await makeWorld();
    const kept = await postSale(world, createUlid(), 200_000, 20_000);
    expect(kept).toBeTruthy();
    const reversedSale = await postSale(world, createUlid(), 100_000, 10_000);
    await postEntry(world, {
      period: world.nov,
      entryDate: "2026-11-06",
      sourceType: "reversal",
      reversalOf: reversedSale,
      lines: [
        [world.cash, 0, 110_000],
        [world.revenue, 100_000, 0],
        [world.tax, 10_000, 0],
      ],
    });

    const lines = await novLines(world);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ baseIdr: 200_000, taxIdr: 20_000 });
  });

  it("legend-powk0 ignores an opening balance credit on the tax account", async () => {
    const world = await makeWorld();
    await postSale(world, createUlid(), 1_000_000, 100_000);
    await postEntry(world, {
      period: world.nov,
      entryDate: "2026-11-01",
      sourceType: "opening_balance",
      lines: [
        [world.cash, 500_000, 0],
        [world.tax, 0, 500_000],
      ],
    });

    const lines = await novLines(world);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ taxIdr: 100_000, baseIdr: 1_000_000 });
  });

  it("legend-powk0 returns no line when the period only has an opening balance", async () => {
    const world = await makeWorld();
    await postEntry(world, {
      period: world.nov,
      entryDate: "2026-11-01",
      sourceType: "opening_balance",
      lines: [
        [world.cash, 500_000, 0],
        [world.tax, 0, 500_000],
      ],
    });

    expect(await novLines(world)).toEqual([]);
  });

  it("legend-powk0 grosses a refund up to a base from the period's sales ratio", async () => {
    const world = await makeWorld();
    await postSale(world, createUlid(), 100_000, 10_000);
    await postEntry(world, {
      period: world.nov,
      entryDate: "2026-11-07",
      sourceType: "refund",
      sourceId: createUlid(),
      lines: [
        [world.tax, 2_500, 0],
        [world.revenue, 25_000, 0],
        [world.cash, 0, 27_500],
      ],
    });

    const lines = await novLines(world);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ taxIdr: 7_500, baseIdr: 75_000 });
  });

  it("legend-powk0 leaves out a period where a sale from an earlier period was voided", async () => {
    const world = await makeWorld();
    const sale = await postSale(world, createUlid(), 100_000, 10_000, {
      period: world.oct,
      date: "2026-10-20",
    });
    await postEntry(world, {
      period: world.nov,
      entryDate: "2026-11-03",
      sourceType: "reversal",
      reversalOf: sale,
      lines: [
        [world.cash, 0, 110_000],
        [world.revenue, 100_000, 0],
        [world.tax, 10_000, 0],
      ],
    });

    expect(await novLines(world)).toEqual([]);
  });

  it("legend-powk0 refuses a sale with PBJT but no tax snapshot, naming the outlet, the gap and the sale", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    await postEntry(world, {
      period: world.nov,
      entryDate: "2026-11-05",
      sourceType: "sale",
      sourceId: orderId,
      lines: [
        [world.cash, 110_000, 0],
        [world.revenue, 0, 100_000],
        [world.tax, 0, 10_000],
      ],
    });

    const error = await novLines(world).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "TAX_REPORT_SOURCE_UNAVAILABLE" });
    const message = (error as Error).message;
    expect(message).toContain(
      "buku besar Rp10000, snapshot Rp0, selisih Rp10000",
    );
    expect(message).toContain("Penjualan tanpa snapshot: 1");
    expect(message).toContain(orderId);
  });

  it("legend-powk0 refuses when the snapshot tax differs from the ledger tax", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    await seedSnapshot(world, orderId, {
      gross: 100_000,
      base: 100_000,
      tax: 9_000,
    });
    await postEntry(world, {
      period: world.nov,
      entryDate: "2026-11-05",
      sourceType: "sale",
      sourceId: orderId,
      lines: [
        [world.cash, 110_000, 0],
        [world.revenue, 0, 100_000],
        [world.tax, 0, 10_000],
      ],
    });

    const error = await novLines(world).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "TAX_REPORT_SOURCE_UNAVAILABLE" });
    const message = (error as Error).message;
    expect(message).toContain(
      "buku besar Rp10000, snapshot Rp9000, selisih Rp1000",
    );
    // the sale has a snapshot, so no "missing sale" hint
    expect(message).not.toContain("Penjualan tanpa snapshot");
  });

  it("legend-powk0 reports only PBJT in the line and warns about other tax on the sale", async () => {
    const world = await makeWorld();
    const orderId = createUlid();
    await seedSnapshot(world, orderId, {
      gross: 100_000,
      base: 100_000,
      tax: 10_000,
    });
    await seedSnapshot(
      world,
      orderId,
      { gross: 100_000, base: 100_000, tax: 2_000 },
      "2026-11-05",
      { taxType: "ppn", rateBp: 200 },
    );
    await postEntry(world, {
      period: world.nov,
      entryDate: "2026-11-05",
      sourceType: "sale",
      sourceId: orderId,
      lines: [
        [world.cash, 112_000, 0],
        [world.revenue, 0, 100_000],
        [world.tax, 0, 12_000],
      ],
    });

    const lines = await novLines(world);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ taxIdr: 10_000, baseIdr: 100_000 });
    // legend-wqorb: the note is a `warnings` entry, not a source reference.
    expect(lines[0]!.references).toEqual([]);
    expect(lines[0]!.warnings).toHaveLength(1);
    expect(lines[0]!.warnings[0]).toMatch(/non-PBJT Rp2000/);
  });

  it("legend-powk0 adds no warning when the sales carry PBJT only", async () => {
    const world = await makeWorld();
    await postSale(world, createUlid(), 100_000, 10_000);

    const lines = await novLines(world);

    expect(lines).toHaveLength(1);
    expect(lines[0]!.references).toEqual([]);
    expect(lines[0]!.warnings).toEqual([]);
  });

  it("legend-powk0 ignores zero-rate sales when grossing up a refund base", async () => {
    const world = await makeWorld();
    await postSale(world, createUlid(), 100_000, 10_000);
    // Sale B: a 0% PBJT snapshot (base 100_000, tax 0) and no tax credit line.
    const zeroOrder = createUlid();
    await seedSnapshot(
      world,
      zeroOrder,
      { gross: 100_000, base: 100_000, tax: 0 },
      "2026-11-05",
      { rateBp: 0 },
    );
    await postEntry(world, {
      period: world.nov,
      entryDate: "2026-11-05",
      sourceType: "sale",
      sourceId: zeroOrder,
      lines: [
        [world.cash, 100_000, 0],
        [world.revenue, 0, 100_000],
      ],
    });
    await postEntry(world, {
      period: world.nov,
      entryDate: "2026-11-07",
      sourceType: "refund",
      sourceId: createUlid(),
      lines: [
        [world.tax, 2_500, 0],
        [world.revenue, 25_000, 0],
        [world.cash, 0, 27_500],
      ],
    });

    const lines = await novLines(world);

    // Base 100_000 + 100_000 from the sales, minus the refund's 25_000
    // (2_500 tax at the 10% ratio): 175_000.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ taxIdr: 7_500, baseIdr: 175_000 });
  });
});
