// Hooks are the only way components touch edge data. They own polling, cache
// keys and invalidation.
import { useRouteContext } from "@tanstack/react-router";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { Device } from "@starter/shared/edge";
import { ANONYMOUS_ACCESS, type AreaAccess } from "@/lib/areas/access";
import { useOnline } from "@/lib/use-online";
import {
  grantCatalogOverrideCall,
  reprintPrintJobCall,
  retryPrintJobCall,
  setDeviceTrainingModeCall,
} from "./api.ts";
import {
  CATALOG_OVERRIDE_PERMISSION,
  isCatalogSalesBlockedError,
} from "./catalog-sales.ts";
import { cloudConnectionOnline } from "./logic.ts";
import {
  edgeDevicesQuery,
  edgeKeys,
  edgeNodesQuery,
  edgeStatusQuery,
  printQueueQuery,
  printQueueJobs,
} from "./queries.ts";

/**
 * Live edge status. Disabled during SSR: it is a probe of the device's own
 * edge node, and the server cannot stand in for that device.
 */
export function useEdgeStatus(options?: { enabled?: boolean }) {
  return useQuery({
    ...edgeStatusQuery(),
    enabled: typeof window !== "undefined" && (options?.enabled ?? true),
  });
}

/** Back-office node list; browser only, like the status probe above. */
export function useEdgeNodes() {
  return useQuery({
    ...edgeNodesQuery(),
    enabled: typeof window !== "undefined",
  });
}

/**
 * Cloud connection for the operations header badge (legend-b0l9): the edge
 * node's cloud link, with browser connectivity as the secondary hint. Shares
 * the status query with the offline banner, so no extra request. Pass
 * `enabled: false` where the badge is not shown (no edge probe then).
 */
export function useCloudConnection(options?: { enabled?: boolean }): boolean {
  const browserOnline = useOnline();
  const { data } = useEdgeStatus(options);
  return cloudConnectionOnline({
    browserOnline,
    cloudLink: data?.data.cloudLink ?? null,
  });
}

export function useEdgeDevices(options?: {
  outletId?: string;
  enabled?: boolean;
}) {
  return useQuery({
    ...edgeDevicesQuery({ limit: 25, outletId: options?.outletId }),
    enabled: typeof window !== "undefined" && (options?.enabled ?? true),
  });
}

/** The print queue is read when its drawer opens, not on every page. */
export function usePrintQueue(enabled: boolean) {
  const query = useInfiniteQuery({ ...printQueueQuery(), enabled });
  return { ...query, jobs: printQueueJobs(query.data?.pages) };
}

function useInvalidateQueue() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: edgeKeys.printJobs() });
}

/** "Cetak ulang": queues a new job that references the original (F5). */
export function useReprintPrintJob() {
  const invalidate = useInvalidateQueue();
  return useMutation({
    mutationFn: (printJobId: string) => reprintPrintJobCall(printJobId),
    onSuccess: invalidate,
  });
}

/** Retry a failed job: failed → queued, the printer stays the same. */
export function useRetryPrintJob() {
  const invalidate = useInvalidateQueue();
  return useMutation({
    mutationFn: (printJobId: string) => retryPrintJobCall(printJobId),
    onSuccess: invalidate,
  });
}

/** Mode Latihan per device: sandbox data that never enters reports (F5). */
export function useSetTrainingMode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      deviceId,
      trainingMode,
    }: {
      deviceId: string;
      trainingMode: boolean;
    }) => setDeviceTrainingModeCall(deviceId, trainingMode).then((r) => r.data),
    onSuccess: (device: Device) => {
      queryClient.setQueryData<{ data: { thisDevice: Device | null } }>(
        edgeKeys.status(),
        (current) =>
          current
            ? { ...current, data: { ...current.data, thisDevice: device } }
            : current,
      );
      return queryClient.invalidateQueries({ queryKey: edgeKeys.all });
    },
  });
}

// ---- Catalog sales gate (legend-10nex) --------------------------------------

/** Presentation only: the API re-checks the owner role on every grant. */
export function useCanGrantCatalogOverride(): boolean {
  const context = useRouteContext({ strict: false }) as {
    readonly access?: AreaAccess;
  };
  // Fail closed: no access context means no override action.
  const access = context.access ?? ANONYMOUS_ACCESS;
  return (access.permissions as readonly string[]).includes(
    CATALOG_OVERRIDE_PERMISSION,
  );
}

/** Owner allows selling on an old catalog; the status poll shows the result. */
export function useGrantCatalogOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { minutes: number; reason: string }) =>
      grantCatalogOverrideCall(input),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: edgeKeys.catalogSalesBlock() });
      return queryClient.invalidateQueries({ queryKey: edgeKeys.status() });
    },
  });
}

export type CatalogSalesBlockNote = { message: string; at: number };

/**
 * An order call refused with CATALOG_STALE_BLOCKED: keep its message for the
 * notice and re-read the status so the gate state shows without waiting for
 * the next poll. Other errors are ignored.
 */
export function noteCatalogSalesBlocked(
  queryClient: QueryClient,
  error: unknown,
) {
  if (!isCatalogSalesBlockedError(error)) return;
  queryClient.setQueryData<CatalogSalesBlockNote>(
    edgeKeys.catalogSalesBlock(),
    { message: error.message, at: Date.now() },
  );
  void queryClient.invalidateQueries({ queryKey: edgeKeys.status() });
}

export function useCatalogSalesBlockNote(): CatalogSalesBlockNote | null {
  const { data } = useQuery<CatalogSalesBlockNote | null>({
    queryKey: edgeKeys.catalogSalesBlock(),
    // Written only by noteCatalogSalesBlocked; never fetched.
    queryFn: () => null,
    enabled: false,
    staleTime: Infinity,
  });
  return data ?? null;
}
