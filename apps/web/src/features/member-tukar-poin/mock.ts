// Mock mode for "tukar poin di kasir" (legend-0ne0z, flow A). Member Sari
// Wulandari (1.240 poin, Rp100 per poin) has an open bill at Cafe Legend. Bills
// and balance are derived from one store of redemptions, so a consumed QR shows
// up everywhere (bill, quote, status) the same way the real API would.
// Scenarios (lib/mock/control.ts): empty = no bill, points-consumed = the first
// status check reports the cashier scanned the QR, points-redeemed = the bill
// already had 500 poin redeemed, points-mint-fail = minting the QR fails with
// 503, points-multi-bill = two open bills. slow/offline/error are central.
import {
  getMemberPointsQuote,
  getMemberPointsRedeemStatus,
  listMemberOpenBills,
} from "@starter/shared/crm";
import type {
  MemberOpenBill,
  MemberPointsQuote,
  MemberPointsRedeemStatus,
} from "@starter/shared/crm";
import { ApiError } from "@/lib/api/errors";
import type { MockScenario } from "@/lib/mock/control";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";

const POINT_VALUE_IDR = 100;
const START_BALANCE = 1_240;
const TOKEN_TTL_MS = 120_000;

const loadedAt = Date.now();
const attachedAt = new Date(loadedAt - 8 * 60_000).toISOString();
const seededRedeemedAt = new Date(loadedAt - 4 * 60_000).toISOString();

const MAIN_ORDER_ID = "mock-order-lg-0248";
const SECOND_ORDER_ID = "mock-order-lg-0251";

type BaseBill = Omit<MemberOpenBill, "pointsRedeemed" | "remainingIdr">;

const mainBill: BaseBill = {
  orderId: MAIN_ORDER_ID,
  outletName: "Cafe Legend",
  outletArea: "Kemang",
  billNumber: "LG-0248",
  tableLabel: "08",
  totalIdr: 185_000,
  paidIdr: 0,
  attachedVia: "member_qr",
  attachedAt,
};
const secondBill: BaseBill = {
  orderId: SECOND_ORDER_ID,
  outletName: "Cafe Legend",
  outletArea: "Senopati",
  billNumber: "LG-0251",
  tableLabel: "03",
  totalIdr: 92_000,
  paidIdr: 0,
  attachedVia: "pwa_session",
  attachedAt,
};

type Redemption = {
  points: number;
  discountIdr: number;
  redeemedAt: string;
  /** Token the cashier scanned; null for a redemption that was already there. */
  token: string | null;
};

type IssuedToken = { orderId: string; points: number; expiresAtMs: number };

const redemptions = createMockStore(() => new Map<string, Redemption>());
const tokens = createMockStore(() => new Map<string, IssuedToken>());
let tokenCounter = 0;

function allRedemptions(scenario: MockScenario) {
  const map = new Map(redemptions.get());
  if (scenario === "points-redeemed" && !map.has(MAIN_ORDER_ID))
    map.set(MAIN_ORDER_ID, {
      points: 500,
      discountIdr: 500 * POINT_VALUE_IDR,
      redeemedAt: seededRedeemedAt,
      token: null,
    });
  return map;
}

function snapshot(scenario: MockScenario) {
  const done = allRedemptions(scenario);
  const base: BaseBill[] =
    scenario === "empty"
      ? []
      : scenario === "points-multi-bill"
        ? [mainBill, secondBill]
        : [mainBill];
  const bills: MemberOpenBill[] = base.map((bill) => {
    const redeemed = done.get(bill.orderId);
    return {
      ...bill,
      remainingIdr: Math.max(
        0,
        bill.totalIdr - bill.paidIdr - (redeemed?.discountIdr ?? 0),
      ),
      pointsRedeemed: redeemed
        ? {
            points: redeemed.points,
            discountIdr: redeemed.discountIdr,
            redeemedAt: redeemed.redeemedAt,
          }
        : null,
    };
  });
  let balance = START_BALANCE;
  for (const redeemed of done.values()) balance -= redeemed.points;
  return { bills, balance: Math.max(0, balance), done };
}

