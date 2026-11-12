// Query keys and options for the outlet settings screen. `endpointQueryOptions`
// keys by endpoint id + input, so invalidating `[endpoint.id]` refreshes the
// list (docs/frontend.md "Typed endpoints and mock mode").
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { orgEndpoints } from "@starter/shared/platform";
import { endpointQueryOptions } from "@/lib/api/endpoint";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

export const outletsQuery = (query: Query<typeof orgEndpoints.listOutlets>) =>
  endpointQueryOptions(orgEndpoints.listOutlets, { query });

// Custom-domain verification (bead legend-az8z5). Brands are read only to pick
// the brand a new domain attaches to (`addDomainInputSchema.brandId`).
export const domainsQuery = () =>
  endpointQueryOptions(orgEndpoints.listDomains);

export const brandsQuery = () => endpointQueryOptions(orgEndpoints.listBrands);
