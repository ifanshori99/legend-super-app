// Guest-facing read models and endpoints of the QR order journey (beads
// legend-2m4, legend-8sh, legend-woz, legend-tz1; PRD v1.7 §3 "QR Order
// Pelanggan"). The WS-03 contracts (legend-6li, legend-j85) define the write
// side and the staff views; the customer screens also need:
//   - the public menu read model (items with channel price, variants,
//     modifier groups with min/max, labels, allergens, sold-out state);
//   - menu suggestions (AI-01);
//   - a guest-safe view of failed-item issues (no cost, no staff names);
//   - the payment hand-off for a QR order / split share (WS-05 intent, trimmed
//     to what a guest may see);
//   - the per-person point claim (PRD "Klaim Poin per Orang", 24 hours).
// They live here, next to the QR order contract, until the backend beads
// (legend-4jm) ratify them; every price on the wire is computed by the server
// (ORD-03) and excludes tax and service charge (owner rule, menu prices are
// exclusive; the quote adds both at checkout).

import {
  z,
  uuidSchema,
  idrSchema,
  basisPointsSchema,
  isoDateTimeSchema,
  dataResponseSchema,
  clientInputSchema,
  idempotencyKeySchema,
  brandRefSchema,
  outletRefSchema,
  idr,
} from "../core/index.ts";
import { cafeLegendFixtures } from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import { cafeLegendMenuFixtures } from "../menu/index.ts";
import { paymentStatusSchema } from "../payment/index.ts";
import {
  apologyVoucherIdSchema,
  billSplitIdSchema,
  floorZoneIdSchema,
  orderIdSchema,
  orderIssueIdSchema,
  orderIssueResolutionSchema,
  orderIssueTypeSchema,
  orderItemIdSchema,
  paymentModeSchema,
  signedQrTokenSchema,
  tableIdSchema,
  tableSessionIdSchema,
  voucherCodeSchema,
} from "./schemas.ts";
import type { FloorZone, Table } from "./schemas.ts";
import { qrOrderFixtures } from "./fixtures.ts";

const name = z.string().min(1).max(150);
const nonnegativeIdr = idrSchema.refine((value) => value >= 0);
const positiveIdr = idrSchema.refine((value) => value > 0);

// ---- Public menu read model ------------------------------------------------

/** Labels the menu content form offers (PRD "Konten Menu"). Free text is allowed. */
export const MENU_LABELS = ["baru", "terlaris", "pedas", "vegetarian"] as const;

export const qrMenuModifierSchema = z.strictObject({
  id: uuidSchema,
  name,
  /** Added to the unit price per unit (excludes tax and service charge). */
  priceIdr: nonnegativeIdr,
  soldOut: z.boolean(),
});

export const qrMenuModifierGroupSchema = z
  .strictObject({
    id: uuidSchema,
    name,
    minSelect: z.number().int().nonnegative(),
    maxSelect: z.number().int().positive(),
    modifiers: z.array(qrMenuModifierSchema).min(1),
  })
  .refine(
    (group) =>
      group.minSelect <= group.maxSelect &&
      group.maxSelect <= group.modifiers.length,
    { path: ["maxSelect"], message: "min/max must fit the modifier list" },
  );

export const qrMenuVariantSchema = z.strictObject({
  id: uuidSchema,
  name,
  /** Absolute channel price of this variant. */
  priceIdr: positiveIdr,
});

export const qrMenuItemSchema = z
  .strictObject({
    id: uuidSchema,
    categoryId: uuidSchema,
    name,
    description: z.string().max(500),
    type: z.enum(["single", "combo"]),
    /** Channel price (dine-in), excluding tax and service charge. */
    priceIdr: positiveIdr,
    labels: z.array(name).max(6),
    allergens: z.array(name).max(10),
    /** Media library URL; null until the outlet uploads a photo. */
    photoUrl: z.string().min(1).max(500).nullable(),
    variants: z.array(qrMenuVariantSchema).max(8),
    modifierGroups: z.array(qrMenuModifierGroupSchema).max(8),
    status: z.enum(["available", "sold_out"]),
    sortOrder: z.number().int(),
  })
  .superRefine((item, ctx) => {
    if (
      item.variants.length > 0 &&
      Math.min(...item.variants.map((v) => v.priceIdr)) !== item.priceIdr
    )
      ctx.addIssue({
        code: "custom",
        path: ["priceIdr"],
        message: "priceIdr is the lowest variant price when variants exist",
      });
  });
