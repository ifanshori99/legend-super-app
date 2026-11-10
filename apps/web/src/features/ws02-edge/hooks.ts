// Hooks are the only way components touch edge data. They own polling, cache
// keys and invalidation.
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { Device } from "@starter/shared/edge";
import { useOnline } from "@/lib/use-online";
import {
  reprintPrintJobCall,
  retryPrintJobCall,
  setDeviceTrainingModeCall,
} from "./api.ts";
import { cloudConnectionOnline } from "./logic.ts";
import {
  edgeDevicesQuery,
  edgeKeys,
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

export function useEdgeDevices() {
  return useQuery({
    ...edgeDevicesQuery(),
    enabled: typeof window !== "undefined",
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
