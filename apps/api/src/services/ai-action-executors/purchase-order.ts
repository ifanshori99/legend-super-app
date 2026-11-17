// TL-13 executor: create a DRAFT purchase order through `createPurchaseOrder`
// (`purchasing.order.create` at the outlet, re-checked by the service for the
// requester). The executor never submits or approves the order: a person still
// does that from the purchasing screen.
//
// A draft line carries no unit of measure, so each line takes the unit and the
// price of the supplier's current quote (`supplier_prices`, latest effective
// row on or before today). Without a quote the draft's own `unitCostIdr` is
// used with the item's base unit; with neither the request fails instead of
// guessing a price. A quote always wins over the draft's number, so a model
// can not push a price the supplier never gave.
//
// Idempotency: the purchasing idempotency key is `ai-action:<actionRequestId>`.
// A re-run after a crash between the service commit and the status commit
// returns the stored order instead of creating a second one, even when the
// date or a supplier price changed since (the key would clash on a different
// request fingerprint, and the request would wrongly end `failed`).
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { localDateOf } from "@starter/shared/core";
import { draftPurchaseOrderInputSchema } from "@starter/shared/ai";
import { createPurchaseOrderInputSchema } from "@starter/shared/inventory";
import { db } from "../../db/index.ts";
import { inventoryItems, supplierPrices } from "../../db/schema/index.ts";
import { withTenant } from "../../db/tenant.ts";
import {
  createPurchaseOrder,
  findPurchaseOrderByIdempotencyKey,
} from "../purchasing-order.service.ts";
import { holdsToolAccess } from "./access.ts";
import { ActionExecutionError, type ActionExecutor } from "./types.ts";

export const executePurchaseOrder: ActionExecutor = async ({
  access,
  row,
  now,
}) => {
  const payload = draftPurchaseOrderInputSchema.parse(row.payload);
  if (!holdsToolAccess(access, "TL-13", row.payload))
    throw new ActionExecutionError(
      "Pengaju tidak lagi punya izin membuat pesanan pembelian di outlet ini.",
    );
  const context = access.contextFor("purchasing.order.create", {
    type: "outlet",
    id: payload.outletId,
  });
  if (!context)
    throw new ActionExecutionError(
      "Pengaju tidak lagi punya izin membuat pesanan pembelian di outlet ini.",
    );
  const idempotencyKey = `ai-action:${row.id}`;
  const existing = await findPurchaseOrderByIdempotencyKey(
    context,
    row.requestedByUserId,
    idempotencyKey,
  );
  if (existing)
    return { resultRef: `purchase_order:${existing.purchaseOrder.id}` };
  const itemIds = payload.lines.map((line) => line.inventoryItemId);
  const today = localDateOf(now);
  const { quotes, items } = await withTenant(db, context, async (tx) => ({
    quotes: await tx
      .select({
        inventoryItemId: supplierPrices.inventoryItemId,
        purchaseUomId: supplierPrices.purchaseUomId,
        priceIdr: supplierPrices.priceIdr,
      })
      .from(supplierPrices)
      .where(
        and(
          eq(supplierPrices.tenantId, row.tenantId),
          eq(supplierPrices.supplierId, payload.supplierId),
          inArray(supplierPrices.inventoryItemId, itemIds),
          eq(supplierPrices.isActive, true),
          lte(supplierPrices.effectiveFrom, today),
        ),
      )
      .orderBy(
        desc(supplierPrices.effectiveFrom),
        desc(supplierPrices.createdAt),
      ),
    items: await tx
      .select({ id: inventoryItems.id, baseUomId: inventoryItems.baseUomId })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.tenantId, row.tenantId),
          inArray(inventoryItems.id, itemIds),
        ),
      ),
  }));
  // Rows arrive newest first: the first one per item is the current quote.
  const quoteOf = new Map<string, (typeof quotes)[number]>();
  for (const quote of quotes)
    if (!quoteOf.has(quote.inventoryItemId.toLowerCase()))
      quoteOf.set(quote.inventoryItemId.toLowerCase(), quote);
  const baseUomOf = new Map(
    items.map((item) => [item.id.toLowerCase(), item.baseUomId]),
  );
  const lines = payload.lines.map((line) => {
    const key = line.inventoryItemId.toLowerCase();
    const quote = quoteOf.get(key);
    if (quote)
      return {
        inventoryItemId: line.inventoryItemId,
        quantity: line.qty,
        uomId: quote.purchaseUomId,
        unitPriceIdr: quote.priceIdr,
      };
    const baseUomId = baseUomOf.get(key);
    if (!baseUomId)
      throw new ActionExecutionError("Barang pesanan tidak ditemukan.");
    if (line.unitCostIdr === undefined)
      throw new ActionExecutionError(
        "Harga barang belum diketahui: tidak ada harga supplier dan tidak ada harga di draf.",
      );
    return {
      inventoryItemId: line.inventoryItemId,
      quantity: line.qty,
      uomId: baseUomId,
      unitPriceIdr: line.unitCostIdr,
    };
  });
  const input = createPurchaseOrderInputSchema.parse({
    outletId: payload.outletId,
    supplierId: payload.supplierId,
    purchaseRequestId: null,
    expectedDate: payload.neededBy ?? today,
    source: row.source,
    lines,
    // The purchase order note holds 300 characters, a draft note 500.
    note: payload.note?.slice(0, 300) ?? null,
    idempotencyKey,
  });
  const detail = await createPurchaseOrder(
    context,
    row.requestedByUserId,
    input,
    { source: input.source },
  );
  return { resultRef: `purchase_order:${detail.purchaseOrder.id}` };
};
