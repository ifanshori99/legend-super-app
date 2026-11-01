// Cafe Legend inventory fixtures for FE mock mode and contract tests (bead
// legend-p38). Realistic but illustrative: one active outlet has six storage
// locations and an opening stock, one day of sales/production/waste, and two
// stock counts. Menu names and prices come from the menu contract fixtures so
// the HPP rows point at real menu items.
//
// The balances are NOT hand-written: they are folded from the ledger with the
// moving-average rule (INV-01, PRD §16), which also keeps the fixture
// internally consistent. The HPP rows are computed from those unit costs
// (INV-04, PRD §17), so changing a receipt cost moves the menu cost too.

import {
  cafeLegendFixtures,
  decimal4,
  divideRounded,
  formatDecimal4,
  idr,
  parseDecimal4,
} from "../core/index.ts";
import type { Decimal4, Idr } from "../core/index.ts";
import { cafeLegendMenuFixtures } from "../menu/index.ts";
import {
  foldStockLedger,
  grossMarginBp,
  inventoryItemAlternateSchema,
  inventoryItemSchema,
  menuCostSchema,
  menuEngineeringRowSchema,
  parLevelSchema,
  productionOrderSchema,
  recipeCoverageRowSchema,
  recipeLineSchema,
  recipeSchema,
  stockBatchSchema,
  stockBalanceSchema,
  stockCountDetailSchema,
  stockCountLineSchema,
  stockCountSchema,
  stockCountVarianceIdr,
  stockLedgerEntrySchema,
  stockLocationSchema,
  stockTransferSchema,
  theoreticalRecipeCost,
  uomConversionSchema,
  uomSchema,
  wasteLogSchema,
  foodCostComparisonSchema,
  type InventoryItem,
  type InventoryItemType,
  type Recipe,
  type RecipeCost,
  type RecipeLine,
  type StockCountDetail,
  type StockMovementType,
  type StockSourceType,
} from "./schemas.ts";
import { z } from "../core/index.ts";

const { tenant, brand, outlets } = cafeLegendFixtures;
const outletId = outlets[0].id;
const snapshotAt = "2026-11-01T09:30:00.000Z";
const businessDate = "2026-11-01";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Time-ordered ids: 24 fixed characters plus two Crockford characters.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let ledgerSequence = 0;
const nextLedgerId = () => {
  const value = ledgerSequence++;
  return `01JBQ7Z8K0A1B2C3D4E5F6G7${CROCKFORD[Math.floor(value / 32) % 32]}${CROCKFORD[value % 32]}`;
};
const docId = (n: number) =>
  `01JBQ7Z8K0A1B2C3D4E5F6H0${CROCKFORD[Math.floor(n / 32) % 32]}${CROCKFORD[n % 32]}`;

const uom = {
  kg: id(7001),
  g: id(7002),
  l: id(7003),
  ml: id(7004),
  pcs: id(7005),
  pack: id(7006),
} as const;
const item = {
  kopi: id(7101),
  susu: id(7102),
  gulaArenCair: id(7103),
  sirupVanila: id(7104),
  cokelat: id(7105),
  matcha: id(7106),
  ayam: id(7107),
  beras: id(7108),
  telur: id(7109),
  minyak: id(7110),
  kentang: id(7111),
  tepung: id(7112),
  mentega: id(7113),
  keju: id(7114),
  esBatu: id(7115),
  airMineral: id(7116),
  cup: id(7117),
  sedotan: id(7118),
  coldBrew: id(7119),
  gulaAren: id(7120),
  kopiToraja: id(7121),
} as const;
const location = {
  gudang: id(7201),
  chiller: id(7202),
  freezer: id(7203),
  bar: id(7204),
  dapur: id(7205),
  pastry: id(7206),
} as const;
const recipeIds = {
  kopiSusu: id(7601),
  coldBrew: id(7602),
  nasiGoreng: id(7603),
  sirupGulaAren: id(7604),
  coldBrewConcentrate: id(7605),
  esCokelat: id(7606),
} as const;
const countIds = { pending: id(7801), posted: id(7802) } as const;
const wasteIds = { susu: id(7901) } as const;
const productionIds = { coldBrew: id(7951), sirup: id(7961) } as const;
const users = { barista: id(7501), manager: id(7502) } as const;

// ---- Units and locations --------------------------------------------------

const uoms = [
  { id: uom.kg, code: "kg", name: "Kilogram" },
  { id: uom.g, code: "g", name: "Gram" },
  { id: uom.l, code: "l", name: "Liter" },
  { id: uom.ml, code: "ml", name: "Mililiter" },
  { id: uom.pcs, code: "pcs", name: "Pieces" },
  { id: uom.pack, code: "pack", name: "Pack" },
].map((row) => uomSchema.parse({ ...row, tenantId: tenant.id }));

const locations = [
  { id: location.gudang, name: "Gudang Utama", type: "warehouse" },
  { id: location.chiller, name: "Chiller Bar", type: "chiller" },
  { id: location.freezer, name: "Freezer Dapur", type: "freezer" },
  { id: location.bar, name: "Bar", type: "bar" },
  { id: location.dapur, name: "Dapur", type: "kitchen" },
  { id: location.pastry, name: "Pastry", type: "pastry" },
].map((row) =>
  stockLocationSchema.parse({
    ...row,
    tenantId: tenant.id,
    outletId,
    isActive: true,
  }),
);

// ---- Items, alternates and UOM conversions -------------------------------

type ItemSeed = {
  id: string;
  name: string;
  category: string;
  type: InventoryItemType;
  baseUomId: string;
  isPerishable: boolean;
  parMin?: string;
  parMax?: string;
};

