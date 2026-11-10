// Guest point claim (bead legend-n1mp; PRD "Klaim Poin per Orang"; contracts
// @starter/shared/qr-order guest.ts getPointClaim / claimSessionPoints).
//
// A guest who paid at the table, and signs in to the member app, claims the
// loyalty points of what they paid for 24 hours after the bill was settled.
// The unit of a claim is one paid thing with one payer:
//
// - a paid bill split part (`bill_splits`), known by its claim token
//   (`sc_...`): one person, one part, so it is claimed only with its token;
// - a paid order that was never split (a single payer): token issued when the
//   order is fired (`issueWholeBillClaimTx`). Without a token a claim covers
//   all such orders of the session.
//
// The earn is a ledger row `earn` / `table_claim` / sourceId = the unit id, so
// the ledger dedupe key is the idempotency guard. An order that already has a
// member attached earns through the order.paid consumer and is never claimable
// (no double points). Employee self-serve ban does not apply to a claim
// (docs/DECISIONS). The daily cap per customer is read from the ledger.

import { createHash, randomBytes } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import {
  CoreError,
  toIsoDateTime,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { pointsForSpend, type LoyaltyProgram } from "@starter/shared/crm";
import { pointClaimSchema, type PointClaim } from "@starter/shared/qr-order";
import { db } from "../db/index.ts";
import { memberTenantContext, withProfileLock } from "../db/member-scope.ts";
import {
  billSplits,
  customerProfiles,
  loyaltyPrograms,
  pointLedger,
  tableSessions,
} from "../db/schema/index.ts";
import { orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { sealSecret } from "../lib/secrets.ts";
import type { Tx } from "./menu-internals.ts";
import { tierMultiplierBp } from "./loyalty-earn-tier-step.ts";
import type { EarnStepContext } from "./loyalty-earn-step-context.ts";
import {
  findProfileByUser,
  loyaltyConsentActive,
} from "./member-profile.service.ts";
import { postLedgerEntry } from "./point-ledger.service.ts";
import { lockGuestSessionForPayment } from "./qr-order.service.ts";

type SessionRow = typeof tableSessions.$inferSelect;

/** A claim lives 24 hours after the bill is settled (same as split parts). */
const CLAIM_TTL_MS = 24 * 60 * 60_000;
const LEDGER_SOURCE = "table_claim" as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function orderClaimAad(tenantId: string, orderId: string): string {
  return `order-claim:${tenantId}:${orderId}`;
}

function notAvailable(): HttpError {
  return new HttpError(
    409,
    "CLAIM_NOT_AVAILABLE",
    "Poin untuk meja ini tidak bisa diklaim (sudah diklaim, kedaluwarsa, atau bukan milikmu).",
  );
}

/**
 * SQL condition: the order (or a split part of it) has a refund that was not
 * rejected, so its points are not claimable (the money went back). Counts a
 * payment refund that is not `failed` (pending, approved, completed; also the
 * late-payment refund) on an intent of the order (its current one, or tied by order id) or of one of its parts, an
 * intent already marked (partially) refunded, and a POS refund with money.
 */
function orderRefunded(tenantId: TenantId) {
  // Plain `orders.` names: drizzle renders a column unqualified in a
  // single-table query, which would bind to the inner table here.
  return sql`(
    EXISTS (
      SELECT 1 FROM payment_intents i
      WHERE i.tenant_id = ${tenantId}
        AND (
          i.id = orders.payment_intent_id
          OR i.order_id = orders.id
          OR i.bill_split_id IN (
            SELECT s.id FROM bill_splits s
            WHERE s.tenant_id = ${tenantId} AND s.order_id = orders.id
          )
        )
        AND (
          i.status IN ('refunded', 'partially_refunded')
          OR EXISTS (
            SELECT 1 FROM payment_refunds r
            WHERE r.tenant_id = i.tenant_id
              AND r.payment_intent_id = i.id
              AND r.status <> 'failed'
          )
        )
    )
    OR EXISTS (
      SELECT 1 FROM pos_order_refunds p
      WHERE p.tenant_id = ${tenantId}
        AND p.order_id = orders.id
        AND p.amount_idr > 0
    )
  )`;
}

/**
 * SQL condition: the order was rung up on a training device (`pos_orders`
 * stamp, legend-2lp.8). Training sales earn no points, claim included.
 */
function orderTraining(tenantId: TenantId) {
  return sql`EXISTS (
    SELECT 1 FROM pos_orders t
    WHERE t.tenant_id = ${tenantId}
      AND t.order_id = orders.id
      AND t.is_training
  )`;
}

// ---- Issue -------------------------------------------------------------------------

/**
 * Issues the claim token of a paid order that has no bill split (single
 * payer). Called when the order is fired by a guest payment, after the
 * leftover parts were voided. Replay safe: the UPDATE only fills an order
 * without a token, and an order with a live (non-voided) split part is never
 * issued one (its parts carry their own tokens). Returns whether it issued.
 */
export async function issueWholeBillClaimTx(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
  paidAt: Date,
): Promise<boolean> {
  const tenantId = context.tenant.tenantId;
  const raw = `sc_${randomBytes(32).toString("base64url")}`;
  const issued = await tx
    .update(orders)
    .set({
      claimTokenHash: sha256(raw),
      claimTokenSealed: sealSecret(raw, orderClaimAad(tenantId, orderId)),
      claimExpiresAt: new Date(paidAt.getTime() + CLAIM_TTL_MS),
      updatedAt: paidAt,
    })
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.id, orderId),
        isNotNull(orders.tableSessionId),
        isNull(orders.claimTokenHash),
        inArray(orders.status, ["sent", "completed"]),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(billSplits)
            .where(
              and(
                eq(billSplits.tenantId, orders.tenantId),
                eq(billSplits.orderId, orders.id),
                ne(billSplits.status, "voided"),
              ),
            ),
        ),
      ),
    )
    .returning({ id: orders.id });
  return issued.length > 0;
}

