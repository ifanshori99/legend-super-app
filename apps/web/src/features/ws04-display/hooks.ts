import { useQuery } from "@tanstack/react-query";
import type { DisplayDeposit } from "./lib.ts";
import { customerDisplayQuery, displayOrderQuery } from "./queries.ts";

// Hooks are the only way components touch this feature's data
// (docs/frontend.md, "Custom hooks"). The display is read-only: pairing is a
// terminal action, so this feature has no mutations.

export function useCustomerDisplay(
  outletId: string | undefined,
  terminalDeviceId?: string,
) {
  return useQuery({
    ...customerDisplayQuery(outletId ?? "", terminalDeviceId),
    enabled: Boolean(outletId),
  });
}

/**
 * The deposit of the order being paid, for `displayPayMode`. Read only while
 * the display is awaiting payment; pending is "loading", and a failed read or
 * a missing order id is "unknown" (never a guessed 0).
 */
export function useDisplayDeposit(
  outletId: string | undefined,
  orderId: string | null,
  awaitingPayment: boolean,
): DisplayDeposit {
  const query = useQuery({
    ...displayOrderQuery(outletId ?? "", orderId ?? ""),
    enabled: Boolean(outletId) && orderId !== null && awaitingPayment,
  });
  if (orderId === null) return { kind: "unknown" };
  if (query.isError) return { kind: "unknown" };
  if (query.data === undefined) return { kind: "loading" };
  return {
    kind: "known",
    depositAppliedIdr: Number(query.data.depositAppliedIdr),
  };
}
