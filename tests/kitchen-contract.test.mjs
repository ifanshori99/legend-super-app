// Kitchen contract tests (bead legend-acz). Cites PRD v1.7 §3 F12 "KDS, Expo &
// Pickup Display", §3 F11 "Estimasi Waktu Saji", §6 group C (`kitchen_tickets`,
// `order_items`, `stations`, `kitchen_capacity_rules`, `order_issues`) and
// acceptance criteria KDS-03..KDS-07 (contract level).

import assert from "node:assert/strict";
import { test } from "node:test";
import * as kitchen from "../packages/shared/src/kitchen/index.ts";
import * as qrOrder from "../packages/shared/src/qr-order/index.ts";
import * as menu from "../packages/shared/src/menu/index.ts";
import * as events from "../packages/shared/src/events/index.ts";
import * as api from "../packages/shared/src/api/index.ts";

const fixtures = kitchen.cafeLegendKitchenFixtures;

test("PRD §6 kitchen tables: Cafe Legend fixtures parse and reference each other", () => {
  // Throws on any drift between fixtures and schemas (strict objects).
  kitchen.kitchenFixtureSchema.parse(fixtures);
  assert.ok(fixtures.tickets.length >= 5);
  assert.ok(fixtures.ticketItems.length >= fixtures.tickets.length);

  const ticketIds = new Set(fixtures.tickets.map((row) => row.id));
  const orderIds = new Set(fixtures.tickets.map((row) => row.orderId));
  const menuStations = new Set(
    menu.cafeLegendMenuFixtures.stations.map((row) => row.id),
  );
  const menuItems = new Set(
    menu.cafeLegendMenuFixtures.items.map((row) => row.id),
  );

  for (const item of fixtures.ticketItems) {
    assert.ok(ticketIds.has(item.ticketId), "item belongs to a ticket");
    assert.ok(orderIds.has(item.orderId), "item carries its ticket's order");
    assert.ok(menuItems.has(item.menuItemId), "item references a menu item");
  }
  for (const ticket of fixtures.tickets)
    assert.ok(
      menuStations.has(ticket.stationId),
      "ticket routes to a menu station",
    );
  for (const change of fixtures.ticketStatusChanges) {
    assert.ok(ticketIds.has(change.ticketId), "audit row belongs to a ticket");
    assert.ok(orderIds.has(change.orderId), "audit row carries the order");
  }
  // Every station has exactly one config, and configs point at menu stations.
  assert.deepEqual(
    fixtures.stationConfigs.map((row) => row.stationId).sort(),
    [...menuStations].sort(),
  );
});

test("KDS-04: ticket transitions are explicit and cancelled is terminal", () => {
  assert.equal(kitchen.transitionKitchenTicket("new", "start"), "in_progress");
  assert.equal(kitchen.transitionKitchenTicket("in_progress", "bump"), "done");
  assert.equal(kitchen.transitionKitchenTicket("done", "recall"), "recalled");
  assert.equal(
    kitchen.transitionKitchenTicket("recalled", "start"),
    "in_progress",
  );
  assert.equal(kitchen.transitionKitchenTicket("new", "void"), "cancelled");
  for (const action of ["start", "bump", "recall", "void"])
    assert.equal(
      kitchen.canTransitionKitchenTicket("cancelled", action),
      false,
    );
  assert.throws(
    () => kitchen.transitionKitchenTicket("new", "bump"),
    RangeError,
  );
  assert.throws(
    () => kitchen.transitionKitchenTicket("done", "start"),
    RangeError,
  );
  assert.throws(
    () => kitchen.transitionKitchenTicket("cancelled", "start"),
    RangeError,
  );
});

test("KDS-04: item transitions track production, recall and void", () => {
  assert.equal(kitchen.transitionKitchenItem("queued", "start"), "in_progress");
  assert.equal(kitchen.transitionKitchenItem("in_progress", "ready"), "ready");
  assert.equal(kitchen.transitionKitchenItem("ready", "serve"), "served");
  assert.equal(kitchen.transitionKitchenItem("ready", "recall"), "in_progress");
  assert.equal(kitchen.transitionKitchenItem("queued", "void"), "voided");
  assert.equal(kitchen.canTransitionKitchenItem("served", "void"), false);
  assert.equal(kitchen.canTransitionKitchenItem("voided", "start"), false);
  assert.throws(
    () => kitchen.transitionKitchenItem("served", "recall"),
    RangeError,
  );
});