// ---- Units ---------------------------------------------------------------------------

type ClaimUnit = {
  kind: "split" | "order";
  id: string;
  /** What the guest paid (shown as is). */
  paidIdr: number;
  /**
   * The spend that earns points: after discount, before tax and service
   * charge (PRD D18); a split part holds its pro-rata share.
   */
  spendIdr: number;
  paidAt: Date;
  expiresAt: Date;
  redeemedAt: Date | null;
  outletId: string;
  businessDate: string;
  /** A member is already attached to the order: the earn consumer pays it. */
  hasMember: boolean;
};

type OrderUnitRow = {
  id: string;
  outletId: string;
  businessDate: string;
  totalIdr: number;
  subtotalIdr: number;
  discountIdr: number;
  serviceChargeIdr: number;
  taxIdr: number;
  pricesIncludeTax: boolean;
  expiresAt: Date | null;
  redeemedAt: Date | null;
  customerProfileId: string | null;
};

/**
 * Spend of a whole order that earns points: gross sales minus discount. Gross
 * sales are the subtotal, or, for tax-inclusive prices (harga nett), the
 * subtotal without the service charge and tax it already holds (the same split
 * `order.paid` carries, order-revenue.ts).
 */
function eligibleSpend(row: {
  subtotalIdr: number;
  discountIdr: number;
  serviceChargeIdr: number;
  taxIdr: number;
  pricesIncludeTax: boolean;
}): number {
  const gross = row.pricesIncludeTax
    ? row.subtotalIdr - row.serviceChargeIdr - row.taxIdr
    : row.subtotalIdr;
  return Math.max(0, gross - row.discountIdr);
}

/** A part's pro-rata share of the order's spend, rounded down. */
function partSpend(eligible: number, partIdr: number, totalIdr: number) {
  if (totalIdr <= 0) return 0;
  return Number((BigInt(eligible) * BigInt(partIdr)) / BigInt(totalIdr));
}

function orderUnit(row: OrderUnitRow): ClaimUnit | null {
  if (row.expiresAt === null) return null;
  return {
    kind: "order",
    id: row.id,
    paidIdr: row.totalIdr,
    spendIdr: eligibleSpend(row),
    paidAt: new Date(row.expiresAt.getTime() - CLAIM_TTL_MS),
    expiresAt: row.expiresAt,
    redeemedAt: row.redeemedAt,
    outletId: row.outletId,
    businessDate: row.businessDate,
    hasMember: row.customerProfileId !== null,
  };
}

/**
 * The units a request covers, voided and refunded orders left out. With a token: exactly
 * the one unit that token names, if it belongs to this session (a split part
 * or a whole-bill order); otherwise none. Without: every whole-bill order of
 * the session, oldest first.
 */
