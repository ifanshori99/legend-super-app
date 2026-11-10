// Stock ledger insertion sequence (bead legend-bsw9).
//
// Live posting applies the moving average in commit order; the rebuild used to
// fold by (occurred_at, id), so a backdated posting made the two disagree.
// stock_ledger.posting_seq records the insertion order and the rebuild folds by
// it. Runs against the disposable PostgreSQL test database as the migration
// owner (fixtures) and the restricted legend_app login (RLS / append-only).
import { randomUUID } from "node:crypto";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decimal4,
  outletIdSchema,
  ulidToUuid,
  uuidToUlid,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  foldStockLedger,
  stockLedgerEntrySchema,
  type PostedStockLedgerEntry,
  type StockLedgerEntry,
} from "@starter/shared/inventory";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  listStockBalances,
  listStockLedger,
  recordStockMovement,
  rebuildStockBalances,
} from "../services/inventory.service";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0]!.id;
const tenantB = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});

function tenantContext(tenantId = tenantA): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
    { kind: "tenant" },
  );
}

/** Runs `run` inside a rolled-back legend_app transaction with tenant context. */
async function asTenant<T>(
  tenantId: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    return await run(client as unknown as Client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

// Fixture ids (random per run, safe on the disposable database).
let uomId: string;
let locationId: string;
let itemId: string;
let serviceUserId: string;

// Posting order of the scenario, with the ledger ids the service returned.
const posted: { id: string; occurredAt: string }[] = [];
let live: { quantity: string; avgCostIdr: string };

async function balanceOf(item: string) {
  const { data } = await listStockBalances(tenantContext(), serviceUserId, {
    outletId: outletA,
    limit: 100,
    inventoryItemId: item,
  });
  const row = data.find(
    (balance) =>
      balance.locationId === locationId && balance.inventoryItemId === item,
  );
  if (!row) throw new Error("balance row missing");
  return { quantity: row.quantity, avgCostIdr: row.avgCostIdr };
}

async function ledgerWithSeq(item: string): Promise<PostedStockLedgerEntry[]> {
  const page = await listStockLedger(tenantContext(), serviceUserId, {
    outletId: outletA,
    limit: 100,
    inventoryItemId: item,
  });
  const { rows } = await owner.query<{ id: string; posting_seq: string }>(
    "SELECT id, posting_seq FROM stock_ledger WHERE tenant_id = $1 AND inventory_item_id = $2",
    [tenantA, item],
  );
  const seqById = new Map(rows.map((row) => [row.id, Number(row.posting_seq)]));
  return page.data.map((entry) => ({
    ...entry,
    postingSeq: seqById.get(ulidToUuid(entry.id))!,
  }));
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");

  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Ledger Sequence Tenant B', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantB,
      `ledger-seq-${randomUUID().slice(0, 8)}`,
      JSON.stringify({ modules: [], integrationProviders: [] }),
      JSON.stringify({
        maxOutlets: 1,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  uomId = (
    await owner.query<{ id: string }>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, 'Kilogram') RETURNING id",
      [tenantA, `kgs-${randomUUID().slice(0, 4)}`],
    )
  ).rows[0]!.id;
  locationId = (
    await owner.query<{ id: string }>(
      "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, 'Gudang Urutan', 'warehouse') RETURNING id",
      [tenantA, outletA],
    )
  ).rows[0]!.id;
  itemId = await insertItem("Kopi Urutan");

  serviceUserId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [serviceUserId, "Ledger Sequence", `${serviceUserId}@example.com`],
  );
  const role = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
    [tenantA],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantA, serviceUserId, role.rows[0]!.id],
  );
});

afterAll(async () => {
  // Tenant B carries ledger rows written without their foreign keys; the
  // ledger is append-only, so replica mode (origin triggers do not fire, the
  // test server login is a superuser) is the one way to remove them.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("DELETE FROM stock_ledger WHERE tenant_id = $1", [
      tenantB,
    ]);
    await client.query("DELETE FROM stock_balances WHERE tenant_id = $1", [
      tenantB,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  // Tenant A fixtures keep their ledger rows (append-only), so the unit,
  // location and item stay in the disposable database like inventory.test.ts.
  await owner.end();
  await appPool.end();
});

