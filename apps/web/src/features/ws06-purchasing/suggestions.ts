// PRD §16 AI-08: temporary par-level basis until the suggestion service lands.
// This is deterministic stock replenishment, not a demand forecast.
import { formatDecimal4, parseDecimal4 } from "@starter/shared/core";
import type { Decimal4 } from "@starter/shared/core";
import {
  effectiveParLevel,
  parStatus,
  stockBalanceKey,
} from "@starter/shared/inventory";
import type {
  InventoryItem,
  ParLevel,
  StockBalance,
} from "@starter/shared/inventory";

export type PurchaseSuggestion = {
  key: string;
  item: InventoryItem;
  locationId: string;
  onHand: Decimal4;
  parMin: Decimal4;
  parMax: Decimal4;
  suggestedQty: Decimal4;
};

/** Same basis as legend-vxj: explicit location par wins; defaults only apply
 * to locations with a balance. Include explicit pairs even without stock. */
export function purchaseSuggestions(input: {
  items: readonly InventoryItem[];
  balances: readonly StockBalance[];
  parLevels: readonly ParLevel[];
}): PurchaseSuggestion[] {
  const items = new Map<string, InventoryItem>(
    input.items.map((item) => [item.id, item]),
  );
  const balances = new Map(
    input.balances.map((balance) => [
      stockBalanceKey(balance.locationId, balance.inventoryItemId),
      balance,
    ]),
  );
  const explicit = new Set<string>();
  const rows: PurchaseSuggestion[] = [];
  const add = (
    item: InventoryItem,
    locationId: string,
    par: { parMin: Decimal4; parMax: Decimal4 },
  ) => {
    const key = stockBalanceKey(locationId, item.id);
    const onHand = balances.get(key)?.quantity ?? ("0.0000" as Decimal4);
    if (parStatus(onHand, par) !== "below_min") return;
    rows.push({
      key,
      item,
      locationId,
      onHand,
      ...par,
      suggestedQty: formatDecimal4(
        parseDecimal4(par.parMax) - parseDecimal4(onHand),
      ),
    });
  };
  for (const level of input.parLevels) {
    const item = items.get(level.inventoryItemId);
    if (!item) continue;
    explicit.add(stockBalanceKey(level.locationId, item.id));
    add(item, level.locationId, level);
  }
  for (const balance of input.balances) {
    const key = stockBalanceKey(balance.locationId, balance.inventoryItemId);
    if (explicit.has(key)) continue;
    const item = items.get(balance.inventoryItemId);
    if (!item) continue;
    const par = effectiveParLevel(item);
    if (par) add(item, balance.locationId, par);
  }
  return rows.sort(
    (a, b) =>
      Number(a.onHand) / Math.max(Number(a.parMin), 1) -
      Number(b.onHand) / Math.max(Number(b.parMin), 1),
  );
}
