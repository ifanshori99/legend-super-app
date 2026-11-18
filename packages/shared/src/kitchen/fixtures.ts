// Cafe Legend kitchen fixtures (bead legend-acz) for FE mock mode and the
// contract test. Sunday lunch service at Cafe Legend Bandung, WIB = UTC+7, so
// 03:52Z is 10:52 local. Illustrative like the menu fixtures: the owner has not
// confirmed stations, capacity points or staff.
//
// Tenant, brand, outlet and the order id come from the core fixtures; station
// and menu item ids come from the menu fixtures (@starter/shared/menu), so the
// three contracts reference the same records.

import { fixtureTimeAfter } from "../core/fixture-clock.ts";
import { z, cafeLegendFixtures } from "../core/index.ts";
import {
  kitchenFixtureSchema,
  orderIssueViewSchema,
  stationCapacityRuleSchema,
  stationLabelSchema,
} from "./schemas.ts";

// Fixtures are written as plain data (`z.input`): branded ids appear only after
// the schema parses them, which is what the fixture test and the API do.
type KitchenFixtureInput = z.input<typeof kitchenFixtureSchema>;

const { tenant, outlets } = cafeLegendFixtures;
const outletId = outlets[0].id;
const scope = { tenantId: tenant.id, outletId };
const scope2 = { tenantId: tenant.id, outletId: outlets[1].id };
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Menu fixtures: stations 200-203, items 1000+group*100+index.
const stationId = {
  coffee: id(200),
  beverage: id(201),
  kitchen: id(202),
  pastry: id(203),
  // Second outlet (Bandung 2), mirrors coffee (legend-7art).
  coffee2: id(205),
};
const menuItemId = {
  kopiSusuAren: id(1004),
  flatWhite: id(1005),
  matchaLatte: id(1102),
  nasiGorengKampung: id(1200),
  ayamGeprek: id(1205),
  supBuntut: id(1208),
  sateAyam: id(1209),
  kentangGoreng: id(1213),
  croissant: id(1300),
};
// Staff and devices (illustrative).
const staffId = {
  cook: id(500),
  barista: id(501),
  pastry: id(502),
  supervisor: id(503),
  cashier: id(504),
  runner: id(505),
  // Two more floor staff the expo screen can assign as runner (F12).
  waiter: id(506),
  waiter2: id(507),
};
const deviceId = { kdsKitchen: id(600), kdsCoffee: id(601) };

// Orders: the core fixture order plus illustrative siblings (ULID, §6).
const orderId = cafeLegendFixtures.orderId;
const orderIds = {
  dineIn: orderId,
  gofood: "01JBQ7Z8K0A1B2C3D4E5F6G7H9",
  dineInPastry: "01JBQ7Z8K0A1B2C3D4E5F6G7HA",
  takeaway: "01JBQ7Z8K0A1B2C3D4E5F6G7HB",
  takeawayDone: "01JBQ7Z8K0A1B2C3D4E5F6G7HC",
};
/** Table label and channel the KDS header shows per order (legend-rutl). */
export const orderHeaders: Record<
  string,
  { tableLabel: string | null; channel: "dine_in" | "takeaway" | "gofood" }
> = {
  [orderIds.dineIn]: { tableLabel: "A3", channel: "dine_in" },
  [orderIds.gofood]: { tableLabel: null, channel: "gofood" },
  [orderIds.dineInPastry]: { tableLabel: "B7", channel: "dine_in" },
  [orderIds.takeaway]: { tableLabel: null, channel: "takeaway" },
  [orderIds.takeawayDone]: { tableLabel: null, channel: "takeaway" },
};
const orderItemIds = [
  "01JBQ7Z8K3M4N5P6Q7R8S9T0VY",
  "01JBQ7Z8K4M4N5P6Q7R8S9T0VY",
  "01JBQ7Z8K5M4N5P6Q7R8S9T0VY",
  "01JBQ7Z8K6M4N5P6Q7R8S9T0VY",
  "01JBQ7Z8K7M4N5P6Q7R8S9T0VY",
  "01JBQ7Z8K8M4N5P6Q7R8S9T0VY",
  "01JBQ7Z8K9M4N5P6Q7R8S9T0VY",
  "01JBQ7Z8KAM4N5P6Q7R8S9T0VY",
];

const ticket = (suffix: number) => `01JBQ7Z8T0A1B2C3D4E5F6G7H${suffix}`;
const ticketItemId = (suffix: number) => `01JBQ7Z8X0A1B2C3D4E5F6G7H${suffix}`;
let changeCounter = 0;
const changeSuffix = "0123456789ABCDEFGH";
const changeId = () =>
  `01JBQ7Z9Y0A1B2C3D4E5F6G7H${changeSuffix[changeCounter++]}`;

const ticketIds = {
  kitchenDone: ticket(0),
  coffeeInProgress: ticket(1),
  kitchenNew: ticket(2),
  pastryRecalled: ticket(3),
  beverageCancelled: ticket(4),
  coffeeDone: ticket(5),
  kitchenReady: ticket(6),
};