async function insertItem(name: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id) VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3) RETURNING id",
    [tenantA, `${name} ${randomUUID().slice(0, 6)}`, uomId],
  );
  return rows[0]!.id;
}

describe("legend-bsw9 backdated postings", () => {
  beforeAll(async () => {
    const now = Date.now();
    const base = {
      outletId: outletA,
      locationId,
      inventoryItemId: itemId,
      actor: { type: "system" } as const,
    };
    // A: 10 @ 1000, posted at "now".
    const a = await recordStockMovement(tenantContext(), {
      ...base,
      movementType: "receipt",
      quantity: decimal4("10.0000"),
      unitCostIdr: decimal4("1000.0000"),
      sourceType: "goods_receipt",
      sourceId: randomUUID(),
      occurredAt: new Date(now).toISOString(),
    });
    // Outflow of 5 at the live average (1000): 5 @ 1000 left.
    const out = await recordStockMovement(tenantContext(), {
      ...base,
      movementType: "waste",
      quantity: decimal4("-5.0000"),
      sourceType: "waste_log",
      sourceId: randomUUID(),
      occurredAt: new Date(now + 1_000).toISOString(),
    });
    // B: posted last but dated an hour BEFORE A (EOD import / stock opname).
    // Live: (5 * 1000 + 10 * 2000) / 15 = 1666.6667.
    // occurred_at order would give B, A, out = 15 @ 1500.
    const b = await recordStockMovement(tenantContext(), {
      ...base,
      movementType: "receipt",
      quantity: decimal4("10.0000"),
      unitCostIdr: decimal4("2000.0000"),
      sourceType: "goods_receipt",
      sourceId: randomUUID(),
      occurredAt: new Date(now - 3_600_000).toISOString(),
    });
    for (const entry of [a, out, b])
      posted.push({ id: entry.id, occurredAt: entry.occurredAt });
    live = await balanceOf(itemId);
  });

  it("the live balance is the moving average in posting order", () => {
    expect(live).toEqual({ quantity: "15.0000", avgCostIdr: "1666.6667" });
  });

  it("a rebuild equals the live balance after a backdated posting", async () => {
    await rebuildStockBalances(tenantContext(), serviceUserId, outletA);
    expect(await balanceOf(itemId)).toEqual(live);
  });

  it("an occurred_at-ordered fold would give another average (discriminator)", async () => {
    const entries = await ledgerWithSeq(itemId);
    expect(entries).toHaveLength(3);
    const byOccurredAt = foldStockLedger(entries, "half_up").find(
      (balance) => balance.inventoryItemId === itemId,
    );
    expect(byOccurredAt).toMatchObject({
      quantity: "15.0000",
      avgCostIdr: "1500.0000",
    });
    expect(byOccurredAt!.avgCostIdr).not.toBe(live.avgCostIdr);
    const byPosting = foldStockLedger(entries, "half_up", "posting").find(
      (balance) => balance.inventoryItemId === itemId,
    );
    expect(byPosting).toMatchObject(live);
  });

  it("posting_seq strictly increases in insertion order", async () => {
    const { rows } = await owner.query<{ id: string; posting_seq: string }>(
      "SELECT id, posting_seq FROM stock_ledger WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
      [tenantA, locationId, itemId],
    );
    const seqById = new Map(
      rows.map((row) => [row.id, BigInt(row.posting_seq)]),
    );
    const seqs = posted.map((entry) => seqById.get(ulidToUuid(entry.id))!);
    expect(seqs.every((seq) => seq !== undefined)).toBe(true);
    for (let index = 1; index < seqs.length; index += 1)
      expect(seqs[index]! > seqs[index - 1]!).toBe(true);
    // The backdated row carries the largest sequence yet the earliest date.
    const earliest = [...posted].sort((left, right) =>
      left.occurredAt.localeCompare(right.occurredAt),
    )[0]!;
    expect(earliest.id).toBe(posted[2]!.id);
  });

  it("posting_seq cannot be written by anyone (GENERATED ALWAYS)", async () => {
    await expect(
      owner.query(
        `INSERT INTO stock_ledger
           (id, tenant_id, outlet_id, location_id, inventory_item_id, movement_type,
            quantity, unit_cost_idr, source_type, source_id, posting_seq)
         VALUES ($1, $2, $3, $4, $5, 'receipt', 1, 1, 'goods_receipt', $1, 1)`,
        [randomUUID(), tenantA, outletA, locationId, itemId],
      ),
    ).rejects.toThrow(/posting_seq|GENERATED ALWAYS/i);
  });
});