test("KDS-04: every status change records time, user or device and a reason", () => {
  const base = fixtures.ticketStatusChanges[0];
  const change = { ...base };
  assert.equal(
    kitchen.ticketStatusChangeSchema.safeParse({ ...change, actorId: null })
      .success,
    false,
    "a user change without an actor has no audit trail",
  );
  assert.equal(
    kitchen.ticketStatusChangeSchema.safeParse({
      ...change,
      source: "device",
      deviceId: null,
    }).success,
    false,
    "a device change names the device",
  );
  assert.equal(
    kitchen.ticketStatusChangeSchema.safeParse({
      ...change,
      toStatus: "recalled",
      reason: null,
    }).success,
    false,
    "a recall records why it came back",
  );
  assert.equal(
    kitchen.ticketStatusChangeSchema.safeParse({
      ...change,
      source: "system",
      actorId: null,
    }).success,
    true,
    "system rows (printed fallback) have no user",
  );

  // The fixture audit replays to each ticket's current status.
  for (const ticket of fixtures.tickets) {
    const rows = fixtures.ticketStatusChanges
      .filter((row) => row.ticketId === ticket.id)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    assert.ok(rows.length > 0, "ticket has an audit trail");
    assert.equal(rows[0].fromStatus, null, "the first row creates the ticket");
    assert.equal(rows.at(-1).toStatus, ticket.status);
  }
  // F12 aksi tiket: started/bumped times exist for every finished ticket.
  for (const ticket of fixtures.tickets)
    if (ticket.status !== "new" && ticket.status !== "cancelled")
      assert.ok(ticket.startedAt, "started tickets record startedAt");
});

test("PRD §6 kitchen_capacity_rules + KDS-05: pacing levels derive from capacity", () => {
  assert.equal(kitchen.capacityLevelFor(0, 18, 9000), "available");
  assert.equal(kitchen.capacityLevelFor(16, 18, 9000), "available");
  assert.equal(kitchen.capacityLevelFor(17, 18, 9000), "near_capacity");
  assert.equal(kitchen.capacityLevelFor(18, 18, 9000), "at_capacity");
  assert.equal(kitchen.capacityLevelFor(20, 18, 9000), "at_capacity");
  assert.throws(() => kitchen.capacityLevelFor(-1, 18, 9000), RangeError);
  assert.throws(() => kitchen.capacityLevelFor(1, 0, 9000), RangeError);
  assert.throws(() => kitchen.capacityLevelFor(1, 18, 10_001), RangeError);

  const rule = fixtures.capacityRules[0];
  assert.equal(
    kitchen.capacityRuleSchema.safeParse({
      ...rule,
      channelPriority: ["dine_in", "dine_in"],
    }).success,
    false,
    "a channel appears once in the priority list",
  );
  assert.equal(
    kitchen.capacityRuleSchema.safeParse({ ...rule, windowMinutes: 7 }).success,
    false,
    "windows are whole 5-minute slices",
  );
  assert.equal(
    kitchen.capacityRuleSchema.safeParse({ ...rule, nearCapacityBp: 0 })
      .success,
    false,
    "the near-capacity level is above zero",
  );

  const row = fixtures.pacing.stations[0];
  assert.equal(
    kitchen.stationPacingSchema.safeParse({ ...row, status: "at_capacity" })
      .success,
    false,
    "a pacing row cannot lie about its level",
  );
  // KDS-05 needs the near threshold to refresh estimates before the station fills.
  assert.ok(
    fixtures.pacing.stations.some((row) => row.status === "near_capacity"),
  );
  assert.ok(
    fixtures.pacing.stations.some((row) => row.status === "at_capacity"),
  );
});