export const stationConfigs: KitchenFixtureInput["stationConfigs"] = [
  {
    ...scope,
    id: id(700),
    stationId: stationId.coffee,
    displayOrder: 0,
    isActive: true,
    autoPrintFallback: true,
  },
  {
    ...scope,
    id: id(701),
    stationId: stationId.beverage,
    displayOrder: 1,
    isActive: true,
    autoPrintFallback: true,
  },
  {
    ...scope,
    id: id(702),
    stationId: stationId.kitchen,
    displayOrder: 2,
    isActive: true,
    autoPrintFallback: true,
  },
  {
    ...scope,
    id: id(703),
    stationId: stationId.pastry,
    displayOrder: 3,
    isActive: true,
    autoPrintFallback: false,
  },
  {
    ...scope2,
    id: id(704),
    stationId: stationId.coffee2,
    displayOrder: 0,
    isActive: true,
    autoPrintFallback: true,
  },
];

export const menuLoads: KitchenFixtureInput["menuLoads"] = [
  {
    ...scope,
    id: id(800),
    menuItemId: menuItemId.nasiGorengKampung,
    variantId: null,
    loadPoints: 4,
    prepSeconds: 720,
  },
  {
    ...scope,
    id: id(801),
    menuItemId: menuItemId.ayamGeprek,
    variantId: null,
    loadPoints: 3,
    prepSeconds: 540,
  },
  {
    ...scope,
    id: id(802),
    menuItemId: menuItemId.sateAyam,
    variantId: null,
    loadPoints: 3,
    prepSeconds: 600,
  },
  {
    ...scope,
    id: id(803),
    menuItemId: menuItemId.kentangGoreng,
    variantId: null,
    loadPoints: 1,
    prepSeconds: 240,
  },
  {
    ...scope,
    id: id(804),
    menuItemId: menuItemId.supBuntut,
    variantId: null,
    loadPoints: 5,
    prepSeconds: 900,
  },
  {
    ...scope,
    id: id(805),
    menuItemId: menuItemId.kopiSusuAren,
    variantId: null,
    loadPoints: 1,
    prepSeconds: 180,
  },
  {
    ...scope,
    id: id(806),
    menuItemId: menuItemId.matchaLatte,
    variantId: null,
    loadPoints: 2,
    prepSeconds: 240,
  },
  {
    ...scope,
    id: id(807),
    menuItemId: menuItemId.croissant,
    variantId: null,
    loadPoints: 1,
    prepSeconds: 120,
  },
];

export const capacityRules: KitchenFixtureInput["capacityRules"] = [
  {
    ...scope,
    id: id(850),
    stationId: stationId.kitchen,
    windowMinutes: 15,
    capacityPoints: 18,
    nearCapacityBp: 9000,
    schedule: [{ daysOfWeek: [1, 2, 3, 4, 5], start: "10:00", end: "15:00" }],
    channelPriority: [
      "dine_in",
      "takeaway",
      "gofood",
      "grabfood",
      "shopeefood",
      "reservation",
    ],
  },
  {
    ...scope,
    id: id(851),
    stationId: stationId.kitchen,
    windowMinutes: 15,
    capacityPoints: 15,
    nearCapacityBp: 8500,
    schedule: [
      { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "17:00", end: "21:00" },
    ],
    channelPriority: [
      "dine_in",
      "takeaway",
      "gofood",
      "grabfood",
      "shopeefood",
    ],
  },
  {
    ...scope,
    id: id(852),
    stationId: stationId.coffee,
    windowMinutes: 15,
    capacityPoints: 30,
    nearCapacityBp: 9000,
    schedule: [
      { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "22:00" },
    ],
    channelPriority: [
      "dine_in",
      "takeaway",
      "gofood",
      "grabfood",
      "shopeefood",
    ],
  },
  {
    ...scope,
    id: id(853),
    stationId: stationId.beverage,
    windowMinutes: 15,
    capacityPoints: 24,
    nearCapacityBp: 9000,
    schedule: [
      { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "09:00", end: "21:00" },
    ],
    channelPriority: ["dine_in", "takeaway", "gofood", "grabfood"],
  },
  {
    ...scope,
    id: id(854),
    stationId: stationId.pastry,
    windowMinutes: 15,
    capacityPoints: 12,
    nearCapacityBp: 9000,
    schedule: [{ daysOfWeek: [0, 6], start: "09:00", end: "18:00" }],
    channelPriority: ["dine_in", "takeaway"],
  },
  {
    ...scope2,
    id: id(855),
    stationId: stationId.coffee2,
    windowMinutes: 15,
    capacityPoints: 30,
    nearCapacityBp: 9000,
    schedule: [
      { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "22:00" },
    ],
    channelPriority: [
      "dine_in",
      "takeaway",
      "gofood",
      "grabfood",
      "shopeefood",
    ],
  },
];

