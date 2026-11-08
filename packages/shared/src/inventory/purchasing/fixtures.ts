// Cafe Legend purchasing fixtures for FE mock mode and contract tests (bead
// legend-ejk). Illustrative but internally consistent with the inventory
// fixtures: suppliers and catalog prices point at real inventory items, one PO
// is partially received (INV-05), one invoice is matched and paid, one is
// discrepant (price and quantity) and one payment awaits approval. Money is
// whole rupiah; PPN/PPh 23 stay 0 here because tax amounts belong to the tax
// contract (the contract accepts any amount).
//
// Everything below is parsed by `purchasingFixtureSchema.parse`, so a change
// that breaks a schema fails at module load, as with the other fixtures.

import {
  cafeLegendFixtures,
  decimal4,
  extendCostIdr,
  idr,
  idrSchema,
  z,
} from "../../core/index.ts";
import { businessDateSchema } from "../../core/index.ts";
import { cafeLegendInventoryFixtures } from "../fixtures.ts";
import {
  goodsReceiptDetailSchema,
  goodsReceiptLineSchema,
  goodsReceiptSchema,
  goodsReceiptValueIdr,
  pettyPurchasePolicySchema,
  pettyPurchaseSchema,
  purchaseOrderDetailSchema,
  purchaseOrderLineSchema,
  purchaseOrderLineTotalIdr,
  purchaseOrderSchema,
  purchaseOrderTotals,
  purchaseRequestDetailSchema,
  purchaseRequestLineSchema,
  purchaseRequestSchema,
  purchaseReturnDetailSchema,
  purchaseReturnLineSchema,
  purchaseReturnSchema,
  purchaseReturnValueIdr,
  supplierCatalogItemSchema,
  supplierContactSchema,
  supplierInvoiceDetailSchema,
  supplierInvoiceLineSchema,
  supplierInvoiceSchema,
  supplierPaymentSchema,
  supplierDeliverySchema,
  supplierPerformance,
  supplierPerformanceSchema,
  supplierPriceOnDate,
  supplierSchema,
  threeWayMatch,
  type SupplierDelivery,
  type SupplierInvoice,
} from "./schemas.ts";

const { tenant, outlets } = cafeLegendFixtures;
const outletId = outlets[0].id;
const inventory = cafeLegendInventoryFixtures;

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const itemByName = (name: string): string => {
  const found = inventory.items.find((item) => item.name === name);
  if (!found) throw new Error(`Inventory fixture item "${name}" is missing`);
  return found.id;
};
const uomByCode = (code: string): string => {
  const found = inventory.uoms.find((uom) => uom.code === code);
  if (!found) throw new Error(`Inventory fixture uom "${code}" is missing`);
  return found.id;
};
const locationByName = (name: string): string => {
  const found = inventory.locations.find((location) => location.name === name);
  if (!found)
    throw new Error(`Inventory fixture location "${name}" is missing`);
  return found.id;
};

const uom = { kg: uomByCode("kg"), l: uomByCode("l"), pack: uomByCode("pack") };
const gudang = locationByName("Gudang Utama");
const chiller = locationByName("Chiller Bar");

// Staff ids used across documents; the identity contract owns real users.
const userId = {
  kitchenLead: id(8001),
  manager: id(8002),
  purchasing: id(8003),
  warehouse: id(8004),
  finance: id(8005),
  owner: id(8006),
  cashier: id(8007),
} as const;

const createdAt = "2026-07-01T02:00:00.000Z";
const updatedAt = "2026-10-20T03:00:00.000Z";

const supplierIds = {
  kopi: id(8101),
  susu: id(8102),
  sayur: id(8103),
  kemasan: id(8104),
} as const;

// ---- Suppliers, contacts and catalog (PRD §3.18 Supplier) ----------------

const suppliers = [
  {
    id: supplierIds.kopi,
    name: "CV Kopi Priangan",
    legalName: "CV Kopi Priangan",
    contactName: "Asep Hidayat",
    phone: "628112233445",
    email: "pembelian@kopipriangan.example",
    address: "Jl. Braga No. 42, Bandung",
    paymentTermsDays: 14,
    rating: 4,
  },
  {
    id: supplierIds.susu,
    name: "PT Susu Segar Bandung",
    legalName: "PT Susu Segar Bandung",
    contactName: "Rina Kartika",
    phone: "628122334455",
    email: "sales@sususegar.example",
    address: "Jl. Soekarno-Hatta No. 210, Bandung",
    paymentTermsDays: 7,
    rating: 5,
  },
  {
    id: supplierIds.sayur,
    name: "UD Sayur Lembang",
    legalName: null,
    contactName: "Ujang Suryana",
    phone: "628133445566",
    email: null,
    address: "Pasar Lembang Blok C, Bandung Barat",
    paymentTermsDays: 3,
    rating: 3,
  },
  {
    id: supplierIds.kemasan,
    name: "PT Kemasan Nusantara",
    legalName: "PT Kemasan Nusantara",
    contactName: "Vina Lestari",
    phone: "628134556677",
    email: "ar@kemasannusantara.example",
    address: "Kawasan Industri Cikarang Blok B-7, Bekasi",
    paymentTermsDays: 30,
    rating: 4,
  },
].map((supplier) =>
  supplierSchema.parse({
    ...supplier,
    tenantId: tenant.id,
    isActive: true,
    createdAt,
    updatedAt,
  }),
);

