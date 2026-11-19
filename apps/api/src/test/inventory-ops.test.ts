// Inventory operations integration tests (bead legend-ugo; PRD v1.7 §3 F16
// "Batch & Kedaluwarsa", "Par Level & Saran Pembelian", "Waste & Spoilage",
// "Lokasi Stok ... transfer antarlokasi"; §3 F17 "Produksi Batch"; AI-08).
//
// Runs against the disposable PostgreSQL test database: the migration owner
// seeds fixtures, the restricted legend_app login proves RLS, the services run
// through `withTenant`, and the HTTP block uses the real Express app (it needs
// `createInventoryOpsRouter()` mounted at /api/inventory, wired by the lead).
// Covers FEFO order, the no-oversell race, idempotency replay + fingerprint
// mismatch, transfer atomicity and cost carry, production costing (INV-02),
// par alert dedupe, the AI-08 rule, expiry alerts, TEN-01/TEN-03 denial.
import type { StockLocationId } from "@starter/shared/inventory";
import {
  expiryAlertQuerySchema,
  stockAlertQuerySchema,
  purchaseSuggestionQuerySchema,
} from "@starter/shared/inventory";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addBusinessDays,
  businessDateOf,
  businessDateSchema,
  CoreError,
  createUlid,
  decimal4,
  outletIdSchema,
  ulidToUuid,
  type BusinessDate,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  createProductionOrderInputSchema,
  createStockCountInputSchema,
  createStockTransferInputSchema,
  createWasteLogInputSchema,
  productionOrderQuerySchema,
  stockTransferListQuerySchema,
  transitionProductionOrderInputSchema,
  wasteLogQuerySchema,
} from "@starter/shared/inventory";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import {
  createStockBatch,
  recordStockMovement,
} from "../services/inventory.service.ts";
import {
  allocateFefo,
  fefoAvailability,
  listExpiryAlerts,
} from "../services/inventory-expiry.service.ts";
import {
  setInventoryRecipeSource,
  type RecipeForStock,
} from "../services/inventory-ops.shared.ts";
import { createStockCount } from "../services/inventory-count.service.ts";
import { listStockAlerts } from "../services/inventory-par-alerts.service.ts";
import {
  createProductionOrder,
  listProductionOrders,
  transitionProductionOrderStatus,
} from "../services/inventory-production.service.ts";
import { listPurchaseSuggestions } from "../services/inventory-suggestions.service.ts";
import {
  createStockTransfer,
  listStockTransfers,
} from "../services/inventory-transfer.service.ts";
import {
  createWasteLog,
  listWasteLogs,
} from "../services/inventory-waste.service.ts";
import { runInventoryExpiryJob } from "../worker/inventory-expiry.job.ts";
import { runInventoryParAlertJob } from "../worker/inventory-par-alerts.job.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0]!.id;
const outletB = cafeLegendPlatformFixtures.outlets[1]!.id;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});
const app = createApp();
const createdUserIds: string[] = [];

function tenantContext(
  tenantId = tenantA,
  outletIds: readonly string[] | null = null,
): ScopedTenantContext {
  const reach = outletIds?.map((id) => outletIdSchema.parse(id) as OutletId);
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
    reach === null || reach === undefined
      ? { kind: "tenant" }
      : { kind: "outlets", outletIds: reach },
  );
}

/** Runs `run` in a rolled-back legend_app transaction with tenant + outlets. */
async function asTenant<T>(
  tenantId: string,
  outlets: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
      [tenantId, outlets],
    );
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function caught(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => null,
    (error: unknown) => error,
  );
}

async function rejectsWithCode(run: Promise<unknown>, code: string) {
  const error = await caught(run);
  expect(error, `expected ${code}`).toBeInstanceOf(CoreError);
  expect((error as CoreError).code).toBe(code);
}

async function rejectsWithStatus(
  run: Promise<unknown>,
  status: number,
  code?: string,
) {
  const error = (await caught(run)) as {
    status?: number;
    code?: string;
  } | null;
  expect(error?.status, JSON.stringify(error)).toBe(status);
  if (code) expect(error?.code).toBe(code);
}

const short = () => randomUUID().slice(0, 6);
const key = (prefix: string) => `${prefix}-${randomUUID()}`;

async function insertUom(code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
    [tenantA, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
  );
  return rows[0]!.id;
}

async function insertLocation(
  name: string,
  type = "warehouse",
  outletId = outletA,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4) RETURNING id",
    [tenantA, outletId, `${name} ${short()}`, type],
  );
  return rows[0]!.id;
}

async function insertItem(
  name: string,
  baseUomId: string,
  options: {
    type?: "raw_material" | "semi_finished";
    parMin?: string;
    parMax?: string;
  } = {},
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable, par_min, par_max)
     VALUES ($1, $2, 'Bahan Baku', $3, $4, true, $5, $6) RETURNING id`,
    [
      tenantA,
      `${name} ${short()}`,
      options.type ?? "raw_material",
      baseUomId,
      options.parMin ?? null,
      options.parMax ?? null,
    ],
  );
  return rows[0]!.id;
}

/** A goods receipt (optionally into a new batch); returns the batch id. */
async function receive(
  locationId: string,
  itemId: string,
  quantity: string,
  unitCost: string,
  batch?: { code: string; expiresOn: string | null },
): Promise<string | null> {
  let batchId: string | null = null;
  if (batch)
    batchId = (
      await createStockBatch(tenantContext(), {
        outletId: outletA,
        locationId,
        inventoryItemId: itemId,
        batchCode: batch.code,
        expiresOn:
          batch.expiresOn === null
            ? null
            : businessDateSchema.parse(batch.expiresOn),
      })
    ).id;
  await recordStockMovement(tenantContext(), {
    outletId: outletA,
    locationId,
    inventoryItemId: itemId,
    movementType: "receipt",
    quantity: decimal4(quantity),
    unitCostIdr: decimal4(unitCost),
    batchId,
    sourceType: "goods_receipt",
    sourceId: randomUUID(),
    actor: { type: "system" },
  });
  return batchId;
}

async function balanceOf(locationId: string, itemId: string) {
  const { rows } = await owner.query<{ quantity: string; avg: string }>(
    "SELECT quantity::text AS quantity, avg_cost_idr::text AS avg FROM stock_balances WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
    [tenantA, locationId, itemId],
  );
  return rows[0] ?? null;
}

async function ledgerOf(sourceId: string) {
  const { rows } = await owner.query<{
    movement_type: string;
    quantity: string;
    unit_cost_idr: string;
    batch_id: string | null;
    location_id: string;
    inventory_item_id: string;
  }>(
    `SELECT movement_type, quantity::text AS quantity, unit_cost_idr::text AS unit_cost_idr,
            batch_id, location_id, inventory_item_id
     FROM stock_ledger WHERE tenant_id = $1 AND source_id = $2 ORDER BY occurred_at, id`,
    [tenantA, sourceId],
  );
  return rows;
}

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantA, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role for tenant ${tenantA}`);
  return rows[0].id;
}

