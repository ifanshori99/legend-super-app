// Failure paths of the TL-15 (promotion) and TL-17 (price change) executors
// (WS-12 part W). The module services commit on their own, so the request's
// savepoint cannot undo them; the executors compensate. Real PostgreSQL; the
// executors are called directly with the requester's access, and failures are
// injected with vi.spyOn on the module services the executors call.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  resolveAccessSnapshot,
  loadTenantAccess,
} from "../services/permission-resolver.ts";
import * as pricing from "../services/menu-pricing.service.ts";
import * as promoOutlets from "../services/crm-promo-outlets.service.ts";
import * as promo from "../services/crm-promo.service.ts";
import { executePriceChange } from "../services/ai-action-executors/price-change.ts";
import { executePromotion } from "../services/ai-action-executors/promotion.ts";
import {
  ActionExecutionError,
  type ActionRequestRow,
} from "../services/ai-action-executors/types.ts";
import {
  asTenant,
  cleanupAcceptance,
  createMenuItem,
  grantCustomRole,
  outletA,
  outletB,
  ownerPool,
  signedIn,
  tenantId,
} from "./ai-acceptance-helpers.ts";

const tenant = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const workerContext = establishScopedTenantContext(tenant, { kind: "tenant" });

async function manager() {
  const actor = await signedIn("Pengelola Rollback");
  await grantCustomRole(
    actor.userId,
    ["menu.item.view", "menu.item.manage", "menu.price.manage", "promo.manage"],
    { type: "tenant" },
  );
  const data = await loadTenantAccess(workerContext, actor.userId);
  const access = resolveAccessSnapshot({
    tenant,
    userId: actor.userId,
    ...data,
    mfaVerified: true,
    now: new Date(),
  });
  return { actor, access };
}

type Manager = Awaited<ReturnType<typeof manager>>;

// Only these row fields are read by the executors under test.
const rowOf = (
  who: Manager,
  tool: "TL-15" | "TL-17",
  payload: unknown,
): ActionRequestRow =>
  ({
    id: randomUUID(),
    tenantId,
    requestedByUserId: who.actor.userId,
    toolCode: tool,
    payload,
  }) as unknown as ActionRequestRow;

const run = (
  who: Manager,
  executor: typeof executePromotion,
  row: ActionRequestRow,
) =>
  executor({
    tx: undefined as never,
    context: workerContext,
    access: who.access,
    row,
    now: new Date(),
  });

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await asTenant(async (db) => {
    await db.query(
      `DELETE FROM price_list_items WHERE tenant_id = $1 AND price_list_id IN
         (SELECT id FROM price_lists WHERE tenant_id = $1 AND effective_from >= '2040-01-01')`,
      [tenantId],
    );
    await db.query(
      "DELETE FROM price_lists WHERE tenant_id = $1 AND effective_from >= '2040-01-01'",
      [tenantId],
    );
  });
  await cleanupAcceptance().catch(() => undefined);
  await ownerPool.end();
});

// ---- TL-15 promotion --------------------------------------------------------

const promotionPayload = (outletIds: string[]) => ({
  name: `Promo rollback ${randomUUID().slice(0, 8)}`,
  outletIds,
  startsAt: "2040-01-01T00:00:00.000Z",
  endsAt: "2040-02-01T00:00:00.000Z",
  discount: { kind: "percent", percent: "10.0000" },
});

async function promotionStatuses(rowId: string): Promise<string[]> {
  const { rows } = await ownerPool.query(
    "SELECT status FROM promotions WHERE tenant_id = $1 AND ai_action_request_id = $2",
    [tenantId, rowId],
  );
  return rows.map((entry) => entry.status as string);
}

