// Promo engine administration, checkout preview, vouchers and ROI (PRD v1.7
// §3.21 "Promo Engine", "ROI Promo"; LOY-03; ORD-03; TEN-01..03; bead
// legend-7x4g). Routes: routes/crm-promo.routes.ts.
//
// Every function runs inside `withTenant`, so Postgres RLS scopes rows to the
// resolved tenant, and re-checks the caller's permission on its target
// (tenant-wide `promo.manage` for administration, `order.create` on the outlet
// for a checkout preview) on top of the route middleware. Rules are data: the
// price decision is the shared pure evaluator, run by crm-promo-engine.ts —
// the same adapter the POS, QR and website checkouts call in their order
// transaction (`redeemPromotions` / `releasePromotions`).

import { isDeepStrictEqual } from "node:util";
import { randomInt } from "node:crypto";
import { and, desc, eq, lt, or, sql, type SQL } from "drizzle-orm";
import type { AccessTarget, PermissionCode } from "@starter/shared/access";
import {
  createPromotionInputSchema,
  evaluatePromotion,
  issueVoucherInputSchema,
  listPromotionsQuerySchema,
  listVouchersQuerySchema,
  outletLocalClock,
  promoEvaluationRequestSchema,
  promotionSchema,
  updatePromoStackingPolicyInputSchema,
  updatePromotionInputSchema,
  voucherDtoSchema,
  voucherUsability,
  voucherValidationInputSchema,
  type PromoRejectionReason,
  type PromoStackingPolicy,
  type Promotion,
  type PromotionApplicationResult,
  type PromotionRoi,
  type PromotionStatus,
  type VoucherDto,
  type VoucherIssued,
  type VoucherRejectionReason,
  type VoucherValidationResult,
} from "@starter/shared/crm";
import {
  createUlid,
  decodeCursor,
  encodeCursor,
  idr,
  outletIdSchema,
  userIdSchema,
  z,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { db } from "../db";
import {
  promoSettings,
  promotionOrderApplications,
  promotionRedemptions,
  promotions,
  vouchers,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { openSecret, sealSecret } from "../lib/secrets";
import { recordAudit } from "./core-audit";
import {
  appendPromoEvent,
  hashPromoCode,
  loadStackingPolicy,
  PROMO_AUDIT_SAFE_FIELDS,
  promoAuditChanges,
  priceRequestLines,
  quotePromotions,
  requirePromoOutlet,
  resolveCode,
  toPromotion,
  toVoucher,
  type PromotionRow,
} from "./crm-promo-engine";
import { promoIdempotentCommand } from "./crm-promo-idempotency";
import { assertFacilityProductOpen } from "./facility-shower-gate";
import { assertPromoBenefitNotWfc } from "./wfc-product-guard";
import { promotionDisabledAtOutlet } from "./crm-promo-outlets";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
  type Tx,
} from "./permission-resolver";

type CreatePromotionInput = z.output<typeof createPromotionInputSchema>;
type UpdatePromotionInput = z.output<typeof updatePromotionInputSchema>;
type IssueVoucherInput = z.output<typeof issueVoucherInputSchema>;
type ListPromotionsQuery = z.output<typeof listPromotionsQuerySchema>;
type ListVouchersQuery = z.output<typeof listVouchersQuerySchema>;
type EvaluationRequest = z.output<typeof promoEvaluationRequestSchema>;
type VoucherValidationInput = z.output<typeof voucherValidationInputSchema>;
type StackingPolicyInput = z.output<
  typeof updatePromoStackingPolicyInputSchema
>;
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

/** Promotion administration is marketing (§3.7 role matrix: Marketing/CRM). */
const MANAGE_PERMISSION: PermissionCode = "promo.manage";
/** A checkout preview is part of taking an order at the outlet. */
const CHECKOUT_PERMISSION: PermissionCode = "order.create";
/** Codes customers type: no 0/O or 1/I so they read back unambiguously. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;

// -------------------------------------------------------------- helpers

/** Service-layer authorization (TEN-03), in the tenant transaction. */
async function assertPermission(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permission: PermissionCode,
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
  if (!snapshot.allows(permission, target))
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Your account cannot perform this action in this tenant.",
    );
}

