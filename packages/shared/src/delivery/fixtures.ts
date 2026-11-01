// Cafe Legend delivery channel fixtures: the three platform channels (GoFood
// live, GrabFood with a stale menu sync, ShopeeFood still in manual mode), four
// platform orders in different fulfilment states, and one GoFood commission
// reconciliation with a matched, a variance and an unknown order.
//
// Menu ids and channel prices come from `cafeLegendMenuFixtures` (the fixture
// price list is the dine-in channel; the GrabFood line deliberately shows a
// platform price that differs, which is the `price_mismatch` staff review case).
// Sample data, not the owner's negotiated platform commission or menu.

import { cafeLegendFixtures, idr, z } from "../core/index.ts";
import { cafeLegendMenuFixtures } from "../menu/index.ts";
import {
  deliveryChannelOrderIdSchema,
  deliveryChannelOrderSchema,
  deliveryChannelSchema,
  deliveryReconciliationSchema,
  deliverySettlementLineSchema,
  deliveryReconciliationSummaryOf,
} from "./schemas.ts";
import type {
  DeliveryChannel,
  DeliveryChannelOrder,
  DeliverySettlementLine,
} from "./schemas.ts";
import { deliveryEventSchema } from "./events.ts";

const { tenant, outlets } = cafeLegendFixtures;
const outlet = outlets[0];
const scope = { tenantId: tenant.id, outletId: outlet.id };
const orderId = cafeLegendFixtures.orderId;
const secondOrderId = "01JBQ7Z8K0A1B2C3D4E5F6G7H9";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const menuItem = (name: string) => {
  const item = cafeLegendMenuFixtures.items.find(
    (entry) => entry.name === name,
  );
  if (!item) throw new RangeError(`Unknown menu fixture item: ${name}`);
  return item;
};
const channelPriceOf = (menuItemId: string) => {
  const row = cafeLegendMenuFixtures.priceListItems.find(
    (entry) => entry.itemId === menuItemId,
  );
  if (!row) throw new RangeError(`No channel price for item ${menuItemId}`);
  return row.priceIdr;
};
const digest =
  "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b";

const kopiSusuAren = menuItem("Kopi Susu Aren");
const nasiGoreng = menuItem("Nasi Goreng Kampung");
const esCokelat = menuItem("Es Cokelat");
const croissant = menuItem("Croissant Mentega");
const ayamGeprek = menuItem("Ayam Geprek");

const channels: DeliveryChannel[] = [
  deliveryChannelSchema.parse({
    ...scope,
    platform: "gofood",
    isOpen: true,
    closedUntil: null,
    closedReason: null,
    syncStatus: "ok",
    lastSyncedAt: "2026-11-01T05:30:00.000Z",
    syncError: null,
    menuItemCount: cafeLegendMenuFixtures.items.length,
    soldOutItemCount: 2,
    updatedAt: "2026-11-01T05:30:00.000Z",
  }),
  deliveryChannelSchema.parse({
    ...scope,
    platform: "grabfood",
    isOpen: true,
    closedUntil: null,
    closedReason: null,
    syncStatus: "stale",
    lastSyncedAt: "2026-11-01T02:00:00.000Z",
    syncError: null,
    menuItemCount: cafeLegendMenuFixtures.items.length - 1,
    soldOutItemCount: 1,
    updatedAt: "2026-11-01T02:00:00.000Z",
  }),
  deliveryChannelSchema.parse({
    ...scope,
    platform: "shopeefood",
    isOpen: false,
    closedUntil: null,
    closedReason: "Menunggu persetujuan mitra; pesanan dicatat manual di POS.",
    syncStatus: "error",
    lastSyncedAt: null,
    syncError: "Integrasi ShopeeFood belum aktif (PRD D12 mode manual).",
    menuItemCount: 0,
    soldOutItemCount: 0,
    updatedAt: "2026-11-01T03:00:00.000Z",
  }),
];

