// Typed endpoint callers for the connectivity kit (docs/frontend.md, "Typed
// endpoints and mock mode"). Components never call these directly; they use
// the hooks in ./hooks.ts.
import {
  getEdgeStatus,
  listEdgeDevices,
  listPrintJobs,
  reprintPrintJob,
  retryPrintJob,
  setOutletDeviceTrainingMode,
  type CloudLink,
  type DeviceListQuery,
  type PrintJobListQuery,
} from "@starter/shared/edge";
import { createUlid } from "@starter/shared/core";
import { apiFetch } from "@/lib/api/client";
import { callEndpoint } from "@/lib/api/endpoint";

export function fetchEdgeStatus(signal?: AbortSignal) {
  return callEndpoint(getEdgeStatus, undefined, { signal });
}

export function fetchEdgeDevices(query: DeviceListQuery, signal?: AbortSignal) {
  return callEndpoint(listEdgeDevices, { query }, { signal });
}

export function fetchPrintJobs(query: PrintJobListQuery, signal?: AbortSignal) {
  return callEndpoint(listPrintJobs, { query }, { signal });
}

export function reprintPrintJobCall(printJobId: string) {
  return callEndpoint(reprintPrintJob, {
    params: { printJobId },
    body: { idempotencyKey: createUlid() },
  });
}

export function retryPrintJobCall(printJobId: string) {
  return callEndpoint(retryPrintJob, {
    params: { printJobId },
    body: { idempotencyKey: createUlid() },
  });
}

export function setDeviceTrainingModeCall(
  deviceId: string,
  trainingMode: boolean,
) {
  return callEndpoint(setOutletDeviceTrainingMode, {
    params: { deviceId },
    body: { trainingMode },
  });
}

/**
 * Owner override of the 24 hour catalog sales gate (legend-10nex). The edge
 * API takes `{ minutes, reason }` and answers owners only, offline included.
 */
export function grantCatalogOverrideCall(body: {
  minutes: number;
  reason: string;
}) {
  return apiFetch<{ data: unknown }>("/api/edge/catalog-override", {
    method: "POST",
    body,
  });
}

/** Dev-only mock control handle (see mock.ts); typed for the console. */
export type EdgeMockControl = {
  setCloudLink: (link: CloudLink) => void;
  setPendingEvents: (count: number) => void;
};