export const tickets: KitchenFixtureInput["tickets"] = [
  {
    ...scope,
    id: ticketIds.kitchenDone,
    orderId: orderIds.dineIn,
    stationId: stationId.kitchen,
    status: "done",
    priority: 0,
    ticketNo: 3,
    firedAt: "2026-11-01T03:52:00.000Z",
    startedAt: "2026-11-01T03:53:00.000Z",
    doneAt: "2026-11-01T04:04:00.000Z",
    servedAt: null,
    printedFallback: false,
  },
  {
    ...scope,
    id: ticketIds.coffeeInProgress,
    orderId: orderIds.dineIn,
    stationId: stationId.coffee,
    status: "in_progress",
    priority: 0,
    ticketNo: 4,
    firedAt: "2026-11-01T03:52:00.000Z",
    startedAt: "2026-11-01T03:53:00.000Z",
    doneAt: null,
    servedAt: null,
    printedFallback: false,
  },
  {
    ...scope,
    id: ticketIds.kitchenNew,
    orderId: orderIds.gofood,
    stationId: stationId.kitchen,
    status: "new",
    priority: 2,
    ticketNo: 7,
    firedAt: "2026-11-01T04:06:00.000Z",
    startedAt: null,
    doneAt: null,
    servedAt: null,
    printedFallback: true,
  },
  {
    ...scope,
    id: ticketIds.pastryRecalled,
    orderId: orderIds.dineInPastry,
    stationId: stationId.pastry,
    status: "recalled",
    priority: 1,
    ticketNo: 1,
    firedAt: "2026-11-01T03:40:00.000Z",
    startedAt: "2026-11-01T03:41:00.000Z",
    doneAt: "2026-11-01T03:47:00.000Z",
    servedAt: null,
    printedFallback: false,
  },
  {
    ...scope,
    id: ticketIds.beverageCancelled,
    orderId: orderIds.takeaway,
    stationId: stationId.beverage,
    status: "cancelled",
    priority: 0,
    ticketNo: 6,
    firedAt: "2026-11-01T04:00:00.000Z",
    startedAt: null,
    doneAt: null,
    servedAt: null,
    printedFallback: false,
  },
  {
    ...scope,
    id: ticketIds.coffeeDone,
    orderId: orderIds.gofood,
    stationId: stationId.coffee,
    status: "done",
    priority: 0,
    ticketNo: 5,
    firedAt: "2026-11-01T03:57:00.000Z",
    startedAt: "2026-11-01T03:57:30.000Z",
    doneAt: "2026-11-01T04:05:00.000Z",
    servedAt: null,
    printedFallback: false,
  },
  {
    ...scope,
    id: ticketIds.kitchenReady,
    orderId: orderIds.takeawayDone,
    stationId: stationId.kitchen,
    status: "done",
    priority: 0,
    ticketNo: 2,
    firedAt: "2026-11-01T03:45:00.000Z",
    startedAt: "2026-11-01T03:46:00.000Z",
    doneAt: "2026-11-01T03:59:00.000Z",
    servedAt: null,
    printedFallback: false,
  },
];

export const ticketItems: KitchenFixtureInput["ticketItems"] = [
  {
    ...scope,
    id: ticketItemId(0),
    ticketId: ticketIds.kitchenDone,
    orderId: orderIds.dineIn,
    orderItemId: orderItemIds[0],
    menuItemId: menuItemId.nasiGorengKampung,
    variantId: null,
    name: "Nasi Goreng Kampung",
    quantity: 1,
    course: "main",
    modifiers: ["Pedas sedang"],
    note: null,
    status: "ready",
    firedAt: "2026-11-01T03:52:00.000Z",
    startedAt: "2026-11-01T03:53:00.000Z",
    readyAt: "2026-11-01T04:03:00.000Z",
    servedAt: null,
    recalledCount: 0,
  },
  {
    ...scope,
    id: ticketItemId(1),
    ticketId: ticketIds.kitchenDone,
    orderId: orderIds.dineIn,
    orderItemId: orderItemIds[1],
    menuItemId: menuItemId.ayamGeprek,
    variantId: null,
    name: "Ayam Geprek",
    quantity: 2,
    course: "main",
    modifiers: ["Level 3", "Nasi tambahan"],
    note: "Satu tanpa sambal",
    status: "ready",
    firedAt: "2026-11-01T03:52:00.000Z",
    startedAt: "2026-11-01T03:54:00.000Z",
    readyAt: "2026-11-01T04:04:00.000Z",
    servedAt: null,
    recalledCount: 0,
  },
  {
    ...scope,
    id: ticketItemId(2),
    ticketId: ticketIds.coffeeInProgress,
    orderId: orderIds.dineIn,
    orderItemId: orderItemIds[2],
    menuItemId: menuItemId.kopiSusuAren,
    variantId: null,
    name: "Kopi Susu Aren",
    quantity: 2,
    course: "drink",
    modifiers: ["Less Sugar"],
    note: null,
    status: "in_progress",
    firedAt: "2026-11-01T03:52:00.000Z",
    startedAt: "2026-11-01T03:53:00.000Z",
    readyAt: null,
    servedAt: null,
    recalledCount: 0,
  },
  {
    ...scope,
    id: ticketItemId(3),
    ticketId: ticketIds.kitchenNew,
    orderId: orderIds.gofood,
    orderItemId: orderItemIds[3],
    menuItemId: menuItemId.sateAyam,
    variantId: null,
    name: "Sate Ayam",
    quantity: 3,
    course: "main",
    modifiers: ["Bumbu kacang"],
    note: "Tanpa lontong",
    status: "queued",
    firedAt: "2026-11-01T04:06:00.000Z",
    startedAt: null,
    readyAt: null,
    servedAt: null,
    recalledCount: 0,
  },
  {
    ...scope,
    id: ticketItemId(4),
    ticketId: ticketIds.pastryRecalled,
    orderId: orderIds.dineInPastry,
    orderItemId: orderItemIds[4],
    menuItemId: menuItemId.croissant,
    variantId: null,
    name: "Croissant Mentega",
    quantity: 1,
    course: "dessert",
    modifiers: ["Dipanaskan"],
    note: null,
    status: "in_progress",
    firedAt: "2026-11-01T03:40:00.000Z",
    startedAt: "2026-11-01T03:41:00.000Z",
    readyAt: null,
    servedAt: null,
    recalledCount: 1,
  },
  {
    ...scope,
    id: ticketItemId(5),
    ticketId: ticketIds.beverageCancelled,
    orderId: orderIds.takeaway,
    orderItemId: orderItemIds[5],
    menuItemId: menuItemId.matchaLatte,
    variantId: null,
    name: "Matcha Latte",
    quantity: 1,
    course: "drink",
    modifiers: ["Oat milk"],
    note: null,
    status: "voided",
    firedAt: "2026-11-01T04:00:00.000Z",
    startedAt: null,
    readyAt: null,
    servedAt: null,
    recalledCount: 0,
  },
  {
    ...scope,
    id: ticketItemId(6),
    ticketId: ticketIds.coffeeDone,
    orderId: orderIds.gofood,
    orderItemId: orderItemIds[6],
    menuItemId: menuItemId.flatWhite,
    variantId: null,
    name: "Flat White",
    quantity: 1,
    course: "drink",
    modifiers: [],
    note: null,
    status: "ready",
    firedAt: "2026-11-01T03:57:00.000Z",
    startedAt: "2026-11-01T03:57:30.000Z",
    readyAt: "2026-11-01T04:05:00.000Z",
    servedAt: null,
    recalledCount: 0,
  },
  {
    ...scope,
    id: ticketItemId(7),
    ticketId: ticketIds.kitchenReady,
    orderId: orderIds.takeawayDone,
    orderItemId: orderItemIds[7],
    menuItemId: menuItemId.kentangGoreng,
    variantId: null,
    name: "Kentang Goreng",
    quantity: 1,
    course: "side",
    modifiers: ["Saus keju"],
    note: null,
    status: "ready",
    firedAt: "2026-11-01T03:45:00.000Z",
    startedAt: "2026-11-01T03:46:00.000Z",
    readyAt: "2026-11-01T03:59:00.000Z",
    servedAt: null,
    recalledCount: 0,
  },
];

