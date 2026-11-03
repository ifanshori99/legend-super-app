// What the wizard created in this browser session, per tenant. The platform
// contract has no read endpoint for a tenant's first admin and the org reads
// are tenant-scoped, so the detail screen merges these rows in (by id) until
// the real API exposes them. Memory only: a reload drops it.
// TEN-04: the admin contact is kept masked; the full number and email go to
// the API once (createTenant body) and are never held here.
import type { Brand, LegalEntity, Outlet } from "@starter/shared/platform";

export type ProvisionedOrg = {
  brand?: Brand;
  outlet?: Outlet;
  legalEntity?: LegalEntity;
  admin?: { name: string; whatsappMasked: string; emailMasked: string | null };
};

const provisioned = new Map<string, ProvisionedOrg>();

export const getProvisioned = (tenantId: string): ProvisionedOrg =>
  provisioned.get(tenantId) ?? {};

export const rememberProvisioned = (
  tenantId: string,
  patch: ProvisionedOrg,
) => {
  provisioned.set(tenantId, { ...getProvisioned(tenantId), ...patch });
};
