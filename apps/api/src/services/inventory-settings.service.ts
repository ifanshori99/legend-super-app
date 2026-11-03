// Tenant inventory settings (PRD v1.7 §16 "Pemotongan Otomatis": recipe
// deduction real-time or at close of day "sesuai pengaturan"; §16 "Batch &
// Kedaluwarsa": the warning window before expiry; bead legend-gjmk).
//
// One row per tenant. A tenant that never saved settings reads the contract
// defaults. A change is a full replacement guarded by `expectedUpdatedAt`
// (PRECONDITION_FAILED on a stale value) and an idempotency key bound to the
// request fingerprint; every change is audited. Reading needs the stock view
// permission; changing the mode or window affects costing and alerts, so it
// needs the manager-level `inventory.adjustment.approve` (the catalog has no
// dedicated settings code; the lead may add one, see the bead report).

import { eq } from "drizzle-orm";
import { CoreError, type ScopedTenantContext } from "@starter/shared/core";
import {
  DEFAULT_EXPIRY_WARNING_DAYS,
  DEFAULT_RECIPE_DEDUCTION_MODE,
  inventorySettingsSchema,
  type InventorySettings,
  type updateInventorySettingsInputSchema,
} from "@starter/shared/inventory";
import type { z } from "zod";
import { inventorySettings } from "../db/schema/inventory-setup";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  assertSetupPermission,
  auditSetupChange,
  findIdempotentResource,
  rememberIdempotentResource,
  setupFingerprint,
} from "./inventory-setup.service";

export type UpdateInventorySettingsInput = z.infer<
  typeof updateInventorySettingsInputSchema
>;

const SETTINGS_AUDIT_FIELDS = [
  "recipeDeductionMode",
  "expiryWarningDays",
] as const;

type SettingsRow = typeof inventorySettings.$inferSelect;

function toSettings(
  tenantId: string,
  row: SettingsRow | undefined,
): InventorySettings {
  return inventorySettingsSchema.parse({
    tenantId,
    recipeDeductionMode:
      row?.recipeDeductionMode ?? DEFAULT_RECIPE_DEDUCTION_MODE,
    expiryWarningDays: row?.expiryWarningDays ?? DEFAULT_EXPIRY_WARNING_DAYS,
    updatedAt: row ? row.updatedAt.toISOString() : null,
  });
}

export async function getInventorySettings(
  context: ScopedTenantContext,
  actorUserId: string,
): Promise<InventorySettings> {
  return withTenant(db, context, async (tx) => {
    await assertSetupPermission(
      tx,
      context,
      actorUserId,
      "inventory.stock.view",
      { type: "tenant" },
    );
    const [row] = await tx
      .select()
      .from(inventorySettings)
      .where(eq(inventorySettings.tenantId, context.tenant.tenantId));
    return toSettings(context.tenant.tenantId, row);
  });
}

export async function updateInventorySettings(
  context: ScopedTenantContext,
  actorUserId: string,
  input: UpdateInventorySettingsInput,
): Promise<InventorySettings> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await assertSetupPermission(
      tx,
      context,
      actorUserId,
      "inventory.adjustment.approve",
      { type: "tenant" },
    );
    const fingerprint = setupFingerprint("settings.update", [
      input.recipeDeductionMode,
      input.expiryWarningDays,
      input.expectedUpdatedAt,
    ]);
    const replayed = await findIdempotentResource(
      tx,
      context,
      input.idempotencyKey,
      "settings.update",
      fingerprint,
    );
    const [existing] = await tx
      .select()
      .from(inventorySettings)
      .where(eq(inventorySettings.tenantId, tenantId));
    // A replay returns the settings as they are now (the first save won).
    if (replayed) return toSettings(tenantId, existing);
    const staleMessage =
      "Settings changed since they were read; reload them and try again.";
    let row: SettingsRow;
    if (!existing) {
      if (input.expectedUpdatedAt !== null)
        throw new CoreError("PRECONDITION_FAILED", staleMessage);
      const [created] = await tx
        .insert(inventorySettings)
        .values({
          tenantId,
          recipeDeductionMode: input.recipeDeductionMode,
          expiryWarningDays: input.expiryWarningDays,
          updatedBy: actorUserId,
        })
        .onConflictDoNothing()
        .returning();
      // Lost a first-save race against another request.
      if (!created) throw new CoreError("PRECONDITION_FAILED", staleMessage);
      row = created;
    } else {
      if (existing.updatedAt.toISOString() !== input.expectedUpdatedAt)
        throw new CoreError("PRECONDITION_FAILED", staleMessage);
      const [updated] = await tx
        .update(inventorySettings)
        .set({
          recipeDeductionMode: input.recipeDeductionMode,
          expiryWarningDays: input.expiryWarningDays,
          updatedBy: actorUserId,
          updatedAt: new Date(),
        })
        .where(eq(inventorySettings.tenantId, tenantId))
        .returning();
      row = updated!;
    }
    await rememberIdempotentResource(
      tx,
      context,
      input.idempotencyKey,
      "settings.update",
      fingerprint,
      tenantId,
    );
    const before = existing ? toSettings(tenantId, existing) : null;
    const after = toSettings(tenantId, row);
    await auditSetupChange(tx, context, actorUserId, {
      action: "inventory_settings.updated",
      objectType: "inventory_settings",
      objectId: tenantId,
      outletId: null,
      before:
        before === null
          ? null
          : {
              recipeDeductionMode: before.recipeDeductionMode,
              expiryWarningDays: before.expiryWarningDays,
            },
      after: {
        recipeDeductionMode: after.recipeDeductionMode,
        expiryWarningDays: after.expiryWarningDays,
      },
      safeFields: SETTINGS_AUDIT_FIELDS,
    });
    return after;
  });
}