async function loadUnits(
  tx: Tx,
  tenantId: TenantId,
  sessionId: string,
  claimToken: string | undefined,
): Promise<ClaimUnit[]> {
  const orderSelect = {
    id: orders.id,
    outletId: orders.outletId,
    businessDate: orders.businessDate,
    totalIdr: orders.totalIdr,
    subtotalIdr: orders.subtotalIdr,
    discountIdr: orders.discountIdr,
    serviceChargeIdr: orders.serviceChargeIdr,
    taxIdr: orders.taxIdr,
    pricesIncludeTax: orders.pricesIncludeTax,
    expiresAt: orders.claimExpiresAt,
    redeemedAt: orders.claimRedeemedAt,
    customerProfileId: orders.customerProfileId,
  };
  if (claimToken !== undefined) {
    const hash = sha256(claimToken);
    const [part] = await tx
      .select({
        id: billSplits.id,
        amountIdr: billSplits.amountIdr,
        paidAt: billSplits.paidAt,
        expiresAt: billSplits.claimExpiresAt,
        redeemedAt: billSplits.claimRedeemedAt,
        outletId: orders.outletId,
        businessDate: orders.businessDate,
        customerProfileId: orders.customerProfileId,
        totalIdr: orders.totalIdr,
        subtotalIdr: orders.subtotalIdr,
        discountIdr: orders.discountIdr,
        serviceChargeIdr: orders.serviceChargeIdr,
        taxIdr: orders.taxIdr,
        pricesIncludeTax: orders.pricesIncludeTax,
      })
      .from(billSplits)
      .innerJoin(
        orders,
        and(
          eq(orders.tenantId, billSplits.tenantId),
          eq(orders.id, billSplits.orderId),
        ),
      )
      .where(
        and(
          eq(billSplits.tenantId, tenantId),
          eq(billSplits.claimTokenHash, hash),
          eq(billSplits.tableSessionId, sessionId),
          eq(billSplits.status, "paid"),
          ne(orders.status, "voided"),
          sql`NOT ${orderRefunded(tenantId)}`,
          sql`NOT ${orderTraining(tenantId)}`,
        ),
      );
    if (part) {
      if (part.paidAt === null || part.expiresAt === null) return [];
      return [
        {
          kind: "split",
          id: part.id,
          paidIdr: part.amountIdr,
          spendIdr: partSpend(
            eligibleSpend(part),
            part.amountIdr,
            part.totalIdr,
          ),
          paidAt: part.paidAt,
          expiresAt: part.expiresAt,
          redeemedAt: part.redeemedAt,
          outletId: part.outletId,
          businessDate: part.businessDate,
          hasMember: part.customerProfileId !== null,
        },
      ];
    }
    const [row] = await tx
      .select(orderSelect)
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.claimTokenHash, hash),
          eq(orders.tableSessionId, sessionId),
          ne(orders.status, "voided"),
          sql`NOT ${orderRefunded(tenantId)}`,
          sql`NOT ${orderTraining(tenantId)}`,
        ),
      );
    const unit = row ? orderUnit(row) : null;
    return unit ? [unit] : [];
  }
  const rows = await tx
    .select(orderSelect)
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.tableSessionId, sessionId),
        isNotNull(orders.claimTokenHash),
        ne(orders.status, "voided"),
        sql`NOT ${orderRefunded(tenantId)}`,
        sql`NOT ${orderTraining(tenantId)}`,
      ),
    )
    .orderBy(asc(orders.claimExpiresAt), asc(orders.id));
  return rows.flatMap((row) => orderUnit(row) ?? []);
}

// ---- Points --------------------------------------------------------------------------

type ProgramRow = typeof loyaltyPrograms.$inferSelect;
type ProfileRow = typeof customerProfiles.$inferSelect;

async function loadProgram(
  tx: Tx,
  tenantId: TenantId,
): Promise<ProgramRow | null> {
  const [program] = await tx
    .select()
    .from(loyaltyPrograms)
    .where(eq(loyaltyPrograms.tenantId, tenantId))
    .limit(1);
  return program && program.isActive ? program : null;
}

function programDtoOf(row: ProgramRow): LoyaltyProgram {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    earnRate: { spendIdr: row.earnSpendIdr, points: row.earnPoints },
    expiryMonths: row.expiryMonths,
    rollingMonths: row.rollingMonths,
    pointValueIdr: row.pointValueIdr,
    referral: row.referral,
    antiFraud: {
      dailyPointCapPerCustomer: row.dailyPointCapPerCustomer,
      employeeSelfServeBan: row.employeeSelfServeBan,
    },
    updatedAt: row.updatedAt.toISOString(),
  } as LoyaltyProgram;
}

