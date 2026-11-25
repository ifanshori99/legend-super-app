// Pure mapping between the cashier view-models and the shared POS contracts
// (brief 1268 W1). No price, total or applied amount is ever built here: a
// request carries ids, quantities, notes and the table session only; every
// figure shown after create comes from the server's answer.
//
// Plain TypeScript with relative `.ts` imports: Node tests load it directly.
import type {
  PosCatalog,
  PosOrderDetail,
  PosParkedOrder,
} from "@starter/shared/pos";
import type { FloorBoard } from "@starter/shared/qr-order";
import { cartTotals } from "./cart-logic.ts";
import type {
  CaptainTable,
  CartLine,
  Catalog,
  Course,
  MenuItem,
  OjolPlatform,
  OrderMeta,
  OrderSnapshot,
  ParkedDraft,
  PosOrderView,
  SaleChannel,
  SubmitOrderInput,
} from "./types.ts";

const NO_COURSE: Course = { id: "", label: "", order: 0 };

type WireLine = {
  menuItemId: string;
  variantId: string | null;
  modifierIds: string[];
  quantity: number;
  note: string | null;
  course: string | null;
  hold: boolean;
};

export type OrderTarget = {
  channel: "pos" | OjolPlatform;
  serviceType: "dine_in" | "takeaway" | "delivery";
  tableSessionId: string | null;
  externalRef: string | null;
};

/** A cart line as the server takes it: ids and quantities, no money. */
export function toWireLine(line: CartLine): WireLine {
  return {
    menuItemId: line.menuItemId,
    variantId: line.variantId,
    modifierIds: line.modifiers.map((modifier) => modifier.optionId),
    quantity: line.quantity,
    note: line.note.trim() === "" ? null : line.note.trim(),
    course: line.course.id === "" ? null : line.course.id,
    hold: line.hold,
  };
}

/** Where the order goes: the table session, never the table's label. */
export function orderTarget(
  input: Pick<SubmitOrderInput, "channel" | "tableSessionId" | "ojol">,
): OrderTarget {
  if (input.channel === "ojol_manual" && input.ojol)
    return {
      channel: input.ojol.platform,
      serviceType: "delivery",
      tableSessionId: null,
      externalRef: input.ojol.externalRef.trim(),
    };
  if (input.channel === "takeaway")
    return {
      channel: "pos",
      serviceType: "takeaway",
      tableSessionId: null,
      externalRef: null,
    };
  return {
    channel: "pos",
    serviceType: "dine_in",
    tableSessionId: input.tableSessionId,
    externalRef: null,
  };
}

/** The create body without its key: this is what the intent fingerprints. */
export function createBodyOf(input: SubmitOrderInput) {
  const target = orderTarget(input);
  return {
    channel: target.channel,
    serviceType: target.serviceType,
    tableSessionId: target.tableSessionId,
    externalRef: target.externalRef,
    items: input.lines.map(toWireLine),
  };
}

/** Submit moves the order draft -> awaiting_payment; the key is per intent. */
export function submitBodyOf(idempotencyKey: string) {
  return { expectedStatus: "draft" as const, idempotencyKey };
}

export function channelOfOrder(
  order: Pick<PosOrderDetail, "channel" | "serviceType">,
): SaleChannel {
  if (
    order.channel === "gofood" ||
    order.channel === "grabfood" ||
    order.channel === "shopeefood"
  )
    return "ojol_manual";
  return order.serviceType === "takeaway" ? "takeaway" : "dine_in";
}

function courseOf(value: string | null): Course {
  if (value === null || value === "") return NO_COURSE;
  const order = Number.parseInt(value.replace(/\D+/g, ""), 10);
  return { id: value, label: value, order: Number.isFinite(order) ? order : 0 };
}

export function mapCatalog(wire: PosCatalog): Catalog {
  return {
    categories: wire.categories.map((category) => ({
      id: category.id,
      name: category.name,
    })),
    items: wire.items.map((item): MenuItem => ({
      id: item.id,
      name: item.name,
      categoryId: item.categoryId,
      categoryName: item.categoryName,
      priceIdr: Number(item.basePriceIdr),
      imageUrl: item.imageUrl,
      soldOut: item.soldOut,
      code: item.code,
      course: courseOf(item.course),
      variants: item.variants.map((variant) => ({
        id: variant.id,
        name: variant.name,
        priceIdr: Number(variant.priceIdr),
      })),
      modifierGroups: item.modifierGroups.map((group) => ({
        id: group.id,
        name: group.name,
        required: group.required,
        min: group.min,
        max: group.max,
        options: group.options.map((option) => ({
          id: option.id,
          name: option.label,
          priceDeltaIdr: Number(option.priceDeltaIdr),
        })),
      })),
    })),
    updatedAt: wire.updatedAt,
    source: wire.source,
  };
}

/** The order as the server priced it. Voided lines are not shown. */
export function mapOrder(order: PosOrderDetail): PosOrderView {
  return {
    orderId: order.id,
    number: order.number,
    channel: channelOfOrder(order),
    tableLabel: null,
    callNumber: order.callNumber,
    subtotalIdr: Number(order.subtotalIdr),
    lines: order.items
      .filter((item) => item.status !== "voided")
      .map((item) => ({
        lineId: item.id,
        menuItemId: item.menuItemId,
        name: item.name,
        unitPriceIdr: Number(item.unitPriceIdr),
        quantity: item.quantity,
        modifiers: item.modifiers.map((modifier) => ({
          groupId: "",
          optionId: modifier.modifierId,
          name: modifier.name,
          priceDeltaIdr: Number(modifier.priceIdr),
        })),
        note: item.note ?? "",
        course: courseOf(item.course),
        status: item.fireStatus === "held" ? "held" : "sent",
      })),
  };
}

