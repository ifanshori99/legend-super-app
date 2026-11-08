// Stock opname integration tests (bead legend-j5x; PRD v1.7 §3 F16 "Stok
// Opname", INV-01, INV-03, Alur J). Contract: docs/briefs/sub-stock-opname.md.
//
// Runs against the disposable PostgreSQL test database: the migration owner
// seeds fixtures and reads the ledger, the restricted legend_app login proves
// RLS, and the HTTP block drives the real Express app (createInventoryCountRouter
// mounted at /api/inventory). Actors are real signed-in users:
//   counter   warehouse @ outlet A   (inventory.opname.count + stock.view)
//   counter2  warehouse @ outlet A
//   approver  outlet_manager @ A     (inventory.adjustment.approve + inbox decide)
//   dual      warehouse + outlet_manager @ A (can count AND approve: INV-03 probes)
//   outsider  warehouse @ outlet B
//   cashier   cashier @ A            (no stock permissions)
//
// Assumptions (the brief is silent or loose):
// - A stock_adjustment policy "threshold NULL -> outlet_manager, 1 level" is
//   seeded so every count routes to an approver (NULL = every amount).
// - The inbox decision value is "approved"/"rejected" (what
//   decideApprovalRequest accepts in the existing tests), not "approve".
// - A fresh count starts in `draft`; lines exist from create, `start` makes
//   the snapshot and moves it to `counting`.
// - Cross-tenant / cross-outlet denial may be 403 or 404 (TEN-01/TEN-03).
import { roleTemplate } from "@starter/shared/access";
import { stockCountQuerySchema } from "@starter/shared/inventory";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decimal4,
  outletIdSchema,
  type OutletId,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import {
  getStockCountDetail,
  listStockCounts,
  transitionStockCount,
} from "../services/inventory-count.service.ts";
import { decideApprovalRequest } from "../services/platform-approval.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0]!.id;
const outletB = cafeLegendPlatformFixtures.outlets[1]!.id;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});
const app = createApp();
const createdUserIds: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];

const inboxTenant: TenantContext = establishTenantContext({
  tenantId: tenantA,
  brandId: null,
  source: "session",
});

function tenantContext(
  tenantId: string = tenantA,
  outletIds: readonly string[] | null = null,
): ScopedTenantContext {
  const reach = outletIds?.map((id) => outletIdSchema.parse(id) as OutletId);
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId,
      brandId: null,
      source: "domain",
    }) as TenantContext,
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

const short = () => randomUUID().slice(0, 6);
const key = (prefix: string) => `${prefix}-${randomUUID()}`;
const today = new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ seeding

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

async function insertItem(name: string, baseUomId: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
    [tenantA, `${name} ${short()}`, baseUomId],
  );
  return rows[0]!.id;
}

async function receive(
  locationId: string,
  itemId: string,
  quantity: string,
  unitCost: string,
): Promise<void> {
  await recordStockMovement(tenantContext(), {
    outletId: outletA,
    locationId,
    inventoryItemId: itemId,
    movementType: "receipt",
    quantity: decimal4(quantity),
    unitCostIdr: decimal4(unitCost),
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

/** Ledger rows a stock count wrote (INV-01). */
async function countLedger(countId: string) {
  const { rows } = await owner.query<{
    movement_type: string;
    source_type: string;
    inventory_item_id: string;
    quantity: string;
  }>(
    `SELECT movement_type, source_type, inventory_item_id, quantity::text AS quantity
     FROM stock_ledger WHERE tenant_id = $1 AND source_id = $2
     ORDER BY inventory_item_id`,
    [tenantA, countId],
  );
  return rows;
}

async function approvalRows(countId: string) {
  const { rows } = await owner.query<{
    id: string;
    chain_id: string;
    status: string;
  }>(
    `SELECT id, chain_id, status FROM approval_requests
     WHERE tenant_id = $1 AND source_module = 'inventory_count' AND object_id = $2`,
    [tenantA, countId],
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
  outletId: string,
): Promise<void> {
  // Backdated: the container clock may drift from the Node clock.
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenantA, userId, await roleIdOf(templateKey), outletId],
  );
}

// -------------------------------------------------------------------- actors

type Actor = { client: ReturnType<typeof agent>; userId: string };

async function makeActor(
  name: string,
  roles: Array<[templateKey: string, outletId: string]>,
  options: { mfa?: boolean } = {},
): Promise<Actor> {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  for (const [templateKey, outletId] of roles)
    await assignRole(userId, templateKey, outletId);
  if (options.mfa) await verifySessionMfa(email);
  return { client, userId };
}

let counter: Actor;
let counter2: Actor;
let approver: Actor;
let dual: Actor;
let outsider: Actor;
let cashier: Actor;
let gramId: string;

// ------------------------------------------------------------------ HTTP kit

const base = "/api/inventory/stock-counts";
const get = (actor: Actor, path: string) => actor.client.get(`${base}${path}`);
const post = (actor: Actor, path: string, body: unknown) =>
  actor.client
    .post(`${base}${path}`)
    .set(originHeader)
    .send(body as object);
const patch = (actor: Actor, path: string, body: unknown) =>
  actor.client
    .patch(`${base}${path}`)
    .set(originHeader)
    .send(body as object);

function expectError(response: Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(response.body.error?.code).toBe(code);
}

/** The brief fixes the code but not the 4xx status for these. */
function expectCode(response: Response, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(
    400,
  );
  expect(response.status).toBeLessThan(500);
  expect(response.body.error?.code).toBe(code);
}

/** TEN-01/TEN-03: another tenant or outlet answers 403 or 404, never data. */
function expectDenied(response: Response) {
  expect([403, 404], JSON.stringify(response.body)).toContain(response.status);
  expect(response.body.data).toBeUndefined();
}

function transition(
  actor: Actor,
  countId: string,
  action: string,
  extra: Record<string, unknown> = {},
) {
  return post(actor, `/${countId}/transitions`, {
    action,
    idempotencyKey: key(action),
    ...extra,
  });
}

async function ok(response: Response, status = 200): Promise<Response> {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return response;
}

type StockSpec = { onHand: string | null; cost?: string };

async function seedStock(specs: StockSpec[]) {
  const locationId = await insertLocation("Opname");
  const itemIds: string[] = [];
  for (const spec of specs) {
    const itemId = await insertItem("Opname", gramId);
    if (spec.onHand !== null)
      await receive(locationId, itemId, spec.onHand, spec.cost ?? "1500.0000");
    itemIds.push(itemId);
  }
  return { locationId, itemIds };
}

function createBody(
  locationId: string,
  itemIds: string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    outletId: outletA,
    locationId,
    type: "cycle",
    blind: false,
    businessDate: today,
    inventoryItemIds: itemIds,
    idempotencyKey: key("sc"),
    ...overrides,
  };
}

async function createCount(
  actor: Actor,
  locationId: string,
  itemIds: string[],
  overrides: Record<string, unknown> = {},
) {
  const response = await post(
    actor,
    "",
    createBody(locationId, itemIds, overrides),
  );
  await ok(response, 201);
  return response.body.data as {
    count: Record<string, unknown> & { id: string };
    lines: Array<Record<string, unknown>>;
  };
}

/** Counter-visible line ids by item (blind counts read the sheet). */
async function lineIdsOf(
  actor: Actor,
  countId: string,
  blind: boolean,
): Promise<Map<string, string>> {
  const response = await get(
    actor,
    blind ? `/${countId}/sheet` : `/${countId}`,
  );
  await ok(response);
  const lines = response.body.data.lines as Array<{
    id: string;
    inventoryItemId: string;
  }>;
  return new Map(lines.map((line) => [line.inventoryItemId, line.id]));
}

async function enterCounts(
  actor: Actor,
  countId: string,
  blind: boolean,
  quantities: Record<string, string>,
) {
  const lineIds = await lineIdsOf(actor, countId, blind);
  for (const [itemId, countedQty] of Object.entries(quantities)) {
    const lineId = lineIds.get(itemId);
    expect(lineId, `line for ${itemId}`).toBeDefined();
    const path = blind
      ? `/${countId}/sheet/lines/${lineId}`
      : `/${countId}/lines/${lineId}`;
    await ok(await patch(actor, path, { countedQty }));
  }
  return lineIds;
}

type Prepared = {
  countId: string;
  locationId: string;
  itemIds: string[];
  blind: boolean;
};

/** Seeds stock, creates the count as `creator` and starts it (`counting`). */
async function startedCount(
  specs: StockSpec[],
  options: { blind?: boolean; creator?: Actor } = {},
): Promise<Prepared> {
  const blind = options.blind ?? false;
  const creator = options.creator ?? counter;
  const { locationId, itemIds } = await seedStock(specs);
  const { count } = await createCount(creator, locationId, itemIds, { blind });
  const started = await ok(await transition(creator, count.id, "start"));
  expect(started.body.data.status).toBe("counting");
  return { countId: count.id, locationId, itemIds, blind };
}

/** Counts every line and submits (`pending_approval`). */
async function submittedCount(
  specs: StockSpec[],
  counted: string[],
  options: { blind?: boolean; creator?: Actor } = {},
): Promise<Prepared> {
  const prepared = await startedCount(specs, options);
  const creator = options.creator ?? counter;
  await enterCounts(
    creator,
    prepared.countId,
    prepared.blind,
    Object.fromEntries(prepared.itemIds.map((id, i) => [id, counted[i]!])),
  );
  const submitted = await ok(
    await transition(creator, prepared.countId, "submit"),
  );
  expect(submitted.body.data.status).toBe("pending_approval");
  return prepared;
}

const FORBIDDEN_FOR_COUNTER = ["systemQty", "varianceIdr", "unitCostIdr"];

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  gramId = await insertUom("g");

  // Every stock_adjustment count routes to an outlet manager (INV-03: always a
  // second person). Existing tenant policies for this action are restored after.
  savedPolicies = (
    await owner.query(
      `SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'stock_adjustment'`,
      [tenantA],
    )
  ).rows;
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'stock_adjustment'`,
    [tenantA],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'stock_adjustment', NULL, $2, 1)`,
    [tenantA, await roleIdOf("outlet_manager")],
  );

  counter = await makeActor("Opname Counter", [["warehouse", outletA]]);
  counter2 = await makeActor("Opname Counter Two", [["warehouse", outletA]]);
  approver = await makeActor("Opname Approver", [["outlet_manager", outletA]], {
    mfa: true,
  });
  dual = await makeActor(
    "Opname Dual",
    [
      ["warehouse", outletA],
      ["outlet_manager", outletA],
    ],
    { mfa: true },
  );
  outsider = await makeActor("Opname Outsider", [["warehouse", outletB]]);
  cashier = await makeActor("Opname Cashier", [["cashier", outletA]]);
});