const change = (
  ticketId: string,
  orderIdValue: string,
  stationIdValue: string,
  fromStatus: KitchenFixtureInput["ticketStatusChanges"][number]["fromStatus"],
  toStatus: KitchenFixtureInput["ticketStatusChanges"][number]["toStatus"],
  occurredAt: string,
  actorId: string | null,
  extra: {
    orderItemId?: string | null;
    deviceId?: string | null;
    source?: "user" | "device" | "system";
    reason?: string | null;
  } = {},
) => ({
  ...scope,
  id: changeId(),
  ticketId,
  orderId: orderIdValue,
  stationId: stationIdValue,
  orderItemId: extra.orderItemId ?? null,
  fromStatus,
  toStatus,
  source: extra.source ?? ("user" as const),
  actorId,
  deviceId: extra.deviceId ?? null,
  occurredAt,
  reason: extra.reason ?? null,
});

export const ticketStatusChanges: KitchenFixtureInput["ticketStatusChanges"] = [
  change(
    ticketIds.kitchenDone,
    orderIds.dineIn,
    stationId.kitchen,
    null,
    "new",
    "2026-11-01T03:52:00.000Z",
    staffId.cashier,
  ),
  change(
    ticketIds.kitchenDone,
    orderIds.dineIn,
    stationId.kitchen,
    "new",
    "in_progress",
    "2026-11-01T03:53:00.000Z",
    staffId.cook,
    { deviceId: deviceId.kdsKitchen, source: "device" },
  ),
  change(
    ticketIds.kitchenDone,
    orderIds.dineIn,
    stationId.kitchen,
    "in_progress",
    "done",
    "2026-11-01T04:04:00.000Z",
    staffId.cook,
    { deviceId: deviceId.kdsKitchen, source: "device" },
  ),
  change(
    ticketIds.coffeeInProgress,
    orderIds.dineIn,
    stationId.coffee,
    null,
    "new",
    "2026-11-01T03:52:00.000Z",
    staffId.cashier,
  ),
  change(
    ticketIds.coffeeInProgress,
    orderIds.dineIn,
    stationId.coffee,
    "new",
    "in_progress",
    "2026-11-01T03:53:00.000Z",
    staffId.barista,
    { deviceId: deviceId.kdsCoffee, source: "device" },
  ),
  change(
    ticketIds.kitchenNew,
    orderIds.gofood,
    stationId.kitchen,
    null,
    "new",
    "2026-11-01T04:06:00.000Z",
    staffId.cashier,
    { source: "user" },
  ),
  change(
    ticketIds.pastryRecalled,
    orderIds.dineInPastry,
    stationId.pastry,
    null,
    "new",
    "2026-11-01T03:40:00.000Z",
    staffId.cashier,
  ),
  change(
    ticketIds.pastryRecalled,
    orderIds.dineInPastry,
    stationId.pastry,
    "new",
    "in_progress",
    "2026-11-01T03:41:00.000Z",
    staffId.pastry,
  ),
  change(
    ticketIds.pastryRecalled,
    orderIds.dineInPastry,
    stationId.pastry,
    "in_progress",
    "done",
    "2026-11-01T03:47:00.000Z",
    staffId.pastry,
  ),
  change(
    ticketIds.pastryRecalled,
    orderIds.dineInPastry,
    stationId.pastry,
    "done",
    "recalled",
    "2026-11-01T03:50:00.000Z",
    staffId.supervisor,
    { orderItemId: orderItemIds[4], reason: "Tidak sesuai pesanan" },
  ),
  change(
    ticketIds.beverageCancelled,
    orderIds.takeaway,
    stationId.beverage,
    null,
    "new",
    "2026-11-01T04:00:00.000Z",
    staffId.cashier,
  ),
  change(
    ticketIds.beverageCancelled,
    orderIds.takeaway,
    stationId.beverage,
    "new",
    "cancelled",
    "2026-11-01T04:01:00.000Z",
    staffId.supervisor,
    { orderItemId: orderItemIds[5], reason: "Pelanggan membatalkan pesanan" },
  ),
  change(
    ticketIds.coffeeDone,
    orderIds.gofood,
    stationId.coffee,
    null,
    "new",
    "2026-11-01T03:57:00.000Z",
    staffId.cashier,
  ),
  change(
    ticketIds.coffeeDone,
    orderIds.gofood,
    stationId.coffee,
    "new",
    "in_progress",
    "2026-11-01T03:57:30.000Z",
    staffId.barista,
  ),
  change(
    ticketIds.coffeeDone,
    orderIds.gofood,
    stationId.coffee,
    "in_progress",
    "done",
    "2026-11-01T04:05:00.000Z",
    staffId.barista,
  ),
  change(
    ticketIds.kitchenReady,
    orderIds.takeawayDone,
    stationId.kitchen,
    null,
    "new",
    "2026-11-01T03:45:00.000Z",
    staffId.cashier,
  ),
  change(
    ticketIds.kitchenReady,
    orderIds.takeawayDone,
    stationId.kitchen,
    "new",
    "in_progress",
    "2026-11-01T03:46:00.000Z",
    staffId.cook,
  ),
  change(
    ticketIds.kitchenReady,
    orderIds.takeawayDone,
    stationId.kitchen,
    "in_progress",
    "done",
    "2026-11-01T03:59:00.000Z",
    staffId.cook,
  ),
];