/** PostgreSQL unique violation, directly or wrapped by drizzle's cause chain. */
function uniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || uniqueViolation(candidate.cause, depth + 1)
  );
}

function cursorKeys(cursor: string): [string, string] {
  let keys;
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  }
  const [at, id] = keys;
  if (typeof at !== "string" || typeof id !== "string")
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  return [at, id];
}

async function lockPromotion(
  tx: Tx,
  context: ScopedTenantContext,
  promotionId: string,
): Promise<PromotionRow> {
  const [row] = await tx
    .select()
    .from(promotions)
    .where(
      and(
        eq(promotions.tenantId, context.tenant.tenantId),
        eq(promotions.id, promotionId),
      ),
    )
    .limit(1)
    .for("update");
  if (!row) throw new HttpError(404, "NOT_FOUND", "Promo tidak ditemukan.");
  return row;
}

/**
 * Contract refinements (promotionSchema) plus rule coherence the DSL cannot
 * express: a "buy X get Y" needs the X condition, otherwise it never applies.
 */
function validatePromotion(candidate: Promotion): Promotion {
  const parsed = promotionSchema.safeParse(candidate);
  if (!parsed.success)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Periksa aturan promo.",
    );
  const promotion = parsed.data;
  if (
    promotion.benefit.kind === "free_items" &&
    !promotion.conditions.some(
      (condition) => condition.kind === "item_quantity",
    )
  )
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Promo beli X gratis Y memerlukan syarat jumlah item.",
    );
  return promotion;
}

/** A promo code may not collide with a single-use voucher code. */
async function assertCodeFree(
  tx: Tx,
  context: ScopedTenantContext,
  codeHash: string,
): Promise<void> {
  const [voucher] = await tx
    .select({ id: vouchers.id })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.tenantId, context.tenant.tenantId),
        eq(vouchers.codeHash, codeHash),
      ),
    )
    .limit(1);
  if (voucher)
    throw new HttpError(409, "PROMO_CODE_TAKEN", "Kode promo sudah dipakai.");
}

/** Lifecycle: an ended promotion is final (its ROI period is closed). */
function assertStatusChange(from: PromotionStatus, to: PromotionStatus) {
  if (from === "ended" && to !== "ended")
    throw new HttpError(
      409,
      "PROMO_ENDED",
      "Promo yang sudah berakhir tidak dapat diaktifkan lagi.",
    );
}

function auditEntry(
  context: ScopedTenantContext,
  actor: string,
  now: Date,
  entry: {
    action: string;
    objectType: string;
    objectId: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  },
) {
  return {
    id: createUlid(now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: null,
    actorType: "user" as const,
    actorId: actor,
    deviceId: null,
    action: entry.action,
    objectType: entry.objectType,
    objectId: entry.objectId,
    reason: null,
    maskedChanges: promoAuditChanges(entry.before, entry.after),
    ipHash: null,
    sensitiveAccess: false,
    retentionClass: "audit_2y" as const,
    createdAt: now.toISOString(),
  };
}

/** Audit view of a promotion: the rule, never the code digest. */
function auditView(promotion: Promotion): Record<string, unknown> {
  const { codeHash, ...rest } = promotion;
  return { ...rest, hasCode: codeHash !== null };
}

// ----------------------------------------------------------- promotions

export async function listPromotions(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListPromotionsQuery,
): Promise<Page<Promotion>> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, MANAGE_PERMISSION, {
      type: "tenant",
    });
    const filters: SQL[] = [eq(promotions.tenantId, context.tenant.tenantId)];
    if (query.status) filters.push(eq(promotions.status, query.status));
    if (query.cursor) {
      const [at, id] = cursorKeys(query.cursor);
      filters.push(
        or(
          lt(promotions.createdAt, new Date(at)),
          and(eq(promotions.createdAt, new Date(at)), lt(promotions.id, id)),
        ) as SQL,
      );
    }
    const rows = await tx
      .select()
      .from(promotions)
      .where(and(...filters))
      .orderBy(desc(promotions.createdAt), desc(promotions.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toPromotion),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.createdAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

/** 1269 F0: a promotion whose reward is a closed shower may be saved but not be active. */
async function assertNoShowerPromoActive(
  tx: Tx,
  context: ScopedTenantContext,
  promotion: Pick<Promotion, "status" | "benefit">,
): Promise<void> {
  if (
    promotion.status === "active" &&
    promotion.benefit.kind === "facility_entitlement"
  )
    await assertFacilityProductOpen(
      tx,
      context.tenant.tenantId,
      promotion.benefit.facilityProductId,
    );
}

export async function createPromotion(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreatePromotionInput,
  now = new Date(),
  idempotencyKey: string | null = null,
  aiActionRequestId: string | null = null,
): Promise<Promotion> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actor, MANAGE_PERMISSION, {
      type: "tenant",
    });
    // legend-nloi: same key + same body replays the first promotion.
    return promoIdempotentCommand(
      tx,
      context,
      { key: idempotencyKey, operation: "promotion.create", request: input },
      () => insertPromotion(tx, context, actor, input, now, aiActionRequestId),
    );
  });
}