function addMonthsUtc(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/**
 * Points each open unit would earn the profile (none when there is no active
 * program). The tier multiplier and the daily cap apply when the profile is
 * known: the cap leaves `cap - points already earned that business date`,
 * shared by the units of one date in order. An anonymous guest sees the
 * uncapped figure.
 */
async function planPoints(
  tx: Tx,
  tenantId: TenantId,
  program: ProgramRow | null,
  profile: ProfileRow | null,
  open: ClaimUnit[],
): Promise<Map<string, number>> {
  const plan = new Map<string, number>();
  if (!program) {
    for (const unit of open) plan.set(unit.id, 0);
    return plan;
  }
  const dto = programDtoOf(program);
  const multiplier = profile
    ? // The tier lookup reads only the tx, tenant and profile of the context.
      await tierMultiplierBp({
        tx,
        tenantId,
        profile,
      } as unknown as EarnStepContext)
    : 10_000;
  const cap = profile ? program.dailyPointCapPerCustomer : null;
  const remaining = new Map<string, number>();
  for (const unit of open) {
    let points = pointsForSpend(dto, unit.spendIdr, multiplier);
    if (cap !== null && profile) {
      if (!remaining.has(unit.businessDate)) {
        const [day] = await tx
          .select({
            total: sql<string>`COALESCE(SUM(${pointLedger.points}), 0)`,
          })
          .from(pointLedger)
          .where(
            and(
              eq(pointLedger.tenantId, tenantId),
              eq(pointLedger.customerProfileId, profile.id),
              eq(pointLedger.type, "earn"),
              eq(pointLedger.businessDate, unit.businessDate),
            ),
          );
        remaining.set(
          unit.businessDate,
          Math.max(0, cap - Number(day?.total ?? 0)),
        );
      }
      const left = remaining.get(unit.businessDate) ?? 0;
      points = Math.min(points, left);
      remaining.set(unit.businessDate, left - points);
    }
    plan.set(unit.id, points);
  }
  return plan;
}

function isOpen(unit: ClaimUnit, now: Date): boolean {
  return (
    unit.redeemedAt === null &&
    unit.expiresAt.getTime() > now.getTime() &&
    !unit.hasMember
  );
}

/**
 * This profile's claim earns among the units: unit id -> points booked. A unit
 * redeemed by anyone else is not here, so it is never "claimed" for the caller.
 */
async function ownClaims(
  tx: Tx,
  tenantId: TenantId,
  profileId: string | null,
  unitIds: string[],
): Promise<Map<string, number>> {
  const own = new Map<string, number>();
  if (profileId === null || unitIds.length === 0) return own;
  const rows = await tx
    .select({ sourceId: pointLedger.sourceId, points: pointLedger.points })
    .from(pointLedger)
    .where(
      and(
        eq(pointLedger.tenantId, tenantId),
        eq(pointLedger.customerProfileId, profileId),
        eq(pointLedger.type, "earn"),
        eq(pointLedger.sourceType, LEDGER_SOURCE),
        inArray(pointLedger.sourceId, unitIds),
      ),
    );
  for (const row of rows)
    if (row.sourceId !== null)
      own.set(row.sourceId, (own.get(row.sourceId) ?? 0) + Number(row.points));
  return own;
}

async function buildClaim(
  tx: Tx,
  tenantId: TenantId,
  sessionId: string,
  units: ClaimUnit[],
  program: ProgramRow | null,
  profile: ProfileRow | null,
  userId: string | null,
  now: Date,
): Promise<PointClaim> {
  const claim = (
    status: PointClaim["status"],
    paidIdr: number,
    points: number,
    claimableUntil: Date | null,
  ) =>
    pointClaimSchema.parse({
      sessionId,
      status,
      paidIdr,
      points,
      claimableUntil: claimableUntil ? toIsoDateTime(claimableUntil) : null,
      requiresLogin: userId === null,
    });
  const open = units.filter((unit) => isOpen(unit, now));
  const plan = await planPoints(tx, tenantId, program, profile, open);
  const claimable = open.filter((unit) => (plan.get(unit.id) ?? 0) > 0);
  if (claimable.length > 0)
    return claim(
      "available",
      claimable.reduce((sum, unit) => sum + unit.paidIdr, 0),
      claimable.reduce((sum, unit) => sum + (plan.get(unit.id) ?? 0), 0),
      new Date(Math.min(...claimable.map((unit) => unit.expiresAt.getTime()))),
    );
  // Only what this profile redeemed counts as claimed; a unit taken by
  // someone else (or any unit, for an anonymous guest) reads as unavailable.
  const own = await ownClaims(
    tx,
    tenantId,
    profile?.id ?? null,
    units.filter((unit) => unit.redeemedAt !== null).map((unit) => unit.id),
  );
  const redeemed = units.filter(
    (unit) => unit.redeemedAt !== null && own.has(unit.id),
  );
  if (redeemed.length > 0)
    return claim(
      "claimed",
      redeemed.reduce((sum, unit) => sum + unit.paidIdr, 0),
      redeemed.reduce((sum, unit) => sum + (own.get(unit.id) ?? 0), 0),
      null,
    );
  const lapsed = units.some(
    (unit) =>
      unit.redeemedAt === null &&
      !unit.hasMember &&
      unit.expiresAt.getTime() <= now.getTime(),
  );
  if (lapsed && program) return claim("expired", 0, 0, null);
  return claim("unavailable", 0, 0, null);
}

/**
 * The guest session of a request. A claim token is its own proof, so with one
 * the session may be closed (24 hours after paying, like
 * getSplitClaimByToken): the credential must still name this session and the
 * unit is still bound to it by loadUnits. Without a token the session must be
 * open (the credential gate of the QR order).
 */
async function claimSession(
  tx: Tx,
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  claimToken: string | undefined,
  now: Date,
): Promise<SessionRow> {
  try {
    return await lockGuestSessionForPayment(
      tx,
      context,
      credential,
      sessionId,
      now,
      "none",
    );
  } catch (error) {
    if (
      claimToken === undefined ||
      !(error instanceof CoreError) ||
      error.code !== "UNAUTHORIZED"
    )
      throw error;
    const [closed] = await tx
      .select()
      .from(tableSessions)
      .where(
        and(
          eq(tableSessions.tenantId, context.tenant.tenantId),
          eq(tableSessions.id, sessionId),
          eq(tableSessions.sessionTokenHash, sha256(credential)),
          eq(tableSessions.status, "closed"),
        ),
      );
    if (!closed) throw error;
    return closed;
  }
}

// ---- Reads and claim ----------------------------------------------------------------

/**
 * GET /api/table-sessions/:sessionId/points-claim. Sign-in is optional here
 * (`requiresLogin` tells the guest to sign in); the figure is the same.
 */
export async function getPointClaim(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  input: { claimToken?: string; userId: string | null },
  now = new Date(),
): Promise<PointClaim> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const session = await claimSession(
      tx,
      context,
      credential,
      sessionId,
      input.claimToken,
      now,
    );
    const units = await loadUnits(tx, tenantId, session.id, input.claimToken);
    const program = await loadProgram(tx, tenantId);
    const profile = input.userId
      ? await findProfileByUser(tx, tenantId, input.userId)
      : null;
    return buildClaim(
      tx,
      tenantId,
      session.id,
      units,
      program,
      profile,
      input.userId,
      now,
    );
  });
}