export type QrMenuItem = z.infer<typeof qrMenuItemSchema>;
export type QrMenuModifierGroup = z.infer<typeof qrMenuModifierGroupSchema>;

export const qrMenuSchema = z
  .strictObject({
    brand: brandRefSchema,
    outlet: outletRefSchema,
    table: z.strictObject({
      id: tableIdSchema,
      code: z.string().min(1).max(20),
      capacity: z.number().int().min(1).max(50),
    }),
    zone: z.strictObject({
      id: floorZoneIdSchema,
      name,
      paymentMode: paymentModeSchema,
      serviceChargeBp: basisPointsSchema,
      minimumSpendIdr: nonnegativeIdr,
    }),
    /** False outside the zone's opening hours; the menu stays readable. */
    orderingOpen: z.boolean(),
    pricing: z.strictObject({
      /** Owner rule: menu prices exclude tax and service charge. */
      pricesIncludeTaxAndService: z.literal(false),
      serviceChargeBp: basisPointsSchema,
      taxes: z.array(z.strictObject({ name, rateBp: basisPointsSchema })),
    }),
    categories: z.array(
      z.strictObject({
        id: uuidSchema,
        name,
        sortOrder: z.number().int(),
      }),
    ),
    items: z.array(qrMenuItemSchema),
    menuUpdatedAt: isoDateTimeSchema,
  })
  .superRefine((menu, ctx) => {
    const categoryIds = new Set(menu.categories.map((category) => category.id));
    for (const item of menu.items)
      if (!categoryIds.has(item.categoryId))
        ctx.addIssue({
          code: "custom",
          path: ["items"],
          message: "Every item must belong to a listed category",
        });
  });
export type QrMenu = z.infer<typeof qrMenuSchema>;

/** Public, read-only: the signed table QR resolves tenant, outlet and zone. */
export const getQrMenu = defineEndpoint({
  method: "GET",
  path: "/api/qr/menu/:qrToken",
  params: z.strictObject({ qrToken: signedQrTokenSchema }),
  response: dataResponseSchema(qrMenuSchema),
});

// ---- Suggestions (AI-01) ----------------------------------------------------

export const menuSuggestionSchema = z.strictObject({
  menuItemId: uuidSchema,
  /** pairing: goes with what is in the cart; upgrade: a richer option. */
  kind: z.enum(["pairing", "upgrade"]),
  basedOnMenuItemId: uuidSchema.nullable(),
});
export type MenuSuggestion = z.infer<typeof menuSuggestionSchema>;

/**
 * Rules (margin, stock, hours) are applied by the server; the guest sees only
 * items that can be ordered now (PRD AI-01).
 */
export const getMenuSuggestions = defineEndpoint({
  method: "GET",
  path: "/api/table-sessions/:sessionId/suggestions",
  params: z.strictObject({ sessionId: tableSessionIdSchema }),
  query: z.strictObject({ menuItemId: uuidSchema.optional() }),
  response: dataResponseSchema(z.array(menuSuggestionSchema).max(6)),
});

// ---- Failed item recovery, guest view (ORD-08) ------------------------------

export const guestSwapOptionSchema = z.strictObject({
  menuItemId: uuidSchema,
  name,
  priceIdr: positiveIdr,
  /** Positive: the guest pays the difference; negative: credited (server). */
  differenceIdr: idrSchema,
});

