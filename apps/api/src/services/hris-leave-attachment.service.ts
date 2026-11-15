import { and, eq } from "drizzle-orm";
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import type { ObjectStorage } from "@starter/shared/adapters";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import { withTenant } from "../db/tenant.ts";
import { uploadStorage } from "./core-storage.ts";
import type { MalwareScanner } from "./core-image.ts";
import { forbidden, loadHrisAccess } from "./hris-access.ts";

/** Uploads only the caller's leave proof, scoped to their own home outlet. */
export async function uploadLeaveAttachment(
  context: ScopedTenantContext,
  actorUserId: string,
  bytes: Uint8Array,
  deps: { storage: ObjectStorage; scanner: MalwareScanner },
): Promise<{ attachmentUploadRef: string }> {
  const home = await withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId);
    // Live self.leave.request grant at the leave's own (home) outlet, so the
    // upload ref can only be used where the link will actually open (legend-bkd76).
    if (
      !access.own ||
      !access.snapshot.allows("self.leave.request", {
        type: "outlet",
        id: access.own.homeOutletId,
      })
    )
      throw forbidden();
    const [employee] = await tx
      .select({ status: employees.status })
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, context.tenant.tenantId),
          eq(employees.id, access.own.id),
        ),
      )
      .limit(1);
    if (!employee || !["active", "onboarding"].includes(employee.status))
      throw forbidden();
    return outletIdSchema.parse(access.own.homeOutletId);
  });
  const scoped = establishScopedTenantContext(context.tenant, {
    kind: "outlets",
    outletIds: [home],
  });
  const uploaded = await uploadStorage(
    db,
    scoped,
    {
      purpose: "document",
      outletId: home,
      sourceKind: "leave_request",
    },
    bytes,
    {
      ...deps,
      actorUserId,
      authorize: async (action, purpose, outletId, target) =>
        action === "upload" &&
        purpose === "document" &&
        outletId === home &&
        target?.sourceKind === "leave_request",
    },
  );
  return { attachmentUploadRef: uploaded.id };
}
