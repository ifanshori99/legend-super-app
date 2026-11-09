// Storage upload/read authorization (bead legend-tiie). The storage router
// takes a `resolveRequest`; this builds it from the caller's verified tenant
// membership and role assignments (loadRequestAccess), so access is decided
// per purpose, per action and per outlet. Not mounted yet: there is no object
// storage provider (legend-7nv1 mounts createCoreStorageRouterWithAccess).
//
// The catalog has no storage codes, so each purpose reuses the permission of
// the feature that owns the file. Adding codes needs a migration backfill and
// is out of scope here.

import type { Request } from "express";
import { AccessError, type PermissionCode } from "@starter/shared/access";
import { outletIdSchema, type OutletId } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  storagePurposeSchema,
  type StoragePurpose,
} from "@starter/shared/storage";
import { getAuth } from "../middleware/auth";
import { loadRequestAccess } from "../middleware/permissions";
import { getTenantContext } from "../middleware/tenant";
import { createStorageRouter } from "../routes/core-storage.routes";
import { loadTenantAccess } from "./permission-resolver";

type StorageAction = "upload" | "read";

/**
 * Any-of permission table, one row per purpose. The caller needs one of the
 * listed codes over the target outlet (a tenant or brand grant covers it).
 * Receipt read is the review side only: invoice matching (purchasing),
 * expense approval (finance) and reimbursement approval (HR). The people who
 * upload a receipt cannot read it back unless they also review.
 */
export const storagePermissionMap = {
  menu_photo: {
    upload: ["menu.item.manage"],
    read: ["menu.item.view"],
  },
  selfie: {
    upload: ["self.attendance.clock"],
    read: ["hr.attendance.manage", "hr.attendance_correction.approve"],
  },
  document: {
    upload: ["hr.employee.manage"],
    read: ["hr.employee.view"],
  },
  receipt: {
    upload: [
      "purchasing.request.create",
      "accounting.expense.request",
      "accounting.cash_deposit.record",
      "self.reimbursement.request",
    ],
    read: [
      "purchasing.invoice.match",
      "accounting.expense.approve",
      "hr.reimbursement.approve",
    ],
  },
} as const satisfies Record<
  StoragePurpose,
  Record<StorageAction, readonly PermissionCode[]>
>;

type ResolveRequest = Parameters<
  typeof createStorageRouter
>[0]["resolveRequest"];

/** Purposes the request may concern, narrowed to the uploaded purpose when
 * the multipart body already carries a valid one. The narrowing only shrinks
 * the minted scope: `authorize` still decides every purpose and outlet. */
function purposesOf(req: Request, action: StorageAction): StoragePurpose[] {
  if (action === "upload") {
    const body = req.body as { purpose?: unknown } | undefined;
    const purpose = storagePurposeSchema.safeParse(body?.purpose);
    if (purpose.success) return [purpose.data];
  }
  return Object.keys(storagePermissionMap) as StoragePurpose[];
}

export function createStorageRequestResolver(): ResolveRequest {
  return async (req) => {
    // Needs requireAuth and a tenant context; their 401/404 come first.
    const snapshot = await loadRequestAccess(req);
    const tenant = getTenantContext(req);
    // The snapshot does not carry the org tree. One more read on the tenant
    // transaction gives the outlets that exist for this tenant (and brand).
    const { org } = await loadTenantAccess(
      establishScopedTenantContext(tenant, { kind: "tenant" }),
      getAuth(req).user.id,
    );
    const outlets = org.outlets.map((outlet) => outlet.id);
    const permitted = (
      action: StorageAction,
      purpose: StoragePurpose,
      outletId: OutletId,
    ) =>
      storagePermissionMap[purpose][action].some((code) =>
        snapshot.allows(code, { type: "outlet", id: outletId }),
      );

    // Scope is minted before the body is parsed by the service. Only the
    // outlets the caller can reach for this action and these purposes go in
    // it, so the service's scope check and RLS never see a wider reach.
    // objectId in the path is the signed-URL (read) route.
    const requested: StorageAction =
      typeof req.params.objectId === "string" ? "read" : "upload";
    const purposes = purposesOf(req, requested);
    const outletIds = outlets.filter((outletId) =>
      purposes.some((purpose) => permitted(requested, purpose, outletId)),
    );
    if (outletIds.length === 0)
      throw new AccessError(
        "PERMISSION_DENIED",
        "Your account cannot use file storage in this tenant.",
      );

    return {
      context: establishScopedTenantContext(tenant, {
        kind: "outlets",
        outletIds,
      }),
      authorize: async (action, purpose, outletId) => {
        const purposeKey = storagePurposeSchema.safeParse(purpose);
        const outlet = outletIdSchema.safeParse(outletId);
        if (!purposeKey.success || !outlet.success) return false;
        if (!(action === "upload" || action === "read")) return false;
        // An outlet outside this tenant (or brand) is not in the org tree.
        if (
          !outlets.some((id) => id.toLowerCase() === outlet.data.toLowerCase())
        )
          return false;
        return permitted(action, purposeKey.data, outlet.data);
      },
    };
  };
}

/** The storage router with the real resolver, for legend-7nv1 to mount once a
 * provider exists. */
export function createCoreStorageRouterWithAccess(
  options: Omit<Parameters<typeof createStorageRouter>[0], "resolveRequest">,
) {
  return createStorageRouter({
    ...options,
    resolveRequest: createStorageRequestResolver(),
  });
}
