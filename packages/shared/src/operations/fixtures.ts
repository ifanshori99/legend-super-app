// Cafe Legend daily-operations fixtures for FE mock mode and contract tests
// (bead legend-ptd8). Realistic but illustrative: one operating day at the
// Bandung outlet with opening/closing/cleaning/shift checklists, chiller and
// freezer temperature logs (one corrected excursion each), prep labels for the
// cold-brew batch and opened milk, today's prep list, the equipment registry
// with service schedules and breakdown tickets, and two shift handovers.
//
// Cross-contract references point at the real fixtures: people and roles from
// the access contract, shift templates from HRIS, zones from QR ordering, menu
// items from the menu contract, and inventory items/batches/production orders
// from inventory. Ids are fixed so screens and tests can address rows.

import { cafeLegendFixtures, isoDateTimeSchema, z } from "../core/index.ts";
import { cafeLegendAccessFixtures } from "../access/fixtures.ts";
import { cafeLegendHrisFixtures } from "../hris/fixtures.ts";
import {
  cafeLegendInventoryFixtures,
  cafeLegendPurchasingFixtures,
} from "../inventory/index.ts";
import { cafeLegendMenuFixtures } from "../menu/index.ts";
import { cafeLegendQrOrderFixtures } from "../qr-order/index.ts";
import {
  checklistItemResultSchema,
  checklistRunSchema,
  checklistTemplateSchema,
  equipmentSchema,
  maintenanceScheduleSchema,
  maintenanceTicketSchema,
  prepLabelSchema,
  prepListSchema,
  shiftHandoverSchema,
  temperatureLogSchema,
} from "./schemas.ts";
import type {
  ChecklistRun,
  ChecklistTemplate,
  Equipment,
  MaintenanceSchedule,
  MaintenanceTicket,
  PrepLabel,
  PrepList,
  ShiftHandover,
  TemperatureLog,
} from "./schemas.ts";

const { tenant, outlets } = cafeLegendFixtures;
const outletId = outlets[0].id;
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const people = cafeLegendAccessFixtures.users;
const roleByTemplate = (key: string) => {
  const role = cafeLegendAccessFixtures.roles.find(
    (row) => row.templateKey === key,
  );
  if (!role) throw new Error(`Missing role template fixture "${key}"`);
  return role.id;
};
const stationByCode = (code: string) => {
  const station = cafeLegendAccessFixtures.stations.find(
    (row) => row.code === code,
  );
  if (!station) throw new Error(`Missing station fixture "${code}"`);
  return station.id;
};
const shiftByName = (name: string) => {
  const shift = cafeLegendHrisFixtures.shiftTemplates.find(
    (row) => row.name === name,
  );
  if (!shift) throw new Error(`Missing shift template fixture "${name}"`);
  return shift;
};
const pagi = shiftByName("Pagi");
const siang = shiftByName("Siang");
const malam = shiftByName("Malam");
const indoorZone = cafeLegendQrOrderFixtures.zones[0];

const menuItem = (name: string) => {
  const item = cafeLegendMenuFixtures.items.find((row) => row.name === name);
  if (!item) throw new Error(`Missing menu fixture "${name}"`);
  return item.id;
};
const inventoryItem = (name: string) => {
  const item = cafeLegendInventoryFixtures.items.find(
    (row) => row.name === name,
  );
  if (!item) throw new Error(`Missing inventory fixture "${name}"`);
  return item.id;
};
const stockBatch = (batchCode: string) => {
  const batch = cafeLegendInventoryFixtures.batches.find(
    (row) => row.batchCode === batchCode,
  );
  if (!batch) throw new Error(`Missing stock batch fixture "${batchCode}"`);
  return batch.id;
};
const productionOrder = (n: number) => {
  const order = cafeLegendInventoryFixtures.productionOrders.find(
    (row) => row.id === id(n),
  );
  if (!order) throw new Error(`Missing production order fixture ${n}`);
  return order.id;
};

/** Service vendors are purchasing suppliers (owner decision, legend-uy1e).
 * The coffee supplier also services the bar's coffee machines; the purchasing
 * fixtures have no dedicated technician yet, so other equipment has none. */
