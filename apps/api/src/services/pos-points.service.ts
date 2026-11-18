// Member points paid at the POS (936, legend-hpgyw part B; contract
// @starter/shared/pos/points). The server prices everything: one point is worth
// the loyalty program's `pointValueIdr`, a quote rounds DOWN to whole points
// that fit the bill, and the cashier screen only shows the answer.
//
// Money rules (founder: never pay more, never lose):
// - Points cover at most the REMAINING balance (total - deposit - captured
//   tenders), never more than the member's balance. Leftover rupiah the points
//   cannot cover (value < point value) is paid by another method.
// - The ledger row and the tender are written in ONE transaction under the
//   order lock; the redeem row's source id is the tender id. Replays of the same
//   idempotency key return the stored answer (posIdempotent); two different keys
//   queue on the order lock and the second sees the smaller remaining balance.
// - The loyalty_liability move is booked by order.paid (paidPointsIdr), equal
//   to the ledger row's liability (points x program value), so the GL balances.
//   A `pos_tender` redeem row emits no points.redeemed event or journal.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  CoreError,
  outletIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { isFinalPosOrder, type PosOrderDetail } from "@starter/shared/pos";
import type {
  PosPointsAccount,
  PosPointsQuote,
} from "@starter/shared/pos/points";
import { db } from "../db/index.ts";
import { withProfileLock } from "../db/member-scope.ts";
import { customerProfiles, loyaltyPrograms } from "../db/schema/crm-member.ts";
import { orders } from "../db/schema/qr-order.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { HttpError } from "../lib/http-error.ts";
import { withTenant } from "../db/tenant.ts";
import { expirePointsForProfile } from "./loyalty-expiry.service.ts";
import type { Tx } from "./menu-internals.ts";
import { addPosTender } from "./pos-order-payment.ts";
import type { PosExternalTenderPort } from "./pos-order-ports.ts";
import {
  readPosOrder,
  remainingIdr,
  tendersOf,
  type PosCaller,
} from "./pos-order-support.ts";
import { postLedgerEntry } from "./point-ledger.service.ts";

/** No program-level minimum exists yet; one point is the smallest redemption. */
export const POS_MIN_REDEEM_POINTS = 1;

type Program = { isActive: boolean; pointValueIdr: number };

async function loadProgram(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
): Promise<Program | null> {
  const [row] = await tx
    .select({
      isActive: loyaltyPrograms.isActive,
      pointValueIdr: loyaltyPrograms.pointValueIdr,
    })
    .from(loyaltyPrograms)
    .where(eq(loyaltyPrograms.tenantId, tenantId));
  return row ?? null;
}

/** Whole points that fit `remainingIdr` (rounded down) and the balance. */
function maxPointsFor(
  balance: number,
  remaining: number,
  pointValueIdr: number,
): number {
  return Math.max(0, Math.min(balance, Math.floor(remaining / pointValueIdr)));
}

/** Validates a redemption and returns its rupiah value; throws to refuse. */
function priceRedemption(input: {
  program: Program | null;
  membershipStatus: string;
  balance: number;
  remainingIdr: number;
  points: number;
}): number {
  const { program, points } = input;
  if (!program?.isActive || input.membershipStatus !== "active")
    throw new CoreError(
      "CONFLICT",
      "Poin member belum bisa dipakai untuk pembayaran.",
    );
  if (!Number.isSafeInteger(points) || points <= 0)
    throw new CoreError("VALIDATION_ERROR", "Jumlah poin harus lebih dari 0.");
  if (points < POS_MIN_REDEEM_POINTS)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Jumlah poin kurang dari minimum penukaran.",
    );
  if (points > input.balance)
    throw new CoreError("CONFLICT", "Saldo poin tidak cukup.");
  if (input.remainingIdr <= 0)
    throw new CoreError("CONFLICT", "Tagihan ini sudah lunas.");
  const valueIdr = points * program.pointValueIdr;
  if (valueIdr > input.remainingIdr)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Nilai poin tidak boleh melebihi sisa tagihan.",
    );
  return valueIdr;
}

/**
 * The port behind a `points` tender (`setPosPointsTenderPort`): runs inside the
 * order transaction with the order row locked. `input.amountIdr` is the
 * remaining balance, the ceiling of what the points may cover.
 */
