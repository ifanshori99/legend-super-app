// One function per order detail call; components never call these (they use
// ./hooks.ts). Both calls have a shared contract (`getPosOrder`,
// `listPosOrderEvents`).
import { getPosOrder, listPosOrderEvents } from "@starter/shared/pos";
import { callEndpoint } from "@/lib/api/endpoint";
import { kitchenVoidNotices, type KitchenVoidNotice } from "./kitchen-void";

export async function fetchOrder(
  outletId: string,
  orderId: string,
  signal?: AbortSignal,
) {
  const { data } = await callEndpoint(
    getPosOrder,
    { params: { outletId, orderId } },
    { signal },
  );
  return data;
}

// The log is append-only and short for one order; a hard page cap keeps a
// runaway cursor from looping.
const MAX_PAGES = 10;

/** Kitchen void notices of one order, read from its event log. */
export async function fetchKitchenVoids(
  outletId: string,
  orderId: string,
  signal?: AbortSignal,
): Promise<KitchenVoidNotice[]> {
  const events: Parameters<typeof kitchenVoidNotices>[0][number][] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await callEndpoint(
      listPosOrderEvents,
      {
        params: { outletId, orderId },
        query: { limit: 100, ...(cursor ? { cursor } : {}) },
      },
      { signal },
    );
    events.push(...result.data);
    cursor = result.meta.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return kitchenVoidNotices(events);
}
