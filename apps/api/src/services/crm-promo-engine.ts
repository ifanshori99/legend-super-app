// Promo engine DB adapter, shared by POS, QR order and the website (PRD v1.7
// §3.21 "Promo Engine": "Engine yang sama dipakai POS, QR order, dan website";
// LOY-03; ORD-03; bead legend-7x4g).
//
// Pure core + DB adapter: every price decision is the shared pure evaluator
// (`applyPromotions` in @starter/shared/crm); this module only loads its
// inputs under the tenant transaction and persists what an order consumed.
//
// The ports below take the caller's tenant transaction (`withTenant`), so the
// checkout that posts an order calls `redeemPromotions` in the SAME
// transaction: the order and its quota/budget/voucher consumption commit or
// roll back together.
//
// Race safety (LOY-03, "quota/budget caps race-safe"):
// - an advisory lock per (tenant, order) serializes redeem/release of one order;
// - candidate promotions are locked FOR UPDATE in id order (one global order,
//   so two checkouts can never deadlock on each other), then re-evaluated with
//   the locked counters, so the second of two concurrent redemptions sees the
//   first one's use;
// - the counter UPDATEs repeat the cap in their WHERE clause and the table
//   CHECKs repeat it again, so an over-redemption is impossible even if a
//   future caller skipped the lock;
// - a voucher flips issued -> redeemed with a guarded UPDATE under its row lock.
//
// Money: Idr whole rupiah; the evaluator rounds once per step (half up), and
// the total discount feeds the tax engine's `orderDiscountIdr` (calc order
// discount -> service charge -> tax, legend-559) — this module never computes
// tax or service charge itself.