const pacingRow = (
  stationIdValue: string,
  capacityPoints: number,
  nearCapacityBp: number,
  usedPoints: number,
  queuedItems: number,
  statusValue: KitchenFixtureInput["pacing"]["stations"][number]["status"],
  rowScope: typeof scope = scope,
) => ({
  ...rowScope,
  stationId: stationIdValue,
  windowMinutes: 15,
  windowStart: "2026-11-01T04:00:00.000Z",
  capacityPoints,
  nearCapacityBp,
  usedPoints,
  queuedItems,
  status: statusValue,
});

export const pacing: KitchenFixtureInput["pacing"] = {
  ...scope,
  generatedAt: "2026-11-01T04:10:00.000Z",
  stations: [
    pacingRow(stationId.kitchen, 18, 9000, 17, 9, "near_capacity"),
    pacingRow(stationId.coffee, 30, 9000, 29, 11, "near_capacity"),
    pacingRow(stationId.beverage, 24, 9000, 9, 4, "available"),
    pacingRow(stationId.pastry, 12, 9000, 12, 5, "at_capacity"),
    pacingRow(stationId.coffee2, 30, 9000, 6, 2, "available", scope2),
  ],
};

export const allDay: KitchenFixtureInput["allDay"] = {
  ...scope,
  stationId: stationId.kitchen,
  generatedAt: "2026-11-01T04:10:00.000Z",
  rows: [
    {
      stationId: stationId.kitchen,
      menuItemId: menuItemId.nasiGorengKampung,
      variantId: null,
      name: "Nasi Goreng Kampung",
      quantity: 4,
      oldestFiredAt: "2026-11-01T03:52:00.000Z",
    },
    {
      stationId: stationId.kitchen,
      menuItemId: menuItemId.ayamGeprek,
      variantId: null,
      name: "Ayam Geprek",
      quantity: 3,
      oldestFiredAt: "2026-11-01T03:52:00.000Z",
    },
    {
      stationId: stationId.kitchen,
      menuItemId: menuItemId.sateAyam,
      variantId: null,
      name: "Sate Ayam",
      quantity: 3,
      oldestFiredAt: "2026-11-01T04:06:00.000Z",
    },
  ],
};