const supplierContacts = [
  {
    id: id(8201),
    supplierId: supplierIds.kopi,
    name: "Asep Hidayat",
    role: "Sales",
    phone: "628112233445",
    email: "pembelian@kopipriangan.example",
    isPrimary: true,
  },
  {
    id: id(8202),
    supplierId: supplierIds.kopi,
    name: "Dewi Rosdiana",
    role: "Penagihan",
    phone: "628112233999",
    email: "finance@kopipriangan.example",
    isPrimary: false,
  },
  {
    id: id(8203),
    supplierId: supplierIds.susu,
    name: "Rina Kartika",
    role: "Account Executive",
    phone: "628122334455",
    email: "sales@sususegar.example",
    isPrimary: true,
  },
  {
    id: id(8204),
    supplierId: supplierIds.sayur,
    name: "Ujang Suryana",
    role: null,
    phone: "628133445566",
    email: null,
    isPrimary: true,
  },
  {
    id: id(8205),
    supplierId: supplierIds.kemasan,
    name: "Vina Lestari",
    role: "AR",
    phone: "628134556677",
    email: "ar@kemasannusantara.example",
    isPrimary: true,
  },
].map((contact) =>
  supplierContactSchema.parse({ ...contact, tenantId: tenant.id }),
);

const supplierCatalogSeeds = [
  {
    id: id(8301),
    supplierId: supplierIds.kopi,
    item: "Kopi Arabika Gayo",
    purchaseUomId: uom.kg,
    priceIdr: "185000.0000",
    effectiveFrom: "2026-10-01",
    createdAt: "2026-09-25T02:00:00.000Z",
  },
  {
    id: id(8302),
    supplierId: supplierIds.kopi,
    item: "Kopi Arabika Gayo",
    purchaseUomId: uom.kg,
    priceIdr: "172000.0000",
    effectiveFrom: "2026-08-01",
    createdAt: "2026-07-25T02:00:00.000Z",
  },
  {
    id: id(8303),
    supplierId: supplierIds.kopi,
    item: "Gula Aren",
    purchaseUomId: uom.kg,
    priceIdr: "24000.0000",
    effectiveFrom: "2026-10-01",
    createdAt: "2026-09-25T02:00:00.000Z",
  },
  {
    id: id(8304),
    supplierId: supplierIds.susu,
    item: "Susu UHT Full Cream",
    purchaseUomId: uom.l,
    priceIdr: "22000.0000",
    effectiveFrom: "2026-09-15",
    createdAt: "2026-09-10T02:00:00.000Z",
  },
  {
    id: id(8305),
    supplierId: supplierIds.kemasan,
    item: "Cup 16oz",
    purchaseUomId: uom.pack,
    priceIdr: "32500.0000",
    effectiveFrom: "2026-09-01",
    createdAt: "2026-08-25T02:00:00.000Z",
  },
  {
    id: id(8306),
    supplierId: supplierIds.kemasan,
    item: "Sedotan Kertas",
    purchaseUomId: uom.pack,
    priceIdr: "18000.0000",
    effectiveFrom: "2026-09-01",
    createdAt: "2026-08-25T02:00:00.000Z",
  },
  {
    id: id(8307),
    supplierId: supplierIds.sayur,
    item: "Ayam Fillet",
    purchaseUomId: uom.kg,
    priceIdr: "62000.0000",
    effectiveFrom: "2026-10-01",
    createdAt: "2026-09-28T02:00:00.000Z",
  },
  {
    id: id(8308),
    supplierId: supplierIds.sayur,
    item: "Telur Ayam",
    purchaseUomId: uom.kg,
    priceIdr: "30000.0000",
    effectiveFrom: "2026-10-01",
    createdAt: "2026-09-28T02:00:00.000Z",
  },
  {
    id: id(8309),
    supplierId: supplierIds.sayur,
    item: "Kentang",
    purchaseUomId: uom.kg,
    priceIdr: "14000.0000",
    effectiveFrom: "2026-10-15",
    createdAt: "2026-10-10T02:00:00.000Z",
  },
];
const supplierCatalog = supplierCatalogSeeds.map((seed) =>
  supplierCatalogItemSchema.parse({
    id: seed.id,
    tenantId: tenant.id,
    supplierId: seed.supplierId,
    inventoryItemId: itemByName(seed.item),
    purchaseUomId: seed.purchaseUomId,
    priceIdr: seed.priceIdr,
    effectiveFrom: seed.effectiveFrom,
    isActive: true,
    createdAt: seed.createdAt,
  }),
);

// ---- Purchase requests (PRD §4 Alur I step 1) -----------------------------

const prIds = {
  approved: id(8401),
  pending: id(8402),
  draft: id(8403),
  rejected: id(8404),
} as const;

const purchaseRequestLineSeeds = [
  {
    id: id(8411),
    purchaseRequestId: prIds.approved,
    item: "Kopi Arabika Gayo",
    quantity: "20.0000",
    uomId: uom.kg,
  },
  {
    id: id(8412),
    purchaseRequestId: prIds.approved,
    item: "Gula Aren",
    quantity: "5.0000",
    uomId: uom.kg,
  },
  {
    id: id(8413),
    purchaseRequestId: prIds.pending,
    item: "Susu UHT Full Cream",
    quantity: "24.0000",
    uomId: uom.l,
  },
  {
    id: id(8414),
    purchaseRequestId: prIds.draft,
    item: "Kentang",
    quantity: "10.0000",
    uomId: uom.kg,
  },
  {
    id: id(8415),
    purchaseRequestId: prIds.rejected,
    item: "Ayam Fillet",
    quantity: "10.0000",
    uomId: uom.kg,
  },
].map((seed) =>
  purchaseRequestLineSchema.parse({
    id: seed.id,
    tenantId: tenant.id,
    purchaseRequestId: seed.purchaseRequestId,
    inventoryItemId: itemByName(seed.item),
    quantity: seed.quantity,
    uomId: seed.uomId,
  }),
);