afterAll(async () => {
  await owner.query(
    `DELETE FROM approval_requests WHERE tenant_id = $1 AND source_module = 'inventory_count'`,
    [tenantA],
  );
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'stock_adjustment'`,
    [tenantA],
  );
  for (const row of savedPolicies)
    await owner.query(
      `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.tenant_id,
        row.action_type,
        row.threshold_idr,
        row.approver_role_id,
        row.levels,
        row.requires_distinct_actor,
      ],
    );
  if (createdUserIds.length > 0)
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantA, createdUserIds],
    );
  // Ledger rows are append-only (INV-01); stock fixtures carry random names.
  await owner.end();
  await appPool.end();
});

// ============================================================================

describe("access basics (stock count API)", () => {
  it("requires a session, a trusted origin and the opname permission", async () => {
    expect((await agent(app).get(`${base}?outletId=${outletA}`)).status).toBe(
      401,
    );
    const { locationId, itemIds } = await seedStock([{ onHand: "5.0000" }]);
    const body = createBody(locationId, itemIds);
    // Mutations need the trusted Origin header (CSRF).
    expect((await counter.client.post(base).send(body)).status).toBe(403);
    // A cashier has no stock permissions at all.
    expect((await post(cashier, "", body)).status).toBe(403);
    expect((await get(cashier, `?outletId=${outletA}`)).status).toBe(403);
    // Strict Zod: unknown fields are refused.
    expect(
      (await post(counter, "", { ...body, systemQty: "1.0000" })).status,
    ).toBe(422);
  });
});

describe("F16 INV-03 count scope: full and cycle", () => {
  it("full count lists every active item incl. ones with a balance; cycle count only the listed items", async () => {
    const { locationId, itemIds } = await seedStock([
      { onHand: "10.0000" },
      { onHand: null },
      { onHand: "4.0000" },
    ]);
    const [withStock, empty, otherStock] = itemIds as [string, string, string];

    const full = await createCount(counter, locationId, [], {
      type: "full",
      inventoryItemIds: undefined,
    });
    const fullLines = new Map(
      full.lines.map((line) => [line.inventoryItemId as string, line]),
    );
    expect(fullLines.get(withStock)?.systemQty).toBe("10.0000");
    expect(fullLines.get(otherStock)?.systemQty).toBe("4.0000");
    // An active item with no balance row is part of a full count at 0.
    expect(fullLines.get(empty)?.systemQty).toBe("0.0000");
    expect(full.lines.every((line) => line.countedQty === null)).toBe(true);
    expect(full.count).toMatchObject({
      type: "full",
      status: "draft",
      locationId,
      outletId: outletA,
    });
    await ok(await transition(counter, full.count.id, "cancel"));

    const cycle = await createCount(counter, locationId, [withStock, empty], {
      type: "cycle",
    });
    expect(cycle.lines.map((line) => line.inventoryItemId).sort()).toEqual(
      [withStock, empty].sort(),
    );
    expect(cycle.lines.map((line) => line.inventoryItemId)).not.toContain(
      otherStock,
    );
  });

  it("start refreshes the snapshot: system quantity is the stock when the count began", async () => {
    const { locationId, itemIds } = await seedStock([{ onHand: "10.0000" }]);
    const item = itemIds[0]!;
    const { count, lines } = await createCount(counter, locationId, itemIds);
    expect(lines[0]?.systemQty).toBe("10.0000");
    // Goods arrive between creating the count and starting it.
    await receive(locationId, item, "5.0000", "1500.0000");
    await ok(await transition(counter, count.id, "start"));
    const detail = await ok(await get(counter, `/${count.id}`));
    expect(detail.body.data.lines[0].systemQty).toBe("15.0000");
    expect(detail.body.data.count.status).toBe("counting");
  });

  it("lists the location's counts and filters by status", async () => {
    const { locationId, itemIds } = await seedStock([{ onHand: "3.0000" }]);
    const { count } = await createCount(counter, locationId, itemIds);
    const page = await ok(
      await get(counter, `?outletId=${outletA}&locationId=${locationId}`),
    );
    expect(page.body.data.map((row: { id: string }) => row.id)).toEqual([
      count.id,
    ]);
    const posted = await ok(
      await get(
        counter,
        `?outletId=${outletA}&locationId=${locationId}&status=posted`,
      ),
    );
    expect(posted.body.data).toEqual([]);
  });
});

