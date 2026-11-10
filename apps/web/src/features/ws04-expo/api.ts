// One function per contract endpoint (docs/frontend.md, "Calling the API").
// Components never call these: they use the hooks in ./hooks.ts.
import {
  assignExpoRunner,
  callPickupNumber,
  getExpoBoard,
  getPickupDisplay,
  listExpoRunners,
} from "@starter/shared/kitchen";
import type { ExpoRunner, ExpoTicket } from "@starter/shared/kitchen";
import type { OutletId } from "@starter/shared/core";
import { callEndpoint } from "@/lib/api/endpoint.ts";

/** Every order across stations, per table (F12 "Expo"). */
export async function fetchExpoBoard(outletId: OutletId, signal?: AbortSignal) {
  const { data } = await callEndpoint(
    getExpoBoard,
    { params: { outletId } },
    { signal },
  );
  return data;
}

/** The staff the expo screen may pick as runner (F12 "menugaskan runner"). */
export async function fetchExpoRunners(
  outletId: OutletId,
  signal?: AbortSignal,
) {
  const { data } = await callEndpoint(
    listExpoRunners,
    { params: { outletId } },
    { signal },
  );
  return data;
}

export async function assignRunner(
  outletId: OutletId,
  orderId: ExpoTicket["orderId"],
  runnerId: ExpoRunner["userId"],
) {
  const { data } = await callEndpoint(assignExpoRunner, {
    params: { outletId, orderId },
    body: { runnerId },
  });
  return data;
}

/** Called numbers for takeaway and delivery channels (F12 "Pickup Display"). */
export async function fetchPickupDisplay(
  outletId: OutletId,
  signal?: AbortSignal,
) {
  const { data } = await callEndpoint(
    getPickupDisplay,
    { params: { outletId } },
    { signal },
  );
  return data;
}

/** "Panggil": mark a number called (the display then announces it). */
export async function callPickup(outletId: OutletId, callId: string) {
  const { data } = await callEndpoint(callPickupNumber, {
    params: { outletId, callId },
  });
  return data;
}
