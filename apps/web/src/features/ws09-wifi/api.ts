// Typed calls for the guest Wi-Fi portal, one function per endpoint of the
// WS-09 facility contract (`@starter/shared/facility`, PRD v1.7 §3 Kelompok C
// "Wi-Fi Tamu & WFC"). Responses are unwrapped to their payload so components
// and query options never see the `{ data }` envelope.
import { callEndpoint } from "@/lib/api/endpoint";
import {
  getCurrentWifiSession,
  getWifiPolicyForZone,
  listSubscriptionPlans,
  refreshWifiQuota,
  startWifiSession,
  type StartWifiSessionInput,
} from "@starter/shared/facility";

export async function fetchWifiPolicy(zoneId: string, signal?: AbortSignal) {
  const response = await callEndpoint(
    getWifiPolicyForZone,
    { query: { zoneId } },
    { signal },
  );
  return response.data;
}

/** The caller's session today, or null when this account is not connected. */
export async function fetchCurrentWifiSession(signal?: AbortSignal) {
  const response = await callEndpoint(getCurrentWifiSession, {}, { signal });
  return response.data;
}

export function requestWifiSession(body: StartWifiSessionInput) {
  return callEndpoint(startWifiSession, { body }).then(
    (response) => response.data,
  );
}

/**
 * FAC-12: called after a payment lands; returns the recomputed allowance.
 * The body is empty — the API derives same-day spend from the account's
 * settled payments, never from the client.
 */
export function requestQuotaRefresh() {
  return callEndpoint(refreshWifiQuota, { body: {} }).then(
    (response) => response.data,
  );
}

export async function fetchWfcPlans(facilityId: string, signal?: AbortSignal) {
  const response = await callEndpoint(
    listSubscriptionPlans,
    { query: { facilityId } },
    { signal },
  );
  return response.data.plans;
}