/**
 * POST /api/table-sessions/:sessionId/points-claim. The signed-in member
 * redeems every open unit the request covers and is paid its points in one
 * transaction under the profile lock. A repeat by the same member returns the
 * claimed result; a unit taken by someone else, expired, voided, already tied
 * to a member, or worth no points is `CLAIM_NOT_AVAILABLE`.
 */
export async function claimSessionPoints(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  input: { claimToken?: string; userId: string | null },
  now = new Date(),
): Promise<PointClaim> {
  const { userId } = input;
  if (userId === null)
    throw new CoreError("UNAUTHORIZED", "Masuk dulu untuk mengklaim poin.");
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const session = await claimSession(
      tx,
      context,
      credential,
      sessionId,
      input.claimToken,
      now,
    );
    const found = await findProfileByUser(tx, tenantId, userId);
    if (!found)
      throw new HttpError(
        403,
        "MEMBER_PROFILE_REQUIRED",
        "Daftar jadi member dulu untuk mengklaim poin.",
      );
    await withProfileLock(tx, tenantId, found.id);
    // Typed re-read under the lock, as the earn consumer does.
    const [profile] = await tx
      .select()
      .from(customerProfiles)
      .where(
        and(
          eq(customerProfiles.tenantId, tenantId),
          eq(customerProfiles.id, found.id),
        ),
      );
    if (!profile || profile.membershipStatus !== "active")
      throw new HttpError(
        403,
        "MEMBER_NOT_ACTIVE",
        "Keanggotaanmu belum aktif, jadi poin belum bisa diklaim.",
      );
    if (profile.whatsappVerifiedAt === null)
      throw new HttpError(
        403,
        "MEMBER_WHATSAPP_UNVERIFIED",
        "Verifikasi nomor WhatsApp dulu untuk mengklaim poin.",
      );
    if (!(await loyaltyConsentActive(tx, tenantId, profile.id, now)))
      throw new HttpError(
        403,
        "LOYALTY_CONSENT_REQUIRED",
        "Setujui program poin dulu untuk mengklaim poin.",
      );

    const program = await loadProgram(tx, tenantId);
    const units = await loadUnits(tx, tenantId, session.id, input.claimToken);
    const open = units.filter((unit) => isOpen(unit, now));
    const plan = await planPoints(tx, tenantId, program, profile, open);
    const toClaim = open.filter((unit) => (plan.get(unit.id) ?? 0) > 0);

    if (toClaim.length === 0) {
      // Nothing left to take: ok only if this member already took something
      // of this request (a repeat); never another member's claim.
      const redeemedIds = units
        .filter((unit) => unit.redeemedAt !== null)
        .map((unit) => unit.id);
      const mine = await ownClaims(tx, tenantId, profile.id, redeemedIds);
      if (mine.size === 0) throw notAvailable();
    }

    const expiryMonths = program?.expiryMonths ?? 0;
    let lost = false;
    for (const unit of toClaim) {
      const points = plan.get(unit.id) ?? 0;
      const redeemed =
        unit.kind === "split"
          ? await redeemSplit(tx, tenantId, unit.id, now)
          : await redeemOrder(tx, tenantId, unit.id, now);
      if (!redeemed) {
        lost = true;
        continue;
      }
      // The ledger event is tenant-wide (the member earns at many outlets),
      // and the guest context is outlet-scoped: post under a tenant-wide one.
      await postLedgerEntry(
        tx,
        memberTenantContext(tenantId),
        {
          tenantId,
          customerProfileId: profile.id,
          outletId: unit.outletId,
          type: "earn",
          points,
          sourceType: LEDGER_SOURCE,
          sourceId: unit.id,
          expiresAt: addMonthsUtc(unit.paidAt, expiryMonths),
          businessDate: unit.businessDate,
        },
        now,
      );
    }

    // A unit taken by a concurrent claim is a conflict: roll the request back
    // so this member never reports (or keeps) a part of someone else's claim.
    if (lost) throw notAvailable();

    const after = await loadUnits(tx, tenantId, session.id, input.claimToken);
    const result = await buildClaim(
      tx,
      tenantId,
      session.id,
      after,
      program,
      profile,
      userId,
      now,
    );
    // Every unit that could be taken was taken in this transaction (or by a
    // concurrent claim that won the row): a request that took nothing is a
    // conflict, not a result.
    if (toClaim.length > 0 && result.status === "unavailable")
      throw notAvailable();
    return result;
  });
}