const itemSeeds: ItemSeed[] = [
  {
    id: item.kopi,
    name: "Kopi Arabika Gayo",
    category: "Kopi & Teh",
    type: "raw_material",
    baseUomId: uom.kg,
    isPerishable: false,
  },
  {
    id: item.susu,
    name: "Susu UHT Full Cream",
    category: "Susu & Dairy",
    type: "raw_material",
    baseUomId: uom.l,
    isPerishable: true,
    parMin: "20.0000",
    parMax: "60.0000",
  },
  {
    id: item.gulaArenCair,
    name: "Gula Aren Cair",
    category: "Semi-finished",
    type: "semi_finished",
    baseUomId: uom.l,
    isPerishable: true,
  },
  {
    id: item.sirupVanila,
    name: "Sirup Vanila",
    category: "Sirup & Gula",
    type: "raw_material",
    baseUomId: uom.l,
    isPerishable: false,
  },
  {
    id: item.cokelat,
    name: "Cokelat Bubuk",
    category: "Bahan Kering",
    type: "raw_material",
    baseUomId: uom.kg,
    isPerishable: false,
  },
  {
    id: item.matcha,
    name: "Matcha Powder",
    category: "Bahan Kering",
    type: "raw_material",
    baseUomId: uom.kg,
    isPerishable: false,
  },
  {
    id: item.ayam,
    name: "Ayam Fillet",
    category: "Protein",
    type: "raw_material",
    baseUomId: uom.kg,
    isPerishable: true,
  },
  {
    id: item.beras,
    name: "Beras Pandan Wangi",
    category: "Bahan Kering",
    type: "raw_material",
    baseUomId: uom.kg,
    isPerishable: false,
  },
  {
    id: item.telur,
    name: "Telur Ayam",
    category: "Protein",
    type: "raw_material",
    baseUomId: uom.kg,
    isPerishable: true,
  },
  {
    id: item.minyak,
    name: "Minyak Goreng",
    category: "Bahan Kering",
    type: "raw_material",
    baseUomId: uom.l,
    isPerishable: false,
  },
  {
    id: item.kentang,
    name: "Kentang",
    category: "Sayur & Buah",
    type: "raw_material",
    baseUomId: uom.kg,
    isPerishable: true,
  },
  {
    id: item.tepung,
    name: "Tepung Terigu",
    category: "Bahan Kering",
    type: "raw_material",
    baseUomId: uom.kg,
    isPerishable: false,
  },
  {
    id: item.mentega,
    name: "Mentega Tawar",
    category: "Susu & Dairy",
    type: "raw_material",
    baseUomId: uom.kg,
    isPerishable: true,
  },
  {
    id: item.keju,
    name: "Keju Cheddar",
    category: "Susu & Dairy",
    type: "raw_material",
    baseUomId: uom.kg,
    isPerishable: true,
  },
  {
    id: item.esBatu,
    name: "Es Batu",
    category: "Bahan Kering",
    type: "raw_material",
    baseUomId: uom.kg,
    isPerishable: false,
  },
  {
    id: item.airMineral,
    name: "Air Mineral",
    category: "Bahan Kering",
    type: "raw_material",
    baseUomId: uom.l,
    isPerishable: false,
  },
  {
    id: item.cup,
    name: "Cup 16oz",
    category: "Kemasan",
    type: "raw_material",
    baseUomId: uom.pcs,
    isPerishable: false,
  },
  {
    id: item.sedotan,
    name: "Sedotan Kertas",
    category: "Kemasan",
    type: "raw_material",
    baseUomId: uom.pcs,
    isPerishable: false,
  },
  {
    id: item.coldBrew,
    name: "Cold Brew Concentrate",
    category: "Semi-finished",
    type: "semi_finished",
    baseUomId: uom.l,
    isPerishable: true,
  },
  {
    id: item.gulaAren,
    name: "Gula Aren",
    category: "Sirup & Gula",
    type: "raw_material",
    baseUomId: uom.kg,
    isPerishable: false,
  },
  {
    id: item.kopiToraja,
    name: "Kopi Arabika Toraja",
    category: "Kopi & Teh",
    type: "raw_material",
    baseUomId: uom.kg,
    isPerishable: false,
  },
];

const items: InventoryItem[] = itemSeeds.map((seed) =>
  inventoryItemSchema.parse({
    ...seed,
    tenantId: tenant.id,
    isActive: true,
    parMin: seed.parMin ?? null,
    parMax: seed.parMax ?? null,
    updatedAt: snapshotAt,
  }),
);

const itemAlternates = [
  inventoryItemAlternateSchema.parse({
    id: id(7960),
    tenantId: tenant.id,
    inventoryItemId: item.kopi,
    alternateItemId: item.kopiToraja,
    priority: 0,
  }),
];

const gramItems = [
  item.kopi,
  item.gulaAren,
  item.cokelat,
  item.matcha,
  item.ayam,
  item.beras,
  item.telur,
  item.kentang,
  item.tepung,
  item.mentega,
  item.keju,
  item.esBatu,
];
const millilitreItems = [
  item.susu,
  item.gulaArenCair,
  item.sirupVanila,
  item.minyak,
  item.airMineral,
  item.coldBrew,
];
const uomConversions = [
  ...gramItems.map((inventoryItemId, index) => ({
    id: id(7300 + index),
    inventoryItemId,
    fromUomId: uom.kg,
    toUomId: uom.g,
    factor: "1000.0000",
  })),
  ...millilitreItems.map((inventoryItemId, index) => ({
    id: id(7330 + index),
    inventoryItemId,
    fromUomId: uom.l,
    toUomId: uom.ml,
    factor: "1000.0000",
  })),
  {
    id: id(7360),
    inventoryItemId: item.cup,
    fromUomId: uom.pack,
    toUomId: uom.pcs,
    factor: "50.0000",
  },
  {
    id: id(7361),
    inventoryItemId: item.sedotan,
    fromUomId: uom.pack,
    toUomId: uom.pcs,
    factor: "100.0000",
  },
].map((row) => uomConversionSchema.parse({ ...row, tenantId: tenant.id }));