describe("F16 blind count (hitung buta)", () => {
  it("never shows system quantity or variance to the counter; the approver sees both", async () => {
    const { locationId, itemIds } = await seedStock([{ onHand: "10.0000" }]);
    const item = itemIds[0]!;
    const created = await createCount(counter, locationId, itemIds, {
      blind: true,
    });
    const countId = created.count.id;
    // Create response leaks nothing: no lines.
    expect(created.count.blind).toBe(true);
    expect(created.lines).toEqual([]);

    // Draft: full detail is hidden from everyone, approver included.
    expectError(
      await get(counter, `/${countId}`),
      403,
      "STOCK_COUNT_BLIND_HIDDEN",
    );
    expectError(
      await get(approver, `/${countId}`),
      403,
      "STOCK_COUNT_BLIND_HIDDEN",
    );

    await ok(await transition(counter, countId, "start"));

    // The sheet is the counter's view: lines without system data.
    const sheet = await ok(await get(counter, `/${countId}/sheet`));
    const sheetText = JSON.stringify(sheet.body);
    for (const field of FORBIDDEN_FOR_COUNTER)
      expect(sheetText, field).not.toContain(field);
    expect(sheet.body.data.lines).toHaveLength(1);
    expect(sheet.body.data.lines[0]).toMatchObject({
      inventoryItemId: item,
      countedQty: null,
    });

    // Counting: detail still hidden for everyone.
    expectError(
      await get(counter, `/${countId}`),
      403,
      "STOCK_COUNT_BLIND_HIDDEN",
    );
    expectError(
      await get(approver, `/${countId}`),
      403,
      "STOCK_COUNT_BLIND_HIDDEN",
    );

    // The plain line endpoint would echo system data, so it refuses blind counts.
    const lineId = sheet.body.data.lines[0].id as string;
    expectError(
      await patch(counter, `/${countId}/lines/${lineId}`, {
        countedQty: "8.0000",
      }),
      409,
      "STOCK_COUNT_BLIND_USE_SHEET",
    );

    // The sheet line edit answers without system data too.
    const edited = await ok(
      await patch(counter, `/${countId}/sheet/lines/${lineId}`, {
        countedQty: "8.0000",
      }),
    );
    expect(edited.body.data).toMatchObject({
      id: lineId,
      countedQty: "8.0000",
      countedBy: counter.userId,
    });
    for (const field of FORBIDDEN_FOR_COUNTER)
      expect(JSON.stringify(edited.body), field).not.toContain(field);

    await ok(await transition(counter, countId, "submit"));

    // Pending approval: the counter is still blind, a non-approver too, the
    // approver (someone else) now sees system quantity and the variance.
    expectError(
      await get(counter, `/${countId}`),
      403,
      "STOCK_COUNT_BLIND_HIDDEN",
    );
    expectError(
      await get(counter2, `/${countId}`),
      403,
      "STOCK_COUNT_BLIND_HIDDEN",
    );
    const asApprover = await ok(await get(approver, `/${countId}`));
    expect(asApprover.body.data.lines[0]).toMatchObject({
      inventoryItemId: item,
      systemQty: "10.0000",
      countedQty: "8.0000",
      varianceIdr: -3000,
    });

    // Once posted the count is no longer a secret.
    await ok(await transition(approver, countId, "approve"));
    const afterPost = await ok(await get(counter, `/${countId}`));
    expect(afterPost.body.data.count.status).toBe("posted");
    expect(afterPost.body.data.lines[0].systemQty).toBe("10.0000");
  });

  it("a non-blind count shows the full detail and accepts line edits on the plain endpoint", async () => {
    const { locationId, itemIds } = await seedStock([{ onHand: "10.0000" }]);
    const created = await createCount(counter, locationId, itemIds);
    expect(created.lines).toHaveLength(1);
    await ok(await transition(counter, created.count.id, "start"));
    const lineId = created.lines[0]!.id as string;
    const edited = await ok(
      await patch(counter, `/${created.count.id}/lines/${lineId}`, {
        countedQty: "9.0000",
      }),
    );
    expect(edited.body.data).toMatchObject({
      systemQty: "10.0000",
      countedQty: "9.0000",
    });
  });
});

describe("F16 INV-03 variance value", () => {
  it("values negative, positive and zero variance at the snapshot average cost", async () => {
    const prepared = await submittedCount(
      [
        { onHand: "10.0000", cost: "1500.0000" },
        { onHand: "10.0000", cost: "1500.0000" },
        { onHand: "4.0000", cost: "2000.0000" },
      ],
      ["8.0000", "12.0000", "4.0000"],
    );
    const [short_, over, exact] = prepared.itemIds as [string, string, string];
    const detail = await ok(await get(approver, `/${prepared.countId}`));
    const byItem = new Map(
      (
        detail.body.data.lines as Array<{
          inventoryItemId: string;
          varianceIdr: number;
        }>
      ).map((line) => [line.inventoryItemId, line.varianceIdr]),
    );
    expect(byItem.get(short_)).toBe(-3000);
    expect(byItem.get(over)).toBe(3000);
    expect(byItem.get(exact)).toBe(0);
  });

  it("variance is empty before submit", async () => {
    const prepared = await startedCount([{ onHand: "10.0000" }]);
    await enterCounts(counter, prepared.countId, false, {
      [prepared.itemIds[0]!]: "8.0000",
    });
    const detail = await ok(await get(counter, `/${prepared.countId}`));
    expect(detail.body.data.lines[0].varianceIdr).toBeNull();
  });

  it("submit needs every line counted", async () => {
    const prepared = await startedCount([
      { onHand: "10.0000" },
      { onHand: "5.0000" },
    ]);
    await enterCounts(counter, prepared.countId, false, {
      [prepared.itemIds[0]!]: "10.0000",
    });
    expectCode(
      await transition(counter, prepared.countId, "submit"),
      "STOCK_COUNT_LINES_INCOMPLETE",
    );
    expect(
      (await ok(await get(counter, `/${prepared.countId}`))).body.data.count
        .status,
    ).toBe("counting");
  });
});