const orders: DeliveryChannelOrder[] = [
  // Just arrived from GoFood; the cashier still has to accept it.
  deliveryChannelOrderSchema.parse({
    id: id(7_001),
    ...scope,
    platform: "gofood",
    externalOrderId: "GF-2026-1101-4471",
    orderId: null,
    number: null,
    status: "received",
    source: "platform",
    grossIdr: 78_000,
    commissionIdr: 15_600,
    payloadHash: digest,
    customerNote: "Sambal dipisah.",
    lines: [
      {
        lineNo: 1,
        externalItemId: "GF-ITEM-12",
        externalItemName: "Nasi Goreng Kampung",
        menuItemId: nasiGoreng.id,
        variantId: null,
        quantity: 2,
        unitPriceIdr: 20_000,
        lineTotalIdr: 40_000,
        modifiers: [],
        note: null,
        mapping: "matched",
        channelPriceIdr: channelPriceOf(nasiGoreng.id),
      },
      {
        lineNo: 2,
        externalItemId: "GF-ITEM-31",
        externalItemName: "Es Cokelat",
        menuItemId: esCokelat.id,
        variantId: null,
        quantity: 1,
        unitPriceIdr: 38_000,
        lineTotalIdr: 38_000,
        modifiers: [{ name: "Less sugar", priceIdr: idr(0) }],
        note: null,
        mapping: "matched",
        channelPriceIdr: channelPriceOf(esCokelat.id),
      },
    ],
    receivedAt: "2026-11-01T05:42:00.000Z",
    acceptedAt: null,
    readyAt: null,
    pickedUpAt: null,
    deliveredAt: null,
    closedAt: null,
    closeReason: null,
    settledAt: null,
    settledNetIdr: null,
  }),
  // In preparation; the platform charged Rp2.000 more per coffee than our channel price.
  deliveryChannelOrderSchema.parse({
    id: id(7_002),
    ...scope,
    platform: "gofood",
    externalOrderId: "GF-2026-1101-4452",
    orderId: secondOrderId,
    number: "D-0231",
    status: "preparing",
    source: "platform",
    grossIdr: 103_000,
    commissionIdr: 20_600,
    payloadHash: digest,
    customerNote: null,
    lines: [
      {
        lineNo: 1,
        externalItemId: "GRB-1004",
        externalItemName: "Kopi Susu Aren",
        menuItemId: kopiSusuAren.id,
        variantId: null,
        quantity: 2,
        unitPriceIdr: 34_000,
        lineTotalIdr: 68_000,
        modifiers: [],
        note: null,
        mapping: "price_mismatch",
        channelPriceIdr: channelPriceOf(kopiSusuAren.id),
      },
      {
        lineNo: 2,
        externalItemId: "GRB-1300",
        externalItemName: "Croissant Mentega",
        menuItemId: croissant.id,
        variantId: null,
        quantity: 1,
        unitPriceIdr: 35_000,
        lineTotalIdr: 35_000,
        modifiers: [],
        note: null,
        mapping: "matched",
        channelPriceIdr: channelPriceOf(croissant.id),
      },
    ],
    receivedAt: "2026-11-01T04:59:00.000Z",
    acceptedAt: "2026-11-01T05:01:00.000Z",
    readyAt: null,
    pickedUpAt: null,
    deliveredAt: null,
    closedAt: null,
    closeReason: null,
    settledAt: null,
    settledNetIdr: null,
  }),
  // Recorded by the cashier before ShopeeFood integration (D12), then settled.
  deliveryChannelOrderSchema.parse({
    id: id(7_003),
    ...scope,
    platform: "shopeefood",
    externalOrderId: "SHP-77120",
    orderId: orderId,
    number: "D-0228",
    status: "delivered",
    source: "manual_pos",
    grossIdr: 35_000,
    commissionIdr: 7_000,
    payloadHash: digest,
    customerNote: "Tanpa nasi tambahan.",
    lines: [
      {
        lineNo: 1,
        externalItemId: null,
        externalItemName: "Ayam Geprek",
        menuItemId: ayamGeprek.id,
        variantId: null,
        quantity: 1,
        unitPriceIdr: 35_000,
        lineTotalIdr: 35_000,
        modifiers: [],
        note: "Level 3",
        mapping: "matched",
        channelPriceIdr: channelPriceOf(ayamGeprek.id),
      },
    ],
    receivedAt: "2026-11-01T02:10:00.000Z",
    acceptedAt: "2026-11-01T02:11:00.000Z",
    readyAt: "2026-11-01T02:25:00.000Z",
    pickedUpAt: "2026-11-01T02:31:00.000Z",
    deliveredAt: "2026-11-01T03:02:00.000Z",
    closedAt: null,
    closeReason: null,
    settledAt: "2026-11-01T04:00:00.000Z",
    settledNetIdr: 28_000,
  }),
  // Cancelled by the kitchen because the item ran out.
  deliveryChannelOrderSchema.parse({
    id: id(7_004),
    ...scope,
    platform: "gofood",
    externalOrderId: "GF-2026-1101-4468",
    orderId: null,
    number: null,
    status: "cancelled",
    source: "platform",
    grossIdr: 20_000,
    commissionIdr: 0,
    payloadHash: digest,
    customerNote: null,
    lines: [
      {
        lineNo: 1,
        externalItemId: "GF-ITEM-12",
        externalItemName: "Nasi Goreng Kampung",
        menuItemId: nasiGoreng.id,
        variantId: null,
        quantity: 1,
        unitPriceIdr: 20_000,
        lineTotalIdr: 20_000,
        modifiers: [],
        note: null,
        mapping: "matched",
        channelPriceIdr: channelPriceOf(nasiGoreng.id),
      },
    ],
    receivedAt: "2026-11-01T04:40:00.000Z",
    acceptedAt: null,
    readyAt: null,
    pickedUpAt: null,
    deliveredAt: null,
    closedAt: "2026-11-01T04:44:00.000Z",
    closeReason: "Bahan habis sebelum jam tutup.",
    settledAt: null,
    settledNetIdr: null,
  }),
];