async function assignRole(
  userId: string,
  templateKey: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
): Promise<void> {
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenantA,
      userId,
      await roleIdOf(templateKey),
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
}

async function insertUser(name: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [id, name, `${id}@example.com`],
  );
  createdUserIds.push(id);
  return id;
}

async function signedIn(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  return { client, userId };
}

// Test double for the recipe engine port (legend-db6 owns the real one).
const recipes = new Map<string, RecipeForStock>();
const menuRecipes = new Map<string, RecipeForStock>();
function useRecipeDouble() {
  setInventoryRecipeSource({
    loadRecipe: async (_tx, _context, recipeId) =>
      recipes.get(recipeId) ?? null,
    loadMenuItemRecipe: async (_tx, _context, menuItemId) =>
      menuRecipes.get(menuItemId) ?? null,
  });
}

let ownerUserId: string;
let otherUserId: string;
let gramId: string;
let kgId: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  ownerUserId = await insertUser("Inventory Ops Owner");
  await assignRole(ownerUserId, "owner", { type: "tenant" });
  otherUserId = await insertUser("Inventory Ops Second Owner");
  await assignRole(otherUserId, "owner", { type: "tenant" });
  gramId = await insertUom("g");
  kgId = await insertUom("kg");
});

beforeEach(() => {
  useRecipeDouble();
});

afterAll(async () => {
  setInventoryRecipeSource(null);
  if (createdUserIds.length > 0)
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantA, createdUserIds],
    );
  // Ledger rows are append-only (INV-01), so the stock fixtures stay in the
  // disposable database; every name carries a random suffix.
  await owner.end();
  await appPool.end();
});

// ---------------------------------------------------------------- FEFO unit

describe("F16 FEFO helpers (PRD §16 saran FEFO)", () => {
  const batch = (id: string, expiresOn: string | null) => ({
    id,
    tenantId: tenantA,
    outletId: outletA,
    locationId: randomUUID(),
    inventoryItemId: randomUUID(),
    batchCode: id.slice(0, 8),
    expiresOn: expiresOn as BusinessDate | null,
    receivedAt: "2026-11-01T00:00:00.000Z",
  });

  it("F16 attributes on-hand stock to the latest batches and draws the earliest first", () => {
    const early = batch(randomUUID(), "2099-01-05");
    const late = batch(randomUUID(), "2099-01-10");
    // Ledger says 5 + 5, but only 6 are on hand (4 left without a batch):
    // FEFO assumes the early batch went first.
    const availability = fefoAvailability(
      [
        { batch: late as never, remaining: decimal4("5.0000") },
        { batch: early as never, remaining: decimal4("5.0000") },
      ],
      decimal4("6.0000"),
    );
    expect(
      availability.batches.map((row) => [row.batch.id, row.available]),
    ).toEqual([
      [early.id, "1.0000"],
      [late.id, "5.0000"],
    ]);
    expect(availability.unbatched).toBe("0.0000");
    expect(
      allocateFefo(availability, decimal4("3.0000")).map((row) => [
        row.batch?.id ?? null,
        row.quantity,
      ]),
    ).toEqual([
      [early.id, "1.0000"],
      [late.id, "2.0000"],
    ]);
  });

  it("F16 draws unbatched stock last and attributes nothing to a negative balance", () => {
    const dated = batch(randomUUID(), "2099-01-05");
    const availability = fefoAvailability(
      [{ batch: dated as never, remaining: decimal4("2.0000") }],
      decimal4("5.0000"),
    );
    expect(availability.unbatched).toBe("3.0000");
    expect(
      allocateFefo(availability, decimal4("4.0000")).map((row) => [
        row.batch?.id ?? null,
        row.quantity,
      ]),
    ).toEqual([
      [dated.id, "2.0000"],
      [null, "2.0000"],
    ]);
    const negative = fefoAvailability(
      [{ batch: dated as never, remaining: decimal4("2.0000") }],
      decimal4("-1.0000"),
    );
    expect(negative.batches).toEqual([]);
    expect(negative.unbatched).toBe("0.0000");
  });
});

// ------------------------------------------------------------------- waste

