// Ports the QR order service (bead legend-e2x) depends on but does not own.
// Each has a fail-safe default and a setter the API bootstrap (lead) or a test
// installs, per AGENT_PLAYBOOK §2 "Missing dependency? Do not block".
//
// - OrderPromoPort (services/order-promo-port.ts, implemented by legend-souz in
//   services/order-promo.ts). Default: no promotion applies and any promo code
//   is refused, so a guest is never under- or over-charged by a guess.
// - Deposit credit (reservation DP, WS-08 `depositCreditForSession`). Default:
//   no deposit (0) until the reservation module is wired.
// - Serving estimate (WS-04 order pacing, ORD-11). Default: the slowest
//   station target of the cart, else a conservative fixed window.
// - Open service requests (legend-7qg) for the session view. Default: none.

import { sql } from "drizzle-orm";
import {
  CoreError,
  idr,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import type { ServiceRequest } from "@starter/shared/qr-order";
import type { OrderPromoPort } from "./order-promo-port.ts";
import type { Tx } from "./permission-resolver.ts";

// ---- Promo ------------------------------------------------------------------

/** Fail-safe promo port: no discounts; an explicit code is refused. */
export const noPromotionsPort: OrderPromoPort = {
  async quote(_tx, _ctx, input) {
    if (input.voucherCode !== null)
      throw new CoreError(
        "VALIDATION_ERROR",
        "Kode promo tidak dapat dipakai saat ini.",
      );
    return {
      result: { evaluations: [], totalDiscountIdr: idr(0) },
      totalDiscountIdr: idr(0),
    };
  },
  async redeem(tx, ctx, input) {
    return noPromotionsPort.quote(tx, ctx, input);
  },
  async release() {
    return { released: false, releasedDiscountIdr: idr(0) };
  },
};

let promoPort: OrderPromoPort = noPromotionsPort;

/** Lead wires the legend-souz implementation here; tests install a double. */
export function setQrOrderPromoPort(next: OrderPromoPort | null): void {
  promoPort = next ?? noPromotionsPort;
}

export function qrOrderPromoPort(): OrderPromoPort {
  return promoPort;
}

// ---- Reservation deposit credit ----------------------------------------------

/**
 * Same shape as WS-08 `depositCreditForSession(tx, tenantId, tableSessionId)`:
 * the reservation DP allocated to this table session, in whole rupiah.
 */
export type DepositCreditLookup = (
  tx: Tx,
  tenantId: TenantId,
  tableSessionId: string,
) => Promise<number>;

let depositCredit: DepositCreditLookup = async () => 0;

export function setQrOrderDepositCreditLookup(
  next: DepositCreditLookup | null,
): void {
  depositCredit = next ?? (async () => 0);
}

/** Never negative: a corrupt or refunded allocation cannot raise the bill. */
export async function depositCreditFor(
  tx: Tx,
  tenantId: TenantId,
  tableSessionId: string,
): Promise<number> {
  const value = await depositCredit(tx, tenantId, tableSessionId);
  return Number.isSafeInteger(value) ? Math.max(0, value) : 0;
}

/**
 * Serializes every reader-then-writer of one table session's deposit credit
 * (bead legend-94qt): the QR pay-first checkout and every POS order create or
 * reprice of the session take this transaction lock right before they sum the
 * deposit the session's other live orders already applied, and hold it until
 * commit, so two orders never both apply the same remaining credit. It is a
 * leaf lock: nothing else is locked after it, only the caller's own order row
 * is written (already locked, or a fresh insert).
 *
 * Global lock order across the QR and POS bills (legend-94qt): the order row,
 * then the promo engine locks (`redeemPromotions` doc in crm-promo-engine.ts),
 * THEN this deposit lock. POS follows it by construction (discount apply ->
 * redeem -> repriceOrder -> depositFor). The QR pay-first checkout therefore
 * inserts its order, redeems its promotion, and only then takes this lock to
 * apply the credit; taking it before the redeem deadlocked (40P01) against a
 * POS promo discount in the same session. Never take a promo lock after this.
 */
export async function lockSessionDeposit(
  tx: Tx,
  tenantId: TenantId,
  tableSessionId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`table-deposit:${tenantId}:${tableSessionId.toLowerCase()}`}, 0))`,
  );
}

// ---- Serving estimate (ORD-11) -----------------------------------------------

export type ServingEstimateInput = {
  readonly outletId: string;
  readonly lines: readonly {
    readonly menuItemId: string;
    readonly quantity: number;
    /** `stations.target_seconds` of the item's default station, if any. */
    readonly stationTargetSeconds: number | null;
  }[];
  readonly at: Date;
};

export type ServingEstimate = { minMinutes: number; maxMinutes: number };

export type ServingEstimatePort = (
  tx: Tx,
  context: ScopedTenantContext,
  input: ServingEstimateInput,
) => Promise<ServingEstimate | null>;

/** PRD silent on a fallback window; 15-25 min until WS-04 pacing is wired. */
export const FALLBACK_SERVING_MINUTES = { min: 15, max: 25 } as const;

/**
 * Default estimator: the slowest configured station target among the cart's
 * items (min) and 1.5x that (max); without station targets the fallback
 * window. WS-04 order pacing (KDS-05) replaces it through the setter.
 */
export const stationTargetServingEstimate: ServingEstimatePort = async (
  _tx,
  _context,
  input,
) => {
  const targets = input.lines
    .map((line) => line.stationTargetSeconds)
    .filter((value): value is number => value !== null && value > 0);
  if (targets.length === 0)
    return {
      minMinutes: FALLBACK_SERVING_MINUTES.min,
      maxMinutes: FALLBACK_SERVING_MINUTES.max,
    };
  const slowest = Math.max(...targets);
  const minMinutes = Math.max(1, Math.ceil(slowest / 60));
  return {
    minMinutes,
    maxMinutes: Math.max(minMinutes, Math.ceil((slowest * 1.5) / 60)),
  };
};

let servingEstimate: ServingEstimatePort = stationTargetServingEstimate;

export function setQrOrderServingEstimatePort(
  next: ServingEstimatePort | null,
): void {
  servingEstimate = next ?? stationTargetServingEstimate;
}

export function qrOrderServingEstimatePort(): ServingEstimatePort {
  return servingEstimate;
}

// ---- Open service requests (legend-7qg) ---------------------------------------

export type OpenServiceRequestsLookup = (
  tx: Tx,
  context: ScopedTenantContext,
  tableSessionId: string,
) => Promise<ServiceRequest[]>;

let openServiceRequests: OpenServiceRequestsLookup = async () => [];

export function setQrOrderOpenServiceRequestsLookup(
  next: OpenServiceRequestsLookup | null,
): void {
  openServiceRequests = next ?? (async () => []);
}

export function qrOrderOpenServiceRequests(): OpenServiceRequestsLookup {
  return openServiceRequests;
}
