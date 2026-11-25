// Static demo data behind the ordering mock (beads legend-59v, legend-76t).
// Names and prices follow the approved mockups (design/mockups/pos): the
// cashier menu, the A01-A08 tables of the captain and the A03 waiter call. The
// mock engine (./mock-engine.ts) is the only reader.
//
// Plain TypeScript: Node tests load it directly.
import type {
  CaptainTable,
  Catalog,
  Course,
  MenuCategory,
  MenuItem,
  ModifierGroup,
  OrderLine,
  ServiceCall,
} from "./types.ts";

/** The demo day, 8 November 2026. WIB is UTC+7, so 07:08Z is 14.08 local. */
export const DEMO_BUSINESS_DATE = "2026-11-08";
/** The cached catalog of the offline demo is this old, so "sejak ..." stays true next to "Sinkron terakhir". */
export const OFFLINE_CATALOG_AGE_MS = 25 * 60 * 1000;
/** Next takeaway call number of the demo: "A-12". */
export const FIRST_CALL_NUMBER = 12;
export const CALL_NUMBER_PREFIX = "A-";
/** First order number made by the mock; the demo bill of table A01 is POS-0051. */
export const FIRST_ORDER_SEQUENCE = 52;
export const MAX_ORDER_LINES = 99;

export const courses = {
  one: { id: "course-1", label: "Course 1", order: 1 },
  two: { id: "course-2", label: "Course 2", order: 2 },
  drink: { id: "course-drink", label: "Minuman", order: 3 },
} satisfies Record<string, Course>;

export const categories: MenuCategory[] = [
  { id: "cat-makanan", name: "Makanan" },
  { id: "cat-minuman", name: "Minuman" },
  { id: "cat-camilan", name: "Camilan" },
];

const spiceLevel: ModifierGroup = {
  id: "grp-pedas",
  name: "Tingkat pedas",
  required: true,
  min: 1,
  max: 1,
  options: [
    { id: "opt-tidak-pedas", name: "Tidak pedas", priceDeltaIdr: 0 },
    { id: "opt-pedas-sedang", name: "Pedas sedang", priceDeltaIdr: 0 },
    { id: "opt-pedas", name: "Pedas", priceDeltaIdr: 0 },
  ],
};

const geprekExtras: ModifierGroup = {
  id: "grp-tambahan-geprek",
  name: "Tambahan",
  required: false,
  min: 0,
  max: 2,
  options: [
    { id: "opt-telur", name: "Telur dadar", priceDeltaIdr: 5000 },
    { id: "opt-keju", name: "Keju", priceDeltaIdr: 6000 },
  ],
};

const coffeeExtras: ModifierGroup = {
  id: "grp-tambahan-kopi",
  name: "Tambahan",
  required: false,
  min: 0,
  max: 1,
  options: [{ id: "opt-extra-shot", name: "Extra shot", priceDeltaIdr: 6000 }],
};

const category = (id: string) =>
  categories.find((entry) => entry.id === id) as MenuCategory;

function item(
  id: string,
  name: string,
  categoryId: string,
  priceIdr: number,
  course: Course,
  extra: Partial<MenuItem> = {},
): MenuItem {
  return {
    id,
    name,
    categoryId,
    categoryName: category(categoryId).name,
    priceIdr,
    imageUrl: null,
    soldOut: false,
    code: null,
    course,
    variants: [],
    modifierGroups: [],
    ...extra,
  };
}

export const menuItems: MenuItem[] = [
  item(
    "menu-nasi-goreng",
    "Nasi goreng kampung",
    "cat-makanan",
    38000,
    courses.two,
    {
      code: "NGK",
      modifierGroups: [spiceLevel],
    },
  ),
  item("menu-ayam-geprek", "Ayam geprek", "cat-makanan", 42000, courses.two, {
    code: "AGP",
    modifierGroups: [geprekExtras],
  }),
  item("menu-sate-ayam", "Sate ayam", "cat-makanan", 40000, courses.two, {
    code: "SAT",
    soldOut: true,
  }),
  item("menu-es-teh", "Es teh manis", "cat-minuman", 12000, courses.drink, {
    code: "ETM",
  }),
  item("menu-kopi-susu", "Kopi susu", "cat-minuman", 24000, courses.drink, {
    code: "KPS",
    modifierGroups: [coffeeExtras],
  }),
  item(
    "menu-kentang-goreng",
    "Kentang goreng",
    "cat-camilan",
    25000,
    courses.one,
    {
      code: "KTG",
    },
  ),
];

