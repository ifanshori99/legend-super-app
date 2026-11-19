// Blind-count movement lock (bead 0hzu; PRD v1.7 §3 F16 "Stok Opname" hitung
// buta, INV-01). Contract: docs/briefs/sub-1167-p3-webhook-opname.md section B
// and the shared inventory error table (`BLIND_COUNT_LOCKED`, HTTP 409).
//
// The leak: a counter of an open blind count cannot read the stock of the
// counted (location, item) pair, but could probe it by moving stock out
// (waste, transfer, production) and watching 409 INSUFFICIENT_STOCK vs success.
// The rule under test: for that counter, an outgoing movement of the hidden
// pair is refused UNIFORMLY (409 BLIND_COUNT_LOCKED, same message) whether the
// stock would have covered the movement or not, and nothing is posted.
//
// Actors (real signed-in users):
//   counter    warehouse @ A                   creates the blind counts
//   prodCount  warehouse + kitchen_lead @ A    counter who may also run production
//   counter2   warehouse @ A                   NOT a counter of the counts below
//   cook       kitchen_lead @ A                NOT a counter (production probes)
//
// Assumptions (the brief is loose):
// - "Counter" = the count creator (counter_ids), or a user who entered a line.
// - A blind count hides the pair from creation (draft) until posted/cancelled.
// - Production consumes components when the batch is completed, so the lock is
//   probed at the `complete` transition (the order is created and started
//   before the count opens).
// - The lock answers 409 with code BLIND_COUNT_LOCKED and one fixed message.
// - A non-counter keeps today's behaviour (success, or 409 INSUFFICIENT_STOCK).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decimal4 } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import {
  setInventoryRecipeSource,
  type RecipeForStock,
} from "../services/inventory-ops.shared.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0]!.id;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const app = createApp();
const createdUserIds: string[] = [];

const short = () => randomUUID().slice(0, 6);
const key = (prefix: string) => `${prefix}-${randomUUID()}`;
const today = new Date().toISOString().slice(0, 10);

function tenantContext() {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantA,
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

// ------------------------------------------------------------------ seeding

let gramId: string;

async function insertUom(code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
    [tenantA, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
  );
  return rows[0]!.id;
}

async function insertLocation(name: string, type = "warehouse") {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4) RETURNING id",
    [tenantA, outletA, `${name} ${short()}`, type],
  );
  return rows[0]!.id;
}

async function insertItem(name: string, type = "raw_material") {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', $3, $4, true) RETURNING id`,
    [tenantA, `${name} ${short()}`, type, gramId],
  );
  return rows[0]!.id;
}

async function receive(locationId: string, itemId: string, quantity: string) {
  await recordStockMovement(tenantContext(), {
    outletId: outletA,
    locationId,
    inventoryItemId: itemId,
    movementType: "receipt",
    quantity: decimal4(quantity),
    unitCostIdr: decimal4("1500.0000"),
    batchId: null,
    sourceType: "goods_receipt",
    sourceId: randomUUID(),
    actor: { type: "system" },
  });
}

