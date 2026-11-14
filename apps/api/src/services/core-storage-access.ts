// Storage upload/read authorization (bead legend-tiie, object owner and source
// legend-pszrm). The storage router takes a `resolveRequest`; this builds it
// from the caller's verified tenant membership and role assignments
// (loadRequestAccess). Upload is decided per purpose, source kind and outlet.
// Read of a private object is decided per object id: the owner reads it only
// while they still hold a code of the kind's feature over the object's current
// outlet (a revoked owner gets no signed URL); anyone else needs a review code
// for the object's source kind over its outlet; an object with no source kind
// (legacy or unclassified upload) is readable only by the strict manager codes
// of its purpose. Not mounted yet:
// there is no object storage provider (legend-7nv1 mounts
// createCoreStorageRouterWithAccess).
//
// The catalog has no storage codes, so each source kind reuses the permission
// of the feature that owns the file. Adding codes needs a migration backfill
// and is out of scope here.

import { and, eq, sql } from "drizzle-orm";
import type { Request } from "express";
import { AccessError, type PermissionCode } from "@starter/shared/access";
import { outletIdSchema, type OutletId } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  storageObjectIdSchema,
  storagePurposeSchema,
  storageSourceKindPurpose,
  storageSourceKindSchema,
  type StoragePurpose,
  type StorageSourceKind,
} from "@starter/shared/storage";
import { db } from "../db";
import { coreStorageObjects } from "../db/schema/core-storage";
import { leaveRequests } from "../db/schema/hris-leave";
import { employees } from "../db/schema/hris";
import { withTenant } from "../db/tenant";
import { getAuth } from "../middleware/auth";
import { loadRequestAccess } from "../middleware/permissions";
import { getTenantContext } from "../middleware/tenant";
import { createStorageRouter } from "../routes/core-storage.routes";
import { loadTenantAccess } from "./permission-resolver";

type StorageAction = "upload" | "read";

/**
 * Any-of permission table, one row per source kind. The caller needs one of
 * the listed codes over the object's outlet (a tenant or brand grant covers
 * it). Read is the review side of that kind only: purchasing invoice matching
 * does not read a reimbursement receipt, and the people who upload a file
 * cannot read it back unless they also review (the owner can, while they
 * still hold an upload or review code of the kind over the outlet).
 */
export const storageSourcePermissionMap = {
  purchase_invoice: {
    upload: ["purchasing.request.create", "purchasing.invoice.match"],
    read: ["purchasing.invoice.match"],
  },
  goods_receipt: {
    upload: ["inventory.stock.receive"],
    read: ["purchasing.invoice.match", "inventory.stock.receive"],
  },
  expense: {
    upload: ["accounting.expense.request"],
    read: ["accounting.expense.approve"],
  },
  cash_deposit: {
    upload: ["accounting.cash_deposit.record"],
    read: ["accounting.reconcile"],
  },
  reimbursement: {
    upload: ["self.reimbursement.request"],
    read: ["hr.reimbursement.approve"],
  },
  attendance: {
    upload: ["self.attendance.clock"],
    read: ["hr.attendance.manage", "hr.attendance_correction.approve"],
  },
  employee_document: {
    upload: ["hr.employee.manage"],
    read: ["hr.employee.view"],
  },
  employment_contract: {
    upload: ["hr.employee.manage"],
    read: ["hr.employee.view"],
  },
  leave_request: {
    upload: ["self.leave.request"],
    read: ["hr.leave.approve"],
  },
  menu_item: {
    upload: ["menu.item.manage"],
    read: ["menu.item.view"],
  },
  waste_log: {
    upload: ["inventory.waste.record"],
    read: ["inventory.stock.view"],
  },
  petty_purchase: {
    upload: ["purchasing.petty.record"],
    read: ["accounting.reconcile", "purchasing.petty_policy.manage"],
  },
  // Cleaning photos: only the uploader (while entitled) and the facility
  // manager read them back; a colleague with the operate code does not.
  cleaning_task: {
    upload: ["facility.booth.operate"],
    read: ["facility.config.manage"],
  },
  // The maintenance team has to see the damage photo, so the staff code reads;
  // facility.config.manage is the facility manager.
  maintenance_ticket: {
    upload: ["ops.equipment.maintain"],
    read: ["ops.equipment.maintain", "facility.config.manage"],
  },
  // Checklist evidence includes signatures (personal data): the uploader (while
  // entitled) and the checklist manager only.
  checklist_evidence: {
    upload: ["ops.checklist.complete"],
    read: ["ops.checklist.manage"],
  },
} as const satisfies Record<
  StorageSourceKind,
  Record<StorageAction, readonly PermissionCode[]>