const purchaseRequests = [
  {
    id: prIds.approved,
    status: "converted",
    neededBy: "2026-11-01",
    note: "Stok kopi dan gula aren di bawah par level setelah akhir pekan.",
    decidedBy: userId.manager,
    decidedAt: "2026-10-30T04:00:00.000Z",
    decisionNote: "Disetujui; PO diterbitkan ke CV Kopi Priangan.",
    createdAt: "2026-10-29T02:00:00.000Z",
    updatedAt: "2026-10-30T04:10:00.000Z",
  },
  {
    id: prIds.pending,
    status: "pending_approval",
    neededBy: "2026-11-03",
    note: "Susu UHT untuk bar; chiller tersisa 18 liter.",
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: "2026-10-31T02:00:00.000Z",
    updatedAt: "2026-10-31T02:05:00.000Z",
  },
  {
    id: prIds.draft,
    status: "draft",
    neededBy: "2026-11-05",
    note: null,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: "2026-11-01T01:00:00.000Z",
    updatedAt: "2026-11-01T01:00:00.000Z",
  },
  {
    id: prIds.rejected,
    status: "rejected",
    neededBy: "2026-11-04",
    note: "Ayam fillet untuk menu baru.",
    decidedBy: userId.manager,
    decidedAt: "2026-10-31T05:00:00.000Z",
    decisionNote: "Anggaran minggu ini dialihkan ke perbaikan chiller.",
    createdAt: "2026-10-30T03:00:00.000Z",
    updatedAt: "2026-10-31T05:00:00.000Z",
  },
].map((request) =>
  purchaseRequestSchema.parse({
    ...request,
    tenantId: tenant.id,
    outletId,
    requestedBy: userId.kitchenLead,
  }),
);

const purchaseRequestDetails = purchaseRequests.map((request) =>
  purchaseRequestDetailSchema.parse({
    request,
    lines: purchaseRequestLineSeeds.filter(
      (line) => line.purchaseRequestId === request.id,
    ),
  }),
);

// ---- Purchase orders and lines (PRD §6.E purchase_orders) ----------------

const poIds = {
  kopi: id(8501),
  susu: id(8502),
  kemasan: id(8503),
  aiDraft: id(8504),
  sayur: id(8505),
} as const;

const purchaseOrderLineSeeds = [
  {
    id: id(8511),
    purchaseOrderId: poIds.kopi,
    item: "Kopi Arabika Gayo",
    quantity: "20.0000",
    uomId: uom.kg,
    unitPriceIdr: "185000.0000",
  },
  {
    id: id(8512),
    purchaseOrderId: poIds.kopi,
    item: "Gula Aren",
    quantity: "5.0000",
    uomId: uom.kg,
    unitPriceIdr: "24000.0000",
  },
  {
    id: id(8513),
    purchaseOrderId: poIds.susu,
    item: "Susu UHT Full Cream",
    quantity: "24.0000",
    uomId: uom.l,
    unitPriceIdr: "22000.0000",
  },
  {
    id: id(8514),
    purchaseOrderId: poIds.kemasan,
    item: "Cup 16oz",
    quantity: "4.0000",
    uomId: uom.pack,
    unitPriceIdr: "32500.0000",
  },
  {
    id: id(8515),
    purchaseOrderId: poIds.kemasan,
    item: "Sedotan Kertas",
    quantity: "2.0000",
    uomId: uom.pack,
    unitPriceIdr: "18000.0000",
  },
  {
    id: id(8516),
    purchaseOrderId: poIds.aiDraft,
    item: "Kopi Arabika Gayo",
    quantity: "15.0000",
    uomId: uom.kg,
    unitPriceIdr: "185000.0000",
  },
  {
    id: id(8517),
    purchaseOrderId: poIds.aiDraft,
    item: "Gula Aren",
    quantity: "3.0000",
    uomId: uom.kg,
    unitPriceIdr: "24000.0000",
  },
  {
    id: id(8518),
    purchaseOrderId: poIds.sayur,
    item: "Ayam Fillet",
    quantity: "8.0000",
    uomId: uom.kg,
    unitPriceIdr: "62000.0000",
  },
  {
    id: id(8519),
    purchaseOrderId: poIds.sayur,
    item: "Telur Ayam",
    quantity: "5.0000",
    uomId: uom.kg,
    unitPriceIdr: "30000.0000",
  },
].map((seed) =>
  purchaseOrderLineSchema.parse({
    id: seed.id,
    tenantId: tenant.id,
    purchaseOrderId: seed.purchaseOrderId,
    inventoryItemId: itemByName(seed.item),
    quantity: seed.quantity,
    uomId: seed.uomId,
    unitPriceIdr: seed.unitPriceIdr,
    lineTotalIdr: purchaseOrderLineTotalIdr(
      decimal4(seed.quantity),
      decimal4(seed.unitPriceIdr),
      "half_up",
    ),
  }),
);

