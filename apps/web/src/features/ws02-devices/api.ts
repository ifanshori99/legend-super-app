import { callEndpoint } from "@/lib/api/endpoint";
import { revokeEdgeDevice } from "./endpoints.ts";

export function revokeEdgeDeviceCall(deviceId: string, reason: string) {
  return callEndpoint(revokeEdgeDevice, {
    params: { deviceId },
    body: { reason },
  });
}