test("PRD §3 F12 all-day count and expo board: station queue and runner assignment", () => {
  const board = fixtures.stationBoards[0];
  kitchen.stationBoardSchema.parse(board);
  assert.deepEqual(
    board.allDay.rows.reduce((sum, row) => sum + row.quantity, 0),
    10,
    "all-day count sums queued quantities for batch prep",
  );

  const complete = fixtures.expo.tickets.find((ticket) => ticket.isComplete);
  assert.ok(complete?.readyAt, "a complete expo ticket records readyAt");
  assert.ok(complete?.runnerId, "the complete ticket has a runner");
  assert.equal(
    kitchen.expoTicketSchema.safeParse({
      ...complete,
      readyAt: null,
    }).success,
    false,
    "complete without readyAt is rejected",
  );
  assert.equal(
    kitchen.expoTicketSchema.safeParse({
      ...fixtures.expo.tickets[0],
      runnerId: complete.runnerId,
      runnerAssignedAt: null,
    }).success,
    false,
    "a runner assignment carries its timestamp",
  );
});

test("PRD §3 F12 pickup display: call numbers are unique per outlet per day", () => {
  const seen = new Set();
  for (const call of fixtures.pickupDisplay.calls) {
    const key = `${call.businessDate}:${call.number}`;
    assert.equal(seen.has(key), false, "call numbers do not repeat in a day");
    seen.add(key);
  }
  assert.equal(
    kitchen.pickupCallSchema.safeParse({
      ...fixtures.pickupDisplay.calls[0],
      status: "picked_up",
      pickedUpAt: null,
    }).success,
    false,
    "a picked-up number records pickedUpAt",
  );
  assert.ok(
    fixtures.pickupDisplay.calls.some((call) => call.status === "called"),
    "the display has a called number to announce",
  );
});

test("legend-usw3 pickup: called -> picked_up is explicit, repeat is idempotent", () => {
  const {
    assigned,
    called,
    picked_up: pickedUp,
  } = kitchen.PICKUP_CALL_TRANSITIONS;
  assert.deepEqual(assigned, { call: "called" });
  assert.deepEqual(called, { call: "called", pickup: "picked_up" });
  assert.deepEqual(pickedUp, { pickup: "picked_up" });

  // Valid moves.
  assert.equal(kitchen.transitionPickupCall("assigned", "call"), "called");
  assert.equal(kitchen.transitionPickupCall("called", "pickup"), "picked_up");
  // Invalid: a number cannot be picked up before it is called, and picked_up
  // is terminal (no re-call, no reopen).
  assert.equal(kitchen.canTransitionPickupCall("assigned", "pickup"), false);
  assert.equal(kitchen.canTransitionPickupCall("picked_up", "call"), false);
  assert.throws(
    () => kitchen.transitionPickupCall("assigned", "pickup"),
    RangeError,
  );
  assert.throws(
    () => kitchen.transitionPickupCall("picked_up", "call"),
    RangeError,
  );
  // Refusal codes are shared, not left to the API.
  assert.equal(
    kitchen.pickupCallBlock("assigned", "pickup"),
    "PICKUP_CALL_NOT_CALLED",
  );
  assert.equal(
    kitchen.pickupCallBlock("picked_up", "call"),
    "PICKUP_CALL_CLOSED",
  );
  assert.equal(kitchen.pickupCallBlock("called", "pickup"), null);
  assert.equal(kitchen.pickupCallBlock("picked_up", "pickup"), null);
  // Repeats keep the status, so the API answers 200 with the first timestamp.
  assert.equal(kitchen.isPickupCallRepeat("picked_up", "pickup"), true);
  assert.equal(kitchen.isPickupCallRepeat("called", "call"), true);
  assert.equal(kitchen.isPickupCallRepeat("called", "pickup"), false);
  assert.equal(
    kitchen.transitionPickupCall("picked_up", "pickup"),
    "picked_up",
  );

  // The fixture of every status is consistent with the table.
  for (const call of fixtures.pickupDisplay.calls)
    assert.ok(kitchen.pickupCallSchema.safeParse(call).success);

  // Endpoint shape: POST, no body, outlet scope in the path only (TEN-02).
  const endpoint = kitchen.markPickupPickedUp;
  assert.equal(endpoint.method, "POST");
  assert.equal(
    endpoint.path,
    "/api/outlets/:outletId/pickup-calls/:callId/picked-up",
  );
  assert.equal(endpoint.body, undefined);
  assert.equal(
    endpoint.params.safeParse({
      outletId: fixtures.pickupDisplay.outletId,
      callId: fixtures.pickupDisplay.calls[1].id,
    }).success,
    true,
  );
  assert.equal(
    endpoint.params.safeParse({
      outletId: fixtures.pickupDisplay.outletId,
      callId: "not-a-uuid",
    }).success,
    false,
  );
  // The response must carry pickedUpAt once picked up.
  assert.equal(
    endpoint.response.safeParse({
      data: { ...fixtures.pickupDisplay.calls[1], status: "picked_up" },
    }).success,
    false,
    "picked_up without pickedUpAt is rejected",
  );
});

