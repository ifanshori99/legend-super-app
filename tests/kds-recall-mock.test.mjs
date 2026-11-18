import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { cafeLegendKitchenFixtures } from "../packages/shared/src/kitchen/index.ts";
import { registerWebAlias } from "./helpers/web-alias.mjs";

registerWebAlias();
const { dispatchMock, resetMocks } =
  await import("../apps/web/src/lib/mock/runtime.ts");
await import("../apps/web/src/features/ws04-kds/mock.ts");

const fixture = cafeLegendKitchenFixtures;
const readyItem = fixture.ticketItems.find((item) => item.status === "ready");
assert.ok(readyItem?.readyAt, "The fixture must start with a ready item");
const itemTicket = fixture.tickets.find(
  (ticket) => ticket.id === readyItem.ticketId,
);
assert.ok(itemTicket, "The ready item must belong to a ticket");
const doneTicket = fixture.tickets.find(
  (ticket) =>
    ticket.status === "done" &&
    fixture.ticketItems.some(
      (item) => item.ticketId === ticket.id && item.status === "ready",
    ),
);
assert.ok(doneTicket, "The fixture must have a completed ticket to recall");

beforeEach(() => resetMocks());

test("legend-9zc3 recalled fixture items have no stale readyAt", () => {
  const recalledItems = fixture.ticketItems.filter(
    (item) => item.status === "in_progress" && item.recalledCount > 0,
  );
  assert.ok(recalledItems.length > 0, "The fixture covers recalled items");
  for (const item of recalledItems) assert.equal(item.readyAt, null);
});

test("legend-9zc3 recalling a ticket clears its ready items' readyAt", async () => {
  const originalItems = fixture.ticketItems.filter(
    (item) => item.ticketId === doneTicket.id && item.status === "ready",
  );
  const { data } = await dispatchMock({
    method: "POST",
    path: `/api/outlets/${doneTicket.outletId}/kitchen/tickets/${doneTicket.id}/recall`,
    body: { reason: "Masak kembali" },
  });
  assert.equal(data.status, "recalled");
  for (const original of originalItems) {
    const recalled = data.items.find((item) => item.id === original.id);
    assert.equal(recalled.status, "in_progress");
    assert.equal(recalled.recalledCount, original.recalledCount + 1);
    assert.equal(recalled.readyAt, null);
  }
});

test("legend-9zc3 recalling one item clears readyAt in the response and board", async () => {
  const { data } = await dispatchMock({
    method: "POST",
    path: `/api/outlets/${readyItem.outletId}/kitchen/ticket-items/${readyItem.id}/status`,
    body: { action: "recall" },
  });
  assert.equal(data.status, "in_progress");
  assert.equal(data.recalledCount, readyItem.recalledCount + 1);
  assert.equal(data.readyAt, null);

  const { data: board } = await dispatchMock({
    method: "GET",
    path: `/api/outlets/${readyItem.outletId}/kitchen/stations/${itemTicket.stationId}/board`,
  });
  const stored = board.tickets
    .flatMap((ticket) => ticket.items)
    .find((item) => item.id === readyItem.id);
  assert.equal(stored.readyAt, null);
});
