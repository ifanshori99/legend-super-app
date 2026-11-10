// One function per contract endpoint (docs/frontend.md, "Calling the API").
// Components never call these: they use the hooks in ./hooks.ts.
import { getCustomerDisplayState } from "@starter/shared/pos";
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