// ---- Batches --------------------------------------------------------------

const batchIds = {
  susuA: id(7401),
  susuB: id(7402),
  ayam: id(7403),
  keju: id(7404),
  coldBrew: id(7405),
  kopi: id(7406),
} as const;

const batches = [
  {
    id: batchIds.susuA,
    inventoryItemId: item.susu,
    locationId: location.chiller,
    batchCode: "SUSU-1101-A",
    expiresOn: "2026-11-03",
    receivedAt: "2026-11-01T00:05:00.000Z",
  },
  {
    id: batchIds.susuB,
    inventoryItemId: item.susu,
    locationId: location.chiller,
    batchCode: "SUSU-1101-B",
    expiresOn: "2026-11-08",
    receivedAt: "2026-11-01T00:05:00.000Z",
  },
  {
    id: batchIds.ayam,
    inventoryItemId: item.ayam,
    locationId: location.freezer,
    batchCode: "AYAM-1101",
    expiresOn: "2026-11-04",
    receivedAt: "2026-11-01T00:05:00.000Z",
  },
  {
    id: batchIds.keju,
    inventoryItemId: item.keju,
    locationId: location.chiller,
    batchCode: "KEJU-1101",
    expiresOn: "2026-12-15",
    receivedAt: "2026-11-01T00:05:00.000Z",
  },
  {
    id: batchIds.coldBrew,
    inventoryItemId: item.coldBrew,
    locationId: location.chiller,
    batchCode: "CB-1101",
    expiresOn: "2026-11-08",
    receivedAt: "2026-11-01T02:05:00.000Z",
  },
  {
    id: batchIds.kopi,
    inventoryItemId: item.kopi,
    locationId: location.gudang,
    batchCode: "ROAST-1101",
    expiresOn: null,
    receivedAt: "2026-11-01T00:05:00.000Z",
  },
].map((row) =>
  stockBatchSchema.parse({
    ...row,
    tenantId: tenant.id,
    outletId,
  }),
);

// ---- Ledger: one operating day -------------------------------------------

type LedgerSeed = {
  locationId: string;
  inventoryItemId: string;
  movementType: StockMovementType;
  quantity: string;
  unitCostIdr: string;
  batchId: string | null;
  sourceType: StockSourceType;
  sourceId: string;
  occurredAt: string;
};

const ledgerSeeds: LedgerSeed[] = [];
const addMovement = (seed: LedgerSeed): void => {
  ledgerSeeds.push(seed);
};

const openingStock: {
  inventoryItemId: string;
  quantity: string;
  unitCostIdr: string;
  locationId: string;
  batchId?: string;
}[] = [
  {
    inventoryItemId: item.kopi,
    quantity: "12.0000",
    unitCostIdr: "245000.0000",
    locationId: location.gudang,
    batchId: batchIds.kopi,
  },
  {
    inventoryItemId: item.susu,
    quantity: "14.0000",
    unitCostIdr: "22500.0000",
    locationId: location.chiller,
    batchId: batchIds.susuA,
  },
  {
    inventoryItemId: item.susu,
    quantity: "10.0000",
    unitCostIdr: "22500.0000",
    locationId: location.chiller,
    batchId: batchIds.susuB,
  },
  {
    inventoryItemId: item.gulaAren,
    quantity: "10.0000",
    unitCostIdr: "40000.0000",
    locationId: location.gudang,
  },
  {
    inventoryItemId: item.airMineral,
    quantity: "40.0000",
    unitCostIdr: "4000.0000",
    locationId: location.gudang,
  },
  {
    inventoryItemId: item.cup,
    quantity: "250.0000",
    unitCostIdr: "1200.0000",
    locationId: location.gudang,
  },
  {
    inventoryItemId: item.esBatu,
    quantity: "20.0000",
    unitCostIdr: "2000.0000",
    locationId: location.freezer,
  },
  {
    inventoryItemId: item.beras,
    quantity: "25.0000",
    unitCostIdr: "14000.0000",
    locationId: location.gudang,
  },
  {
    inventoryItemId: item.ayam,
    quantity: "10.0000",
    unitCostIdr: "38000.0000",
    locationId: location.freezer,
    batchId: batchIds.ayam,
  },
  {
    inventoryItemId: item.telur,
    quantity: "10.0000",
    unitCostIdr: "28000.0000",
    locationId: location.chiller,
  },
  {
    inventoryItemId: item.minyak,
    quantity: "18.0000",
    unitCostIdr: "18000.0000",
    locationId: location.gudang,
  },
  {
    inventoryItemId: item.kentang,
    quantity: "10.0000",
    unitCostIdr: "16000.0000",
    locationId: location.chiller,
  },
  {
    inventoryItemId: item.tepung,
    quantity: "25.0000",
    unitCostIdr: "12000.0000",
    locationId: location.gudang,
  },
  {
    inventoryItemId: item.mentega,
    quantity: "5.0000",
    unitCostIdr: "95000.0000",
    locationId: location.chiller,
  },
  {
    inventoryItemId: item.keju,
    quantity: "4.0000",
    unitCostIdr: "120000.0000",
    locationId: location.chiller,
    batchId: batchIds.keju,
  },
  {
    inventoryItemId: item.sirupVanila,
    quantity: "6.0000",
    unitCostIdr: "85000.0000",
    locationId: location.bar,
  },
  {
    inventoryItemId: item.cokelat,
    quantity: "5.0000",
    unitCostIdr: "90000.0000",
    locationId: location.gudang,
  },
  {
    inventoryItemId: item.matcha,
    quantity: "2.0000",
    unitCostIdr: "420000.0000",
    locationId: location.gudang,
  },
  {
    inventoryItemId: item.sedotan,
    quantity: "300.0000",
    unitCostIdr: "150.0000",
    locationId: location.bar,
  },
];