>;

/** Upload codes for an upload that names no source kind (any-of, per purpose). */
export const storageLegacyUploadMap = {
  menu_photo: ["menu.item.manage"],
  selfie: ["self.attendance.clock"],
  document: ["hr.employee.manage"],
  // A receipt names its kind: an unclassified one would reach the wrong
  // reviewers (legend-pszrm review). Legacy rows keep the strict read list.
  receipt: [],
  // Tenant-level: decided at tenant scope in the resolver, never per outlet.
  brand_logo: [],
} as const satisfies Record<StoragePurpose, readonly PermissionCode[]>;

/** Strict read codes for an object with no source kind (legacy or
 * unclassified). Only the managers of the purpose, not the per-kind reviewers. */
export const storageLegacyReadMap = {
  selfie: ["hr.attendance.manage"],
  document: ["hr.employee.manage"],
  receipt: ["accounting.reconcile"],
  menu_photo: ["menu.item.manage"],
  brand_logo: ["org.theme.manage"],
} as const satisfies Record<StoragePurpose, readonly PermissionCode[]>;

/** Code to upload the tenant-level brand logo, needed at tenant scope. */
const brandLogoUploadCode =
  "org.theme.manage" as const satisfies PermissionCode;

type ResolveRequest = Parameters<
  typeof createStorageRouter
>[0]["resolveRequest"];

const purposeKeys = Object.keys(storageLegacyUploadMap) as StoragePurpose[];

const sourceKindsOf = (purpose: StoragePurpose) =>
  (Object.keys(storageSourcePermissionMap) as StorageSourceKind[]).filter(
    (kind) => storageSourceKindPurpose[kind] === purpose,
  );

/** Purposes the request may concern, narrowed to the uploaded purpose when
 * the multipart body already carries a valid one. The narrowing only shrinks
 * the minted scope: `authorize` still decides every purpose and outlet. */
function purposesOf(req: Request, action: StorageAction): StoragePurpose[] {
  if (action === "upload") {
    const body = req.body as { purpose?: unknown } | undefined;
    const purpose = storagePurposeSchema.safeParse(body?.purpose);
    if (purpose.success) return [purpose.data];
  }
  return purposeKeys;
}

const denied = () =>
  new AccessError(
    "PERMISSION_DENIED",
    "Your account cannot use file storage in this tenant.",
  );

type ReadableObject = {
  id: string;
  outletId: string;
  purpose: StoragePurpose;
  ownerUserId: string | null;
  sourceKind: StorageSourceKind | null;
};