describe("F16 waste & spoilage (PRD §16 Waste & Spoilage)", () => {
  it("F16 WASTE-01 posts waste FEFO (earliest expiry first) and values it at the moving average", async () => {
    const location = await insertLocation("Gudang Waste");
    const item = await insertItem("Susu UHT", gramId);
    const later = await receive(location, item, "5.0000", "1000.0000", {
      code: `L-${short()}`,
      expiresOn: "2099-01-10",
    });
    const earlier = await receive(location, item, "5.0000", "2000.0000", {
      code: `E-${short()}`,
      expiresOn: "2099-01-05",
    });
    await receive(location, item, "2.0000", "1500.0000");
    expect(await balanceOf(location, item)).toEqual({
      quantity: "12.0000",
      avg: "1500.0000",
    });

    const first = await createWasteLog(
      tenantContext(),
      ownerUserId,
      createWasteLogInputSchema.parse({
        outletId: outletA,
        locationId: location,
        targetType: "inventory_item",
        targetId: item,
        quantity: "6.0000",
        reason: "spoiled",
        idempotencyKey: key("waste"),
      }),
    );
    // 6 x Rp 1.500 moving average (PRD §16 "nilai kerugian").
    expect(first.valueIdr).toBe(9000);
    expect(
      (await ledgerOf(first.id))
        .map((row) => [
          row.movement_type,
          row.batch_id,
          row.quantity,
          row.unit_cost_idr,
        ])
        .sort(),
    ).toEqual(
      [
        // FEFO: the earlier batch is emptied, the later one only touched.
        ["waste", earlier, "-5.0000", "1500.0000"],
        ["waste", later, "-1.0000", "1500.0000"],
      ].sort(),
    );

    // The next waste finishes the dated batch, then takes unbatched stock.
    const second = await createWasteLog(
      tenantContext(),
      ownerUserId,
      createWasteLogInputSchema.parse({
        outletId: outletA,
        locationId: location,
        targetType: "inventory_item",
        targetId: item,
        quantity: "6.0000",
        reason: "expired",
        idempotencyKey: key("waste"),
      }),
    );
    expect(
      (await ledgerOf(second.id))
        .map((row) => [row.batch_id, row.quantity])
        .sort(),
    ).toEqual(
      [
        [later, "-4.0000"],
        [null, "-2.0000"],
      ].sort(),
    );
    expect((await balanceOf(location, item))?.quantity).toBe("0.0000");

    const page = await listWasteLogs(
      tenantContext(),
      ownerUserId,
      wasteLogQuerySchema.parse({
        outletId: outletA,
        locationId: location,
        limit: 1,
      }),
    );
    expect(page.data[0]?.id).toBe(second.id);
    expect(page.meta.nextCursor).not.toBeNull();
    const next = await listWasteLogs(
      tenantContext(),
      ownerUserId,
      wasteLogQuerySchema.parse({
        outletId: outletA,
        locationId: location,
        limit: 1,
        cursor: page.meta.nextCursor!,
      }),
    );
    expect(next.data[0]?.id).toBe(first.id);
  });

  it("F16 WASTE-02 refuses to waste more than the location holds (no negative stock)", async () => {
    const location = await insertLocation("Gudang Kurang");
    const item = await insertItem("Gula", gramId);
    await receive(location, item, "3.0000", "100.0000");
    const idempotencyKey = key("waste");
    await rejectsWithStatus(
      createWasteLog(
        tenantContext(),
        ownerUserId,
        createWasteLogInputSchema.parse({
          outletId: outletA,
          locationId: location,
          targetType: "inventory_item",
          targetId: item,
          quantity: "3.0001",
          reason: "dropped",
          idempotencyKey,
        }),
      ),
      409,
      "INSUFFICIENT_STOCK",
    );
    expect((await balanceOf(location, item))?.quantity).toBe("3.0000");
    const { rows } = await owner.query(
      "SELECT 1 FROM inventory_ops_idempotency WHERE tenant_id = $1 AND idempotency_key = $2",
      [tenantA, idempotencyKey],
    );
    // The failed attempt released its key with the rolled-back transaction.
    expect(rows).toHaveLength(0);
  });

  it("F16 WASTE-03 two concurrent wastes cannot oversell the same stock", async () => {
    const location = await insertLocation("Gudang Balapan");
    const item = await insertItem("Mentega", gramId);
    await receive(location, item, "10.0000", "50.0000");
    const attempt = () =>
      createWasteLog(
        tenantContext(),
        ownerUserId,
        createWasteLogInputSchema.parse({
          outletId: outletA,
          locationId: location,
          targetType: "inventory_item",
          targetId: item,
          quantity: "6.0000",
          reason: "spoiled",
          idempotencyKey: key("race"),
        }),
      );
    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((row) => row.status === "rejected") as
      PromiseRejectedResult | undefined;
    expect((rejected?.reason as { status?: number }).status).toBe(409);
    expect((await balanceOf(location, item))?.quantity).toBe("4.0000");
  });

  it("F16 WASTE-04 replays a retried waste and rejects a reused key (fingerprint)", async () => {
    const location = await insertLocation("Gudang Retry");
    const item = await insertItem("Tepung", gramId);
    await receive(location, item, "10.0000", "10.0000");
    const body = {
      outletId: outletA,
      locationId: location,
      targetType: "inventory_item",
      targetId: item,
      quantity: "2.0000",
      reason: "prep_error",
      idempotencyKey: key("retry"),
    };
    const first = await createWasteLog(
      tenantContext(),
      ownerUserId,
      createWasteLogInputSchema.parse(body),
    );
    const replay = await createWasteLog(
      tenantContext(),
      ownerUserId,
      createWasteLogInputSchema.parse(body),
    );
    expect(replay).toEqual(first);
    expect(await ledgerOf(first.id)).toHaveLength(1);
    expect((await balanceOf(location, item))?.quantity).toBe("8.0000");

    await rejectsWithCode(
      createWasteLog(
        tenantContext(),
        ownerUserId,
        createWasteLogInputSchema.parse({ ...body, quantity: "3.0000" }),
      ),
      "IDEMPOTENCY_KEY_REUSED",
    );
    // The same key from another user is a different request, never a replay.
    await rejectsWithCode(
      createWasteLog(
        tenantContext(),
        otherUserId,
        createWasteLogInputSchema.parse(body),
      ),
      "IDEMPOTENCY_KEY_REUSED",
    );
    expect((await balanceOf(location, item))?.quantity).toBe("8.0000");
  });

  it("legend-tk7i WASTE-06 a waste photo must be a stored object of this tenant", async () => {
    const location = await insertLocation("Gudang Foto");
    const item = await insertItem("Susu Foto", gramId);
    await receive(location, item, "10.0000", "10.0000");
    const body = (mediaId: string) =>
      createWasteLogInputSchema.parse({
        outletId: outletA,
        locationId: location,
        targetType: "inventory_item",
        targetId: item,
        quantity: "1.0000",
        reason: "spoiled",
        mediaId,
        idempotencyKey: key("photo"),
      });

    await rejectsWithStatus(
      createWasteLog(tenantContext(), ownerUserId, body(randomUUID())),
      422,
      "WASTE_MEDIA_NOT_FOUND",
    );
    expect((await balanceOf(location, item))?.quantity).toBe("10.0000");

    const mediaId = randomUUID();
    await owner.query(
      `INSERT INTO core_storage_objects (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, owner_user_id, source_kind)
       VALUES ($1, $2, $3, 'receipt', $4, 'image/jpeg', 1024, $5, 'waste_log')`,
      [
        tenantA,
        outletA,
        mediaId,
        `private/${tenantA}/${mediaId}.jpg`,
        ownerUserId,
      ],
    );
    const log = await createWasteLog(
      tenantContext(),
      ownerUserId,
      body(mediaId),
    );
    expect(log.mediaId).toBe(mediaId);
  });

  it("legend-ec8t2 WASTE-06 a waste photo cannot be a brand logo, a plain receipt or another tenant's object", async () => {
    const location = await insertLocation("Gudang Foto Ketat");
    const item = await insertItem("Susu Foto Ketat", gramId);
    await receive(location, item, "10.0000", "10.0000");
    const body = (mediaId: string) =>
      createWasteLogInputSchema.parse({
        outletId: outletA,
        locationId: location,
        targetType: "inventory_item",
        targetId: item,
        quantity: "1.0000",
        reason: "spoiled",
        mediaId,
        idempotencyKey: key("photo-strict"),
      });
    const brandLogo = randomUUID();
    const plainReceipt = randomUUID();
    await owner.query(
      `INSERT INTO core_storage_objects (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, owner_user_id, source_kind)
       VALUES ($1, NULL, $2, 'brand_logo', $3, 'image/webp', 1024, $4, NULL),
              ($1, $5, $6, 'receipt', $7, 'image/jpeg', 1024, $4, NULL)`,
      [
        tenantA,
        brandLogo,
        `private/${tenantA}/${brandLogo}.webp`,
        ownerUserId,
        outletA,
        plainReceipt,
        `private/${tenantA}/${plainReceipt}.jpg`,
      ],
    );
    for (const mediaId of [brandLogo, plainReceipt])
      await rejectsWithStatus(
        createWasteLog(tenantContext(), ownerUserId, body(mediaId)),
        422,
        "WASTE_MEDIA_NOT_FOUND",
      );
    expect((await balanceOf(location, item))?.quantity).toBe("10.0000");
  });

  it("F16 WASTE-05 a menu portion wastes its recipe ingredients; no recipe fails closed", async () => {
    const location = await insertLocation("Bar Waste");
    const espresso = await insertItem("Biji Kopi", gramId);
    await receive(location, espresso, "100.0000", "300.0000");
    const menuItemId = randomUUID();
    menuRecipes.set(menuItemId, {
      recipeId: randomUUID(),
      isActive: true,
      outputItemId: null,
      yieldQuantity: decimal4("1.0000"),
      yieldUomId: gramId,
      lines: [
        {
          componentType: "item",
          componentId: espresso,
          quantity: decimal4("18.0000"),
          uomId: gramId,
          wastePctBp: 0,
        },
      ],
      nestedOutputItemIds: new Map(),
    });
    const log = await createWasteLog(
      tenantContext(),
      ownerUserId,
      createWasteLogInputSchema.parse({
        outletId: outletA,
        locationId: location,
        targetType: "menu_item",
        targetId: menuItemId,
        quantity: "2.0000",
        reason: "quality_reject",
        idempotencyKey: key("menu-waste"),
      }),
    );
    // 2 portions x 18 g x Rp 300.
    expect(log.valueIdr).toBe(10_800);
    expect((await balanceOf(location, espresso))?.quantity).toBe("64.0000");

    await rejectsWithStatus(
      createWasteLog(
        tenantContext(),
        ownerUserId,
        createWasteLogInputSchema.parse({
          outletId: outletA,
          locationId: location,
          targetType: "menu_item",
          targetId: randomUUID(),
          quantity: "1.0000",
          reason: "dropped",
          idempotencyKey: key("menu-waste"),
        }),
      ),
      404,
      "RECIPE_NOT_FOUND",
    );
  });
});

