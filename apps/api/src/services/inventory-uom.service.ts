// Tenant-defined units of measure (bead legend-ie6m): add and rename.
//
// Standard catalog units (`is_system`) are provisioned per tenant and are
// read-only. The code is immutable after creation because edge sync keys on
// it; only the name can change. Writes follow the setup conventions in
// inventory-setup.service.ts: tenant-scope `inventory.item.manage`, a
// transaction under RLS, idempotent create, and a before/after audit row.

import { and, eq, sql } from "drizzle-orm";
import { CoreError, type ScopedTenantContext } from "@starter/shared/core";
import {
  STANDARD_UOM_CATALOG,
  uomSchema,
  type createUomInputSchema,
  type updateUomInputSchema,
  type Uom,
} from "@starter/shared/inventory";
import type { z } from "zod";
import { uoms } from "../db/schema/index.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertSetupPermission,
  auditSetupChange,
  findIdempotentResource,
  rememberIdempotentResource,
  setupFingerprint,
  SETUP_WRITE_PERMISSION,
  type SetupTx,
} from "./inventory-setup.service.ts";

export type CreateUomInput = z.infer<typeof createUomInputSchema>;
export type UpdateUomInput = z.infer<typeof updateUomInputSchema>;

type UomRow = typeof uoms.$inferSelect;

const UOM_AUDIT_FIELDS = ["code", "name", "isSystem"] as const;

function toUom(row: UomRow): Uom {
  return uomSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    isSystem: row.isSystem,
  });
}

function uomAuditView(uom: Uom) {
  return { code: uom.code, name: uom.name, isSystem: uom.isSystem };
}

/** Serialises code checks for one tenant (the unique key is the backstop). */
async function lockTenantUoms(tx: SetupTx, tenantId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory:setup:uoms:${tenantId}`}, 0))`,
  );
}

export async function createUom(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateUomInput,
): Promise<Uom> {
  return withTenant(db, context, async (tx) => {
    await assertSetupPermission(
      tx,
      context,
      actorUserId,
      SETUP_WRITE_PERMISSION,
      { type: "tenant" },
    );
    const fingerprint = setupFingerprint("uom.create", [
      input.code,
      input.name,
    ]);
    const replayId = await findIdempotentResource(
      tx,
      context,
      input.idempotencyKey,
      "uom.create",
      fingerprint,
    );
    if (replayId) {
      const [first] = await tx.select().from(uoms).where(eq(uoms.id, replayId));
      if (!first) throw new HttpError(404, "NOT_FOUND", "Unit not found.");
      return toUom(first);
    }
    await lockTenantUoms(tx, context.tenant.tenantId);
    // Standard codes are reserved: a tenant not provisioned yet must not claim
    // one as a custom unit, or provisioning would skip it and it would never
    // become read-only.
    if (STANDARD_UOM_CATALOG.some((standard) => standard.code === input.code))
      throw new HttpError(
        409,
        "CONFLICT",
        "That code is reserved for a standard unit.",
      );
    const [clash] = await tx
      .select({ id: uoms.id })
      .from(uoms)
      .where(
        and(
          eq(uoms.tenantId, context.tenant.tenantId),
          eq(uoms.code, input.code),
        ),
      );
    if (clash)
      throw new HttpError(
        409,
        "CONFLICT",
        "This tenant already has a unit with that code.",
      );
    const [row] = await tx
      .insert(uoms)
      .values({
        tenantId: context.tenant.tenantId,
        code: input.code,
        name: input.name,
        isSystem: false,
      })
      .returning();
    const uom = toUom(row!);
    await rememberIdempotentResource(
      tx,
      context,
      input.idempotencyKey,
      "uom.create",
      fingerprint,
      uom.id,
    );
    await auditSetupChange(tx, context, actorUserId, {
      action: "inventory.uom.created",
      objectType: "uom",
      objectId: uom.id,
      outletId: null,
      before: null,
      after: uomAuditView(uom),
      safeFields: UOM_AUDIT_FIELDS,
    });
    return uom;
  });
}

export async function updateUom(
  context: ScopedTenantContext,
  actorUserId: string,
  uomId: string,
  input: UpdateUomInput,
): Promise<Uom> {
  return withTenant(db, context, async (tx) => {
    await assertSetupPermission(
      tx,
      context,
      actorUserId,
      SETUP_WRITE_PERMISSION,
      { type: "tenant" },
    );
    // RLS hides other tenants' units: a 404, never a 403.
    const [existing] = await tx.select().from(uoms).where(eq(uoms.id, uomId));
    if (!existing) throw new HttpError(404, "NOT_FOUND", "Unit not found.");
    if (existing.isSystem)
      throw new CoreError("FORBIDDEN", "Standard units cannot be edited.");
    // `is_system = false` in the WHERE keeps the guard atomic with the write.
    const [row] = await tx
      .update(uoms)
      .set({ name: input.name })
      .where(and(eq(uoms.id, existing.id), eq(uoms.isSystem, false)))
      .returning();
    if (!row)
      throw new CoreError("FORBIDDEN", "Standard units cannot be edited.");
    const before = toUom(existing);
    const after = toUom(row);
    await auditSetupChange(tx, context, actorUserId, {
      action: "inventory.uom.updated",
      objectType: "uom",
      objectId: after.id,
      outletId: null,
      before: uomAuditView(before),
      after: uomAuditView(after),
      safeFields: UOM_AUDIT_FIELDS,
    });
    return after;
  });
}
