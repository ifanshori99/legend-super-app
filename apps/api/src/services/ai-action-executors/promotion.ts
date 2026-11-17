// TL-15 executor: create an active promotion through `createPromotion`
// (promo.manage re-checked by the service for the requester). Promotions are
// tenant-wide records; the outlet list is applied afterwards by switching the
// promotion off at every other outlet (`setPromotionOutlet`). A `menuItemIds`
// list becomes an `item_quantity` condition (at least one of those items).
//
// The promotion is created as a draft, its outlets are applied, and only then
// is it activated, so it never trades at an outlet the request did not name.
// If anything after the create fails, the draft is ended (compensation) before
// the error reaches the caller, because these services commit on their own and
// the request's savepoint cannot roll them back.
//
// Idempotency (crash between the service commit and the status commit): the
// promotion row carries `ai_action_request_id` = the action request id, under
// a partial unique index (tenant_id, ai_action_request_id). A re-run finds the
// promotion by that column instead of creating a second one, then finishes the
// outlet switches and the activation (each is idempotent). Two runs racing past
// the lookup hit the unique index; the loser re-reads the winner's row.
// Rows made before the column existed were backfilled from the old description
// marker `[ai:<id>]` (migration 0495); new promotions carry no marker.
import {
  createPromotionInputSchema,
  type PromotionBenefit,
} from "@starter/shared/crm";
import { parseDecimal4 } from "@starter/shared/core";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { promotions } from "../../db/schema/index.ts";
import { withTenant } from "../../db/tenant.ts";
import { draftPromotionInputSchema } from "@starter/shared/ai";
import { createPromotion, updatePromotion } from "../crm-promo.service.ts";
import {
  listPromotionOutlets,
  setPromotionOutlet,
} from "../crm-promo-outlets.service.ts";
import { HttpError } from "../../lib/http-error.ts";
import { ActionExecutionError, type ActionExecutor } from "./types.ts";

export const executePromotion: ActionExecutor = async ({
  access,
  row,
  now,
}) => {
  const payload = draftPromotionInputSchema.parse(row.payload);
  const context = access.contextFor("promo.manage", { type: "tenant" });
  if (!context)
    throw new ActionExecutionError("Pengaju tidak lagi boleh mengelola promo.");
  const benefit: PromotionBenefit =
    payload.discount.kind === "percent"
      ? {
          kind: "percent_off",
          // Decimal4 percent (x10000) to basis points (x100).
          percentBp: Number(parseDecimal4(payload.discount.percent) / 100n),
          maxDiscountIdr: null,
        }
      : { kind: "nominal_off", amountIdr: payload.discount.amountIdr };
  const description = (payload.description ?? "").slice(0, 1000);
  const input = createPromotionInputSchema.parse({
    name: payload.name,
    description,
    status: "draft",
    codeHash: null,
    voucherRequired: false,
    startsAt: payload.startsAt,
    endsAt: payload.endsAt,
    conditions: payload.menuItemIds
      ? [
          {
            kind: "item_quantity",
            menuItemIds: payload.menuItemIds,
            minQuantity: 1,
          },
        ]
      : [],
    benefit,
    stackGroup: "ai_promo",
    stackable: true,
    priority: 0,
    quotaTotal: null,
    quotaPerCustomer: null,
    budgetIdr: null,
  });
  const findExisting = async () => {
    const [found] = await withTenant(db, context, (tx) =>
      tx
        .select({ id: promotions.id, status: promotions.status })
        .from(promotions)
        .where(
          and(
            eq(promotions.tenantId, row.tenantId),
            eq(promotions.aiActionRequestId, row.id),
          ),
        )
        .limit(1),
    );
    return found;
  };
  const existing = await findExisting();
  let promotion = existing;
  if (!promotion) {
    try {
      promotion = await createPromotion(
        context,
        row.requestedByUserId,
        input,
        now,
        null,
        row.id,
      );
    } catch (error) {
      // The unique index fired: a concurrent run created the promotion first.
      // These promotions have no code hash, so PROMO_CODE_TAKEN can only mean
      // that index; anything else (or no row to reuse) is a real failure.
      const raced =
        error instanceof HttpError && error.code === "PROMO_CODE_TAKEN"
          ? await findExisting()
          : undefined;
      if (!raced) throw error;
      promotion = raced;
    }
  }
  try {
    const wanted = new Set(payload.outletIds.map((id) => id.toLowerCase()));
    const outlets = await listPromotionOutlets(
      context,
      row.requestedByUserId,
      promotion.id,
    );
    for (const outlet of outlets) {
      if (wanted.has(outlet.outletId.toLowerCase()) || !outlet.enabled)
        continue;
      await setPromotionOutlet(
        context,
        row.requestedByUserId,
        promotion.id,
        outlet.outletId,
        { enabled: false },
        now,
      );
    }
    if (promotion.status !== "active")
      await updatePromotion(
        context,
        row.requestedByUserId,
        promotion.id,
        { status: "active" },
        now,
      );
  } catch (error) {
    // Never leave a half-configured promotion able to be activated later.
    await updatePromotion(
      context,
      row.requestedByUserId,
      promotion.id,
      { status: "ended" },
      now,
    ).catch(() => undefined);
    throw error;
  }
  return { resultRef: `promotion:${promotion.id}` };
};
