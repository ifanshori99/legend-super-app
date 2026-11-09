// Sample QR guest content (token fixtures, the illustrative Cafe Legend menu,
// the failed-item issue and the point claim). Lives behind its own subpath,
// `@starter/shared/qr-order/sample`, so the `@starter/shared/qr-order` barrel
// does not build the 61-item sample menu when it loads (bead legend-33uj).
// Mocks, fixtures and tests import from here; production code does not.
import { z, idr } from "../core/index.ts";
import { cafeLegendFixtures } from "../core/index.ts";
import { cafeLegendMenuFixtures } from "../menu/index.ts";
import {
  guestOrderIssueSchema,
  pointClaimSchema,
  qrMenuSchema,
  type GuestOrderIssue,
  type PointClaim,
  type QrMenu,
  qrMenuModifierGroupSchema,
} from "./guest.ts";
import type { FloorZone, Table } from "./schemas.ts";
import { qrOrderFixtures } from "./fixtures.ts";

export * from "./fixtures.ts";

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
/**
 * Sold out in the sample menu so every state is visible (ORD-05). Mie Kuah is
 * sold out too because it has a demo photo: the customer card shows the greyed
 * photo state, which an item without a photo could not demonstrate.
 */
const soldOutNames = new Set(["Sup Buntut", "Cheesecake", "Mie Kuah"]);

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
 *
 * `photoFor` is the mock/demo seam: the sample catalogue has no uploaded media,
 * so the demo layer supplies its Unsplash samples by item name (owner Q17/Q24).
 * A real build passes nothing and every item keeps the designed missing-photo
 * state (`MediaPlate missing="quiet"`) until its upload exists (owner Q23).
 */
export function buildQrMenu(
  input: {
    table: Pick<Table, "id" | "code" | "capacity">;
    zone: FloorZone;
    at?: Date;
  },
  options: { photoFor?: (itemName: string) => string | null } = {},
): QrMenu {
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
        photoUrl: options.photoFor?.(item.name) ?? null,
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

/**
 * Q23 (legend-qf0i): the guest copy of a menu never carries an active item
 * without a photo. The API drops those rows in SQL (`guestMenuItemCondition`);
 * a mock built from fixtures applies the same rule on the resolved read model,
 * so the demo shows exactly what a guest would see once an outlet has a legacy
 * row. Categories are kept: they are navigation, and the contract allows a
 * category with no visible item.
 */
export function hidePhotoLessMenuItems(menu: QrMenu): QrMenu {
  return {
    ...menu,
    items: menu.items.filter((item) => item.photoUrl !== null),
  };
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