test("legend-usw3 expo: delivered needs a complete order and a runner, repeat is idempotent", () => {
  const [open, , , readyWithRunner] = fixtures.expo.tickets;
  assert.equal(readyWithRunner.deliveredAt, null);
  for (const ticket of fixtures.expo.tickets)
    assert.equal(ticket.deliveredAt, null, "fixtures start undelivered");

  // Rule: allowed, or the exact refusal code.
  assert.equal(kitchen.expoDeliveryBlock(readyWithRunner), null);
  assert.equal(kitchen.expoDeliveryBlock(open), "EXPO_ORDER_NOT_COMPLETE");
  assert.equal(
    kitchen.expoDeliveryBlock({
      ...readyWithRunner,
      runnerId: null,
      runnerAssignedAt: null,
    }),
    "EXPO_RUNNER_NOT_ASSIGNED",
  );
  // A repeat on a delivered ticket is not a block (idempotent 200).
  const delivered = {
    ...readyWithRunner,
    deliveredAt: "2026-11-01T04:20:00.000Z",
  };
  assert.equal(kitchen.expoDeliveryBlock(delivered), null);

  // Schema: the delivered state cannot exist without completeness and a runner.
  assert.equal(kitchen.expoTicketSchema.safeParse(delivered).success, true);
  assert.equal(
    kitchen.expoTicketSchema.safeParse({
      ...open,
      deliveredAt: "2026-11-01T04:20:00.000Z",
    }).success,
    false,
    "an order without a runner cannot be delivered",
  );
  assert.equal(
    kitchen.expoTicketSchema.safeParse({
      ...delivered,
      runnerId: null,
      runnerAssignedAt: null,
    }).success,
    false,
    "a delivered order keeps its runner",
  );
  // A recall after delivery must not make the whole board unparsable.
  assert.equal(
    kitchen.expoTicketSchema.safeParse({
      ...delivered,
      isComplete: false,
      readyAt: null,
    }).success,
    true,
  );

  // Endpoint shape.
  const endpoint = kitchen.markExpoOrderDelivered;
  assert.equal(endpoint.method, "POST");
  assert.equal(endpoint.path, "/api/outlets/:outletId/expo/:orderId/delivered");
  assert.equal(endpoint.body, undefined);
  assert.equal(
    endpoint.params.safeParse({
      outletId: readyWithRunner.outletId,
      orderId: readyWithRunner.orderId,
    }).success,
    true,
  );
});

test("legend-usw3 errors: pickup and expo refusals are 409 with Indonesian fallbacks", () => {
  assert.deepEqual(Object.keys(kitchen.kitchenErrorHttpStatus).sort(), [
    "EXPO_ORDER_DELIVERED",
    "EXPO_ORDER_NOT_COMPLETE",
    "EXPO_RUNNER_NOT_ASSIGNED",
    "PICKUP_CALL_CLOSED",
    "PICKUP_CALL_NOT_CALLED",
  ]);
  for (const code of kitchen.KITCHEN_ERROR_CODES) {
    const error = new kitchen.KitchenError(code);
    assert.equal(error.code, code);
    assert.equal(error.status, 409);
    assert.ok(error.message.length > 0 && !error.message.includes(code));
  }
});