const settlementLines: DeliverySettlementLine[] = [
  deliverySettlementLineSchema.parse({
    id: id(7_101),
    ...scope,
    platform: "gofood",
    externalOrderId: "GF-2026-1101-4471",
    grossIdr: 78_000,
    commissionIdr: 15_600,
    settledNetIdr: 62_400,
    deliveryChannelOrderId: deliveryChannelOrderIdSchema.parse(id(7_001)),
    status: "matched",
    varianceIdr: 0,
    settledOn: "2026-11-01",
  }),
  deliverySettlementLineSchema.parse({
    id: id(7_102),
    ...scope,
    platform: "gofood",
    externalOrderId: "GF-2026-1101-4452",
    grossIdr: 103_000,
    commissionIdr: 20_600,
    settledNetIdr: 80_000,
    deliveryChannelOrderId: deliveryChannelOrderIdSchema.parse(id(7_002)),
    status: "variance",
    varianceIdr: -2_400,
    settledOn: "2026-11-01",
  }),
  // The platform paid for an order the outlet never recorded.
  deliverySettlementLineSchema.parse({
    id: id(7_103),
    ...scope,
    platform: "gofood",
    externalOrderId: "GF-2026-1101-9930",
    grossIdr: 50_000,
    commissionIdr: 10_000,
    settledNetIdr: 40_000,
    deliveryChannelOrderId: null,
    status: "unknown_order",
    varianceIdr: 40_000,
    settledOn: "2026-11-01",
  }),
];

const reconciliation = deliveryReconciliationSchema.parse({
  ...scope,
  platform: "gofood",
  periodStart: "2026-11-01",
  periodEnd: "2026-11-01",
  lines: settlementLines,
  summary: deliveryReconciliationSummaryOf(settlementLines),
});

export const deliveryFixtureSchema = z.strictObject({
  channels: z.array(deliveryChannelSchema).min(1),
  orders: z.array(deliveryChannelOrderSchema).min(1),
  settlementLines: z.array(deliverySettlementLineSchema),
  reconciliation: deliveryReconciliationSchema,
});
export type DeliveryFixtures = z.infer<typeof deliveryFixtureSchema>;

export const cafeLegendDeliveryFixtures: DeliveryFixtures =
  deliveryFixtureSchema.parse({
    channels,
    orders,
    settlementLines,
    reconciliation,
  });

/** One typed envelope per lifecycle step, validated at module load. */
export const deliveryEventFixtures = {
  received: deliveryEventSchema.parse({
    id: "01JBQ7Z8K0A1B2C3D4E5F70001",
    tenantId: tenant.id,
    outletId: outlet.id,
    name: "delivery_order.received",
    version: 1,
    aggregateType: "delivery_order",
    aggregateId: orders[0].id,
    sequence: 1,
    occurredAt: orders[0].receivedAt,
    actor: { type: "system" },
    idempotencyKey: "delivery:gofood:GF-2026-1101-4471",
    payloadSchemaRef: "delivery_order.received.v1",
    payload: {
      deliveryChannelOrderId: orders[0].id,
      platform: orders[0].platform,
      externalOrderId: orders[0].externalOrderId,
      orderId: null,
      source: orders[0].source,
      grossIdr: orders[0].grossIdr,
      commissionIdr: orders[0].commissionIdr,
      payloadHash: orders[0].payloadHash,
    },
  }),
  settled: deliveryEventSchema.parse({
    id: "01JBQ7Z8K0A1B2C3D4E5F70002",
    tenantId: tenant.id,
    outletId: outlet.id,
    name: "delivery_order.settled",
    version: 1,
    aggregateType: "delivery_order",
    aggregateId: orders[2].id,
    sequence: 5,
    occurredAt: orders[2].settledAt,
    actor: { type: "system" },
    idempotencyKey: "delivery:shopeefood:SHP-77120:settled",
    payloadSchemaRef: "delivery_order.settled.v1",
    payload: {
      deliveryChannelOrderId: orders[2].id,
      platform: orders[2].platform,
      externalOrderId: orders[2].externalOrderId,
      grossIdr: orders[2].grossIdr,
      commissionIdr: orders[2].commissionIdr,
      settledNetIdr: orders[2].settledNetIdr,
      varianceIdr: 0,
    },
  }),
} as const;

/** Stable ids other contracts or seeders may reference. */
export const deliveryFixtureIds = {
  receivedOrderId: orders[0].id,
  preparingOrderId: orders[1].id,
  deliveredOrderId: orders[2].id,
  cancelledOrderId: orders[3].id,
  gofoodExternalOrderId: orders[0].externalOrderId,
  preparingExternalOrderId: orders[1].externalOrderId,
} as const;
