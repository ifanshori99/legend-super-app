import { endpointQueryOptions } from "@/lib/api/endpoint";
import { platformEndpoints } from "@starter/shared/platform";

export const packagesQuery = () =>
  endpointQueryOptions(platformEndpoints.listPackages);

/** The platform registry is small (a handful of tenants); one page of 100. */
export const tenantsQuery = () =>
  endpointQueryOptions(platformEndpoints.listTenants, {
    query: { limit: 100 },
  });

export const tenantQuery = (tenantId: string) =>
  endpointQueryOptions(platformEndpoints.getTenant, { params: { tenantId } });

export const usageQuery = (tenantId: string) =>
  endpointQueryOptions(platformEndpoints.getTenantUsage, {
    params: { tenantId },
  });