describe("TL-15 promotion executor: failure paths", () => {
  it("control: a clean run leaves one active promotion", async () => {
    const who = await manager();
    const row = rowOf(who, "TL-15", promotionPayload([outletA]));
    const result = await run(who, executePromotion, row);
    expect(result.resultRef).toMatch(/^promotion:/);
    expect(await promotionStatuses(row.id)).toEqual(["active"]);
  }, 60_000);

  it("an outlet switch that fails leaves no active promotion", async () => {
    const who = await manager();
    const row = rowOf(who, "TL-15", promotionPayload([outletA]));
    const spy = vi
      .spyOn(promoOutlets, "setPromotionOutlet")
      .mockRejectedValueOnce(new Error("outlet-switch boom"));
    await expect(run(who, executePromotion, row)).rejects.toThrow(
      "outlet-switch boom",
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await promotionStatuses(row.id)).toEqual(["ended"]);
  }, 60_000);

  it("a failure after the first outlet switch (partway) leaves no active promotion", async () => {
    const who = await manager();
    // Wants only outlet A: every other outlet of the tenant must be switched off.
    const row = rowOf(who, "TL-15", promotionPayload([outletA]));
    const real = promoOutlets.setPromotionOutlet;
    let calls = 0;
    const spy = vi
      .spyOn(promoOutlets, "setPromotionOutlet")
      .mockImplementation(async (...args) => {
        calls += 1;
        if (calls === 2) throw new Error("second-switch boom");
        return real(...args);
      });
    const outcome = await run(who, executePromotion, row).catch(
      (e: unknown) => e,
    );
    // The tenant needs at least three outlets for a failure to land mid-way;
    // with two, the run succeeds and the claim is not exercised.
    if (spy.mock.calls.length < 2) {
      expect(outcome).toMatchObject({ resultRef: expect.any(String) });
      return;
    }
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("second-switch boom");
    expect(await promotionStatuses(row.id)).toEqual(["ended"]);
  }, 60_000);

  it("a failed activation leaves no active promotion", async () => {
    const who = await manager();
    const row = rowOf(who, "TL-15", promotionPayload([outletA, outletB]));
    // First updatePromotion call is the activation; the compensation call
    // (status ended) goes through to the real service.
    vi.spyOn(promo, "updatePromotion").mockRejectedValueOnce(
      new Error("activation boom"),
    );
    await expect(run(who, executePromotion, row)).rejects.toThrow(
      "activation boom",
    );
    expect(await promotionStatuses(row.id)).toEqual(["ended"]);
  }, 60_000);
});

// ---- TL-17 price change -----------------------------------------------------

let dayCounter = 0;
/** A date in 2040, unique per call, later than any seeded or other-suite list. */
const nextDay = (): string => {
  // Step by 3: a run uses the day before and the day itself.
  dayCounter += 3;
  const month = String(1 + Math.floor(dayCounter / 27)).padStart(2, "0");
  const day = String(2 + (dayCounter % 27)).padStart(2, "0");
  return `2040-${month}-${day}`;
};
const dayBefore = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/** Puts `itemId` on a dine_in price list of `outletId` dated `effectiveFrom`. */
async function sellItem(
  who: Manager,
  outletId: string,
  itemId: string,
  effectiveFrom: string,
  priceIdr: number,
): Promise<string> {
  const context = who.access.contextFor("menu.price.manage", {
    type: "outlet",
    id: outletId,
  })!;
  const list = await pricing.createPriceList(context, who.actor.userId, {
    outletId,
    channel: "dine_in",
    effectiveFrom,
  });
  await pricing.setPriceListItems(context, who.actor.userId, list.id, [
    { itemId, variantId: null, priceIdr },
  ]);
  return list.id;
}

const pricePayload = (itemId: string, date: string, outletIds: string[]) => ({
  outletIds,
  changes: [{ menuItemId: itemId, newPriceIdr: 99_000 }],
  effectiveAt: `${date}T03:00:00.000Z`,
});

async function datedLists(outletId: string, date: string): Promise<string[]> {
  const { rows } = await ownerPool.query(
    `SELECT id FROM price_lists
      WHERE tenant_id = $1 AND outlet_id = $2 AND effective_from = $3 AND deleted_at IS NULL`,
    [tenantId, outletId, date],
  );
  return rows.map((entry) => entry.id as string);
}

async function livePrice(listId: string, itemId: string): Promise<number[]> {
  const { rows } = await ownerPool.query(
    `SELECT price_idr FROM price_list_items
      WHERE tenant_id = $1 AND price_list_id = $2 AND item_id = $3 AND deleted_at IS NULL`,
    [tenantId, listId, itemId],
  );
  return rows.map((entry) => Number(entry.price_idr));
}

async function twoOutletSetup() {
  const who = await manager();
  const itemId = await createMenuItem(
    await signedIn("Pemilik Menu Rollback").then(async (owner) => {
      await grantCustomRole(
        owner.userId,
        ["menu.item.view", "menu.item.manage"],
        {
          type: "tenant",
        },
      );
      return owner;
    }),
  );
  return { who, itemId, date: nextDay() };
}