const linesForPo = (purchaseOrderId: string) =>
  purchaseOrderLineSeeds.filter(
    (line) => line.purchaseOrderId === purchaseOrderId,
  );

const purchaseOrders = [
  {
    id: poIds.kopi,
    supplierId: supplierIds.kopi,
    number: "PO/BDG/2026/10/0042",
    purchaseRequestId: prIds.approved,
    status: "partially_received",
    expectedDate: "2026-11-01",
    source: "user",
    createdBy: userId.purchasing,
    createdAt: "2026-10-30T04:15:00.000Z",
    updatedAt: "2026-10-30T05:30:00.000Z",
    approvedBy: userId.manager,
    approvedAt: "2026-10-30T05:00:00.000Z",
    sentAt: "2026-10-30T05:30:00.000Z",
    sentTo: "pembelian@kopipriangan.example",
    emailDeliveryStatus: "sent",
    closedAt: null,
    note: "Kirim pagi sebelum jam 09.00.",
  },
  {
    id: poIds.susu,
    supplierId: supplierIds.susu,
    number: "PO/BDG/2026/10/0043",
    purchaseRequestId: null,
    status: "received",
    expectedDate: "2026-11-01",
    source: "user",
    createdBy: userId.purchasing,
    createdAt: "2026-10-30T06:00:00.000Z",
    updatedAt: "2026-10-30T07:00:00.000Z",
    approvedBy: userId.manager,
    approvedAt: "2026-10-30T06:30:00.000Z",
    sentAt: "2026-10-30T07:00:00.000Z",
    sentTo: "sales@sususegar.example",
    emailDeliveryStatus: "sent",
    closedAt: null,
    note: null,
  },
  {
    id: poIds.kemasan,
    supplierId: supplierIds.kemasan,
    number: "PO/BDG/2026/10/0044",
    purchaseRequestId: null,
    status: "partially_received",
    expectedDate: "2026-10-31",
    source: "user",
    createdBy: userId.purchasing,
    createdAt: "2026-10-28T02:00:00.000Z",
    updatedAt: "2026-10-28T03:30:00.000Z",
    approvedBy: userId.manager,
    approvedAt: "2026-10-28T03:00:00.000Z",
    sentAt: "2026-10-28T03:30:00.000Z",
    sentTo: "ar@kemasannusantara.example",
    emailDeliveryStatus: "sent",
    closedAt: null,
    note: null,
  },
  {
    id: poIds.aiDraft,
    supplierId: supplierIds.kopi,
    number: "PO/BDG/2026/11/0045",
    purchaseRequestId: null,
    status: "draft",
    expectedDate: "2026-11-04",
    source: "ai",
    createdBy: userId.kitchenLead,
    createdAt: "2026-11-01T01:30:00.000Z",
    updatedAt: "2026-11-01T01:30:00.000Z",
    approvedBy: null,
    approvedAt: null,
    sentAt: null,
    sentTo: null,
    emailDeliveryStatus: null,
    closedAt: null,
    note: "Draf dari saran pembelian AI-08; menunggu persetujuan purchasing.",
  },
  {
    id: poIds.sayur,
    supplierId: supplierIds.sayur,
    number: "PO/BDG/2026/11/0046",
    purchaseRequestId: null,
    status: "approved",
    expectedDate: "2026-11-05",
    source: "mcp",
    createdBy: userId.kitchenLead,
    createdAt: "2026-11-01T02:00:00.000Z",
    updatedAt: "2026-11-01T02:30:00.000Z",
    approvedBy: userId.manager,
    approvedAt: "2026-11-01T02:30:00.000Z",
    sentAt: null,
    sentTo: null,
    emailDeliveryStatus: null,
    closedAt: null,
    note: "Draft MCP TL-13 sudah disetujui; menunggu dikirim.",
  },
].map((order) => {
  const totals = purchaseOrderTotals(linesForPo(order.id), idr(0), "half_up");
  return purchaseOrderSchema.parse({
    ...order,
    tenantId: tenant.id,
    outletId,
    ...totals,
  });
});

const purchaseOrderDetails = purchaseOrders.map((order) =>
  purchaseOrderDetailSchema.parse({
    purchaseOrder: order,
    lines: linesForPo(order.id),
  }),
);

// ---- Goods receipts with QC and partial delivery (INV-05) ----------------

const grIds = { kopi: id(8601), susu: id(8602), kemasan: id(8603) } as const;

