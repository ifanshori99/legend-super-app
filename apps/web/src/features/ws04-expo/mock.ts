// Mock handlers for VITE_API_MOCK=true: the expo board, the runner list and
// the pickup display come from the kitchen fixtures (@starter/shared/kitchen),
// so both screens work without an API (docs/frontend.md, "Typed endpoints and
// mock mode"). The handlers behave like the service they stand in for:
// assignments change the board, a call moves a number from `assigned` to
// `called`, and states that the schema forbids are refused.
import {
  assignExpoRunner,
  cafeLegendKitchenFixtures,
  callPickupNumber,
  getExpoBoard,
  getPickupDisplay,
  listExpoRunners,
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
  // A picked-up order is done; the POS closes it, the display cannot reopen it.
  if (call.status === "picked_up")
    throw new ApiError(
      409,
      "CONFLICT",
      "Nomor ini sudah diambil pelanggan atau driver.",
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