export const posPointsTenderSettlement: PosExternalTenderPort = async (
  tx,
  context,
  input,
) => {
  // An edge node cannot see the member's cloud balance or lock it against a
  // second terminal, so points could be spent twice: cloud only (same rule as
  // pos-order-payment.ts isEdgeProcess and refundPosOrder).
  if (getEdgeRuntimeState().edgeMode || process.env.EDGE_MODE === "true")
    throw new HttpError(
      409,
      "POINTS_NEED_CLOUD",
      "Pembayaran dengan poin hanya bisa dilakukan saat terhubung ke server pusat.",
    );
  const tenantId = context.tenant.tenantId;
  const points = input.pointsUsed;
  if (points === null)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Pembayaran poin mencantumkan jumlah poin.",
    );
  const [order] = await tx
    .select({
      customerProfileId: orders.customerProfileId,
      businessDate: orders.businessDate,
    })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.id, input.orderId),
        eq(orders.outletId, outletIdSchema.parse(input.outletId)),
      ),
    );
  if (!order?.customerProfileId)
    throw new CoreError("CONFLICT", "Pesanan ini tidak punya member.");
  const profileId = order.customerProfileId;
  await withProfileLock(tx, tenantId, profileId);
  // Expired points must not pay (as redeemReward): expire first, then read the
  // balance again under the same lock.
  await expirePointsForProfile(tx, tenantId, profileId, input.at);
  const profile = await withProfileLock(tx, tenantId, profileId);
  const program = await loadProgram(tx, tenantId);
  const valueIdr = priceRedemption({
    program,
    membershipStatus: profile.membershipStatus,
    balance: Number(profile.pointsBalance),
    remainingIdr: input.amountIdr,
    points,
  });
  const tenderId = randomUUID();
  await postLedgerEntry(
    tx,
    context,
    {
      tenantId,
      customerProfileId: profileId,
      outletId: input.outletId,
      type: "redeem",
      points: -points,
      sourceType: "pos_tender",
      sourceId: tenderId,
      expiresAt: null,
      businessDate: order.businessDate,
      createdBy: input.cashierId,
    },
    input.at,
  );
  return { reference: null, approvedBy: null, amountIdr: valueIdr, tenderId };
};

type BillPoints = {
  profile: typeof customerProfiles.$inferSelect | null;
  program: Program | null;
  remainingIdr: number;
};

async function loadBill(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  orderId: string,
): Promise<BillPoints> {
  const { order } = await readPosOrder(tx, context, outletId, orderId);
  const tenantId = context.tenant.tenantId;
  const tenders = await tendersOf(tx, context, order.id);
  // Reading and quoting also serve a bill not yet submitted; only redeeming
  // needs it payable (addPosTender refuses a draft). A final bill owes nothing.
  const remaining = isFinalPosOrder(order.status)
    ? 0
    : remainingIdr(order, tenders);
  let profile: BillPoints["profile"] = null;
  if (order.customerProfileId) {
    const [row] = await tx
      .select()
      .from(customerProfiles)
      .where(
        and(
          eq(customerProfiles.tenantId, tenantId),
          eq(customerProfiles.id, order.customerProfileId),
        ),
      );
    profile = row ?? null;
  }
  return {
    profile,
    program: await loadProgram(tx, tenantId),
    remainingIdr: remaining,
  };
}

/** GET: the member on the bill and what they may spend now (null = no member). */
export async function getPosOrderPointsAccount(
  context: ScopedTenantContext,
  outletId: OutletId,
  orderId: string,
): Promise<{ account: PosPointsAccount | null }> {
  return withTenant(db, context, async (tx) => {
    const {
      profile,
      program,
      remainingIdr: remaining,
    } = await loadBill(tx, context, outletId, orderId);
    if (!profile) return { account: null };
    const balance = Number(profile.pointsBalance);
    const usable = program?.isActive && profile.membershipStatus === "active";
    return {
      account: {
        memberId: profile.id,
        memberName: profile.name,
        balancePoints: balance,
        minRedeemPoints: POS_MIN_REDEEM_POINTS,
        maxRedeemPoints:
          usable && program
            ? maxPointsFor(balance, remaining, program.pointValueIdr)
            : 0,
      },
    };
  });
}

/** POST quote: what these points are worth on this bill; refuses what redeem refuses. */
export async function quotePosOrderPoints(
  context: ScopedTenantContext,
  outletId: OutletId,
  orderId: string,
  points: number,
): Promise<PosPointsQuote> {
  return withTenant(db, context, async (tx) => {
    const {
      profile,
      program,
      remainingIdr: remaining,
    } = await loadBill(tx, context, outletId, orderId);
    if (!profile)
      throw new CoreError("CONFLICT", "Pesanan ini tidak punya member.");
    const valueIdr = priceRedemption({
      program,
      membershipStatus: profile.membershipStatus,
      balance: Number(profile.pointsBalance),
      remainingIdr: remaining,
      points,
    });
    return { points, valueIdr };
  });
}

/**
 * POST redeem: one `points` tender worth `points x pointValueIdr`, through the
 * same guarded path as every tender (QR holds, open EDC, idempotency, order
 * lock). Returns the order as `getPosOrder` shows it.
 */
export async function redeemPosOrderPoints(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: OutletId,
  orderId: string,
  input: { points: number; idempotencyKey: string },
  now = new Date(),
): Promise<PosOrderDetail> {
  const result = await addPosTender(
    context,
    caller,
    outletId,
    orderId,
    {
      method: "points",
      pointsUsed: input.points,
      idempotencyKey: input.idempotencyKey,
    },
    now,
  );
  return result.order;
}