/**
 * Photo name per demo item as the shared demo photo map spells it. ./api.ts
 * resolves it (mock mode only), so no sample path enters a normal build.
 */
export const DEMO_PHOTO_NAMES: Record<string, string> = {
  "menu-nasi-goreng": "Nasi Goreng Kampung",
  "menu-ayam-geprek": "Ayam Geprek",
  "menu-sate-ayam": "Sate Ayam",
  "menu-es-teh": "Teh Tarik",
  "menu-kopi-susu": "Kopi Susu Aren",
  "menu-kentang-goreng": "Kentang Goreng",
};

export function liveCatalog(nowIso: string): Catalog {
  return {
    categories: categories.map((entry) => ({ ...entry })),
    items: menuItems.map((entry) => structuredClone(entry)),
    updatedAt: nowIso,
    source: "live",
  };
}

export function cachedCatalog(now: Date = new Date()): Catalog {
  const cachedAt = new Date(now.getTime() - OFFLINE_CATALOG_AGE_MS);
  return { ...liveCatalog(cachedAt.toISOString()), source: "cached" };
}

export function emptyCatalog(nowIso: string): Catalog {
  return { categories: [], items: [], updatedAt: nowIso, source: "live" };
}

// ---- Captain tables ----------------------------------------------------------

const ZONE = "Zona dalam";

function table(
  label: string,
  seats: number,
  extra: Partial<CaptainTable> = {},
): CaptainTable {
  return {
    id: `table-${label.toLowerCase()}`,
    label,
    zone: ZONE,
    status: "empty",
    guestCount: 0,
    seats,
    qrSessionActive: false,
    sessionId: null,
    hasOpenCall: false,
    hold: null,
    ...extra,
  };
}

/** A01 occupied with an active QR session, A02 empty, only A03 has an open call. */
export function demoTables(): CaptainTable[] {
  return [
    table("A01", 4, {
      status: "occupied",
      guestCount: 4,
      qrSessionActive: true,
      sessionId: "session-a01",
    }),
    table("A02", 4),
    table("A03", 4, { status: "occupied", guestCount: 2, hasOpenCall: true }),
    table("A04", 2, {
      status: "occupied",
      guestCount: 2,
      qrSessionActive: true,
      sessionId: "session-a04",
    }),
    table("A05", 2),
    table("A06", 4),
    table("A07", 6),
    table("A08", 4),
  ];
}

/** A03: "Minta alat makan" 14.32 (new). A01: "Minta tagihan" 14.26 (accepted). */
export function demoCalls(): ServiceCall[] {
  return [
    {
      id: "call-a03-alat-makan",
      tableId: "table-a03",
      tableLabel: "A03",
      type: "call_waiter",
      reason: "Minta alat makan",
      createdAt: "2026-11-08T07:32:00.000Z",
      status: "new",
    },
    {
      id: "call-a01-tagihan",
      tableId: "table-a01",
      tableLabel: "A01",
      type: "request_bill",
      reason: "Minta tagihan",
      createdAt: "2026-11-08T07:26:00.000Z",
      status: "acknowledged",
    },
  ];
}

/** Table A01 already ordered: one sent, one held (the "held" mockup). */
export function demoA01Lines(): OrderLine[] {
  return [
    {
      lineId: "line-a01-1",
      menuItemId: "menu-nasi-goreng",
      name: "Nasi goreng kampung",
      unitPriceIdr: 38000,
      quantity: 1,
      modifiers: [
        {
          groupId: "grp-pedas",
          optionId: "opt-tidak-pedas",
          name: "Tidak pedas",
          priceDeltaIdr: 0,
        },
      ],
      note: "",
      course: courses.two,
      status: "sent",
    },
    {
      lineId: "line-a01-2",
      menuItemId: "menu-es-teh",
      name: "Es teh manis",
      unitPriceIdr: 12000,
      quantity: 1,
      modifiers: [],
      note: "",
      course: courses.drink,
      status: "held",
    },
  ];
}
