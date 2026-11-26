// Page guard of the open orders list. Presentation only: the API re-checks
// every request (`listPosOrders` and the parked list need a POS permission).
// Same permissions as the order detail it opens.
import { orderDetailGuard } from "@/features/ws04-pos-order-detail/guard";

export const openOrdersGuard = orderDetailGuard;