const goodsReceiptLineSeeds = [
  {
    id: id(8611),
    goodsReceiptId: grIds.kopi,
    purchaseOrderLineId: id(8511),
    item: "Kopi Arabika Gayo",
    locationId: gudang,
    quantityReceived: "12.0000",
    quantityRejected: "0.0000",
    unitCostIdr: "185000.0000",
    batchCode: "KOPI-GAYO-2611",
    expiresOn: null,
  },
  {
    id: id(8612),
    goodsReceiptId: grIds.kopi,
    purchaseOrderLineId: id(8512),
    item: "Gula Aren",
    locationId: gudang,
    quantityReceived: "5.0000",
    quantityRejected: "0.0000",
    unitCostIdr: "24000.0000",
    batchCode: "GULA-AREN-2611",
    expiresOn: null,
  },
  {
    id: id(8613),
    goodsReceiptId: grIds.susu,
    purchaseOrderLineId: id(8513),
    item: "Susu UHT Full Cream",
    locationId: chiller,
    quantityReceived: "24.0000",
    quantityRejected: "0.0000",
    unitCostIdr: "22000.0000",
    batchCode: "SUSU-2611-A",
    expiresOn: "2026-11-21",
  },
  {
    id: id(8614),
    goodsReceiptId: grIds.kemasan,
    purchaseOrderLineId: id(8514),
    item: "Cup 16oz",
    locationId: gudang,
    quantityReceived: "4.0000",
    quantityRejected: "1.0000",
    unitCostIdr: "32500.0000",
    batchCode: null,
    expiresOn: null,
  },
  {
    id: id(8615),
    goodsReceiptId: grIds.kemasan,
    purchaseOrderLineId: id(8515),
    item: "Sedotan Kertas",
    locationId: gudang,
    quantityReceived: "2.0000",
    quantityRejected: "0.0000",
    unitCostIdr: "18000.0000",
    batchCode: null,
    expiresOn: null,
  },
].map((seed) =>
  goodsReceiptLineSchema.parse({
    id: seed.id,
    tenantId: tenant.id,
    goodsReceiptId: seed.goodsReceiptId,
    purchaseOrderLineId: seed.purchaseOrderLineId,
    inventoryItemId: itemByName(seed.item),
    locationId: seed.locationId,
    quantityReceived: seed.quantityReceived,
    quantityRejected: seed.quantityRejected,
    unitCostIdr: seed.unitCostIdr,
    batchCode: seed.batchCode,
    expiresOn: seed.expiresOn,
  }),
);

const goodsReceipts = [
  {
    id: grIds.kopi,
    purchaseOrderId: poIds.kopi,
    supplierId: supplierIds.kopi,
    number: "GR/BDG/2026/11/0017",
    receivedBy: userId.warehouse,
    receivedAt: "2026-11-01T01:30:00.000Z",
    receivedOn: "2026-11-01",
    qcNotes: "Kemasan kopi utuh; gula aren sesuai PO. Sisa 8 kg kopi menyusul.",
    mediaIds: [id(9001)],
    note: null,
    createdAt: "2026-11-01T01:30:00.000Z",
  },
  {
    id: grIds.susu,
    purchaseOrderId: poIds.susu,
    supplierId: supplierIds.susu,
    number: "GR/BDG/2026/11/0018",
    receivedBy: userId.warehouse,
    receivedAt: "2026-11-01T02:00:00.000Z",
    receivedOn: "2026-11-01",
    qcNotes: "Suhu chiller 4 derajat Celsius, segel utuh.",
    mediaIds: [],
    note: null,
    createdAt: "2026-11-01T02:00:00.000Z",
  },
  {
    id: grIds.kemasan,
    purchaseOrderId: poIds.kemasan,
    supplierId: supplierIds.kemasan,
    number: "GR/BDG/2026/11/0019",
    receivedBy: userId.warehouse,
    receivedAt: "2026-11-01T02:30:00.000Z",
    receivedOn: "2026-11-01",
    qcNotes: "1 pack cup penyok saat bongkar dan ditolak QC.",
    mediaIds: [id(9002), id(9003)],
    note: null,
    createdAt: "2026-11-01T02:30:00.000Z",
  },
].map((receipt) =>
  goodsReceiptSchema.parse({ ...receipt, tenantId: tenant.id, outletId }),
);

const receiptLinesFor = (goodsReceiptId: string) =>
  goodsReceiptLineSeeds.filter(
    (line) => line.goodsReceiptId === goodsReceiptId,
  );
const receiptLinesForPo = (purchaseOrderId: string) => {
  const receiptIds = goodsReceipts
    .filter((receipt) => receipt.purchaseOrderId === purchaseOrderId)
    .map((receipt) => receipt.id);
  return goodsReceiptLineSeeds.filter((line) =>
    receiptIds.includes(line.goodsReceiptId),
  );
};

const goodsReceiptDetails = goodsReceipts.map((receipt) =>
  goodsReceiptDetailSchema.parse({
    receipt,
    lines: receiptLinesFor(receipt.id),
  }),
);

// ---- Supplier invoices and three-way match (PRD §3.18) -------------------

const invoiceIds = {
  kopi: id(8701),
  susu: id(8702),
  kemasan: id(8703),
} as const;

const supplierInvoiceLineSeeds = [
  {
    id: id(8711),
    supplierInvoiceId: invoiceIds.kopi,
    purchaseOrderLineId: id(8511),
    kind: "goods",
    description: "Kopi Arabika Gayo 12 kg (penerimaan GR/0017)",
    quantity: "12.0000",
    unitPriceIdr: "185000.0000",
  },
  {
    id: id(8712),
    supplierInvoiceId: invoiceIds.kopi,
    purchaseOrderLineId: id(8512),
    kind: "goods",
    description: "Gula Aren 5 kg",
    quantity: "5.0000",
    unitPriceIdr: "24000.0000",
  },
  {
    id: id(8713),
    supplierInvoiceId: invoiceIds.susu,
    purchaseOrderLineId: id(8513),
    kind: "goods",
    description: "Susu UHT Full Cream 24 liter",
    quantity: "24.0000",
    unitPriceIdr: "22000.0000",
  },
  {
    id: id(8714),
    supplierInvoiceId: invoiceIds.kemasan,
    purchaseOrderLineId: id(8514),
    kind: "goods",
    description: "Cup 16oz 4 pack",
    quantity: "4.0000",
    unitPriceIdr: "34000.0000",
  },
  {
    id: id(8715),
    supplierInvoiceId: invoiceIds.kemasan,
    purchaseOrderLineId: id(8515),
    kind: "goods",
    description: "Sedotan Kertas 2 pack",
    quantity: "2.0000",
    unitPriceIdr: "18000.0000",
  },
].map((seed) =>
  supplierInvoiceLineSchema.parse({
    id: seed.id,
    tenantId: tenant.id,
    supplierInvoiceId: seed.supplierInvoiceId,
    purchaseOrderLineId: seed.purchaseOrderLineId,
    kind: seed.kind,
    description: seed.description,
    quantity: seed.quantity,
    unitPriceIdr: seed.unitPriceIdr,
    lineTotalIdr: extendCostIdr(
      decimal4(seed.quantity),
      decimal4(seed.unitPriceIdr),
      "half_up",
    ),
  }),
);