describe("F16 INV-01/INV-03 approval posts the adjustment", () => {
  it("another user's approval posts adjustment/stock_count rows = counted - snapshot and updates balances", async () => {
    const prepared = await submittedCount(
      [
        { onHand: "10.0000", cost: "1500.0000" },
        { onHand: "10.0000", cost: "1500.0000" },
        { onHand: "4.0000", cost: "2000.0000" },
      ],
      ["8.0000", "12.0000", "4.0000"],
    );
    const [short_, over, exact] = prepared.itemIds as [string, string, string];

    // Pending approval writes nothing (INV-03).
    expect(await countLedger(prepared.countId)).toEqual([]);
    expect(await balanceOf(prepared.locationId, short_)).toBe("10.0000");

    const approved = await ok(
      await transition(approver, prepared.countId, "approve", {
        note: "Selisih wajar",
      }),
    );
    expect(approved.body.data).toMatchObject({
      status: "posted",
      approvedBy: approver.userId,
    });
    expect(approved.body.data.approvedAt).not.toBeNull();

    const ledger = await countLedger(prepared.countId);
    expect(ledger.every((row) => row.movement_type === "adjustment")).toBe(
      true,
    );
    expect(ledger.every((row) => row.source_type === "stock_count")).toBe(true);
    // The zero-variance line posts nothing.
    expect(ledger).toHaveLength(2);
    const byItem = new Map(
      ledger.map((row) => [row.inventory_item_id, row.quantity]),
    );
    expect(byItem.get(short_)).toBe("-2.0000");
    expect(byItem.get(over)).toBe("2.0000");
    expect(byItem.has(exact)).toBe(false);

    expect(await balanceOf(prepared.locationId, short_)).toBe("8.0000");
    expect(await balanceOf(prepared.locationId, over)).toBe("12.0000");
    expect(await balanceOf(prepared.locationId, exact)).toBe("4.0000");
  });
});

describe("F16 INV-03 the counter cannot approve", () => {
  it("the creator is refused (STOCK_COUNT_SELF_APPROVAL) and nothing is posted", async () => {
    // `dual` holds both counting and approving permissions.
    const prepared = await submittedCount([{ onHand: "10.0000" }], ["6.0000"], {
      creator: dual,
    });
    expectCode(
      await transition(dual, prepared.countId, "approve"),
      "STOCK_COUNT_SELF_APPROVAL",
    );
    expect(await countLedger(prepared.countId)).toEqual([]);
    expect(
      (await ok(await get(dual, `/${prepared.countId}`))).body.data.count
        .status,
    ).toBe("pending_approval");
  });

  it("any user who entered a line is refused too", async () => {
    const prepared = await startedCount(
      [{ onHand: "10.0000" }, { onHand: "10.0000" }],
      { creator: counter },
    );
    const [first, second] = prepared.itemIds as [string, string];
    // `dual` counts one line, the creator the other and submits.
    await enterCounts(dual, prepared.countId, false, { [first]: "9.0000" });
    await enterCounts(counter, prepared.countId, false, { [second]: "9.0000" });
    await ok(await transition(counter, prepared.countId, "submit"));

    expectCode(
      await transition(dual, prepared.countId, "approve"),
      "STOCK_COUNT_SELF_APPROVAL",
    );
    expect(await countLedger(prepared.countId)).toEqual([]);
    // A clean approver is still able to approve afterwards.
    await ok(await transition(approver, prepared.countId, "approve"));
    expect(await countLedger(prepared.countId)).toHaveLength(2);
  });

  it("someone without the approval permission cannot approve", async () => {
    const prepared = await submittedCount([{ onHand: "10.0000" }], ["9.0000"]);
    expect(
      (await transition(counter2, prepared.countId, "approve")).status,
    ).toBe(403);
    expect(
      (await transition(cashier, prepared.countId, "approve")).status,
    ).toBe(403);
    expect(await countLedger(prepared.countId)).toEqual([]);
  });
});

describe("F16 reject, recount and resubmit", () => {
  it("rejection goes back to counting with an empty ledger; resubmitting opens a new approval chain", async () => {
    const prepared = await submittedCount([{ onHand: "10.0000" }], ["5.0000"]);
    const item = prepared.itemIds[0]!;
    expect(await countLedger(prepared.countId)).toEqual([]);

    const rejected = await ok(
      await transition(approver, prepared.countId, "reject", {
        note: "Hitung ulang rak belakang",
      }),
    );
    expect(rejected.body.data.status).toBe("counting");
    expect(await countLedger(prepared.countId)).toEqual([]);
    expect(await balanceOf(prepared.locationId, item)).toBe("10.0000");

    // Variances were cleared; lines can be edited again.
    const detail = await ok(await get(counter, `/${prepared.countId}`));
    expect(detail.body.data.lines[0].varianceIdr).toBeNull();
    await enterCounts(counter, prepared.countId, false, { [item]: "9.0000" });
    await ok(await transition(counter, prepared.countId, "submit"));

    const chains = new Set(
      (await approvalRows(prepared.countId)).map((row) => row.chain_id),
    );
    expect(chains.size).toBe(2);

    await ok(await transition(approver, prepared.countId, "approve"));
    expect(await countLedger(prepared.countId)).toHaveLength(1);
    expect((await countLedger(prepared.countId))[0]?.quantity).toBe("-1.0000");
    expect(await balanceOf(prepared.locationId, item)).toBe("9.0000");
  });

  it("the counter cannot reject their own count", async () => {
    const prepared = await submittedCount([{ onHand: "10.0000" }], ["5.0000"], {
      creator: dual,
    });
    const response = await transition(dual, prepared.countId, "reject");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(
      (await ok(await get(dual, `/${prepared.countId}`))).body.data.count
        .status,
    ).toBe("pending_approval");
  });

  it("cancelling a pending count releases the location and writes nothing", async () => {
    const prepared = await submittedCount([{ onHand: "10.0000" }], ["5.0000"]);
    const cancelled = await ok(
      await transition(counter, prepared.countId, "cancel"),
    );
    expect(cancelled.body.data.status).toBe("cancelled");
    expect(await countLedger(prepared.countId)).toEqual([]);
    // A new count can now open on the same location.
    await createCount(counter, prepared.locationId, prepared.itemIds);
  });
});

