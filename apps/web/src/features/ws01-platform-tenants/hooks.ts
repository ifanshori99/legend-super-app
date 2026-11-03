// The only way components touch tenant data: queries keep endpoint keys,
// mutations invalidate every list a write can change.
import * as React from "react";
import type { TenantId } from "@starter/shared/core";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { platformEndpoints } from "@starter/shared/platform";
import type {
  Brand,
  CreateTenantInput,
  LegalEntity,
  Outlet,
  SetTenantStatusInput,
  Tenant,
} from "@starter/shared/platform";
import * as api from "./api";
import {
  brandsQuery,
  legalEntitiesQuery,
  outletsQuery,
  packagesQuery,
  tenantQuery,
  tenantsQuery,
  tenantUsageQuery,
} from "./queries";
import {
  buildBrandInput,
  buildLegalEntityInput,
  buildOutletInput,
  buildTenantInput,
  maskEmail,
  maskWhatsapp,
  type WizardDraft,
} from "./logic";
import { rememberProvisioned } from "./session-cache";
import type { PlatformPackage } from "@starter/shared/platform";

export const usePackages = () => useQuery(packagesQuery());

export function useTenants(query: Parameters<typeof tenantsQuery>[0]) {
  return useQuery({
    ...tenantsQuery(query),
    placeholderData: keepPreviousData,
  });
}

export const useTenant = (tenantId: string) =>
  useQuery(tenantQuery({ tenantId: tenantId as TenantId }));

export const useTenantUsage = (tenantId: string) =>
  useQuery(tenantUsageQuery({ tenantId: tenantId as TenantId }));

export const useTenantBrands = () => useQuery(brandsQuery());
export const useTenantOutlets = () => useQuery(outletsQuery());
export const useTenantLegalEntities = () => useQuery(legalEntitiesQuery());

/** Debounced copy of a value (search box -> request). */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function useInvalidateTenants() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      [
        platformEndpoints.listTenants.id,
        platformEndpoints.getTenant.id,
        platformEndpoints.getTenantUsage.id,
      ].map((id) => queryClient.invalidateQueries({ queryKey: [id] })),
    );
}

export function useSetTenantStatus(tenantId: string) {
  const refresh = useInvalidateTenants();
  return useMutation({
    mutationFn: (body: SetTenantStatusInput) =>
      api.setTenantStatus({ tenantId: tenantId as TenantId }, body),
    onSuccess: () => refresh(),
  });
}

export type ProvisionResult = {
  tenant: Tenant;
  legalEntity: LegalEntity;
  brand: Brand;
  outlet: Outlet;
};

export class ProvisionError extends Error {
  stage: "tenant" | "legal" | "brand" | "outlet";
  cause: unknown;
  constructor(stage: ProvisionError["stage"], cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.stage = stage;
    this.cause = cause;
  }
}

/**
 * Flow R: tenant -> legal entity -> brand -> outlet (the outlet names both).
 * Completed stages are remembered, so a retry after a partial failure resumes
 * instead of creating the tenant twice.
 */
export function useProvisionTenant() {
  const refresh = useInvalidateTenants();
  const done = React.useRef<Partial<ProvisionResult>>({});
  const mutation = useMutation({
    mutationFn: async (input: { draft: WizardDraft; pkg: PlatformPackage }) => {
      const { draft, pkg } = input;
      const step = async <T>(
        stage: ProvisionError["stage"],
        run: () => Promise<T>,
      ) => {
        try {
          return await run();
        } catch (error) {
          throw new ProvisionError(stage, error);
        }
      };
      if (!done.current.tenant) {
        const body: CreateTenantInput = buildTenantInput(draft, pkg);
        done.current.tenant = (
          await step("tenant", () => api.createTenant(body))
        ).data;
        rememberProvisioned(done.current.tenant.id, {
          admin: {
            name: body.firstAdmin.name,
            whatsappMasked: maskWhatsapp(body.firstAdmin.whatsapp),
            emailMasked: maskEmail(body.firstAdmin.email),
          },
        });
      }
      const tenantId = done.current.tenant.id;
      if (!done.current.legalEntity) {
        done.current.legalEntity = (
          await step("legal", () =>
            api.createLegalEntity(buildLegalEntityInput(draft)),
          )
        ).data;
        rememberProvisioned(tenantId, {
          legalEntity: done.current.legalEntity,
        });
      }
      if (!done.current.brand) {
        done.current.brand = (
          await step("brand", () => api.createBrand(buildBrandInput(draft)))
        ).data;
        rememberProvisioned(tenantId, { brand: done.current.brand });
      }
      if (!done.current.outlet) {
        const outletBody = buildOutletInput(draft, {
          brandId: done.current.brand.id,
          legalEntityId: done.current.legalEntity.id,
        });
        done.current.outlet = (
          await step("outlet", () => api.createOutlet(outletBody))
        ).data;
        rememberProvisioned(tenantId, { outlet: done.current.outlet });
      }
      return done.current as ProvisionResult;
    },
    onSuccess: () => refresh(),
  });
  return {
    ...mutation,
    /** Stage that already succeeded (tenant created) but a later one failed. */
    getCreated: () => done.current.tenant,
  };
}