test("PRD §3 F12 + KDS-06: serving-time estimate and samples carry their basis", () => {
  kitchen.servingTimeEstimateSchema.parse(fixtures.servingTimeEstimate);
  assert.equal(
    kitchen.servingTimeEstimateSchema.safeParse({
      ...fixtures.servingTimeEstimate,
      estimatedMinutes: -1,
    }).success,
    false,
  );
  for (const sample of fixtures.servingTimeSamples) {
    assert.equal(
      kitchen.servingTimeSampleSchema.safeParse({ ...sample, metTarget: null })
        .success,
      false,
      "a duration has a target verdict",
    );
    assert.equal(
      sample.seconds,
      (Date.parse(sample.doneAt) - Date.parse(sample.startedAt)) / 1000,
      "duration matches the timestamps (KDS-04 analytics)",
    );
  }
  assert.equal(
    kitchen.servingTimeSampleSchema.safeParse({
      ...fixtures.servingTimeSamples[0],
      seconds: null,
      metTarget: null,
    }).success,
    false,
    "an unfinished sample has no duration",
  );
});

test("KDS-07 + F41 + R25: remake and comp record reason, staff and ingredient cost", () => {
  const remake = fixtures.orderIssues.find((issue) => issue.type === "remake");
  const comp = fixtures.orderIssues.find((issue) => issue.type === "comp");
  assert.ok(remake?.reasonNote && remake.employeeId && remake.costIdr > 0);
  assert.ok(comp?.reasonNote && comp.employeeId && comp.costIdr > 0);

  assert.equal(
    kitchen.orderIssueSchema.safeParse({ ...remake, employeeId: null }).success,
    false,
    "a remake records the staff member (KDS-07)",
  );
  assert.equal(
    kitchen.orderIssueSchema.safeParse({ ...comp, costIdr: -1 }).success,
    false,
    "ingredient cost cannot be negative",
  );
  assert.equal(
    kitchen.orderIssueSchema.safeParse({
      ...remake,
      resolution: "voucher",
      voucherId: null,
    }).success,
    false,
    "a voucher resolution records the voucher",
  );
  assert.equal(
    kitchen.orderIssueSchema.safeParse({
      ...remake,
      resolution: "manual_refund",
      approvedBy: null,
    }).success,
    false,
    "a manual refund needs supervisor approval (R25)",
  );
  // F41 standard reasons only.
  assert.equal(
    kitchen.orderIssueSchema.safeParse({ ...remake, reason: "terlalu asin" })
      .success,
    false,
  );
});

test("legend-d60m: kitchen and qr-order share ONE order_issues record shape", () => {
  assert.equal(
    qrOrder.orderIssueSchema,
    kitchen.orderIssueSchema,
    "qr-order re-exports the kitchen record, no second definition",
  );
  // Every kitchen fixture parses under the QR entry point and carries the QR lifecycle.
  for (const issue of fixtures.orderIssues) {
    assert.equal(qrOrder.orderIssueSchema.safeParse(issue).success, true);
    assert.ok(["open", "resolved", "cancelled"].includes(issue.status));
  }
  // And every QR fixture parses under the kitchen entry point.
  for (const issue of qrOrder.cafeLegendQrOrderFixtures?.orderIssues ?? []) {
    assert.equal(kitchen.orderIssueSchema.safeParse(issue).success, true);
  }
  const resolved = fixtures.orderIssues.find((i) => i.resolution === "swap");
  assert.ok(resolved);
  assert.equal(
    kitchen.orderIssueSchema.safeParse({ ...resolved, replacementItemId: null })
      .success,
    false,
    "a swap names the replacement item",
  );
  assert.equal(
    kitchen.orderIssueSchema.safeParse({ ...resolved, resolvedAt: null })
      .success,
    false,
    "a resolved issue has resolvedAt",
  );
  const refund = fixtures.orderIssues.find(
    (i) => i.resolution === "manual_refund",
  );
  assert.ok(refund);
  assert.equal(
    kitchen.orderIssueSchema.safeParse({ ...refund, reasonNote: "salah" })
      .success,
    false,
    "a manual refund needs a written reason of 10+ characters (ORD-09)",
  );
  // The QR staff-report input now speaks the unified vocabulary.
  assert.equal(
    qrOrder.createOrderIssueInputSchema.safeParse({
      type: "unfulfillable",
      reason: "out_of_stock",
      reasonNote: "Bahan habis",
    }).success,
    true,
  );
});