const supplierByName = (name: string) => {
  const supplier = cafeLegendPurchasingFixtures.suppliers.find(
    (row) => row.name === name,
  );
  if (!supplier) throw new Error(`Missing supplier fixture "${name}"`);
  return supplier.id;
};
const coffeeMachineVendor = supplierByName("CV Kopi Priangan");

/** A clock after the day's deadlines, so overdue fixtures stay overdue. */
const now = "2026-11-01T12:00:00.000Z";

// ---- Checklist items ------------------------------------------------------

const openingItems = [
  {
    id: id(8111),
    label: "Buka pintu, matikan alarm, dan nyalakan lampu",
    instruction: null,
    requiredEvidence: [],
  },
  {
    id: id(8112),
    label: "Cek kebersihan area depan dan meja",
    instruction: "Foto area depan setelah dibersihkan.",
    requiredEvidence: ["photo"],
  },
  {
    id: id(8113),
    label: "Catat suhu chiller bar",
    instruction: "Pembacaan dari termometer digital chiller bar.",
    requiredEvidence: ["number"],
  },
  {
    id: id(8114),
    label: "Hitung kas awal laci",
    instruction: null,
    requiredEvidence: ["number", "signature"],
  },
];

const closingItems = [
  {
    id: id(8121),
    label: "Matikan peralatan dapur yang tidak dipakai",
    instruction: null,
    requiredEvidence: [],
  },
  {
    id: id(8122),
    label: "Cek semua pintu dan jendela terkunci",
    instruction: "Foto pintu belakang setelah dikunci.",
    requiredEvidence: ["photo"],
  },
  {
    id: id(8123),
    label: "Rekap kas akhir shift",
    instruction: null,
    requiredEvidence: ["number", "signature"],
  },
];

const cleaningItems = [
  {
    id: id(8131),
    label: "Bersihkan lantai, wastafel, dan cermin",
    instruction: "Foto kondisi toilet setelah dibersihkan.",
    requiredEvidence: ["photo"],
  },
  {
    id: id(8132),
    label: "Isi ulang sabun dan tisu",
    instruction: null,
    requiredEvidence: [],
  },
  {
    id: id(8133),
    label: "Catat sisa stok sabun",
    instruction: null,
    requiredEvidence: ["number"],
  },
];

const barShiftItems = [
  {
    id: id(8141),
    label: "Bersihkan group head mesin espresso",
    instruction: "Foto group head setelah backflush.",
    requiredEvidence: ["photo"],
  },
  {
    id: id(8142),
    label: "Catat suhu susu di chiller bar",
    instruction: null,
    requiredEvidence: ["number"],
  },
  {
    id: id(8143),
    label: "Tanda tangan serah terima bar",
    instruction: null,
    requiredEvidence: ["signature"],
  },
];

// ---- Checklist templates --------------------------------------------------

const checklistTemplates: ChecklistTemplate[] = [
  checklistTemplateSchema.parse({
    id: id(8101),
    tenantId: tenant.id,
    outletId,
    name: "Checklist Buka Toko",
    type: "opening",
    items: openingItems,
    schedule: {
      shiftTemplateId: pagi.id,
      stationId: null,
      zoneId: null,
      dueTime: "08:30",
    },
    version: 1,
    roleId: roleByTemplate("supervisor"),
    updatedAt: "2026-10-25T02:00:00.000Z",
  }),
  checklistTemplateSchema.parse({
    id: id(8102),
    tenantId: tenant.id,
    outletId,
    name: "Checklist Tutup Toko",
    type: "closing",
    items: closingItems,
    schedule: {
      shiftTemplateId: siang.id,
      stationId: null,
      zoneId: null,
      dueTime: "22:15",
    },
    version: 1,
    roleId: roleByTemplate("supervisor"),
    updatedAt: "2026-10-25T02:00:00.000Z",
  }),
  checklistTemplateSchema.parse({
    id: id(8103),
    tenantId: tenant.id,
    outletId,
    name: "Checklist Kebersihan Toilet Umum",
    type: "cleaning",
    items: cleaningItems,
    schedule: {
      shiftTemplateId: malam.id,
      stationId: null,
      zoneId: indoorZone.id,
      dueTime: "23:00",
    },
    version: 1,
    roleId: roleByTemplate("facility_attendant"),
    updatedAt: "2026-10-25T02:00:00.000Z",
  }),
  checklistTemplateSchema.parse({
    id: id(8104),
    tenantId: tenant.id,
    outletId,
    name: "Checklist Pengecekan Bar Kopi",
    type: "shift",
    items: barShiftItems,
    schedule: {
      shiftTemplateId: siang.id,
      stationId: stationByCode("bar_kopi"),
      zoneId: null,
      dueTime: "16:00",
    },
    version: 1,
    roleId: roleByTemplate("barista_cook"),
    updatedAt: "2026-10-25T02:00:00.000Z",
  }),
];

