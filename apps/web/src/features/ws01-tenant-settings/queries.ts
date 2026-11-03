// Query options for the tenant settings screens. `endpointQueryOptions` keys by
// endpoint id + input, so the integrations list shares its cache entry with
// every other reader of the same endpoint.
import { endpointQueryOptions } from "@/lib/api/endpoint";
import { orgEndpoints, textOverrideEndpoints } from "@starter/shared/platform";

export const integrationsQuery = () =>
  endpointQueryOptions(orgEndpoints.listIntegrations);

export const brandsQuery = () => endpointQueryOptions(orgEndpoints.listBrands);

export const outletsQuery = () =>
  endpointQueryOptions(orgEndpoints.listOutlets, { query: { limit: 100 } });

export const themesQuery = (brandId: string) =>
  endpointQueryOptions(orgEndpoints.listThemes, { query: { brandId } });

/** Both locales: the editor shows the `id` row as the fallback for `en`. */
export const textOverridesQuery = () =>
  endpointQueryOptions(textOverrideEndpoints.listTextOverrides, { query: {} });