test("F12 events: kitchen event names are registered on the WS-04 catalog line", () => {
  const catalog = new Map(
    events.eventCatalog.map((entry) => [entry.name, entry]),
  );
  for (const name of kitchen.kitchenEventNames) {
    const entry = catalog.get(name);
    assert.ok(entry, `${name} is registered in the WS-00 catalog`);
    assert.equal(entry.workstream, "WS-04");
    assert.equal(entry.aggregateType, name.split(".")[0]);
    assert.equal(entry.payloadSchemaRef, `${name}.v1`);
  }
  assert.deepEqual(
    kitchen.kitchenEventCatalog.map((entry) => entry.name),
    [...kitchen.kitchenEventNames],
  );
  assert.equal(
    catalog.has("kitchen_ticket.updated"),
    false,
    "replaced by the explicit verbs",
  );
});

test("F12 events: envelopes validate against their payload schema", () => {
  const ticket = fixtures.tickets[0];
  const envelope = {
    id: "01JBQ7Z8Z0A1B2C3D4E5F6G7H0",
    tenantId: ticket.tenantId,
    outletId: ticket.outletId,
    name: "kitchen_ticket.bumped",
    version: 1,
    aggregateType: "kitchen_ticket",
    aggregateId: ticket.id,
    sequence: 1,
    occurredAt: "2026-11-01T04:04:00.000Z",
    actor: { type: "user", id: "00000000-0000-4000-8000-000000000500" },
    idempotencyKey: "kds-bump-001",
    payloadSchemaRef: "kitchen_ticket.bumped.v1",
    payload: {
      outletId: ticket.outletId,
      ticketId: ticket.id,
      orderId: ticket.orderId,
      stationId: ticket.stationId,
      status: "done",
      startedAt: ticket.startedAt,
      doneAt: ticket.doneAt,
    },
  };
  kitchen.kitchenEventSchema.parse(envelope);
  assert.equal(
    kitchen.kitchenEventSchema.safeParse({
      ...envelope,
      payload: { ...envelope.payload, status: "cancelled" },
    }).success,
    false,
    "the payload status must match the event verb",
  );
  assert.equal(
    kitchen.kitchenEventSchema.safeParse({ ...envelope, name: "order.paid" })
      .success,
    false,
    "not a kitchen event",
  );
  // pacing.updated carries the same rows the config screen reads.
  kitchen.kitchenEventSchema.parse({
    ...envelope,
    name: "pacing.updated",
    aggregateType: "pacing",
    aggregateId: "00000000-0000-4000-8000-000000000703",
    payloadSchemaRef: "pacing.updated.v1",
    payload: {
      outletId: ticket.outletId,
      generatedAt: fixtures.pacing.generatedAt,
      stations: fixtures.pacing.stations,
    },
  });
});