// ---- Checklist runs -------------------------------------------------------

/** Each run carries its own copy of the template items (owner decision). */
const snapshotOf = (templateId: string) => {
  const template = checklistTemplates.find((row) => row.id === templateId);
  if (!template) throw new Error(`Missing checklist template ${templateId}`);
  return {
    templateId: template.id,
    templateVersion: template.version,
    items: template.items,
  };
};

const finished = (
  itemId: string,
  status: "done" | "failed",
  completedAt: string,
  completedBy: string,
  extra: Partial<z.input<typeof checklistItemResultSchema>> = {},
): z.input<typeof checklistItemResultSchema> => ({
  itemId,
  status,
  numberValue: null,
  note: null,
  photoMediaIds: [],
  signatureMediaId: null,
  completedAt,
  completedBy,
  ...extra,
});

const pendingResult = (
  itemId: string,
): z.input<typeof checklistItemResultSchema> => ({
  itemId,
  status: "pending",
  numberValue: null,
  note: null,
  photoMediaIds: [],
  signatureMediaId: null,
  completedAt: null,
  completedBy: null,
});

const openingRun = {
  id: id(8201),
  tenantId: tenant.id,
  outletId,
  ...snapshotOf(id(8101)),
  shiftDate: "2026-11-01",
  shiftTemplateId: pagi.id,
  assignedTo: people.supervisor.id,
  dueAt: "2026-11-01T01:30:00.000Z",
  completedAt: "2026-11-01T01:20:00.000Z",
  status: "completed",
  missedAt: null,
  alertedAt: null,
  results: [
    finished(
      id(8111),
      "done",
      "2026-11-01T01:05:00.000Z",
      people.supervisor.id,
    ),
    finished(
      id(8112),
      "done",
      "2026-11-01T01:08:00.000Z",
      people.supervisor.id,
      { photoMediaIds: [id(9001)] },
    ),
    finished(id(8113), "done", "2026-11-01T01:14:00.000Z", people.barista.id, {
      numberValue: "3.5000",
    }),
    finished(
      id(8114),
      "done",
      "2026-11-01T01:20:00.000Z",
      people.supervisor.id,
      { numberValue: "500000.0000", signatureMediaId: id(9002) },
    ),
  ],
};

const closingRun = {
  id: id(8202),
  tenantId: tenant.id,
  outletId,
  ...snapshotOf(id(8102)),
  shiftDate: "2026-11-01",
  shiftTemplateId: siang.id,
  assignedTo: people.supervisor.id,
  dueAt: "2026-11-01T15:15:00.000Z",
  completedAt: null,
  status: "pending",
  missedAt: null,
  alertedAt: null,
  results: [
    pendingResult(id(8121)),
    pendingResult(id(8122)),
    pendingResult(id(8123)),
  ],
};

const cleaningRun = {
  id: id(8203),
  tenantId: tenant.id,
  outletId,
  ...snapshotOf(id(8103)),
  shiftDate: "2026-11-01",
  shiftTemplateId: malam.id,
  assignedTo: people.facilityAttendant.id,
  dueAt: "2026-11-01T16:00:00.000Z",
  completedAt: null,
  status: "in_progress",
  missedAt: null,
  alertedAt: null,
  results: [
    finished(
      id(8131),
      "done",
      "2026-11-01T15:40:00.000Z",
      people.facilityAttendant.id,
      { photoMediaIds: [id(9003)] },
    ),
    pendingResult(id(8132)),
    pendingResult(id(8133)),
  ],
};