describe("legend-bsw9 tenant isolation", () => {
  const outletB = randomUUID();
  const locationB = randomUUID();
  const itemB = randomUUID();
  const ledgerB: string[] = [];

  beforeAll(async () => {
    // Backdated, out-of-order rows for tenant B. Foreign keys are skipped
    // (replica mode, superuser) because tenant B owns no outlet or item; the
    // check constraints still apply.
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const base = Date.now();
      for (const [offsetMinutes, quantity, cost] of [
        [0, 4, 500],
        [-60, 6, 900],
        [-30, 2, 700],
      ] as const) {
        const id = randomUUID();
        ledgerB.push(id);
        await client.query(
          `INSERT INTO stock_ledger
             (id, tenant_id, outlet_id, location_id, inventory_item_id, movement_type,
              quantity, unit_cost_idr, source_type, source_id, occurred_at)
           VALUES ($1, $2, $3, $4, $5, 'receipt', $6, $7, 'goods_receipt', $8, $9)`,
          [
            id,
            tenantB,
            outletB,
            locationB,
            itemB,
            quantity,
            cost,
            randomUUID(),
            new Date(base + offsetMinutes * 60_000).toISOString(),
          ],
        );
      }
      await client.query(
        `INSERT INTO stock_balances
           (tenant_id, outlet_id, location_id, inventory_item_id, quantity, avg_cost_idr)
         VALUES ($1, $2, $3, $4, 12, 733.3333)`,
        [tenantB, outletB, locationB, itemB],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  async function tenantBSnapshot() {
    const ledger = await owner.query(
      "SELECT id, posting_seq::text AS posting_seq, quantity, unit_cost_idr, occurred_at FROM stock_ledger WHERE tenant_id = $1 ORDER BY posting_seq",
      [tenantB],
    );
    const balances = await owner.query(
      "SELECT location_id, quantity, avg_cost_idr FROM stock_balances WHERE tenant_id = $1",
      [tenantB],
    );
    return { ledger: ledger.rows, balances: balances.rows };
  }

  it("rebuilding tenant A leaves tenant B ledger and balances untouched", async () => {
    const before = await tenantBSnapshot();
    expect(before.ledger).toHaveLength(3);
    expect(before.balances).toHaveLength(1);
    await rebuildStockBalances(tenantContext(), serviceUserId, outletA);
    expect(await tenantBSnapshot()).toEqual(before);
  });

  it("tenant A cannot see tenant B rows or their posting_seq (RLS)", async () => {
    const seen = await asTenant(tenantA, (client) =>
      client.query(
        "SELECT id, posting_seq FROM stock_ledger WHERE tenant_id = $1",
        [tenantB],
      ),
    );
    expect(seen.rows).toEqual([]);
    const own = await asTenant(tenantB, (client) =>
      client.query<{ id: string; posting_seq: string }>(
        "SELECT id, posting_seq FROM stock_ledger ORDER BY posting_seq",
      ),
    );
    expect(own.rows.map((row) => row.id)).toEqual(ledgerB);
  });

  it("append-only still holds: UPDATE and DELETE of posting_seq are rejected", async () => {
    await expect(
      asTenant(tenantA, (client) =>
        client.query("UPDATE stock_ledger SET posting_seq = DEFAULT"),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asTenant(tenantB, (client) =>
        client.query("UPDATE stock_ledger SET posting_seq = DEFAULT"),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asTenant(tenantA, (client) => client.query("DELETE FROM stock_ledger")),
    ).rejects.toThrow(/permission denied/);
    // GENERATED ALWAYS refuses any explicit value; DEFAULT reaches the
    // trigger, which stops the owner even for the new column.
    await expect(
      owner.query("UPDATE stock_ledger SET posting_seq = 0 WHERE id = $1", [
        ledgerB[0],
      ]),
    ).rejects.toThrow(/posting_seq/);
    await expect(
      owner.query(
        "UPDATE stock_ledger SET posting_seq = DEFAULT WHERE id = $1",
        [ledgerB[0]],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      owner.query("DELETE FROM stock_ledger WHERE id = $1", [ledgerB[0]]),
    ).rejects.toThrow(/append-only/);
  });
});

describe("foldStockLedger order", () => {
  const tenant = randomUUID();
  const outlet = randomUUID();
  const location = randomUUID();
  const item = randomUUID();

  function entry(
    quantity: string,
    unitCostIdr: string,
    occurredAt: string,
    movementType: "receipt" | "waste",
  ): StockLedgerEntry {
    return stockLedgerEntrySchema.parse({
      id: uuidToUlid(randomUUID()),
      tenantId: tenant,
      outletId: outletIdSchema.parse(outlet) as OutletId,
      locationId: location,
      inventoryItemId: item,
      movementType,
      quantity,
      unitCostIdr,
      batchId: null,
      sourceType: movementType === "receipt" ? "goods_receipt" : "waste_log",
      sourceId: randomUUID(),
      occurredAt,
    });
  }

  // Posting order: A (10 @ 1000), waste 5, B (10 @ 2000, dated before A).
  const a = entry(
    "10.0000",
    "1000.0000",
    "2026-11-10T10:00:00.000Z",
    "receipt",
  );
  const out = entry(
    "-5.0000",
    "1000.0000",
    "2026-11-10T10:00:01.000Z",
    "waste",
  );
  const b = entry(
    "10.0000",
    "2000.0000",
    "2026-11-10T09:00:00.000Z",
    "receipt",
  );

  it("default order stays occurred_at then id", () => {
    const [balance] = foldStockLedger([a, out, b], "half_up");
    expect(balance).toMatchObject({
      quantity: "15.0000",
      avgCostIdr: "1500.0000",
    });
    expect(foldStockLedger([a, out, b], "half_up", "occurred_at")).toEqual([
      balance,
    ]);
    // Input order does not matter for the default fold.
    expect(foldStockLedger([b, out, a], "half_up")).toEqual([balance]);
  });

  it('"posting" order folds by postingSeq, whatever the input or date order', () => {
    const posting = [
      { ...a, postingSeq: 1 },
      { ...out, postingSeq: 2 },
      { ...b, postingSeq: 3 },
    ];
    const [balance] = foldStockLedger(posting, "half_up", "posting");
    expect(balance).toMatchObject({
      quantity: "15.0000",
      avgCostIdr: "1666.6667",
    });
    expect(
      foldStockLedger([...posting].reverse(), "half_up", "posting"),
    ).toEqual([balance]);
  });

  it('"posting" order requires postingSeq', () => {
    expect(() =>
      foldStockLedger(
        [a, out, b] as unknown as PostedStockLedgerEntry[],
        "half_up",
        "posting",
      ),
    ).toThrow(/posting order needs postingSeq/);
    expect(() =>
      foldStockLedger(
        [{ ...a, postingSeq: 1 }, out] as unknown as PostedStockLedgerEntry[],
        "half_up",
        "posting",
      ),
    ).toThrow(/posting order needs postingSeq/);
  });
});