export function createStorageRequestResolver(): ResolveRequest {
  return async (req) => {
    // Needs requireAuth and a tenant context; their 401/404 come first.
    const snapshot = await loadRequestAccess(req);
    const tenant = getTenantContext(req);
    const actorUserId = getAuth(req).user.id;
    // The snapshot does not carry the org tree. One more read on the tenant
    // transaction gives the outlets that exist for this tenant (and brand).
    const { org } = await loadTenantAccess(
      establishScopedTenantContext(tenant, { kind: "tenant" }),
      actorUserId,
    );
    const outlets = org.outlets.map((outlet) => outlet.id);
    const inTenant = (outletId: string) =>
      outlets.some((id) => id.toLowerCase() === outletId.toLowerCase());
    const allowsAny = (codes: readonly PermissionCode[], outletId: OutletId) =>
      codes.some((code) =>
        snapshot.allows(code, { type: "outlet", id: outletId }),
      );
    // Upload: the kind's codes, or the per-purpose list when no kind is named.
    const canUpload = (
      purpose: StoragePurpose,
      outletId: OutletId,
      sourceKind: StorageSourceKind | null,
    ) => {
      // The brand logo has no outlet: only the tenant-scope path below.
      if (purpose === "brand_logo") return false;
      if (sourceKind === null)
        return allowsAny(storageLegacyUploadMap[purpose], outletId);
      if (storageSourceKindPurpose[sourceKind] !== purpose) return false;
      return allowsAny(storageSourcePermissionMap[sourceKind].upload, outletId);
    };
    // Read: the owner while still entitled (an upload or review code of the
    // kind over the object's outlet now), else the review codes of the kind,
    // else (no kind) the strict legacy manager codes.
    const canRead = (object: ReadableObject, outletId: OutletId) => {
      if (
        object.sourceKind !== null &&
        storageSourceKindPurpose[object.sourceKind] !== object.purpose
      )
        return false;
      if (object.ownerUserId !== null && object.ownerUserId === actorUserId) {
        const ownerCodes =
          object.sourceKind === null
            ? [
                ...storageLegacyUploadMap[object.purpose],
                ...storageLegacyReadMap[object.purpose],
              ]
            : [
                ...storageSourcePermissionMap[object.sourceKind].upload,
                ...storageSourcePermissionMap[object.sourceKind].read,
              ];
        if (allowsAny(ownerCodes, outletId)) return true;
      }
      if (object.sourceKind === null)
        return allowsAny(storageLegacyReadMap[object.purpose], outletId);
      return allowsAny(
        storageSourcePermissionMap[object.sourceKind].read,
        outletId,
      );
    };

    // objectId in the path is the signed-URL (read) route.
    const requested: StorageAction =
      typeof req.params.objectId === "string" ? "read" : "upload";

    if (requested === "read") {
      const objectId = storageObjectIdSchema.safeParse(req.params.objectId);
      if (!objectId.success) throw denied();
      const { row, leave } = await withTenant(
        db,
        establishScopedTenantContext(tenant, { kind: "tenant" }),
        async (tx) => {
          const row = (
            await tx
              .select({
                tenantId: coreStorageObjects.tenantId,
                outletId: coreStorageObjects.outletId,
                id: coreStorageObjects.id,
                purpose: coreStorageObjects.purpose,
                ownerUserId: coreStorageObjects.ownerUserId,
                sourceKind: coreStorageObjects.sourceKind,
              })
              .from(coreStorageObjects)
              .where(
                and(
                  eq(coreStorageObjects.tenantId, tenant.tenantId),
                  eq(coreStorageObjects.id, objectId.data),
                ),
              )
              .limit(1)
          )[0];
          const leave = (
            await tx
              .select({
                outletId: leaveRequests.outletId,
                userId: employees.userId,
              })
              .from(leaveRequests)
              .innerJoin(
                employees,
                and(
                  eq(employees.tenantId, leaveRequests.tenantId),
                  eq(employees.id, leaveRequests.employeeId),
                ),
              )
              .where(
                and(
                  eq(leaveRequests.tenantId, tenant.tenantId),
                  sql`lower(${leaveRequests.attachmentKey}) = ${objectId.data.toLowerCase()}`,
                ),
              )
              .limit(1)
          )[0];
          return { row, leave };
        },
      );
      // Missing, other-tenant and not-allowed all answer the same (no
      // existence oracle).
      const purpose = storagePurposeSchema.safeParse(row?.purpose);
      const outlet = outletIdSchema.safeParse(row?.outletId);
      const kind =
        row?.sourceKind == null
          ? { success: true as const, data: null }
          : storageSourceKindSchema.safeParse(row.sourceKind);
      if (
        !row ||
        row.tenantId !== tenant.tenantId ||
        !purpose.success ||
        !outlet.success ||
        !kind.success ||
        !inTenant(outlet.data)
      )
        throw denied();
      const object: ReadableObject = {
        id: row.id,
        outletId: outlet.data,
        purpose: purpose.data,
        ownerUserId: row.ownerUserId,
        sourceKind: kind.data,
      };
      // Historical objects may be unclassified or wrongly classified. The
      // leave reference takes precedence over the stored object's metadata.
      // The owner needs a live self.leave.request grant at the leave's outlet;
      // otherwise an approver with hr.leave.approve there.
      const canReadLeave = () =>
        leave === undefined ||
        (leave.outletId.toLowerCase() === object.outletId.toLowerCase() &&
          ((leave.userId === actorUserId &&
            allowsAny(["self.leave.request"], outlet.data)) ||
            allowsAny(["hr.leave.approve"], outlet.data)));
      if (
        !canReadLeave() ||
        (leave === undefined && !canRead(object, outlet.data))
      )
        throw denied();

      return {
        actorUserId,
        context: establishScopedTenantContext(tenant, {
          kind: "outlets",
          outletIds: [outlet.data],
        }),
        authorize: async (action, purposeArg, outletArg, target) => {
          if (action !== "read") return false;
          const purposeKey = storagePurposeSchema.safeParse(purposeArg);
          const outletKey = outletIdSchema.safeParse(outletArg);
          if (!purposeKey.success || !outletKey.success) return false;
          if (target?.objectId?.toLowerCase() !== object.id.toLowerCase())
            return false;
          if (purposeKey.data !== object.purpose) return false;
          if (outletKey.data.toLowerCase() !== object.outletId.toLowerCase())
            return false;
          // A kind that disagrees with the row's purpose is never valid.
          if (
            target.sourceKind != null &&
            storageSourceKindPurpose[target.sourceKind] !== object.purpose
          )
            return false;
          return (
            canReadLeave() &&
            (leave !== undefined || canRead(object, outletKey.data))
          );
        },
      };
    }

    // Brand logo: tenant-level, so a tenant scope is minted only when the
    // multipart body purpose is exactly brand_logo and the caller holds the
    // code at tenant scope. Anything else falls through to the outlet path.
    const bodyPurpose = (req.body as { purpose?: unknown } | undefined)
      ?.purpose;
    if (bodyPurpose === "brand_logo") {
      if (!snapshot.allows(brandLogoUploadCode, { type: "tenant" }))
        throw denied();
      return {
        actorUserId,
        context: establishScopedTenantContext(tenant, { kind: "tenant" }),
        authorize: async (action, purpose, outletId, target) =>
          action === "upload" &&
          purpose === "brand_logo" &&
          outletId === null &&
          (target?.sourceKind ?? null) === null,
      };
    }

    // Scope is minted before the body is parsed by the service. Only the
    // outlets the caller can reach for an upload of these purposes go in it
    // (any kind of the purpose, or the no-kind list), so the service's scope
    // check and RLS never see a wider reach.
    const purposes = purposesOf(req, "upload");
    const outletIds = outlets.filter((outletId) =>
      purposes.some(
        (purpose) =>
          canUpload(purpose, outletId, null) ||
          sourceKindsOf(purpose).some((kind) =>
            canUpload(purpose, outletId, kind),
          ),
      ),
    );
    if (outletIds.length === 0) throw denied();

    return {
      actorUserId,
      context: establishScopedTenantContext(tenant, {
        kind: "outlets",
        outletIds,
      }),
      authorize: async (action, purpose, outletId, target) => {
        if (action !== "upload") return false;
        // A null outlet is only valid for brand_logo (handled above).
        if (outletId === null) return false;
        const purposeKey = storagePurposeSchema.safeParse(purpose);
        const outlet = outletIdSchema.safeParse(outletId);
        if (!purposeKey.success || !outlet.success) return false;
        // An outlet outside this tenant (or brand) is not in the org tree.
        if (!inTenant(outlet.data)) return false;
        return canUpload(
          purposeKey.data,
          outlet.data,
          target?.sourceKind ?? null,
        );
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