export const expo: KitchenFixtureInput["expo"] = {
  ...scope,
  generatedAt: "2026-11-01T04:10:00.000Z",
  tickets: [
    {
      ...scope,
      orderId: orderIds.dineIn,
      channel: "dine_in",
      tableLabel: "A3",
      pickupNumber: null,
      pickupCode: null,
      stations: [
        {
          stationId: stationId.kitchen,
          stationName: "Dapur",
          ticketId: ticketIds.kitchenDone,
          status: "done",
        },
        {
          stationId: stationId.coffee,
          stationName: "Kopi",
          ticketId: ticketIds.coffeeInProgress,
          status: "in_progress",
        },
      ],
      isComplete: false,
      readyAt: null,
      runnerId: null,
      runnerAssignedAt: null,
      deliveredAt: null,
    },
    {
      ...scope,
      orderId: orderIds.gofood,
      channel: "gofood",
      tableLabel: null,
      pickupNumber: 12,
      pickupCode: "A-012",
      stations: [
        {
          stationId: stationId.kitchen,
          stationName: "Dapur",
          ticketId: ticketIds.kitchenNew,
          status: "new",
        },
        {
          stationId: stationId.coffee,
          stationName: "Kopi",
          ticketId: ticketIds.coffeeDone,
          status: "done",
        },
      ],
      isComplete: false,
      readyAt: null,
      runnerId: null,
      runnerAssignedAt: null,
      deliveredAt: null,
    },
    {
      ...scope,
      orderId: orderIds.dineInPastry,
      channel: "dine_in",
      tableLabel: "B7",
      pickupNumber: null,
      pickupCode: null,
      stations: [
        {
          stationId: stationId.pastry,
          stationName: "Pastry",
          ticketId: ticketIds.pastryRecalled,
          status: "recalled",
        },
      ],
      isComplete: false,
      readyAt: null,
      runnerId: null,
      runnerAssignedAt: null,
      deliveredAt: null,
    },
    {
      ...scope,
      orderId: orderIds.takeawayDone,
      channel: "takeaway",
      tableLabel: null,
      pickupNumber: 14,
      pickupCode: "A-014",
      stations: [
        {
          stationId: stationId.kitchen,
          stationName: "Dapur",
          ticketId: ticketIds.kitchenReady,
          status: "done",
        },
      ],
      isComplete: true,
      readyAt: "2026-11-01T03:59:00.000Z",
      runnerId: staffId.runner,
      runnerAssignedAt: "2026-11-01T04:00:00.000Z",
      deliveredAt: null,
    },
    {
      ...scope,
      orderId: orderIds.takeaway,
      channel: "takeaway",
      tableLabel: null,
      pickupNumber: 13,
      pickupCode: "A-013",
      stations: [
        {
          stationId: stationId.beverage,
          stationName: "Nonkopi",
          ticketId: ticketIds.beverageCancelled,
          status: "cancelled",
        },
      ],
      isComplete: false,
      readyAt: null,
      runnerId: null,
      runnerAssignedAt: null,
      deliveredAt: null,
    },
  ],
};

// F12 "menugaskan runner": the floor staff the expo screen can pick from. The
// assigned expo ticket above already points at staffId.runner.
export const expoRunners: KitchenFixtureInput["expoRunners"] = [
  { ...scope, userId: staffId.runner, name: "Rizky Alfian" },
  { ...scope, userId: staffId.waiter, name: "Bagas Prakoso" },
  { ...scope, userId: staffId.waiter2, name: "Nadia Puspita" },
];

export const pickupCalls: KitchenFixtureInput["pickupDisplay"]["calls"] = [
  {
    ...scope,
    id: id(950),
    orderId: orderIds.gofood,
    channel: "gofood",
    number: 12,
    code: "A-012",
    businessDate: "2026-11-01",
    status: "assigned",
    calledAt: null,
    pickedUpAt: null,
  },
  {
    ...scope,
    id: id(951),
    orderId: orderIds.takeaway,
    channel: "takeaway",
    number: 13,
    code: "A-013",
    businessDate: "2026-11-01",
    status: "called",
    calledAt: "2026-11-01T04:12:00.000Z",
    pickedUpAt: null,
  },
  {
    ...scope,
    id: id(952),
    orderId: orderIds.takeawayDone,
    channel: "takeaway",
    number: 14,
    code: "A-014",
    businessDate: "2026-11-01",
    status: "picked_up",
    calledAt: "2026-11-01T04:01:00.000Z",
    pickedUpAt: "2026-11-01T04:05:00.000Z",
  },
];

// F12 "... dengan promosi": the slide the pickup display shows between call
// numbers. Illustrative campaign copy like the menu fixtures; the tenant's own
// promotions come from the promo engine once the API serves this feed.
export const pickupPromotions: KitchenFixtureInput["pickupDisplay"]["promotions"] =
  [
    {
      ...scope,
      id: id(960),
      title: "Kopi Susu Aren · 2 gelas Rp 45.000",
      body: "Berlaku setiap hari pukul 15.00–18.00 di Cafe Legend Bandung.",
      validUntil: fixtureTimeAfter({ days: 6, hours: 16, minutes: 59 }),
    },
  ];

export const pickupDisplay: KitchenFixtureInput["pickupDisplay"] = {
  ...scope,
  generatedAt: "2026-11-01T04:13:00.000Z",
  calls: pickupCalls,
  promotions: pickupPromotions,
};

export const servingTimeEstimate: KitchenFixtureInput["servingTimeEstimate"] = {
  ...scope,
  channel: "dine_in",
  queueItems: 29,
  queueLoadPoints: 64,
  estimatedMinutes: 21,
  estimatedReadyAt: "2026-11-01T04:31:00.000Z",
  computedAt: "2026-11-01T04:10:00.000Z",
};