openingStock.forEach((stock, index) =>
  addMovement({
    locationId: stock.locationId,
    inventoryItemId: stock.inventoryItemId,
    movementType: "receipt",
    quantity: stock.quantity,
    unitCostIdr: stock.unitCostIdr,
    batchId: stock.batchId ?? null,
    sourceType: "goods_receipt",
    sourceId: docId(100 + index),
    occurredAt: "2026-11-01T00:05:00.000Z",
  }),
);

// Morning restock: transfer_out and transfer_in rows share the document id.
const transferSeeds = [
  {
    id: docId(201),
    fromLocationId: location.gudang,
    toLocationId: location.bar,
    occurredAt: "2026-11-01T01:00:00.000Z",
    lines: [
      {
        inventoryItemId: item.kopi,
        quantity: "2.0000",
        unitCostIdr: "245000.0000",
      },
      {
        inventoryItemId: item.cup,
        quantity: "100.0000",
        unitCostIdr: "1200.0000",
      },
    ],
  },
  {
    id: docId(202),
    fromLocationId: location.chiller,
    toLocationId: location.bar,
    occurredAt: "2026-11-01T01:05:00.000Z",
    lines: [
      {
        inventoryItemId: item.susu,
        quantity: "10.0000",
        unitCostIdr: "22500.0000",
      },
    ],
  },
  {
    id: docId(203),
    fromLocationId: location.freezer,
    toLocationId: location.bar,
    occurredAt: "2026-11-01T01:10:00.000Z",
    lines: [
      {
        inventoryItemId: item.esBatu,
        quantity: "5.0000",
        unitCostIdr: "2000.0000",
      },
    ],
  },
  {
    id: docId(204),
    fromLocationId: location.gudang,
    toLocationId: location.dapur,
    occurredAt: "2026-11-01T01:15:00.000Z",
    lines: [
      {
        inventoryItemId: item.beras,
        quantity: "2.0000",
        unitCostIdr: "14000.0000",
      },
    ],
  },
];

const stockTransfers = transferSeeds.map((transfer) =>
  stockTransferSchema.parse({
    ...transfer,
    tenantId: tenant.id,
    outletId,
    lines: transfer.lines.map(({ inventoryItemId, quantity }) => ({
      inventoryItemId,
      quantity,
    })),
    movedBy: users.barista,
    note: null,
  }),
);

for (const transfer of transferSeeds) {
  for (const line of transfer.lines) {
    addMovement({
      locationId: transfer.fromLocationId,
      inventoryItemId: line.inventoryItemId,
      movementType: "transfer_out",
      quantity: `-${line.quantity}`,
      unitCostIdr: line.unitCostIdr,
      batchId: null,
      sourceType: "stock_transfer",
      sourceId: transfer.id,
      occurredAt: transfer.occurredAt,
    });
    addMovement({
      locationId: transfer.toLocationId,
      inventoryItemId: line.inventoryItemId,
      movementType: "transfer_in",
      quantity: line.quantity,
      unitCostIdr: line.unitCostIdr,
      batchId: null,
      sourceType: "stock_transfer",
      sourceId: transfer.id,
      occurredAt: transfer.occurredAt,
    });
  }
}

const productionOrders = [
  productionOrderSchema.parse({
    id: productionIds.coldBrew,
    tenantId: tenant.id,
    outletId,
    recipeId: recipeIds.coldBrewConcentrate,
    plannedQty: "5.0000",
    actualQty: "5.0000",
    status: "completed",
    costIdr: 265_000,
    createdAt: "2026-11-01T01:30:00.000Z",
    completedAt: "2026-11-01T02:05:00.000Z",
  }),
  productionOrderSchema.parse({
    id: productionIds.sirup,
    tenantId: tenant.id,
    outletId,
    recipeId: recipeIds.sirupGulaAren,
    plannedQty: "5.0000",
    actualQty: "5.0000",
    status: "completed",
    costIdr: 115_000,
    createdAt: "2026-11-01T02:00:00.000Z",
    completedAt: "2026-11-01T02:15:00.000Z",
  }),
];

// Cold brew: 1 kg coffee + 5 l water in, 5 l concentrate out at 53,000/l.
addMovement({
  locationId: location.gudang,
  inventoryItemId: item.kopi,
  movementType: "production_out",
  quantity: "-1.0000",
  unitCostIdr: "245000.0000",
  batchId: batchIds.kopi,
  sourceType: "production_order",
  sourceId: productionIds.coldBrew,
  occurredAt: "2026-11-01T01:50:00.000Z",
});
addMovement({
  locationId: location.gudang,
  inventoryItemId: item.airMineral,
  movementType: "production_out",
  quantity: "-5.0000",
  unitCostIdr: "4000.0000",
  batchId: null,
  sourceType: "production_order",
  sourceId: productionIds.coldBrew,
  occurredAt: "2026-11-01T01:51:00.000Z",
});
addMovement({
  locationId: location.chiller,
  inventoryItemId: item.coldBrew,
  movementType: "production_in",
  quantity: "5.0000",
  unitCostIdr: "53000.0000",
  batchId: batchIds.coldBrew,
  sourceType: "production_order",
  sourceId: productionIds.coldBrew,
  occurredAt: "2026-11-01T02:05:00.000Z",
});

