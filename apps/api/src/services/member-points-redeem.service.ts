// Member "tukar poin" at the till, flow A (legend-0ne0z, contract
// @starter/shared/crm member-points-redeem). The member PWA lists the open
// bills the cashier attached to them, quotes how many points fit, mints a QR
// bound to one bill, one amount and the member's point-ledger version, and
// polls the outcome. Spending happens only at the POS
// (pos-points.service.ts `posPointsTenderSettlement`).
//
// Money rules (founder: nobody is paid more, the outlet never loses):
// - Every figure is the server's: remaining = total - deposit - captured
//   tenders (as pos-order-support `remainingIdr`), max points =
//   min(balance, floor(remaining / point value)), 0 when refused.
// - Ownership is filtered in SQL: tenant AND the session's customer profile.
//   Another member's or tenant's bill answers 404, never its figures.
// - Mint refuses what the POS would refuse (program, membership, member proof,
//   PT of the program, settled/voided bill, outlet offline, points > max) and
//   a second token while one for the bill is still live. The QR binds the
//   ledger version, so any balance move after mint refuses the redeem.

import { and, asc, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import {
  tenantIdSchema,
  ulidSchema,
  uuidToUlid,
  type OutletId,
} from "@starter/shared/core";
import type {
  MemberOpenBill,
  MemberPointsQuote,
  MemberPointsRedeemStatus,
  MemberPointsRefusal,
} from "@starter/shared/crm";
import { withProfileLock, type MemberScope } from "../db/member-scope.ts";
import {
  memberQrRedeemMints,
  memberQrRedeemNonces,
} from "../db/schema/crm-ledger.ts";
import { customerProfiles, loyaltyPrograms } from "../db/schema/crm-member.ts";
import { edgeNodeAlerts } from "../db/schema/edge-node-alert.ts";
import { edgeNodes } from "../db/schema/edge-node.ts";
import { floorZones, tables, tableSessions } from "../db/schema/floor.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { posOrders, posOrderTenders } from "../db/schema/pos-order.ts";
import { orders, type OrderStatus } from "../db/schema/qr-order.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  inspectMemberQrRedeemToken,
  issueMemberQrToken,
  MEMBER_QR_TOKEN_TTL_SECONDS,
  verifyMemberQrRedeemToken,
} from "../lib/member-qr-token.ts";
import { expirePointsForProfile } from "./loyalty-expiry.service.ts";
import type { Tx } from "./menu-internals.ts";
import {
  maxPointsFor,
  memberLedgerVersion,
  POS_MIN_REDEEM_POINTS,
} from "./pos-points.service.ts";

/** How the cashier attached the member that proves the member is present. */
const MEMBER_PROOF_VIA = ["member_qr", "pwa_session"] as const;
type ProofVia = (typeof MEMBER_PROOF_VIA)[number];
const isProofVia = (via: string | null): via is ProofVia =>
  via === "member_qr" || via === "pwa_session";

/** Statuses the POS takes a tender on (`canSettlePosOrder`). */
const SETTLEABLE_STATUSES: OrderStatus[] = ["awaiting_payment", "sent"];
const SETTLEABLE = new Set<string>(SETTLEABLE_STATUSES);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const billNotFound = () =>
  new HttpError(404, "ORDER_NOT_FOUND", "Tagihan tidak ditemukan.");

/** The order ULID behind a path or body id (ULID or its UUID form), else null. */
export function parseMemberOrderRef(raw: string): string | null {
  const ulid = ulidSchema.safeParse(raw);
  if (ulid.success) return ulid.data;
  return UUID_PATTERN.test(raw) ? uuidToUlid(raw) : null;
}

type Program = {
  isActive: boolean;
  pointValueIdr: number;
  legalEntityId: string | null;
};

type Bill = {
  id: string;
  number: string;
  status: string;
  totalIdr: number;
  depositAppliedIdr: number;
  outletId: OutletId;
  outletName: string;
  outletEntityId: string;
  attachedVia: string | null;
  attachedAt: Date | null;
  createdAt: Date;
  tableLabel: string | null;
  zoneName: string | null;
};

type Paid = {
  paidIdr: number;
  points: number;
  pointsIdr: number;
  redeemedAt: Date | null;
};

