// Delivery channel contract tests (bead legend-m7ak). PRD v1.7 §3 F20 /
// §3.23 "Integrasi Ojek Online", D12 (manual POS mode), §6.G
// delivery_channel_orders.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEndpointPath,
  pathParamNames,
} from "../packages/shared/src/api/endpoint.ts";
import { eventCatalog } from "../packages/shared/src/events/index.ts";
import { idr } from "../packages/shared/src/core/index.ts";
import * as delivery from "../packages/shared/src/delivery/index.ts";

const f = delivery.cafeLegendDeliveryFixtures;
const ids = delivery.deliveryFixtureIds;
const menuItemId = "00000000-0000-4000-8000-000000001200";

test("legend-5v8sm delivery attention query uses explicit booleans and rejects ambiguous values", () => {
  assert.equal(
    delivery.listDeliveryOrdersQuerySchema.parse({ attention: "true" })
      .attention,
    true,
  );
  assert.equal(
    delivery.listDeliveryOrdersQuerySchema.parse({ attention: "false" })
      .attention,
    false,
  );
  assert.equal(
    delivery.listDeliveryOrdersQuerySchema.parse({}).attention,
    undefined,
  );
  assert.equal(
    delivery.listDeliveryOrdersQuerySchema.safeParse({ attention: "yes" })
      .success,
    false,
  );
});

test("F20 Cafe Legend delivery channel fixtures parse (§6.G delivery_channel_orders)", () => {
  delivery.deliveryFixtureSchema.parse(f);
  assert.equal(f.channels.length, 3);
  assert.equal(f.orders.length, 4);
  assert.equal(f.settlementLines.length, 3);

  // One channel row per platform; ShopeeFood is still in manual mode (D12).
  assert.deepEqual(f.channels.map((channel) => channel.platform).sort(), [
    "gofood",
    "grabfood",
    "shopeefood",
  ]);
  assert.equal(
    f.channels.find((channel) => channel.platform === "shopeefood")?.isOpen,
    false,
  );
  assert.equal(
    f.channels.find((channel) => channel.platform === "grabfood")?.syncStatus,
    "stale",
  );

  // `external_order_id` is unique per platform (PRD §6.G), and every order
  // line preserves the platform's gross price and our channel price.
  const keys = f.orders.map(
    (order) => `${order.platform}:${order.externalOrderId}`,
  );
  assert.equal(new Set(keys).size, keys.length);
  for (const order of f.orders) {
    assert.ok(order.commissionIdr <= order.grossIdr);
    assert.equal(
      new Set(order.lines.map((line) => line.lineNo)).size,
      order.lines.length,
    );
    assert.match(order.payloadHash, /^[a-f0-9]{64}$/);
    for (const line of order.lines) {
      assert.match(line.externalItemName, /\S/);
      if (line.mapping !== "unmatched") {
        assert.ok(line.menuItemId);
        assert.ok(line.channelPriceIdr !== null);
      }
    }
  }
  // The delivered ShopeeFood order was recorded by the cashier, then settled.
  const manual = f.orders.find((order) => order.source === "manual_pos");
  assert.ok(manual);
  assert.equal(manual.status, "delivered");
  assert.ok(manual.settledAt);
  assert.equal(manual.settledNetIdr, manual.grossIdr - manual.commissionIdr);
});

test("F20 a platform price that differs from our channel price is flagged, not hidden", () => {
  const preparing = f.orders.find((order) => order.id === ids.preparingOrderId);
  assert.ok(preparing);
  const coffee = preparing.lines.find(
    (line) => line.externalItemName === "Kopi Susu Aren",
  );
  assert.equal(coffee.mapping, "price_mismatch");
  assert.ok(coffee.channelPriceIdr < coffee.unitPriceIdr);
  // A price mismatch does not block the kitchen: only an unmatched line does.
  assert.equal(delivery.deliveryOrderIsInjectable(preparing), true);

  const unmatched = {
    lines: [
      {
        ...preparing.lines[0],
        mapping: "unmatched",
        menuItemId: null,
        channelPriceIdr: null,
      },
    ],
  };
  assert.equal(delivery.deliveryOrderIsInjectable(unmatched), false);
  assert.throws(
    () => delivery.assertDeliveryOrderInjectable(unmatched),
    (error) => error.code === "DELIVERY_MAPPING_INCOMPLETE",
  );
  // An injected order (it has an internal orderId) cannot hold an unmatched line.
  assert.notEqual(preparing.orderId, null);
  assert.equal(
    delivery.deliveryChannelOrderSchema.safeParse({
      ...preparing,
      lines: unmatched.lines,
    }).success,
    false,
  );
  assert.equal(
    delivery.deliveryChannelOrderSchema.safeParse({
      ...preparing,
      orderId: null,
      number: null,
      status: "received",
      acceptedAt: null,
      readyAt: null,
      lines: unmatched.lines,
    }).success,
    true,
  );
  // The schema keeps mapping and menu link coherent.
  assert.equal(
    delivery.deliveryOrderLineSchema.safeParse({
      ...preparing.lines[0],
      mapping: "unmatched",
    }).success,
    false,
  );
});