const missedRun = {
  id: id(8204),
  tenantId: tenant.id,
  outletId,
  ...snapshotOf(id(8104)),
  shiftDate: "2026-10-31",
  shiftTemplateId: siang.id,
  assignedTo: people.barista.id,
  dueAt: "2026-10-31T09:00:00.000Z",
  completedAt: null,
  status: "missed",
  missedAt: "2026-10-31T09:12:00.000Z",
  alertedAt: "2026-10-31T09:12:00.000Z",
  results: [
    finished(id(8141), "done", "2026-10-31T08:40:00.000Z", people.barista.id, {
      photoMediaIds: [id(9004)],
    }),
    pendingResult(id(8142)),
    pendingResult(id(8143)),
  ],
};

const failedRun = {
  id: id(8205),
  tenantId: tenant.id,
  outletId,
  ...snapshotOf(id(8101)),
  shiftDate: "2026-10-31",
  shiftTemplateId: pagi.id,
  assignedTo: people.supervisor.id,
  dueAt: "2026-10-31T01:30:00.000Z",
  completedAt: "2026-10-31T01:25:00.000Z",
  status: "failed",
  missedAt: null,
  alertedAt: null,
  results: [
    finished(
      id(8111),
      "done",
      "2026-10-31T01:05:00.000Z",
      people.supervisor.id,
    ),
    finished(
      id(8112),
      "done",
      "2026-10-31T01:08:00.000Z",
      people.supervisor.id,
      { photoMediaIds: [id(9005)] },
    ),
    finished(
      id(8113),
      "failed",
      "2026-10-31T01:15:00.000Z",
      people.barista.id,
      {
        numberValue: "9.2000",
        note: "Chiller bar di atas ambang; susu dipindahkan ke chiller cadangan.",
      },
    ),
    finished(
      id(8114),
      "done",
      "2026-10-31T01:25:00.000Z",
      people.supervisor.id,
      { numberValue: "500000.0000", signatureMediaId: id(9006) },
    ),
  ],
};

const checklistRuns: ChecklistRun[] = [
  checklistRunSchema.parse(openingRun),
  checklistRunSchema.parse(closingRun),
  checklistRunSchema.parse(cleaningRun),
  checklistRunSchema.parse(missedRun),
  checklistRunSchema.parse(failedRun),
];

// ---- Equipment ------------------------------------------------------------