describe("F16 single-use approval (no duplicate ledger rows)", () => {
  it("replaying approve or post on a posted count returns it without new rows", async () => {
    const prepared = await submittedCount([{ onHand: "10.0000" }], ["7.0000"]);
    const approveKey = key("approve");
    const first = await ok(
      await transition(approver, prepared.countId, "approve", {
        idempotencyKey: approveKey,
      }),
    );
    expect(first.body.data.status).toBe("posted");
    expect(await countLedger(prepared.countId)).toHaveLength(1);

    // Same key, a fresh key, and an explicit post: all idempotent.
    const sameKey = await ok(
      await transition(approver, prepared.countId, "approve", {
        idempotencyKey: approveKey,
      }),
    );
    expect(sameKey.body.data.status).toBe("posted");
    const newKey = await ok(
      await transition(approver, prepared.countId, "approve"),
    );
    expect(newKey.body.data.status).toBe("posted");
    const replayPost = await ok(
      await transition(approver, prepared.countId, "post"),
    );
    expect(replayPost.body.data.status).toBe("posted");

    expect(await countLedger(prepared.countId)).toHaveLength(1);
    expect(await balanceOf(prepared.locationId, prepared.itemIds[0]!)).toBe(
      "7.0000",
    );
  });

  it("two concurrent approves produce one set of ledger rows", async () => {
    const prepared = await submittedCount(
      [{ onHand: "10.0000" }, { onHand: "10.0000" }],
      ["7.0000", "13.0000"],
    );
    const responses = await Promise.all([
      transition(approver, prepared.countId, "approve"),
      transition(approver, prepared.countId, "approve"),
    ]);
    for (const response of responses) {
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(500);
    }
    expect(responses.some((response) => response.status === 200)).toBe(true);
    expect(await countLedger(prepared.countId)).toHaveLength(2);
    expect(await balanceOf(prepared.locationId, prepared.itemIds[0]!)).toBe(
      "7.0000",
    );
    expect(await balanceOf(prepared.locationId, prepared.itemIds[1]!)).toBe(
      "13.0000",
    );
  });
});

/** Decides the count's currently pending approval level in the generic inbox. */
async function inboxDecide(
  actor: Actor,
  countId: string,
  decision: "approved" | "rejected",
): Promise<void> {
  const pending = (await approvalRows(countId)).find(
    (row) => row.status === "pending",
  );
  expect(pending, "a pending approval level").toBeDefined();
  await decideApprovalRequest(
    inboxTenant,
    actor.userId,
    pending!.id,
    { decision, reason: "Keputusan dari kotak approval." },
    { mfaVerified: true, idempotencyKey: null },
  );
}

async function countRow(countId: string) {
  const { rows } = await owner.query<{
    count_version: number;
    snapshot_at: Date;
  }>(
    "SELECT count_version, snapshot_at FROM stock_counts WHERE tenant_id = $1 AND id = $2",
    [tenantA, countId],
  );
  return rows[0]!;
}

describe("F16 approval done in the generic approval inbox", () => {
  it("a decision in the inbox is honoured: post settles to posted, concurrent posts write once", async () => {
    const prepared = await submittedCount(
      [{ onHand: "10.0000" }, { onHand: "10.0000" }],
      ["6.0000", "10.0000"],
    );
    const pending = (await approvalRows(prepared.countId)).filter(
      (row) => row.status === "pending",
    );
    expect(pending).toHaveLength(1);

    await decideApprovalRequest(
      inboxTenant,
      approver.userId,
      pending[0]!.id,
      { decision: "approved", reason: "Disetujui dari kotak approval." },
      { mfaVerified: true, idempotencyKey: null },
    );
    // Deciding in the inbox does not touch the ledger by itself ...
    // (settling happens on the next transition of the count)
    const responses = await Promise.all([
      transition(approver, prepared.countId, "post"),
      transition(approver, prepared.countId, "post"),
    ]);
    for (const response of responses)
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(responses.map((response) => response.body.data.status)).toEqual([
      "posted",
      "posted",
    ]);

    const ledger = await countLedger(prepared.countId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      movement_type: "adjustment",
      source_type: "stock_count",
      inventory_item_id: prepared.itemIds[0],
      quantity: "-4.0000",
    });
    expect(await balanceOf(prepared.locationId, prepared.itemIds[0]!)).toBe(
      "6.0000",
    );
    const detail = await ok(await get(counter, `/${prepared.countId}`));
    expect(detail.body.data.count.status).toBe("posted");
  });

  it("an inbox rejection sends the count back to counting without posting", async () => {
    const prepared = await submittedCount([{ onHand: "10.0000" }], ["2.0000"]);
    await inboxDecide(approver, prepared.countId, "rejected");

    // The next transition settles the chain. Brief (Wave 2 semantics fix):
    // `post` answers 200 with the settled count, status `counting`, no ledger.
    const response = await ok(
      await transition(approver, prepared.countId, "post"),
    );
    expect(response.body.data.status).toBe("counting");
    expect(await countLedger(prepared.countId)).toEqual([]);
    expect(await balanceOf(prepared.locationId, prepared.itemIds[0]!)).toBe(
      "10.0000",
    );

    const detail = await ok(await get(counter, `/${prepared.countId}`));
    expect(detail.body.data.count.status).toBe("counting");
    // F4: the recount starts from a clean sheet.
    expect(detail.body.data.lines[0].countedQty ?? null).toBeNull();
    expect(detail.body.data.lines[0].varianceIdr ?? null).toBeNull();
  });
});

describe("F1 blind count does not leak through the approval inbox", () => {
  it("the counter's own approval rows for a blind count carry no amount or variance", async () => {
    // 10 on hand at 1.500 counted as 3 -> variance Rp10.500 (must stay hidden).
    const prepared = await submittedCount([{ onHand: "10.0000" }], ["3.0000"], {
      blind: true,
    });
    const [request] = await approvalRows(prepared.countId);
    expect(request).toBeDefined();

    const list = await ok(
      await counter.client.get(
        "/api/approvals?status=pending&actionType=stock_adjustment&limit=100",
      ),
    );
    const mine = (list.body.data as Array<Record<string, unknown>>).filter(
      (row) => row.objectId === prepared.countId,
    );
    expect(mine.length).toBeGreaterThan(0);
    const single = await ok(
      await counter.client.get(`/api/approvals/${request!.id}`),
    );
    for (const row of [...mine, single.body.data]) {
      expect(row.amountIdr ?? null).toBeNull();
      const text = JSON.stringify(row);
      expect(text).not.toMatch(/variance/i);
      expect(text).not.toMatch(/\b10500\b/);
    }

    // The approver still gets the request in the inbox and can finish it.
    const inbox = await ok(
      await approver.client.get(
        "/api/approvals?status=pending&actionType=stock_adjustment&limit=100",
      ),
    );
    expect(
      (inbox.body.data as Array<{ id: string }>).map((row) => row.id),
    ).toContain(request!.id);
    await ok(await transition(approver, prepared.countId, "approve"));
    expect(await countLedger(prepared.countId)).toHaveLength(1);
  });

  it("a non-blind count keeps the gross variance as the approval amount", async () => {
    const prepared = await submittedCount([{ onHand: "10.0000" }], ["3.0000"]);
    const list = await ok(
      await counter.client.get(
        "/api/approvals?status=pending&actionType=stock_adjustment&limit=100",
      ),
    );
    const row = (list.body.data as Array<Record<string, unknown>>).find(
      (entry) => entry.objectId === prepared.countId,
    );
    expect(row, "approval row of the count").toBeDefined();
    expect(Number(row!.amountIdr)).toBe(10500);
  });
});

