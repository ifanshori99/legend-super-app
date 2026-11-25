// Pure mapping for the captain on the real contract (brief 1268 W4): the
// captain's cart key, the order input, the table's orders (one per send, never
// merged), waiter calls and the reservation hold warning. No price is built
// here: every figure comes from the server's answer.
//
// Plain TypeScript with relative `.ts` imports: Node tests load it directly.
import type { PosOrderDetail } from "@starter/shared/pos";
import type { ServiceRequest } from "@starter/shared/qr-order";
import type { Reservation } from "@starter/shared/reservation";
import { ApiError } from "@/lib/api/errors";
import { mapOrder } from "./order-wire.ts";
import {
  type CaptainTable,
  type CartLine,
  type OrderMeta,
  type ServiceCall,
  type SubmitOrderInput,
  type TableOrdersView,
} from "./types.ts";

export const NO_TABLE_SESSION = "NO_TABLE_SESSION";

/**
 * The captain's cart: per outlet, captain and table session. A new session on
 * the same table is a new cart; another captain never shares one.
 */
export function captainDraftKey(
  outletId: string,
  actorId: string,
  sessionId: string,
): string {
  return `captain:${outletId}:${actorId}:${sessionId}`;
}

/** A dine-in order on the table session, sent on the `captain` channel. */
export function captainInput(
  tableSessionId: string,
  lines: CartLine[],
): SubmitOrderInput {
  return {
    channel: "dine_in",
    tableSessionId,
    ojol: null,
    lines,
    captain: true,
  };
}

/** What the unclear-send snapshot remembers about the table. */
export function captainMeta(table: {
  label: string;
  sessionId: string | null;
}): OrderMeta {
  return {
    channel: "dine_in",
    tableLabel: table.label,
    tableSessionId: table.sessionId,
    ojolPlatform: null,
    ojolRef: "",
  };
}

/** No session, no order: the id of the table's open session, or a refusal. */
export function assertSeated(table: CaptainTable): string {
  if (table.sessionId === null || table.sessionId === "")
    throw new ApiError(
      409,
      NO_TABLE_SESSION,
      "Meja ini belum punya sesi. Dudukkan tamu dulu.",
    );
  return table.sessionId;
}

/** Items of the cart that were not part of the send that just succeeded. */
export function removeSentLines(
  current: readonly CartLine[],
  sent: readonly CartLine[],
): CartLine[] {
  const gone = new Set(sent.map((line) => line.lineId));
  return current.filter((line) => !gone.has(line.lineId));
}

/**
 * The orders of the table's session, one per send, oldest first. Lines carry
 * the server's item ids (what fire needs). They are not merged into one order.
 */
export function mapTableOrders(
  table: CaptainTable,
  orders: readonly PosOrderDetail[],
): TableOrdersView {
  return {
    table,
    orders: [...orders]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((order) => ({ ...mapOrder(order), tableLabel: table.label })),
  };
}

const REASON_TEXT = {
  add_order: "Mau tambah pesanan",
  utensils: "Minta alat makan",
  complaint: "Keluhan",
  other: "Lainnya",
} as const;

/** A waiter call as the inbox shows it; a cancelled one is not shown. */
export function mapServiceRequest(request: ServiceRequest): ServiceCall | null {
  if (request.status === "cancelled") return null;
  const note = request.message?.trim();
  return {
    id: request.id,
    tableId: request.tableId,
    tableLabel: request.tableLabel ?? "-",
    type: request.type,
    reason: note || (request.reason ? REASON_TEXT[request.reason] : ""),
    createdAt: request.createdAt,
    status: request.status === "pending" ? "new" : request.status,
  };
}

/** A bill request must be acknowledged before it is resolved. */
export function canResolveCall(call: Pick<ServiceCall, "type" | "status">) {
  if (call.status === "resolved") return false;
  return call.type !== "request_bill" || call.status === "acknowledged";
}

export type ReservationHold = {
  id: string;
  guestName: string;
  pax: number;
  reservedFor: string;
};

/**
 * A reservation that holds the table and has not seated yet. The hold does not
 * change the table's status, so a walk-in could take the seat: the captain is
 * told first. Earliest one wins; one that ended already does not count.
 */
export function holdFor(
  reservations: readonly Reservation[],
  tableId: string,
  nowMs: number,
): ReservationHold | null {
  const holds = reservations
    .filter(
      (reservation) =>
        (reservation.status === "confirmed" ||
          reservation.status === "pending_deposit") &&
        reservation.tableSessionId === null &&
        reservation.tableIds.includes(tableId as never) &&
        Date.parse(reservation.reservedFor) +
          reservation.durationMinutes * 60_000 >
          nowMs,
    )
    .sort((a, b) => a.reservedFor.localeCompare(b.reservedFor));
  const first = holds[0];
  return first
    ? {
        id: first.id,
        guestName: first.guestName,
        pax: first.pax,
        reservedFor: first.reservedFor,
      }
    : null;
}
