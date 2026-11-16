import assert from "node:assert/strict";
import { after, test } from "node:test";
import { componentHarness } from "./844-component-harness.mjs";

const harness = componentHarness((specifier, parent) => {
  if (specifier === "../hooks" && parent.includes("ws03-floor"))
    return `export const useSessionBill = () => ({data: globalThis.__844Data.bill});
      export const useMoveItems = () => ({mutate: input => { globalThis.__844Data.submitted = input; }});
      ${["useCloseSession", "useConfirmSession", "useMergeTables", "useMoveSession", "useSplitBill", "useTableStatus"].map((name) => `export const ${name} = () => ({});`).join("\n")}`;
  if (specifier === "../../hooks" && parent.includes("ws03-qr-order"))
    return "export const useCreateSplits = () => ({reset() {}});";
  if (specifier === "../../lib/ids")
    return 'export const idempotencyKey = () => "split-key";';
  if (specifier === "../lib" && parent.includes("ws03-floor"))
    return "export const otherSessionRows = () => []; export const floorActionErrorKey = () => ''; export const moveTargets = () => []; export const paymentModeLabel = () => '';";
});
after(() => harness.close());
const { MoveItemsDialog } =
  await import("../apps/web/src/features/ws03-floor/components/dialogs.tsx");
const { SplitPanel } =
  await import("../apps/web/src/features/ws03-qr-order/components/bill/split-panel.tsx");

const active = {
  id: "active",
  name: "Kopi aktif",
  quantity: 1,
  status: "served",
  lineTotalIdr: 18000,
};
const bill = {
  orders: [
    {
      id: "live-order",
      number: "A-001",
      status: "completed",
      paymentStatus: "paid",
      totalIdr: 18000,
      items: [
        active,
        {
          ...active,
          id: "void-line",
          name: "Item void",
          status: "voided",
          lineTotalIdr: 90000,
        },
      ],
    },
    {
      id: "void-order",
      number: "A-002",
      status: "voided",
      paymentStatus: "unpaid",
      totalIdr: 50000,
      items: [
        {
          ...active,
          id: "void-parent-line",
          name: "Pesanan void",
          lineTotalIdr: 50000,
        },
      ],
    },
  ],
  totals: { totalIdr: 18000 },
};

test("sgvw0 move dialog only offers active lines from live orders", () => {
  const html = harness.render(
    MoveItemsDialog,
    { row: { session: { id: "session" } }, board: { tables: [] }, open: true },
    { bill },
  );
  assert.match(html, /Kopi aktif/);
  assert.match(html, /18000/);
  assert.doesNotMatch(html, /Item void|Pesanan void|90000|50000/);
});

test("sgvw0 by-item split excludes void orders and lines while preserving active amount", () => {
  const html = harness.render(
    SplitPanel,
    {
      sessionId: "session",
      bill,
      participants: [{ id: "guest" }],
      myParticipantId: "guest",
    },
    { mode: "by_item" },
  );
  assert.match(html, /Kopi aktif/);
  assert.match(html, /18000/);
  assert.doesNotMatch(html, /Item void|Pesanan void|90000|50000/);
});

test("sgvw0 move submit removes selected IDs voided by a bill refresh", () => {
  const props = {
    row: { session: { id: "session" } },
    board: { tables: [] },
    open: true,
  };
  const state = {
    bill,
    selected: ["active", "void-line", "void-parent-line"],
    target: "target-session",
  };
  harness.render(MoveItemsDialog, props, state);
  assert.equal(harness.lastAction().disabled, false);
  harness.lastAction().onClick();
  assert.deepEqual(state.submitted, {
    sessionId: "session",
    toSessionId: "target-session",
    orderItemIds: ["active"],
  });
  const refreshed = {
    ...state,
    bill: {
      ...bill,
      orders: bill.orders.map((order) => ({ ...order, status: "voided" })),
    },
  };
  harness.render(MoveItemsDialog, props, refreshed);
  assert.equal(
    harness.lastAction().disabled,
    true,
    "No move is offered when every selected line became void",
  );
});