test("F20 every fulfilment step maps to a DeliveryChannel adapter action", () => {
  assert.equal(
    delivery.canTransitionDeliveryOrder("received", "accepted"),
    true,
  );
  assert.equal(
    delivery.canTransitionDeliveryOrder("received", "delivered"),
    false,
  );
  assert.equal(
    delivery.canTransitionDeliveryOrder("delivered", "cancelled"),
    false,
  );
  assert.equal(delivery.canTransitionDeliveryOrder("preparing", "ready"), true);
  assert.throws(
    () => delivery.assertDeliveryOrderTransition("delivered", "cancelled"),
    (error) => error.code === "DELIVERY_TRANSITION_INVALID",
  );

  assert.equal(
    delivery.deliveryActionForTransition("received", "accepted"),
    "accept_order",
  );
  assert.equal(
    delivery.deliveryActionForTransition("accepted", "preparing"),
    "update_order",
  );
  assert.equal(
    delivery.deliveryActionForTransition("ready", "picked_up"),
    "update_order",
  );
  assert.equal(
    delivery.deliveryActionForTransition("ready", "cancelled"),
    "cancel_order",
  );
  assert.equal(
    delivery.deliveryActionForTransition("received", "rejected"),
    "cancel_order",
  );
  // No adapter call for an invalid step (the service still rejects it).
  assert.equal(
    delivery.deliveryActionForTransition("delivered", "received"),
    null,
  );
  // The fixture's cancelled order records when and why it closed.
  const cancelled = f.orders.find((order) => order.id === ids.cancelledOrderId);
  assert.ok(cancelled.closedAt);
  assert.ok(cancelled.closeReason);
});

test("F20 commission reconciliation: net = gross − commission, variance and unknown order", () => {
  const received = f.orders.find((order) => order.id === ids.receivedOrderId);
  const matched = delivery.reconcileDeliveryLine(
    {
      id: received.id,
      grossIdr: received.grossIdr,
      commissionIdr: received.commissionIdr,
    },
    { settledNetIdr: idr(received.grossIdr - received.commissionIdr) },
  );
  assert.equal(matched.status, "matched");
  assert.equal(matched.varianceIdr, 0);
  assert.equal(
    delivery.deliveryNetIdr(received),
    received.grossIdr - received.commissionIdr,
  );

  const shortPaid = delivery.reconcileDeliveryLine(
    {
      id: received.id,
      grossIdr: received.grossIdr,
      commissionIdr: received.commissionIdr,
    },
    { settledNetIdr: idr(received.grossIdr - received.commissionIdr - 2_400) },
  );
  assert.equal(shortPaid.status, "variance");
  assert.equal(shortPaid.varianceIdr, -2_400);

  // The platform statement names an order the outlet never recorded.
  const unknown = delivery.reconcileDeliveryLine(null, {
    settledNetIdr: idr(40_000),
  });
  assert.equal(unknown.status, "unknown_order");
  assert.equal(unknown.varianceIdr, 40_000);

  // The fixture summary is derived from its lines, never hand-written.
  const summary = delivery.deliveryReconciliationSummaryOf(f.settlementLines);
  assert.deepEqual(summary, f.reconciliation.summary);
  assert.equal(summary.lineCount, 3);
  assert.equal(summary.matchedCount, 1);
  assert.equal(summary.varianceCount, 1);
  assert.equal(summary.unknownOrderCount, 1);
  assert.equal(summary.grossIdr - summary.commissionIdr, 231_000 - 46_200);
  assert.equal(summary.varianceIdr, -2_400 + 40_000);
  // Line statuses stay consistent with the order and the amount.
  assert.equal(
    delivery.deliverySettlementLineSchema.safeParse({
      ...f.settlementLines[0],
      varianceIdr: idr(1),
    }).success,
    false,
  );
});

