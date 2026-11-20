// Inventory, recipe and HPP contracts (bead legend-p38, PRD v1.7 §16
// "Inventori & Gudang", §17 "Resep, Produksi & HPP", §6.E).
//
// Conventions follow docs/plan/contracts.md: tenant/outlet scope, money as
// BIGINT rupiah on the wire (`…Idr`, whole safe integer) and NUMERIC(14,4)
// quantities/unit costs (`Decimal4`, decimal string), ULID ids for
// time-ordered rows (stock ledger, transfers) and UUID for the rest.
//
// The contract carries the invariants the API and UI share:
// - INV-01: the stock ledger is append-only and balances are derived from it
//   (`foldStockLedger`). Corrections are `adjustment` rows whose source is an
//   approved stock count; there is no ledger update schema.
// - INV-02: a sale or production consumes every recipe line, through nested
//   recipes, with UOM conversion (`theoreticalRecipeCost`).
// - INV-03: a stock count posts only after a different person approves it
//   (`transitionStockCount` + `assertStockCountApproval`).
// - INV-04: an ingredient cost change updates the theoretical menu HPP; the
//   `recipe.cost_changed` event carries the new cost.
// - INV-05 (partial Goods Receipt posts the quantity actually received) is a
//   purchasing rule and belongs to the purchasing contract (bead legend-ejk);
//   this contract only provides the `receipt` movement it writes.

import {
  basisPointsSchema,
  brandIdSchema,
  businessDateSchema,
  decimal4Schema,
  divideRounded,
  extendCostIdr,
  formatDecimal4,
  idr,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  parseDecimal4,
  tenantIdSchema,
  ulidIdSchema,
  ulidSchema,
  userIdSchema,
  uuidIdSchema,
  uuidSchema,
  z,
} from "../core/index.ts";
import type {
  BusinessDate,
  Decimal4,
  Idr,
  IsoDateTime,
  RoundingMode,
} from "../core/index.ts";
import { InventoryError } from "./errors.ts";

// ---- Ids ------------------------------------------------------------------

export const inventoryItemIdSchema = uuidIdSchema<"InventoryItemId">();
export const inventoryItemAlternateIdSchema =
  uuidIdSchema<"InventoryItemAlternateId">();
export const uomIdSchema = uuidIdSchema<"UomId">();
export const uomConversionIdSchema = uuidIdSchema<"UomConversionId">();
export const stockLocationIdSchema = uuidIdSchema<"StockLocationId">();
export const stockLedgerIdSchema = ulidIdSchema<"StockLedgerId">();
export const stockBatchIdSchema = uuidIdSchema<"StockBatchId">();
export const parLevelIdSchema = uuidIdSchema<"ParLevelId">();
export const stockCountIdSchema = uuidIdSchema<"StockCountId">();
export const stockCountLineIdSchema = uuidIdSchema<"StockCountLineId">();
export const wasteLogIdSchema = uuidIdSchema<"WasteLogId">();
export const stockTransferIdSchema = ulidIdSchema<"StockTransferId">();
export const recipeIdSchema = uuidIdSchema<"RecipeId">();
export const recipeLineIdSchema = uuidIdSchema<"RecipeLineId">();
export const productionOrderIdSchema = uuidIdSchema<"ProductionOrderId">();

export type InventoryItemId = z.infer<typeof inventoryItemIdSchema>;
export type UomId = z.infer<typeof uomIdSchema>;
export type UomConversionId = z.infer<typeof uomConversionIdSchema>;
export type StockLocationId = z.infer<typeof stockLocationIdSchema>;
export type StockLedgerId = z.infer<typeof stockLedgerIdSchema>;
export type StockBatchId = z.infer<typeof stockBatchIdSchema>;
export type StockCountId = z.infer<typeof stockCountIdSchema>;
export type RecipeId = z.infer<typeof recipeIdSchema>;
export type ProductionOrderId = z.infer<typeof productionOrderIdSchema>;

// ---- Shared field refinements --------------------------------------------

const name = z.string().min(1).max(150);
const note = z.string().max(300).nullable();
export const positiveDecimal4Schema = decimal4Schema.refine(
  (value) => parseDecimal4(value) > 0n,
  "Quantity must be greater than zero",
);
export const nonnegativeDecimal4Schema = decimal4Schema.refine(
  (value) => parseDecimal4(value) >= 0n,
  "Quantity must not be negative",
);
export const nonnegativeIdrSchema = idrSchema.refine(
  (value) => value >= 0,
  "Amount must not be negative",
);

// ---- Units of measure and conversions (PRD §16, §6.E) ---------------------

/** Tenant-wide unit catalog: kg, g, l, ml, pcs, pack. */
export const uomSchema = z.strictObject({
  id: uomIdSchema,
  tenantId: tenantIdSchema,
  code: z.string().min(1).max(10),
  name,
  /** Standard catalog units are read-only; tenant-created units are not. */
  isSystem: z.boolean(),
});
export type Uom = z.infer<typeof uomSchema>;

/**
 * Per-item conversion. `factor` is how many `toUom` one `fromUom` contains:
 * 1 kg -> 1000 g. `convertQuantity` also walks the reverse direction, so only
 * the purchase -> base direction has to be stored (PRD §6.E `uom_conversions`).
 */
export const uomConversionSchema = z
  .strictObject({
    id: uomConversionIdSchema,
    tenantId: tenantIdSchema,
    inventoryItemId: inventoryItemIdSchema,
    fromUomId: uomIdSchema,
    toUomId: uomIdSchema,
    factor: positiveDecimal4Schema,
  })
  .refine((conversion) => conversion.fromUomId !== conversion.toUomId, {
    path: ["toUomId"],
    message: "A conversion needs two different units",
  });
export type UomConversion = z.infer<typeof uomConversionSchema>;

/** Residual stock location types named by PRD §16 "Lokasi Stok". */
export const stockLocationTypeSchema = z.enum([
  "warehouse",
  "chiller",
  "freezer",
  "bar",
  "kitchen",
  "pastry",
]);
export type StockLocationType = z.infer<typeof stockLocationTypeSchema>;

export const stockLocationSchema = z.strictObject({
  id: stockLocationIdSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  name,
  type: stockLocationTypeSchema,
  isActive: z.boolean(),
});
export type StockLocation = z.infer<typeof stockLocationSchema>;

// ---- Inventory items (PRD §16, §6.E) -------------------------------------

/** PRD §6.E: `inventory_items` holds raw materials and semi-finished goods. */
export const inventoryItemTypeSchema = z.enum([
  "raw_material",
  "semi_finished",
]);
export type InventoryItemType = z.infer<typeof inventoryItemTypeSchema>;

/**
 * A sellable ingredient or semi-finished good. Tenant-wide master data (no
 * outlet): outlet-specific par levels live in `parLevelSchema`, location stock
 * in `stockBalanceSchema`. `updatedAt` supports the optimistic update endpoint.
 */
