// Page guard of the open orders list. Presentation only: the API re-checks
// every request (`listPosOrders` and the parked list need `order.view`).
//
// Why the cashier permissions and not `order.view` (CTO 26 Nov, review W5
// no. 1): /pos/pesanan is the cashier's screen. Waiters and captains work on
// tables in the captain screen (brief 1268 W4), so an account that holds only
// `order.create` is sent there instead of to an empty "not found".
import { notFound, redirect } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard, holdsAny } from "@/lib/areas/guard";

/** Same permissions as the order detail the list opens. */
export const OPEN_ORDERS_PERMISSIONS: readonly PermissionCode[] = [
  "pos.sale.create",
  "pos.payment.accept",
  "pos.void.request",
];

export type OpenOrdersGate = "allowed" | "captain" | "hidden";

export function openOrdersGate(access: AreaAccess): OpenOrdersGate {
  const gate = evaluateGuard(
    { kind: "permission", surface: "pos", anyOf: OPEN_ORDERS_PERMISSIONS },
    access,
  );
  if (gate.status === "allowed") return "allowed";
  if (gate.status === "forbidden" && holdsAny(access, ["order.create"]))
    return "captain";
  return "hidden";
}

export const openOrdersGuard =
  () =>
  ({ context }: { context: { access: AreaAccess } }) => {
    const gate = openOrdersGate(context.access);
    if (gate === "captain") throw redirect({ to: "/pos/captain" });
    if (gate !== "allowed") throw notFound();
  };