const NOTHING_PAID: Paid = {
  paidIdr: 0,
  points: 0,
  pointsIdr: 0,
  redeemedAt: null,
};

/** What the member's bills are judged against: one read per request. */
type Judge = {
  program: Program | null;
  /** The PT the program belongs to; null when it cannot be told (refuse). */
  programEntityId: string | null;
  membershipStatus: string;
  balance: number;
  offlineOutletIds: ReadonlySet<string>;
  edgeProcess: boolean;
};

const tenantOf = (scope: MemberScope) => tenantIdSchema.parse(scope.tenantId);

function profileOf(scope: MemberScope): string {
  if (!scope.customerProfileId)
    throw new HttpError(
      404,
      "CUSTOMER_NOT_FOUND",
      "Pelanggan tidak ditemukan.",
    );
  return scope.customerProfileId;
}

async function loadProgram(
  tx: Tx,
  scope: MemberScope,
): Promise<Program | null> {
  const [row] = await tx
    .select({
      isActive: loyaltyPrograms.isActive,
      pointValueIdr: loyaltyPrograms.pointValueIdr,
      legalEntityId: loyaltyPrograms.legalEntityId,
    })
    .from(loyaltyPrograms)
    .where(eq(loyaltyPrograms.tenantId, tenantOf(scope)));
  return row ?? null;
}

/**
 * The PT of the loyalty program, read without locks (the POS redeem re-checks
 * under its entity lock): the program's own PT, else the tenant's only PT,
 * else null (ambiguous: nothing is eligible).
 */
async function programEntityOf(
  tx: Tx,
  scope: MemberScope,
  program: Program | null,
): Promise<string | null> {
  if (program?.legalEntityId) return program.legalEntityId;
  const rows = await tx
    .selectDistinct({ legalEntityId: outlets.legalEntityId })
    .from(outlets)
    .where(eq(outlets.tenantId, tenantOf(scope)))
    .limit(2);
  return rows.length === 1 ? (rows[0]?.legalEntityId ?? null) : null;
}

/** Outlets whose active edge node has an open `edge_offline` alert. */
async function offlineOutlets(
  tx: Tx,
  scope: MemberScope,
  outletIds: readonly OutletId[],
): Promise<Set<string>> {
  if (outletIds.length === 0) return new Set();
  const tenantId = tenantOf(scope);
  const rows = await tx
    .selectDistinct({ outletId: edgeNodeAlerts.outletId })
    .from(edgeNodeAlerts)
    .innerJoin(
      edgeNodes,
      and(
        eq(edgeNodes.tenantId, edgeNodeAlerts.tenantId),
        eq(edgeNodes.id, edgeNodeAlerts.edgeNodeId),
      ),
    )
    .where(
      and(
        eq(edgeNodeAlerts.tenantId, tenantId),
        inArray(edgeNodeAlerts.outletId, [...outletIds]),
        eq(edgeNodeAlerts.kind, "edge_offline"),
        sql`${edgeNodeAlerts.resolvedAt} IS NULL`,
        eq(edgeNodes.status, "active"),
      ),
    );
  return new Set(rows.map((row) => row.outletId));
}

async function loadJudge(
  tx: Tx,
  scope: MemberScope,
  bills: readonly Bill[],
  profile: { pointsBalance: number; membershipStatus: string },
): Promise<Judge> {
  const program = await loadProgram(tx, scope);
  return {
    program,
    programEntityId: await programEntityOf(tx, scope, program),
    membershipStatus: profile.membershipStatus,
    balance: Number(profile.pointsBalance),
    offlineOutletIds: await offlineOutlets(tx, scope, [
      ...new Set(bills.map((bill) => bill.outletId)),
    ]),
    // An edge node cannot spend cloud points (POINTS_NEED_CLOUD).
    edgeProcess:
      getEdgeRuntimeState().edgeMode || process.env.EDGE_MODE === "true",
  };
}

async function readProfile(tx: Tx, scope: MemberScope) {
  const [row] = await tx
    .select({
      pointsBalance: customerProfiles.pointsBalance,
      membershipStatus: customerProfiles.membershipStatus,
    })
    .from(customerProfiles)
    .where(
      and(
        eq(customerProfiles.tenantId, tenantOf(scope)),
        eq(customerProfiles.id, profileOf(scope)),
      ),
    );
  if (!row)
    throw new HttpError(
      404,
      "CUSTOMER_NOT_FOUND",
      "Pelanggan tidak ditemukan.",
    );
  return row;
}