function quoteFor(bill: MemberOpenBill, balance: number): MemberPointsQuote {
  const refusal: MemberPointsQuote["refusal"] =
    bill.pointsRedeemed !== null
      ? "order_not_eligible"
      : bill.remainingIdr === 0
        ? "bill_settled"
        : null;
  return {
    orderId: bill.orderId,
    balancePoints: balance,
    pointValueIdr: POINT_VALUE_IDR,
    minPoints: 1,
    maxPoints:
      refusal === null
        ? Math.min(balance, Math.floor(bill.remainingIdr / POINT_VALUE_IDR))
        : 0,
    remainingIdr: bill.remainingIdr,
    refusal,
    quotedAt: new Date().toISOString(),
  };
}

/**
 * Points already spent at the cashier (consumed QR or a seeded redemption), so
 * the member overview on the points page shows the same balance as the quote.
 */
export function redeemedPointsTotal(scenario: MockScenario) {
  let total = 0;
  for (const redeemed of allRedemptions(scenario).values())
    total += redeemed.points;
  return total;
}

registerMock(listMemberOpenBills, ({ scenario }) => ({
  data: snapshot(scenario).bills,
}));

registerMock(getMemberPointsQuote, ({ params, scenario }) => {
  const { bills, balance } = snapshot(scenario);
  const bill = bills.find((item) => item.orderId === params.orderId);
  if (!bill) throw new ApiError(404, "NOT_FOUND", "Tagihan tidak ditemukan.");
  return { data: quoteFor(bill, balance) };
});

/**
 * Mints a points QR token for one bill (called by the member QR mock in
 * features/ws08-member/mock.ts, which owns POST /api/member/qr-token). Checks the
 * amount against the same quote the picker used.
 */
export function mintRedeemMockToken(
  input: { orderId: string; points: number },
  scenario: MockScenario,
) {
  if (scenario === "points-mint-fail")
    throw new ApiError(
      503,
      "SERVICE_UNAVAILABLE",
      "QR belum bisa dibuat. Coba lagi sebentar lagi.",
    );
  const { bills, balance } = snapshot(scenario);
  const bill = bills.find((item) => item.orderId === input.orderId);
  if (!bill) throw new ApiError(404, "NOT_FOUND", "Tagihan tidak ditemukan.");
  const quote = quoteFor(bill, balance);
  if (
    quote.refusal !== null ||
    input.points < quote.minPoints ||
    input.points > quote.maxPoints
  )
    throw new ApiError(
      409,
      "CONFLICT",
      "Jumlah poin tidak bisa ditukar untuk tagihan ini.",
    );
  tokenCounter += 1;
  const token = `mock.redeem.${tokenCounter}.${Date.now().toString(36)}`;
  const expiresAtMs = Date.now() + TOKEN_TTL_MS;
  tokens.get().set(token, {
    orderId: input.orderId,
    points: input.points,
    expiresAtMs,
  });
  return { data: { token, expiresAt: new Date(expiresAtMs).toISOString() } };
}

registerMock(getMemberPointsRedeemStatus, ({ body, scenario }) => {
  const checkedAt = new Date().toISOString();
  const issued = tokens.get().get(body.token);
  const respond = (
    state: MemberPointsRedeemStatus["state"],
    done?: Redemption,
  ) => {
    const current = snapshot(scenario);
    const bill = current.bills.find((item) => item.orderId === body.orderId);
    return {
      data: {
        orderId: body.orderId,
        state,
        points: done?.points ?? null,
        discountIdr: done?.discountIdr ?? null,
        remainingIdr: bill?.remainingIdr ?? 0,
        balancePoints: current.balance,
        checkedAt,
      },
    };
  };
  if (!issued || issued.orderId !== body.orderId) return respond("invalid");

  const existing = redemptions.get().get(issued.orderId);
  if (existing && existing.token === body.token)
    return respond("consumed", existing);

  if (scenario === "points-consumed" && !existing) {
    const consumed: Redemption = {
      points: issued.points,
      discountIdr: issued.points * POINT_VALUE_IDR,
      redeemedAt: checkedAt,
      token: body.token,
    };
    redemptions.get().set(issued.orderId, consumed);
    return respond("consumed", consumed);
  }
  return respond(Date.now() >= issued.expiresAtMs ? "expired" : "pending");
});
