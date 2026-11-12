// The only way the outlet screen touches outlet data: the list query keeps its
// endpoint key, and a write invalidates the list so the card and the form show
// the same row.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import type { OutletId } from "@starter/shared/core";
import type {
  AddDomainInput,
  TenantDomainId,
  UpdateOutletInput,
} from "@starter/shared/platform";
import { orgEndpoints } from "@starter/shared/platform";
import * as api from "./api";
import { brandsQuery, domainsQuery, outletsQuery } from "./queries";

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

export function useDomains() {
  return useQuery(domainsQuery());
}

export function useOrgBrands() {
  return useQuery(brandsQuery());
}

// A failed check or add leaves the list as it was; only a success refreshes it.
export function useAddDomain() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AddDomainInput) => api.addDomain(body),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [orgEndpoints.listDomains.id],
      }),
  });
}

export function useVerifyDomain() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (domainId: TenantDomainId) => api.verifyDomain(domainId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [orgEndpoints.listDomains.id],
      }),
  });
}