export const guestOrderIssueSchema = z.strictObject({
  id: orderIssueIdSchema,
  orderId: orderIdSchema,
  orderItemId: orderItemIdSchema,
  itemName: name,
  quantity: z.number().int().min(1).max(99),
  lineTotalIdr: positiveIdr,
  type: orderIssueTypeSchema,
  status: z.enum(["open", "resolved", "cancelled"]),
  /** ORD-08: the guest only ever chooses swap or voucher credit. */
  options: z.strictObject({
    swap: z.strictObject({
      allowed: z.boolean(),
      items: z.array(guestSwapOptionSchema),
    }),
    voucher: z.strictObject({ allowed: z.boolean(), valueIdr: nonnegativeIdr }),
  }),
  resolution: orderIssueResolutionSchema.nullable(),
  replacementItemName: name.nullable(),
  priceDifferenceIdr: idrSchema.nullable(),
  voucher: z
    .strictObject({
      id: apologyVoucherIdSchema,
      code: voucherCodeSchema,
      valueIdr: positiveIdr,
      expiresAt: isoDateTimeSchema,
    })
    .nullable(),
  createdAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.nullable(),
});
export type GuestOrderIssue = z.infer<typeof guestOrderIssueSchema>;

export const listSessionOrderIssues = defineEndpoint({
  method: "GET",
  path: "/api/table-sessions/:sessionId/order-issues",
  params: z.strictObject({ sessionId: tableSessionIdSchema }),
  response: dataResponseSchema(z.array(guestOrderIssueSchema)),
});

// ---- Payment hand-off (WS-05) -----------------------------------------------

export const GUEST_PAYMENT_METHODS = ["qris", "ewallet"] as const;
export const guestPaymentMethodSchema = z.enum(GUEST_PAYMENT_METHODS);
export type GuestPaymentMethod = z.infer<typeof guestPaymentMethodSchema>;

export const guestPaymentIntentIdSchema = uuidSchema;

/** What the guest pays: one order (pay-first), a split share, or the open bill. */
export const guestPaymentTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("order"), orderId: orderIdSchema }),
  z.strictObject({ kind: z.literal("split"), billSplitId: billSplitIdSchema }),
  z.strictObject({ kind: z.literal("bill") }),
]);
export type GuestPaymentTarget = z.infer<typeof guestPaymentTargetSchema>;

export const createGuestPaymentInputSchema = clientInputSchema({
  target: guestPaymentTargetSchema,
  method: guestPaymentMethodSchema,
  idempotencyKey: idempotencyKeySchema,
});