async function insertPromotion(
  tx: Tx,
  context: ScopedTenantContext,
  actor: UserId,
  input: CreatePromotionInput,
  now: Date,
  aiActionRequestId: string | null = null,
): Promise<Promotion> {
  {
    const id = crypto.randomUUID();
    const promotion = validatePromotion({
      ...input,
      id,
      tenantId: context.tenant.tenantId,
      spentIdr: idr(0),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    await assertNoShowerPromoActive(tx, context, promotion);
    await assertPromoBenefitNotWfc(
      tx,
      context.tenant.tenantId,
      promotion.benefit,
    );
    if (promotion.codeHash !== null)
      await assertCodeFree(tx, context, promotion.codeHash);
    let row: PromotionRow | undefined;
    try {
      [row] = await tx
        .insert(promotions)
        .values({
          id,
          tenantId: context.tenant.tenantId,
          name: promotion.name,
          description: promotion.description,
          status: promotion.status,
          codeHash: promotion.codeHash,
          voucherRequired: promotion.voucherRequired,
          startsAt: new Date(promotion.startsAt),
          endsAt: promotion.endsAt === null ? null : new Date(promotion.endsAt),
          conditions: promotion.conditions,
          benefit: promotion.benefit,
          stackGroup: promotion.stackGroup,
          stackable: promotion.stackable,
          priority: promotion.priority,
          quotaTotal: promotion.quotaTotal,
          quotaPerCustomer: promotion.quotaPerCustomer,
          budgetIdr: promotion.budgetIdr,
          outletScope: promotion.outletScope ?? "all_except",
          aiActionRequestId,
          createdBy: actor,
          updatedBy: actor,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    } catch (error) {
      if (uniqueViolation(error))
        throw new HttpError(
          409,
          "PROMO_CODE_TAKEN",
          "Kode promo sudah dipakai.",
        );
      throw error;
    }
    if (!row) throw new Error("Promotion insert returned no row");
    const created = toPromotion(row);
    await appendPromoEvent(tx, context, "promotion.updated", {
      aggregateId: created.id,
      aggregateUuid: created.id,
      outletId: null,
      actorUserId: actor,
      idempotencyKey: `promotion.updated:${created.id}:${now.getTime()}`,
      now,
      payload: { change: "created", promotion: created },
    });
    await recordAudit(
      tx,
      context,
      auditEntry(context, actor, now, {
        action: "promotion.created",
        objectType: "promotion",
        objectId: created.id,
        before: null,
        after: auditView(created),
      }),
      PROMO_AUDIT_SAFE_FIELDS,
    );
    return created;
  }
}

export async function updatePromotion(
  context: ScopedTenantContext,
  actorUserId: string,
  promotionId: string,
  input: UpdatePromotionInput,
  now = new Date(),
): Promise<Promotion> {
  const actor = userIdSchema.parse(actorUserId);
  if (Object.keys(input).length === 0)
    throw new HttpError(422, "VALIDATION_ERROR", "Tidak ada perubahan.");
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actor, MANAGE_PERMISSION, {
      type: "tenant",
    });
    // Locked: a concurrent redemption cannot move the counters while the
    // caps are checked against them.
    const row = await lockPromotion(tx, context, promotionId);
    const current = toPromotion(row);
    const next = validatePromotion({
      ...current,
      ...input,
      updatedAt: now.toISOString(),
    });
    assertStatusChange(current.status, next.status);
    await assertNoShowerPromoActive(tx, context, next);
    // A promotion saved before its product became WFC may still be switched off.
    if (
      next.status === "active" ||
      !isDeepStrictEqual(next.benefit, current.benefit)
    )
      await assertPromoBenefitNotWfc(tx, context.tenant.tenantId, next.benefit);
    if (next.quotaTotal !== null && next.quotaTotal < row.usesTotal)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Kuota tidak boleh di bawah jumlah pemakaian.",
      );
    if (next.budgetIdr !== null && next.budgetIdr < row.spentIdr)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Anggaran tidak boleh di bawah biaya yang sudah terpakai.",
      );
    if (next.codeHash !== null && next.codeHash !== current.codeHash)
      await assertCodeFree(tx, context, next.codeHash);
    let updated: PromotionRow | undefined;
    try {
      [updated] = await tx
        .update(promotions)
        .set({
          name: next.name,
          description: next.description,
          status: next.status,
          codeHash: next.codeHash,
          voucherRequired: next.voucherRequired,
          startsAt: new Date(next.startsAt),
          endsAt: next.endsAt === null ? null : new Date(next.endsAt),
          conditions: next.conditions,
          benefit: next.benefit,
          stackGroup: next.stackGroup,
          stackable: next.stackable,
          priority: next.priority,
          quotaTotal: next.quotaTotal,
          quotaPerCustomer: next.quotaPerCustomer,
          budgetIdr: next.budgetIdr,
          outletScope: next.outletScope,
          updatedBy: actor,
          updatedAt: now,
        })
        .where(
          and(
            eq(promotions.tenantId, context.tenant.tenantId),
            eq(promotions.id, row.id),
          ),
        )
        .returning();
    } catch (error) {
      if (uniqueViolation(error))
        throw new HttpError(
          409,
          "PROMO_CODE_TAKEN",
          "Kode promo sudah dipakai.",
        );
      throw error;
    }
    if (!updated)
      throw new HttpError(404, "NOT_FOUND", "Promo tidak ditemukan.");
    const result = toPromotion(updated);
    await appendPromoEvent(tx, context, "promotion.updated", {
      aggregateId: result.id,
      aggregateUuid: result.id,
      outletId: null,
      actorUserId: actor,
      idempotencyKey: `promotion.updated:${result.id}:${now.getTime()}`,
      now,
      payload: { change: "updated", promotion: result },
    });
    await recordAudit(
      tx,
      context,
      auditEntry(context, actor, now, {
        action: "promotion.updated",
        objectType: "promotion",
        objectId: result.id,
        before: auditView(current),
        after: auditView(result),
      }),
      PROMO_AUDIT_SAFE_FIELDS,
    );
    return result;
  });
}