/** POS bills of the session's member (tenant and profile filtered in SQL; training bills excluded). */
async function loadBills(
  tx: Tx,
  scope: MemberScope,
  filter: { orderId: string } | { open: true },
): Promise<Bill[]> {
  const tenantId = tenantOf(scope);
  return tx
    .select({
      id: orders.id,
      number: orders.number,
      status: orders.status,
      totalIdr: orders.totalIdr,
      depositAppliedIdr: orders.depositAppliedIdr,
      outletId: orders.outletId,
      outletName: outlets.name,
      outletEntityId: outlets.legalEntityId,
      attachedVia: orders.customerAttachedVia,
      attachedAt: orders.customerAttachedAt,
      createdAt: orders.createdAt,
      tableLabel: tables.code,
      zoneName: floorZones.name,
    })
    .from(orders)
    .innerJoin(
      posOrders,
      and(
        eq(posOrders.tenantId, orders.tenantId),
        eq(posOrders.orderId, orders.id),
      ),
    )
    .innerJoin(
      outlets,
      and(
        eq(outlets.tenantId, orders.tenantId),
        eq(outlets.id, orders.outletId),
      ),
    )
    .leftJoin(
      tableSessions,
      and(
        eq(tableSessions.tenantId, orders.tenantId),
        eq(tableSessions.id, orders.tableSessionId),
      ),
    )
    .leftJoin(
      tables,
      and(
        eq(tables.tenantId, orders.tenantId),
        eq(tables.id, tableSessions.tableId),
      ),
    )
    .leftJoin(
      floorZones,
      and(
        eq(floorZones.tenantId, orders.tenantId),
        eq(floorZones.id, tables.zoneId),
      ),
    )
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.customerProfileId, profileOf(scope)),
        // Training bills are practice, not sales: never listed, never minted.
        eq(posOrders.isTraining, false),
        "orderId" in filter
          ? eq(orders.id, filter.orderId)
          : and(
              inArray(orders.status, SETTLEABLE_STATUSES),
              inArray(orders.customerAttachedVia, [...MEMBER_PROOF_VIA]),
            ),
      ),
    )
    .orderBy(desc(orders.createdAt), desc(orders.id));
}

/** Captured tenders per bill: all money in, and the points part of it. */
async function paidOf(
  tx: Tx,
  scope: MemberScope,
  orderIds: readonly string[],
): Promise<Map<string, Paid>> {
  if (orderIds.length === 0) return new Map();
  const rows = await tx
    .select({
      orderId: posOrderTenders.orderId,
      paidIdr: sql<string>`coalesce(sum(${posOrderTenders.amountIdr}), 0)`,
      points: sql<string>`coalesce(sum(${posOrderTenders.pointsUsed}) FILTER (WHERE ${posOrderTenders.method} = 'points'), 0)`,
      pointsIdr: sql<string>`coalesce(sum(${posOrderTenders.amountIdr}) FILTER (WHERE ${posOrderTenders.method} = 'points'), 0)`,
      redeemedAt: sql<
        string | Date | null
      >`max(${posOrderTenders.resolvedAt}) FILTER (WHERE ${posOrderTenders.method} = 'points')`,
    })
    .from(posOrderTenders)
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantOf(scope)),
        inArray(posOrderTenders.orderId, [...orderIds]),
        eq(posOrderTenders.status, "captured"),
      ),
    )
    .groupBy(posOrderTenders.orderId);
  return new Map(
    rows.map((row) => [
      row.orderId,
      {
        paidIdr: Number(row.paidIdr),
        points: Number(row.points),
        pointsIdr: Number(row.pointsIdr),
        redeemedAt: row.redeemedAt === null ? null : new Date(row.redeemedAt),
      },
    ]),
  );
}

const isFinal = (status: string) =>
  status === "completed" || status === "voided";

/** What is still owed (pos-order-support `remainingIdr`); 0 once final. */
function remainingOf(bill: Bill, paid: Paid): number {
  if (isFinal(bill.status)) return 0;
  return Math.max(
    0,
    Number(bill.totalIdr) - Number(bill.depositAppliedIdr) - paid.paidIdr,
  );
}