export const inventoryItemSchema = z
  .strictObject({
    id: inventoryItemIdSchema,
    tenantId: tenantIdSchema,
    name,
    category: z.string().min(1).max(50),
    type: inventoryItemTypeSchema,
    baseUomId: uomIdSchema,
    isPerishable: z.boolean(),
    isActive: z.boolean(),
    /** Item-level par defaults; a per-location par level overrides them. */
    parMin: nonnegativeDecimal4Schema.nullable(),
    parMax: nonnegativeDecimal4Schema.nullable(),
    updatedAt: isoDateTimeSchema,
  })
  .refine(
    (item) =>
      item.parMin === null ||
      item.parMax === null ||
      parseDecimal4(item.parMax) >= parseDecimal4(item.parMin),
    { path: ["parMax"], message: "parMax must be at least parMin" },
  );
export type InventoryItem = z.infer<typeof inventoryItemSchema>;

/** Substitute ingredient ("bahan alternatif", PRD §16). Lower priority wins. */
export const inventoryItemAlternateSchema = z
  .strictObject({
    id: inventoryItemAlternateIdSchema,
    tenantId: tenantIdSchema,
    inventoryItemId: inventoryItemIdSchema,
    alternateItemId: inventoryItemIdSchema,
    priority: z.number().int().nonnegative(),
  })
  .refine(
    (alternate) => alternate.inventoryItemId !== alternate.alternateItemId,
    {
      path: ["alternateItemId"],
      message: "An item cannot alternate with itself",
    },
  );
export type InventoryItemAlternate = z.infer<
  typeof inventoryItemAlternateSchema
>;

// ---- Par levels (PRD §16 "Par Level & Saran Pembelian") -------------------

export const parLevelSchema = z
  .strictObject({
    id: parLevelIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    locationId: stockLocationIdSchema,
    inventoryItemId: inventoryItemIdSchema,
    parMin: nonnegativeDecimal4Schema,
    parMax: nonnegativeDecimal4Schema,
  })
  .refine((par) => parseDecimal4(par.parMax) >= parseDecimal4(par.parMin), {
    path: ["parMax"],
    message: "parMax must be at least parMin",
  });
export type ParLevel = z.infer<typeof parLevelSchema>;

export const parStatusSchema = z.enum(["below_min", "within", "above_max"]);
export type ParStatus = z.infer<typeof parStatusSchema>;

/**
 * PRD §16 defines par levels per location; PRD §6.E also lists item defaults.
 * A location override wins, else the item defaults apply. Null means neither
 * is configured, so no alert is raised.
 */
export function effectiveParLevel(
  item: Pick<InventoryItem, "parMin" | "parMax">,
  override?: Pick<ParLevel, "parMin" | "parMax"> | null,
): { parMin: Decimal4; parMax: Decimal4 } | null {
  if (override) return { parMin: override.parMin, parMax: override.parMax };
  if (item.parMin !== null && item.parMax !== null)
    return { parMin: item.parMin, parMax: item.parMax };
  return null;
}

/** Compares a derived balance with its effective par level. */
export function parStatus(
  quantity: Decimal4,
  par: Pick<ParLevel, "parMin" | "parMax">,
): ParStatus {
  const value = parseDecimal4(quantity);
  if (value < parseDecimal4(par.parMin)) return "below_min";
  if (value > parseDecimal4(par.parMax)) return "above_max";
  return "within";
}

// ---- Stock ledger (PRD §16 "Kartu Stok Append-only", §6.E) ---------------

export const STOCK_MOVEMENT_TYPES = [
  "receipt",
  "sale",
  "production_in",
  "production_out",
  "transfer_in",
  "transfer_out",
  "waste",
  "adjustment",
  "duty_meal",
  "return",
] as const;
export const stockMovementTypeSchema = z.enum(STOCK_MOVEMENT_TYPES);
export type StockMovementType = z.infer<typeof stockMovementTypeSchema>;

/**
 * The document a movement row came from (PRD §6.E `source_type`). The ledger
 * keeps these pairs to make the source traceable; a correction must point at
 * an approved stock count (INV-01).
 */
export const stockSourceTypeSchema = z.enum([
  "goods_receipt",
  "order",
  "production_order",
  "stock_transfer",
  "stock_count",
  "waste_log",
  "purchase_return",
  "duty_meal",
]);
export type StockSourceType = z.infer<typeof stockSourceTypeSchema>;

export const stockMovementDirectionSchema = z.enum(["in", "out", "either"]);
export type StockMovementDirection = z.infer<
  typeof stockMovementDirectionSchema
>;

/**
 * PRD §6.E: `quantity` is positive for stock in and negative for stock out.
 * `adjustment` and `return` carry direction in the sign: an adjustment may be
 * positive or negative (approved count correction), and a purchase return is
 * stock out while a restocked sales return is stock in, so `sourceType` names
 * the document.
 */
export const STOCK_MOVEMENT_DIRECTION: Record<
  StockMovementType,
  StockMovementDirection
> = {
  receipt: "in",
  sale: "out",
  production_in: "in",
  production_out: "out",
  transfer_in: "in",
  transfer_out: "out",
  waste: "out",
  adjustment: "either",
  duty_meal: "out",
  return: "either",
};

/** Which source documents may produce each movement type. */
export const STOCK_MOVEMENT_SOURCES: Record<
  StockMovementType,
  readonly StockSourceType[]
> = {
  receipt: ["goods_receipt"],
  sale: ["order"],
  production_in: ["production_order"],
  production_out: ["production_order"],
  transfer_in: ["stock_transfer"],
  transfer_out: ["stock_transfer"],
  waste: ["waste_log"],
  adjustment: ["stock_count"],
  duty_meal: ["duty_meal"],
  return: ["purchase_return", "order"],
};

/**
 * One append-only stock-card row. There is deliberately no update schema:
 * correcting a posted movement means a new approved `adjustment` row (INV-01).
 * `sourceId` is a UUID or a ULID because orders are ULIDs while most documents
 * are UUIDs; the API converts at the database boundary (D-CORE-1).
 */