export const servingTimeSamples: KitchenFixtureInput["servingTimeSamples"] = [
  {
    ...scope,
    ticketId: ticketIds.kitchenDone,
    stationId: stationId.kitchen,
    orderId: orderIds.dineIn,
    employeeId: staffId.cook,
    startedAt: "2026-11-01T03:53:00.000Z",
    doneAt: "2026-11-01T04:04:00.000Z",
    seconds: 660,
    targetSeconds: 600,
    metTarget: false,
  },
  {
    ...scope,
    ticketId: ticketIds.pastryRecalled,
    stationId: stationId.pastry,
    orderId: orderIds.dineInPastry,
    employeeId: staffId.pastry,
    startedAt: "2026-11-01T03:41:00.000Z",
    doneAt: "2026-11-01T03:47:00.000Z",
    seconds: 360,
    targetSeconds: 600,
    metTarget: true,
  },
  {
    ...scope,
    ticketId: ticketIds.coffeeDone,
    stationId: stationId.coffee,
    orderId: orderIds.gofood,
    employeeId: staffId.barista,
    startedAt: "2026-11-01T03:57:30.000Z",
    doneAt: "2026-11-01T04:05:00.000Z",
    seconds: 450,
    targetSeconds: 300,
    metTarget: false,
  },
  {
    ...scope,
    ticketId: ticketIds.kitchenReady,
    stationId: stationId.kitchen,
    orderId: orderIds.takeawayDone,
    employeeId: staffId.cook,
    startedAt: "2026-11-01T03:46:00.000Z",
    doneAt: "2026-11-01T03:59:00.000Z",
    seconds: 780,
    targetSeconds: 600,
    metTarget: false,
  },
];

export const servingTimeSummaries: KitchenFixtureInput["servingTimeSummaries"] =
  [
    {
      ...scope,
      group: "station",
      groupKey: stationId.kitchen,
      label: "Dapur",
      sampleCount: 2,
      medianSeconds: 720,
      averageSeconds: 720,
      targetSeconds: 600,
      withinTargetBp: 0,
    },
    {
      ...scope,
      group: "station",
      groupKey: stationId.coffee,
      label: "Kopi",
      sampleCount: 1,
      medianSeconds: 450,
      averageSeconds: 450,
      targetSeconds: 300,
      withinTargetBp: 0,
    },
    {
      ...scope,
      group: "hour",
      groupKey: "11",
      label: "Jam 11:00",
      sampleCount: 4,
      medianSeconds: 555,
      averageSeconds: 563,
      targetSeconds: 600,
      withinTargetBp: 2500,
    },
    {
      ...scope,
      group: "employee",
      groupKey: staffId.pastry,
      label: "Pastry",
      sampleCount: 1,
      medianSeconds: 360,
      averageSeconds: 360,
      targetSeconds: 600,
      withinTargetBp: 10_000,
    },
    {
      ...scope,
      group: "item",
      groupKey: menuItemId.nasiGorengKampung,
      label: "Nasi Goreng Kampung",
      sampleCount: 1,
      medianSeconds: 660,
      averageSeconds: 660,
      targetSeconds: 600,
      withinTargetBp: 0,
    },
  ];

export const orderIssues: KitchenFixtureInput["orderIssues"] = [
  {
    ...scope,
    id: id(1000),
    orderId: orderIds.dineIn,
    orderItemId: orderItemIds[1],
    type: "remake",
    reason: "late",
    reasonNote: "Ayam kembali dingin saat disajikan",
    stationId: stationId.kitchen,
    employeeId: staffId.cook,
    reportedBy: staffId.supervisor,
    resolution: "swap",
    replacementItemId: menuItemId.kentangGoreng,
    voucherId: null,
    approvedBy: staffId.supervisor,
    priceDifferenceIdr: null,
    costIdr: 12_500,
    createdAt: "2026-11-01T04:06:00.000Z",
    status: "resolved",
    resolvedAt: "2026-11-01T04:07:00.000Z",
  },
  {
    ...scope,
    id: id(1001),
    orderId: orderIds.dineInPastry,
    orderItemId: orderItemIds[4],
    type: "comp",
    reason: "quality",
    reasonNote: "Croissant tidak mengembang, diganti menu lain",
    stationId: stationId.pastry,
    employeeId: staffId.pastry,
    reportedBy: staffId.supervisor,
    resolution: "voucher",
    replacementItemId: null,
    voucherId: id(900),
    approvedBy: staffId.supervisor,
    priceDifferenceIdr: null,
    costIdr: 4_000,
    createdAt: "2026-11-01T03:52:00.000Z",
    status: "resolved",
    resolvedAt: "2026-11-01T03:53:00.000Z",
  },
  {
    ...scope,
    id: id(1002),
    orderId: orderIds.gofood,
    orderItemId: orderItemIds[3],
    type: "unfulfillable",
    reason: "wrong_order",
    reasonNote: "Jumlah sate salah input, pelanggan minta refund",
    stationId: stationId.kitchen,
    employeeId: staffId.cook,
    reportedBy: staffId.cashier,
    resolution: "manual_refund",
    replacementItemId: null,
    voucherId: null,
    approvedBy: staffId.supervisor,
    priceDifferenceIdr: null,
    costIdr: 0,
    createdAt: "2026-11-01T04:08:00.000Z",
    status: "resolved",
    resolvedAt: "2026-11-01T04:09:00.000Z",
  },
  {
    ...scope,
    id: id(1003),
    orderId: orderIds.dineIn,
    orderItemId: orderItemIds[0],
    type: "complaint",
    reason: "complaint",
    reasonNote: "Pelanggan menunggu lebih dari 20 menit",
    stationId: null,
    employeeId: null,
    reportedBy: staffId.supervisor,
    resolution: null,
    replacementItemId: null,
    voucherId: null,
    approvedBy: null,
    priceDifferenceIdr: null,
    costIdr: 0,
    createdAt: "2026-11-01T04:09:00.000Z",
    status: "open",
    resolvedAt: null,
  },
];