const invoiceLinesFor = (supplierInvoiceId: string) =>
  supplierInvoiceLineSeeds.filter(
    (line) => line.supplierInvoiceId === supplierInvoiceId,
  );

const invoiceSeeds = [
  {
    id: invoiceIds.kopi,
    supplierId: supplierIds.kopi,
    purchaseOrderId: poIds.kopi,
    number: "INV/KP/2026/0914",
    invoiceDate: "2026-11-01",
    dueDate: "2026-11-15",
    ppnIdr: 0,
    pph23Idr: 0,
    paidIdr: 0,
    recordedBy: userId.finance,
    recordedAt: "2026-11-01T03:00:00.000Z",
    matchedAt: "2026-11-01T03:05:00.000Z",
    matchNote: null,
    matchToleranceBp: 200,
  },
  {
    id: invoiceIds.susu,
    supplierId: supplierIds.susu,
    purchaseOrderId: poIds.susu,
    number: "SSB/11/0412",
    invoiceDate: "2026-11-01",
    dueDate: "2026-11-08",
    ppnIdr: 0,
    pph23Idr: 0,
    paidIdr: 528_000,
    recordedBy: userId.finance,
    recordedAt: "2026-11-01T03:10:00.000Z",
    matchedAt: "2026-11-01T03:12:00.000Z",
    matchNote: null,
    matchToleranceBp: 200,
  },
  {
    id: invoiceIds.kemasan,
    supplierId: supplierIds.kemasan,
    purchaseOrderId: poIds.kemasan,
    number: "KN/2026/11/0031",
    invoiceDate: "2026-11-01",
    dueDate: "2026-12-01",
    ppnIdr: 0,
    pph23Idr: 0,
    paidIdr: 0,
    recordedBy: userId.finance,
    recordedAt: "2026-11-01T03:15:00.000Z",
    matchedAt: "2026-11-01T03:20:00.000Z",
    matchNote:
      "Harga cup Rp34.000 melebihi PO Rp32.500 dan qty 4 pack melebihi penerimaan 3 pack.",
    matchToleranceBp: 200,
  },
] as const;

const invoiceDrafts = invoiceSeeds.map((seed) => {
  const lines = invoiceLinesFor(seed.id);
  let goodsIdr = 0;
  let servicesIdr = 0;
  for (const line of lines) {
    if (line.kind === "goods") goodsIdr += line.lineTotalIdr;
    else servicesIdr += line.lineTotalIdr;
  }
  const matchWith = (headerGoodsIdr: number) =>
    threeWayMatch(
      {
        invoice: {
          id: seed.id as SupplierInvoice["id"],
          purchaseOrderId:
            seed.purchaseOrderId as SupplierInvoice["purchaseOrderId"],
          goodsIdr: idr(headerGoodsIdr),
          servicesIdr: idr(servicesIdr),
        },
        invoiceLines: lines,
        purchaseOrderLines: linesForPo(seed.purchaseOrderId),
        goodsReceiptLines: receiptLinesForPo(seed.purchaseOrderId),
        toleranceBp: seed.matchToleranceBp,
        computedAt: seed.matchedAt,
      },
      "half_up",
    );
  // The server derives the header the same way: the line variance first, then
  // goods at PO price = invoice-price goods − variance (it clears GRNI).
  const priceVarianceIdr = matchWith(goodsIdr).priceVarianceIdr;
  goodsIdr -= priceVarianceIdr;
  const match = matchWith(goodsIdr);
  const totalIdr = goodsIdr + priceVarianceIdr + servicesIdr + seed.ppnIdr;
  const payableIdr = totalIdr - seed.pph23Idr;
  const invoice = supplierInvoiceSchema.parse({
    id: seed.id,
    tenantId: tenant.id,
    outletId,
    supplierId: seed.supplierId,
    purchaseOrderId: seed.purchaseOrderId,
    number: seed.number,
    invoiceDate: seed.invoiceDate,
    dueDate: seed.dueDate,
    goodsIdr,
    priceVarianceIdr,
    servicesIdr,
    ppnIdr: seed.ppnIdr,
    pph23Idr: seed.pph23Idr,
    totalIdr,
    payableIdr,
    paidIdr: seed.paidIdr,
    outstandingIdr: payableIdr - seed.paidIdr,
    matchStatus: match.status,
    matchedAt: seed.matchedAt,
    matchNote: seed.matchNote,
    recordedBy: seed.recordedBy,
    recordedAt: seed.recordedAt,
  });
  return { invoice, lines, match };
});