// Aren syrup: 2.5 kg palm sugar + 3.75 l water in, 5 l syrup out at 23,000/l.
addMovement({
  locationId: location.gudang,
  inventoryItemId: item.gulaAren,
  movementType: "production_out",
  quantity: "-2.5000",
  unitCostIdr: "40000.0000",
  batchId: null,
  sourceType: "production_order",
  sourceId: productionIds.sirup,
  occurredAt: "2026-11-01T02:10:00.000Z",
});
addMovement({
  locationId: location.gudang,
  inventoryItemId: item.airMineral,
  movementType: "production_out",
  quantity: "-3.7500",
  unitCostIdr: "4000.0000",
  batchId: null,
  sourceType: "production_order",
  sourceId: productionIds.sirup,
  occurredAt: "2026-11-01T02:11:00.000Z",
});
addMovement({
  locationId: location.bar,
  inventoryItemId: item.gulaArenCair,
  movementType: "production_in",
  quantity: "5.0000",
  unitCostIdr: "23000.0000",
  batchId: null,
  sourceType: "production_order",
  sourceId: productionIds.sirup,
  occurredAt: "2026-11-01T02:15:00.000Z",
});

// Two Kopi Susu Aren sold from the bar (same order document).
const saleLines: {
  inventoryItemId: string;
  quantity: string;
  unitCostIdr: string;
}[] = [
  {
    inventoryItemId: item.kopi,
    quantity: "-0.0360",
    unitCostIdr: "245000.0000",
  },
  {
    inventoryItemId: item.susu,
    quantity: "-0.4000",
    unitCostIdr: "22500.0000",
  },
  {
    inventoryItemId: item.gulaArenCair,
    quantity: "-0.0400",
    unitCostIdr: "23000.0000",
  },
  { inventoryItemId: item.cup, quantity: "-2.0000", unitCostIdr: "1200.0000" },
  {
    inventoryItemId: item.esBatu,
    quantity: "-0.2000",
    unitCostIdr: "2000.0000",
  },
];
for (const line of saleLines) {
  addMovement({
    locationId: location.bar,
    inventoryItemId: line.inventoryItemId,
    movementType: "sale",
    quantity: line.quantity,
    unitCostIdr: line.unitCostIdr,
    batchId: null,
    sourceType: "order",
    sourceId: cafeLegendFixtures.orderId,
    occurredAt: "2026-11-01T03:15:00.000Z",
  });
}

addMovement({
  locationId: location.bar,
  inventoryItemId: item.susu,
  movementType: "waste",
  quantity: "-1.5000",
  unitCostIdr: "22500.0000",
  batchId: batchIds.susuA,
  sourceType: "waste_log",
  sourceId: wasteIds.susu,
  occurredAt: "2026-11-01T04:00:00.000Z",
});
addMovement({
  locationId: location.gudang,
  inventoryItemId: item.kopi,
  movementType: "return",
  quantity: "-1.0000",
  unitCostIdr: "245000.0000",
  batchId: batchIds.kopi,
  sourceType: "purchase_return",
  sourceId: docId(300),
  occurredAt: "2026-11-01T05:00:00.000Z",
});
addMovement({
  locationId: location.dapur,
  inventoryItemId: item.beras,
  movementType: "duty_meal",
  quantity: "-0.2500",
  unitCostIdr: "14000.0000",
  batchId: null,
  sourceType: "duty_meal",
  sourceId: docId(301),
  occurredAt: "2026-11-01T06:00:00.000Z",
});

// ---- Stock counts (INV-03) ----------------------------------------------

const stockCounts = [
  stockCountSchema.parse({
    id: countIds.pending,
    tenantId: tenant.id,
    outletId,
    locationId: location.chiller,
    type: "cycle",
    status: "pending_approval",
    blind: true,
    businessDate,
    countedBy: users.barista,
    approvedBy: null,
    countedAt: "2026-11-01T06:40:00.000Z",
    approvedAt: null,
    note: "Cek susu dan telur chiller",
  }),
  stockCountSchema.parse({
    id: countIds.posted,
    tenantId: tenant.id,
    outletId,
    locationId: location.gudang,
    type: "full",
    status: "posted",
    blind: false,
    businessDate,
    countedBy: users.barista,
    approvedBy: users.manager,
    countedAt: "2026-11-01T06:45:00.000Z",
    approvedAt: "2026-11-01T06:55:00.000Z",
    note: null,
  }),
];

const stockCountLines = [
  stockCountLineSchema.parse({
    id: id(7810),
    tenantId: tenant.id,
    stockCountId: countIds.pending,
    inventoryItemId: item.susu,
    systemQty: "14.0000",
    countedQty: "13.5000",
    varianceIdr: stockCountVarianceIdr(
      {
        systemQty: decimal4("14.0000"),
        countedQty: decimal4("13.5000"),
        unitCostIdr: decimal4("22500.0000"),
      },
      "half_up",
    ),
  }),
  stockCountLineSchema.parse({
    id: id(7811),
    tenantId: tenant.id,
    stockCountId: countIds.pending,
    inventoryItemId: item.telur,
    systemQty: "10.0000",
    countedQty: "9.8000",
    varianceIdr: stockCountVarianceIdr(
      {
        systemQty: decimal4("10.0000"),
        countedQty: decimal4("9.8000"),
        unitCostIdr: decimal4("28000.0000"),
      },
      "half_up",
    ),
  }),
  stockCountLineSchema.parse({
    id: id(7820),
    tenantId: tenant.id,
    stockCountId: countIds.posted,
    inventoryItemId: item.kopi,
    systemQty: "8.0000",
    countedQty: "7.8000",
    varianceIdr: stockCountVarianceIdr(
      {
        systemQty: decimal4("8.0000"),
        countedQty: decimal4("7.8000"),
        unitCostIdr: decimal4("245000.0000"),
      },
      "half_up",
    ),
  }),
  stockCountLineSchema.parse({
    id: id(7821),
    tenantId: tenant.id,
    stockCountId: countIds.posted,
    inventoryItemId: item.gulaAren,
    systemQty: "7.5000",
    countedQty: "7.5000",
    varianceIdr: 0,
  }),
];