describe("TL-17 price change executor: failure paths", () => {
  it("control: a clean run creates one dated list per outlet with the new price", async () => {
    const { who, itemId, date } = await twoOutletSetup();
    await sellItem(who, outletA, itemId, dayBefore(date), 25_000);
    await sellItem(who, outletB, itemId, dayBefore(date), 25_000);
    const result = await run(
      who,
      executePriceChange,
      rowOf(who, "TL-17", pricePayload(itemId, date, [outletA, outletB])),
    );
    expect(result.resultRef).toBe("price_change:2_lists");
    for (const outletId of [outletA, outletB]) {
      const lists = await datedLists(outletId, date);
      expect(lists).toHaveLength(1);
      expect(await livePrice(lists[0]!, itemId)).toEqual([99_000]);
    }
  }, 60_000);

  it("a validation failure on a later outlet means no writes at any outlet", async () => {
    const { who, itemId, date } = await twoOutletSetup();
    await sellItem(who, outletA, itemId, dayBefore(date), 25_000);
    // Outlet B does not sell the item at all.
    const create = vi.spyOn(pricing, "createPriceList");
    const setItems = vi.spyOn(pricing, "setPriceListItems");
    const remove = vi.spyOn(pricing, "deletePriceList");

    await expect(
      run(
        who,
        executePriceChange,
        rowOf(who, "TL-17", pricePayload(itemId, date, [outletA, outletB])),
      ),
    ).rejects.toBeInstanceOf(ActionExecutionError);

    expect(create).not.toHaveBeenCalled();
    expect(setItems).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await datedLists(outletA, date)).toEqual([]);
    expect(await datedLists(outletB, date)).toEqual([]);
  }, 60_000);

  it("a validation failure on the first outlet also writes nothing", async () => {
    const { who, itemId, date } = await twoOutletSetup();
    await sellItem(who, outletB, itemId, dayBefore(date), 25_000);
    const create = vi.spyOn(pricing, "createPriceList");
    await expect(
      run(
        who,
        executePriceChange,
        rowOf(who, "TL-17", pricePayload(itemId, date, [outletA, outletB])),
      ),
    ).rejects.toBeInstanceOf(ActionExecutionError);
    expect(create).not.toHaveBeenCalled();
    expect(await datedLists(outletB, date)).toEqual([]);
  }, 60_000);

  it("an error after list creation leaves no empty dated list", async () => {
    const { who, itemId, date } = await twoOutletSetup();
    await sellItem(who, outletA, itemId, dayBefore(date), 25_000);
    await sellItem(who, outletB, itemId, dayBefore(date), 25_000);
    const real = pricing.setPriceListItems;
    let calls = 0;
    vi.spyOn(pricing, "setPriceListItems").mockImplementation(
      async (...args) => {
        calls += 1;
        // Outlet A's grid is written; outlet B's list exists but its grid fails.
        if (calls === 2) throw new Error("grid boom");
        return real(...args);
      },
    );

    await expect(
      run(
        who,
        executePriceChange,
        rowOf(who, "TL-17", pricePayload(itemId, date, [outletA, outletB])),
      ),
    ).rejects.toThrow("grid boom");

    expect(await datedLists(outletA, date)).toEqual([]);
    expect(await datedLists(outletB, date)).toEqual([]);
  }, 60_000);

  it("an error on the very first grid write leaves no empty dated list", async () => {
    const { who, itemId, date } = await twoOutletSetup();
    await sellItem(who, outletA, itemId, dayBefore(date), 25_000);
    vi.spyOn(pricing, "setPriceListItems").mockRejectedValueOnce(
      new Error("first grid boom"),
    );
    await expect(
      run(
        who,
        executePriceChange,
        rowOf(who, "TL-17", pricePayload(itemId, date, [outletA])),
      ),
    ).rejects.toThrow("first grid boom");
    expect(await datedLists(outletA, date)).toEqual([]);
  }, 60_000);

  it("an error after an in-place edit restores the edited list", async () => {
    const { who, itemId, date } = await twoOutletSetup();
    // Outlet A already has a list dated the effective day: edited in place.
    const inPlace = await sellItem(who, outletA, itemId, date, 25_000);
    // Outlet B needs a new list; creating it fails.
    await sellItem(who, outletB, itemId, dayBefore(date), 25_000);
    vi.spyOn(pricing, "createPriceList").mockRejectedValueOnce(
      new Error("create boom"),
    );

    await expect(
      run(
        who,
        executePriceChange,
        rowOf(who, "TL-17", pricePayload(itemId, date, [outletA, outletB])),
      ),
    ).rejects.toThrow("create boom");

    expect(await livePrice(inPlace, itemId)).toEqual([25_000]);
    expect(await datedLists(outletA, date)).toEqual([inPlace]);
    expect(await datedLists(outletB, date)).toEqual([]);
  }, 60_000);

  it("a failed in-place write is still restored", async () => {
    const { who, itemId, date } = await twoOutletSetup();
    const inPlace = await sellItem(who, outletA, itemId, date, 25_000);
    const real = pricing.setPriceListItems;
    let calls = 0;
    vi.spyOn(pricing, "setPriceListItems").mockImplementation(
      async (...args) => {
        calls += 1;
        // Write lands (call 1), then the service reports an error anyway.
        if (calls === 1) {
          await real(...args);
          throw new Error("late boom");
        }
        return real(...args);
      },
    );
    await expect(
      run(
        who,
        executePriceChange,
        rowOf(who, "TL-17", pricePayload(itemId, date, [outletA])),
      ),
    ).rejects.toThrow("late boom");
    expect(await livePrice(inPlace, itemId)).toEqual([25_000]);
  }, 60_000);
});