const supplierInvoices = invoiceDrafts.map((draft) => draft.invoice);
const supplierInvoiceDetails = invoiceDrafts.map((draft) =>
  supplierInvoiceDetailSchema.parse({
    invoice: draft.invoice,
    lines: draft.lines,
    match: draft.match,
  }),
);

// ---- Supplier payments (PRD §3.18 pembayaran dengan approval) ------------

const supplierPayments = [
  {
    id: id(8801),
    supplierId: supplierIds.kopi,
    supplierInvoiceId: invoiceIds.kopi,
    amountIdr: supplierInvoices[0].payableIdr,
    method: "bank_transfer",
    reference: null,
    status: "pending_approval",
    requestedBy: userId.finance,
    requestedAt: "2026-11-01T03:30:00.000Z",
    approvedBy: null,
    approvedAt: null,
    paidAt: null,
    note: "Termin 14 hari; jatuh tempo 15 November.",
    createdAt: "2026-11-01T03:30:00.000Z",
  },
  {
    id: id(8802),
    supplierId: supplierIds.susu,
    supplierInvoiceId: invoiceIds.susu,
    amountIdr: supplierInvoices[1].payableIdr,
    method: "virtual_account",
    reference: "VA-8820-1101",
    status: "paid",
    requestedBy: userId.finance,
    requestedAt: "2026-11-01T03:10:00.000Z",
    approvedBy: userId.owner,
    approvedAt: "2026-11-01T03:20:00.000Z",
    paidAt: "2026-11-01T03:25:00.000Z",
    note: null,
    createdAt: "2026-11-01T03:10:00.000Z",
  },
].map((payment) =>
  supplierPaymentSchema.parse({ ...payment, tenantId: tenant.id }),
);

// ---- Purchase returns (PRD §3.18 Retur Pembelian) ------------------------

const purchaseReturnIds = { kopi: id(8901) } as const;

const purchaseReturnLines = [
  {
    id: id(8911),
    purchaseReturnId: purchaseReturnIds.kopi,
    item: "Kopi Arabika Gayo",
    purchaseOrderLineId: id(8511),
    quantity: "1.0000",
    unitCostIdr: "185000.0000",
    batchCode: "KOPI-GAYO-2611",
  },
].map((seed) =>
  purchaseReturnLineSchema.parse({
    id: seed.id,
    tenantId: tenant.id,
    purchaseReturnId: seed.purchaseReturnId,
    inventoryItemId: itemByName(seed.item),
    purchaseOrderLineId: seed.purchaseOrderLineId,
    quantity: seed.quantity,
    unitCostIdr: seed.unitCostIdr,
    lineValueIdr: extendCostIdr(
      decimal4(seed.quantity),
      decimal4(seed.unitCostIdr),
      "half_up",
    ),
    batchCode: seed.batchCode,
  }),
);

const purchaseReturns = [
  {
    id: purchaseReturnIds.kopi,
    supplierId: supplierIds.kopi,
    purchaseOrderId: poIds.kopi,
    goodsReceiptId: grIds.kopi,
    number: "RET/BDG/2026/11/0003",
    returnedOn: "2026-11-02",
    returnedBy: userId.warehouse,
    reason: "damaged",
    valueIdr: purchaseReturnValueIdr(
      purchaseReturnLines.filter(
        (line) => line.purchaseReturnId === purchaseReturnIds.kopi,
      ),
      "half_up",
    ),
    note: "1 kg kopi basah saat pengiriman; diganti pada pengiriman berikutnya.",
    createdAt: "2026-11-02T02:00:00.000Z",
  },
].map((row) =>
  purchaseReturnSchema.parse({ ...row, tenantId: tenant.id, outletId }),
);

const purchaseReturnDetails = purchaseReturns.map((purchaseReturn) =>
  purchaseReturnDetailSchema.parse({
    purchaseReturn,
    lines: purchaseReturnLines.filter(
      (line) => line.purchaseReturnId === purchaseReturn.id,
    ),
  }),
);

// ---- Petty purchase (PRD §3.18 Pembelian Sederhana) ----------------------

const pettyPurchasePolicies = [
  pettyPurchasePolicySchema.parse({
    tenantId: tenant.id,
    outletId: null,
    limitIdr: idr(500_000),
  }),
];

const pettyPurchases = [
  {
    id: id(8951),
    vendorName: "Pasar Kosambi",
    description: "Daun pandan, jeruk nipis, dan garnish bar (nota difoto)",
    amountIdr: idr(285_000),
    photoMediaId: id(9004),
    paidBy: userId.cashier,
    paidAt: "2026-11-01T00:45:00.000Z",
    businessDate: "2026-11-01",
    note: null,
    createdAt: "2026-11-01T00:45:00.000Z",
  },
].map((row) =>
  pettyPurchaseSchema.parse({ ...row, tenantId: tenant.id, outletId }),
);

// ---- Supplier performance (PRD §3.18 ketepatan, kualitas, harga) ---------

