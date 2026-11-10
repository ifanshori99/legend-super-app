import { callEndpoint } from "@/lib/api/endpoint";
import {
  enrollDevice,
  issueDeviceToken,
  revokeDevice,
  type Device,
} from "@starter/shared/edge";

export function revokeDeviceCall(
  deviceId: string,
  reason: string,
  idempotencyKey: string,
) {
  return callEndpoint(revokeDevice, {
    params: { deviceId },
    body: { reason, idempotencyKey },
  });
}

export function enrollDeviceCall(
  body: {
    outletId: string;
    type: Device["type"];
    label: string;
  },
  idempotencyKey: string,
) {
  return callEndpoint(enrollDevice, { body: { ...body, idempotencyKey } });
}

export function issueDeviceTokenCall(deviceId: string, idempotencyKey: string) {
  return callEndpoint(issueDeviceToken, {
    params: { deviceId },
    body: { idempotencyKey },
  });
}