/** ORD-02: `paid` arrives from the verified gateway webhook, never the client. */
export const guestPaymentSchema = z
  .strictObject({
    id: guestPaymentIntentIdSchema,
    target: guestPaymentTargetSchema,
    method: guestPaymentMethodSchema,
    amountIdr: positiveIdr,
    status: paymentStatusSchema,
    /** QRIS payload to render as a QR code (method qris). */
    qrisPayload: z.string().min(1).max(2000).nullable(),
    /** Wallet deep link / hosted page (method ewallet). */
    redirectUrl: z.string().min(1).max(500).nullable(),
    expiresAt: isoDateTimeSchema,
    paidAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((payment, ctx) => {
    if ((payment.status === "paid") !== (payment.paidAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["paidAt"],
        message: "paidAt must be set exactly when paid",
      });
  });
export type GuestPayment = z.infer<typeof guestPaymentSchema>;

export const createGuestPayment = defineEndpoint({
  method: "POST",
  path: "/api/table-sessions/:sessionId/payments",
  params: z.strictObject({ sessionId: tableSessionIdSchema }),
  body: createGuestPaymentInputSchema,
  response: dataResponseSchema(guestPaymentSchema),
});

export const getGuestPayment = defineEndpoint({
  method: "GET",
  path: "/api/table-sessions/:sessionId/payments/:paymentId",
  params: z.strictObject({
    sessionId: tableSessionIdSchema,
    paymentId: guestPaymentIntentIdSchema,
  }),
  response: dataResponseSchema(guestPaymentSchema),
});

// ---- Order ETA (PRD "Status Pesanan ... dengan estimasi waktu") -----------------

export const orderEtaSchema = z
  .strictObject({
    orderId: orderIdSchema,
    minMinutes: z.number().int().nonnegative(),
    maxMinutes: z.number().int().nonnegative(),
    estimatedReadyAt: isoDateTimeSchema,
  })
  .refine((eta) => eta.minMinutes <= eta.maxMinutes, {
    path: ["maxMinutes"],
    message: "minMinutes must not exceed maxMinutes",
  });
export type OrderEta = z.infer<typeof orderEtaSchema>;

/** From WS-04 order pacing; only orders that are not fully served appear. */
export const getOrderEtas = defineEndpoint({
  method: "GET",
  path: "/api/table-sessions/:sessionId/order-etas",
  params: z.strictObject({ sessionId: tableSessionIdSchema }),
  response: dataResponseSchema(z.array(orderEtaSchema)),
});

// ---- Point claim (PRD "Klaim Poin per Orang") --------------------------------

export const pointClaimSchema = z
  .strictObject({
    sessionId: tableSessionIdSchema,
    status: z.enum(["unavailable", "available", "claimed", "expired"]),
    /** What this guest paid in the session. */
    paidIdr: nonnegativeIdr,
    /** Computed by the loyalty program rules on the server. */
    points: z.number().int().nonnegative(),
    /** 24 hours after the bill is settled (PRD). */
    claimableUntil: isoDateTimeSchema.nullable(),
    /** True for an anonymous guest: sign in to claim. */
    requiresLogin: z.boolean(),
  })
  .superRefine((claim, ctx) => {
    if (claim.status === "available" && claim.claimableUntil === null)
      ctx.addIssue({
        code: "custom",
        path: ["claimableUntil"],
        message: "An available claim has a deadline",
      });
  });
export type PointClaim = z.infer<typeof pointClaimSchema>;

export const getPointClaim = defineEndpoint({
  method: "GET",
  path: "/api/table-sessions/:sessionId/points-claim",
  params: z.strictObject({ sessionId: tableSessionIdSchema }),
  response: dataResponseSchema(pointClaimSchema),
});

export const claimSessionPoints = defineEndpoint({
  method: "POST",
  path: "/api/table-sessions/:sessionId/points-claim",
  params: z.strictObject({ sessionId: tableSessionIdSchema }),
  body: clientInputSchema({ idempotencyKey: idempotencyKeySchema }),
  response: dataResponseSchema(pointClaimSchema),
});

// ---- Fixtures ---------------------------------------------------------------

const fixtureId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Well-formed signed tokens for the Cafe Legend tables the mock knows. */
const token = (a: string, b: string) => `v1.${a.repeat(40)}.${b.repeat(43)}`;
export const qrTokenFixtures = {
  /** A03, Indoor, pay-first: joins the active session with a shared cart. */
  indoor: qrOrderFixtures.tableQr.token,
  /** A01, Indoor, pay-first: free table, the scan opens a fresh session. */
  freeTable: token("C", "D"),
  /** P1, Private Room, open bill: session with a bill and splits. */
  privateRoom: token("E", "F"),
  /** W01, WFC Corner, open bill: waiting for waiter confirmation. */
  wfc: token("G", "H"),
} as const;
export const qrTokenTableCodes: Record<string, string> = {
  [qrTokenFixtures.indoor]: "A03",
  [qrTokenFixtures.freeTable]: "A01",
  [qrTokenFixtures.privateRoom]: "P1",
  [qrTokenFixtures.wfc]: "W01",
};

type ItemOverlay = {
  description?: string;
  labels?: string[];
  allergens?: string[];
};
// Illustrative content for the sample outlet; the owner's real menu replaces it.
const itemOverlays: Record<string, ItemOverlay> = {
  Espresso: { description: "Satu shot espresso pekat dengan crema tebal." },
  "Kopi Susu Aren": {
    description: "Espresso, susu segar, dan gula aren cair.",
    labels: ["terlaris"],
    allergens: ["susu"],
  },
  "Cafe Latte": {
    description: "Espresso dengan susu steamed yang lembut.",
    allergens: ["susu"],
  },
  Cappuccino: {
    description: "Espresso, susu steamed, dan busa tebal.",
    allergens: ["susu"],
  },
  "Cold Brew": {
    description: "Diseduh dingin 16 jam, ringan dan manis alami.",
    labels: ["baru"],
  },
  "Matcha Latte": {
    description: "Matcha dengan susu, disajikan panas atau dingin.",
    labels: ["baru"],
    allergens: ["susu"],
  },
  "Nasi Goreng Kampung": {
    description: "Nasi goreng bumbu kampung, telur mata sapi, acar.",
    labels: ["terlaris"],
    allergens: ["telur"],
  },
  "Ayam Sambal Matah": {
    description: "Ayam goreng dengan sambal matah segar dan nasi hangat.",
    labels: ["pedas"],
  },
  "Ayam Geprek": {
    description: "Ayam krispi digeprek dengan sambal bawang.",
    labels: ["pedas", "terlaris"],
  },
  "Mie Goreng Jawa": {
    description: "Mie goreng bumbu manis gurih khas Jawa.",
    allergens: ["gluten", "telur"],
  },
  "Pasta Carbonara": {
    description: "Fettuccine, saus krim, telur, dan smoked beef.",
    allergens: ["gluten", "susu", "telur"],
  },
  "Burger Sapi": {
    description: "Patty sapi, keju, selada, dan saus rumah.",
    allergens: ["gluten", "susu"],
  },
  "Sate Ayam": {
    description: "Sepuluh tusuk dengan bumbu kacang.",
    allergens: ["kacang"],
  },
  "Kentang Goreng": { labels: ["vegetarian"] },
  "Salad Sayur": { labels: ["vegetarian"] },
  "Croissant Mentega": {
    description: "Croissant renyah berlapis mentega, dipanggang pagi ini.",
    labels: ["terlaris"],
    allergens: ["gluten", "susu"],
  },
  "Banana Bread": { labels: ["vegetarian"], allergens: ["gluten", "telur"] },
  Brownies: { allergens: ["gluten", "telur", "kacang"] },
  Cheesecake: { allergens: ["susu", "telur", "gluten"] },
  "Pie Apel": { labels: ["baru", "vegetarian"], allergens: ["gluten"] },
};
/** Sold out in the sample menu so every state is visible (ORD-05). */
const soldOutNames = new Set(["Sup Buntut", "Cheesecake"]);

const SUGAR_GROUP = fixtureId(4100);
const TOPPING_GROUP = fixtureId(4401);
const SPICE_GROUP = fixtureId(4402);
const spiceNames = new Set([
  "Nasi Goreng Kampung",
  "Nasi Goreng Ayam",
  "Mie Goreng Jawa",
  "Ayam Sambal Matah",
  "Ayam Geprek",
]);

function modifierGroupsFor(
  categoryName: string,
  itemName: string,
): z.input<typeof qrMenuModifierGroupSchema>[] {
  const sugarBase = cafeLegendMenuFixtures.modifierGroups.find(
    (group) => group.id === SUGAR_GROUP,
  );
  const normal = cafeLegendMenuFixtures.modifiers.find(
    (modifier) => modifier.groupId === SUGAR_GROUP,
  );
  if (!sugarBase || !normal) throw new RangeError("Missing sugar fixtures");
  const sugar: z.input<typeof qrMenuModifierGroupSchema> = {
    id: sugarBase.id,
    name: sugarBase.name,
    minSelect: sugarBase.minSelect,
    maxSelect: sugarBase.maxSelect,
    modifiers: [
      {
        id: normal.id,
        name: normal.name,
        priceIdr: normal.priceIdr,
        soldOut: false,
      },
      {
        id: fixtureId(4201),
        name: "Kurang manis",
        priceIdr: 0,
        soldOut: false,
      },
      { id: fixtureId(4202), name: "Tanpa gula", priceIdr: 0, soldOut: false },
    ],
  };
  const topping: z.input<typeof qrMenuModifierGroupSchema> = {
    id: TOPPING_GROUP,
    name: "Tambahan",
    minSelect: 0,
    maxSelect: 2,
    modifiers: [
      {
        id: fixtureId(4411),
        name: "Extra shot",
        priceIdr: 6000,
        soldOut: false,
      },
      { id: fixtureId(4412), name: "Boba", priceIdr: 5000, soldOut: false },
      {
        id: fixtureId(4413),
        name: "Cheese foam",
        priceIdr: 8000,
        soldOut: true,
      },
    ],
  };
  const spice: z.input<typeof qrMenuModifierGroupSchema> = {
    id: SPICE_GROUP,
    name: "Level pedas",
    minSelect: 1,
    maxSelect: 1,
    modifiers: [
      { id: fixtureId(4421), name: "Tidak pedas", priceIdr: 0, soldOut: false },
      { id: fixtureId(4422), name: "Sedang", priceIdr: 0, soldOut: false },
      { id: fixtureId(4423), name: "Pedas", priceIdr: 0, soldOut: false },
    ],
  };
  if (categoryName === "Kopi") return [sugar, topping];
  if (categoryName === "Nonkopi" && /Tea|Latte|Cokelat/.test(itemName))
    return [sugar];
  if (spiceNames.has(itemName)) return [spice];
  return [];
}

function parseHm(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

/** Zone hours in the outlet's wall clock (fixture clock is UTC+7, Asia/Jakarta). */
function zoneIsOpen(zone: FloorZone, at: Date): boolean {
  const local = new Date(at.getTime() + 7 * 3_600_000);
  const day = local.getUTCDay();
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  return zone.hours.some(
    (hours) =>
      hours.daysOfWeek.includes(day) &&
      minutes >= parseHm(hours.start) &&
      minutes < parseHm(hours.end),
  );
}

/**
 * Builds the public menu read model of one table from the menu contract
 * fixtures: channel prices, availability, and the presentation overlays above.
 */
export function buildQrMenu(input: {
  table: Pick<Table, "id" | "code" | "capacity">;
  zone: FloorZone;
  at?: Date;
}): QrMenu {
  const menu = cafeLegendMenuFixtures;
  const { brand, outlets } = cafeLegendFixtures;
  const outlet = outlets[0];
  const priceOf = (itemId: string) => {
    const row = menu.priceListItems.find(
      (entry) => entry.itemId === itemId && entry.variantId === null,
    );
    if (!row) throw new RangeError(`No channel price for item ${itemId}`);
    return row.priceIdr;
  };
  const items = menu.items
    .filter((item) => item.isActive)
    .map((item, index) => {
      const category = menu.categories.find(
        (entry) => entry.id === item.categoryId,
      );
      if (!category) throw new RangeError(`Unknown category for ${item.name}`);
      const overlay = itemOverlays[item.name] ?? {};
      const base = priceOf(item.id);
      const fixtureVariant = menu.variants.find(
        (variant) => variant.menuItemId === item.id,
      );
      const variants =
        category.name === "Kopi" && item.type === "single"
          ? [
              {
                id: fixtureVariant?.id ?? fixtureId(4500 + index * 2),
                name: "Panas",
                priceIdr: idr(base),
              },
              {
                id: fixtureId(4501 + index * 2),
                name: "Dingin",
                priceIdr: idr(base + 3000),
              },
            ]
          : [];
      const availability = menu.availability.find(
        (entry) => entry.menuItemId === item.id,
      );
      const soldOut =
        availability?.status === "sold_out" || soldOutNames.has(item.name);
      return {
        id: item.id,
        categoryId: item.categoryId,
        name: item.name,
        description: overlay.description ?? item.description,
        type: item.type,
        priceIdr: idr(base),
        labels: overlay.labels ?? item.labels,
        allergens: overlay.allergens ?? item.allergens,
        photoUrl: null,
        variants,
        modifierGroups: modifierGroupsFor(category.name, item.name),
        status: soldOut ? ("sold_out" as const) : ("available" as const),
        sortOrder: item.sortOrder,
      };
    });
  const taxRule = qrOrderFixtures.quotes[0].taxLines[0];
  return qrMenuSchema.parse({
    brand,
    outlet,
    table: {
      id: input.table.id,
      code: input.table.code,
      capacity: input.table.capacity,
    },
    zone: {
      id: input.zone.id,
      name: input.zone.name,
      paymentMode: input.zone.paymentMode,
      serviceChargeBp: input.zone.serviceChargeBp,
      minimumSpendIdr: input.zone.minimumSpendIdr,
    },
    orderingOpen: zoneIsOpen(
      input.zone,
      input.at ?? new Date("2026-11-02T03:10:00.000Z"),
    ),
    pricing: {
      pricesIncludeTaxAndService: false,
      serviceChargeBp: input.zone.serviceChargeBp,
      taxes: [{ name: taxRule.name, rateBp: taxRule.rateBp }],
    },
    categories: menu.categories
      .map((category) => ({
        id: category.id,
        name: category.name,
        sortOrder: category.sortOrder,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder),
    items,
    menuUpdatedAt: "2026-11-01T05:00:00.000Z",
  });
}

function tableByCode(code: string): Table {
  const table = qrOrderFixtures.tables.find((entry) => entry.code === code);
  if (!table) throw new RangeError(`Unknown table fixture: ${code}`);
  return table;
}

export const qrMenuFixtures = {
  indoor: buildQrMenu({
    table: tableByCode("A03"),
    zone: qrOrderFixtures.zones[0],
  }),
};

/** The open failed-item issue of the private-room order, as the guest sees it. */
const failedOrderItem = qrOrderFixtures.orders[0].items[1];
const swapTarget = cafeLegendMenuFixtures.items.find(
  (item) => item.name === "Mie Goreng Jawa",
);
if (!swapTarget) throw new RangeError("Missing swap fixture item");
const swapPrice =
  cafeLegendMenuFixtures.priceListItems.find(
    (row) => row.itemId === swapTarget.id,
  )?.priceIdr ?? 0;

export const guestOrderIssueFixtures: GuestOrderIssue[] = [
  guestOrderIssueSchema.parse({
    id: qrOrderFixtures.orderIssues[0].id,
    orderId: qrOrderFixtures.orders[0].id,
    orderItemId: failedOrderItem.id,
    itemName: failedOrderItem.name,
    quantity: failedOrderItem.quantity,
    lineTotalIdr: failedOrderItem.lineTotalIdr,
    type: "unfulfillable",
    status: "open",
    options: {
      swap: {
        allowed: true,
        items: [
          {
            menuItemId: swapTarget.id,
            name: swapTarget.name,
            priceIdr: swapPrice,
            differenceIdr: idr(swapPrice - failedOrderItem.lineTotalIdr),
          },
        ],
      },
      voucher: { allowed: true, valueIdr: failedOrderItem.lineTotalIdr },
    },
    resolution: null,
    replacementItemName: null,
    priceDifferenceIdr: null,
    voucher: null,
    createdAt: qrOrderFixtures.orderIssues[0].createdAt,
    resolvedAt: null,
  }),
];

export const pointClaimFixture: PointClaim = pointClaimSchema.parse({
  sessionId: qrOrderFixtures.sessions[1].id,
  status: "available",
  paidIdr: qrOrderFixtures.sessionBills[0].totals.paidIdr,
  points: 28,
  claimableUntil: "2026-11-02T05:10:00.000Z",
  requiresLogin: false,
});