// The approved full count posted its coffee correction (INV-01).
addMovement({
  locationId: location.gudang,
  inventoryItemId: item.kopi,
  movementType: "adjustment",
  quantity: "-0.2000",
  unitCostIdr: "245000.0000",
  batchId: null,
  sourceType: "stock_count",
  sourceId: countIds.posted,
  occurredAt: "2026-11-01T07:00:00.000Z",
});

const ledger = ledgerSeeds.map((seed) =>
  stockLedgerEntrySchema.parse({
    ...seed,
    id: nextLedgerId(),
    tenantId: tenant.id,
    outletId,
  }),
);

const stockBalances = foldStockLedger(ledger, "half_up").map((balance) =>
  stockBalanceSchema.parse(balance),
);

// ---- Par levels ----------------------------------------------------------

const parLevels = [
  parLevelSchema.parse({
    id: id(7551),
    tenantId: tenant.id,
    outletId,
    locationId: location.gudang,
    inventoryItemId: item.kopi,
    parMin: "10.0000",
    parMax: "30.0000",
  }),
  parLevelSchema.parse({
    id: id(7552),
    tenantId: tenant.id,
    outletId,
    locationId: location.bar,
    inventoryItemId: item.cup,
    parMin: "50.0000",
    parMax: "200.0000",
  }),
];

// ---- Waste ---------------------------------------------------------------

const wasteLogs = [
  wasteLogSchema.parse({
    id: wasteIds.susu,
    tenantId: tenant.id,
    outletId,
    locationId: location.bar,
    targetType: "inventory_item",
    targetId: item.susu,
    quantity: "1.5000",
    reason: "expired",
    mediaId: null,
    valueIdr: 33_750,
    loggedBy: users.barista,
    occurredAt: "2026-11-01T04:00:00.000Z",
    note: "Susu lewat tanggal di bar",
  }),
];

// ---- Recipes / BOM -------------------------------------------------------

type RecipeSeed = {
  id: string;
  name: string;
  outputItemId: string | null;
  yieldQuantity: string;
  yieldUomId: string;
  version: number;
  lines: {
    componentType: "item" | "recipe";
    componentId: string;
    quantity: string;
    uomId: string;
    wastePctBp: number;
  }[];
};

const recipeSeeds: RecipeSeed[] = [
  {
    id: recipeIds.kopiSusu,
    name: "Kopi Susu Aren",
    outputItemId: null,
    yieldQuantity: "1.0000",
    yieldUomId: uom.pcs,
    version: 3,
    lines: [
      {
        componentType: "item",
        componentId: item.kopi,
        quantity: "18.0000",
        uomId: uom.g,
        wastePctBp: 200,
      },
      {
        componentType: "item",
        componentId: item.susu,
        quantity: "200.0000",
        uomId: uom.ml,
        wastePctBp: 0,
      },
      {
        componentType: "item",
        componentId: item.gulaArenCair,
        quantity: "20.0000",
        uomId: uom.ml,
        wastePctBp: 0,
      },
      {
        componentType: "item",
        componentId: item.cup,
        quantity: "1.0000",
        uomId: uom.pcs,
        wastePctBp: 0,
      },
      {
        componentType: "item",
        componentId: item.esBatu,
        quantity: "100.0000",
        uomId: uom.g,
        wastePctBp: 0,
      },
    ],
  },
  {
    id: recipeIds.coldBrew,
    name: "Cold Brew Legendaris",
    outputItemId: null,
    yieldQuantity: "1.0000",
    yieldUomId: uom.pcs,
    version: 2,
    lines: [
      {
        componentType: "recipe",
        componentId: recipeIds.coldBrewConcentrate,
        quantity: "60.0000",
        uomId: uom.ml,
        wastePctBp: 0,
      },
      {
        componentType: "item",
        componentId: item.airMineral,
        quantity: "200.0000",
        uomId: uom.ml,
        wastePctBp: 0,
      },
      {
        componentType: "item",
        componentId: item.esBatu,
        quantity: "150.0000",
        uomId: uom.g,
        wastePctBp: 0,
      },
      {
        componentType: "item",
        componentId: item.cup,
        quantity: "1.0000",
        uomId: uom.pcs,
        wastePctBp: 0,
      },
    ],
  },
  {
    id: recipeIds.nasiGoreng,
    name: "Nasi Goreng Kampung",
    outputItemId: null,
    yieldQuantity: "1.0000",
    yieldUomId: uom.pcs,
    version: 1,
    lines: [
      {
        componentType: "item",
        componentId: item.beras,
        quantity: "150.0000",
        uomId: uom.g,
        wastePctBp: 0,
      },
      {
        componentType: "item",
        componentId: item.ayam,
        quantity: "80.0000",
        uomId: uom.g,
        wastePctBp: 100,
      },
      {
        componentType: "item",
        componentId: item.telur,
        quantity: "55.0000",
        uomId: uom.g,
        wastePctBp: 0,
      },
      {
        componentType: "item",
        componentId: item.minyak,
        quantity: "15.0000",
        uomId: uom.ml,
        wastePctBp: 0,
      },
      {
        componentType: "item",
        componentId: item.kentang,
        quantity: "30.0000",
        uomId: uom.g,
        wastePctBp: 0,
      },
    ],
  },
  {
    id: recipeIds.sirupGulaAren,
    name: "Sirup Gula Aren",
    outputItemId: item.gulaArenCair,
    yieldQuantity: "5.0000",
    yieldUomId: uom.l,
    version: 2,
    lines: [
      {
        componentType: "item",
        componentId: item.gulaAren,
        quantity: "2.5000",
        uomId: uom.kg,
        wastePctBp: 0,
      },
      {
        componentType: "item",
        componentId: item.airMineral,
        quantity: "3.7500",
        uomId: uom.l,
        wastePctBp: 0,
      },
    ],
  },
  {
    id: recipeIds.coldBrewConcentrate,
    name: "Cold Brew Concentrate",
    outputItemId: item.coldBrew,
    yieldQuantity: "5.0000",
    yieldUomId: uom.l,
    version: 4,
    lines: [
      {
        componentType: "item",
        componentId: item.kopi,
        quantity: "1.0000",
        uomId: uom.kg,
        wastePctBp: 0,
      },
      {
        componentType: "item",
        componentId: item.airMineral,
        quantity: "5.0000",
        uomId: uom.l,
        wastePctBp: 0,
      },
    ],
  },
  {
    id: recipeIds.esCokelat,
    name: "Es Cokelat Legend",
    outputItemId: null,
    yieldQuantity: "1.0000",
    yieldUomId: uom.pcs,
    version: 1,
    lines: [
      {
        componentType: "item",
        componentId: item.cokelat,
        quantity: "25.0000",
        uomId: uom.g,
        wastePctBp: 0,
      },
      {
        componentType: "item",
        componentId: item.susu,
        quantity: "200.0000",
        uomId: uom.ml,
        wastePctBp: 0,
      },
      {
        componentType: "item",
        componentId: item.cup,
        quantity: "1.0000",
        uomId: uom.pcs,
        wastePctBp: 0,
      },
      {
        componentType: "item",
        componentId: item.esBatu,
        quantity: "100.0000",
        uomId: uom.g,
        wastePctBp: 0,
      },
    ],
  },
];

