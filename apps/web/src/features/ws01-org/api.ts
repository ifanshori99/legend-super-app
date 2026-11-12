// Typed calls for the outlet settings screen (bead legend-1mi5). The contract
// owns the shapes (platform/endpoints.ts): the PATCH is audited by the API as
// `outlet.business_day_cutoff.updated` when the cutoff changes (D-CORE-7).
import type { OutletId } from "@starter/shared/core";
import type {
  AddDomainInput,
  TenantDomainId,
  UpdateOutletInput,
} from "@starter/shared/platform";
import { orgEndpoints } from "@starter/shared/platform";
import { callEndpoint } from "@/lib/api/endpoint";

export function updateOutlet(outletId: OutletId, body: UpdateOutletInput) {
  return callEndpoint(orgEndpoints.updateOutlet, {
    params: { outletId },
    body,
  });
}

// Custom-domain verification (bead legend-az8z5). `verifyDomain` answers 422
// DOMAIN_VERIFICATION_FAILED while the TXT record is not found; add answers
// 422 DOMAIN_RESERVED / 409 DOMAIN_TAKEN.
export function addDomain(body: AddDomainInput) {
  return callEndpoint(orgEndpoints.addDomain, { body });
}

export function verifyDomain(domainId: TenantDomainId) {
  return callEndpoint(orgEndpoints.verifyDomain, { params: { domainId } });
}