const entityOk = (bill: Bill, judge: Judge) =>
  judge.programEntityId !== null &&
  bill.outletEntityId === judge.programEntityId;

/** Why points cannot pay this bill now, or null. Strictest reason first. */
function refusalOf(
  bill: Bill,
  remaining: number,
  judge: Judge,
): MemberPointsRefusal | null {
  if (!judge.program?.isActive) return "program_inactive";
  if (judge.membershipStatus !== "active") return "membership_inactive";
  if (
    !isProofVia(bill.attachedVia) ||
    !entityOk(bill, judge) ||
    (bill.status !== "completed" && !SETTLEABLE.has(bill.status))
  )
    return "order_not_eligible";
  if (bill.status === "completed" || remaining <= 0) return "bill_settled";
  if (judge.edgeProcess || judge.offlineOutletIds.has(bill.outletId))
    return "outlet_offline";
  return null;
}

type Quoted = {
  bill: Bill;
  paid: Paid;
  remaining: number;
  refusal: MemberPointsRefusal | null;
  maxPoints: number;
  judge: Judge;
};

function quoteOf(bill: Bill, paid: Paid, judge: Judge): Quoted {
  const remaining = remainingOf(bill, paid);
  const refusal = refusalOf(bill, remaining, judge);
  const maxPoints =
    refusal === null && judge.program
      ? maxPointsFor(judge.balance, remaining, judge.program.pointValueIdr)
      : 0;
  return { bill, paid, remaining, refusal, maxPoints, judge };
}

/** One bill of the member, quoted; 404 for anything not theirs. */
async function quoteBill(
  tx: Tx,
  scope: MemberScope,
  rawOrderId: string,
  profile: { pointsBalance: number; membershipStatus: string },
): Promise<Quoted> {
  const orderId = parseMemberOrderRef(rawOrderId);
  if (!orderId) throw billNotFound();
  const [bill] = await loadBills(tx, scope, { orderId });
  if (!bill) throw billNotFound();
  const paid = (await paidOf(tx, scope, [bill.id])).get(bill.id);
  const judge = await loadJudge(tx, scope, [bill], profile);
  return quoteOf(bill, paid ?? NOTHING_PAID, judge);
}

/** GET /api/member/open-bills */
export async function listMemberOpenBills(
  tx: Tx,
  scope: MemberScope,
): Promise<MemberOpenBill[]> {
  const bills = await loadBills(tx, scope, { open: true });
  if (bills.length === 0) return [];
  const profile = await readProfile(tx, scope);
  const judge = await loadJudge(tx, scope, bills, profile);
  const paid = await paidOf(
    tx,
    scope,
    bills.map((bill) => bill.id),
  );
  return bills
    .filter((bill) => entityOk(bill, judge) && isProofVia(bill.attachedVia))
    .map((bill) => {
      const money = paid.get(bill.id) ?? NOTHING_PAID;
      return {
        orderId: bill.id,
        outletName: bill.outletName,
        outletArea: bill.zoneName,
        billNumber: bill.number,
        tableLabel: bill.tableLabel,
        totalIdr: Number(bill.totalIdr),
        paidIdr: money.paidIdr,
        remainingIdr: remainingOf(bill, money),
        attachedVia: isProofVia(bill.attachedVia)
          ? bill.attachedVia
          : "member_qr",
        attachedAt: (bill.attachedAt ?? bill.createdAt).toISOString(),
        pointsRedeemed:
          money.points > 0
            ? {
                points: money.points,
                discountIdr: money.pointsIdr,
                redeemedAt: (money.redeemedAt ?? bill.createdAt).toISOString(),
              }
            : null,
      };
    });
}