// ------------------------------------------------------ stacking policy

export async function getStackingPolicy(
  context: ScopedTenantContext,
  actorUserId: string,
): Promise<PromoStackingPolicy> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, MANAGE_PERMISSION, {
      type: "tenant",
    });
    return loadStackingPolicy(tx, context);
  });
}

export async function updateStackingPolicy(
  context: ScopedTenantContext,
  actorUserId: string,
  input: StackingPolicyInput,
  now = new Date(),
): Promise<PromoStackingPolicy> {
  const actor = userIdSchema.parse(actorUserId);
  const policy: PromoStackingPolicy = {
    mode: input.mode,
    maxStacked: input.maxStacked,
    allowSameGroup: input.allowSameGroup,
  };
  if (policy.mode === "exclusive" && policy.maxStacked !== 1)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Mode eksklusif hanya memakai satu promo.",
    );
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actor, MANAGE_PERMISSION, {
      type: "tenant",
    });
    const before = await loadStackingPolicy(tx, context);
    await tx
      .insert(promoSettings)
      .values({
        tenantId: context.tenant.tenantId,
        stackingPolicy: policy,
        updatedBy: actor,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: promoSettings.tenantId,
        set: { stackingPolicy: policy, updatedBy: actor, updatedAt: now },
      });
    await recordAudit(
      tx,
      context,
      auditEntry(context, actor, now, {
        action: "promo_settings.updated",
        objectType: "promo_settings",
        objectId: context.tenant.tenantId,
        before: { ...before },
        after: { ...policy },
      }),
      PROMO_AUDIT_SAFE_FIELDS,
    );
    return policy;
  });
}