describe("F1 blind count variance in the audit log is not readable by the counter", () => {
  const auditEventsOf = async (countId: string) =>
    (
      await owner.query<{ event: Record<string, unknown> }>(
        `SELECT event FROM audit_logs
          WHERE tenant_id = $1 AND event->>'objectId' = $2`,
        [tenantA, countId],
      )
    ).rows.map((row) => row.event);

  it("the audit rows hold the variance, but no API route serves audit rows to a counter", async () => {
    // 10 on hand at 1.500 counted as 3 -> variance Rp10.500.
    const prepared = await submittedCount([{ onHand: "10.0000" }], ["3.0000"], {
      blind: true,
    });
    // The audit trail does record the variance (the reason this test exists).
    const events = await auditEventsOf(prepared.countId);
    expect(JSON.stringify(events)).toMatch(/grossVarianceIdr/);

    // The counter role (warehouse) never holds the audit viewer permission…
    expect(roleTemplate("warehouse").permissions).toContain(
      "inventory.opname.count",
    );
    expect(roleTemplate("warehouse").permissions).not.toContain(
      "audit.log.view",
    );

    // …and no audit read endpoint is mounted, so nothing reaches the counter.
    for (const path of [
      "/api/audit/events",
      `/api/audit/events?objectType=stock_count&objectId=${prepared.countId}`,
    ]) {
      const response = await counter.client.get(path);
      expect([403, 404]).toContain(response.status);
      expect(JSON.stringify(response.body)).not.toMatch(/variance|10500/i);
    }
  });

  it("tripwire: the audit viewer is not mounted yet (it must redact blind-count variance before it ships)", async () => {
    // A tenant admin holds `audit.log.view`. When the F36 audit viewer
    // (`GET /api/audit/events`) is built this test fails on purpose: the viewer
    // must then hide totalVarianceIdr/grossVarianceIdr of blind stock counts
    // from readers who counted them or lack `inventory.adjustment.approve`
    // (legend-j5x), and this test must be replaced by that redaction test.
    const admin = await makeActor("Opname Audit Admin", []);
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
      [tenantA, admin.userId, await roleIdOf("tenant_admin")],
    );
    const response = await admin.client.get("/api/audit/events");
    expect(response.status).toBe(404);
  });
});

