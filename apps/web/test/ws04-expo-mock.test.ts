// Bead legend-5vcqk: the expo/pickup mock follows the API (legend-usw3). A
// picked-up number is closed (PICKUP_CALL_CLOSED), "Diambil" needs a called
// number, "Diantar" needs a complete ticket with a runner, a delivered order
// keeps its runner, and every repeat answers 200 with the first timestamp.
import assert from "node:assert/strict";
import {
  assignExpoRunner,
  cafeLegendKitchenFixtures,
  getExpoBoard,
  getPickupDisplay,
  markExpoOrderDelivered,
  markPickupPickedUp,
} from "@starter/shared/kitchen";
import { ApiError } from "@/lib/api/errors";
import { dispatchMock, resetMocks } from "@/lib/mock/runtime";
import "@/features/ws04-expo/mock";

const { expo, expoRunners, pickupDisplay } = cafeLegendKitchenFixtures;
const outletId = expo.outletId;

const [assigned, called, pickedUp] = pickupDisplay.calls;
const incomplete = expo.tickets.find((ticket) => !ticket.isComplete)!;
const delivered = expo.tickets.find(
  (ticket) => ticket.isComplete && ticket.runnerId !== null,
)!;
const [runnerA, runnerB] = expoRunners;

beforeEach(() => resetMocks());

function post(path: string, body?: unknown) {
  return dispatchMock({ method: "POST", path, body });
}

const pickupPath = (callId: string, action: "call" | "picked-up") =>
  `/api/outlets/${outletId}/pickup-calls/${callId}/${action}`;
const expoPath = (orderId: string, action: "delivered" | "runner") =>
  `/api/outlets/${outletId}/expo/${orderId}/${action}`;

async function refused(
  promise: Promise<unknown>,
  status: number,
  code: string,
) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

test("legend-5vcqk: Diambil closes a called number and a repeat keeps the first time", async () => {
  const first = markPickupPickedUp.response.parse(
    await post(pickupPath(called.id, "picked-up")),
  ).data;
  assert.equal(first.status, "picked_up");
  assert.ok(first.pickedUpAt);
  assert.equal(first.calledAt, called.calledAt);

  const again = markPickupPickedUp.response.parse(
    await post(pickupPath(called.id, "picked-up")),
  ).data;
  assert.deepEqual(again, first);

  const display = getPickupDisplay.response.parse(
    await dispatchMock({
      method: "GET",
      path: `/api/outlets/${outletId}/pickup-display`,
    }),
  ).data;
  assert.equal(
    display.calls.find((call) => call.id === called.id)?.status,
    "picked_up",
  );
});

test("legend-5vcqk: Diambil on an already picked-up number is a 200 repeat", async () => {
  const repeat = markPickupPickedUp.response.parse(
    await post(pickupPath(pickedUp.id, "picked-up")),
  ).data;
  assert.equal(repeat.pickedUpAt, pickedUp.pickedUpAt);
});

test("legend-5vcqk: Diambil before Panggil is 409 PICKUP_CALL_NOT_CALLED", async () => {
  await refused(
    post(pickupPath(assigned.id, "picked-up")),
    409,
    "PICKUP_CALL_NOT_CALLED",
  );
});

test("legend-5vcqk: Diambil on an unknown number is 404", async () => {
  await refused(
    post(pickupPath("00000000-0000-4000-8000-00000000dead", "picked-up")),
    404,
    "NOT_FOUND",
  );
});

test("legend-5vcqk: Panggil on a picked-up number is 409 PICKUP_CALL_CLOSED", async () => {
  await refused(
    post(pickupPath(pickedUp.id, "call")),
    409,
    "PICKUP_CALL_CLOSED",
  );
});

test("legend-5vcqk: Panggil then Diambil closes a number, and Panggil is then refused", async () => {
  await post(pickupPath(assigned.id, "call"));
  const closed = markPickupPickedUp.response.parse(
    await post(pickupPath(assigned.id, "picked-up")),
  ).data;
  assert.equal(closed.status, "picked_up");
  await refused(
    post(pickupPath(assigned.id, "call")),
    409,
    "PICKUP_CALL_CLOSED",
  );
});

test("legend-5vcqk: Diantar stamps deliveredAt, keeps the runner, and a repeat keeps the first time", async () => {
  const first = markExpoOrderDelivered.response.parse(
    await post(expoPath(delivered.orderId, "delivered")),
  ).data;
  assert.ok(first.deliveredAt);
  assert.equal(first.runnerId, delivered.runnerId);

  const again = markExpoOrderDelivered.response.parse(
    await post(expoPath(delivered.orderId, "delivered")),
  ).data;
  assert.deepEqual(again, first);

  const board = getExpoBoard.response.parse(
    await dispatchMock({
      method: "GET",
      path: `/api/outlets/${outletId}/expo`,
    }),
  ).data;
  assert.equal(
    board.tickets.find((ticket) => ticket.orderId === delivered.orderId)
      ?.deliveredAt,
    first.deliveredAt,
  );
});

test("legend-5vcqk: Diantar on an incomplete order is 409 EXPO_ORDER_NOT_COMPLETE", async () => {
  await refused(
    post(expoPath(incomplete.orderId, "delivered")),
    409,
    "EXPO_ORDER_NOT_COMPLETE",
  );
});

test("legend-5vcqk: Diantar on an unknown order is 404", async () => {
  await refused(
    post(expoPath("01JBQ7Z8K0A1B2C3D4E5F6G7ZZ", "delivered")),
    404,
    "NOT_FOUND",
  );
});

test("legend-5vcqk: a delivered order keeps its runner (409 EXPO_ORDER_DELIVERED), naming the same runner repeats", async () => {
  await post(expoPath(delivered.orderId, "delivered"));
  const other = [runnerA, runnerB].find(
    (runner) => runner.userId !== delivered.runnerId,
  )!;
  await refused(
    post(expoPath(delivered.orderId, "runner"), { runnerId: other.userId }),
    409,
    "EXPO_ORDER_DELIVERED",
  );
  const same = assignExpoRunner.response.parse(
    await post(expoPath(delivered.orderId, "runner"), {
      runnerId: delivered.runnerId,
    }),
  ).data;
  assert.equal(same.runnerId, delivered.runnerId);
  assert.ok(same.deliveredAt);
});

test("legend-5vcqk: before delivery another runner replaces the first", async () => {
  const other = [runnerA, runnerB].find(
    (runner) => runner.userId !== delivered.runnerId,
  )!;
  const replaced = assignExpoRunner.response.parse(
    await post(expoPath(delivered.orderId, "runner"), {
      runnerId: other.userId,
    }),
  ).data;
  assert.equal(replaced.runnerId, other.userId);
  assert.equal(replaced.deliveredAt, null);
});