// ------------------------------------------------------ checkout preview

/**
 * Staff checkout preview (POS cashier, waiter): prices come from the outlet's
 * channel price list (ORD-03), the time from the server clock in the outlet
 * zone, no member context (the order service passes its own customer to the
 * engine ports). A presented code that is invalid is refused (422).
 * No tax context here: `min_spend` compares the server-priced bill as given
 * (no `minSpendSubtotalIdr`). The QR order service passes the pre-tax basis
 * itself at inclusive outlets (Q53, bead legend-u5tkd).
 */
export async function evaluateCheckoutPromotions(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: string,
  request: EvaluationRequest,
  now = new Date(),
): Promise<PromotionApplicationResult> {
  const outletKey = outletIdSchema.parse(outletId);
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, CHECKOUT_PERMISSION, {
      type: "outlet",
      id: outletKey,
    });
    const outlet = await requirePromoOutlet(tx, context, outletKey);
    const lines = await priceRequestLines(
      tx,
      context,
      outlet,
      request.channel,
      request.lines,
      now,
    );
    return quotePromotions(tx, context, {
      outletId: outletKey,
      channel: request.channel,
      lines,
      customer: null,
      voucherCode: request.voucherCode,
      at: now,
    });
  });
}

/** Evaluator reason -> voucher reason the checkout shows. */
function voucherReasonOf(reason: PromoRejectionReason): VoucherRejectionReason {
  switch (reason) {
    case "not_started":
      return "not_started";
    case "ended":
      return "expired";
    case "min_spend_not_met":
      return "min_spend_not_met";
    case "channel_mismatch":
      return "channel_not_allowed";
    case "quota_exhausted":
    case "budget_exhausted":
      return "quota_exhausted";
    case "member_only":
    case "tier_mismatch":
      return "customer_mismatch";
    default:
      return "not_applicable";
  }
}

/**
 * Voucher preview (contract: `subtotalIdr` is a preview only; the discount
 * applied is recomputed from the server-priced bill when the order posts).
 * Without the cart's lines, item conditions (buy X, bundle) cannot be checked
 * here, so they are skipped and an item benefit previews Rp0.
 */