/** Marks a split part redeemed; false when it is no longer claimable. */
async function redeemSplit(
  tx: Tx,
  tenantId: TenantId,
  splitId: string,
  now: Date,
): Promise<boolean> {
  const done = await tx
    .update(billSplits)
    .set({ claimRedeemedAt: now, updatedAt: now })
    .where(
      and(
        eq(billSplits.tenantId, tenantId),
        eq(billSplits.id, splitId),
        eq(billSplits.status, "paid"),
        isNull(billSplits.claimRedeemedAt),
        gt(billSplits.claimExpiresAt, now),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(orders)
            .where(
              and(
                eq(orders.tenantId, billSplits.tenantId),
                eq(orders.id, billSplits.orderId),
                or(
                  eq(orders.status, "voided"),
                  isNotNull(orders.customerProfileId),
                  orderRefunded(tenantId),
                  orderTraining(tenantId),
                ),
              ),
            ),
        ),
      ),
    )
    .returning({ id: billSplits.id });
  return done.length > 0;
}

/** Marks a whole-bill order's claim redeemed; false when it is not claimable. */
async function redeemOrder(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
  now: Date,
): Promise<boolean> {
  const done = await tx
    .update(orders)
    .set({ claimRedeemedAt: now, updatedAt: now })
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.id, orderId),
        isNotNull(orders.claimTokenHash),
        isNull(orders.claimRedeemedAt),
        gt(orders.claimExpiresAt, now),
        ne(orders.status, "voided"),
        isNull(orders.customerProfileId),
        sql`NOT ${orderRefunded(tenantId)}`,
        sql`NOT ${orderTraining(tenantId)}`,
      ),
    )
    .returning({ id: orders.id });
  return done.length > 0;
}
