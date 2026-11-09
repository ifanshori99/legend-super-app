// Read-only `PaymentProvider.getPayment` over DOIT. It asks DOIT for the
// payment and reports what DOIT says; it writes nothing, so a network error,
// timeout or 5xx leaves local state alone and reaches the caller as the
// gateway's SERVICE_UNAVAILABLE. The lookup of DOIT's own id for a Legend
// reference is injected, so this file never touches the database.

import {
  scopedReferenceSchema,
  type PaymentProvider,
  type ScopedReference,
} from "@starter/shared/adapters";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  CoreError,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { DoitGateway } from "./payment-doit";

export type DoitPaymentRef = {
  /** DOIT's payment id (not the Legend reference). */
  providerRef: string;
  integrationId: string | null;
  outletId: string;
};

export type DoitPaymentResolver = (
  context: ScopedTenantContext,
  scopedRef: ScopedReference,
) => Promise<DoitPaymentRef | null>;

export function createDoitPaymentReader(deps: {
  gateway: Pick<DoitGateway, "lookupPayment">;
  resolve: DoitPaymentResolver;
}): Pick<PaymentProvider, "getPayment"> {
  return {
    async getPayment(context, input) {
      assertTrustedScopedContext(context);
      const scoped = scopedReferenceSchema.parse(input);
      if (context.tenant.tenantId !== scoped.tenantId)
        throw new TypeError("Tenant mismatch");
      assertOutletInScope(context.outletScope, scoped.outletId);
      const found = await deps.resolve(context, scoped);
      if (!found)
        throw new CoreError("NOT_FOUND", "Pembayaran tidak ditemukan.");
      // Defence in depth: the resolver must answer for the outlet asked about.
      if (found.outletId !== scoped.outletId)
        throw new CoreError("NOT_FOUND", "Pembayaran tidak ditemukan.");
      return deps.gateway.lookupPayment({
        context,
        outletId: found.outletId,
        integrationId: found.integrationId,
        providerRef: found.providerRef,
        reference: scoped.reference,
      });
    },
  };
}