const supplierDeliveries: Record<string, SupplierDelivery[]> =
  Object.fromEntries(
    Object.entries({
      [supplierIds.kopi]: [
        {
          purchaseOrderId: poIds.kopi,
          expectedDate: "2026-11-01",
          receivedOn: "2026-11-01",
          quantityReceived: "12.0000",
          quantityRejected: "0.0000",
          invoicedPriceIdr: "185000.0000",
          catalogPriceIdr: "185000.0000",
        },
        {
          purchaseOrderId: poIds.kopi,
          expectedDate: "2026-11-01",
          receivedOn: "2026-11-01",
          quantityReceived: "5.0000",
          quantityRejected: "0.0000",
          invoicedPriceIdr: "24000.0000",
          catalogPriceIdr: "24000.0000",
        },
      ],
      [supplierIds.susu]: [
        {
          purchaseOrderId: poIds.susu,
          expectedDate: "2026-11-01",
          receivedOn: "2026-11-01",
          quantityReceived: "24.0000",
          quantityRejected: "0.0000",
          invoicedPriceIdr: "22000.0000",
          catalogPriceIdr: "22000.0000",
        },
      ],
      [supplierIds.kemasan]: [
        {
          purchaseOrderId: poIds.kemasan,
          expectedDate: "2026-10-31",
          receivedOn: "2026-11-01",
          quantityReceived: "4.0000",
          quantityRejected: "1.0000",
          invoicedPriceIdr: "34000.0000",
          catalogPriceIdr: "32500.0000",
        },
        {
          purchaseOrderId: poIds.kemasan,
          expectedDate: "2026-10-31",
          receivedOn: "2026-11-01",
          quantityReceived: "2.0000",
          quantityRejected: "0.0000",
          invoicedPriceIdr: "18000.0000",
          catalogPriceIdr: "18000.0000",
        },
      ],
    }).map(([supplierId, deliveries]) => [
      supplierId,
      deliveries.map((delivery) => supplierDeliverySchema.parse(delivery)),
    ]),
  );

const supplierPerformances = suppliers.map((supplier) =>
  supplierPerformance(
    {
      tenantId: tenant.id,
      supplierId: supplier.id,
      fromDate: "2026-11-01",
      toDate: "2026-11-30",
      deliveries: supplierDeliveries[supplier.id] ?? [],
      computedAt: "2026-11-01T04:00:00.000Z",
    },
    "half_up",
  ),
);

// ---- The exported fixture object -----------------------------------------

export const purchasingFixtureSchema = z.strictObject({
  suppliers: z.array(supplierSchema),
  supplierContacts: z.array(supplierContactSchema),
  supplierCatalog: z.array(supplierCatalogItemSchema),
  supplierPerformances: z.array(supplierPerformanceSchema),
  purchaseRequests: z.array(purchaseRequestSchema),
  purchaseRequestLines: z.array(purchaseRequestLineSchema),
  purchaseRequestDetails: z.array(purchaseRequestDetailSchema),
  purchaseOrders: z.array(purchaseOrderSchema),
  purchaseOrderLines: z.array(purchaseOrderLineSchema),
  purchaseOrderDetails: z.array(purchaseOrderDetailSchema),
  goodsReceipts: z.array(goodsReceiptSchema),
  goodsReceiptLines: z.array(goodsReceiptLineSchema),
  goodsReceiptDetails: z.array(goodsReceiptDetailSchema),
  supplierInvoices: z.array(supplierInvoiceSchema),
  supplierInvoiceLines: z.array(supplierInvoiceLineSchema),
  supplierInvoiceDetails: z.array(supplierInvoiceDetailSchema),
  supplierPayments: z.array(supplierPaymentSchema),
  purchaseReturns: z.array(purchaseReturnSchema),
  purchaseReturnLines: z.array(purchaseReturnLineSchema),
  purchaseReturnDetails: z.array(purchaseReturnDetailSchema),
  pettyPurchases: z.array(pettyPurchaseSchema),
  pettyPurchasePolicies: z.array(pettyPurchasePolicySchema),
  /** Reference values for the fixtures above, used by FE mock screens. */
  pettyPurchaseLimitIdr: idrSchema,
  receivedValueIdr: z.record(z.string(), idrSchema),
});

export const cafeLegendPurchasingFixtures = purchasingFixtureSchema.parse({
  suppliers,
  supplierContacts,
  supplierCatalog,
  supplierPerformances,
  purchaseRequests,
  purchaseRequestLines: purchaseRequestLineSeeds,
  purchaseRequestDetails,
  purchaseOrders,
  purchaseOrderLines: purchaseOrderLineSeeds,
  purchaseOrderDetails,
  goodsReceipts,
  goodsReceiptLines: goodsReceiptLineSeeds,
  goodsReceiptDetails,
  supplierInvoices,
  supplierInvoiceLines: supplierInvoiceLineSeeds,
  supplierInvoiceDetails,
  supplierPayments,
  purchaseReturns,
  purchaseReturnLines,
  purchaseReturnDetails,
  pettyPurchases,
  pettyPurchasePolicies,
  pettyPurchaseLimitIdr: idr(500_000),
  receivedValueIdr: {
    [poIds.kopi]: goodsReceiptValueIdr(
      receiptLinesForPo(poIds.kopi),
      "half_up",
    ),
    [poIds.susu]: goodsReceiptValueIdr(
      receiptLinesForPo(poIds.susu),
      "half_up",
    ),
    [poIds.kemasan]: goodsReceiptValueIdr(
      receiptLinesForPo(poIds.kemasan),
      "half_up",
    ),
  },
});

/** Price of one catalog item on a date, for the supplier detail screen. */
export function fixtureSupplierPrice(
  supplierId: string,
  inventoryItemName: string,
  onDate: string,
): string | null {
  return (
    supplierPriceOnDate(supplierCatalog, {
      supplierId,
      inventoryItemId: itemByName(inventoryItemName),
      onDate: businessDateSchema.parse(onDate),
    })?.priceIdr ?? null
  );
}