test("F12 endpoints: paths, params and responses stay in step with the fixtures", () => {
  const ids = new Set();
  for (const endpoint of Object.values(kitchen).filter(
    (value) =>
      value &&
      typeof value === "object" &&
      "method" in value &&
      "path" in value,
  )) {
    assert.equal(endpoint.id, `${endpoint.method} ${endpoint.path}`);
    assert.equal(
      ids.has(endpoint.id),
      false,
      `${endpoint.id} is declared once`,
    );
    ids.add(endpoint.id);
    if (endpoint.params) {
      // Path templates and the params schema name the same variables.
      assert.deepEqual(
        api.pathParamNames(endpoint.path).sort(),
        Object.keys(endpoint.params.shape).sort(),
        endpoint.id,
      );
    }
    assert.equal(api.pathParamNames(endpoint.path).includes("tenantId"), false);
  }

  const respond = (endpoint, data) => endpoint.response.parse({ data });
  const ticket = fixtures.tickets[0];
  const detail = {
    ...ticket,
    items: fixtures.ticketItems.filter((item) => item.ticketId === ticket.id),
  };
  respond(kitchen.listKitchenStations, fixtures.stationConfigs);
  respond(kitchen.getKitchenBoard, fixtures.stationBoards[0]);
  respond(kitchen.startKitchenTicket, detail);
  respond(kitchen.bumpKitchenTicket, detail);
  respond(kitchen.recallKitchenTicket, { ...detail, status: "recalled" });
  respond(kitchen.voidKitchenTicket, { ...detail, status: "cancelled" });
  respond(kitchen.setKitchenTicketPriority, { ...detail, priority: 3 });
  respond(kitchen.updateKitchenTicketItem, fixtures.ticketItems[0]);
  assert.equal(
    kitchen.updateKitchenTicketItem.body.safeParse({ action: "burn" }).success,
    false,
    "the item action is one of the explicit transitions",
  );
  respond(kitchen.getAllDayCount, fixtures.allDay);
  respond(kitchen.getExpoBoard, fixtures.expo);
  respond(kitchen.assignExpoRunner, fixtures.expo.tickets[3]);
  respond(kitchen.listExpoRunners, fixtures.expoRunners);
  // F12 "menugaskan runner": the expo screen can only pick staff the runner
  // list offers (bead legend-zvz).
  const runnerIds = new Set(
    fixtures.expoRunners.map((runner) => runner.userId),
  );
  for (const row of fixtures.expo.tickets)
    if (row.runnerId !== null)
      assert.ok(runnerIds.has(row.runnerId), "assigned runner is assignable");
  respond(kitchen.getPickupDisplay, fixtures.pickupDisplay);
  respond(kitchen.callPickupNumber, fixtures.pickupDisplay.calls[1]);
  respond(kitchen.markPickupPickedUp, fixtures.pickupDisplay.calls[2]);
  respond(kitchen.markExpoOrderDelivered, {
    ...fixtures.expo.tickets[3],
    deliveredAt: "2026-11-01T04:20:00.000Z",
  });
  respond(kitchen.getPacing, fixtures.pacing);
  respond(kitchen.updateCapacityRules, fixtures.capacityRules.slice(0, 1));
  respond(kitchen.estimateServingTime, fixtures.servingTimeEstimate);
  respond(kitchen.getServingTimeSummary, fixtures.servingTimeSummaries);
  respond(kitchen.reportOrderIssue, fixtures.orderIssues[0]);
  kitchen.listOrderIssues.response.parse({
    data: fixtures.orderIssues,
    meta: { limit: 25, nextCursor: null },
  });

  // Client input never carries the tenant (TEN-02): strict schemas reject it.
  assert.equal(
    kitchen.reportOrderIssue.body.safeParse({
      orderItemId: fixtures.orderIssues[0].orderItemId,
      type: "remake",
      reason: "late",
      reasonNote: "Dingin",
      stationId: null,
      employeeId: null,
      resolution: null,
      voucherId: null,
      approvedBy: null,
      tenantId: fixtures.tickets[0].tenantId,
    }).success,
    false,
  );
  const validIssueInput = {
    orderItemId: fixtures.orderIssues[0].orderItemId,
    type: "remake",
    reason: "quality",
    reasonNote: "Kopi terlalu pahit",
    stationId: null,
    employeeId: fixtures.orderIssues[0].employeeId,
    resolution: null,
    voucherId: null,
    approvedBy: null,
  };
  assert.equal(
    kitchen.reportOrderIssue.body.safeParse(validIssueInput).success,
    true,
  );
  // KDS-07: ingredient cost is computed by the API, never client input.
  assert.equal(
    kitchen.reportOrderIssue.body.safeParse({ ...validIssueInput, costIdr: 0 })
      .success,
    false,
  );
  // KDS-07 / R25: the input enforces the same rules as the stored record.
  for (const [patch, label] of [
    [{ employeeId: null }, "remake without staff member"],
    [{ resolution: "voucher" }, "voucher resolution without voucher"],
    [{ resolution: "manual_refund" }, "manual refund without approval"],
  ])
    assert.equal(
      kitchen.reportOrderIssue.body.safeParse({ ...validIssueInput, ...patch })
        .success,
      false,
      label,
    );
  assert.equal(
    kitchen.estimateServingTime.query.safeParse({ channel: "dine_in" }).success,
    true,
  );
  assert.equal(
    kitchen.getServingTimeSummary.query.safeParse({
      group: "station",
      startDate: "2026-11-02",
      endDate: "2026-11-01",
    }).success,
    false,
    "the period ends on or after it starts",
  );
});