/** The parked snapshot body: ids only, same shape as an order's lines. */
export function parkBodyOf(input: SubmitOrderInput) {
  return createBodyOf(input);
}

/**
 * A parked snapshot carries ids only, so names, prices and courses come from
 * the current catalog. A line whose item left the catalog is counted in
 * `missing` and not restored; the price shown is an estimate until create.
 */
export function mapParked(
  parked: PosParkedOrder,
  catalog: Catalog,
  newLineId: () => string,
): { draft: ParkedDraft; missing: number } {
  const items = new Map(catalog.items.map((item) => [item.id, item]));
  let missing = 0;
  const lines: CartLine[] = [];
  for (const wire of parked.items) {
    const item = items.get(wire.menuItemId);
    const variant =
      item?.variants.find((entry) => entry.id === wire.variantId) ?? null;
    if (!item || (item.variants.length > 0 && !variant)) {
      missing += 1;
      continue;
    }
    // Every saved option must still exist; otherwise the line would come back
    // cheaper or different without a word, so it is counted as missing.
    const modifiers = wire.modifierIds.flatMap((optionId) =>
      item.modifierGroups.flatMap((group) =>
        group.options
          .filter((option) => option.id === optionId)
          .map((option) => ({
            groupId: group.id,
            optionId: option.id,
            name: option.name,
            priceDeltaIdr: option.priceDeltaIdr,
          })),
      ),
    );
    if (modifiers.length !== wire.modifierIds.length) {
      missing += 1;
      continue;
    }
    lines.push({
      lineId: newLineId(),
      menuItemId: item.id,
      variantId: variant?.id ?? null,
      variantName: variant?.name ?? null,
      name: item.name,
      unitPriceIdr: variant?.priceIdr ?? item.priceIdr,
      quantity: wire.quantity,
      modifiers,
      note: wire.note ?? "",
      course: item.course,
      hold: wire.hold ?? false,
    });
  }
  const channel: SaleChannel =
    parked.channel === "gofood" ||
    parked.channel === "grabfood" ||
    parked.channel === "shopeefood"
      ? "ojol_manual"
      : parked.serviceType === "takeaway"
        ? "takeaway"
        : "dine_in";
  const ojolPlatform =
    parked.channel === "gofood" ||
    parked.channel === "grabfood" ||
    parked.channel === "shopeefood"
      ? parked.channel
      : null;
  return {
    missing,
    draft: {
      id: parked.id,
      label: parked.label,
      channel,
      tableSessionId: parked.tableSessionId ?? null,
      ojol:
        ojolPlatform && parked.externalRef
          ? { platform: ojolPlatform, externalRef: parked.externalRef }
          : null,
      lines,
      parkedAt: parked.parkedAt,
      subtotalIdr: cartTotals(lines).subtotalIdr,
    },
  };
}

/**
 * The floor board as table choices. A table is orderable only with an open
 * session (`sessionId`); seating a walk-in is the captain card (B1).
 */
export function mapFloor(board: FloorBoard): CaptainTable[] {
  const zones = new Map(board.zones.map((zone) => [zone.id, zone.name]));
  return board.tables.map((row) => ({
    id: row.table.id,
    label: row.table.code,
    zone: zones.get(row.table.zoneId) ?? "",
    status: row.session ? "occupied" : "empty",
    guestCount: row.session?.pax ?? 0,
    seats: row.table.capacity,
    qrSessionActive: row.session !== null,
    sessionId: row.session?.id ?? null,
    hasOpenCall: row.openServiceRequestCount > 0,
  }));
}

/**
 * The parked entry as the cart that was just parked: the lines are the ones
 * the cashier had, so parking never depends on loading the catalog.
 */
export function draftFromPark(
  parked: PosParkedOrder,
  input: SubmitOrderInput,
): ParkedDraft {
  return {
    id: parked.id,
    label: parked.label,
    channel: input.channel,
    tableSessionId: input.tableSessionId,
    ojol: input.ojol,
    lines: input.lines,
    parkedAt: parked.parkedAt,
    subtotalIdr: cartTotals(input.lines).subtotalIdr,
  };
}

/** The send input of a cart and its meta (what `createBodyOf` fingerprints). */
export function inputOfMeta(
  meta: OrderMeta,
  lines: CartLine[],
): SubmitOrderInput {
  return {
    channel: meta.channel,
    tableSessionId: meta.channel === "dine_in" ? meta.tableSessionId : null,
    ojol:
      meta.channel === "ojol_manual" &&
      meta.ojolPlatform &&
      meta.ojolRef.trim() !== ""
        ? { platform: meta.ojolPlatform, externalRef: meta.ojolRef.trim() }
        : null,
    lines,
  };
}

/** True when the cart on screen would be sent as exactly this snapshot. */
export function sameOrder(
  lines: CartLine[],
  meta: OrderMeta,
  snapshot: OrderSnapshot,
): boolean {
  return (
    JSON.stringify(createBodyOf(inputOfMeta(meta, lines))) ===
    JSON.stringify(createBodyOf(inputOfMeta(snapshot.meta, snapshot.lines)))
  );
}
