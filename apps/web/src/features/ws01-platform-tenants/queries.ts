import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { orgEndpoints, platformEndpoints } from "@starter/shared/platform";
import { endpointQueryOptions } from "@/lib/api/endpoint";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];

export const packagesQuery = () =>
  endpointQueryOptions(platformEndpoints.listPackages);

export const tenantsQuery = (
  query: Query<typeof platformEndpoints.listTenants>,
) => endpointQueryOptions(platformEndpoints.listTenants, { query });

export const tenantQuery = (
  params: Params<typeof platformEndpoints.getTenant>,
) => endpointQueryOptions(platformEndpoints.getTenant, { params });

export const tenantUsageQuery = (
  params: Params<typeof platformEndpoints.getTenantUsage>,
) => endpointQueryOptions(platformEndpoints.getTenantUsage, { params });

export const brandsQuery = () => endpointQueryOptions(orgEndpoints.listBrands);

export const outletsQuery = () =>
  endpointQueryOptions(orgEndpoints.listOutlets, { query: { limit: 100 } });

export const legalEntitiesQuery = () =>
  endpointQueryOptions(orgEndpoints.listLegalEntities);
