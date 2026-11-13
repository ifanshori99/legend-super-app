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
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { CONTRACT_PENDING, type EdgeNodesOverview } from "./types.ts";

export function fetchEdgeStatus(signal?: AbortSignal) {
  return callEndpoint(getEdgeStatus, undefined, { signal });
}

export function fetchEdgeDevices(
  query: DeviceListQuery & { outletId?: string },
  signal?: AbortSignal,
) {
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

/**
 * Back-office list of edge nodes with their receipt-run alert (legend-ph62j).
 * No cloud endpoint yet (./CONTRACT-GAPS.md): mock fixture in mock mode,
 * CONTRACT_PENDING everywhere else.
 */
export async function fetchEdgeNodes(): Promise<EdgeNodesOverview> {
  if (!API_MOCK)
    throw new ApiError(
      501,
      CONTRACT_PENDING,
      "Fitur ini belum tersambung ke server (status edge).",
    );
  const { mockEdgeNodes } = await import("./nodes-mock.ts");
  return mockEdgeNodes();
}

/** Dev-only mock control handle (see mock.ts); typed for the console. */
export type EdgeMockControl = {
  setCloudLink: (link: CloudLink) => void;
  setPendingEvents: (count: number) => void;
  setReceiptRunAlert: (on: boolean) => void;
};
