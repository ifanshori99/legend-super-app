// Mock handlers for VITE_API_MOCK=true: the expo board, the runner list and
// the pickup display come from the kitchen fixtures (@starter/shared/kitchen),
// so both screens work without an API (docs/frontend.md, "Typed endpoints and
// mock mode"). The handlers behave like the service they stand in for:
// assignments change the board, a call moves a number from `assigned` to
// `called`, "Diambil" closes a called number, "Diantar" marks a complete
// order with a runner delivered, and transitions the contract forbids are
// refused with the API's kitchen codes (legend-usw3). Repeats are 200 and keep
// the first timestamp.
import {
  assignExpoRunner,
  cafeLegendKitchenFixtures,
  callPickupNumber,
  expoDeliveryBlock,
  getExpoBoard,
  getPickupDisplay,
  kitchenErrorHttpStatus,
  listExpoRunners,
  markExpoOrderDelivered,
  markPickupPickedUp,
  pickupCallBlock,
} from "@starter/shared/kitchen";
import type { ExpoBoard, PickupDisplay } from "@starter/shared/kitchen";
import { ApiError } from "../../lib/api/errors.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";

const { expo, expoRunners, pickupDisplay } = cafeLegendKitchenFixtures;

/** Fixtures stay immutable: the stores own the copy the screens mutate. */
function seedBoard(): ExpoBoard {
  return {
    ...expo,
    tickets: expo.tickets.map((ticket) => ({
      ...ticket,
      stations: ticket.stations.map((station) => ({ ...station })),
    })),
  } as ExpoBoard;
}

function seedPickup(): PickupDisplay {
  return {
    ...pickupDisplay,
    calls: pickupDisplay.calls.map((call) => ({ ...call })),
    promotions: pickupDisplay.promotions.map((promotion) => ({
      ...promotion,
    })),
  } as PickupDisplay;
}

const board = createMockStore<ExpoBoard>(seedBoard);
const pickup = createMockStore<PickupDisplay>(seedPickup);
const runners = createMockStore(() => [...expoRunners]);

/**
 * New events in mock mode continue the fixture clock (one fixed service at
 * 04:10Z) instead of jumping to the developer's wall clock, so a screenshot
 * shows a single day. The real service stamps the server clock.
 */
let tick = 0;
function nextFixtureInstant(base: string): string {
  tick += 1;
  return new Date(Date.parse(base) + tick * 60_000).toISOString();
}

registerMock(getExpoBoard, ({ scenario }) => {
  const state = board.get();
  if (scenario === "empty") return { data: { ...state, tickets: [] } };
  return { data: state };
});

registerMock(listExpoRunners, ({ scenario }) => {
  if (scenario === "empty") return { data: [] };
  return { data: runners.get() };
});

registerMock(assignExpoRunner, ({ params, body }) => {
  const current = board.get();
  const ticket = current.tickets.find((row) => row.orderId === params.orderId);
  if (!ticket)
    throw new ApiError(404, "NOT_FOUND", "Pesanan tidak ada di papan expo.");
  if (!runners.get().some((runner) => runner.userId === body.runnerId))
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Runner tidak tersedia di outlet ini.",
    );
  // A delivered order keeps its runner; naming the same runner is a repeat.
  if (ticket.deliveredAt !== null) {
    if (ticket.runnerId === body.runnerId) return { data: ticket };
    throw new ApiError(
      kitchenErrorHttpStatus.EXPO_ORDER_DELIVERED,
      "EXPO_ORDER_DELIVERED",
      "Pesanan sudah diantar, runner tidak bisa diganti.",
    );
  }
  if (ticket.runnerId === body.runnerId) return { data: ticket };
  const assigned = {
    ...ticket,
    runnerId: body.runnerId,
    runnerAssignedAt: nextFixtureInstant(current.generatedAt),
  };
  board.set({
    ...current,
    tickets: current.tickets.map((row) =>
      row.orderId === ticket.orderId ? assigned : row,
    ),
  });
  return { data: assigned };
});

registerMock(markExpoOrderDelivered, ({ params }) => {
  const current = board.get();
  const ticket = current.tickets.find((row) => row.orderId === params.orderId);
  if (!ticket)
    throw new ApiError(404, "NOT_FOUND", "Pesanan tidak ada di papan expo.");
  const block = expoDeliveryBlock(ticket);
  if (block === "EXPO_ORDER_NOT_COMPLETE")
    throw new ApiError(
      kitchenErrorHttpStatus[block],
      block,
      "Pesanan belum selesai di semua stasiun.",
    );
  if (block === "EXPO_RUNNER_NOT_ASSIGNED")
    throw new ApiError(
      kitchenErrorHttpStatus[block],
      block,
      "Pesanan belum punya runner.",
    );
  // A repeat answers the ticket unchanged with the first `deliveredAt`.
  if (ticket.deliveredAt !== null) return { data: ticket };
  const deliveredAt = nextFixtureInstant(current.generatedAt);
  const delivered = {
    ...ticket,
    // The table CHECK needs delivered_at >= runner_assigned_at.
    deliveredAt:
      ticket.runnerAssignedAt && ticket.runnerAssignedAt > deliveredAt
        ? ticket.runnerAssignedAt
        : deliveredAt,
  };
  board.set({
    ...current,
    tickets: current.tickets.map((row) =>
      row.orderId === ticket.orderId ? delivered : row,
    ),
  });
  return { data: delivered };
});

registerMock(getPickupDisplay, ({ scenario }) => {
  const state = pickup.get();
  if (scenario === "empty") return { data: { ...state, calls: [] } };
  return { data: state };
});

registerMock(callPickupNumber, ({ params }) => {
  const current = pickup.get();
  const call = current.calls.find((row) => row.id === params.callId);
  if (!call)
    throw new ApiError(404, "NOT_FOUND", "Nomor panggilan tidak ditemukan.");
  // A picked-up number is closed: it cannot be called again or reopened.
  if (pickupCallBlock(call.status, "call") === "PICKUP_CALL_CLOSED")
    throw new ApiError(
      kitchenErrorHttpStatus.PICKUP_CALL_CLOSED,
      "PICKUP_CALL_CLOSED",
      "Nomor ini sudah diambil dan tidak bisa dipanggil lagi.",
    );
  // Calling again re-announces the same number and keeps the first call time.
  const called = {
    ...call,
    status: "called" as const,
    calledAt: call.calledAt ?? nextFixtureInstant(current.generatedAt),
  };
  pickup.set({
    ...current,
    calls: current.calls.map((row) => (row.id === call.id ? called : row)),
  });
  return { data: called };
});

registerMock(markPickupPickedUp, ({ params }) => {
  const current = pickup.get();
  const call = current.calls.find((row) => row.id === params.callId);
  if (!call)
    throw new ApiError(404, "NOT_FOUND", "Nomor panggilan tidak ditemukan.");
  // "Diambil" needs the number to be called first; a repeat keeps the first time.
  if (pickupCallBlock(call.status, "pickup") === "PICKUP_CALL_NOT_CALLED")
    throw new ApiError(
      kitchenErrorHttpStatus.PICKUP_CALL_NOT_CALLED,
      "PICKUP_CALL_NOT_CALLED",
      "Panggil nomor ini dulu sebelum menandai diambil.",
    );
  if (call.status === "picked_up") return { data: call };
  const pickedUp = {
    ...call,
    status: "picked_up" as const,
    pickedUpAt: nextFixtureInstant(current.generatedAt),
  };
  pickup.set({
    ...current,
    calls: current.calls.map((row) => (row.id === call.id ? pickedUp : row)),
  });
  return { data: pickedUp };
});
