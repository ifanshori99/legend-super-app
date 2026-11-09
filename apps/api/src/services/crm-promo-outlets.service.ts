// Per-outlet promotion switch administration (contract PromotionOutlet,
// endpoints listPromotionOutlets / setPromotionOutlet; PRD v1.7 §3.21; TEN-01..03;
// bead legend-e5it). Routes: routes/crm-promo.routes.ts. Engine side and the
// "no row = runs everywhere" reading: crm-promo-outlets.ts.
//
// The list needs tenant-wide `promo.manage` (it answers every outlet of the
// tenant). Setting one outlet needs `promo.manage` on THAT outlet, so a
// brand-scoped marketing role can switch promotions for its own outlets only;
// the row is outlet-owned, so outlet RLS backs the check. Each change is
// audited and emitted as `promotion_outlet.changed` for edge nodes.

import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { AccessTarget, PermissionCode } from "@starter/shared/access";
import {
  promotionOutletSchema,
  setPromotionOutletInputSchema,
  type PromotionOutlet,
  type PromotionOutletScope,
} from "@starter/shared/crm";
import {
  createUlid,
  outletIdSchema,
  userIdSchema,
  z,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { maskAuditChanges } from "@starter/shared/audit";
import { db } from "../db";
import { outlets, promotionOutlets, promotions } from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";
import { appendPromoEvent, requirePromoOutlet } from "./crm-promo-engine";
import { promotionRunsAtOutlet } from "./crm-promo-outlets";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
  type Tx,
} from "./permission-resolver";

type SetPromotionOutletInput = z.output<typeof setPromotionOutletInputSchema>;

const MANAGE_PERMISSION: PermissionCode = "promo.manage";
const AUDIT_FIELDS: readonly string[] = ["promotionId", "outletId", "enabled"];

/**
 * Stable aggregate id of one (promotion, outlet) switch: a name-based UUID
 * (RFC 9562 v5 layout over SHA-256), so every event of the pair shares one
 * aggregate and one outlet.
 */
export function promotionOutletAggregateId(
  promotionId: string,
  outletId: string,
): string {
  const bytes = createHash("sha256")
    .update(`promotion_outlet:${promotionId}:${outletId}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Service-layer authorization (TEN-03), in the tenant transaction. */
async function assertPermission(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  target: AccessTarget,
): Promise<void> {
  const data = await loadTenantAccessInTransaction(tx, context, actorUserId);
  const snapshot = resolveAccessSnapshot({
    tenant: context.tenant,
    userId: actorUserId,
    ...data,
    mfaVerified: false,
    now: new Date(),
  });
  if (!snapshot.allows(MANAGE_PERMISSION, target))
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Your account cannot perform this action in this tenant.",
    );
}

/** The promotion must exist in this tenant (RLS hides other tenants'). */
async function requirePromotion(
  tx: Tx,
  context: ScopedTenantContext,
  promotionId: string,
): Promise<PromotionOutletScope> {
  const [row] = await tx
    .select({ outletScope: promotions.outletScope })
    .from(promotions)
    .where(
      and(
        eq(promotions.tenantId, context.tenant.tenantId),
        eq(promotions.id, promotionId),
      ),
    )
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Promo tidak ditemukan.");
  return row.outletScope;
}

/** Every outlet of the tenant with the promotion's effective state there. */
export async function listPromotionOutlets(
  context: ScopedTenantContext,
  actorUserId: string,
  promotionId: string,
): Promise<PromotionOutlet[]> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, { type: "tenant" });
    const scope = await requirePromotion(tx, context, promotionId);
    const tenantId = context.tenant.tenantId;
    const rows = await tx
      .select({ outletId: outlets.id, enabled: promotionOutlets.enabled })
      .from(outlets)
      .leftJoin(
        promotionOutlets,
        and(
          eq(promotionOutlets.tenantId, outlets.tenantId),
          eq(promotionOutlets.outletId, outlets.id),
          eq(promotionOutlets.promotionId, promotionId),
        ),
      )
      .where(eq(outlets.tenantId, tenantId))
      .orderBy(asc(outlets.code), asc(outlets.id));
    return rows.map((row) =>
      promotionOutletSchema.parse({
        promotionId,
        tenantId,
        outletId: row.outletId,
        // Effective state per the promotion's scope (crm-promo-outlets.ts):
        // all_except: no row = runs; only: no row = does not run.
        enabled: promotionRunsAtOutlet(scope, row.enabled),
      }),
    );
  });
}

/** Switches a promotion on or off at one outlet (idempotent). */
export async function setPromotionOutlet(
  context: ScopedTenantContext,
  actorUserId: string,
  promotionId: string,
  outletId: string,
  input: SetPromotionOutletInput,
  now = new Date(),
): Promise<PromotionOutlet> {
  const actor = userIdSchema.parse(actorUserId);
  const outletKey = outletIdSchema.parse(outletId);
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actor, {
      type: "outlet",
      id: outletKey,
    });
    await requirePromoOutlet(tx, context, outletKey);
    const scope = await requirePromotion(tx, context, promotionId);
    const tenantId = context.tenant.tenantId;
    const [before] = await tx
      .select({ enabled: promotionOutlets.enabled })
      .from(promotionOutlets)
      .where(
        and(
          eq(promotionOutlets.tenantId, tenantId),
          eq(promotionOutlets.promotionId, promotionId),
          eq(promotionOutlets.outletId, outletKey),
        ),
      )
      .limit(1)
      .for("update");
    const wasEnabled = promotionRunsAtOutlet(scope, before?.enabled ?? null);
    await tx
      .insert(promotionOutlets)
      .values({
        tenantId,
        promotionId,
        outletId: outletKey,
        enabled: input.enabled,
        updatedBy: actor,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          promotionOutlets.tenantId,
          promotionOutlets.promotionId,
          promotionOutlets.outletId,
        ],
        set: { enabled: input.enabled, updatedBy: actor, updatedAt: now },
      });
    const result = promotionOutletSchema.parse({
      promotionId,
      tenantId,
      outletId: outletKey,
      enabled: input.enabled,
    });
    if (wasEnabled === input.enabled) return result;
    const payload = {
      promotionId,
      outletId: outletKey,
      enabled: input.enabled,
    };
    const aggregateId = promotionOutletAggregateId(promotionId, outletKey);
    await appendPromoEvent(tx, context, "promotion_outlet.changed", {
      aggregateId,
      aggregateUuid: aggregateId,
      outletId: outletKey,
      actorUserId: actor,
      idempotencyKey: `promotion_outlet.changed:${promotionId}:${outletKey}:${now.getTime()}`,
      now,
      payload,
    });
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId: outletKey,
        actorType: "user",
        actorId: actor,
        deviceId: null,
        action: "promotion_outlet.changed",
        objectType: "promotion",
        objectId: promotionId,
        reason: null,
        maskedChanges: {
          before: maskAuditChanges(
            { ...payload, enabled: wasEnabled },
            AUDIT_FIELDS,
          ),
          after: maskAuditChanges(payload, AUDIT_FIELDS),
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      AUDIT_FIELDS,
    );
    return result;
  });
}
