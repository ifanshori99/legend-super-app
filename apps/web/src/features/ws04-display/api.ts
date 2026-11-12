// One function per contract endpoint (docs/frontend.md, "Calling the API").
// Components never call these: they use the hooks in ./hooks.ts.
import { getCustomerDisplayState, getPosOrder } from "@starter/shared/pos";
import { callEndpoint } from "@/lib/api/endpoint.ts";

/**
 * What the paired second screen shows right now (items, total, QRIS) —
 * PRD §3 F11 "Customer Display". `terminalDeviceId` is optional: the terminal
 * the display is paired to is resolved from the device context server-side.
 */
export async function fetchCustomerDisplayState(
  outletId: string,
  terminalDeviceId?: string,
  signal?: AbortSignal,
) {
  const { data } = await callEndpoint(
    getCustomerDisplayState,
    {
      params: { outletId },
      query: terminalDeviceId ? { terminalDeviceId } : {},
    },
    { signal },
  );
  return data;
}

/**
 * The order on screen, read for its reservation deposit only: the display
 * contract has no deposit field, so a DP order is detected here and never
 * shows a QRIS for the full total (sub-539-u2).
 */
export async function fetchDisplayOrder(
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
