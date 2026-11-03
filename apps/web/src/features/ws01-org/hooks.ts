// The only way the outlet screen touches outlet data: the list query keeps its
// endpoint key, and a write invalidates the list so the card and the form show
// the same row.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import type { OutletId } from "@starter/shared/core";
import type { UpdateOutletInput } from "@starter/shared/platform";
import { orgEndpoints } from "@starter/shared/platform";
import * as api from "./api";
import { outletsQuery } from "./queries";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

export function useOutlets(query: Query<typeof orgEndpoints.listOutlets>) {
  return useQuery(outletsQuery(query));
}

export function useUpdateOutlet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      outletId,
      body,
    }: {
      outletId: OutletId;
      body: UpdateOutletInput;
    }) => api.updateOutlet(outletId, body),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [orgEndpoints.listOutlets.id],
      }),
  });
}
