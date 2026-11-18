// Cafe Legend fixtures for the QR order contracts: four floor zones, a dozen
// tables, active and closed table sessions, a shared cart, server quotes,
// placed QR orders, a split bill, waiter calls, a failed item with an apology
// voucher, and a post-meal review.
//
// PRD facts: first tenant Cafe Legend in Kota Bandung, PBJT 10% (§6 F11
// default), zones may be pay-first or open bill (§3 "Mode Bayar"). The menu
// lines come from `cafeLegendMenuFixtures`, so ids and channel prices stay
// consistent across contracts. Sample data, not the owner's confirmed floor
// plan or prices.

import { fixtureTimeAfter } from "../core/fixture-clock.ts";
import { cafeLegendFixtures, idr, z } from "../core/index.ts";
import type { RoundingMode } from "../core/index.ts";
import { cafeLegendMenuFixtures } from "../menu/index.ts";
import { computeQuote, splitBill } from "./pricing.ts";
import type { QuoteConfig, QuoteLineInput, QuoteTaxRule } from "./pricing.ts";
import {
  apologyVoucherSchema,
  billSplitSchema,
  cartLineSchema,
  cartSchema,
  floorBoardSchema,
  floorZoneSchema,
  orderIssueSchema,
  orderIssueOptionsSchema,
  orderQuoteSchema,
  qrOrderItemSchema,
  qrOrderSchema,
  qrScanResultSchema,
  qrTokenPayloadSchema,
  reviewEligibilitySchema,
  serviceRequestSchema,
  sessionBillSchema,
  sessionParticipantSchema,
  tableQrSchema,
  tableReviewSchema,
  tableSchema,
  tableSessionSchema,
  tableSessionTokenExpiresAt,
} from "./schemas.ts";
import type {
  ApologyVoucher,
  BillSplit,
  CartLine,
  FloorZone,
  OrderIssue,
  QrOrder,
  QrOrderItem,
  ServiceRequest,
  SessionParticipant,
  Table,
  TableSession,
} from "./schemas.ts";

const { tenant, brand, outlets } = cafeLegendFixtures;
const outlet = outlets[0];
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { tenantId: tenant.id, outletId: outlet.id };
const staffUserId = "00000000-0000-4000-8000-000000009001";

const menuItem = (name: string) => {
  const item = cafeLegendMenuFixtures.items.find(
    (entry) => entry.name === name,
  );
  if (!item) throw new RangeError(`Unknown menu fixture item: ${name}`);
  return item;
};
const priceOf = (menuItemId: string) => {
  const row = cafeLegendMenuFixtures.priceListItems.find(
    (entry) => entry.itemId === menuItemId,
  );
  if (!row) throw new RangeError(`No channel price for item ${menuItemId}`);
  return row.priceIdr;
};
const normalSugar = cafeLegendMenuFixtures.modifiers[0];

