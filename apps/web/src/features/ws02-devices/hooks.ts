// Registry data. The device list and training toggle come from ws02-edge's
// exported hooks (one owner per endpoint); only revoke and outlets live here.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Device } from "@starter/shared/edge";
import { orgEndpoints } from "@starter/shared/platform";
import { endpointQueryOptions } from "@/lib/api/endpoint";
import { edgeKeys } from "@/features/ws02-edge/queries";
import { revokeEdgeDeviceCall } from "./api.ts";

export { useEdgeDevices, useSetTrainingMode } from "@/features/ws02-edge/hooks";

const revokedKey = ["deviceRegistry", "revoked"] as const;

export function useOutlets() {
  return useQuery({
    ...endpointQueryOptions(orgEndpoints.listOutlets, {
      query: { limit: 50 },
    }),
    enabled: typeof window !== "undefined",
    retry: false,
  });
}

/** Devices revoked in this session (overlay until the polled list agrees). */
export function useRevokedOverlay(): ReadonlyMap<string, Device> {
  const { data } = useQuery({
    queryKey: revokedKey,
    queryFn: () => new Map<string, Device>(),
    staleTime: Infinity,
    gcTime: Infinity,
    initialData: () => new Map<string, Device>(),
  });
  return data;
}

export function useRevokeDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      deviceId,
      reason,
      idempotencyKey,
    }: {
      deviceId: string;
      reason: string;
      idempotencyKey: string;
    }) =>
      revokeEdgeDeviceCall(deviceId, reason, idempotencyKey).then(
        (r) => r.data,
      ),
    onSuccess: (device: Device) => {
      queryClient.setQueryData<Map<string, Device>>(revokedKey, (current) =>
        new Map(current ?? []).set(device.id, device),
      );
      return queryClient.invalidateQueries({ queryKey: edgeKeys.all });
    },
    // A conflict means the device is already revoked (or changed): reload.
    onError: () => queryClient.invalidateQueries({ queryKey: edgeKeys.all }),
  });
}
