// The outlet a staff session pins for outlet-less routes (bead legend-6vgv;
// PRD v1.7 §3.7 RBAC, TEN-02/TEN-03). /api/floor, zones, tables and layout
// carry no outlet id, so the caller pins one with PUT /api/me/active-outlet
// and the server works on it.
//
// The pin is a preference, never a grant. `setActiveOutlet` stores it only
// after the outlet passed `assertOutletInScope` against the caller's own
// assigned outlets (the same list GET /api/me/access shows), and every read
// (`activeOutletOf`) checks the pin against that list again, so a revoked
// assignment or a closed outlet silently stops counting. An outlet the caller
// cannot reach, one of another tenant and an unknown id all answer the same
// 404, so the answer leaks nothing about other tenants (TEN-01).

import {
  CoreError,
  assertOutletInScope,
  outletIdSchema,
  type OutletId,
  type TenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { sessionActiveOutlets } from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import type { TenantAccessData } from "./permission-resolver";
import { listMyOutlets } from "./me-outlets.service";

type CallerInput = {
  readonly tenant: TenantContext;
  readonly userId: string;
  readonly sessionId: string;
  readonly data: TenantAccessData;
  readonly now: Date;
};

/** The stored pin of a session in this tenant, or null. Re-checked by callers. */
export async function pinnedOutletOf(
  tenant: TenantContext,
  sessionId: string,
): Promise<string | null> {
  const context = establishScopedTenantContext(tenant, { kind: "tenant" });
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select({ outletId: sessionActiveOutlets.outletId })
      .from(sessionActiveOutlets)
      .where(
        and(
          eq(sessionActiveOutlets.sessionId, sessionId),
          eq(sessionActiveOutlets.tenantId, tenant.tenantId),
        ),
      )
      .limit(1),
  );
  return rows[0]?.outletId.toLowerCase() ?? null;
}

/**
 * The active outlet among the caller's assigned outlets: the valid pin, else
 * the only assigned outlet, else null (several outlets and no valid pin, or no
 * outlet at all).
 */
export function chooseActiveOutlet(
  assignedIds: readonly string[],
  pinned: string | null,
): string | null {
  const ids = assignedIds.map((id) => id.toLowerCase());
  if (pinned && ids.includes(pinned.toLowerCase())) return pinned.toLowerCase();
  return ids.length === 1 ? ids[0]! : null;
}

/** The active outlet of this session, given the caller's assigned outlets. */
export async function activeOutletOf(
  input: Pick<CallerInput, "tenant" | "sessionId"> & {
    readonly assignedIds: readonly string[];
  },
): Promise<string | null> {
  if (input.assignedIds.length === 0) return null;
  return chooseActiveOutlet(
    input.assignedIds,
    await pinnedOutletOf(input.tenant, input.sessionId),
  );
}

/** Pins `outletId` for this session; 404 unless the caller is assigned to it. */
export async function setActiveOutlet(
  input: CallerInput & { readonly outletId: OutletId },
): Promise<string> {
  const assigned = await listMyOutlets(input);
  // Branded OutletId (lower case) for the insert and the scope check.
  const outletId = outletIdSchema.parse(input.outletId.toLowerCase());
  const notFound = () =>
    new HttpError(404, "OUTLET_NOT_FOUND", "Outlet tidak ditemukan.");
  // No assigned outlet: nothing is in scope (and an empty scope is no context).
  if (assigned.length === 0) throw notFound();
  const reach = establishScopedTenantContext(input.tenant, {
    kind: "outlets",
    outletIds: assigned.map((outlet) => outlet.id) as never,
  });
  try {
    assertOutletInScope(reach.outletScope, outletId);
  } catch (error) {
    if (error instanceof CoreError) throw notFound();
    throw error;
  }
  const context = establishScopedTenantContext(input.tenant, {
    kind: "tenant",
  });
  await withTenant(db, context, (tx) =>
    tx
      .insert(sessionActiveOutlets)
      .values({
        sessionId: input.sessionId,
        tenantId: input.tenant.tenantId,
        outletId,
      })
      .onConflictDoUpdate({
        target: [sessionActiveOutlets.sessionId, sessionActiveOutlets.tenantId],
        set: { outletId, updatedAt: input.now },
      }),
  );
  return outletId;
}