import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  applyPromotions,
  crmErrorHttpStatus,
  crmErrorMessages,
  crmEvents,
  defaultPromoStackingPolicy,
  outletLocalClock,
  promoStackingPolicySchema,
  promotionApplicationResultSchema,
  promotionBenefitSchema,
  promotionConditionSchema,
  promotionSchema,
  voucherCodeInputSchema,
  voucherUsability,
  type CrmErrorCode,
  type PromoChannel,
  type PromoCustomer,
  type PromoEvaluationInput,
  type PromoLine,
  type PromoRejectionReason,
  type PromoRequestLine,
  type PromoStackingPolicy,
  type PromoUsage,
  type Promotion,
  type PromotionApplicationResult,
  type PromotionEvaluation,
  type Voucher,
} from "@starter/shared/crm";
import {
  assertTrustedScopedContext,
  businessDateOf,
  createUlid,
  idr,
  isOutletInScope,
  outletIdSchema,
  ulidIdSchema,
  ulidToUuid,
  userIdSchema,
  type Idr,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { MenuChannel } from "@starter/shared/menu";
import {
  domainEventOutbox,
  facilityRewards,
  outlets,
  priceListItems,
  priceLists,
  promoSettings,
  promotionCustomerUsage,
  promotionOrderApplications,
  promotionRedemptions,
  promotions,
  vouchers,
} from "../db/schema";
import { maskAuditChanges } from "@starter/shared/audit";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";
import { appendOutbox } from "./core-outbox";
import type { Tx } from "./permission-resolver";

export type PromotionRow = typeof promotions.$inferSelect;
export type VoucherRow = typeof vouchers.$inferSelect;
type OutletRow = typeof outlets.$inferSelect;

/** Edge nodes and WS-09 read promo events from the cloud-sync stream. */
export const PROMO_EVENT_DESTINATION = "cloud-sync";
/** Stack group of a value voucher (no promotion behind it). */
const VALUE_VOUCHER_GROUP = "value_voucher";

/**
 * Promo audit rows keep rule and money fields readable; every other value is
 * redacted by `maskAuditChanges`, and sensitive-named keys (e.g. a promotion
 * `name`) are always redacted (PRD §6 B audit masking).
 */
export const PROMO_AUDIT_SAFE_FIELDS: readonly string[] = [
  "id",
  "promotionId",
  "orderId",
  "outletId",
  "status",
  "change",
  "priority",
  "stackable",
  "stackGroup",
  "quotaTotal",
  "quotaPerCustomer",
  "budgetIdr",
  "spentIdr",
  "startsAt",
  "endsAt",
  "voucherRequired",
  "hasCode",
  "kind",
  "percentBp",
  "maxDiscountIdr",
  "amountIdr",
  "minQuantity",
  "quantity",
  "quantityPerMultiple",
  "bundlePriceIdr",
  "menuItemIds",
  "channels",
  "tierIds",
  "daysOfWeek",
  "start",
  "end",
  "facilityProductId",
  "source",
  "valueIdr",
  "validFrom",
  "validUntil",
  "mode",
  "maxStacked",
  "allowSameGroup",
  "totalDiscountIdr",
  "releasedDiscountIdr",
  "voucherIds",
  "facilityRewardIds",
  "reason",
];

export function promoAuditChanges(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
) {
  const mask = (value: Record<string, unknown> | null) =>
    value === null
      ? null
      : (maskAuditChanges(value, PROMO_AUDIT_SAFE_FIELDS) as Record<
          string,
          unknown
        >);
  return { before: mask(before), after: mask(after) };
}

export function crmHttpError(code: CrmErrorCode): HttpError {
  return new HttpError(crmErrorHttpStatus[code], code, crmErrorMessages[code]);
}

/** SHA-256 hex of the normalized code (contract: only digests are stored). */
export function hashPromoCode(code: string): string {
  const normalized = voucherCodeInputSchema.parse(code);
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

// ------------------------------------------------------------- row mapping

/** Row -> contract Promotion; jsonb is re-validated so a bad row fails closed. */
export function toPromotion(row: PromotionRow): Promotion {
  return promotionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description,
    status: row.status,
    codeHash: row.codeHash,
    voucherRequired: row.voucherRequired,
    startsAt: row.startsAt.toISOString(),
    endsAt: iso(row.endsAt),
    conditions: promotionConditionSchema.array().parse(row.conditions),
    benefit: promotionBenefitSchema.parse(row.benefit),
    stackGroup: row.stackGroup,
    stackable: row.stackable,
    priority: row.priority,
    quotaTotal: row.quotaTotal,
    quotaPerCustomer: row.quotaPerCustomer,
    budgetIdr: row.budgetIdr,
    spentIdr: row.spentIdr,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function toVoucher(row: VoucherRow): Voucher {
  return {
    id: row.id,
    tenantId: row.tenantId,
    promotionId: row.promotionId,
    customerProfileId: row.customerProfileId,
    codeHash: row.codeHash,
    source: row.source,
    status: row.status,
    valueIdr: row.valueIdr,
    validFrom: row.validFrom.toISOString(),
    validUntil: iso(row.validUntil),
    issuedAt: row.issuedAt.toISOString(),
    issuedBy: row.issuedBy,
    redeemedAt: iso(row.redeemedAt),
    redeemedOrderId: (row.redeemedOrderId ??
      null) as Voucher["redeemedOrderId"],
    cancelledReason: row.cancelledReason,
  } as Voucher;
}

/**
 * A value voucher (no promotion, `valueIdr` set: apology, birthday, manual)
 * runs through the same engine as a voucher-only nominal discount, so it obeys
 * the tenant stacking policy and never exceeds the bill. Its evaluation id is
 * the voucher id.
 */
function valueVoucherPromotion(voucher: VoucherRow): Promotion {
  if (voucher.valueIdr === null || voucher.valueIdr <= 0)
    throw new Error("A value voucher needs a positive valueIdr");
  return promotionSchema.parse({
    id: voucher.id,
    tenantId: voucher.tenantId,
    name: "Voucher",
    description: "",
    status: "active",
    codeHash: voucher.codeHash,
    voucherRequired: true,
    startsAt: voucher.validFrom.toISOString(),
    endsAt: iso(voucher.validUntil),
    conditions: [],
    benefit: { kind: "nominal_off", amountIdr: voucher.valueIdr },
    stackGroup: VALUE_VOUCHER_GROUP,
    stackable: true,
    priority: 0,
    quotaTotal: null,
    quotaPerCustomer: null,
    budgetIdr: null,
    spentIdr: 0,
    createdAt: voucher.issuedAt.toISOString(),
    updatedAt: voucher.issuedAt.toISOString(),
  });
}

// ------------------------------------------------------------ outlet + time

/** The outlet must exist in this tenant and be inside the caller's reach. */
export async function requirePromoOutlet(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<OutletRow> {
  const id = outletIdSchema.parse(outletId);
  const [row] = await tx
    .select()
    .from(outlets)
    .where(
      and(eq(outlets.id, id), eq(outlets.tenantId, context.tenant.tenantId)),
    )
    .limit(1);
  if (!row || !isOutletInScope(context.outletScope, row.id))
    throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
  return row;
}

/** Wall-clock offset (ms) of a time zone at an instant. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const value = (type: string) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? "0");
  const local = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );
  return local - Math.floor(instant / 1000) * 1000;
}

/**
 * First instant of the next business date in the outlet's zone. PRD §3.25
 * "Minimum belanja": the access voucher is valid until the end of the day's
 * operating hours; facility hours belong to WS-09, so the reward ends at the
 * end of the outlet business date and WS-09 narrows it to its own hours.
 */
export function endOfBusinessDay(at: Date, timeZone: string): Date {
  const today = businessDateOf(at, timeZone);
  const [year, month, day] = today.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const localMidnight = Date.UTC(year, month - 1, day + 1);
  // Two passes settle the offset even across a DST change.
  let guess = localMidnight - zoneOffsetMs(localMidnight, timeZone);
  guess = localMidnight - zoneOffsetMs(guess, timeZone);
  return new Date(guess);
}

// ---------------------------------------------------------------- pricing

/**
 * Price-list channel for a promo channel. Website orders use the outlet's
 * dine-in list, the same list the public menu page shows (guest-menu.service).
 */
function priceListChannel(channel: PromoChannel): MenuChannel {
  return channel === "website" ? "dine_in" : channel;
}

/**
 * ORD-03: prices always come from the server. Each request line is priced from
 * the outlet's channel price list in force on the outlet business date (the
 * item's plain price; variants/modifiers are priced by the order service,
 * which then passes its own PromoLine[] to the ports below).
 */
export async function priceRequestLines(
  tx: Tx,
  context: ScopedTenantContext,
  outlet: OutletRow,
  channel: PromoChannel,
  requestLines: readonly PromoRequestLine[],
  at: Date,
): Promise<PromoLine[]> {
  const today = businessDateOf(at, outlet.timezone);
  const [list] = await tx
    .select({ id: priceLists.id })
    .from(priceLists)
    .where(
      and(
        eq(priceLists.tenantId, context.tenant.tenantId),
        eq(priceLists.outletId, outlet.id),
        eq(priceLists.channel, priceListChannel(channel)),
        lte(priceLists.effectiveFrom, today),
        isNull(priceLists.deletedAt),
      ),
    )
    .orderBy(desc(priceLists.effectiveFrom), desc(priceLists.id))
    .limit(1);
  const itemIds = [...new Set(requestLines.map((line) => line.menuItemId))];
  const prices = new Map<string, Idr>();
  if (list && itemIds.length > 0) {
    const rows = await tx
      .select({
        itemId: priceListItems.itemId,
        priceIdr: priceListItems.priceIdr,
      })
      .from(priceListItems)
      .where(
        and(
          eq(priceListItems.tenantId, context.tenant.tenantId),
          eq(priceListItems.priceListId, list.id),
          inArray(priceListItems.itemId, itemIds),
          isNull(priceListItems.variantId),
          isNull(priceListItems.deletedAt),
        ),
      );
    for (const row of rows) prices.set(row.itemId, row.priceIdr);
  }
  return requestLines.map((line) => {
    const unit = prices.get(line.menuItemId);
    if (unit === undefined)
      throw new HttpError(
        422,
        "ITEM_NOT_PRICED",
        "Menu ini tidak dijual di kanal ini.",
      );
    const lineTotal = unit * line.quantity;
    if (!Number.isSafeInteger(lineTotal))
      throw new HttpError(422, "VALIDATION_ERROR", "Jumlah terlalu besar.");
    return {
      menuItemId: line.menuItemId,
      quantity: line.quantity,
      unitPriceIdr: unit,
      lineTotalIdr: idr(lineTotal),
    };
  });
}

// --------------------------------------------------------------- settings

export async function loadStackingPolicy(
  tx: Tx,
  context: ScopedTenantContext,
): Promise<PromoStackingPolicy> {
  const [row] = await tx
    .select({ policy: promoSettings.stackingPolicy })
    .from(promoSettings)
    .where(eq(promoSettings.tenantId, context.tenant.tenantId))
    .limit(1);
  return row
    ? promoStackingPolicySchema.parse(row.policy)
    : defaultPromoStackingPolicy;
}

// ---------------------------------------------------------- voucher codes

export type ResolvedCode =
  | { kind: "voucher"; voucher: VoucherRow; promotion: Promotion | null }
  | { kind: "promo_code"; promotion: Promotion };

/**
 * A typed code is first a single-use voucher, else a multi-use promo code
 * (`promotions.code_hash`). `lock` takes the voucher row lock (redeem path).
 */
export async function resolveCode(
  tx: Tx,
  context: ScopedTenantContext,
  code: string,
  lock: boolean,
): Promise<ResolvedCode | null> {
  const codeHash = hashPromoCode(code);
  const voucherQuery = tx
    .select()
    .from(vouchers)
    .where(
      and(
        eq(vouchers.tenantId, context.tenant.tenantId),
        eq(vouchers.codeHash, codeHash),
      ),
    )
    .limit(1);
  const [voucher] = lock
    ? await voucherQuery.for("update")
    : await voucherQuery;
  if (voucher) {
    let promotion: Promotion | null = null;
    if (voucher.promotionId !== null) {
      const [row] = await tx
        .select()
        .from(promotions)
        .where(
          and(
            eq(promotions.tenantId, context.tenant.tenantId),
            eq(promotions.id, voucher.promotionId),
          ),
        )
        .limit(1);
      if (!row) return null;
      promotion = toPromotion(row);
    }
    return { kind: "voucher", voucher, promotion };
  }
  const [row] = await tx
    .select()
    .from(promotions)
    .where(
      and(
        eq(promotions.tenantId, context.tenant.tenantId),
        eq(promotions.codeHash, codeHash),
      ),
    )
    .limit(1);
  return row ? { kind: "promo_code", promotion: toPromotion(row) } : null;
}

// ------------------------------------------------------------- evaluation

export type PromoCheckoutInput = {
  readonly outletId: OutletId;
  readonly channel: PromoChannel;
  /** Server-priced lines (priceRequestLines or the order service's pricing). */
  readonly lines: readonly PromoLine[];
  /** Server-derived member context; never taken from the client. */
  readonly customer: PromoCustomer | null;
  /** The code the customer typed, or null. */
  readonly voucherCode: string | null;
  /** Server instant. */
  readonly at: Date;
};

type Prepared = {
  input: PromoEvaluationInput;
  candidates: Promotion[];
  usage: PromoUsage[];
  policy: PromoStackingPolicy;
  /** The single-use voucher presented, if any. */
  voucher: VoucherRow | null;
  /** Evaluation id the voucher (or promo code) unlocks. */
  voucherEvaluationId: string | null;
};

/**
 * Loads everything the pure evaluator needs. With `lock`, the voucher, every
 * candidate promotion (id order) and the customer's usage rows are locked
 * FOR UPDATE, so the result stays true until the transaction commits.
 */
async function prepare(
  tx: Tx,
  context: ScopedTenantContext,
  checkout: PromoCheckoutInput,
  lock: boolean,
): Promise<Prepared> {
  assertTrustedScopedContext(context);
  const outlet = await requirePromoOutlet(tx, context, checkout.outletId);
  if (checkout.lines.length === 0)
    throw new HttpError(422, "VALIDATION_ERROR", "Keranjang kosong.");
  let subtotal = 0;
  for (const line of checkout.lines) subtotal += line.lineTotalIdr;
  if (!Number.isSafeInteger(subtotal))
    throw new HttpError(422, "VALIDATION_ERROR", "Jumlah terlalu besar.");

  let voucher: VoucherRow | null = null;
  let voucherEvaluationId: string | null = null;
  let codePromotion: Promotion | null = null;
  if (checkout.voucherCode !== null) {
    const resolved = await resolveCode(tx, context, checkout.voucherCode, lock);
    if (resolved === null) throw crmHttpError("VOUCHER_INVALID");
    if (resolved.kind === "voucher") {
      const rejection = voucherUsability(toVoucher(resolved.voucher), {
        customerProfileId: checkout.customer?.customerProfileId ?? null,
        at: checkout.at.toISOString(),
      });
      if (rejection !== null) throw crmHttpError("VOUCHER_INVALID");
      voucher = resolved.voucher;
      codePromotion =
        resolved.promotion ?? valueVoucherPromotion(resolved.voucher);
    } else {
      codePromotion = resolved.promotion;
    }
    voucherEvaluationId = codePromotion.id;
  }

  const at = checkout.at;
  const query = tx
    .select()
    .from(promotions)
    .where(
      and(
        eq(promotions.tenantId, context.tenant.tenantId),
        eq(promotions.status, "active"),
        lte(promotions.startsAt, at),
        sql`(${promotions.endsAt} IS NULL OR ${promotions.endsAt} > ${at.toISOString()})`,
        voucherEvaluationId === null
          ? eq(promotions.voucherRequired, false)
          : sql`(${promotions.voucherRequired} = false OR ${promotions.id} = ${voucherEvaluationId})`,
      ),
    )
    .orderBy(asc(promotions.id));
  const rows = lock ? await query.for("update") : await query;
  const candidates = rows.map(toPromotion);
  // A value voucher, or a code promotion that is not active right now, still
  // goes to the evaluator so the caller sees why it does not apply.
  if (
    codePromotion !== null &&
    !candidates.some((promotion) => promotion.id === codePromotion.id)
  )
    candidates.push(codePromotion);

  const customerId = checkout.customer?.customerProfileId ?? null;
  const customerUses = new Map<string, number>();
  const realIds = rows.map((row) => row.id);
  if (customerId !== null && realIds.length > 0) {
    const usageQuery = tx
      .select()
      .from(promotionCustomerUsage)
      .where(
        and(
          eq(promotionCustomerUsage.tenantId, context.tenant.tenantId),
          eq(promotionCustomerUsage.customerProfileId, customerId),
          inArray(promotionCustomerUsage.promotionId, realIds),
        ),
      )
      .orderBy(asc(promotionCustomerUsage.promotionId));
    const usageRows = lock ? await usageQuery.for("update") : await usageQuery;
    for (const row of usageRows) customerUses.set(row.promotionId, row.uses);
  }
  const usesById = new Map(rows.map((row) => [row.id, row.usesTotal]));
  const usage: PromoUsage[] = candidates.map((promotion) => ({
    promotionId: promotion.id,
    totalUses: usesById.get(promotion.id) ?? 0,
    customerUses: customerUses.get(promotion.id) ?? 0,
  }));

  const clock = outletLocalClock(at, outlet.timezone);
  const input: PromoEvaluationInput = {
    at: at.toISOString(),
    channel: checkout.channel,
    localDayOfWeek: clock.localDayOfWeek,
    localTime: clock.localTime,
    subtotalIdr: idr(subtotal),
    lines: [...checkout.lines],
    customer: checkout.customer,
    voucherPromotionId: voucherEvaluationId,
  };
  return {
    input,
    candidates,
    usage,
    policy: await loadStackingPolicy(tx, context),
    voucher,
    voucherEvaluationId,
  };
}

/** Read-only quote: what the bill would get now (no locks, no writes). */
export async function quotePromotions(
  tx: Tx,
  context: ScopedTenantContext,
  checkout: PromoCheckoutInput,
): Promise<PromotionApplicationResult> {
  const prepared = await prepare(tx, context, checkout, false);
  return applyPromotions(
    prepared.candidates,
    prepared.input,
    prepared.usage,
    prepared.policy,
  );
}

// ------------------------------------------------------------- redemption

type AppliedEvaluation = Extract<PromotionEvaluation, { applied: true }>;

function appliedOf(result: PromotionApplicationResult): AppliedEvaluation[] {
  return result.evaluations.filter(
    (evaluation): evaluation is AppliedEvaluation => evaluation.applied,
  );
}

/** Same promotions, same amounts, same free items and rewards. */
function sameApplication(
  left: PromotionApplicationResult,
  right: PromotionApplicationResult,
): boolean {
  const key = (result: PromotionApplicationResult) =>
    JSON.stringify(
      appliedOf(result)
        .map((evaluation) => ({
          id: evaluation.promotionId,
          discount: evaluation.discountIdr,
          free: evaluation.freeItems,
          facility: evaluation.facilityEntitlement,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
  return (
    left.totalDiscountIdr === right.totalDiscountIdr && key(left) === key(right)
  );
}

/** Why an expected promotion no longer applies, as a contract error. */
function changedError(
  expected: PromotionApplicationResult,
  actual: PromotionApplicationResult,
): HttpError {
  const reasons = new Map<string, PromoRejectionReason>();
  for (const evaluation of actual.evaluations)
    if (!evaluation.applied)
      reasons.set(evaluation.promotionId, evaluation.reason);
  for (const evaluation of appliedOf(expected)) {
    const reason = reasons.get(evaluation.promotionId);
    if (reason === "quota_exhausted")
      return crmHttpError("PROMO_QUOTA_EXHAUSTED");
    if (reason === "budget_exhausted")
      return crmHttpError("PROMO_BUDGET_EXHAUSTED");
  }
  return new HttpError(
    409,
    "PROMO_CHANGED",
    "Promo berubah sejak harga dihitung. Hitung ulang pesanan.",
  );
}

function fingerprintOf(checkout: PromoCheckoutInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        outletId: checkout.outletId,
        channel: checkout.channel,
        lines: checkout.lines.map((line) => [
          line.menuItemId,
          line.quantity,
          line.unitPriceIdr,
          line.lineTotalIdr,
        ]),
        customer: checkout.customer,
        code:
          checkout.voucherCode === null
            ? null
            : hashPromoCode(checkout.voucherCode),
      }),
    )
    .digest("hex");
}

/** Serializes redeem/release of one order (transaction-scoped). */
async function lockOrder(tx: Tx, tenantId: string, orderId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`promo:${tenantId}:${orderId}`}, 0))`,
  );
}

async function nextSequence(
  tx: Tx,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, PROMO_EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, aggregateType),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

type PromoEventName =
  | "promotion.updated"
  | "promo_application.redeemed"
  | "promo_application.released"
  | "voucher.issued";

/** Append one catalogued promo event inside the caller's transaction. */
export async function appendPromoEvent(
  tx: Tx,
  context: ScopedTenantContext,
  name: PromoEventName,
  input: {
    aggregateId: string;
    /** UUID form of the aggregate id, for the per-aggregate sequence. */
    aggregateUuid: string;
    outletId: string | null;
    actorUserId: string | null;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    now: Date;
  },
): Promise<void> {
  const definition = crmEvents[name];
  const sequence = await nextSequence(
    tx,
    context.tenant.tenantId,
    definition.entry.aggregateType,
    input.aggregateUuid,
  );
  const event = definition.envelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: input.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: input.aggregateId,
    sequence,
    occurredAt: input.now.toISOString(),
    actor:
      input.actorUserId === null
        ? { type: "system" }
        : { type: "user", id: input.actorUserId },
    deviceId: null,
    idempotencyKey: input.idempotencyKey.slice(0, 100),
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: input.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(input.now.getTime()),
    event,
    destination: PROMO_EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

const orderIdSchema = ulidIdSchema<"OrderId">();

export type RedeemPromotionsInput = PromoCheckoutInput & {
  /** The order being posted in this transaction (ULID). */
  readonly orderId: string;
  /** Staff who posted the order; null for a guest/system checkout. */
  readonly actorUserId: string | null;
  /**
   * The quote the customer accepted. When set, a changed outcome (quota or
   * budget taken by another order meanwhile) is refused instead of silently
   * charging a different price.
   */
  readonly expected?: PromotionApplicationResult;
};

/**
 * Commits the promotions of one order inside the caller's order transaction
 * (LOY-03). Idempotent per order: a retry with the same request returns the
 * stored result; a different request for the same order is refused.
 */
export async function redeemPromotions(
  tx: Tx,
  context: ScopedTenantContext,
  redeem: RedeemPromotionsInput,
): Promise<PromotionApplicationResult> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const orderId = orderIdSchema.parse(redeem.orderId);
  const fingerprint = fingerprintOf(redeem);
  await lockOrder(tx, tenantId, orderId);

  const [existing] = await tx
    .select()
    .from(promotionOrderApplications)
    .where(
      and(
        eq(promotionOrderApplications.tenantId, tenantId),
        eq(promotionOrderApplications.orderId, orderId),
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.requestFingerprint !== fingerprint)
      throw new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Pesanan ini sudah memakai promo dengan isi berbeda.",
      );
    if (existing.status === "released")
      throw new HttpError(
        409,
        "PROMO_APPLICATION_RELEASED",
        "Promo pesanan ini sudah dibatalkan.",
      );
    return promotionApplicationResultSchema.parse(existing.result);
  }

  const prepared = await prepare(tx, context, redeem, true);
  const result = applyPromotions(
    prepared.candidates,
    prepared.input,
    prepared.usage,
    prepared.policy,
  );
  if (redeem.expected && !sameApplication(redeem.expected, result))
    throw changedError(redeem.expected, result);

  const now = redeem.at;
  const outlet = await requirePromoOutlet(tx, context, redeem.outletId);
  const outletId = redeem.outletId;
  const customerId = redeem.customer?.customerProfileId ?? null;
  const applied = appliedOf(result).sort((a, b) =>
    a.promotionId < b.promotionId ? -1 : 1,
  );
  const voucherUsed =
    prepared.voucher !== null &&
    applied.some(
      (evaluation) => evaluation.promotionId === prepared.voucherEvaluationId,
    )
      ? prepared.voucher
      : null;
  const promotionById = new Map(
    prepared.candidates.map((promotion) => [promotion.id, promotion]),
  );

  await tx.insert(promotionOrderApplications).values({
    tenantId,
    outletId,
    orderId,
    requestFingerprint: fingerprint,
    channel: redeem.channel,
    customerProfileId: customerId,
    voucherId: voucherUsed?.id ?? null,
    subtotalIdr: prepared.input.subtotalIdr,
    totalDiscountIdr: result.totalDiscountIdr,
    result,
    redeemedAt: now,
    redeemedBy:
      redeem.actorUserId === null
        ? null
        : userIdSchema.parse(redeem.actorUserId),
  });

  if (voucherUsed) {
    // Single-use: issued -> redeemed, guarded, under the row lock (LOY-03).
    const flipped = await tx
      .update(vouchers)
      .set({ status: "redeemed", redeemedAt: now, redeemedOrderId: orderId })
      .where(
        and(
          eq(vouchers.tenantId, tenantId),
          eq(vouchers.id, voucherUsed.id),
          eq(vouchers.status, "issued"),
        ),
      )
      .returning({ id: vouchers.id });
    if (flipped.length !== 1) throw crmHttpError("VOUCHER_INVALID");
  }

  const rewards: Array<{
    facilityRewardId: string;
    promotionId: string;
    facilityProductId: string;
    quantity: number;
    expiresAt: string | null;
  }> = [];
  const appliedLines: Array<{
    promotionId: string | null;
    voucherId: string | null;
    discountIdr: Idr;
    freeItems: AppliedEvaluation["freeItems"];
  }> = [];
  for (const evaluation of applied) {
    const promotion = promotionById.get(evaluation.promotionId);
    if (!promotion) throw new Error("Applied promotion is not a candidate");
    const isValueVoucher =
      voucherUsed !== null &&
      voucherUsed.promotionId === null &&
      evaluation.promotionId === voucherUsed.id;
    const promotionId = isValueVoucher ? null : promotion.id;
    const voucherId =
      voucherUsed !== null &&
      evaluation.promotionId === prepared.voucherEvaluationId
        ? voucherUsed.id
        : null;

    if (promotionId !== null) {
      // Global quota + budget, atomically and guarded (CHECKs back this up).
      const counted = await tx
        .update(promotions)
        .set({
          usesTotal: sql`${promotions.usesTotal} + 1`,
          spentIdr: sql`${promotions.spentIdr} + ${evaluation.discountIdr}`,
          updatedAt: now,
        })
        .where(
          and(
            eq(promotions.tenantId, tenantId),
            eq(promotions.id, promotionId),
            sql`(${promotions.quotaTotal} IS NULL OR ${promotions.usesTotal} < ${promotions.quotaTotal})`,
            sql`(${promotions.budgetIdr} IS NULL OR ${promotions.spentIdr} + ${evaluation.discountIdr} <= ${promotions.budgetIdr})`,
          ),
        )
        .returning({ id: promotions.id });
      if (counted.length !== 1)
        throw crmHttpError(
          promotion.quotaTotal !== null
            ? "PROMO_QUOTA_EXHAUSTED"
            : "PROMO_BUDGET_EXHAUSTED",
        );
      if (customerId !== null) {
        const quota = promotion.quotaPerCustomer;
        const counter = await tx
          .insert(promotionCustomerUsage)
          .values({
            tenantId,
            promotionId,
            customerProfileId: customerId,
            uses: 1,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              promotionCustomerUsage.tenantId,
              promotionCustomerUsage.promotionId,
              promotionCustomerUsage.customerProfileId,
            ],
            set: {
              uses: sql`${promotionCustomerUsage.uses} + 1`,
              updatedAt: now,
            },
            setWhere:
              quota === null
                ? undefined
                : sql`${promotionCustomerUsage.uses} < ${quota}`,
          })
          .returning({ uses: promotionCustomerUsage.uses });
        if (counter.length !== 1) throw crmHttpError("PROMO_QUOTA_EXHAUSTED");
      }
    }

    await tx.insert(promotionRedemptions).values({
      tenantId,
      outletId,
      orderId,
      promotionId,
      voucherId,
      customerProfileId: customerId,
      discountIdr: evaluation.discountIdr,
      freeItems: evaluation.freeItems,
      redeemedAt: now,
    });
    appliedLines.push({
      promotionId,
      voucherId,
      discountIdr: evaluation.discountIdr,
      freeItems: evaluation.freeItems,
    });

    if (evaluation.facilityEntitlement !== null) {
      // The evaluator only grants a facility reward to an identified customer.
      if (customerId === null)
        throw new Error("Facility reward without a customer");
      const expiresAt = endOfBusinessDay(now, outlet.timezone);
      const [reward] = await tx
        .insert(facilityRewards)
        .values({
          tenantId,
          outletId,
          promotionId: promotion.id,
          customerProfileId: customerId,
          facilityProductId: evaluation.facilityEntitlement.facilityProductId,
          quantity: evaluation.facilityEntitlement.quantity,
          sourceOrderId: orderId,
          issuedAt: now,
          expiresAt,
        })
        .returning({ id: facilityRewards.id });
      if (!reward) throw new Error("Facility reward insert returned no row");
      rewards.push({
        facilityRewardId: reward.id,
        promotionId: promotion.id,
        facilityProductId: evaluation.facilityEntitlement.facilityProductId,
        quantity: evaluation.facilityEntitlement.quantity,
        expiresAt: expiresAt.toISOString(),
      });
    }
  }

  if (applied.length > 0)
    await appendPromoEvent(tx, context, "promo_application.redeemed", {
      aggregateId: orderId,
      aggregateUuid: ulidToUuid(orderId),
      outletId,
      actorUserId: redeem.actorUserId,
      idempotencyKey: `promo_application.redeemed:${orderId}`,
      now,
      payload: {
        orderId,
        outletId,
        customerProfileId: customerId,
        channel: redeem.channel,
        totalDiscountIdr: result.totalDiscountIdr,
        applied: appliedLines,
        facilityRewards: rewards,
      },
    });
  return result;
}

export type ReleasePromotionsInput = {
  readonly orderId: string;
  /** Void reason (PRD §3.10 "alasan baku"). */
  readonly reason: string;
  readonly actorUserId: string | null;
  readonly at: Date;
};

export type ReleasePromotionsResult = {
  /** False when nothing was redeemed for the order or it was already released. */
  readonly released: boolean;
  readonly releasedDiscountIdr: Idr;
};

/**
 * Gives back what a voided order consumed: global uses and budget, the
 * customer's use, the voucher (back to issued) and the facility rewards
 * (revoked; WS-09 revokes the entitlement from the event). Idempotent: a
 * second release is a no-op. Partial refunds keep the promotion (the bill's
 * promo stays valid for the items kept); a full void releases it.
 */
export async function releasePromotions(
  tx: Tx,
  context: ScopedTenantContext,
  release: ReleasePromotionsInput,
): Promise<ReleasePromotionsResult> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const orderId = orderIdSchema.parse(release.orderId);
  const reason = release.reason.trim();
  if (reason.length === 0 || reason.length > 300)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Alasan pembatalan wajib diisi.",
    );
  await lockOrder(tx, tenantId, orderId);
  const [application] = await tx
    .select()
    .from(promotionOrderApplications)
    .where(
      and(
        eq(promotionOrderApplications.tenantId, tenantId),
        eq(promotionOrderApplications.orderId, orderId),
      ),
    )
    .limit(1)
    .for("update");
  if (!application || application.status === "released")
    return { released: false, releasedDiscountIdr: idr(0) };

  const now = release.at;
  const lines = await tx
    .select()
    .from(promotionRedemptions)
    .where(
      and(
        eq(promotionRedemptions.tenantId, tenantId),
        eq(promotionRedemptions.orderId, orderId),
        eq(promotionRedemptions.status, "applied"),
      ),
    )
    .orderBy(asc(promotionRedemptions.promotionId));
  // Lock order matches redeem (voucher row first, then promotions by id), so
  // a release and a redeem presenting the same voucher cannot deadlock.
  if (application.voucherId !== null)
    await tx
      .select({ id: vouchers.id })
      .from(vouchers)
      .where(
        and(
          eq(vouchers.tenantId, tenantId),
          eq(vouchers.id, application.voucherId),
        ),
      )
      .for("update");
  const promotionIds = lines
    .map((line) => line.promotionId)
    .filter((id): id is string => id !== null)
    .sort();
  if (promotionIds.length > 0)
    // Same global lock order as redeem (id ascending): no deadlock.
    await tx
      .select({ id: promotions.id })
      .from(promotions)
      .where(
        and(
          eq(promotions.tenantId, tenantId),
          inArray(promotions.id, promotionIds),
        ),
      )
      .orderBy(asc(promotions.id))
      .for("update");

  let releasedDiscount = 0;
  for (const line of lines) {
    releasedDiscount += line.discountIdr;
    if (line.promotionId === null) continue;
    await tx
      .update(promotions)
      .set({
        usesTotal: sql`${promotions.usesTotal} - 1`,
        spentIdr: sql`${promotions.spentIdr} - ${line.discountIdr}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(promotions.tenantId, tenantId),
          eq(promotions.id, line.promotionId),
        ),
      );
    if (line.customerProfileId !== null)
      await tx
        .update(promotionCustomerUsage)
        .set({ uses: sql`${promotionCustomerUsage.uses} - 1`, updatedAt: now })
        .where(
          and(
            eq(promotionCustomerUsage.tenantId, tenantId),
            eq(promotionCustomerUsage.promotionId, line.promotionId),
            eq(
              promotionCustomerUsage.customerProfileId,
              line.customerProfileId,
            ),
            sql`${promotionCustomerUsage.uses} > 0`,
          ),
        );
  }
  if (lines.length > 0)
    await tx
      .update(promotionRedemptions)
      .set({ status: "released", releasedAt: now })
      .where(
        and(
          eq(promotionRedemptions.tenantId, tenantId),
          eq(promotionRedemptions.orderId, orderId),
          eq(promotionRedemptions.status, "applied"),
        ),
      );

  const voucherIds: string[] = [];
  if (application.voucherId !== null) {
    const restored = await tx
      .update(vouchers)
      .set({ status: "issued", redeemedAt: null, redeemedOrderId: null })
      .where(
        and(
          eq(vouchers.tenantId, tenantId),
          eq(vouchers.id, application.voucherId),
          eq(vouchers.status, "redeemed"),
          eq(vouchers.redeemedOrderId, orderId),
        ),
      )
      .returning({ id: vouchers.id });
    voucherIds.push(...restored.map((row) => row.id));
  }
  const revoked = await tx
    .update(facilityRewards)
    .set({ revokedAt: now })
    .where(
      and(
        eq(facilityRewards.tenantId, tenantId),
        eq(facilityRewards.sourceOrderId, orderId),
        isNull(facilityRewards.revokedAt),
      ),
    )
    .returning({ id: facilityRewards.id });

  await tx
    .update(promotionOrderApplications)
    .set({ status: "released", releasedAt: now, releaseReason: reason })
    .where(
      and(
        eq(promotionOrderApplications.tenantId, tenantId),
        eq(promotionOrderApplications.orderId, orderId),
      ),
    );

  const payload = {
    orderId,
    outletId: application.outletId,
    reason,
    releasedDiscountIdr: idr(releasedDiscount),
    voucherIds,
    facilityRewardIds: revoked.map((row) => row.id),
  };
  await appendPromoEvent(tx, context, "promo_application.released", {
    aggregateId: orderId,
    aggregateUuid: ulidToUuid(orderId),
    outletId: application.outletId,
    actorUserId: release.actorUserId,
    idempotencyKey: `promo_application.released:${orderId}`,
    now,
    payload,
  });
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId,
      outletId: application.outletId,
      actorType: release.actorUserId === null ? "system" : "user",
      actorId: release.actorUserId,
      deviceId: null,
      action: "promo_application.released",
      objectType: "promo_application",
      objectId: application.orderId,
      reason,
      maskedChanges: promoAuditChanges(
        { status: "applied", totalDiscountIdr: application.totalDiscountIdr },
        { status: "released", ...payload },
      ),
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    PROMO_AUDIT_SAFE_FIELDS,
  );
  return { released: true, releasedDiscountIdr: idr(releasedDiscount) };
}
