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
import { callEndpoint } from "@/lib/api/endpoint.ts";
import { KITCHEN_OUTLET_ID } from "./outlet.ts";

/** Every order across stations, per table (F12 "Expo"). */
export async function fetchExpoBoard(signal?: AbortSignal) {
  const { data } = await callEndpoint(
    getExpoBoard,
    { params: { outletId: KITCHEN_OUTLET_ID } },
    { signal },
  );
  return data;
}

/** The staff the expo screen may pick as runner (F12 "menugaskan runner"). */
export async function fetchExpoRunners(signal?: AbortSignal) {
  const { data } = await callEndpoint(
    listExpoRunners,
    { params: { outletId: KITCHEN_OUTLET_ID } },
    { signal },
  );
  return data;
}

export async function assignRunner(
  orderId: ExpoTicket["orderId"],
  runnerId: ExpoRunner["userId"],
) {
  const { data } = await callEndpoint(assignExpoRunner, {
    params: { outletId: KITCHEN_OUTLET_ID, orderId },
    body: { runnerId },
  });
  return data;
}

/** Called numbers for takeaway and delivery channels (F12 "Pickup Display"). */
export async function fetchPickupDisplay(signal?: AbortSignal) {
  const { data } = await callEndpoint(
    getPickupDisplay,
    { params: { outletId: KITCHEN_OUTLET_ID } },
    { signal },
  );
  return data;
}

/** "Panggil": mark a number called (the display then announces it). */
export async function callPickup(callId: string) {
  const { data } = await callEndpoint(callPickupNumber, {
    params: { outletId: KITCHEN_OUTLET_ID, callId },
  });
  return data;
}