export async function validateVoucherCode(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: string,
  input: VoucherValidationInput,
  now = new Date(),
): Promise<VoucherValidationResult> {
  const outletKey = outletIdSchema.parse(outletId);
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, CHECKOUT_PERMISSION, {
      type: "outlet",
      id: outletKey,
    });
    const outlet = await requirePromoOutlet(tx, context, outletKey);
    const resolved = await resolveCode(tx, context, input.code, false);
    if (resolved === null) return { valid: false, reason: "not_found" };
    let voucherId: string | null = null;
    let promotion: Promotion | null;
    if (resolved.kind === "voucher") {
      const voucher = toVoucher(resolved.voucher);
      const rejection = voucherUsability(voucher, {
        customerProfileId: null,
        at: now.toISOString(),
      });
      if (rejection !== null) return { valid: false, reason: rejection };
      voucherId = voucher.id;
      promotion = resolved.promotion;
      if (promotion === null) {
        // Value voucher: worth its value, capped at the bill.
        const value = resolved.voucher.valueIdr ?? 0;
        return {
          valid: true,
          voucherId,
          promotionId: null,
          discountPreviewIdr: idr(Math.min(value, input.subtotalIdr)),
        };
      }
    } else {
      promotion = resolved.promotion;
    }
    // legend-e5it: a promotion switched off at this outlet does not apply.
    if (await promotionDisabledAtOutlet(tx, context, promotion.id, outletKey))
      return { valid: false, reason: "not_applicable" };
    const usage = {
      promotionId: promotion.id,
      totalUses: 0,
      customerUses: 0,
    };
    const [counters] = await tx
      .select({ uses: promotions.usesTotal })
      .from(promotions)
      .where(
        and(
          eq(promotions.tenantId, context.tenant.tenantId),
          eq(promotions.id, promotion.id),
        ),
      )
      .limit(1);
    usage.totalUses = counters?.uses ?? 0;
    const { localDayOfWeek, localTime } = outletLocalClock(
      now,
      outlet.timezone,
    );
    const preview = evaluatePromotion(
      {
        ...promotion,
        conditions: promotion.conditions.filter(
          (condition) =>
            condition.kind !== "item_quantity" && condition.kind !== "bundle",
        ),
        // Per-customer limits are checked at checkout with the member context.
        quotaPerCustomer: null,
      },
      {
        at: now.toISOString(),
        channel: input.channel,
        localDayOfWeek,
        localTime,
        subtotalIdr: input.subtotalIdr,
        lines: [
          {
            menuItemId: promotion.id,
            quantity: 1,
            unitPriceIdr: input.subtotalIdr,
            lineTotalIdr: input.subtotalIdr,
          },
        ],
        customer: null,
        voucherPromotionId: promotion.id,
      },
      usage,
    );
    // A multi-use promo code has no voucher row: its promotion id names it.
    if (preview.applied)
      return {
        valid: true,
        voucherId: voucherId ?? promotion.id,
        promotionId: promotion.id,
        discountPreviewIdr: preview.discountIdr,
      };
    if (preview.reason === "no_matching_items")
      return {
        valid: true,
        voucherId: voucherId ?? promotion.id,
        promotionId: promotion.id,
        discountPreviewIdr: idr(0),
      };
    return { valid: false, reason: voucherReasonOf(preview.reason) };
  });
}

// --------------------------------------------------------------- vouchers

function newVoucherCode(): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1)
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/**
 * Issues a single-use voucher. The plain code is returned once and never
 * stored (only its SHA-256 digest). A voucher needs a promotion or a value.
 */
export async function issueVoucher(
  context: ScopedTenantContext,
  actorUserId: string,
  input: IssueVoucherInput,
  now = new Date(),
  idempotencyKey: string | null = null,
): Promise<VoucherIssued> {
  const actor = userIdSchema.parse(actorUserId);
  // legend-xzr10: only reward redemption and missions mint loyalty_reward
  // vouchers (they insert directly); staff cannot forge one.
  if (input.source === "loyalty_reward")
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Sumber voucher loyalty_reward hanya dibuat otomatis oleh sistem.",
    );
  if (input.promotionId === null && (input.valueIdr ?? 0) <= 0)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Voucher memerlukan promo atau nilai.",
    );
  if (
    input.validUntil !== null &&
    Date.parse(input.validUntil) <= Date.parse(input.validFrom)
  )
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Masa berlaku harus berakhir setelah dimulai.",
    );
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actor, MANAGE_PERMISSION, {
      type: "tenant",
    });
    // legend-nloi: same key + same body replays the first voucher. Its one-time
    // plain code is stored sealed, never in the clear.
    const aad = `promo-voucher-idem:${context.tenant.tenantId}:${idempotencyKey}`;
    return promoIdempotentCommand<VoucherIssued>(
      tx,
      context,
      {
        key: idempotencyKey,
        operation: "voucher.issue",
        request: input,
        encode: (issued) => ({
          voucher: issued.voucher,
          code: sealSecret(issued.code, aad),
        }),
        decode: (stored) => {
          const { voucher, code } = stored as {
            voucher: VoucherDto;
            code: string;
          };
          return { voucher, code: openSecret(code, aad) } as VoucherIssued;
        },
      },
      () => mintVoucher(tx, context, actor, input, now),
    );
  });
}