describe("F2 every approval level must be a clean approver", () => {
  /** Adds a second level to the stock_adjustment policy for the test's duration. */
  async function withTwoLevels(run: () => Promise<void>) {
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'stock_adjustment', NULL, $2, 2)`,
      [tenantA, await roleIdOf("outlet_manager")],
    );
    try {
      await run();
    } finally {
      await owner.query(
        `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'stock_adjustment' AND levels = 2`,
        [tenantA],
      );
    }
  }

  it("a counter approving level 1 in the inbox does not make the count post", async () => {
    await withTwoLevels(async () => {
      const prepared = await startedCount([{ onHand: "10.0000" }]);
      // `dual` is a counter (enters the line) and also an outlet manager.
      await enterCounts(dual, prepared.countId, false, {
        [prepared.itemIds[0]!]: "6.0000",
      });
      await ok(await transition(counter, prepared.countId, "submit"));

      await inboxDecide(dual, prepared.countId, "approved"); // level 1
      await inboxDecide(approver, prepared.countId, "approved"); // level 2
      expect(
        (await approvalRows(prepared.countId)).filter(
          (row) => row.status === "approved",
        ),
      ).toHaveLength(2);

      // Both levels are approved in the inbox, but level 1 was decided by a
      // counter: settling reverts to counting. Assumption: 200 like the other
      // settle-to-counting outcomes.
      const settled = await ok(
        await transition(approver, prepared.countId, "post"),
      );
      expect(settled.body.data.status).toBe("counting");
      expect(await countLedger(prepared.countId)).toEqual([]);
      expect(await balanceOf(prepared.locationId, prepared.itemIds[0]!)).toBe(
        "10.0000",
      );
    });
  });

  it("two clean approvers across both levels post the count", async () => {
    await withTwoLevels(async () => {
      const prepared = await submittedCount(
        [{ onHand: "10.0000" }],
        ["6.0000"],
      );
      await inboxDecide(approver, prepared.countId, "approved");
      await inboxDecide(dual, prepared.countId, "approved"); // not a counter here
      const settled = await ok(
        await transition(approver, prepared.countId, "post"),
      );
      expect(settled.body.data.status).toBe("posted");
      const ledger = await countLedger(prepared.countId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.quantity).toBe("-4.0000");
    });
  });
});

describe("F3 reject never posts", () => {
  it("rejecting a chain that is already approved is refused and changes nothing", async () => {
    const prepared = await submittedCount([{ onHand: "10.0000" }], ["6.0000"]);
    await inboxDecide(approver, prepared.countId, "approved");

    expectError(
      await transition(approver, prepared.countId, "reject"),
      409,
      "STOCK_COUNT_INVALID_TRANSITION",
    );
    expect(await countLedger(prepared.countId)).toEqual([]);
    const detail = await ok(await get(approver, `/${prepared.countId}`));
    expect(detail.body.data.count.status).toBe("pending_approval");
    expect(await balanceOf(prepared.locationId, prepared.itemIds[0]!)).toBe(
      "10.0000",
    );

    // Only approve/post settles an approved chain into posting.
    const posted = await ok(
      await transition(approver, prepared.countId, "post"),
    );
    expect(posted.body.data.status).toBe("posted");
    expect(await countLedger(prepared.countId)).toHaveLength(1);
  });
});

describe("F4 recount starts from a fresh snapshot", () => {
  it("after a rejection the snapshot is refreshed, lines are cleared and the version is bumped", async () => {
    const prepared = await submittedCount(
      [{ onHand: "10.0000" }, { onHand: "10.0000" }],
      ["4.0000", "9.0000"],
    );
    const [first, second] = prepared.itemIds as [string, string];
    const before = await countRow(prepared.countId);

    // Stock arrives after the first snapshot: 10 -> 15 for the first item.
    await receive(prepared.locationId, first, "5.0000", "1500.0000");
    await ok(
      await transition(approver, prepared.countId, "reject", {
        note: "Hitung ulang",
      }),
    );

    const after = await countRow(prepared.countId);
    expect(after.count_version).toBeGreaterThan(before.count_version);
    expect(after.snapshot_at.getTime()).toBeGreaterThan(
      before.snapshot_at.getTime(),
    );
    const detail = await ok(await get(counter, `/${prepared.countId}`));
    expect(detail.body.data.count.status).toBe("counting");
    const lines = new Map(
      (detail.body.data.lines as Array<Record<string, unknown>>).map((line) => [
        line.inventoryItemId,
        line,
      ]),
    );
    expect(lines.get(first)?.systemQty).toBe("15.0000");
    expect(lines.get(second)?.systemQty).toBe("10.0000");
    for (const line of lines.values()) {
      expect(line.countedQty ?? null).toBeNull();
      expect(line.varianceIdr ?? null).toBeNull();
      expect(line.countedBy ?? null).toBeNull();
    }

    // Recount against the new snapshot: 14 of 15 and 10 of 10 -> one row of -1.
    await enterCounts(counter, prepared.countId, false, {
      [first]: "14.0000",
      [second]: "10.0000",
    });
    await ok(await transition(counter, prepared.countId, "submit"));
    await ok(await transition(approver, prepared.countId, "approve"));
    const ledger = await countLedger(prepared.countId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      inventory_item_id: first,
      quantity: "-1.0000",
    });
    expect(await balanceOf(prepared.locationId, first)).toBe("14.0000");
  });
});

describe("F5 an expired approval can be resubmitted", () => {
  it("past the deadline the count returns to counting, the old request is closed and a resubmit works", async () => {
    const prepared = await submittedCount([{ onHand: "10.0000" }], ["6.0000"]);
    await owner.query(
      `UPDATE approval_requests SET created_at = now() - interval '2 hours', deadline_at = now() - interval '1 hour'
       WHERE tenant_id = $1 AND source_module = 'inventory_count' AND object_id = $2 AND status = 'pending'`,
      [tenantA, prepared.countId],
    );

    // Assumption: settling via `post` answers 200 with the reverted count.
    const settled = await ok(
      await transition(approver, prepared.countId, "post"),
    );
    expect(settled.body.data.status).toBe("counting");
    expect(await countLedger(prepared.countId)).toEqual([]);
    expect(
      (await approvalRows(prepared.countId)).filter(
        (row) => row.status === "pending",
      ),
    ).toEqual([]);

    const detail = await ok(await get(counter, `/${prepared.countId}`));
    expect(detail.body.data.lines[0].countedQty ?? null).toBeNull();

    await enterCounts(counter, prepared.countId, false, {
      [prepared.itemIds[0]!]: "7.0000",
    });
    const resubmitted = await ok(
      await transition(counter, prepared.countId, "submit"),
    );
    expect(resubmitted.body.data.status).toBe("pending_approval");
    await ok(await transition(approver, prepared.countId, "approve"));
    expect(await countLedger(prepared.countId)).toHaveLength(1);
    expect(await balanceOf(prepared.locationId, prepared.itemIds[0]!)).toBe(
      "7.0000",
    );
  });
});

describe("F6 counter history survives overwritten lines", () => {
  /** `dual` counts the line first, then `counter2` overwrites it. */
  async function overwrittenCount() {
    const prepared = await startedCount([{ onHand: "10.0000" }]);
    const item = prepared.itemIds[0]!;
    await enterCounts(dual, prepared.countId, false, { [item]: "9.0000" });
    await enterCounts(counter2, prepared.countId, false, { [item]: "8.0000" });
    // The last editor owns the line now (read from the table: the DTO may not
    // expose the editor).
    const { rows } = await owner.query<{ counted_by: string }>(
      "SELECT counted_by FROM stock_count_lines WHERE stock_count_id = $1",
      [prepared.countId],
    );
    expect(rows.map((row) => row.counted_by)).toEqual([counter2.userId]);
    await ok(await transition(counter, prepared.countId, "submit"));
    return prepared;
  }

  it("a user whose entry was overwritten still cannot approve (STOCK_COUNT_SELF_APPROVAL)", async () => {
    const prepared = await overwrittenCount();
    expectCode(
      await transition(dual, prepared.countId, "approve"),
      "STOCK_COUNT_SELF_APPROVAL",
    );
    expect(await countLedger(prepared.countId)).toEqual([]);
    await ok(await transition(approver, prepared.countId, "approve"));
    expect(await countLedger(prepared.countId)).toHaveLength(1);
  });

  it("an inbox approval by such a user does not post the count", async () => {
    const prepared = await overwrittenCount();
    await inboxDecide(dual, prepared.countId, "approved");
    const settled = await ok(
      await transition(approver, prepared.countId, "post"),
    );
    expect(settled.body.data.status).toBe("counting");
    expect(await countLedger(prepared.countId)).toEqual([]);
  });
});

describe("F16 approval is bound to the counted lines", () => {
  it("lines cannot be edited after submit (STOCK_COUNT_NOT_EDITABLE)", async () => {
    const prepared = await submittedCount([{ onHand: "10.0000" }], ["8.0000"]);
    const lineId = (await lineIdsOf(counter, prepared.countId, false)).get(
      prepared.itemIds[0]!,
    );
    expectError(
      await patch(counter, `/${prepared.countId}/lines/${lineId}`, {
        countedQty: "1.0000",
      }),
      409,
      "STOCK_COUNT_NOT_EDITABLE",
    );

    const blind = await submittedCount([{ onHand: "10.0000" }], ["8.0000"], {
      blind: true,
    });
    const blindLine = (await lineIdsOf(counter, blind.countId, true)).get(
      blind.itemIds[0]!,
    );
    expectError(
      await patch(counter, `/${blind.countId}/sheet/lines/${blindLine}`, {
        countedQty: "1.0000",
      }),
      409,
      "STOCK_COUNT_NOT_EDITABLE",
    );
  });

  it("lines are not editable in draft either", async () => {
    const { locationId, itemIds } = await seedStock([{ onHand: "10.0000" }]);
    const { count, lines } = await createCount(counter, locationId, itemIds);
    expectError(
      await patch(counter, `/${count.id}/lines/${lines[0]!.id}`, {
        countedQty: "1.0000",
      }),
      409,
      "STOCK_COUNT_NOT_EDITABLE",
    );
  });

  it("an approval for changed lines does not post (STOCK_COUNT_VERSION_MISMATCH)", async () => {
    const prepared = await submittedCount([{ onHand: "10.0000" }], ["8.0000"]);
    // Tamper with a counted quantity behind the API after the approval opened.
    await owner.query(
      "UPDATE stock_count_lines SET counted_qty = 1 WHERE tenant_id = $1 AND stock_count_id = $2",
      [tenantA, prepared.countId],
    );
    expectError(
      await transition(approver, prepared.countId, "approve"),
      409,
      "STOCK_COUNT_VERSION_MISMATCH",
    );
    expect(await countLedger(prepared.countId)).toEqual([]);
    expect(await balanceOf(prepared.locationId, prepared.itemIds[0]!)).toBe(
      "10.0000",
    );
  });
});

describe("F16 transactions during the count (delta method)", () => {
  it("posts counted - snapshot, so movements after the snapshot survive", async () => {
    const { locationId, itemIds } = await seedStock([{ onHand: "10.0000" }]);
    const item = itemIds[0]!;
    const { count } = await createCount(counter, locationId, itemIds);
    await ok(await transition(counter, count.id, "start")); // snapshot = 10

    // A sale of 2 posts while the count is running (no stock freeze).
    await recordStockMovement(tenantContext(), {
      outletId: outletA,
      locationId,
      inventoryItemId: item,
      movementType: "sale",
      quantity: decimal4("-2.0000"),
      sourceType: "order",
      sourceId: randomUUID(),
      actor: { type: "system" },
    });
    expect(await balanceOf(locationId, item)).toBe("8.0000");

    // The shelf held 7 at the snapshot moment.
    await enterCounts(counter, count.id, false, { [item]: "7.0000" });
    await ok(await transition(counter, count.id, "submit"));
    await ok(await transition(approver, count.id, "approve"));

    const ledger = await countLedger(count.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      movement_type: "adjustment",
      quantity: "-3.0000",
    });
    // 7 counted - 2 sold since the snapshot.
    expect(await balanceOf(locationId, item)).toBe("5.0000");
  });
});

describe("F16 one open count per location, idempotent create", () => {
  it("a second open count at the location is refused (STOCK_COUNT_LOCATION_BUSY)", async () => {
    const { locationId, itemIds } = await seedStock([{ onHand: "3.0000" }]);
    const { count } = await createCount(counter, locationId, itemIds);
    expectError(
      await post(counter, "", createBody(locationId, itemIds)),
      409,
      "STOCK_COUNT_LOCATION_BUSY",
    );
    // Cancelling frees the location.
    await ok(await transition(counter, count.id, "cancel"));
    await createCount(counter, locationId, itemIds);
  });

  it("replaying a create returns the same count; a different body under the same key is refused", async () => {
    const { locationId, itemIds } = await seedStock([{ onHand: "3.0000" }]);
    const body = createBody(locationId, itemIds);
    const first = await post(counter, "", body);
    await ok(first, 201);
    const replay = await post(counter, "", body);
    expect([200, 201], JSON.stringify(replay.body)).toContain(replay.status);
    expect(replay.body.data.count.id).toBe(first.body.data.count.id);

    expectError(
      await post(counter, "", { ...body, blind: true }),
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );
    const all = await ok(
      await get(counter, `?outletId=${outletA}&locationId=${locationId}`),
    );
    expect(all.body.data).toHaveLength(1);
  });

  it("repeating a transition whose target state is reached returns the count", async () => {
    const { locationId, itemIds } = await seedStock([{ onHand: "3.0000" }]);
    const { count } = await createCount(counter, locationId, itemIds);
    const startKey = key("start");
    await ok(
      await transition(counter, count.id, "start", {
        idempotencyKey: startKey,
      }),
    );
    const again = await ok(
      await transition(counter, count.id, "start", {
        idempotencyKey: startKey,
      }),
    );
    expect(again.body.data.status).toBe("counting");
  });

  it("an invalid transition is refused (STOCK_COUNT_INVALID_TRANSITION)", async () => {
    const { locationId, itemIds } = await seedStock([{ onHand: "3.0000" }]);
    const { count } = await createCount(counter, locationId, itemIds);
    const response = await transition(counter, count.id, "submit");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(response.body.error?.code).toBe("STOCK_COUNT_INVALID_TRANSITION");
  });
});

describe("TEN-01/TEN-03 isolation of stock counts", () => {
  it("another tenant cannot list, read or transition a count and RLS hides the rows", async () => {
    const prepared = await submittedCount([{ onHand: "10.0000" }], ["9.0000"]);
    const stranger = tenantContext(randomUUID());

    // Thunks: each service call starts only when its turn comes, so a later
    // rejection is never left unhandled while an earlier one is awaited.
    const attempts: Array<() => Promise<unknown>> = [
      () =>
        listStockCounts(
          stranger,
          approver.userId,
          stockCountQuerySchema.parse({ outletId: outletA, limit: 10 }),
        ),
      () =>
        getStockCountDetail(
          stranger,
          approver.userId,
          prepared.countId as never,
        ),
      () =>
        transitionStockCount(
          stranger,
          approver.userId,
          prepared.countId as never,
          { action: "approve", idempotencyKey: key("x") } as never,
          { mfaVerified: true },
        ),
    ];
    for (const attempt of attempts) {
      const error = (await attempt().then(
        () => null,
        (e: unknown) => e,
      )) as { status?: number } | null;
      expect([403, 404], JSON.stringify(error)).toContain(error?.status);
    }
    expect(await countLedger(prepared.countId)).toEqual([]);

    const sql = `SELECT
      (SELECT count(*) FROM stock_counts WHERE id = $1) AS counts,
      (SELECT count(*) FROM stock_count_lines WHERE stock_count_id = $1) AS lines`;
    const other = await asTenant(randomUUID(), "*", async (client) => {
      const { rows } = await client.query(sql, [prepared.countId]);
      return rows[0];
    });
    expect(other).toEqual({ counts: "0", lines: "0" });
    const same = await asTenant(tenantA, "*", async (client) => {
      const { rows } = await client.query(sql, [prepared.countId]);
      return rows[0];
    });
    expect(same).toEqual({ counts: "1", lines: "1" });
  });

  it("an outlet-scoped user without the outlet is denied and outlet RLS hides the rows", async () => {
    const prepared = await submittedCount([{ onHand: "10.0000" }], ["9.0000"]);

    expectDenied(await get(outsider, `/${prepared.countId}`));
    expectDenied(await get(outsider, `/${prepared.countId}/sheet`));
    expectDenied(await transition(outsider, prepared.countId, "cancel"));
    expect((await get(outsider, `?outletId=${outletA}`)).status).toBe(403);
    const { locationId, itemIds } = await seedStock([{ onHand: "1.0000" }]);
    expect(
      (await post(outsider, "", createBody(locationId, itemIds))).status,
    ).toBe(403);

    const sql = `SELECT
      (SELECT count(*) FROM stock_counts WHERE id = $1) AS counts,
      (SELECT count(*) FROM stock_count_lines WHERE stock_count_id = $1) AS lines`;
    const hidden = await asTenant(
      tenantA,
      JSON.stringify([outletB]),
      async (client) => (await client.query(sql, [prepared.countId])).rows[0],
    );
    expect(hidden).toEqual({ counts: "0", lines: "0" });
    const visible = await asTenant(
      tenantA,
      JSON.stringify([outletA]),
      async (client) => (await client.query(sql, [prepared.countId])).rows[0],
    );
    expect(visible).toEqual({ counts: "1", lines: "1" });
    expect(await countLedger(prepared.countId)).toEqual([]);
  });
});
