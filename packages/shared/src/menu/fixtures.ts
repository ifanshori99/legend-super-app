import { cafeLegendFixtures } from "../core/index.ts";
import {
  menuFixtureSchema,
  menuItemSchema,
  priceListItemSchema,
} from "./schemas.ts";
import type { MenuItem, PriceListItem } from "./schemas.ts";

// Illustrative mock catalog; not the owner's confirmed menu or prices. Prices
// are exclusive of tax and service charge (owner decision 2026-11-01): the WS-05
// tax engine adds both at checkout (QR web + POS).
const { tenant, brand, outlets } = cafeLegendFixtures;
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = (n: number) => ({ id: id(n), tenantId: tenant.id });
const groups = [
  [
    "Kopi",
    "Espresso|Americano|Cappuccino|Cafe Latte|Kopi Susu Aren|Flat White|Mocha|Caramel Latte|Vanilla Latte|Cold Brew|Kopi Tubruk|Vietnam Drip|Affogato|Piccolo|Long Black",
  ],
  [
    "Nonkopi",
    "Cokelat Panas|Es Cokelat|Matcha Latte|Taro Latte|Red Velvet Latte|Teh Tarik|Lemon Tea|Lychee Tea|Peach Tea|Thai Tea|Air Mineral|Jus Jeruk|Jus Alpukat|Jus Mangga|Soda Leci",
  ],
  [
    "Dapur",
    "Nasi Goreng Kampung|Nasi Goreng Ayam|Mie Goreng Jawa|Mie Kuah|Ayam Sambal Matah|Ayam Geprek|Rice Bowl Teriyaki|Soto Ayam|Sup Buntut|Sate Ayam|Pasta Aglio Olio|Pasta Carbonara|Burger Sapi|Kentang Goreng|Salad Sayur",
  ],
  [
    "Pastry",
    "Croissant Mentega|Croissant Cokelat|Roti Bakar Cokelat|Roti Bakar Keju|Banana Bread|Brownies|Cheesecake|Tiramisu|Donat Gula|Donat Cokelat|Muffin Pisang|Muffin Cokelat|Kue Wortel|Cookies Cokelat|Pie Apel",
  ],
] as const;
// legend-lgyfh: demo breakfast menu. A few morning dishes carry the flag so the
// demo outlet opts in to the flagged breakfast menu; the rest stay unflagged.
const breakfastNames = new Set([
  "Nasi Goreng Kampung",
  "Nasi Goreng Ayam",
  "Roti Bakar Cokelat",
  "Roti Bakar Keju",
  "Croissant Mentega",
]);
const categories = groups.map(([name], i) => ({
  ...base(100 + i),
  brandId: brand.id,
  name,
  parentId: null,
  sortOrder: i,
}));
const stationBase = {
  printerDeviceId: null,
  targetSeconds: 600,
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const stations = [
  ...groups.map(([name], i) => ({
    ...base(200 + i),
    outletId: outlets[0].id,
    name,
    type: (["coffee_bar", "beverage_bar", "hot_kitchen", "pastry"] as const)[i],
    ...stationBase,
  })),
  // Extra station (id 205, outlet 2) so every access fixture station (bead
  // legend-7art) exists here with the same id and outlet. Items only use 200-203.
  {
    ...base(205),
    outletId: outlets[1].id,
    name: "Kopi",
    type: "coffee_bar" as const,
    ...stationBase,
  },
];
const items: MenuItem[] = groups.flatMap(([, names], group) =>
  names.split("|").map((name, i) => ({
    ...base(1000 + group * 100 + i),
    brandId: brand.id,
    categoryId: categories[group].id,
    name,
    description: `Pilihan ${name} khas Cafe Legend`,
    type: "single" as const,
    stationId: stations[group].id,
    stationType: stations[group].type,
    course: group < 2 ? "drink" : group === 2 ? "main" : "dessert",
    recipeId: null,
    taxRuleId: null,
    labels: [],
    allergens: [],
    mediaId: null,
    isActive: true,
    isBreakfast: breakfastNames.has(name),
    sortOrder: i,
  })),
);
const comboItem = {
  ...items[0],
  ...base(2000),
  name: "Paket Kopi dan Croissant",
  type: "combo" as const,
};
items.push(comboItem);
const priceList = {
  ...base(3000),
  outletId: outlets[0].id,
  channel: "dine_in" as const,
  effectiveFrom: "2026-11-01",
};
export const cafeLegendMenuFixtures = menuFixtureSchema.parse({
  categories,
  stations,
  items,
  variants: [
    { ...base(4000), menuItemId: items[0].id, name: "Panas", recipeId: null },
  ],
  modifierGroups: [
    { ...base(4100), name: "Tingkat gula", minSelect: 1, maxSelect: 1 },
  ],
  modifiers: [
    {
      ...base(4200),
      groupId: id(4100),
      name: "Normal",
      priceIdr: 0,
      recipeId: null,
      stationId: stations[0].id,
    },
  ],
  // Two drinks carry the sugar-level group (the back-office demo link).
  itemModifierGroups: [
    { itemId: items[0].id, groupId: id(4100), sortOrder: 0 },
    { itemId: items[4].id, groupId: id(4100), sortOrder: 0 },
  ],
  combos: [
    {
      ...base(4300),
      comboItemId: comboItem.id,
      components: [
        { menuItemId: items[0].id, options: [], revenueAllocationBp: 6000 },
        { menuItemId: items[45].id, options: [], revenueAllocationBp: 4000 },
      ],
    },
  ],
  priceLists: [priceList],
  priceListItems: items.map((item, i) => ({
    ...base(5000 + i),
    priceListId: priceList.id,
    itemId: item.id,
    variantId: null,
    priceIdr: 20000 + (i % 10) * 3000,
  })),
  availability: items.map((item, i) => ({
    ...base(6000 + i),
    outletId: outlets[0].id,
    menuItemId: item.id,
    schedule: [],
    dailyLimit: null,
    soldOutUntil: null,
    status: "available",
  })),
  importRows: [
    {
      category: "Kopi",
      name: "Espresso",
      description: "Espresso",
      type: "single",
      priceIdr: 20000,
      station: "Kopi",
      course: "drink",
      labels: [],
      allergens: [],
    },
  ],
});

/**
 * legend-qf0i (owner Q23): a row created before the photo rule. It is active
 * and has no `mediaId`, so the back office must keep listing it with the
 * "Foto wajib" badge while every guest read hides it.
 *
 * Deliberately NOT part of `cafeLegendMenuFixtures`: the demo catalogue gives
 * every item a photo (legend-4pki), so this legacy row is only injected by the
 * mock `?mock=photo-missing` scenario and by the API tests.
 */
export const legacyPhotoMissingItem: MenuItem = menuItemSchema.parse({
  ...base(7900),
  brandId: brand.id,
  categoryId: categories[0].id,
  name: "Es Kopi Legacy",
  description: "Item lama tanpa foto dari sebelum aturan Q23.",
  type: "single",
  stationId: stations[0].id,
  stationType: stations[0].type,
  course: "drink",
  recipeId: null,
  taxRuleId: null,
  labels: [],
  allergens: [],
  mediaId: null,
  isActive: true,
  isBreakfast: false,
  sortOrder: 90,
});

/** legend-qf0i: the legacy row is sellable, so it has a channel price. */
export const legacyPhotoMissingPrice: PriceListItem = priceListItemSchema.parse(
  {
    ...base(7901),
    priceListId: priceList.id,
    itemId: legacyPhotoMissingItem.id,
    variantId: null,
    priceIdr: 18000,
  },
);