async function mintVoucher(
  tx: Tx,
  context: ScopedTenantContext,
  actor: UserId,
  input: IssueVoucherInput,
  now: Date,
): Promise<VoucherIssued> {
  {
    if (input.promotionId !== null) {
      const [promotion] = await tx
        .select({ id: promotions.id, status: promotions.status })
        .from(promotions)
        .where(
          and(
            eq(promotions.tenantId, context.tenant.tenantId),
            eq(promotions.id, input.promotionId),
          ),
        )
        .limit(1);
      if (!promotion)
        throw new HttpError(404, "NOT_FOUND", "Promo tidak ditemukan.");
      if (promotion.status === "ended")
        throw new HttpError(409, "PROMO_ENDED", "Promo sudah berakhir.");
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = newVoucherCode();
      const codeHash = hashPromoCode(code);
      const [promoCode] = await tx
        .select({ id: promotions.id })
        .from(promotions)
        .where(
          and(
            eq(promotions.tenantId, context.tenant.tenantId),
            eq(promotions.codeHash, codeHash),
          ),
        )
        .limit(1);
      if (promoCode) continue;
      // A savepoint keeps a code collision from aborting the transaction.
      const inserted = await tx
        .transaction(async (savepoint) =>
          savepoint
            .insert(vouchers)
            .values({
              tenantId: context.tenant.tenantId,
              promotionId: input.promotionId,
              customerProfileId: input.customerProfileId,
              codeHash,
              source: input.source,
              valueIdr: input.valueIdr,
              validFrom: new Date(input.validFrom),
              validUntil:
                input.validUntil === null ? null : new Date(input.validUntil),
              issuedAt: now,
              issuedBy: actor,
            })
            .returning(),
        )
        .catch((error: unknown) => {
          if (uniqueViolation(error)) return null;
          // legend-m4p5: vouchers_profile_fk (0207) refuses an unknown profile.
          const pg = error as {
            code?: string;
            constraint?: string;
            cause?: { code?: string; constraint?: string };
          };
          const fk = pg.cause ?? pg;
          if (fk.code === "23503" && fk.constraint === "vouchers_profile_fk")
            throw new HttpError(
              404,
              "CUSTOMER_NOT_FOUND",
              "Pelanggan tidak ditemukan.",
            );
          throw error;
        });
      const row = inserted?.[0];
      if (!row) continue;
      const voucher = voucherDtoSchema.parse(dto(row));
      await appendPromoEvent(tx, context, "voucher.issued", {
        aggregateId: row.id,
        aggregateUuid: row.id,
        outletId: null,
        actorUserId: actor,
        idempotencyKey: `voucher.issued:${row.id}`,
        now,
        payload: {
          voucherId: row.id,
          promotionId: row.promotionId,
          customerProfileId: row.customerProfileId,
          source: row.source,
          valueIdr: row.valueIdr,
          validFrom: voucher.validFrom,
          validUntil: voucher.validUntil,
        },
      });
      await recordAudit(
        tx,
        context,
        auditEntry(context, actor, now, {
          action: "voucher.issued",
          objectType: "voucher",
          objectId: row.id,
          before: null,
          after: {
            promotionId: row.promotionId,
            source: row.source,
            valueIdr: row.valueIdr,
            validFrom: voucher.validFrom,
            validUntil: voucher.validUntil,
          },
        }),
        PROMO_AUDIT_SAFE_FIELDS,
      );
      return { voucher, code };
    }
    throw new HttpError(
      503,
      "VOUCHER_CODE_UNAVAILABLE",
      "Kode voucher belum dapat dibuat. Coba lagi.",
    );
  }
}

function dto(row: typeof vouchers.$inferSelect): VoucherDto {
  const { codeHash, ...rest } = toVoucher(row);
  void codeHash;
  return rest;
}

