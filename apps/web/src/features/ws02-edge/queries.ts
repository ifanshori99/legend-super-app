// Query keys and options for the connectivity kit. Status and device lists
// poll (the edge node reports heartbeats); the print queue is fetched when its
// drawer opens and after every action.
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  type DeviceListQuery,
  type PrintJobListQuery,
  type PrintJob,
} from "@starter/shared/edge";
import {
  fetchEdgeDevices,
  fetchEdgeNodes,
  fetchEdgeStatus,
  fetchPrintJobs,
} from "./api.ts";

export const PRINT_QUEUE_PAGE_SIZE = 20;

export const edgeKeys = {
  all: ["edge"] as const,
  status: () => [...edgeKeys.all, "status"] as const,
  devices: (query: DeviceListQuery & { outletId?: string }) =>
    [...edgeKeys.all, "devices", query] as const,
  nodes: () => [...edgeKeys.all, "nodes"] as const,
  /** Last order refusal for a stale catalog, kept until the next status read. */
  catalogSalesBlock: () => [...edgeKeys.all, "catalog-sales-block"] as const,
  printJobs: () => [...edgeKeys.all, "print-jobs"] as const,
  printJobList: (query: PrintJobListQuery) =>
    [...edgeKeys.printJobs(), query] as const,
};

export function edgeStatusQuery() {
  return queryOptions({
    queryKey: edgeKeys.status(),
    queryFn: ({ signal }) => fetchEdgeStatus(signal),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
    // A failed probe is the offline signal; retrying would only delay the banner.
    retry: false,
  });
}

export function edgeNodesQuery() {
  return queryOptions({
    queryKey: edgeKeys.nodes(),
    queryFn: () => fetchEdgeNodes(),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
    retry: false,
  });
}

export function edgeDevicesQuery(
  query: DeviceListQuery & { outletId?: string } = { limit: 25 },
) {
  return queryOptions({
    queryKey: edgeKeys.devices(query),
    queryFn: ({ signal }) => fetchEdgeDevices(query, signal),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
    retry: false,
  });
}

export function printQueueQuery() {
  return infiniteQueryOptions({
    queryKey: edgeKeys.printJobList({ limit: PRINT_QUEUE_PAGE_SIZE }),
    queryFn: ({ pageParam, signal }) =>
      fetchPrintJobs(
        { limit: PRINT_QUEUE_PAGE_SIZE, cursor: pageParam },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { meta: { nextCursor: string | null } }) =>
      last.meta.nextCursor ?? undefined,
  });
}

export function printQueueJobs(
  pages: readonly { data: readonly PrintJob[] }[] | undefined,
): PrintJob[] {
  return pages?.flatMap((page) => page.data) ?? [];
}