let recipeLineNumber = 0;
const recipeLines: RecipeLine[] = [];
const recipes: Recipe[] = recipeSeeds.map((seed) => {
  const recipe = recipeSchema.parse({
    id: seed.id,
    tenantId: tenant.id,
    brandId: brand.id,
    name: seed.name,
    outputItemId: seed.outputItemId,
    yieldQuantity: seed.yieldQuantity,
    yieldUomId: seed.yieldUomId,
    version: seed.version,
    isActive: true,
    // Filled below once the moving-average costs are known (INV-04).
    theoreticalCostIdr: "0.0000",
    updatedBy: users.manager,
    updatedAt: snapshotAt,
  });
  for (const line of seed.lines) {
    recipeLines.push(
      recipeLineSchema.parse({
        ...line,
        id: id(7700 + recipeLineNumber++),
        tenantId: tenant.id,
        recipeId: seed.id,
      }),
    );
  }
  return recipe;
});

// Weighted moving-average unit cost per item across its locations.
const unitCosts = new Map<string, Decimal4>();
for (const inventoryItem of items) {
  let quantity = 0n;
  let value = 0n;
  for (const balance of stockBalances) {
    if (balance.inventoryItemId !== inventoryItem.id) continue;
    const balanceQuantity = parseDecimal4(balance.quantity);
    if (balanceQuantity <= 0n) continue;
    quantity += balanceQuantity;
    value += balanceQuantity * parseDecimal4(balance.avgCostIdr);
  }
  unitCosts.set(
    inventoryItem.id,
    quantity === 0n
      ? formatDecimal4(0n)
      : formatDecimal4(divideRounded(value, quantity, "half_up")),
  );
}

const costBook = {
  recipes,
  recipeLines,
  items,
  conversions: uomConversions,
  unitCosts,
};

// A semi-finished item's unit cost comes from its production recipe, then the
// menu recipes that use it can be costed.
const semiFinishedCosts = new Map<string, RecipeCost>([
  [
    recipeIds.sirupGulaAren,
    theoreticalRecipeCost(costBook, recipeIds.sirupGulaAren, "half_up"),
  ],
  [
    recipeIds.coldBrewConcentrate,
    theoreticalRecipeCost(costBook, recipeIds.coldBrewConcentrate, "half_up"),
  ],
]);
unitCosts.set(
  item.gulaArenCair,
  semiFinishedCosts.get(recipeIds.sirupGulaAren)?.unitCostIdr ??
    formatDecimal4(0n),
);
unitCosts.set(
  item.coldBrew,
  semiFinishedCosts.get(recipeIds.coldBrewConcentrate)?.unitCostIdr ??
    formatDecimal4(0n),
);

const recipeCosts = new Map<string, RecipeCost>(
  recipes.map((recipe) => [
    recipe.id,
    theoreticalRecipeCost(costBook, recipe.id, "half_up"),
  ]),
);
for (const recipe of recipes) {
  recipe.theoreticalCostIdr =
    recipeCosts.get(recipe.id)?.unitCostIdr ?? formatDecimal4(0n);
}

// ---- Menu HPP, coverage and menu engineering (PRD §17) -------------------

const menuItemByName = (menuName: string) => {
  const menuItem = cafeLegendMenuFixtures.items.find(
    (candidate) => candidate.name === menuName,
  );
  if (!menuItem) throw new Error(`Menu fixture "${menuName}" is missing`);
  return menuItem;
};

const priceOf = (menuItemId: string): Idr => {
  const row = cafeLegendMenuFixtures.priceListItems.find(
    (candidate) => candidate.itemId === menuItemId,
  );
  if (!row) throw new Error(`Price for menu item ${menuItemId} is missing`);
  return row.priceIdr;
};

const recipeByMenuItemId = new Map<string, string>([
  [menuItemByName("Kopi Susu Aren").id, recipeIds.kopiSusu],
  [menuItemByName("Cold Brew").id, recipeIds.coldBrew],
  [menuItemByName("Nasi Goreng Kampung").id, recipeIds.nasiGoreng],
  [menuItemByName("Es Cokelat").id, recipeIds.esCokelat],
]);