/** GET /api/member/open-bills/:orderId/points-quote */
export async function quoteMemberBillPoints(
  tx: Tx,
  scope: MemberScope,
  rawOrderId: string,
  now: Date,
): Promise<MemberPointsQuote> {
  const profile = await readProfile(tx, scope);
  const quoted = await quoteBill(tx, scope, rawOrderId, profile);
  const program = quoted.judge.program;
  if (!program)
    throw new HttpError(
      409,
      "POINTS_PROGRAM_MISSING",
      "Program poin belum tersedia.",
    );
  return {
    orderId: quoted.bill.id,
    balancePoints: Math.max(0, Number(profile.pointsBalance)),
    pointValueIdr: program.pointValueIdr,
    minPoints: POS_MIN_REDEEM_POINTS,
    maxPoints: quoted.maxPoints,
    remainingIdr: quoted.remaining,
    refusal: quoted.refusal,
    quotedAt: now.toISOString(),
  };
}

/** A minted token of this bill that can still pay: unexpired, unspent, current version. */
async function liveMintOf(
  tx: Tx,
  scope: MemberScope,
  orderId: string,
  ledgerVersion: number,
  now: Date,
): Promise<boolean> {
  const tenantId = tenantOf(scope);
  const [row] = await tx
    .select({ id: memberQrRedeemMints.id })
    .from(memberQrRedeemMints)
    .where(
      and(
        eq(memberQrRedeemMints.tenantId, tenantId),
        eq(memberQrRedeemMints.orderId, orderId),
        eq(memberQrRedeemMints.customerProfileId, profileOf(scope)),
        gt(memberQrRedeemMints.expiresAt, now),
        eq(memberQrRedeemMints.ledgerVersion, ledgerVersion),
        sql`NOT EXISTS (SELECT 1 FROM ${memberQrRedeemNonces}
              WHERE ${memberQrRedeemNonces.tenantId} = ${memberQrRedeemMints.tenantId}
                AND ${memberQrRedeemNonces.nonce} = ${memberQrRedeemMints.nonce})`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * POST /api/member/qr-token with { orderId, points }: checks the bill like the
 * POS will, binds the ledger version and records the mint. Every refusal is a
 * 4xx and writes nothing that spends.
 */
export async function mintMemberRedeemToken(
  tx: Tx,
  scope: MemberScope,
  input: { orderId: string; points: number },
  now: Date,
): Promise<{ token: string; expiresAt: string }> {
  const tenantId = tenantOf(scope);
  const profileId = profileOf(scope);
  // Lock order as the till (order row, then member): the mint insert below
  // takes a key share on the order row anyway (its foreign key), so take it
  // first. Taking the member first and the order after deadlocks with a till
  // that holds the order FOR UPDATE and waits for the member (a 500).
  const lockedOrderId = parseMemberOrderRef(input.orderId);
  if (lockedOrderId)
    await tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.id, lockedOrderId),
          eq(orders.customerProfileId, profileId),
        ),
      )
      .for("key share");
  // The profile lock serializes this member's mints (one bill has one
  // member), so two mints of one bill cannot both see "no live token".
  await withProfileLock(tx, tenantId, profileId);
  // Expired points must not be quoted (as the POS redeem): expire first, then
  // read the balance and the version under the same lock.
  await expirePointsForProfile(tx, tenantId, profileId, now);
  const profile = await withProfileLock(tx, tenantId, profileId);
  const quoted = await quoteBill(tx, scope, input.orderId, profile);
  if (quoted.refusal !== null)
    throw new HttpError(
      409,
      "POINTS_REDEEM_REFUSED",
      "Poin tidak bisa dipakai untuk tagihan ini.",
    );
  if (input.points < POS_MIN_REDEEM_POINTS || input.points > quoted.maxPoints)
    throw new HttpError(
      409,
      "POINTS_ABOVE_MAX",
      "Jumlah poin melebihi batas untuk tagihan ini.",
    );
  const ledgerVersion = await memberLedgerVersion(tx, tenantId, profileId);
  if (await liveMintOf(tx, scope, quoted.bill.id, ledgerVersion, now))
    throw new HttpError(
      409,
      "POINTS_QR_STILL_LIVE",
      "QR tukar poin untuk tagihan ini masih berlaku.",
    );
  const minted = issueMemberQrToken(
    {
      tenantId,
      customerProfileId: profileId,
      orderId: quoted.bill.id,
      points: input.points,
      ledgerVersion,
    },
    now,
  );
  const claims = verifyMemberQrRedeemToken(minted.token, tenantId, now);
  if (!claims) throw new Error("A freshly minted member QR did not verify");
  await tx.insert(memberQrRedeemMints).values({
    tenantId,
    outletId: quoted.bill.outletId,
    nonce: claims.nonce,
    orderId: quoted.bill.id,
    customerProfileId: profileId,
    points: input.points,
    ledgerVersion,
    expiresAt: new Date(minted.expiresAt),
    mintedAt: now,
  });
  return minted;
}

