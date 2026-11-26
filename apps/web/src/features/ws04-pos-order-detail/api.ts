// One function per order detail call; components never call these (they use
// ./hooks.ts). Every call has a shared contract (`getPosOrder`,
// `listPosOrderEvents`, `firePosOrderItems`).
import {
  firePosOrderItems,
  getPosOrder,
  listPosOrderEvents,
  type PosOrderDetail,
  type PosOrderStatus,
} from "@starter/shared/pos";
import { callEndpoint } from "@/lib/api/endpoint";
import {
  fireItems,
  pendingFireItems,
} from "@/features/ws04-pos-order/captain-flow";
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

/**
 * Send held items to the kitchen (brief 1268 W5). Keyed like the captain's
 * fire, in the same sessionStorage slot: the key, the ids and the status are
 * stored before sending and a repeat sends the same bytes, so a lost reply
 * never fires twice, also after a refresh or from the captain's screen.
 */
export function fireHeldItems(
  outletId: string,
  actorId: string,
  orderId: string,
  itemIds: readonly string[],
  status: PosOrderStatus,
): Promise<PosOrderDetail> {
  return fireItems(
    {
      storage: window.sessionStorage,
      makeKey: () => globalThis.crypto.randomUUID(),
      scope: { outletId, actorId },
      fire: async (id, body) => {
        const { data } = await callEndpoint(firePosOrderItems, {
          params: { outletId, orderId: id as never },
          body: body as never,
        });
        return data;
      },
    },
    orderId,
    itemIds,
    status,
  );
}

/** The items of this order's fire whose answer is unknown (null: none). */
export function pendingFireOf(
  outletId: string,
  actorId: string,
  orderId: string,
): string[] | null {
  if (typeof window === "undefined") return null;
  return pendingFireItems(
    window.sessionStorage,
    { outletId, actorId },
    orderId,
  );
}
