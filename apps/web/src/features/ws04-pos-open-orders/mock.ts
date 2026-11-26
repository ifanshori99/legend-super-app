// Mock mode handlers of the open orders list (VITE_API_MOCK=true), after the
// founder-approved mockup: up to five open orders (one with held items) and two
// parked carts without a price. The first two rows are the POS kasir engine's
// demo bills, so "Buka" opens a real mock detail; the others are list-only.
// `?mock=empty` gives empty lists; `?mock=error` and `?mock=slow` come from the
// transport.
import { cafeLegendFixtures } from "@starter/shared/core";
import { listPosOrders, listPosParkedOrders } from "@starter/shared/pos";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { DEMO_CODE_ORDER_ID, DEMO_ORDER_ID } from "../ws04-pos-kasir/demo-seed";
import { callPosKasirEngine } from "../ws04-pos-kasir/mock-engine";
import { orderDetailWire } from "../ws04-pos-kasir/mock-wire";

const tenantId = cafeLegendFixtures.tenant.id;
const outletId = cafeLegendFixtures.outlets[0].id;

const minutesBefore = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function engineRow(id: string, minutes: number, table: string | null) {
  const order = callPosKasirEngine((engine) =>
    orderDetailWire(engine.rawOrder(id), engine.rawRemainingIdr(id)),
  );
  return {
    id: order.id,
    tenantId,
    outletId,
    number: order.number,
    channel: "pos",
    serviceType: table ? "dine_in" : "takeaway",
    tableSessionId: null,
    status: order.status,
    shiftId: null,
    totalIdr: order.totalIdr,
    remainingIdr:
      order.status === "completed"
        ? 0
        : order.totalIdr - order.depositAppliedIdr,
    tableLabel: table,
    itemCount: order.items.length,
    heldItemCount: order.items.filter(
      (item) => item.status !== "voided" && item.fireStatus === "held",
    ).length,
    createdAt: minutesBefore(minutes),
  };
}

const listRow = (
  id: string,
  number: string,
  minutes: number,
  over: { table: string | null; service: string; items: number; total: number },
) => ({
  id,
  tenantId,
  outletId,
  number,
  channel: "pos",
  serviceType: over.service,
  tableSessionId: null,
  status: "sent",
  shiftId: null,
  totalIdr: over.total,
  remainingIdr: over.total,
  tableLabel: over.table,
  itemCount: over.items,
  heldItemCount: 0,
  createdAt: minutesBefore(minutes),
});

registerMock(listPosOrders, ({ query, scenario }) => {
  const rows = [
    engineRow(DEMO_ORDER_ID, 4, null),
    engineRow(DEMO_CODE_ORDER_ID, 13, "Meja 3"),
    {
      ...listRow("01JBQ9F0000000000000001042", "POS-1042", 27, {
        table: "Meja 7",
        service: "dine_in",
        items: 4,
        total: 192_900,
      }),
      heldItemCount: 2,
    },
    listRow("01JBQ9F0000000000000001039", "POS-1039", 41, {
      table: null,
      service: "delivery",
      items: 3,
      total: 136_500,
    }),
    listRow("01JBQ9F0000000000000001036", "POS-1036", 60, {
      table: "Meja 12",
      service: "dine_in",
      items: 6,
      total: 318_200,
    }),
  ].filter((row) => row.status !== "completed");
  const page = paginateFixture(rows, query, (row) => row.id, scenario);
  return {
    ...page,
    meta: {
      ...page.meta,
      totalCount: query.withCount ? page.data.length : null,
    },
  } as never;
});

registerMock(listPosParkedOrders, ({ scenario }) => {
  if (scenario === "empty") return { data: [] } as never;
  const line = (menuItemId: string, quantity: number) => ({
    menuItemId,
    modifierIds: [],
    quantity,
  });
  return {
    data: [
      {
        id: "0c0c0051-0000-4000-8000-000000000051",
        label: "Meja 5",
        channel: "pos",
        serviceType: "dine_in",
        items: [
          line("0a0a0001-0000-4000-8000-000000000001", 2),
          line("0a0a0002-0000-4000-8000-000000000002", 1),
          line("0a0a0003-0000-4000-8000-000000000003", 1),
        ],
        parkedAt: minutesBefore(8),
      },
      {
        id: "0c0c0052-0000-4000-8000-000000000052",
        label: "Takeaway",
        channel: "pos",
        serviceType: "takeaway",
        items: [
          line("0a0a0001-0000-4000-8000-000000000001", 1),
          line("0a0a0004-0000-4000-8000-000000000004", 2),
        ],
        parkedAt: minutesBefore(21),
      },
    ],
  } as never;
});
