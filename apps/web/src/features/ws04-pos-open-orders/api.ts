// One function per open orders call; components never call these (they use
// ./hooks.ts). Both lists have a shared contract: `listPosOrders` (open
// statuses, with the server's remaining bill, table label and held count) and
// `listPosParkedOrders` (parked carts, which carry no price).
import { listPosOrders, listPosParkedOrders } from "@starter/shared/pos";
import { callEndpoint } from "@/lib/api/endpoint";
import { ApiError } from "@/lib/api/errors";
import {
  OPEN_ORDER_STATUSES,
  toOpenOrderRows,
  toParkedRows,
  type OpenOrderRow,
  type ParkedRow,
} from "./open-orders-logic";

// One outlet rarely has more than a few dozen open orders; the cap keeps a
// runaway cursor from looping.
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export async function fetchOpenOrders(
  outletId: string,
  signal?: AbortSignal,
): Promise<OpenOrderRow[]> {
  const rows: OpenOrderRow[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await callEndpoint(
      listPosOrders,
      {
        params: { outletId },
        query: {
          status: OPEN_ORDER_STATUSES.join(","),
          limit: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        } as never,
      },
      { signal },
    );
    rows.push(...toOpenOrderRows(result.data));
    const next = result.meta.nextCursor;
    if (next === null) return rows;
    if (seen.has(next))
      throw new ApiError(
        502,
        "PAGE_CURSOR_REPEATED",
        "Daftar dari server tidak selesai dibaca. Coba muat ulang.",
      );
    seen.add(next);
    cursor = next;
  }
  return rows;
}

export async function fetchParkedOrders(
  outletId: string,
  signal?: AbortSignal,
): Promise<ParkedRow[]> {
  const { data } = await callEndpoint(
    listPosParkedOrders,
    { params: { outletId }, query: {} },
    { signal },
  );
  return toParkedRows(data);
}