const zones: FloorZone[] = [
  {
    id: id(100),
    ...scope,
    name: "Indoor Reguler",
    paymentMode: "pay_first" as const,
    serviceChargeBp: 500,
    minimumSpendIdr: idr(0),
    hours: [
      { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "22:00" },
    ],
    status: "active" as const,
    sortOrder: 0,
    isWfc: false,
  },
  {
    id: id(101),
    ...scope,
    name: "Taman Outdoor",
    paymentMode: "pay_first" as const,
    serviceChargeBp: 500,
    minimumSpendIdr: idr(0),
    hours: [
      { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "23:00" },
    ],
    status: "active" as const,
    sortOrder: 1,
    isWfc: false,
  },
  {
    id: id(102),
    ...scope,
    name: "Private Room Nusantara",
    paymentMode: "open_bill" as const,
    serviceChargeBp: 1000,
    minimumSpendIdr: idr(500_000),
    hours: [
      { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "10:00", end: "22:00" },
    ],
    status: "active" as const,
    sortOrder: 2,
    isWfc: false,
  },
  {
    id: id(103),
    ...scope,
    name: "WFC Corner",
    paymentMode: "open_bill" as const,
    serviceChargeBp: 500,
    minimumSpendIdr: idr(50_000),
    hours: [{ daysOfWeek: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" }],
    status: "active" as const,
    sortOrder: 3,
    isWfc: true,
  },
].map((zone) => floorZoneSchema.parse(zone));

type TableSeed = {
  n: number;
  zone: number;
  code: string;
  capacity: number;
  type: Table["type"];
  status: Table["status"];
  x: number;
  y: number;
  width: number;
  height: number;
  shape: "rect" | "round";
};
const tableSeeds: TableSeed[] = [
  {
    n: 201,
    zone: 0,
    code: "A01",
    capacity: 2,
    type: "regular",
    status: "available",
    x: 40,
    y: 40,
    width: 60,
    height: 60,
    shape: "rect",
  },
  {
    n: 202,
    zone: 0,
    code: "A02",
    capacity: 2,
    type: "regular",
    status: "available",
    x: 130,
    y: 40,
    width: 60,
    height: 60,
    shape: "rect",
  },
  {
    n: 203,
    zone: 0,
    code: "A03",
    capacity: 4,
    type: "regular",
    status: "occupied",
    x: 220,
    y: 40,
    width: 80,
    height: 80,
    shape: "rect",
  },
  {
    n: 204,
    zone: 0,
    code: "A04",
    capacity: 4,
    type: "regular",
    status: "dirty",
    x: 40,
    y: 150,
    width: 80,
    height: 80,
    shape: "rect",
  },
  {
    n: 205,
    zone: 0,
    code: "A05",
    capacity: 2,
    type: "bar",
    status: "dirty",
    x: 150,
    y: 160,
    width: 40,
    height: 60,
    shape: "round",
  },
  {
    n: 206,
    zone: 0,
    code: "A06",
    capacity: 2,
    type: "bar",
    status: "dirty",
    x: 210,
    y: 160,
    width: 40,
    height: 60,
    shape: "round",
  },
  {
    n: 207,
    zone: 1,
    code: "B01",
    capacity: 6,
    type: "sofa",
    status: "available",
    x: 40,
    y: 280,
    width: 120,
    height: 80,
    shape: "rect",
  },
  {
    n: 208,
    zone: 1,
    code: "B02",
    capacity: 6,
    type: "sofa",
    status: "reserved",
    x: 190,
    y: 280,
    width: 120,
    height: 80,
    shape: "rect",
  },
  {
    n: 209,
    zone: 2,
    code: "P1",
    capacity: 10,
    type: "private_room",
    status: "occupied",
    x: 380,
    y: 40,
    width: 160,
    height: 120,
    shape: "rect",
  },
  {
    n: 210,
    zone: 3,
    code: "W01",
    capacity: 1,
    type: "bar",
    status: "occupied",
    x: 380,
    y: 200,
    width: 40,
    height: 40,
    shape: "round",
  },
  {
    n: 211,
    zone: 3,
    code: "W02",
    capacity: 1,
    type: "bar",
    status: "available",
    x: 440,
    y: 200,
    width: 40,
    height: 40,
    shape: "round",
  },
  {
    n: 212,
    zone: 3,
    code: "W03",
    capacity: 1,
    type: "bar",
    status: "inactive",
    x: 500,
    y: 200,
    width: 40,
    height: 40,
    shape: "round",
  },
];
const tables: Table[] = tableSeeds.map((seed) =>
  tableSchema.parse({
    id: id(seed.n),
    ...scope,
    zoneId: zones[seed.zone].id,
    code: seed.code,
    capacity: seed.capacity,
    type: seed.type,
    status: seed.status,
    layout: {
      x: seed.x,
      y: seed.y,
      width: seed.width,
      height: seed.height,
      rotation: 0,
      shape: seed.shape,
    },
  }),
);
const tableOf = (code: string) => {
  const table = tables.find((entry) => entry.code === code);
  if (!table) throw new RangeError(`Unknown table fixture: ${code}`);
  return table;
};

const participants: SessionParticipant[] = [
  {
    id: id(301),
    tenantId: tenant.id,
    tableSessionId: id(401),
    deviceHash: "device-a03-guest-1",
    userId: null,
    joinedAt: "2026-11-01T04:30:00.000Z",
    lastSeenAt: "2026-11-01T05:09:00.000Z",
  },
  {
    id: id(302),
    tenantId: tenant.id,
    tableSessionId: id(401),
    deviceHash: "device-a03-guest-2",
    userId: null,
    joinedAt: "2026-11-01T04:32:00.000Z",
    lastSeenAt: "2026-11-01T05:08:00.000Z",
  },
  {
    id: id(303),
    tenantId: tenant.id,
    tableSessionId: id(402),
    deviceHash: "device-p1-guest-1",
    userId: null,
    joinedAt: "2026-11-01T03:00:00.000Z",
    lastSeenAt: "2026-11-01T05:05:00.000Z",
  },
  {
    id: id(304),
    tenantId: tenant.id,
    tableSessionId: id(402),
    deviceHash: "device-p1-guest-2",
    userId: null,
    joinedAt: "2026-11-01T03:01:00.000Z",
    lastSeenAt: "2026-11-01T05:05:00.000Z",
  },
  {
    id: id(305),
    tenantId: tenant.id,
    tableSessionId: id(403),
    deviceHash: "device-w01-guest-1",
    userId: null,
    joinedAt: "2026-11-01T04:55:00.000Z",
    lastSeenAt: "2026-11-01T05:09:30.000Z",
  },
  {
    id: id(306),
    tenantId: tenant.id,
    tableSessionId: id(404),
    deviceHash: "device-a05-guest-1",
    userId: null,
    joinedAt: "2026-11-01T02:00:00.000Z",
    lastSeenAt: "2026-11-01T03:00:00.000Z",
  },
].map((participant) => sessionParticipantSchema.parse(participant));

const sessions: TableSession[] = [
  {
    id: id(401),
    ...scope,
    tableId: tableOf("A03").id,
    pax: 4,
    paymentMode: "pay_first" as const,
    status: "open" as const,
    confirmedBy: null,
    reservationId: null,
    participants: [participants[0], participants[1]],
    openedAt: "2026-11-01T04:30:00.000Z",
    closedAt: null,
    lastActivityAt: "2026-11-01T05:09:00.000Z",
    billRequestedAt: null,
    closedReason: null,
  },
  {
    id: id(402),
    ...scope,
    tableId: tableOf("P1").id,
    pax: 6,
    paymentMode: "open_bill" as const,
    status: "bill_requested" as const,
    confirmedBy: staffUserId,
    reservationId: null,
    participants: [participants[2], participants[3]],
    openedAt: "2026-11-01T03:00:00.000Z",
    closedAt: null,
    lastActivityAt: "2026-11-01T05:05:00.000Z",
    billRequestedAt: "2026-11-01T05:04:00.000Z",
    closedReason: null,
  },
  {
    id: id(403),
    ...scope,
    tableId: tableOf("W01").id,
    pax: 1,
    paymentMode: "open_bill" as const,
    status: "pending_confirmation" as const,
    confirmedBy: null,
    reservationId: null,
    participants: [participants[4]],
    openedAt: "2026-11-01T04:55:00.000Z",
    closedAt: null,
    lastActivityAt: "2026-11-01T05:09:30.000Z",
    billRequestedAt: null,
    closedReason: null,
  },
  {
    id: id(404),
    ...scope,
    tableId: tableOf("A05").id,
    pax: 2,
    paymentMode: "pay_first" as const,
    status: "closed" as const,
    confirmedBy: null,
    reservationId: null,
    participants: [participants[5]],
    openedAt: "2026-11-01T02:00:00.000Z",
    closedAt: "2026-11-01T03:00:00.000Z",
    lastActivityAt: "2026-11-01T03:00:00.000Z",
    billRequestedAt: null,
    closedReason: "paid_and_cleaned" as const,
  },
  {
    id: id(405),
    ...scope,
    tableId: tableOf("A06").id,
    pax: 2,
    paymentMode: "pay_first" as const,
    status: "closed" as const,
    confirmedBy: null,
    reservationId: null,
    participants: [],
    openedAt: "2026-11-01T01:00:00.000Z",
    closedAt: "2026-11-01T01:40:00.000Z",
    lastActivityAt: "2026-11-01T01:40:00.000Z",
    billRequestedAt: null,
    closedReason: "expired" as const,
  },
].map((session) => tableSessionSchema.parse(session));

const taxRuleId = id(7000);
export const cafeLegendTaxRules: QuoteTaxRule[] = [
  {
    id: taxRuleId,
    // The rate is rendered from rateBp by the checkout ("{name} ({rate}%)").
    name: "PBJT Kota Bandung",
    rateBp: 1000,
    appliesTo: "net_plus_service",
  },
];
const roundingMode: RoundingMode = "half_up";
const roundingIncrementIdr = 100;

/** Quote configuration for a zone: service charge, tax rules, cash rounding.
 * Menu prices are exclusive of tax and service charge (owner decision
 * 2026-11-01): the quote adds both on top at checkout. */
export function quoteConfigForZone(zone: FloorZone): QuoteConfig {
  return {
    serviceChargeBp: zone.serviceChargeBp,
    taxRules: cafeLegendTaxRules,
    roundingIncrementIdr,
    roundingMode,
    minimumSpendIdr: zone.minimumSpendIdr,
  };
}

const cartLine = (
  n: number,
  itemName: string,
  quantity: number,
  modifierIds: readonly string[],
  participantId: string,
): CartLine => {
  const item = menuItem(itemName);
  const modifiers = modifierIds.map((modifierId) => {
    const modifier = cafeLegendMenuFixtures.modifiers.find(
      (entry) => entry.id === modifierId,
    );
    if (!modifier)
      throw new RangeError(`Unknown modifier fixture: ${modifierId}`);
    return {
      modifierId: modifier.id,
      groupId: modifier.groupId,
      name: modifier.name,
      priceIdr: modifier.priceIdr,
    };
  });
  const modifiersTotalIdr = idr(
    modifiers.reduce((sum, modifier) => sum + modifier.priceIdr, 0),
  );
  const unitPriceIdr = priceOf(item.id);
  return cartLineSchema.parse({
    id: id(n),
    ...scope,
    tableSessionId: sessions[0].id,
    menuItemId: item.id,
    variantId: null,
    name: item.name,
    quantity,
    modifiers,
    note: null,
    unitPriceIdr,
    modifiersTotalIdr,
    lineTotalIdr: idr((unitPriceIdr + modifiersTotalIdr) * quantity),
    addedByParticipantId: participantId,
    addedAt: "2026-11-01T04:35:00.000Z",
    updatedAt: "2026-11-01T04:36:00.000Z",
  });
};

const cartLines = [
  cartLine(501, "Kopi Susu Aren", 2, [normalSugar.id], participants[0].id),
  cartLine(502, "Nasi Goreng Kampung", 1, [], participants[0].id),
  cartLine(503, "Croissant Mentega", 2, [], participants[1].id),
  cartLine(504, "Air Mineral", 1, [], participants[1].id),
];

const cart = cartSchema.parse({
  sessionId: sessions[0].id,
  version: 3,
  lines: cartLines,
  updatedAt: "2026-11-01T05:09:00.000Z",
});

const quoteLines: QuoteLineInput[] = cartLines.map((line) => ({
  cartLineId: line.id,
  menuItemId: line.menuItemId,
  name: line.name,
  quantity: line.quantity,
  unitPriceIdr: line.unitPriceIdr,
  modifiersTotalIdr: line.modifiersTotalIdr,
  taxRuleId,
}));

const quoteOpen = computeQuote({
  sessionId: sessions[0].id,
  cartVersion: cart.version,
  lines: quoteLines,
  config: quoteConfigForZone(zones[0]),
  servingEstimate: {
    minMinutes: 12,
    maxMinutes: 18,
    computedAt: "2026-11-01T05:09:00.000Z",
  },
  computedAt: "2026-11-01T05:09:00.000Z",
});

const quotePrivateRoom = computeQuote({
  sessionId: sessions[1].id,
  cartVersion: 1,
  lines: quoteLines,
  config: quoteConfigForZone(zones[2]),
  computedAt: "2026-11-01T04:50:00.000Z",
});

const orderId = "01JC0QRD4M5N6P7Q8R9S0T1V2W";
const orderItemIds = [
  "01JC0QRD4M5N6P7Q8R9S0T1V3X",
  "01JC0QRD4M5N6P7Q8R9S0T1V4Y",
  "01JC0QRD4M5N6P7Q8R9S0T1V5Z",
  "01JC0QRD4M5N6P7Q8R9S0T1V6A",
];

const orderItems: QrOrderItem[] = quotePrivateRoom.lines.map((line, index) =>
  qrOrderItemSchema.parse({
    id: orderItemIds[index],
    tenantId: tenant.id,
    orderId,
    menuItemId: line.menuItemId,
    variantId: null,
    name: line.name,
    quantity: line.quantity,
    unitPriceIdr: line.unitPriceIdr,
    modifiersTotalIdr: line.modifiersTotalIdr,
    lineTotalIdr: line.lineTotalIdr,
    modifiers: cartLines[index].modifiers.map((modifier) => ({
      modifierId: modifier.modifierId,
      name: modifier.name,
      priceIdr: modifier.priceIdr,
    })),
    note: null,
    course: menuItem(line.name).course,
    fireStatus: "fired" as const,
    status: "queued" as const,
  }),
);

const order: QrOrder = qrOrderSchema.parse({
  id: orderId,
  ...scope,
  number: "QR-20261101-0042",
  channel: "qr",
  serviceType: "dine_in",
  tableSessionId: sessions[1].id,
  customerProfileId: null,
  subtotalIdr: quotePrivateRoom.subtotalIdr,
  discountIdr: quotePrivateRoom.discountIdr,
  serviceChargeIdr: quotePrivateRoom.serviceCharge.amountIdr,
  taxIdr: quotePrivateRoom.taxIdr,
  roundingIdr: quotePrivateRoom.rounding.adjustmentIdr,
  totalIdr: quotePrivateRoom.totalIdr,
  status: "sent",
  items: orderItems,
  createdAt: "2026-11-01T04:50:00.000Z",
  placedAt: "2026-11-01T04:50:00.000Z",
});

const splitDrafts = splitBill({
  method: "by_person",
  totalIdr: order.totalIdr,
  participantIds: [participants[2].id, participants[3].id],
});
const splits: BillSplit[] = splitDrafts.map((draft, index) =>
  billSplitSchema.parse({
    id: id(801 + index),
    ...scope,
    tableSessionId: sessions[1].id,
    orderId: order.id,
    method: draft.method,
    shareIndex: draft.shareIndex,
    amountIdr: draft.amountIdr,
    status: index === 0 ? "paid" : "pending",
    label: draft.label,
    itemIds: draft.itemIds,
    participantId: draft.participantId,
    createdAt: "2026-11-01T05:05:00.000Z",
  }),
);

const bill = sessionBillSchema.parse({
  sessionId: sessions[1].id,
  orders: [order],
  totals: {
    subtotalIdr: order.subtotalIdr,
    discountIdr: order.discountIdr,
    serviceChargeIdr: order.serviceChargeIdr,
    taxIdr: order.taxIdr,
    roundingIdr: order.roundingIdr,
    totalIdr: order.totalIdr,
    paidIdr: splits[0].amountIdr,
    outstandingIdr: idr(order.totalIdr - splits[0].amountIdr),
  },
  splits,
  computedAt: "2026-11-01T05:05:00.000Z",
});

const serviceRequests: ServiceRequest[] = [
  {
    id: id(601),
    ...scope,
    tableSessionId: sessions[0].id,
    tableId: tableOf("A03").id,
    zoneId: zones[0].id,
    type: "call_waiter" as const,
    reason: "utensils" as const,
    message: null,
    status: "pending" as const,
    assignedTo: null,
    createdAt: "2026-11-01T05:08:30.000Z",
    acknowledgedAt: null,
    resolvedAt: null,
  },
  {
    id: id(602),
    ...scope,
    tableSessionId: sessions[1].id,
    tableId: tableOf("P1").id,
    zoneId: zones[2].id,
    type: "request_bill" as const,
    reason: null,
    message: null,
    status: "resolved" as const,
    assignedTo: staffUserId,
    createdAt: "2026-11-01T05:03:00.000Z",
    acknowledgedAt: "2026-11-01T05:03:20.000Z",
    resolvedAt: "2026-11-01T05:04:00.000Z",
    resolvedBy: staffUserId,
  },
].map((request) => serviceRequestSchema.parse(request));

const issueOpenId = id(701);
const issueVoucherId = id(702);
const voucherId = id(901);

const orderIssues: OrderIssue[] = [
  {
    id: issueOpenId,
    ...scope,
    orderId: order.id,
    orderItemId: orderItems[1].id,
    type: "unfulfillable" as const,
    reason: "out_of_stock" as const,
    reasonNote: "Bahan nasi goreng habis mendadak saat pesanan diproses",
    stationId: null,
    employeeId: null,
    resolution: null,
    replacementItemId: null,
    voucherId: null,
    priceDifferenceIdr: null,
    costIdr: idr(12_000),
    approvedBy: null,
    status: "open" as const,
    reportedBy: staffUserId,
    createdAt: "2026-11-01T05:00:00.000Z",
    resolvedAt: null,
  },
  {
    id: issueVoucherId,
    ...scope,
    orderId: order.id,
    orderItemId: orderItems[2].id,
    type: "remake" as const,
    reason: "quality" as const,
    reasonNote:
      "Croissant gosong dan tamu menolak remake, disetujui kredit voucher",
    stationId: null,
    employeeId: staffUserId,
    resolution: "voucher" as const,
    replacementItemId: null,
    voucherId,
    priceDifferenceIdr: null,
    costIdr: idr(14_000),
    approvedBy: staffUserId,
    status: "resolved" as const,
    reportedBy: staffUserId,
    createdAt: "2026-11-01T04:58:00.000Z",
    resolvedAt: "2026-11-01T05:02:00.000Z",
  },
].map((issue) => orderIssueSchema.parse(issue));

const orderIssueOptions = orderIssueOptionsSchema.parse({
  issueId: issueOpenId,
  swap: {
    allowed: true,
    suggestedMenuItemIds: [menuItem("Mie Goreng Jawa").id],
  },
  voucher: {
    allowed: true,
    valueIdr: orderItems[1].lineTotalIdr,
  },
  manualRefundOfferedToCustomer: false,
});

const apologyVoucher: ApologyVoucher = apologyVoucherSchema.parse({
  id: voucherId,
  ...scope,
  code: "LEG-7K2M-4QX9",
  valueIdr: idr(35_000),
  status: "issued",
  reason: "Permintaan maaf atas croissant yang tidak dapat disajikan",
  orderIssueId: issueVoucherId,
  customerProfileId: null,
  issuedBy: staffUserId,
  approvalRequestId: null,
  issuedAt: "2026-11-01T05:02:00.000Z",
  expiresAt: fixtureTimeAfter({ days: 31, hours: 5, minutes: 2 }),
  redeemedAt: null,
  redemptionOrderId: null,
});

const review = tableReviewSchema.parse({
  id: id(951),
  ...scope,
  tableSessionId: sessions[3].id,
  participantId: participants[5].id,
  rating: 5,
  comment: "Kopi susu arennya pas, pelayanan cepat.",
  googleReviewPrompt: true,
  googleReviewUrl: "https://g.page/r/cafe-legend/review",
  submittedAt: "2026-11-01T03:05:00.000Z",
});

const qrTokenPayload = qrTokenPayloadSchema.parse({
  version: 1,
  tenantId: tenant.id,
  outletId: outlet.id,
  tableId: tableOf("A03").id,
  keyId: "qr-2026-11",
  issuedAt: "2026-11-01T00:00:00.000Z",
});

const tableQr = tableQrSchema.parse({
  tableId: tableOf("A03").id,
  token: `v1.${"A".repeat(40)}.${"B".repeat(43)}`,
  url: `https://legend.example/t/v1.${"A".repeat(40)}.${"B".repeat(43)}`,
  issuedAt: "2026-11-01T00:00:00.000Z",
});

const scanResult = qrScanResultSchema.parse({
  outcome: "joined",
  table: tableOf("A03"),
  zone: zones[0],
  outlet,
  brand,
  session: sessions[0],
  sessionToken: "st_01JC0QRD4M5N6P7Q8R9S0T1V2W",
  // 12 h from the session open (04:30Z), never extended by a rescan.
  sessionTokenExpiresAt: tableSessionTokenExpiresAt(sessions[0]),
  menuUpdatedAt: "2026-11-01T05:00:00.000Z",
  soldOutItemIds: [],
  serverTime: "2026-11-01T05:10:00.000Z",
});

const liveTables = new Map<
  string,
  {
    session: TableSession;
    billTotalIdr: number;
    outstandingIdr: number;
    openServiceRequestCount: number;
  }
>([
  [
    tableOf("A03").id,
    {
      session: sessions[0],
      billTotalIdr: 0,
      outstandingIdr: 0,
      openServiceRequestCount: 1,
    },
  ],
  [
    tableOf("P1").id,
    {
      session: sessions[1],
      billTotalIdr: bill.totals.totalIdr,
      outstandingIdr: bill.totals.outstandingIdr,
      openServiceRequestCount: 0,
    },
  ],
  [
    tableOf("W01").id,
    {
      session: sessions[2],
      billTotalIdr: 0,
      outstandingIdr: 0,
      openServiceRequestCount: 0,
    },
  ],
]);

const floorBoard = floorBoardSchema.parse({
  outletId: outlet.id,
  zones,
  tables: tables.map((table) => {
    const live = liveTables.get(table.id);
    return {
      table,
      session: live
        ? {
            id: live.session.id,
            status: live.session.status,
            pax: live.session.pax,
            paymentMode: live.session.paymentMode,
            openedAt: live.session.openedAt,
            lastActivityAt: live.session.lastActivityAt,
            billTotalIdr: idr(live.billTotalIdr),
          }
        : null,
      openServiceRequestCount: live?.openServiceRequestCount ?? 0,
      outstandingIdr: idr(live?.outstandingIdr ?? 0),
    };
  }),
  generatedAt: "2026-11-01T05:10:00.000Z",
});

const reviewEligibility = reviewEligibilitySchema.parse({
  sessionId: sessions[4].id,
  eligible: true,
  alreadySubmitted: false,
  googleReviewUrl: "https://g.page/r/cafe-legend/review",
});

export const qrOrderFixtureSchema = z.strictObject({
  zones: z.array(floorZoneSchema),
  tables: z.array(tableSchema),
  participants: z.array(sessionParticipantSchema),
  sessions: z.array(tableSessionSchema),
  cart: cartSchema,
  quotes: z.array(orderQuoteSchema),
  orders: z.array(qrOrderSchema),
  billSplits: z.array(billSplitSchema),
  sessionBills: z.array(sessionBillSchema),
  serviceRequests: z.array(serviceRequestSchema),
  orderIssues: z.array(orderIssueSchema),
  orderIssueOptions: orderIssueOptionsSchema,
  apologyVouchers: z.array(apologyVoucherSchema),
  reviews: z.array(tableReviewSchema),
  qrTokenPayload: qrTokenPayloadSchema,
  tableQr: tableQrSchema,
  scanResult: qrScanResultSchema,
  floorBoard: floorBoardSchema,
  reviewEligibility: reviewEligibilitySchema,
});

export const cafeLegendQrOrderFixtures = qrOrderFixtureSchema.parse({
  zones,
  tables,
  participants,
  sessions,
  cart,
  quotes: [quoteOpen, quotePrivateRoom],
  orders: [order],
  billSplits: splits,
  sessionBills: [bill],
  serviceRequests,
  orderIssues,
  orderIssueOptions,
  apologyVouchers: [apologyVoucher],
  reviews: [review],
  qrTokenPayload,
  tableQr,
  scanResult,
  floorBoard,
  reviewEligibility,
});

/** Named access for screens and tests. */
export const qrOrderFixtures = cafeLegendQrOrderFixtures;
export const openSessionQuote = quoteOpen;
export const privateRoomQuote = quotePrivateRoom;
export const placedQrOrder = order;
export const splitBillFixture = bill;