const staffNames: Record<string, string> = {
  [staffId.cook]: "Budi Santoso",
  [staffId.barista]: "Sari Wulandari",
  [staffId.pastry]: "Dewi Lestari",
  [staffId.supervisor]: "Rina Pratama",
  [staffId.cashier]: "Agus Hartono",
};
const orderLabels: Record<string, string> = {
  [orderIds.dineIn]: "A-0101",
  [orderIds.gofood]: "GF-0102",
  [orderIds.dineInPastry]: "A-0103",
};

/** `listOrderIssues` rows: each record plus order label, item and staff names (legend-0eq7). */
export const orderIssueViews: z.input<typeof orderIssueViewSchema>[] =
  orderIssues.map((issue) => ({
    ...issue,
    orderLabel: orderLabels[issue.orderId] ?? "A-0100",
    itemName:
      ticketItems.find((item) => item.orderItemId === issue.orderItemId)
        ?.name ?? "Menu",
    reportedByName: staffNames[issue.reportedBy] ?? "Staf",
    employeeName: issue.employeeId
      ? (staffNames[issue.employeeId] ?? "Staf")
      : null,
    approvedByName: issue.approvedBy
      ? (staffNames[issue.approvedBy] ?? "Staf")
      : null,
  }));

export const channelPauses: KitchenFixtureInput["channelPauses"] = [
  {
    ...scope,
    id: id(1100),
    menuItemId: menuItemId.supBuntut,
    variantId: null,
    channels: ["gofood", "grabfood", "shopeefood"],
    reason: "long_prep",
    pausedUntil: "2026-11-01T05:00:00.000Z",
    createdAt: "2026-11-01T04:08:00.000Z",
    createdBy: staffId.supervisor,
  },
];

// tickets[0] = kitchenDone, tickets[1] = coffeeInProgress (declaration order).
const kitchenDoneTicket = tickets[0];
const coffeeInProgressTicket = tickets[1];

export const stationBoards: KitchenFixtureInput["stationBoards"] = [
  {
    ...scope,
    stationId: stationId.kitchen,
    generatedAt: "2026-11-01T04:10:00.000Z",
    tickets: [
      {
        ...kitchenDoneTicket,
        tableLabel: "A3",
        channel: "dine_in",
        items: ticketItems.filter(
          (item) => item.ticketId === ticketIds.kitchenDone,
        ),
      },
    ],
    allDay,
    pacing: pacing.stations[0],
  },
  {
    ...scope,
    stationId: stationId.coffee,
    generatedAt: "2026-11-01T04:10:00.000Z",
    tickets: [
      {
        ...coffeeInProgressTicket,
        tableLabel: "A3",
        channel: "dine_in",
        items: ticketItems.filter(
          (item) => item.ticketId === ticketIds.coffeeInProgress,
        ),
      },
    ],
    allDay: {
      ...allDay,
      stationId: stationId.coffee,
      rows: [
        {
          stationId: stationId.coffee,
          menuItemId: menuItemId.kopiSusuAren,
          variantId: null,
          name: "Kopi Susu Aren",
          quantity: 2,
          oldestFiredAt: "2026-11-01T03:52:00.000Z",
        },
      ],
    },
    pacing: pacing.stations[1],
  },
];

const OPEN_TICKET_STATUSES = ["new", "in_progress", "recalled"];

export const stationSummary: KitchenFixtureInput["stationSummary"] = {
  ...scope,
  generatedAt: "2026-11-01T04:10:00.000Z",
  // The summary is scoped to the first outlet; the Bandung 2 station is not in it.
  stations: stationConfigs
    .filter((config) => config.outletId === outletId)
    .map((config) => ({
      stationId: config.stationId,
      openTickets: tickets.filter(
        (ticket) =>
          ticket.stationId === config.stationId &&
          OPEN_TICKET_STATUSES.includes(ticket.status),
      ).length,
    })),
};

/** What a cook reads (legend-gt7f); names and types follow the menu stations. */
export const stationLabels: z.input<typeof stationLabelSchema>[] = [
  {
    stationId: stationId.coffee,
    name: "Kopi",
    type: "coffee_bar",
    targetSeconds: 600,
  },
  {
    stationId: stationId.beverage,
    name: "Nonkopi",
    type: "beverage_bar",
    targetSeconds: 600,
  },
  {
    stationId: stationId.kitchen,
    name: "Dapur",
    type: "hot_kitchen",
    targetSeconds: 600,
  },
  {
    stationId: stationId.pastry,
    name: "Pastry",
    type: "pastry",
    targetSeconds: 600,
  },
];

/** The cook's slim view of a station's capacity rules (legend-gt7f). */
export const stationCapacityRules: z.input<typeof stationCapacityRuleSchema>[] =
  capacityRules
    .filter((rule) => rule.stationId === stationId.kitchen)
    .map(
      ({
        stationId: station,
        windowMinutes,
        capacityPoints,
        nearCapacityBp,
        schedule,
        channelPriority,
      }) => ({
        stationId: station,
        windowMinutes,
        capacityPoints,
        nearCapacityBp,
        schedule,
        channelPriority,
      }),
    );

export const cafeLegendKitchenFixtures: KitchenFixtureInput = {
  stationConfigs,
  menuLoads,
  capacityRules,
  tickets,
  ticketItems,
  ticketStatusChanges,
  pacing,
  allDay,
  expo,
  expoRunners,
  pickupDisplay,
  servingTimeEstimate,
  servingTimeSamples,
  servingTimeSummaries,
  orderIssues,
  channelPauses,
  stationBoards,
  stationSummary,
};