export const stockLedgerEntrySchema = z
  .strictObject({
    id: stockLedgerIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    locationId: stockLocationIdSchema,
    inventoryItemId: inventoryItemIdSchema,
    movementType: stockMovementTypeSchema,
    quantity: decimal4Schema,
    unitCostIdr: nonnegativeDecimal4Schema,
    batchId: stockBatchIdSchema.nullable(),
    sourceType: stockSourceTypeSchema,
    sourceId: z.union([uuidSchema, ulidSchema]),
    occurredAt: isoDateTimeSchema,
  })
  .superRefine((entry, context) => {
    const quantity = parseDecimal4(entry.quantity);
    if (quantity === 0n)
      context.addIssue({
        code: "custom",
        path: ["quantity"],
        message: "A ledger row needs a non-zero quantity",
      });
    const direction = STOCK_MOVEMENT_DIRECTION[entry.movementType];
    if (direction === "in" && quantity < 0n)
      context.addIssue({
        code: "custom",
        path: ["quantity"],
        message: `${entry.movementType} must be positive (stock in)`,
      });
    if (direction === "out" && quantity > 0n)
      context.addIssue({
        code: "custom",
        path: ["quantity"],
        message: `${entry.movementType} must be negative (stock out)`,
      });
    // `return` takes its direction from the document: a purchase return sends
    // stock back to the supplier (out), a restocked sales return comes in.
    if (
      entry.movementType === "return" &&
      entry.sourceType === "purchase_return" &&
      quantity > 0n
    )
      context.addIssue({
        code: "custom",
        path: ["quantity"],
        message: "A purchase return must be negative (stock out)",
      });
    if (
      entry.movementType === "return" &&
      entry.sourceType === "order" &&
      quantity < 0n
    )
      context.addIssue({
        code: "custom",
        path: ["quantity"],
        message: "A sales return must be positive (stock in)",
      });
    if (!STOCK_MOVEMENT_SOURCES[entry.movementType].includes(entry.sourceType))
      context.addIssue({
        code: "custom",
        path: ["sourceType"],
        message: `${entry.movementType} must come from ${STOCK_MOVEMENT_SOURCES[
          entry.movementType
        ].join(" or ")}`,
      });
  });
export type StockLedgerEntry = z.infer<typeof stockLedgerEntrySchema>;

// ---- Stock balances and moving-average cost (PRD §16 "Metode Biaya") -----

/**
 * Balance derived from the ledger (PRD §6.E `stock_balances`). Never written
 * directly: `foldStockLedger` rebuilds it. `avgCostIdr` is per base unit at
 * NUMERIC(14,4) precision, moving average per location.
 */
export const stockBalanceSchema = z.strictObject({
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  locationId: stockLocationIdSchema,
  inventoryItemId: inventoryItemIdSchema,
  quantity: decimal4Schema,
  avgCostIdr: nonnegativeDecimal4Schema,
  updatedAt: isoDateTimeSchema,
});
export type StockBalance = z.infer<typeof stockBalanceSchema>;

/** Stable key for one location/item balance. */
export function stockBalanceKey(
  locationId: string,
  inventoryItemId: string,
): string {
  return `${locationId}:${inventoryItemId}`;
}

/**
 * Applies one movement to a balance with the moving-average method (PRD §16
 * default). An inflow re-weights the average from the quantity already on hand;
 * an outflow leaves the average unchanged.
 */
export function applyStockMovement(
  balance: Pick<StockBalance, "quantity" | "avgCostIdr">,
  movement: Pick<StockLedgerEntry, "quantity" | "unitCostIdr">,
  mode: RoundingMode,
): { quantity: Decimal4; avgCostIdr: Decimal4 } {
  const currentQuantity = parseDecimal4(balance.quantity);
  const delta = parseDecimal4(movement.quantity);
  const nextQuantity = currentQuantity + delta;
  if (delta <= 0n)
    return {
      quantity: formatDecimal4(nextQuantity),
      avgCostIdr: balance.avgCostIdr,
    };
  // A zero-cost inflow (supplier bonus) onto a negative balance keeps the old
  // average while the balance stays at or below zero: resetting it to 0 would
  // reprice the whole deficit and credit HPP for units the bonus never covered
  // (legend-tomda). Once it crosses zero the units left on hand are free.
  if (currentQuantity < 0n && parseDecimal4(movement.unitCostIdr) === 0n)
    return {
      quantity: formatDecimal4(nextQuantity),
      avgCostIdr: nextQuantity > 0n ? formatDecimal4(0n) : balance.avgCostIdr,
    };
  // Nothing (or less than nothing, after real-time sale deduction ran ahead of
  // a receipt) is on hand: the old average values no stock, so the inflow's
  // cost becomes the average. Weighting a negative quantity would distort the
  // average and can even turn it negative (review legend-p38).
  if (currentQuantity <= 0n)
    return {
      quantity: formatDecimal4(nextQuantity),
      avgCostIdr: movement.unitCostIdr,
    };
  const value =
    currentQuantity * parseDecimal4(balance.avgCostIdr) +
    delta * parseDecimal4(movement.unitCostIdr);
  return {
    quantity: formatDecimal4(nextQuantity),
    avgCostIdr: formatDecimal4(divideRounded(value, nextQuantity, mode)),
  };
}

export type DerivedStockBalance = {
  tenantId: StockBalance["tenantId"];
  outletId: StockBalance["outletId"];
  locationId: StockLocationId;
  inventoryItemId: InventoryItemId;
  quantity: Decimal4;
  avgCostIdr: Decimal4;
  updatedAt: IsoDateTime;
};

/**
 * A ledger row with its insertion sequence (`stock_ledger.posting_seq`,
 * legend-bsw9): the order the database accepted the posting, which for one
 * (location, item) is the order the live moving average was applied.
 */
export type PostedStockLedgerEntry = StockLedgerEntry & {
  postingSeq: number;
};

/**
 * INV-01 / PRD §16 "saldo diturunkan dari ledger": folds every row into one
 * balance per location/item.
 *
 * - `"posting"` (the API rebuild, legend-bsw9): by insertion sequence, the same
 *   order live posting applied the moving average in, so a rebuild equals the
 *   live balance even when a caller posted a past `occurredAt` (EOD sale
 *   deduction, stock opname, import).
 * - `"occurred_at"` (default; mock data without a sequence): by `occurredAt`
 *   then ULID id (deterministic for rows in the same millisecond).
 *
 * The API may use this for rebuilds and tests; the database keeps the
 * materialized `stock_balances` for reads.
 */