const equipment: Equipment[] = [
  equipmentSchema.parse({
    id: id(8301),
    tenantId: tenant.id,
    outletId,
    name: "Chiller Bar",
    category: "chiller",
    assetId: null,
    linkedMenuItemIds: [],
    status: "operational",
    temperatureThreshold: { minCelsius: "1.0000", maxCelsius: "4.0000" },
    updatedAt: "2026-11-01T01:00:00.000Z",
  }),
  equipmentSchema.parse({
    id: id(8302),
    tenantId: tenant.id,
    outletId,
    name: "Freezer Dapur",
    category: "freezer",
    assetId: null,
    linkedMenuItemIds: [],
    status: "operational",
    temperatureThreshold: { minCelsius: "-22.0000", maxCelsius: "-16.0000" },
    updatedAt: "2026-11-01T01:00:00.000Z",
  }),
  equipmentSchema.parse({
    id: id(8303),
    tenantId: tenant.id,
    outletId,
    name: "Mesin Espresso La Marzocco Linea",
    category: "espresso_machine",
    assetId: null,
    linkedMenuItemIds: [
      menuItem("Espresso"),
      menuItem("Americano"),
      menuItem("Cappuccino"),
      menuItem("Cafe Latte"),
      menuItem("Kopi Susu Aren"),
    ],
    status: "operational",
    temperatureThreshold: null,
    updatedAt: "2026-11-01T01:00:00.000Z",
  }),
  equipmentSchema.parse({
    id: id(8304),
    tenantId: tenant.id,
    outletId,
    name: "Grinder Mahlkönig E80",
    category: "grinder",
    assetId: null,
    linkedMenuItemIds: [
      menuItem("Espresso"),
      menuItem("Long Black"),
      menuItem("Cold Brew"),
    ],
    status: "operational",
    temperatureThreshold: null,
    updatedAt: "2026-11-01T01:00:00.000Z",
  }),
  equipmentSchema.parse({
    id: id(8305),
    tenantId: tenant.id,
    outletId,
    name: "Blender Bar Nonkopi",
    category: "blender",
    assetId: null,
    linkedMenuItemIds: [
      menuItem("Jus Alpukat"),
      menuItem("Jus Mangga"),
      menuItem("Es Cokelat"),
    ],
    status: "broken",
    temperatureThreshold: null,
    updatedAt: "2026-11-01T03:05:00.000Z",
  }),
  equipmentSchema.parse({
    id: id(8306),
    tenantId: tenant.id,
    outletId,
    name: "Oven Deck Pastry",
    category: "oven",
    assetId: null,
    linkedMenuItemIds: [
      menuItem("Croissant Mentega"),
      menuItem("Croissant Cokelat"),
      menuItem("Banana Bread"),
    ],
    status: "operational",
    temperatureThreshold: null,
    updatedAt: "2026-10-30T09:00:00.000Z",
  }),
  equipmentSchema.parse({
    id: id(8307),
    tenantId: tenant.id,
    outletId,
    name: "Filter Air Bar",
    category: "water_filter",
    assetId: null,
    linkedMenuItemIds: [],
    status: "operational",
    temperatureThreshold: null,
    updatedAt: "2026-11-01T01:00:00.000Z",
  }),
  equipmentSchema.parse({
    id: id(8308),
    tenantId: tenant.id,
    outletId,
    name: "AC Ruang Utama",
    category: "air_conditioner",
    assetId: null,
    linkedMenuItemIds: [],
    status: "under_maintenance",
    temperatureThreshold: null,
    updatedAt: "2026-10-31T04:00:00.000Z",
  }),
  equipmentSchema.parse({
    id: id(8309),
    tenantId: tenant.id,
    outletId,
    name: "Water Heater Shower",
    category: "water_heater",
    assetId: null,
    linkedMenuItemIds: [],
    status: "operational",
    temperatureThreshold: null,
    updatedAt: "2026-11-01T01:00:00.000Z",
  }),
];

// ---- Maintenance ----------------------------------------------------------

const maintenanceSchedules: MaintenanceSchedule[] = [
  maintenanceScheduleSchema.parse({
    id: id(8801),
    tenantId: tenant.id,
    outletId,
    equipmentId: id(8303),
    intervalDays: 90,
    nextDueAt: "2026-12-15T02:00:00.000Z",
    vendorId: coffeeMachineVendor,
    updatedAt: "2026-10-01T02:00:00.000Z",
  }),
  maintenanceScheduleSchema.parse({
    id: id(8802),
    tenantId: tenant.id,
    outletId,
    equipmentId: id(8304),
    intervalDays: 120,
    nextDueAt: "2026-11-20T02:00:00.000Z",
    vendorId: coffeeMachineVendor,
    updatedAt: "2026-10-01T02:00:00.000Z",
  }),
  maintenanceScheduleSchema.parse({
    id: id(8803),
    tenantId: tenant.id,
    outletId,
    equipmentId: id(8301),
    intervalDays: 180,
    nextDueAt: "2026-11-10T02:00:00.000Z",
    vendorId: null,
    updatedAt: "2026-10-01T02:00:00.000Z",
  }),
  maintenanceScheduleSchema.parse({
    id: id(8804),
    tenantId: tenant.id,
    outletId,
    equipmentId: id(8309),
    intervalDays: 365,
    nextDueAt: "2026-12-01T02:00:00.000Z",
    vendorId: null,
    updatedAt: "2026-10-01T02:00:00.000Z",
  }),
];

