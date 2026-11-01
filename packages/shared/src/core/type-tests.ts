// Compile-time contract tests, checked by `pnpm typecheck` (never imported at
// runtime). Each @ts-expect-error line must fail to compile; if a refactor
// makes it compile, typecheck fails because the directive is unused.

import { z } from "zod";
import { cafeLegendFixtures } from "./fixtures.ts";
import { idr } from "./money.ts";
import type { Decimal4, Idr } from "./money.ts";
import { establishTenantContext } from "./server.ts";
import { clientInputSchema } from "./tenant.ts";
import type { OutletScope, TenantContext } from "./tenant.ts";
import type { OutletId, TenantId } from "./ids.ts";

export function typeTests(): void {
  const tenantId = cafeLegendFixtures.tenant.id;

  // TEN-02: a TenantContext cannot be forged from request values.
  // @ts-expect-error object literal lacks the private brand
  const forged: TenantContext = { tenantId, brandId: null, source: "domain" };

  // TEN-03: an OutletScope cannot be forged from request values either.
  // @ts-expect-error object literal lacks the private brand
  const forgedScope: OutletScope = { kind: "tenant", tenantId };

  // @ts-expect-error "client" is not a tenant context source
  establishTenantContext({ tenantId, brandId: null, source: "client" });

  // TEN-02: request schemas cannot declare a tenant field.
  // @ts-expect-error tenantId is forbidden in client input
  clientInputSchema({ tenantId: z.string() });
  // @ts-expect-error tenant_id is forbidden in client input
  clientInputSchema({ tenant_id: z.string() });

  // Branded ids do not mix.
  const outletId: OutletId = cafeLegendFixtures.outlets[0].id;
  // @ts-expect-error an OutletId is not a TenantId
  const wrongId: TenantId = outletId;
  // @ts-expect-error a plain string is not a TenantId
  const plainId: TenantId = "0b6f1c2e-7d4a-4c1e-9a3b-2f5d8e1a4c70";

  // Money is branded: plain numbers and decimal strings are not Idr.
  // @ts-expect-error a plain number is not Idr
  const plainAmount: Idr = 25_000;
  // @ts-expect-error a plain string is not Decimal4
  const plainQuantity: Decimal4 = "1.5";
  const amount: Idr = idr(25_000);

  void [
    forged,
    forgedScope,
    wrongId,
    plainId,
    plainAmount,
    plainQuantity,
    amount,
  ];
}