const menuCosts = [...recipeByMenuItemId.entries()].map(
  ([menuItemId, recipeId]) => {
    const cost = recipeCosts.get(recipeId);
    if (!cost) throw new Error(`Cost for recipe ${recipeId} is missing`);
    const priceIdr = priceOf(menuItemId);
    return menuCostSchema.parse({
      tenantId: tenant.id,
      outletId,
      menuItemId,
      variantId: null,
      modifierId: null,
      recipeId,
      recipeComplete: true,
      theoreticalCostIdr: cost.unitCostIdr,
      priceIdr,
      grossMarginBp: grossMarginBp(priceIdr, cost.unitCostIdr, "half_up"),
      computedAt: snapshotAt,
    });
  },
);
const menuWithoutRecipe = menuItemByName("Croissant Mentega");
menuCosts.push(
  menuCostSchema.parse({
    tenantId: tenant.id,
    outletId,
    menuItemId: menuWithoutRecipe.id,
    variantId: null,
    modifierId: null,
    recipeId: null,
    recipeComplete: false,
    theoreticalCostIdr: null,
    priceIdr: priceOf(menuWithoutRecipe.id),
    grossMarginBp: null,
    computedAt: snapshotAt,
  }),
);

const recipeCoverage = cafeLegendMenuFixtures.items.map((menuItem) => {
  const recipeId = recipeByMenuItemId.get(menuItem.id) ?? null;
  const cost = recipeId ? recipeCosts.get(recipeId) : undefined;
  return recipeCoverageRowSchema.parse({
    tenantId: tenant.id,
    menuItemId: menuItem.id,
    variantId: null,
    modifierId: null,
    status: recipeId ? "complete" : "no_recipe",
    recipeId,
    theoreticalCostIdr: cost?.unitCostIdr ?? null,
    updatedAt: snapshotAt,
  });
});

const marginOf = (priceIdr: Idr, costIdr: Decimal4): Idr => {
  const cost = divideRounded(parseDecimal4(costIdr), 10_000n, "half_up");
  return idr(priceIdr - Number(cost));
};

// Illustrative matrix rows: the real classification compares popularity and
// margin with the full-menu medians (PRD §17 "Menu Engineering").
const engineeringSeeds = [
  { name: "Kopi Susu Aren", unitsSold: 520, classification: "star" },
  { name: "Nasi Goreng Kampung", unitsSold: 410, classification: "plowhorse" },
  { name: "Cold Brew", unitsSold: 130, classification: "puzzle" },
  { name: "Es Cokelat", unitsSold: 60, classification: "dog" },
] as const;
const menuEngineering = engineeringSeeds.map((seed) => {
  const menuItem = menuItemByName(seed.name);
  const recipeId = recipeByMenuItemId.get(menuItem.id);
  const cost = recipeId ? recipeCosts.get(recipeId) : undefined;
  if (!cost) throw new Error(`Cost for ${seed.name} is missing`);
  return menuEngineeringRowSchema.parse({
    tenantId: tenant.id,
    outletId,
    menuItemId: menuItem.id,
    unitsSold: seed.unitsSold,
    grossMarginIdr: marginOf(priceOf(menuItem.id), cost.unitCostIdr),
    classification: seed.classification,
  });
});

const foodCostComparisons = [
  foodCostComparisonSchema.parse({
    tenantId: tenant.id,
    outletId,
    fromDate: "2026-10-01",
    toDate: "2026-10-31",
    theoreticalCostIdr: 18_450_000,
    actualCostIdr: 19_120_000,
    varianceIdr: 670_000,
    varianceBp: 363,
    wasteIdr: 410_000,
    adjustmentIdr: 95_000,
    offRecipeUsageIdr: 165_000,
  }),
];

const stockCountDetails: StockCountDetail[] = stockCounts.map((count) => ({
  count,
  lines: stockCountLines.filter((line) => line.stockCountId === count.id),
}));

export const inventoryFixtureSchema = z.strictObject({
  uoms: z.array(uomSchema),
  items: z.array(inventoryItemSchema),
  itemAlternates: z.array(inventoryItemAlternateSchema),
  uomConversions: z.array(uomConversionSchema),
  locations: z.array(stockLocationSchema),
  batches: z.array(stockBatchSchema),
  ledger: z.array(stockLedgerEntrySchema),
  balances: z.array(stockBalanceSchema),
  parLevels: z.array(parLevelSchema),
  stockTransfers: z.array(stockTransferSchema),
  stockCounts: z.array(stockCountSchema),
  stockCountLines: z.array(stockCountLineSchema),
  stockCountDetails: z.array(stockCountDetailSchema),
  wasteLogs: z.array(wasteLogSchema),
  recipes: z.array(recipeSchema),
  recipeLines: z.array(recipeLineSchema),
  productionOrders: z.array(productionOrderSchema),
  menuCosts: z.array(menuCostSchema),
  recipeCoverage: z.array(recipeCoverageRowSchema),
  menuEngineering: z.array(menuEngineeringRowSchema),
  foodCostComparisons: z.array(foodCostComparisonSchema),
});

export const cafeLegendInventoryFixtures = inventoryFixtureSchema.parse({
  uoms,
  items,
  itemAlternates,
  uomConversions,
  locations,
  batches,
  ledger,
  balances: stockBalances,
  parLevels,
  stockTransfers,
  stockCounts,
  stockCountLines,
  stockCountDetails,
  wasteLogs,
  recipes,
  recipeLines,
  productionOrders,
  menuCosts,
  recipeCoverage,
  menuEngineering,
  foodCostComparisons,
});
