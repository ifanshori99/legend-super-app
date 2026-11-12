// Registry data. The device list and training toggle come from ws02-edge's
// exported hooks (one owner per endpoint); revoke, enroll, token reissue and outlets live here.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Device } from "@starter/shared/edge";
import { edgeKeys } from "@/features/ws02-edge/queries";
import {
  enrollDeviceCall,
  issueDeviceTokenCall,
  revokeDeviceCall,
} from "./api.ts";

export { useEdgeDevices, useSetTrainingMode } from "@/features/ws02-edge/hooks";

const revokedKey = ["deviceRegistry", "revoked"] as const;

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
      revokeDeviceCall(deviceId, reason, idempotencyKey).then((r) => r.data),
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

/**
 * The enroll and reissue answers carry the device token, which is shown once
 * and never kept: `gcTime: 0` drops the mutation result from the cache as soon
 * as the screen stops observing it, and only the device (not the token) is
 * written to the query cache. The token lives in the caller's component state.
 */
export function useEnrollDevice(
  onIssued?: (result: { device: Device; token: string }) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: ({
      idempotencyKey,
      ...body
    }: {
      outletId: string;
      type: Device["type"];
      label: string;
      idempotencyKey: string;
    }) => enrollDeviceCall(body, idempotencyKey).then((r) => r.data),
    // Hook-level, so the one-time token reaches the caller even if the
    // dialog that started the request is gone by the time it answers.
    onSuccess: (result) => {
      onIssued?.(result);
      return queryClient.invalidateQueries({ queryKey: edgeKeys.all });
    },
  });
}

/** Reissue: a new token; tokens issued before it stop working. */
export function useIssueDeviceToken(
  onIssued?: (result: { device: Device; token: string }) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: ({
      deviceId,
      idempotencyKey,
    }: {
      deviceId: string;
      idempotencyKey: string;
    }) => issueDeviceTokenCall(deviceId, idempotencyKey).then((r) => r.data),
    onSuccess: (result) => {
      onIssued?.(result);
      return queryClient.invalidateQueries({ queryKey: edgeKeys.all });
    },
  });
}