async function balanceOf(locationId: string, itemId: string) {
  const { rows } = await owner.query<{ quantity: string }>(
    "SELECT quantity::text AS quantity FROM stock_balances WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
    [tenantA, locationId, itemId],
  );
  return rows[0]?.quantity ?? null;
}

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantA, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role for tenant ${tenantA}`);
  return rows[0].id;
}

async function assignRole(userId: string, templateKey: string) {
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenantA, userId, await roleIdOf(templateKey), outletA],
  );
}

type Actor = { client: ReturnType<typeof agent>; userId: string };

async function makeActor(name: string, roles: string[]): Promise<Actor> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  for (const templateKey of roles) await assignRole(userId, templateKey);
  return { client, userId };
}

let counter: Actor;
let prodCounter: Actor;
let counter2: Actor;
let cook: Actor;

// Test double for the recipe engine port (production probes).
const recipes = new Map<string, RecipeForStock>();

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  gramId = await insertUom("g");
  counter = await makeActor("Lock Counter", ["warehouse"]);
  prodCounter = await makeActor("Lock Prod Counter", [
    "warehouse",
    "kitchen_lead",
  ]);
  counter2 = await makeActor("Lock Counter Two", ["warehouse"]);
  cook = await makeActor("Lock Cook", ["kitchen_lead"]);
});

beforeEach(() => {
  setInventoryRecipeSource({
    loadRecipe: async (_tx, _context, recipeId) =>
      recipes.get(recipeId) ?? null,
    loadMenuItemRecipe: async () => null,
  });
});

afterAll(async () => {
  setInventoryRecipeSource(null);
  if (createdUserIds.length > 0)
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantA, createdUserIds],
    );
  await owner.end();
});

// ------------------------------------------------------------------ HTTP kit

const countsBase = "/api/inventory/stock-counts";

async function ok(response: Response, status?: number): Promise<Response> {
  if (status === undefined)
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  else expect(response.status, JSON.stringify(response.body)).toBe(status);
  return response;
}

async function createBlindCount(
  actor: Actor,
  locationId: string,
  itemIds: string[],
  options: { blind?: boolean } = {},
): Promise<string> {
  const response = await actor.client
    .post(countsBase)
    .set(originHeader)
    .send({
      outletId: outletA,
      locationId,
      type: "cycle",
      blind: options.blind ?? true,
      businessDate: today,
      inventoryItemIds: itemIds,
      idempotencyKey: key("lock-count"),
    });
  await ok(response, 201);
  return response.body.data.count.id as string;
}

function countTransition(actor: Actor, countId: string, action: string) {
  return actor.client
    .post(`${countsBase}/${countId}/transitions`)
    .set(originHeader)
    .send({ action, idempotencyKey: key(action) });
}

/** The locked answer is fixed: status, code and message never vary. */
function expectLocked(response: Response) {
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(response.body.error?.code).toBe("BLIND_COUNT_LOCKED");
  expect(response.body.data).toBeUndefined();
}

function lockedShape(response: Response) {
  return {
    status: response.status,
    code: response.body.error?.code,
    message: response.body.error?.message,
  };
}

// ----------------------------------------------------- the three outgoing ops

type Mode = "enough" | "short";

/**
 * One outgoing movement of a (location, item) pair. `prepare` seeds the stock
 * and runs everything that must happen BEFORE a count opens; `attempt` is the
 * outgoing movement itself, sized to be covered ("enough") or not ("short").
 */
type Operation = {
  name: string;
  /** Actor that may run this operation and is also a counter of the count. */
  counterActor: () => Actor;
  /** An actor allowed to run the operation who is NOT a counter. */
  otherActor: () => Actor;
  prepare: (mode: Mode) => Promise<Fixture>;
};

type Fixture = {
  /** Location whose pair the blind count covers. */
  locationId: string;
  /** The item that leaves `locationId` (and is counted). */
  itemId: string;
  /** The outgoing movement, sized by the mode given to `prepare`. */
  attempt: (actor: Actor) => Promise<Response>;
};

const wasteOperation: Operation = {
  name: "waste",
  counterActor: () => counter,
  otherActor: () => counter2,
  prepare: async (mode) => {
    const locationId = await insertLocation("Lock Waste");
    const itemId = await insertItem("Lock Waste Item");
    await receive(locationId, itemId, "10.0000");
    return {
      locationId,
      itemId,
      attempt: (actor) =>
        actor.client
          .post("/api/inventory/waste-logs")
          .set(originHeader)
          .send({
            outletId: outletA,
            locationId,
            targetType: "inventory_item",
            targetId: itemId,
            quantity: mode === "enough" ? "2.0000" : "50.0000",
            reason: "spoiled",
            idempotencyKey: key("lock-waste"),
          }),
    };
  },
};

const transferOperation: Operation = {
  name: "transfer",
  counterActor: () => counter,
  otherActor: () => counter2,
  prepare: async (mode) => {
    const locationId = await insertLocation("Lock Transfer From");
    const toLocationId = await insertLocation("Lock Transfer To", "bar");
    const itemId = await insertItem("Lock Transfer Item");
    await receive(locationId, itemId, "10.0000");
    return {
      locationId,
      itemId,
      attempt: (actor) =>
        actor.client
          .post("/api/inventory/transfers")
          .set(originHeader)
          .send({
            outletId: outletA,
            fromLocationId: locationId,
            toLocationId,
            lines: [
              {
                inventoryItemId: itemId,
                quantity: mode === "enough" ? "2.0000" : "50.0000",
              },
            ],
            idempotencyKey: key("lock-transfer"),
          }),
    };
  },
};

async function productionFixture(mode: Mode, starter: Actor): Promise<Fixture> {
  const kitchen = await insertLocation("Lock Dapur", "kitchen");
  const coffee = await insertItem("Lock Kopi");
  const output = await insertItem("Lock Cold Brew", "semi_finished");
  await receive(kitchen, coffee, "5000.0000");
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
      `Lock Cold Brew ${short()}`,
      output,
      gramId,
      starter.userId,
    ],
  );
  const recipeId = recipeRows[0]!.id;
  // 500 g of coffee per 1000 g batch: planned 2000 needs 1000 g (covered by
  // 5000 g); planned 20000 needs 10000 g (not covered).
  recipes.set(recipeId, {
    recipeId,
    isActive: true,
    outputItemId: output,
    yieldQuantity: decimal4("1000.0000"),
    yieldUomId: gramId,
    lines: [
      {
        componentType: "item",
        componentId: coffee,
        quantity: decimal4("500.0000"),
        uomId: gramId,
        wastePctBp: 0,
      },
    ],
    nestedOutputItemIds: new Map(),
  });
  const created = await starter.client
    .post("/api/inventory/production-orders")
    .set(originHeader)
    .send({
      outletId: outletA,
      recipeId,
      plannedQty: mode === "enough" ? "2000.0000" : "20000.0000",
      locationId: kitchen,
      idempotencyKey: key("lock-prod"),
    });
  await ok(created, 201);
  const orderId = created.body.data.id as string;
  await ok(
    await starter.client
      .post(`/api/inventory/production-orders/${orderId}/transitions`)
      .set(originHeader)
      .send({ action: "start", idempotencyKey: key("lock-prod-start") }),
  );
  return {
    locationId: kitchen,
    itemId: coffee,
    attempt: (actor) =>
      actor.client
        .post(`/api/inventory/production-orders/${orderId}/transitions`)
        .set(originHeader)
        .send({
          action: "complete",
          actualQty: mode === "enough" ? "1800.0000" : "18000.0000",
          idempotencyKey: key("lock-prod-complete"),
        }),
  };
}

const productionOperation: Operation = {
  name: "production",
  counterActor: () => prodCounter,
  otherActor: () => cook,
  // The batch is started by the counter-capable user in every case; only the
  // actor that completes it differs between the probes.
  prepare: (mode) => productionFixture(mode, prodCounter),
};

const operations = [wasteOperation, transferOperation, productionOperation];

// =========================================================================

for (const op of operations) {
  describe(`0hzu ${op.name}: a counter of an open blind count cannot probe the hidden stock`, () => {
    it("is refused 409 BLIND_COUNT_LOCKED when stock would cover the movement, and posts nothing", async () => {
      const fx = await op.prepare("enough");
      const before = await balanceOf(fx.locationId, fx.itemId);
      await createBlindCount(op.counterActor(), fx.locationId, [fx.itemId]);

      expectLocked(await fx.attempt(op.counterActor()));
      expect(await balanceOf(fx.locationId, fx.itemId)).toBe(before);
    });

    it("answers the identical locked response when stock would NOT cover it (no insufficient-stock signal)", async () => {
      const covered = await op.prepare("enough");
      const uncovered = await op.prepare("short");
      for (const fx of [covered, uncovered])
        await createBlindCount(op.counterActor(), fx.locationId, [fx.itemId]);

      const coveredAnswer = await covered.attempt(op.counterActor());
      const uncoveredAnswer = await uncovered.attempt(op.counterActor());

      expectLocked(coveredAnswer);
      expectLocked(uncoveredAnswer);
      // The answer must not depend on stock: same status, code and message,
      // and the message carries no quantity.
      expect(lockedShape(uncoveredAnswer)).toEqual(lockedShape(coveredAnswer));
      expect(String(uncoveredAnswer.body.error?.message)).not.toMatch(/\d/);
      // And it never became INSUFFICIENT_STOCK.
      expect(uncoveredAnswer.body.error?.code).not.toBe("INSUFFICIENT_STOCK");
    });

    it("keeps working for a user who is not a counter of the count", async () => {
      const covered = await op.prepare("enough");
      await createBlindCount(op.counterActor(), covered.locationId, [
        covered.itemId,
      ]);
      const done = await ok(await covered.attempt(op.otherActor()));
      expect(done.body.error).toBeUndefined();

      // A non-counter still gets the plain stock answer when stock is short.
      const uncovered = await op.prepare("short");
      await createBlindCount(op.counterActor(), uncovered.locationId, [
        uncovered.itemId,
      ]);
      const refused = await uncovered.attempt(op.otherActor());
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error?.code).toBe("INSUFFICIENT_STOCK");
    });

    it("does not lock a counter whose count is not blind", async () => {
      const fx = await op.prepare("enough");
      await createBlindCount(op.counterActor(), fx.locationId, [fx.itemId], {
        blind: false,
      });
      await ok(await fx.attempt(op.counterActor()));
    });

    it("moves the pair again once the blind count is cancelled", async () => {
      const fx = await op.prepare("enough");
      const countId = await createBlindCount(op.counterActor(), fx.locationId, [
        fx.itemId,
      ]);
      expectLocked(await fx.attempt(op.counterActor()));

      await ok(await countTransition(op.counterActor(), countId, "cancel"));
      await ok(await fx.attempt(op.counterActor()));
    });
  });
}

describe("0hzu the lock covers only the hidden (location, item) pair", () => {
  it("an item the blind count does not cover still moves for the counter", async () => {
    const locationId = await insertLocation("Lock Pair");
    const hidden = await insertItem("Lock Hidden");
    const open = await insertItem("Lock Open");
    await receive(locationId, hidden, "10.0000");
    await receive(locationId, open, "10.0000");
    await createBlindCount(counter, locationId, [hidden]);

    const waste = (itemId: string, quantity: string) =>
      counter.client
        .post("/api/inventory/waste-logs")
        .set(originHeader)
        .send({
          outletId: outletA,
          locationId,
          targetType: "inventory_item",
          targetId: itemId,
          quantity,
          reason: "spoiled",
          idempotencyKey: key("lock-pair"),
        });

    await ok(await waste(open, "2.0000"));
    expect(await balanceOf(locationId, open)).toBe("8.0000");
    // The uncovered item keeps its honest stock answer.
    const short = await waste(open, "50.0000");
    expect(short.status).toBe(409);
    expect(short.body.error?.code).toBe("INSUFFICIENT_STOCK");
    expectLocked(await waste(hidden, "2.0000"));
    expect(await balanceOf(locationId, hidden)).toBe("10.0000");
  });

  it("the same item at another location is not locked", async () => {
    const countedAt = await insertLocation("Lock Counted");
    const elsewhere = await insertLocation("Lock Elsewhere");
    const itemId = await insertItem("Lock Shared Item");
    await receive(countedAt, itemId, "10.0000");
    await receive(elsewhere, itemId, "10.0000");
    await createBlindCount(counter, countedAt, [itemId]);

    await ok(
      await counter.client
        .post("/api/inventory/waste-logs")
        .set(originHeader)
        .send({
          outletId: outletA,
          locationId: elsewhere,
          targetType: "inventory_item",
          targetId: itemId,
          quantity: "2.0000",
          reason: "spoiled",
          idempotencyKey: key("lock-elsewhere"),
        }),
    );
    expect(await balanceOf(elsewhere, itemId)).toBe("8.0000");
  });

  it("an item with no stock record at all gets the same locked answer", async () => {
    const locationId = await insertLocation("Lock Empty");
    const itemId = await insertItem("Lock Never Received");
    await createBlindCount(counter, locationId, [itemId]);
    expectLocked(
      await counter.client
        .post("/api/inventory/waste-logs")
        .set(originHeader)
        .send({
          outletId: outletA,
          locationId,
          targetType: "inventory_item",
          targetId: itemId,
          quantity: "1.0000",
          reason: "spoiled",
          idempotencyKey: key("lock-empty"),
        }),
    );
  });

  it("a user who entered a line on the blind sheet becomes a counter and is locked too", async () => {
    const locationId = await insertLocation("Lock Line Counter");
    const itemId = await insertItem("Lock Line Item");
    await receive(locationId, itemId, "10.0000");
    const countId = await createBlindCount(counter, locationId, [itemId]);
    await ok(await countTransition(counter, countId, "start"));

    const waste = (actor: Actor) =>
      actor.client
        .post("/api/inventory/waste-logs")
        .set(originHeader)
        .send({
          outletId: outletA,
          locationId,
          targetType: "inventory_item",
          targetId: itemId,
          quantity: "50.0000",
          reason: "spoiled",
          idempotencyKey: key("lock-line"),
        });

    // Before counter2 touches the sheet they are an outsider: plain answer.
    const outsider = await waste(counter2);
    expect(outsider.status).toBe(409);
    expect(outsider.body.error?.code).toBe("INSUFFICIENT_STOCK");

    const sheet = await ok(
      await counter2.client.get(`${countsBase}/${countId}/sheet`),
    );
    const lineId = (
      sheet.body.data.lines as Array<{ id: string; inventoryItemId: string }>
    ).find((line) => line.inventoryItemId === itemId)!.id;
    await ok(
      await counter2.client
        .patch(`${countsBase}/${countId}/sheet/lines/${lineId}`)
        .set(originHeader)
        .send({ countedQty: "9.0000" }),
    );

    expectLocked(await waste(counter2));
  });
});