test("D12 manual POS entry records the channel order without client money", () => {
  const manual = {
    platform: "shopeefood",
    externalOrderId: "SHP-UJI-0001",
    lines: [{ menuItemId, quantity: 2, note: "Tanpa sambal" }],
    customerNote: "Antar ke lobby.",
  };
  assert.ok(delivery.createManualDeliveryOrderInputSchema.parse(manual));
  // TEN-02: the tenant comes from the session, never from the body.
  assert.equal(
    delivery.createManualDeliveryOrderInputSchema.safeParse({
      ...manual,
      tenantId: f.orders[0].tenantId,
    }).success,
    false,
  );
  // The server resolves the channel price; the client cannot send money.
  assert.equal(
    delivery.createManualDeliveryOrderInputSchema.safeParse({
      ...manual,
      lines: [{ menuItemId, quantity: 1, unitPriceIdr: 1_000 }],
    }).success,
    false,
  );
  // Cancelling or rejecting names a reason.
  assert.equal(
    delivery.updateDeliveryOrderStatusInputSchema.safeParse({
      status: "cancelled",
    }).success,
    false,
  );
  assert.equal(
    delivery.updateDeliveryOrderStatusInputSchema.safeParse({
      status: "cancelled",
      reason: "Item habis.",
    }).success,
    true,
  );
});

test("delivery events are registered in the WS-00 catalog with typed payloads (§3.23)", () => {
  const names = eventCatalog.map((entry) => entry.name);
  for (const event of delivery.deliveryEventCatalogEntries) {
    assert.ok(names.includes(event.name), event.name);
    assert.equal(event.workstream, "WS-08");
    assert.equal(event.version, 1);
    assert.equal(event.payloadSchemaRef, `${event.name}.v1`);
  }
  assert.deepEqual(
    delivery.deliveryEventCatalogEntries.map((entry) => entry.name),
    delivery.deliveryEventNames,
  );
  const received = delivery.deliveryEventFixtures.received;
  assert.ok(delivery.deliveryEventSchema.parse(received));
  // A negative gross amount and the wrong event name fail.
  assert.equal(
    delivery.deliveryEventSchema.safeParse({
      ...received,
      payload: { ...received.payload, grossIdr: -1 },
    }).success,
    false,
  );
  assert.equal(
    delivery.deliveryEventSchema.safeParse({
      ...received,
      name: "delivery_order.settled",
    }).success,
    false,
  );
  // The settled payload carries the signed variance (0 for a clean match).
  assert.equal(delivery.deliveryEventFixtures.settled.payload.varianceIdr, 0);
  assert.equal(delivery.deliveryEventPayloadSchema("order.paid"), null);
  assert.equal(delivery.deliveryEventPayloadSchema("constructor"), null);
});

test("delivery endpoint contracts are unique and path-param complete", () => {
  const endpoints = Object.values(delivery).filter(
    (value) =>
      value &&
      typeof value === "object" &&
      typeof value.id === "string" &&
      typeof value.method === "string" &&
      typeof value.path === "string" &&
      value.id === `${value.method} ${value.path}`,
  );
  assert.ok(endpoints.length >= 7, `found ${endpoints.length} endpoints`);
  const ids = endpoints.map((endpoint) => endpoint.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const endpoint of endpoints) {
    assert.ok(endpoint.path.startsWith("/"), endpoint.id);
    const names = pathParamNames(endpoint.path);
    if (names.length > 0) assert.ok(endpoint.params, endpoint.id);
    for (const name of names)
      assert.ok(
        Object.hasOwn(endpoint.params.shape, name),
        `${endpoint.id} declares no schema for :${name}`,
      );
  }
  assert.equal(
    buildEndpointPath(delivery.setDeliveryChannelState.path, {
      outletId: f.orders[0].outletId,
      platform: "gofood",
    }),
    `/api/outlets/${f.orders[0].outletId}/delivery-channels/gofood`,
  );
});