export function foldStockLedger(
  entries: readonly PostedStockLedgerEntry[],
  mode: RoundingMode,
  order: "posting",
): DerivedStockBalance[];
export function foldStockLedger(
  entries: readonly StockLedgerEntry[],
  mode: RoundingMode,
  order?: "occurred_at",
): DerivedStockBalance[];
export function foldStockLedger(
  entries: readonly (StockLedgerEntry & { postingSeq?: number })[],
  mode: RoundingMode,
  order: "posting" | "occurred_at" = "occurred_at",
): DerivedStockBalance[] {
  const ordered = [...entries].sort((left, right) => {
    if (order === "posting") {
      if (left.postingSeq === undefined || right.postingSeq === undefined)
        throw new Error("foldStockLedger: posting order needs postingSeq");
      return left.postingSeq - right.postingSeq;
    }
    const leftTime = Date.parse(left.occurredAt);
    const rightTime = Date.parse(right.occurredAt);
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const balances = new Map<string, DerivedStockBalance>();
  for (const entry of ordered) {
    const key = stockBalanceKey(entry.locationId, entry.inventoryItemId);
    const current = balances.get(key) ?? {
      tenantId: entry.tenantId,
      outletId: entry.outletId,
      locationId: entry.locationId,
      inventoryItemId: entry.inventoryItemId,
      quantity: formatDecimal4(0n),
      avgCostIdr: formatDecimal4(0n),
      updatedAt: entry.occurredAt,
    };
    const next = applyStockMovement(current, entry, mode);
    balances.set(key, { ...current, ...next, updatedAt: entry.occurredAt });
  }
  return [...balances.values()];
}

/** Stock value in whole rupiah (quantity x moving-average unit cost). */
export function stockBalanceValueIdr(
  balance: Pick<StockBalance, "quantity" | "avgCostIdr">,
  mode: RoundingMode,
): Idr {
  return extendCostIdr(balance.quantity, balance.avgCostIdr, mode);
}

// ---- Unit conversion ------------------------------------------------------

/**
 * Converts a quantity between two units of one item, walking the stored
 * conversion graph in both directions (BFS, exact rational factors, one
 * rounding at the end). Throws `UOM_CONVERSION_MISSING` when no path exists.
 */
export function convertQuantity(
  quantity: Decimal4,
  fromUomId: string,
  toUomId: string,
  conversions: readonly UomConversion[],
  mode: RoundingMode = "half_up",
): Decimal4 {
  if (fromUomId === toUomId) return quantity;
  // Each edge multiplies by `numerator / denominator` (both NUMERIC(14,4)
  // scaled); the reverse edge swaps them, so 1 / factor is never rounded and
  // the whole chain rounds once (6000 ml in a 12000 ml carton is 0.5000, not
  // 6000 x 0.0001 = 0.6000).
  type Edge = { to: string; numerator: bigint; denominator: bigint };
  const graph = new Map<string, Edge[]>();
  const addEdge = (from: string, edge: Edge): void => {
    const edges = graph.get(from) ?? [];
    edges.push(edge);
    graph.set(from, edges);
  };
  for (const conversion of conversions) {
    const factor = parseDecimal4(conversion.factor);
    addEdge(conversion.fromUomId, {
      to: conversion.toUomId,
      numerator: factor,
      denominator: 10_000n,
    });
    addEdge(conversion.toUomId, {
      to: conversion.fromUomId,
      numerator: 10_000n,
      denominator: factor,
    });
  }
  const visited = new Set([fromUomId]);
  const queue: { uomId: string; numerator: bigint; denominator: bigint }[] = [
    { uomId: fromUomId, numerator: 1n, denominator: 1n },
  ];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.uomId === toUomId)
      return formatDecimal4(
        divideRounded(
          parseDecimal4(quantity) * current.numerator,
          current.denominator,
          mode,
        ),
      );
    for (const edge of graph.get(current.uomId) ?? []) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      queue.push({
        uomId: edge.to,
        numerator: current.numerator * edge.numerator,
        denominator: current.denominator * edge.denominator,
      });
    }
  }
  throw new InventoryError(
    "UOM_CONVERSION_MISSING",
    `No conversion path from ${fromUomId} to ${toUomId}`,
  );
}

// ---- Batches and expiry (PRD §16 "Batch & Kedaluwarsa", §6.E) -----------

export const stockBatchSchema = z.strictObject({
  id: stockBatchIdSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  locationId: stockLocationIdSchema,
  inventoryItemId: inventoryItemIdSchema,
  batchCode: z.string().min(1).max(40),
  /** Non-perishable batches may carry no expiry date. */
  expiresOn: businessDateSchema.nullable(),
  receivedAt: isoDateTimeSchema,
});
export type StockBatch = z.infer<typeof stockBatchSchema>;

export const stockBatchExpiryStatusSchema = z.enum([
  "no_expiry",
  "expired",
  "expiring_soon",
  "fresh",
]);
export type StockBatchExpiryStatus = z.infer<
  typeof stockBatchExpiryStatusSchema
>;