export async function listVouchers(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListVouchersQuery,
): Promise<Page<VoucherDto>> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, MANAGE_PERMISSION, {
      type: "tenant",
    });
    const filters: SQL[] = [eq(vouchers.tenantId, context.tenant.tenantId)];
    if (query.status) filters.push(eq(vouchers.status, query.status));
    if (query.customerProfileId)
      filters.push(eq(vouchers.customerProfileId, query.customerProfileId));
    if (query.cursor) {
      const [at, id] = cursorKeys(query.cursor);
      filters.push(
        or(
          lt(vouchers.issuedAt, new Date(at)),
          and(eq(vouchers.issuedAt, new Date(at)), lt(vouchers.id, id)),
        ) as SQL,
      );
    }
    const rows = await tx
      .select()
      .from(vouchers)
      .where(and(...filters))
      .orderBy(desc(vouchers.issuedAt), desc(vouchers.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => voucherDtoSchema.parse(dto(row))),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.issuedAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

// -------------------------------------------------------------------- ROI

/**
 * ROI Promo (PRD §3.21): transactions = orders that kept the promotion,
 * discount cost = the discount it gave, revenue = those orders' net sales
 * (server-priced subtotal minus refunded value minus every promo discount on
 * the order, before tax and service charge), net margin = revenue - discount
 * cost (contract definition; COGS-based margin belongs to WS-11 reporting),
 * ROI = net margin / discount cost in basis points, rounded half up, null
 * without a cost. Released (voided) applications are excluded, and a partial
 * refund removes the refunded goods from revenue (owner Q41).
 */
export async function getPromotionRoi(
  context: ScopedTenantContext,
  actorUserId: string,
  promotionId: string,
): Promise<PromotionRoi> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, MANAGE_PERMISSION, {
      type: "tenant",
    });
    const [promotion] = await tx
      .select({ id: promotions.id })
      .from(promotions)
      .where(
        and(
          eq(promotions.tenantId, context.tenant.tenantId),
          eq(promotions.id, promotionId),
        ),
      )
      .limit(1);
    if (!promotion)
      throw new HttpError(404, "NOT_FOUND", "Promo tidak ditemukan.");
    const [row] = await tx
      .select({
        transactions: sql<string>`count(distinct ${promotionRedemptions.orderId})`,
        discount: sql<string>`coalesce(sum(${promotionRedemptions.discountIdr}), 0)`,
        revenue: sql<string>`coalesce(sum(${promotionOrderApplications.subtotalIdr} - ${promotionOrderApplications.refundedSubtotalIdr} - ${promotionOrderApplications.totalDiscountIdr}), 0)`,
      })
      .from(promotionRedemptions)
      .innerJoin(
        promotionOrderApplications,
        and(
          eq(
            promotionOrderApplications.tenantId,
            promotionRedemptions.tenantId,
          ),
          eq(promotionOrderApplications.orderId, promotionRedemptions.orderId),
        ),
      )
      .where(
        and(
          eq(promotionRedemptions.tenantId, context.tenant.tenantId),
          eq(promotionRedemptions.promotionId, promotion.id),
          eq(promotionRedemptions.status, "applied"),
        ),
      );
    const discount = BigInt(row?.discount ?? "0");
    const revenue = BigInt(row?.revenue ?? "0");
    const margin = revenue - discount;
    let roiBp: number | null = null;
    if (discount > 0n) {
      // Half-up division on exact integers (no float), sign-aware.
      const scaled = margin * 10_000n;
      const quotient = scaled / discount;
      const remainder = scaled % discount;
      const twice = (remainder < 0n ? -remainder : remainder) * 2n;
      const rounded =
        twice >= discount ? quotient + (scaled < 0n ? -1n : 1n) : quotient;
      roiBp = Number(rounded);
    }
    const asIdr = (value: bigint) => {
      if (
        value > BigInt(Number.MAX_SAFE_INTEGER) ||
        value < BigInt(Number.MIN_SAFE_INTEGER)
      )
        throw new RangeError("Rupiah amount exceeds the safe integer range");
      return idr(Number(value));
    };
    return {
      promotionId: promotion.id,
      transactions: Number(row?.transactions ?? "0"),
      discountCostIdr: asIdr(discount),
      revenueIdr: asIdr(revenue),
      netMarginIdr: asIdr(margin),
      roiBp,
    };
  });
}