// --------------------------------------------------------------- transfers

describe("F16 internal transfers (PRD §16 transfer antarlokasi)", () => {
  it("F16 TRANSFER-01 is atomic: one short line rejects the whole transfer", async () => {
    const from = await insertLocation("Gudang Asal");
    const to = await insertLocation("Chiller Tujuan", "chiller");
    const enough = await insertItem("Keju", gramId);
    const scarce = await insertItem("Krim", gramId);
    await receive(from, enough, "5.0000", "200.0000");
    await receive(from, scarce, "1.0000", "200.0000");
    const idempotencyKey = key("transfer");
    await rejectsWithStatus(
      createStockTransfer(
        tenantContext(),
        ownerUserId,
        createStockTransferInputSchema.parse({
          outletId: outletA,
          fromLocationId: from,
          toLocationId: to,
          lines: [
            { inventoryItemId: enough, quantity: "2.0000" },
            { inventoryItemId: scarce, quantity: "5.0000" },
          ],
          idempotencyKey,
        }),
      ),
      409,
      "INSUFFICIENT_STOCK",
    );
    // Neither leg of either line, nor the document, survived.
    expect((await balanceOf(from, enough))?.quantity).toBe("5.0000");
    expect(await balanceOf(to, enough)).toBeNull();
    const { rows } = await owner.query(
      "SELECT 1 FROM stock_transfers WHERE tenant_id = $1 AND idempotency_key = $2",
      [tenantA, idempotencyKey],
    );
    expect(rows).toHaveLength(0);
  });

  it("F16 TRANSFER-02 posts both legs at the source average and keeps batch identity", async () => {
    const from = await insertLocation("Gudang Batch");
    const to = await insertLocation("Dapur Batch", "chiller");
    const item = await insertItem("Daging Sapi", gramId);
    const batchCode = `S-${short()}`;
    const batchId = await receive(from, item, "4.0000", "3000.0000", {
      code: batchCode,
      expiresOn: "2099-02-01",
    });
    await receive(from, item, "1.0000", "3000.0000");
    // The destination already holds stock at another cost: the transfer-in
    // re-weights its own average with the source cost (cost per location).
    await receive(to, item, "5.0000", "1000.0000");

    const body = {
      outletId: outletA,
      fromLocationId: from,
      toLocationId: to,
      lines: [{ inventoryItemId: item, quantity: "5.0000" }],
      note: "Isi chiller dapur",
      idempotencyKey: key("transfer"),
    };
    const transfer = await createStockTransfer(
      tenantContext(),
      ownerUserId,
      createStockTransferInputSchema.parse(body),
    );
    const rows = await ledgerOf(ulidToUuid(transfer.id));
    // Rows posted in one transaction may share a millisecond, so compare the
    // set: FEFO batch first, then unbatched, each leg at the source average.
    expect(
      rows
        .map((row) => [
          row.movement_type,
          row.location_id,
          row.quantity,
          row.unit_cost_idr,
          row.batch_id === null
            ? "none"
            : row.batch_id === batchId
              ? "source"
              : "dest",
        ])
        .sort(),
    ).toEqual(
      [
        ["transfer_out", from, "-4.0000", "3000.0000", "source"],
        ["transfer_in", to, "4.0000", "3000.0000", "dest"],
        ["transfer_out", from, "-1.0000", "3000.0000", "none"],
        ["transfer_in", to, "1.0000", "3000.0000", "none"],
      ].sort(),
    );
    const destBatch = rows.find(
      (row) => row.movement_type === "transfer_in" && row.batch_id,
    )!;
    const { rows: batches } = await owner.query(
      "SELECT batch_code, expires_on::text AS expires_on, location_id FROM stock_batches WHERE id = $1",
      [destBatch.batch_id],
    );
    expect(batches[0]).toEqual({
      batch_code: batchCode,
      expires_on: "2099-02-01",
      location_id: to,
    });
    expect(await balanceOf(from, item)).toMatchObject({ quantity: "0.0000" });
    // (5 x 1000 + 5 x 3000) / 10.
    expect(await balanceOf(to, item)).toEqual({
      quantity: "10.0000",
      avg: "2000.0000",
    });

    // Replay returns the same document; a changed body under the key is a 409.
    const replay = await createStockTransfer(
      tenantContext(),
      ownerUserId,
      createStockTransferInputSchema.parse(body),
    );
    expect(replay.id).toBe(transfer.id);
    expect(await ledgerOf(ulidToUuid(transfer.id))).toHaveLength(4);
    await rejectsWithCode(
      createStockTransfer(
        tenantContext(),
        ownerUserId,
        createStockTransferInputSchema.parse({ ...body, note: "Beda" }),
      ),
      "IDEMPOTENCY_KEY_REUSED",
    );

    const list = await listStockTransfers(
      tenantContext(),
      ownerUserId,
      stockTransferListQuerySchema.parse({
        outletId: outletA,
        locationId: to,
        limit: 10,
      }),
    );
    expect(list.data.map((row) => row.id)).toContain(transfer.id);
  });
});

