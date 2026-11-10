// Outlet reach helpers for the AI insight read services (WS-12 wave 3, part A;
// beads legend-hkd4, legend-lely). Every decision comes from the caller's
// `AccessSnapshot`; the RLS context is minted only by `access.contextFor`.
//
// - `outlets` carries tenant RLS only, so a tenant-wide discovery context
//   lists the outlet ids; what the caller may read is decided by `allows`.
// - One `contextFor` context may not reach every permitted outlet (grants at
//   different scopes), so outlets are grouped by a context that covers them.
import { and, eq } from "drizzle-orm";
import type { PermissionCode } from "@starter/shared/access";
import {
  isOutletInScope,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import type { AccessSnapshot } from "./permission-resolver.ts";

export type OutletReadGroup = {
  readonly context: ScopedTenantContext;
  readonly outletIds: readonly string[];
};

export const insightForbidden = () =>
  new HttpError(403, "FORBIDDEN", "Your account cannot perform this action.");

async function tenantOutletIds(access: AccessSnapshot): Promise<string[]> {
  const { tenant } = access;
  const discovery = establishScopedTenantContext(tenant, { kind: "tenant" });
  const rows = await withTenant(db, discovery, (tx) =>
    tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(
        tenant.brandId === null
          ? eq(outlets.tenantId, tenant.tenantId)
          : and(
              eq(outlets.tenantId, tenant.tenantId),
              eq(outlets.brandId, tenant.brandId),
            ),
      )
      .orderBy(outlets.id),
  );
  return rows.map((row) => String(row.id));
}

/**
 * RLS context for one outlet, or 403 when the caller lacks `permission` there.
 */
export function outletContext(
  access: AccessSnapshot,
  permission: PermissionCode,
  outletId: string,
): ScopedTenantContext {
  const target = { type: "outlet", id: outletId } as const;
  if (!access.allows(permission, target)) throw insightForbidden();
  const context = access.contextFor(permission, target);
  if (!context || !isOutletInScope(context.outletScope, outletId))
    throw insightForbidden();
  return context;
}

/**
 * Outlets the caller may read through `permission`, grouped by an RLS context
 * that covers each group. With `outletId`, only that outlet (403 when not
 * permitted). Without it, every permitted outlet; 403 when there is none.
 */
export async function outletReadGroups(
  access: AccessSnapshot,
  permission: PermissionCode,
  outletId?: string,
): Promise<OutletReadGroup[]> {
  if (outletId !== undefined)
    return [
      {
        context: outletContext(access, permission, outletId),
        outletIds: [outletId],
      },
    ];
  const permitted = (await tenantOutletIds(access)).filter((id) =>
    access.allows(permission, { type: "outlet", id }),
  );
  if (permitted.length === 0) throw insightForbidden();
  const groups: { context: ScopedTenantContext; outletIds: string[] }[] = [];
  for (const id of permitted) {
    const group = groups.find((entry) =>
      isOutletInScope(entry.context.outletScope, id),
    );
    if (group) {
      group.outletIds.push(id);
      continue;
    }
    groups.push({
      context: outletContext(access, permission, id),
      outletIds: [id],
    });
  }
  return groups;
}
