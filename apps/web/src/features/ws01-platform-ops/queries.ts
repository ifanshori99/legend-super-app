// Tenant and package reads go through the tenants feature's query factories
// (ws01-platform-tenants owns these endpoints and their mock store), so a
// package/flag/limit change made here is the same cached row the tenant list
// and detail screens show, and one invalidation refreshes every screen.
import type { TenantId } from "@starter/shared/core";
import {
  packagesQuery,
  tenantQuery as tenantByParams,
  tenantsQuery as tenantsByQuery,
  tenantUsageQuery,
} from "../ws01-platform-tenants/queries";

export { packagesQuery };

/** The platform registry is small (a handful of tenants); one page of 100. */
export const tenantsQuery = () => tenantsByQuery({ limit: 100 });

export const tenantQuery = (tenantId: string) =>
  tenantByParams({ tenantId: tenantId as TenantId });

export const usageQuery = (tenantId: string) =>
  tenantUsageQuery({ tenantId: tenantId as TenantId });