const maintenanceTickets: MaintenanceTicket[] = [
  maintenanceTicketSchema.parse({
    id: id(8701),
    tenantId: tenant.id,
    outletId,
    equipmentId: id(8305),
    reportedBy: people.barista.id,
    urgency: "medium",
    description: "Pisau blender berhenti berputar saat menggiling es.",
    mediaIds: [id(9010)],
    vendorId: coffeeMachineVendor,
    costIdr: null,
    status: "reported",
    marksEquipmentBroken: true,
    reportedAt: "2026-11-01T03:00:00.000Z",
    resolvedAt: null,
  }),
  maintenanceTicketSchema.parse({
    id: id(8702),
    tenantId: tenant.id,
    outletId,
    equipmentId: id(8306),
    reportedBy: people.cook.id,
    urgency: "high",
    description: "Elemen pemanas atas oven tidak panas.",
    mediaIds: [id(9011), id(9012)],
    vendorId: null,
    costIdr: 850_000,
    status: "resolved",
    marksEquipmentBroken: true,
    reportedAt: "2026-10-28T02:00:00.000Z",
    resolvedAt: "2026-10-30T09:00:00.000Z",
  }),
  maintenanceTicketSchema.parse({
    id: id(8703),
    tenantId: tenant.id,
    outletId,
    equipmentId: id(8308),
    reportedBy: people.supervisor.id,
    urgency: "low",
    description: "AC bergetar dan berbunyi saat kompresor menyala.",
    mediaIds: [id(9013)],
    vendorId: null,
    costIdr: null,
    status: "in_progress",
    marksEquipmentBroken: false,
    reportedAt: "2026-10-31T04:00:00.000Z",
    resolvedAt: null,
  }),
];

// ---- Temperature logs -----------------------------------------------------

const temperatureLogs: TemperatureLog[] = [
  temperatureLogSchema.parse({
    id: id(8311),
    tenantId: tenant.id,
    outletId,
    equipmentId: id(8301),
    readingCelsius: "3.5000",
    recordedAt: "2026-11-01T01:10:00.000Z",
    recordedBy: people.barista.id,
    inRange: true,
    correctiveAction: null,
  }),
  temperatureLogSchema.parse({
    id: id(8312),
    tenantId: tenant.id,
    outletId,
    equipmentId: id(8301),
    readingCelsius: "9.2000",
    recordedAt: "2026-11-01T07:05:00.000Z",
    recordedBy: people.barista.id,
    inRange: false,
    correctiveAction:
      "Susu dipindahkan ke chiller cadangan; teknisi chiller dipanggil.",
  }),
  temperatureLogSchema.parse({
    id: id(8313),
    tenantId: tenant.id,
    outletId,
    equipmentId: id(8302),
    readingCelsius: "-18.0000",
    recordedAt: "2026-11-01T02:00:00.000Z",
    recordedBy: people.cook.id,
    inRange: true,
    correctiveAction: null,
  }),
  temperatureLogSchema.parse({
    id: id(8314),
    tenantId: tenant.id,
    outletId,
    equipmentId: id(8302),
    readingCelsius: "-12.5000",
    recordedAt: "2026-11-01T11:30:00.000Z",
    recordedBy: people.cook.id,
    inRange: false,
    correctiveAction:
      "Pintu freezer ditutup rapat; ayam dipindahkan ke freezer dapur.",
  }),
];

// ---- Prep labels and prep list -------------------------------------------