function daysBetween(from: BusinessDate, to: BusinessDate): number {
  const parse = (value: string): number => {
    const [year, month, day] = value.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/**
 * Expiry warning window (`warnDays`) is tenant configuration, not a constant:
 * the caller passes it. Expiring today counts as `expiring_soon`.
 */
export function batchExpiryStatus(
  batch: Pick<StockBatch, "expiresOn">,
  asOf: BusinessDate,
  warnDays: number,
): StockBatchExpiryStatus {
  if (!Number.isInteger(warnDays) || warnDays < 0)
    throw new RangeError(
      `warnDays must be a non-negative integer: ${warnDays}`,
    );
  if (batch.expiresOn === null) return "no_expiry";
  const days = daysBetween(asOf, batch.expiresOn);
  if (days < 0) return "expired";
  if (days <= warnDays) return "expiring_soon";
  return "fresh";
}

/**
 * FEFO order (PRD §16 "saran FEFO"): earliest expiry first, batches without
 * expiry last, then earliest received, then id. Returns a new array.
 */
export function fefoSort(batches: readonly StockBatch[]): StockBatch[] {
  return [...batches].sort((left, right) => {
    const leftExpiry = left.expiresOn ?? "9999-12-31";
    const rightExpiry = right.expiresOn ?? "9999-12-31";
    if (leftExpiry !== rightExpiry) return leftExpiry < rightExpiry ? -1 : 1;
    if (left.receivedAt !== right.receivedAt)
      return Date.parse(left.receivedAt) - Date.parse(right.receivedAt);
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

// ---- Stock counts (PRD §16 "Stok Opname", INV-03) ------------------------

export const stockCountTypeSchema = z.enum(["full", "cycle"]);
export type StockCountType = z.infer<typeof stockCountTypeSchema>;

export const stockCountStatusSchema = z.enum([
  "draft",
  "counting",
  "pending_approval",
  "approved",
  "posted",
  "cancelled",
]);
export type StockCountStatus = z.infer<typeof stockCountStatusSchema>;

export const stockCountActionSchema = z.enum([
  "start",
  "submit",
  "approve",
  "reject",
  "post",
  "cancel",
]);
export type StockCountAction = z.infer<typeof stockCountActionSchema>;

/**
 * A count session. `blind` hides `systemQty` from the counter; the API
 * enforces it (counters use the sheet endpoints, which never carry system
 * quantity, cost or variance; full detail of a blind count is approver-only
 * and only once submitted). The approver sees the variance. A posted count has
 * written its `adjustment` ledger rows (INV-01, INV-03).
 */
/** Minimal operational attribution; resolved only for an authorized outlet document. */
export const inventoryStaffSchema = z.strictObject({
  userId: userIdSchema,
  displayName: z.string().min(1),
  /** Current role label; this is not an immutable historical role snapshot. */
  role: z.string().min(1),
});
export type InventoryStaff = z.infer<typeof inventoryStaffSchema>;

export const stockCountSchema = z
  .strictObject({
    id: stockCountIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    locationId: stockLocationIdSchema,
    type: stockCountTypeSchema,
    status: stockCountStatusSchema,
    blind: z.boolean(),
    businessDate: businessDateSchema,
    countedBy: userIdSchema,
    approvedBy: userIdSchema.nullable(),
    countedByStaff: inventoryStaffSchema.nullable().optional(),
    approvedByStaff: inventoryStaffSchema.nullable().optional(),
    countedAt: isoDateTimeSchema.nullable(),
    approvedAt: isoDateTimeSchema.nullable(),
    note,
  })
  .superRefine((count, context) => {
    const submitted = ["pending_approval", "approved", "posted"].includes(
      count.status,
    );
    const approved = ["approved", "posted"].includes(count.status);
    if (submitted && count.countedAt === null)
      context.addIssue({
        code: "custom",
        path: ["countedAt"],
        message: "A submitted count needs a completion time",
      });
    if (approved && (count.approvedBy === null || count.approvedAt === null))
      context.addIssue({
        code: "custom",
        path: ["approvedBy"],
        message: "An approved count needs an approver and time",
      });
    if (!approved && count.approvedBy !== null)
      context.addIssue({
        code: "custom",
        path: ["approvedBy"],
        message: "Only an approved count has an approver",
      });
  });
export type StockCount = z.infer<typeof stockCountSchema>;

/**
 * One counted line. `systemQty` is the snapshot taken when the count was
 * created; `varianceIdr` is the approved valuation of counted minus system.
 */
export const stockCountLineSchema = z.strictObject({
  id: stockCountLineIdSchema,
  tenantId: tenantIdSchema,
  stockCountId: stockCountIdSchema,
  inventoryItemId: inventoryItemIdSchema,
  systemQty: decimal4Schema,
  countedQty: decimal4Schema.nullable(),
  varianceIdr: idrSchema.nullable(),
});
export type StockCountLine = z.infer<typeof stockCountLineSchema>;

export const stockCountDetailSchema = z.strictObject({
  count: stockCountSchema,
  lines: z.array(stockCountLineSchema),
});
export type StockCountDetail = z.infer<typeof stockCountDetailSchema>;

/**
 * Counter-facing line (blind count): no system quantity, unit cost or
 * variance, so nothing about expected stock can reach the counter.
 */
export const stockCountSheetLineSchema = z.strictObject({
  id: stockCountLineIdSchema,
  tenantId: tenantIdSchema,
  stockCountId: stockCountIdSchema,
  inventoryItemId: inventoryItemIdSchema,
  countedQty: decimal4Schema.nullable(),
  countedBy: userIdSchema.nullable(),
  countedByStaff: inventoryStaffSchema.nullable().optional(),
  countedAt: isoDateTimeSchema.nullable(),
});
export type StockCountSheetLine = z.infer<typeof stockCountSheetLineSchema>;

export const stockCountSheetSchema = z.strictObject({
  count: stockCountSchema,
  lines: z.array(stockCountSheetLineSchema),
});
export type StockCountSheet = z.infer<typeof stockCountSheetSchema>;

const STOCK_COUNT_TRANSITIONS: Record<
  StockCountStatus,
  Partial<Record<StockCountAction, StockCountStatus>>
> = {
  draft: { start: "counting", cancel: "cancelled" },
  counting: { submit: "pending_approval", cancel: "cancelled" },
  pending_approval: {
    approve: "approved",
    reject: "counting",
    cancel: "cancelled",
  },
  approved: { post: "posted" },
  posted: {},
  cancelled: {},
};

/**
 * Explicit stock-count state machine. Approval is guarded separately because
 * it also needs the acting user: `assertStockCountApproval` enforces INV-03
 * (different counter and approver) before calling this with `approve`.
 */
export function transitionStockCount(
  from: StockCountStatus,
  action: StockCountAction,
): StockCountStatus {
  const next = STOCK_COUNT_TRANSITIONS[from][action];
  if (!next)
    throw new InventoryError(
      "STOCK_COUNT_INVALID_TRANSITION",
      `Cannot ${action} a stock count in ${from}`,
    );
  return next;
}

/** PRD INV-03 gate: only a submitted count, approved by a different person. */
export function assertStockCountApproval(
  count: Pick<StockCount, "status" | "countedBy">,
  approverId: string,
): void {
  if (count.status !== "pending_approval")
    throw new InventoryError(
      "STOCK_COUNT_NOT_PENDING_APPROVAL",
      `Stock count is ${count.status}, not pending_approval`,
    );
  if (count.countedBy.toLowerCase() === approverId.toLowerCase())
    throw new InventoryError(
      "STOCK_COUNT_SELF_APPROVAL",
      "The counter cannot approve their own stock count",
    );
}

/** Variance value in whole rupiah for the approver's report. */
export function stockCountVarianceIdr(
  input: {
    systemQty: Decimal4;
    countedQty: Decimal4;
    unitCostIdr: Decimal4;
  },
  mode: RoundingMode,
): Idr {
  const variance =
    parseDecimal4(input.countedQty) - parseDecimal4(input.systemQty);
  return extendCostIdr(formatDecimal4(variance), input.unitCostIdr, mode);
}

// ---- Waste and spoilage (PRD §16 "Waste & Spoilage", §6.E) ---------------

/**
 * Proposed standard reason list ("alasan baku"); PRD names the requirement but
 * not the codes, so the owner can extend this enum before the module ships.
 */
export const wasteReasonSchema = z.enum([
  "expired",
  "spoiled",
  "dropped",
  "prep_error",
  "overproduction",
  "quality_reject",
  "other",
]);
export type WasteReason = z.infer<typeof wasteReasonSchema>;

export const wasteTargetTypeSchema = z.enum(["inventory_item", "menu_item"]);
export type WasteTargetType = z.infer<typeof wasteTargetTypeSchema>;

export const wasteLogSchema = z.strictObject({
  id: wasteLogIdSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  locationId: stockLocationIdSchema,
  /** PRD §6.E `item_or_menu_id`: an ingredient or a finished menu portion. */
  targetType: wasteTargetTypeSchema,
  targetId: uuidSchema,
  quantity: positiveDecimal4Schema,
  reason: wasteReasonSchema,
  /** Optional private receipt image uploaded with source kind `waste_log` (10 MiB). */
  mediaId: uuidSchema.nullable(),
  valueIdr: nonnegativeIdrSchema,
  loggedBy: userIdSchema,
  loggedByStaff: inventoryStaffSchema.nullable().optional(),
  occurredAt: isoDateTimeSchema,
  note,
});
export type WasteLog = z.infer<typeof wasteLogSchema>;

// ---- Internal transfers (PRD §16 "transfer antarlokasi") -----------------

export const stockTransferLineSchema = z.strictObject({
  inventoryItemId: inventoryItemIdSchema,
  quantity: positiveDecimal4Schema,
});
export type StockTransferLine = z.infer<typeof stockTransferLineSchema>;

/**
 * Source document for a paired `transfer_out` + `transfer_in` ledger entry.
 * PRD §6.E only defines the movement types, so the document is kept minimal:
 * both rows carry this id in `sourceId`.
 */
export const stockTransferSchema = z
  .strictObject({
    id: stockTransferIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    fromLocationId: stockLocationIdSchema,
    toLocationId: stockLocationIdSchema,
    lines: z.array(stockTransferLineSchema).min(1),
    movedBy: userIdSchema,
    occurredAt: isoDateTimeSchema,
    note,
  })
  .superRefine((transfer, context) => {
    if (transfer.fromLocationId === transfer.toLocationId)
      context.addIssue({
        code: "custom",
        path: ["toLocationId"],
        message: "A transfer needs two different locations",
      });
    const seen = new Set<string>();
    transfer.lines.forEach((line, index) => {
      if (seen.has(line.inventoryItemId))
        context.addIssue({
          code: "custom",
          path: ["lines", index, "inventoryItemId"],
          message: "An item appears once per transfer",
        });
      seen.add(line.inventoryItemId);
    });
  });
export type StockTransfer = z.infer<typeof stockTransferSchema>;

// ---- Recipes / BOM (PRD §17 "Resep Bertingkat", §6.E) --------------------

export const recipeComponentTypeSchema = z.enum(["item", "recipe"]);
export type RecipeComponentType = z.infer<typeof recipeComponentTypeSchema>;

/**
 * Prep loss in basis points. The loss is a yield loss, so a 100% loss has no
 * finite gross quantity (owner decision Q19, 2026-11-01).
 */
export const recipeWastePctSchema = basisPointsSchema.refine(
  (value) => value < 10_000,
  "Waste must be below 100%",
);

/**
 * A versioned recipe. `outputItemId` is set when the recipe produces a
 * semi-finished inventory item (nested BOM); a menu recipe has none.
 * `theoreticalCostIdr` is the current HPP per one `yieldUom` (NUMERIC(14,4),
 * PRD §6.E), refreshed by INV-04.
 */
export const recipeSchema = z.strictObject({
  id: recipeIdSchema,
  tenantId: tenantIdSchema,
  brandId: brandIdSchema,
  name,
  outputItemId: inventoryItemIdSchema.nullable(),
  yieldQuantity: positiveDecimal4Schema,
  yieldUomId: uomIdSchema,
  version: z.number().int().positive(),
  isActive: z.boolean(),
  theoreticalCostIdr: nonnegativeDecimal4Schema,
  updatedBy: userIdSchema,
  updatedAt: isoDateTimeSchema,
});
export type Recipe = z.infer<typeof recipeSchema>;

/**
 * One BOM line. `wastePctBp` is the prep loss allowance in basis points
 * (200 = 2%), applied as a yield loss when costing: gross quantity is
 * net ÷ (1 − waste), so 100 g net at 10% needs 111.1111 g gross (owner
 * decision Q19, 2026-11-01). A line must not reference its own recipe; deeper
 * loops are caught while costing.
 */
export const recipeLineSchema = z
  .strictObject({
    id: recipeLineIdSchema,
    tenantId: tenantIdSchema,
    recipeId: recipeIdSchema,
    componentType: recipeComponentTypeSchema,
    componentId: uuidSchema,
    quantity: positiveDecimal4Schema,
    uomId: uomIdSchema,
    wastePctBp: recipeWastePctSchema,
    /** Stock location this line is drawn from; null = the sale location. */
    deductionLocationId: stockLocationIdSchema.nullable().optional(),
  })
  .superRefine((line, context) => {
    if (line.componentType === "recipe" && line.componentId === line.recipeId)
      context.addIssue({
        code: "custom",
        path: ["componentId"],
        message: "A recipe cannot contain itself",
      });
  });
export type RecipeLine = z.infer<typeof recipeLineSchema>;

export const recipeDetailSchema = z.strictObject({
  recipe: recipeSchema,
  lines: z.array(recipeLineSchema),
});
export type RecipeDetail = z.infer<typeof recipeDetailSchema>;

function assertWastePct(wastePctBp: number): void {
  if (!Number.isInteger(wastePctBp) || wastePctBp < 0 || wastePctBp >= 10_000)
    throw new RangeError(`Invalid waste percentage: ${wastePctBp}`);
}

/**
 * Gross quantity drawn from stock for a net recipe quantity. Waste is a yield
 * loss, not an addition: 100 g net at 10% waste needs 100 ÷ (1 − 10%) =
 * 111.1111 g gross (owner decision Q19, 2026-11-01). Use it for stock
 * movements and display; `theoreticalRecipeCost` divides without rounding the
 * quantity first, so sub-0.0001 unit precision still reaches the HPP.
 */
export function grossRecipeQuantity(
  netQuantity: Decimal4,
  wastePctBp: number,
  mode: RoundingMode,
): Decimal4 {
  assertWastePct(wastePctBp);
  return formatDecimal4(
    divideRounded(
      parseDecimal4(netQuantity) * 10_000n,
      10_000n - BigInt(wastePctBp),
      mode,
    ),
  );
}

/** Cost of one line: base quantity, with waste, valued at the item's cost. */
export function recipeLineCostIdr(
  input: {
    baseQuantity: Decimal4;
    unitCostIdr: Decimal4;
    wastePctBp: number;
  },
  mode: RoundingMode,
): Idr {
  return idr(
    Number(divideRounded(recipeLineCostScaled(input, mode), 10_000n, mode)),
  );
}

/**
 * Line cost at NUMERIC(14,4) scale (rupiah x 10^4). One rounding step:
 * rounding the quantity first would lose precision (100 g net at 10% waste is
 * 111.1111... g gross), and recipes sum these unrounded so a cheap line
 * (2 g sugar at Rp 0.30/g) is not rounded away before it reaches
 * `theoreticalCostIdr` (NUMERIC(14,4), PRD §6.E). The quantity and unit cost
 * are both Decimal4, so `qty x cost / 10^4` is already rupiah x 10^4 and the
 * yield loss divides it by (1 − waste) in the same step.
 */
function recipeLineCostScaled(
  input: { baseQuantity: Decimal4; unitCostIdr: Decimal4; wastePctBp: number },
  mode: RoundingMode,
): bigint {
  assertWastePct(input.wastePctBp);
  return divideRounded(
    parseDecimal4(input.baseQuantity) * parseDecimal4(input.unitCostIdr),
    10_000n - BigInt(input.wastePctBp),
    mode,
  );
}

export type RecipeCostBook = {
  recipes: readonly Recipe[];
  recipeLines: readonly RecipeLine[];
  items: readonly InventoryItem[];
  conversions: readonly UomConversion[];
  /** Moving-average unit cost per base unit, keyed by inventory item id. */
  unitCosts: ReadonlyMap<string, Decimal4>;
};

export type RecipeCost = {
  recipeId: RecipeId;
  totalCostIdr: Idr;
  /** HPP per one yield unit, NUMERIC(14,4). */
  unitCostIdr: Decimal4;
};

/**
 * INV-02 / INV-04: the theoretical HPP of a recipe, resolving nested recipes
 * and converting every line to its component's base unit before applying the
 * moving-average cost and the line yield loss (gross = net ÷ (1 − waste),
 * owner decision Q19). Throws `RECIPE_CYCLE` for a loop,
 * `RECIPE_COMPONENT_MISSING`, `RECIPE_NOT_FOUND`, `RECIPE_OUTPUT_MISSING` (a
 * nested recipe without an output item) or `UNIT_COST_MISSING`.
 */
export function theoreticalRecipeCost(
  book: RecipeCostBook,
  recipeId: string,
  mode: RoundingMode,
): RecipeCost {
  const recipes = new Map<string, Recipe>(
    book.recipes.map((recipe) => [recipe.id, recipe]),
  );
  const items = new Map<string, InventoryItem>(
    book.items.map((item) => [item.id, item]),
  );
  const costs = new Map<string, RecipeCost>();
  const scaledTotals = new Map<string, bigint>();
  const visiting = new Set<string>();

  const conversionsFor = (inventoryItemId: string): UomConversion[] =>
    book.conversions.filter(
      (conversion) => conversion.inventoryItemId === inventoryItemId,
    );

  const costOf = (id: string): RecipeCost => {
    const cached = costs.get(id);
    if (cached) return cached;
    if (visiting.has(id))
      throw new InventoryError(
        "RECIPE_CYCLE",
        `Recipe ${id} takes part in a cycle`,
      );
    const recipe = recipes.get(id);
    if (!recipe)
      throw new InventoryError("RECIPE_NOT_FOUND", `Recipe ${id} not found`);
    visiting.add(id);
    // Rupiah x 10^4: lines are summed unrounded, rounded once below.
    let total = 0n;
    try {
      for (const line of book.recipeLines) {
        if (line.recipeId !== id) continue;
        assertWastePct(line.wastePctBp);
        if (line.componentType === "item") {
          const item = items.get(line.componentId);
          if (!item)
            throw new InventoryError(
              "RECIPE_COMPONENT_MISSING",
              `Recipe ${id} references missing item ${line.componentId}`,
            );
          const unitCost = book.unitCosts.get(item.id);
          if (unitCost === undefined)
            throw new InventoryError(
              "UNIT_COST_MISSING",
              `Item ${item.id} has no moving-average cost`,
            );
          const baseQuantity = convertQuantity(
            line.quantity,
            line.uomId,
            item.baseUomId,
            conversionsFor(item.id),
            mode,
          );
          total += recipeLineCostScaled(
            {
              baseQuantity,
              unitCostIdr: unitCost,
              wastePctBp: line.wastePctBp,
            },
            mode,
          );
          continue;
        }
        const nestedRecipe = recipes.get(line.componentId);
        if (!nestedRecipe)
          throw new InventoryError(
            "RECIPE_COMPONENT_MISSING",
            `Recipe ${id} references missing recipe ${line.componentId}`,
          );
        if (!nestedRecipe.outputItemId)
          throw new InventoryError(
            "RECIPE_OUTPUT_MISSING",
            `Nested recipe ${nestedRecipe.id} has no output item`,
          );
        const outputItem = items.get(nestedRecipe.outputItemId);
        if (!outputItem)
          throw new InventoryError(
            "RECIPE_COMPONENT_MISSING",
            `Nested recipe ${nestedRecipe.id} outputs missing item ${nestedRecipe.outputItemId}`,
          );
        costOf(nestedRecipe.id);
        const nestedScaled = scaledTotals.get(nestedRecipe.id) ?? 0n;
        const outputConversions = conversionsFor(outputItem.id);
        const producedBase = convertQuantity(
          nestedRecipe.yieldQuantity,
          nestedRecipe.yieldUomId,
          outputItem.baseUomId,
          outputConversions,
          mode,
        );
        const consumedBase = convertQuantity(
          line.quantity,
          line.uomId,
          outputItem.baseUomId,
          outputConversions,
          mode,
        );
        if (parseDecimal4(producedBase) <= 0n)
          throw new RangeError(
            `Nested recipe ${nestedRecipe.id} yields no output`,
          );
        total += divideRounded(
          nestedScaled * parseDecimal4(consumedBase) * 10_000n,
          parseDecimal4(producedBase) * (10_000n - BigInt(line.wastePctBp)),
          mode,
        );
      }
    } finally {
      visiting.delete(id);
    }
    const cost: RecipeCost = {
      recipeId: recipe.id,
      totalCostIdr: idr(Number(divideRounded(total, 10_000n, mode))),
      unitCostIdr: formatDecimal4(
        divideRounded(
          total * 10_000n,
          parseDecimal4(recipe.yieldQuantity),
          mode,
        ),
      ),
    };
    scaledTotals.set(id, total);
    costs.set(id, cost);
    return cost;
  };

  return costOf(recipeId);
}

/**
 * Gross margin in basis points for the HPP report (PRD §17 "HPP Menu ...
 * beserta margin kotor"). Cost is per portion at NUMERIC(14,4); price is whole
 * rupiah. A zero price is a data error, not 0%.
 */
export function grossMarginBp(
  priceIdr: Idr,
  costIdr: Decimal4,
  mode: RoundingMode,
): number {
  if (priceIdr <= 0)
    throw new RangeError("Menu price must be greater than zero");
  return Number(
    divideRounded(
      BigInt(priceIdr) * 10_000n - parseDecimal4(costIdr),
      BigInt(priceIdr),
      mode,
    ),
  );
}

// ---- Menu HPP, coverage and menu engineering (PRD §17) -------------------

/**
 * Theoretical HPP per menu item, variant or modifier (exactly one id is set
 * besides the menu item). A menu without a recipe stays sellable and appears
 * with `recipeComplete: false` and no cost (PRD §17 "Kelengkapan Resep", R13).
 */
export const menuCostSchema = z
  .strictObject({
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    menuItemId: uuidSchema,
    variantId: uuidSchema.nullable(),
    modifierId: uuidSchema.nullable(),
    recipeId: recipeIdSchema.nullable(),
    recipeComplete: z.boolean(),
    theoreticalCostIdr: nonnegativeDecimal4Schema.nullable(),
    priceIdr: nonnegativeIdrSchema,
    grossMarginBp: z.number().int().nullable(),
    computedAt: isoDateTimeSchema,
  })
  .superRefine((cost, context) => {
    if (cost.recipeComplete) {
      if (cost.recipeId === null || cost.theoreticalCostIdr === null)
        context.addIssue({
          code: "custom",
          path: ["recipeId"],
          message: "A complete recipe needs a recipe and a cost",
        });
      if (cost.grossMarginBp === null)
        context.addIssue({
          code: "custom",
          path: ["grossMarginBp"],
          message: "A complete recipe needs a gross margin",
        });
      return;
    }
    if (cost.theoreticalCostIdr !== null || cost.grossMarginBp !== null)
      context.addIssue({
        code: "custom",
        path: ["theoreticalCostIdr"],
        message: "An incomplete recipe has no theoretical cost",
      });
  });
export type MenuCost = z.infer<typeof menuCostSchema>;

export const recipeCoverageStatusSchema = z.enum([
  "complete",
  "incomplete",
  "no_recipe",
]);
export type RecipeCoverageStatus = z.infer<typeof recipeCoverageStatusSchema>;

/** PRD §17 "Kelengkapan Resep": which menu items cannot be costed yet. */
export const recipeCoverageRowSchema = z
  .strictObject({
    tenantId: tenantIdSchema,
    menuItemId: uuidSchema,
    variantId: uuidSchema.nullable(),
    modifierId: uuidSchema.nullable(),
    status: recipeCoverageStatusSchema,
    recipeId: recipeIdSchema.nullable(),
    theoreticalCostIdr: nonnegativeDecimal4Schema.nullable(),
    updatedAt: isoDateTimeSchema,
  })
  .refine(
    (row) =>
      row.status === "no_recipe"
        ? row.recipeId === null
        : row.recipeId !== null,
    { path: ["recipeId"], message: "Recipe presence must match the status" },
  );
export type RecipeCoverageRow = z.infer<typeof recipeCoverageRowSchema>;

/**
 * Actual vs theoretical food cost for a period (PRD §17). The variance equals
 * the sum of its explained parts; `varianceBp` is variance / theoretical.
 */
export const foodCostComparisonSchema = z
  .strictObject({
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    fromDate: businessDateSchema,
    toDate: businessDateSchema,
    theoreticalCostIdr: nonnegativeIdrSchema,
    actualCostIdr: nonnegativeIdrSchema,
    varianceIdr: idrSchema,
    varianceBp: z.number().int(),
    wasteIdr: nonnegativeIdrSchema,
    adjustmentIdr: idrSchema,
    offRecipeUsageIdr: nonnegativeIdrSchema,
    // Orders whose stock deduction is not posted yet: their theoretical cost
    // stands in for the actual cost (never Rp0). Optional so older clients and
    // fixtures stay valid; the API always fills them.
    pendingOrderCount: z.number().int().nonnegative().optional(),
    pendingTheoreticalIdr: nonnegativeIdrSchema.optional(),
    // Lines of unreconciled orders with no cost snapshot: their cost is unknown
    // (never Rp0), so the figure is a lower bound when this is above zero.
    pendingUnknownLineCount: z.number().int().nonnegative().optional(),
  })
  .refine((row) => row.fromDate <= row.toDate, {
    path: ["toDate"],
    message: "The period must not end before it starts",
  });
export type FoodCostComparison = z.infer<typeof foodCostComparisonSchema>;

/** Standard menu-engineering matrix (PRD §17 "Menu Engineering"). */
export const menuEngineeringClassSchema = z.enum([
  "star",
  "plowhorse",
  "puzzle",
  "dog",
]);
export type MenuEngineeringClass = z.infer<typeof menuEngineeringClassSchema>;

export const menuEngineeringRowSchema = z.strictObject({
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  menuItemId: uuidSchema,
  unitsSold: z.number().int().nonnegative(),
  grossMarginIdr: idrSchema,
  classification: menuEngineeringClassSchema,
});
export type MenuEngineeringRow = z.infer<typeof menuEngineeringRowSchema>;

// ---- Production orders (PRD §17 "Produksi Batch", §6.E) ------------------

export const productionOrderStatusSchema = z.enum([
  "draft",
  "in_progress",
  "completed",
  "cancelled",
]);
export type ProductionOrderStatus = z.infer<typeof productionOrderStatusSchema>;

export const productionOrderActionSchema = z.enum([
  "start",
  "complete",
  "cancel",
]);
export type ProductionOrderAction = z.infer<typeof productionOrderActionSchema>;

/**
 * A batch of a semi-finished recipe. Completion writes `production_out` rows
 * for every component and one `production_in` row at `costIdr / actualQty`
 * (PRD §17 "Produksi Batch"). `costIdr` is whole rupiah for the batch (D-CORE-2).
 */
export const productionOrderSchema = z
  .strictObject({
    id: productionOrderIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    recipeId: recipeIdSchema,
    plannedQty: positiveDecimal4Schema,
    actualQty: nonnegativeDecimal4Schema.nullable(),
    status: productionOrderStatusSchema,
    costIdr: nonnegativeIdrSchema.nullable(),
    createdAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((order, context) => {
    if (order.status === "completed") {
      if (order.actualQty === null || parseDecimal4(order.actualQty) <= 0n)
        context.addIssue({
          code: "custom",
          path: ["actualQty"],
          message: "A completed batch needs a positive actual quantity",
        });
      if (order.costIdr === null)
        context.addIssue({
          code: "custom",
          path: ["costIdr"],
          message: "A completed batch needs its cost",
        });
      if (order.completedAt === null)
        context.addIssue({
          code: "custom",
          path: ["completedAt"],
          message: "A completed batch needs a completion time",
        });
      return;
    }
    if (order.completedAt !== null)
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Only a completed batch has a completion time",
      });
  });
export type ProductionOrder = z.infer<typeof productionOrderSchema>;

const PRODUCTION_TRANSITIONS: Record<
  ProductionOrderStatus,
  Partial<Record<ProductionOrderAction, ProductionOrderStatus>>
> = {
  draft: { start: "in_progress", cancel: "cancelled" },
  in_progress: { complete: "completed", cancel: "cancelled" },
  completed: {},
  cancelled: {},
};

/** Explicit production-order state machine (PRD §17 "Produksi Batch"). */
export function transitionProductionOrder(
  from: ProductionOrderStatus,
  action: ProductionOrderAction,
): ProductionOrderStatus {
  const next = PRODUCTION_TRANSITIONS[from][action];
  if (!next)
    throw new InventoryError(
      "PRODUCTION_INVALID_TRANSITION",
      `Cannot ${action} a production order in ${from}`,
    );
  return next;
}

// ---- Tenant inventory settings (PRD §16 "Pemotongan Otomatis", legend-gjmk) --

/**
 * PRD §16 "Pemotongan Otomatis": a sale deducts recipe ingredients either
 * `real_time` or `close_of_day` ("pada tutup hari sesuai pengaturan").
 */
export const recipeDeductionModeSchema = z.enum(["real_time", "close_of_day"]);
export type RecipeDeductionMode = z.infer<typeof recipeDeductionModeSchema>;

/**
 * Expiry warning window in days ("peringatan menjelang kedaluwarsa", PRD §16
 * "Batch & Kedaluwarsa"); the `warnDays` argument of `batchExpiryStatus`.
 * PRD gives no number: bounded 1..365, default 7 (decision, see legend-gjmk).
 */
export const expiryWarningDaysSchema = z.number().int().min(1).max(365);
export const DEFAULT_EXPIRY_WARNING_DAYS = 7;
export const DEFAULT_RECIPE_DEDUCTION_MODE: RecipeDeductionMode = "real_time";

/**
 * One row per tenant. A tenant that never saved settings reads the defaults
 * (`updatedAt` null); the first save creates the row.
 */
export const inventorySettingsSchema = z.strictObject({
  tenantId: tenantIdSchema,
  recipeDeductionMode: recipeDeductionModeSchema,
  expiryWarningDays: expiryWarningDaysSchema,
  updatedAt: isoDateTimeSchema.nullable(),
});
export type InventorySettings = z.infer<typeof inventorySettingsSchema>;