// -------------------------------------------------------------- production

describe("F17 production batches (PRD §17 Produksi Batch, INV-02)", () => {
  async function productionFixture() {
    const kitchen = await insertLocation("Dapur Produksi", "kitchen");
    const coffee = await insertItem("Kopi Bubuk", gramId);
    const sugar = await insertItem("Gula Aren", gramId);
    const coldBrew = await insertItem("Cold Brew", gramId, {
      type: "semi_finished",
    });
    // 1 kg = 1000 g for the coffee line (PRD §16 Item Bahan & Satuan).
    await owner.query(
      "INSERT INTO uom_conversions (tenant_id, inventory_item_id, from_uom_id, to_uom_id, factor) VALUES ($1, $2, $3, $4, '1000.0000')",
      [tenantA, coffee, kgId, gramId],
    );
    await receive(kitchen, coffee, "5000.0000", "2.0000");
    await receive(kitchen, sugar, "1000.0000", "5.0000");
    // production_orders.recipe_id has a real FK (legend-tk7i): the recipe row
    // must exist; the in-memory source still supplies its lines.
    const { rows: brandRows } = await owner.query<{ id: string }>(
      "SELECT id FROM brands WHERE tenant_id = $1 ORDER BY id LIMIT 1",
      [tenantA],
    );
    const { rows: recipeRows } = await owner.query<{ id: string }>(
      `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
       VALUES ($1, $2, $3, $4, '1000.0000', $5, true, $6) RETURNING id`,
      [
        tenantA,
        brandRows[0]!.id,
        `Cold Brew ${randomUUID().slice(0, 8)}`,
        coldBrew,
        gramId,
        ownerUserId,
      ],
    );
    const recipeId = recipeRows[0]!.id;
    recipes.set(recipeId, {
      recipeId,
      isActive: true,
      outputItemId: coldBrew,
      yieldQuantity: decimal4("1000.0000"),
      yieldUomId: gramId,
      lines: [
        {
          componentType: "item",
          componentId: coffee,
          quantity: decimal4("0.5000"),
          uomId: kgId,
          wastePctBp: 0,
        },
        {
          componentType: "item",
          componentId: sugar,
          quantity: decimal4("100.0000"),
          uomId: gramId,
          wastePctBp: 1000,
        },
      ],
      nestedOutputItemIds: new Map(),
    });
    return { kitchen, coffee, sugar, coldBrew, recipeId };
  }

  const transition = (
    orderId: string,
    action: "start" | "complete" | "cancel",
    actualQty?: string,
  ) =>
    transitionProductionOrderStatus(
      tenantContext(),
      ownerUserId,
      orderId,
      transitionProductionOrderInputSchema.parse({
        action,
        ...(actualQty ? { actualQty } : {}),
        idempotencyKey: key("prod-step"),
      }),
    );

  it("F17 PROD-01 consumes the planned recipe (conversion + prep loss) and puts the output away at cost / actual", async () => {
    const fx = await productionFixture();
    const createKey = key("prod");
    const input = {
      ...createProductionOrderInputSchema.parse({
        outletId: outletA,
        recipeId: fx.recipeId,
        plannedQty: "2000.0000",
        idempotencyKey: createKey,
      }),
      locationId: fx.kitchen as StockLocationId,
    };
    const order = await createProductionOrder(
      tenantContext(),
      ownerUserId,
      input,
    );
    expect(order.status).toBe("draft");
    const replay = await createProductionOrder(
      tenantContext(),
      ownerUserId,
      input,
    );
    expect(replay.id).toBe(order.id);

    await rejectsWithStatus(
      transition(order.id, "complete", "1800.0000"),
      409,
      "PRODUCTION_INVALID_TRANSITION",
    );
    expect((await transition(order.id, "start")).status).toBe("in_progress");
    const done = await transition(order.id, "complete", "1800.0000");
    // Coffee 0.5 kg x 2 = 1000 g x Rp 2 = 2000; sugar 200 g net / (1 − 10%)
    // = 222.2222 g x Rp 5 = 1111.111; batch Rp 3111 (rounded once).
    expect(done).toMatchObject({
      status: "completed",
      actualQty: "1800.0000",
      costIdr: 3111,
    });
    const rows = await ledgerOf(order.id);
    expect(
      rows
        .map((row) => [
          row.movement_type,
          row.inventory_item_id,
          row.quantity,
          row.unit_cost_idr,
        ])
        .sort(),
    ).toEqual(
      [
        ["production_out", fx.coffee, "-1000.0000", "2.0000"],
        ["production_out", fx.sugar, "-222.2222", "5.0000"],
        // 3111.111 / 1800 = 1.72839… -> 1.7284 per gram of cold brew.
        ["production_in", fx.coldBrew, "1800.0000", "1.7284"],
      ].sort(),
    );
    expect(await balanceOf(fx.kitchen, fx.coldBrew)).toEqual({
      quantity: "1800.0000",
      avg: "1.7284",
    });

    const list = await listProductionOrders(
      tenantContext(),
      ownerUserId,
      productionOrderQuerySchema.parse({
        outletId: outletA,
        status: "completed",
        limit: 100,
      }),
    );
    expect(list.data.some((row) => row.id === order.id)).toBe(true);
  });

  it("F17 PROD-02 a short component rejects the completion and posts nothing", async () => {
    const fx = await productionFixture();
    const order = await createProductionOrder(tenantContext(), ownerUserId, {
      ...createProductionOrderInputSchema.parse({
        outletId: outletA,
        recipeId: fx.recipeId,
        plannedQty: "100000.0000",
        idempotencyKey: key("prod"),
      }),
      locationId: fx.kitchen as StockLocationId,
    });
    await transition(order.id, "start");
    await rejectsWithStatus(
      transition(order.id, "complete", "90000.0000"),
      409,
      "INSUFFICIENT_STOCK",
    );
    expect(await ledgerOf(order.id)).toHaveLength(0);
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM production_orders WHERE id = $1",
      [order.id],
    );
    expect(rows[0]?.status).toBe("in_progress");
    expect((await balanceOf(fx.kitchen, fx.coffee))?.quantity).toBe(
      "5000.0000",
    );
  });

  it("F17 PROD-03 two concurrent completions of one batch post it once", async () => {
    const fx = await productionFixture();
    const order = await createProductionOrder(tenantContext(), ownerUserId, {
      ...createProductionOrderInputSchema.parse({
        outletId: outletA,
        recipeId: fx.recipeId,
        plannedQty: "1000.0000",
        idempotencyKey: key("prod"),
      }),
      locationId: fx.kitchen as StockLocationId,
    });
    await transition(order.id, "start");
    const results = await Promise.allSettled([
      transition(order.id, "complete", "900.0000"),
      transition(order.id, "complete", "900.0000"),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(
      (await ledgerOf(order.id)).filter(
        (row) => row.movement_type === "production_in",
      ),
    ).toHaveLength(1);
  });

  it("F17 PROD-04 fails closed without a recipe engine or a resolvable kitchen", async () => {
    setInventoryRecipeSource(null);
    await rejectsWithStatus(
      createProductionOrder(
        tenantContext(),
        ownerUserId,
        createProductionOrderInputSchema.parse({
          outletId: outletA,
          recipeId: randomUUID(),
          plannedQty: "1.0000",
          idempotencyKey: key("prod"),
        }),
      ),
      404,
      "RECIPE_NOT_FOUND",
    );
    useRecipeDouble();
    const fx = await productionFixture();
    // A second active kitchen makes the contract-only input ambiguous.
    await insertLocation("Dapur Kedua", "kitchen");
    await rejectsWithStatus(
      createProductionOrder(
        tenantContext(),
        ownerUserId,
        createProductionOrderInputSchema.parse({
          outletId: outletA,
          recipeId: fx.recipeId,
          plannedQty: "1.0000",
          idempotencyKey: key("prod"),
        }),
      ),
      422,
      "PRODUCTION_LOCATION_UNRESOLVED",
    );
  });
});

// -------------------------------------------------- par alerts + AI-08

describe("F16 par levels, critical alerts and AI-08 suggestions", () => {
  async function insertParLevel(
    locationId: string,
    itemId: string,
    parMin: string,
    parMax: string,
  ) {
    await owner.query(
      "INSERT INTO par_levels (tenant_id, outlet_id, location_id, inventory_item_id, par_min, par_max) VALUES ($1, $2, $3, $4, $5, $6)",
      [tenantA, outletA, locationId, itemId, parMin, parMax],
    );
  }

  async function alertsOf(itemId: string) {
    const { rows } = await owner.query<{ id: string; resolved: boolean }>(
      "SELECT id, resolved_at IS NOT NULL AS resolved FROM inventory_stock_alerts WHERE tenant_id = $1 AND inventory_item_id = $2 AND kind = 'par_critical' ORDER BY raised_at",
      [tenantA, itemId],
    );
    return rows;
  }

  async function criticalEventsOf(itemId: string): Promise<number> {
    const { rows } = await owner.query<{ count: string }>(
      "SELECT count(*) FROM domain_event_outbox WHERE tenant_id = $1 AND event->>'name' = 'stock.critical' AND event->'payload'->>'inventoryItemId' = $2",
      [tenantA, itemId],
    );
    return Number(rows[0]!.count);
  }

  const waste = (
    locationId: string,
    itemId: string,
    quantity: string,
    actorUserId = ownerUserId,
  ) =>
    createWasteLog(
      tenantContext(),
      actorUserId,
      createWasteLogInputSchema.parse({
        outletId: outletA,
        locationId,
        targetType: "inventory_item",
        targetId: itemId,
        quantity,
        reason: "spoiled",
        idempotencyKey: key("par-waste"),
      }),
    );

  it("F16 PAR-01 raises one critical alert per breach and re-raises only after recovery", async () => {
    const location = await insertLocation("Gudang Par");
    const item = await insertItem("Santan", gramId);
    await insertParLevel(location, item, "5.0000", "20.0000");
    await receive(location, item, "10.0000", "100.0000");

    await waste(location, item, "6.0000");
    expect(await alertsOf(item)).toMatchObject([{ resolved: false }]);
    expect(await criticalEventsOf(item)).toBe(1);

    // Still below parMin: no repeat alert, no second event.
    await waste(location, item, "1.0000");
    await runInventoryParAlertJob(tenantContext(), new Date(), { force: true });
    expect(await alertsOf(item)).toHaveLength(1);
    expect(await criticalEventsOf(item)).toBe(1);

    const open = await listStockAlerts(
      tenantContext(),
      ownerUserId,
      stockAlertQuerySchema.parse({
        outletId: outletA,
        kind: "par_critical",
        locationId: location,
        limit: 25,
      }),
    );
    expect(open.data).toEqual([
      expect.objectContaining({
        inventoryItemId: item,
        quantity: "4.0000",
        parMin: "5.0000",
      }),
    ]);

    // A receipt recovers the stock; the sweep resolves the alert.
    await receive(location, item, "10.0000", "100.0000");
    await runInventoryParAlertJob(tenantContext(), new Date(), { force: true });
    expect(await alertsOf(item)).toMatchObject([{ resolved: true }]);

    // A new breach after recovery alerts again.
    await waste(location, item, "10.0000");
    expect(await alertsOf(item)).toMatchObject([
      { resolved: true },
      { resolved: false },
    ]);
    expect(await criticalEventsOf(item)).toBe(2);
  });

  it("legend-r2zv stock.critical withholds quantity while a blind count of the pair is open", async () => {
    const location = await insertLocation("Gudang Buta");
    const item = await insertItem("Kopi Buta", gramId);
    const free = await insertItem("Teh Bebas", gramId);
    await insertParLevel(location, item, "5.0000", "20.0000");
    await insertParLevel(location, free, "5.0000", "20.0000");
    await receive(location, item, "10.0000", "100.0000");
    await receive(location, free, "10.0000", "100.0000");
    const { rows: outletRows } = await owner.query<{
      timezone: string;
      business_day_cutoff: string;
    }>(
      "SELECT timezone, business_day_cutoff FROM outlets WHERE tenant_id = $1 AND id = $2",
      [tenantA, outletA],
    );
    await createStockCount(
      tenantContext(),
      ownerUserId,
      createStockCountInputSchema.parse({
        outletId: outletA,
        locationId: location,
        type: "cycle",
        blind: true,
        businessDate: businessDateOf(new Date(), {
          timeZone: outletRows[0]!.timezone,
          cutoff: outletRows[0]!.business_day_cutoff,
        }),
        inventoryItemIds: [item],
        idempotencyKey: key("r2zv-count"),
      }),
    );

    // The counter (ownerUserId) is locked out of moving the hidden pair out
    // (0hzu), so a second, non-counter actor posts the breaching waste.
    await waste(location, item, "6.0000", otherUserId);
    await waste(location, free, "6.0000");
    const quantityOf = async (itemId: string) => {
      const { rows } = await owner.query<{ quantity: string | null }>(
        "SELECT event->'payload'->>'quantity' AS quantity FROM domain_event_outbox WHERE tenant_id = $1 AND event->>'name' = 'stock.critical' AND event->'payload'->>'inventoryItemId' = $2",
        [tenantA, itemId],
      );
      return rows.map((row) => row.quantity);
    };
    // The event still fires (the alert is real) but carries no quantity for
    // the pair under blind count; an unrelated pair keeps its quantity.
    expect(await quantityOf(item)).toEqual([null]);
    expect(await quantityOf(free)).toEqual(["4.0000"]);
  });

  it("AI-08 SUGGEST-01 refills below-min pairs to parMax, location par over item default", async () => {
    const location = await insertLocation("Gudang Saran");
    // Location override (min 5, max 20) beats the item default (1, 2).
    const overridden = await insertItem("Telur", gramId, {
      parMin: "1.0000",
      parMax: "2.0000",
    });
    await insertParLevel(location, overridden, "5.0000", "20.0000");
    await receive(location, overridden, "3.0000", "10.0000");
    // Item default only (min 10, max 30), 4 on hand: the most critical.
    const defaulted = await insertItem("Beras", gramId, {
      parMin: "10.0000",
      parMax: "30.0000",
    });
    await receive(location, defaulted, "4.0000", "10.0000");
    // Within par: no suggestion.
    const healthy = await insertItem("Garam", gramId, {
      parMin: "1.0000",
      parMax: "5.0000",
    });
    await receive(location, healthy, "3.0000", "10.0000");

    const rows = await listPurchaseSuggestions(
      tenantContext(),
      ownerUserId,
      purchaseSuggestionQuerySchema.parse({
        outletId: outletA,
        locationId: location,
      }),
    );
    expect(
      rows.map((row) => [
        row.inventoryItemId,
        row.onHand,
        row.suggestedQty,
        row.parSource,
      ]),
    ).toEqual([
      // 4 / 10 = 0.4 before 3 / 5 = 0.6.
      [defaulted, "4.0000", "26.0000", "item_default"],
      [overridden, "3.0000", "17.0000", "location"],
    ]);
    expect(rows.every((row) => row.basis === "par_level")).toBe(true);
  });
});

// ------------------------------------------------------------------ expiry

describe("F16 expiry alerts (PRD §16 peringatan menjelang kedaluwarsa)", () => {
  it("F16 EXPIRY-01 lists expired/expiring batches FEFO, dedupes alerts and resolves used-up batches", async () => {
    const { rows: outletRows } = await owner.query<{
      timezone: string;
      business_day_cutoff: string;
    }>("SELECT timezone, business_day_cutoff FROM outlets WHERE id = $1", [
      outletA,
    ]);
    const today = businessDateOf(new Date(), {
      timeZone: outletRows[0]!.timezone,
      cutoff: outletRows[0]!.business_day_cutoff,
    });
    const { rows: settings } = await owner.query<{ days: number }>(
      "SELECT expiry_warning_days AS days FROM inventory_settings WHERE tenant_id = $1",
      [tenantA],
    );
    const warnDays = settings[0]?.days ?? 7;

    const location = await insertLocation("Chiller Expiry", "chiller");
    const item = await insertItem("Yoghurt", gramId);
    const expired = await receive(location, item, "2.0000", "100.0000", {
      code: `X-${short()}`,
      expiresOn: addBusinessDays(today, -1),
    });
    const soon = await receive(location, item, "3.0000", "100.0000", {
      code: `S-${short()}`,
      expiresOn: addBusinessDays(today, 1),
    });
    await receive(location, item, "4.0000", "100.0000", {
      code: `F-${short()}`,
      expiresOn: addBusinessDays(today, warnDays + 30),
    });

    const listed = await listExpiryAlerts(
      tenantContext(),
      ownerUserId,
      expiryAlertQuerySchema.parse({
        outletId: outletA,
        locationId: location,
      }),
    );
    expect(
      listed.map((row) => [
        row.batch.id,
        row.status,
        row.availableQty,
        row.fefoRank,
      ]),
    ).toEqual([
      [expired, "expired", "2.0000", 1],
      [soon, "expiring_soon", "3.0000", 2],
    ]);

    // A sale deducted without a batch (recipe deduction) took 2: FEFO says it
    // was the expired batch, so that batch no longer needs attention.
    await recordStockMovement(tenantContext(), {
      outletId: outletA,
      locationId: location,
      inventoryItemId: item,
      movementType: "sale",
      quantity: decimal4("-2.0000"),
      sourceType: "order",
      sourceId: createUlid(),
      actor: { type: "system" },
    });
    const afterSale = await listExpiryAlerts(
      tenantContext(),
      ownerUserId,
      expiryAlertQuerySchema.parse({
        outletId: outletA,
        locationId: location,
      }),
    );
    expect(afterSale.map((row) => [row.batch.id, row.fefoRank])).toEqual([
      [soon, 1],
    ]);

    const openFor = async (batchId: string | null) => {
      const { rows } = await owner.query(
        "SELECT kind FROM inventory_stock_alerts WHERE tenant_id = $1 AND batch_id = $2 AND resolved_at IS NULL",
        [tenantA, batchId],
      );
      return rows.map((row: { kind: string }) => row.kind);
    };
    await runInventoryExpiryJob(tenantContext(), new Date(), { force: true });
    await runInventoryExpiryJob(tenantContext(), new Date(), { force: true });
    expect(await openFor(soon)).toEqual(["expiring_soon"]);
    expect(await openFor(expired)).toEqual([]);

    // Wasting the expiring stock (FEFO takes that batch) resolves its alert.
    await createWasteLog(
      tenantContext(),
      ownerUserId,
      createWasteLogInputSchema.parse({
        outletId: outletA,
        locationId: location,
        targetType: "inventory_item",
        targetId: item,
        quantity: "3.0000",
        reason: "expired",
        idempotencyKey: key("expiry-waste"),
      }),
    );
    await runInventoryExpiryJob(tenantContext(), new Date(), { force: true });
    expect(await openFor(soon)).toEqual([]);
  });
});

// --------------------------------------------------------------- isolation

describe("TEN-01/TEN-03 isolation of the operation tables", () => {
  it("TEN-01 another tenant sees no waste, production, alert or idempotency rows", async () => {
    const counts = await asTenant(randomUUID(), "*", async (client) => {
      const result = await client.query(
        `SELECT
           (SELECT count(*) FROM waste_logs) AS waste,
           (SELECT count(*) FROM production_orders) AS production,
           (SELECT count(*) FROM inventory_stock_alerts) AS alerts,
           (SELECT count(*) FROM inventory_ops_idempotency) AS keys`,
      );
      return result.rows[0];
    });
    expect(counts).toEqual({
      waste: "0",
      production: "0",
      alerts: "0",
      keys: "0",
    });
    await rejectsWithStatus(
      listWasteLogs(
        tenantContext(randomUUID() as never),
        ownerUserId,
        wasteLogQuerySchema.parse({
          outletId: outletA,
          limit: 10,
        }),
      ),
      403,
    );
  });

  it("TEN-03 an outlet-scoped caller cannot reach another outlet's operations", async () => {
    const scoped = tenantContext(tenantA, [outletB]);
    const location = await insertLocation("Gudang Scope");
    const item = await insertItem("Cokelat", gramId);
    await receive(location, item, "5.0000", "100.0000");
    await rejectsWithCode(
      createWasteLog(
        scoped,
        ownerUserId,
        createWasteLogInputSchema.parse({
          outletId: outletA,
          locationId: location,
          targetType: "inventory_item",
          targetId: item,
          quantity: "1.0000",
          reason: "dropped",
          idempotencyKey: key("scope"),
        }),
      ),
      "OUTLET_OUT_OF_SCOPE",
    );
    await rejectsWithCode(
      listPurchaseSuggestions(
        scoped,
        ownerUserId,
        purchaseSuggestionQuerySchema.parse({ outletId: outletA }),
      ),
      "OUTLET_OUT_OF_SCOPE",
    );
    // An outlet-B location in an outlet-A transfer is "not found" (TEN-03).
    const locationB = await insertLocation("Gudang B", "warehouse", outletB);
    await rejectsWithStatus(
      createStockTransfer(
        tenantContext(),
        ownerUserId,
        createStockTransferInputSchema.parse({
          outletId: outletA,
          fromLocationId: location,
          toLocationId: locationB,
          lines: [{ inventoryItemId: item, quantity: "1.0000" }],
          idempotencyKey: key("scope"),
        }),
      ),
      404,
    );
    const log = await createWasteLog(
      tenantContext(),
      ownerUserId,
      createWasteLogInputSchema.parse({
        outletId: outletA,
        locationId: location,
        targetType: "inventory_item",
        targetId: item,
        quantity: "1.0000",
        reason: "dropped",
        idempotencyKey: key("scope"),
      }),
    );
    // Outlet RLS hides outlet A's rows from an outlet-B-only session.
    const visible = await asTenant(
      tenantA,
      JSON.stringify([outletB]),
      async (client) =>
        (
          await client.query("SELECT id FROM waste_logs WHERE id = $1", [
            log.id,
          ])
        ).rows,
    );
    expect(visible).toHaveLength(0);
  });
});

// --------------------------------------------------------------------- HTTP

describe("inventory ops API (createInventoryOpsRouter at /api/inventory)", () => {
  it("requires a session, a trusted origin and the operation permission", async () => {
    expect(
      (await agent(app).get(`/api/inventory/stock-alerts?outletId=${outletA}`))
        .status,
    ).toBe(401);

    const kitchen = await signedIn("Kitchen Lead Ops");
    await assignRole(kitchen.userId, "kitchen_lead", {
      type: "outlet",
      id: outletA,
    });
    const location = await insertLocation("Dapur API", "kitchen");
    const item = await insertItem("Jahe", gramId);
    await receive(location, item, "5.0000", "100.0000");
    const body = {
      outletId: outletA,
      locationId: location,
      targetType: "inventory_item",
      targetId: item,
      quantity: "1.0000",
      reason: "spoiled",
      idempotencyKey: key("http"),
    };

    // Mutations need the trusted Origin header (CSRF).
    expect(
      (await kitchen.client.post("/api/inventory/waste-logs").send(body))
        .status,
    ).toBe(403);
    // Strict Zod: a client-supplied loss value is rejected.
    const withValue = await kitchen.client
      .post("/api/inventory/waste-logs")
      .set(originHeader)
      .send({ ...body, valueIdr: 1 });
    expect(withValue.status).toBe(422);
    // Another outlet: denied before the service runs.
    const otherOutlet = await kitchen.client
      .post("/api/inventory/waste-logs")
      .set(originHeader)
      .send({ ...body, outletId: outletB });
    expect(otherOutlet.status).toBe(403);
    // Kitchen lead records waste (inventory.waste.record) ...
    const created = await kitchen.client
      .post("/api/inventory/waste-logs")
      .set(originHeader)
      .send(body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // ... but has no cost view: the loss value is masked.
    expect(created.body.data.valueIdr).toBe(0);
    // ... and cannot move stock between locations (no inventory.stock.transfer).
    const transfer = await kitchen.client
      .post("/api/inventory/transfers")
      .set(originHeader)
      .send({
        outletId: outletA,
        fromLocationId: location,
        toLocationId: await insertLocation("Bar API", "bar"),
        lines: [{ inventoryItemId: item, quantity: "1.0000" }],
        idempotencyKey: key("http"),
      });
    expect(transfer.status).toBe(403);

    for (const path of [
      "expiry-alerts",
      "stock-alerts",
      "purchase-suggestions",
      "waste-logs",
      "transfers",
      "production-orders",
    ]) {
      const response = await kitchen.client.get(
        `/api/inventory/${path}?outletId=${outletA}`,
      );
      expect(response.status, path).toBe(200);
      expect(Array.isArray(response.body.data), path).toBe(true);
    }
  });
});