const prepLabels: PrepLabel[] = [
  prepLabelSchema.parse({
    id: id(8401),
    tenantId: tenant.id,
    outletId,
    inventoryItemId: inventoryItem("Cold Brew Concentrate"),
    batchId: stockBatch("CB-1101"),
    producedAt: "2026-11-01T02:05:00.000Z",
    useBy: "2026-11-08T02:05:00.000Z",
    producedBy: people.barista.id,
    printedAt: "2026-11-01T02:06:00.000Z",
  }),
  prepLabelSchema.parse({
    id: id(8402),
    tenantId: tenant.id,
    outletId,
    inventoryItemId: inventoryItem("Susu UHT Full Cream"),
    batchId: stockBatch("SUSU-1101-A"),
    producedAt: "2026-11-01T01:00:00.000Z",
    useBy: "2026-11-02T01:00:00.000Z",
    producedBy: people.barista.id,
    printedAt: "2026-11-01T01:02:00.000Z",
  }),
  prepLabelSchema.parse({
    id: id(8403),
    tenantId: tenant.id,
    outletId,
    inventoryItemId: inventoryItem("Susu UHT Full Cream"),
    batchId: stockBatch("SUSU-1101-B"),
    producedAt: "2026-10-30T01:00:00.000Z",
    useBy: "2026-10-31T01:00:00.000Z",
    producedBy: people.barista.id,
    printedAt: null,
  }),
];

const prepLists: PrepList[] = [
  prepListSchema.parse({
    id: id(8501),
    tenantId: tenant.id,
    outletId,
    prepDate: "2026-11-01",
    lines: [
      {
        id: id(8511),
        inventoryItemId: inventoryItem("Cold Brew Concentrate"),
        plannedQuantity: "5.0000",
        productionOrderId: productionOrder(7951),
      },
      {
        id: id(8512),
        inventoryItemId: inventoryItem("Gula Aren Cair"),
        plannedQuantity: "3.0000",
        productionOrderId: null,
      },
    ],
    status: "in_progress",
    generatedFromForecastId: id(8601),
    generatedAt: "2026-11-01T00:30:00.000Z",
  }),
];

// ---- Shift handovers ------------------------------------------------------

const shiftHandovers: ShiftHandover[] = [
  shiftHandoverSchema.parse({
    id: id(8901),
    tenantId: tenant.id,
    outletId,
    fromShiftTemplateId: siang.id,
    toShiftTemplateId: malam.id,
    notes: {
      cash: "Kas shift siang sesuai, selisih Rp0.",
      criticalStock: "Susu UHT tinggal 8 liter; gula aren cair 3 liter.",
      openComplaints: null,
      equipmentIssues: "Blender bar nonkopi tidak mau berputar.",
      specialNotes: null,
    },
    submittedBy: people.supervisor.id,
    submittedAt: "2026-11-01T15:05:00.000Z",
    acknowledgedBy: null,
    acknowledgedAt: null,
    status: "submitted",
  }),
  shiftHandoverSchema.parse({
    id: id(8902),
    tenantId: tenant.id,
    outletId,
    fromShiftTemplateId: pagi.id,
    toShiftTemplateId: siang.id,
    notes: {
      cash: "Kas pagi sesuai catatan kasir.",
      criticalStock: null,
      openComplaints: "Satu tamu menunggu kursi outdoor lebih dari 20 menit.",
      equipmentIssues: null,
      specialNotes: "Private room Nusantara dipesan pukul 19:00.",
    },
    submittedBy: people.supervisor.id,
    submittedAt: "2026-10-31T09:00:00.000Z",
    acknowledgedBy: people.supervisor2.id,
    acknowledgedAt: "2026-10-31T09:10:00.000Z",
    status: "acknowledged",
  }),
];

// ---- Fixture bundle -------------------------------------------------------

export const operationsFixtureSchema = z.strictObject({
  now: isoDateTimeSchema,
  checklistTemplates: z.array(checklistTemplateSchema),
  checklistRuns: z.array(checklistRunSchema),
  equipment: z.array(equipmentSchema),
  maintenanceSchedules: z.array(maintenanceScheduleSchema),
  maintenanceTickets: z.array(maintenanceTicketSchema),
  temperatureLogs: z.array(temperatureLogSchema),
  prepLabels: z.array(prepLabelSchema),
  prepLists: z.array(prepListSchema),
  shiftHandovers: z.array(shiftHandoverSchema),
});

export const cafeLegendOperationsFixtures = operationsFixtureSchema.parse({
  now,
  checklistTemplates,
  checklistRuns,
  equipment,
  maintenanceSchedules,
  maintenanceTickets,
  temperatureLogs,
  prepLabels,
  prepLists,
  shiftHandovers,
});