/** The points tender a spent QR (or the cashier on a PWA bill) created. */
async function pointsTenderOf(
  tx: Tx,
  scope: MemberScope,
  orderId: string,
  filter: { points: number } | { since: Date },
) {
  const [row] = await tx
    .select({
      points: posOrderTenders.pointsUsed,
      amountIdr: posOrderTenders.amountIdr,
    })
    .from(posOrderTenders)
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantOf(scope)),
        eq(posOrderTenders.orderId, orderId),
        eq(posOrderTenders.method, "points"),
        "points" in filter
          ? eq(posOrderTenders.pointsUsed, filter.points)
          : gte(posOrderTenders.requestedAt, filter.since),
      ),
    )
    .orderBy(
      "points" in filter
        ? desc(posOrderTenders.requestedAt)
        : asc(posOrderTenders.requestedAt),
    )
    .limit(1);
  return row ?? null;
}

/** POST /api/member/points-redeem/status */
export async function memberPointsRedeemStatus(
  tx: Tx,
  scope: MemberScope,
  input: { orderId: string; token: string },
  now: Date,
): Promise<MemberPointsRedeemStatus> {
  const tenantId = tenantOf(scope);
  const profileId = profileOf(scope);
  const profile = await readProfile(tx, scope);
  const quoted = await quoteBill(tx, scope, input.orderId, profile);
  const { bill } = quoted;
  const pointValueIdr = quoted.judge.program?.pointValueIdr ?? null;
  const base = {
    orderId: bill.id,
    remainingIdr: quoted.remaining,
    balancePoints: Math.max(0, Number(profile.pointsBalance)),
    checkedAt: now.toISOString(),
  };
  const invalid: MemberPointsRedeemStatus = {
    ...base,
    state: "invalid",
    points: null,
    discountIdr: null,
  };
  const claims = inspectMemberQrRedeemToken(input.token, tenantId, now);
  if (
    claims.state === "invalid" ||
    claims.customerProfileId !== profileId ||
    claims.orderId !== bill.id
  )
    return invalid;
  const [spent] = await tx
    .select({ points: memberQrRedeemNonces.points })
    .from(memberQrRedeemNonces)
    .where(
      and(
        eq(memberQrRedeemNonces.tenantId, tenantId),
        eq(memberQrRedeemNonces.nonce, claims.nonce),
        eq(memberQrRedeemNonces.orderId, bill.id),
        eq(memberQrRedeemNonces.customerProfileId, profileId),
      ),
    );
  const consumed = spent
    ? await pointsTenderOf(tx, scope, bill.id, { points: spent.points })
    : bill.attachedVia === "pwa_session"
      ? // A PWA-session bill needs no QR at the till: a points tender taken
        // after this token was minted is its outcome.
        await pointsTenderOf(tx, scope, bill.id, {
          since: new Date((claims.exp - MEMBER_QR_TOKEN_TTL_SECONDS) * 1000),
        })
      : null;
  if (spent || consumed) {
    const points = consumed?.points ?? spent?.points ?? claims.points;
    return {
      ...base,
      state: "consumed",
      points,
      discountIdr:
        consumed?.amountIdr !== undefined
          ? Number(consumed.amountIdr)
          : pointValueIdr === null
            ? null
            : points * pointValueIdr,
    };
  }
  const priced = {
    points: claims.points,
    discountIdr: pointValueIdr === null ? null : claims.points * pointValueIdr,
  };
  if (claims.state === "expired")
    return { ...base, state: "expired", ...priced };
  // Still signed and in time, but the POS would refuse it: the ledger moved
  // since mint, the bill can no longer take points, or no longer this many.
  if (
    claims.ledgerVersion === null ||
    claims.ledgerVersion !==
      (await memberLedgerVersion(tx, tenantId, profileId)) ||
    quoted.refusal !== null ||
    claims.points > quoted.maxPoints
  )
    return invalid;
  return { ...base, state: "pending", ...priced };
}
