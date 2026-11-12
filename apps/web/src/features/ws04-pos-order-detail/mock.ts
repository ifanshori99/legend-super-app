// Mock mode handler of the order event log (VITE_API_MOCK=true). `getPosOrder`
// is answered by the POS kasir engine (../ws04-pos-kasir/mock.ts); this file
// adds the one endpoint that has no mock yet. The demo order's first line was
// voided by the kitchen at 14.29 (`order.kitchen_voided`); `?mock=empty` gives
// an empty log, `?mock=error` and `?mock=slow` come from the transport.
import { listPosOrderEvents } from "@starter/shared/pos";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { callPosKasirEngine } from "../ws04-pos-kasir/mock-engine";
import { orderDetailWire } from "../ws04-pos-kasir/mock-wire";

const KITCHEN_VOID_AT = "2026-11-12T07:29:00.000Z";
const EVENT_ID = "01JBQ9E0000000000000000001";

registerMock(listPosOrderEvents, ({ params, query, scenario }) => {
  const order = callPosKasirEngine((engine) =>
    orderDetailWire(
      engine.rawOrder(params.orderId),
      engine.rawRemainingIdr(params.orderId),
    ),
  );
  const first = order.items[0];
  const events = first
    ? [
        {
          id: EVENT_ID,
          tenantId: order.tenantId,
          outletId: order.outletId,
          orderId: order.id,
          type: "order.kitchen_voided",
          payload: {
            ticketId: "0e0e0024-0000-4000-8000-000000000024",
            stationId: "0f0f0001-0000-4000-8000-000000000001",
            orderItemIds: [first.id],
            ticketCancelled: false,
            reason: "bahan habis",
          },
          actorId: null,
          deviceId: null,
          sequence: 1,
          occurredAt: KITCHEN_VOID_AT,
        },
      ]
    : [];
  return paginateFixture(events, query, (event) => event.id, scenario) as never;
});
