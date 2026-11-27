// Mock handlers for VITE_API_MOCK=true: the paired second screen reads the
// customer-display state from the POS fixtures (@starter/shared/pos), so the
// screen works without an API (docs/frontend.md, "Typed endpoints and mock
// mode"). The handler behaves like the live service:
//   - the QRIS is a dynamic DOIT code that expires; a read after expiry
//     returns a fresh code (PRD §3 F13 "QRIS Dinamis"),
//   - the state machine offers the states the contract allows,
//   - totals stay the fixture's: subtotal − discount + service + tax + rounding.
//
// Demo switch (browser only, same idea as the edge mock override): set
//   localStorage["legend-display-mock"] = "unpaired" | "idle" | "ordering" |
//     "awaiting_payment" | "awaiting_expired" | "awaiting_loading" |
//     "awaiting_deposit" | "awaiting_duitku" | "awaiting_va_fee" |
//     "awaiting_ewallet" | "paid"
// and reload. The default is a live bill awaiting QRIS payment — the screen's
// main purpose. "awaiting_expired" serves one expired code so the refresh path
// can be exercised, then continues with a fresh one. "awaiting_loading" keeps
// the code unissued (qris null) so the "preparing the code" panel shows.
// "awaiting_deposit" is an order with a DP: its orderId resolves, in the POS
// kasir mock, to the order with a Rp100.000 deposit, so the screen shows "pay
// at the cashier" and no QR. "awaiting_duitku" is a QRIS issued by the Duitku
// provider, so the screen shows the "Duitku" label instead of "DOIT" (brief
// 936, bead legend-5w6). Every other demo's orderId resolves to an order
// without a deposit (the display reads the order's deposit; sub-539-u2).
// "awaiting_va_fee" is a cashier VA with a guest service fee (1272 K4): the
// bill, the fee and the total paid; "awaiting_ewallet" an e-wallet without.
import {
  cafeLegendPosFixtures,
  getCustomerDisplayState,
} from "@starter/shared/pos";
import type {
  customerDisplayQrisSchema,
  customerDisplayStateSchema,
} from "@starter/shared/pos";
import type { z } from "zod";
import { qrisPendingIntentFixture } from "@starter/shared/payment";
import { registerMock } from "../../lib/mock/registry.ts";
import {
  DEMO_CODE_ORDER_ULID,
  DEMO_ORDER_ULID,
} from "../ws04-pos-kasir/demo-seed.ts";
import { createMockStore } from "../../lib/mock/store.ts";

/** Wire shapes: the handler returns the input side of the response schema. */
type DisplayStateWire = z.input<typeof customerDisplayStateSchema>;
type DisplayQrisWire = z.input<typeof customerDisplayQrisSchema>;

const fixture = cafeLegendPosFixtures.customerDisplayState;

/** DOIT's dynamic QRIS lives about ten minutes (PRD §3 F13). */
const QRIS_LIFETIME_MS = 10 * 60_000;
/** EMVCo payload from the payment fixtures; the display only renders it. */
const QRIS_PAYLOAD = qrisPendingIntentFixture.instructions.qrPayload;

const DEMO_KEY = "legend-display-mock";
const DEMO_STATES = [
  "unpaired",
  "idle",
  "ordering",
  "awaiting_payment",
  "awaiting_expired",
  "awaiting_loading",
  "awaiting_deposit",
  "awaiting_duitku",
  "awaiting_va_fee",
  "awaiting_ewallet",
  "paid",
] as const;
type DemoState = (typeof DEMO_STATES)[number];

function readDemo(): DemoState {
  if (typeof window === "undefined") return "awaiting_payment";
  try {
    const value = window.localStorage.getItem(DEMO_KEY);
    return DEMO_STATES.includes(value as DemoState)
      ? (value as DemoState)
      : "awaiting_payment";
  } catch {
    // Storage blocked: the screen still works on the default state.
    return "awaiting_payment";
  }
}

type DisplayStore = {
  demo: DemoState;
  /** One expired read is enough to prove the refresh; then go live again. */
  expiredServed: boolean;
  version: number;
};

const store = createMockStore<DisplayStore>(() => ({
  demo: readDemo(),
  expiredServed: false,
  version: fixture.version,
}));

/** Order without a deposit (POS kasir mock "LG-0044") and the DP order (POS-0048). */
const ORDER_NO_DEPOSIT = DEMO_CODE_ORDER_ULID;
const ORDER_WITH_DEPOSIT = DEMO_ORDER_ULID;

const billTotals = {
  lines: fixture.lines,
  subtotalIdr: fixture.subtotalIdr,
  discountIdr: fixture.discountIdr,
  serviceChargeIdr: fixture.serviceChargeIdr,
  taxIdr: fixture.taxIdr,
  roundingIdr: fixture.roundingIdr,
  totalIdr: fixture.totalIdr,
};

function qrisAt(
  nowMs: number,
  expired: boolean,
  provider: DisplayQrisWire["provider"] = "doit",
): DisplayQrisWire {
  return {
    provider,
    amountIdr: fixture.totalIdr,
    payload: QRIS_PAYLOAD,
    expiresAt: new Date(
      nowMs + (expired ? -1_000 : QRIS_LIFETIME_MS),
    ).toISOString(),
  };
}

/** The snapshot the service would push to the paired display. */
function buildState(entry: DisplayStore, nowMs: number): DisplayStateWire {
  const base = {
    tenantId: fixture.tenantId,
    outletId: fixture.outletId,
    terminalDeviceId: fixture.terminalDeviceId,
    displayDeviceId: fixture.displayDeviceId,
    version: entry.version,
    updatedAt: new Date(nowMs).toISOString(),
    promotions: [],
    pairingCode: null,
  };
  if (entry.demo === "idle" || entry.demo === "unpaired")
    return {
      ...base,
      terminalDeviceId:
        entry.demo === "unpaired" ? null : base.terminalDeviceId,
      state: "idle",
      pairingCode: entry.demo === "unpaired" ? "012345" : null,
      promotions:
        entry.demo === "idle"
          ? [
              {
                title: "Promo Kopi Sore",
                body: "Nikmati pilihan kopi favorit di sore hari.",
                validUntil: "2026-12-31T16:59:59.000Z",
              },
            ]
          : [],
      orderId: null,
      orderNumber: null,
      lines: [],
      subtotalIdr: 0,
      discountIdr: 0,
      serviceChargeIdr: 0,
      taxIdr: 0,
      roundingIdr: 0,
      totalIdr: 0,
      qris: null,
      tenders: [],
      changeIdr: null,
    };
  if (entry.demo === "paid")
    return {
      ...base,
      state: "paid",
      orderId: ORDER_NO_DEPOSIT,
      orderNumber: fixture.orderNumber,
      ...billTotals,
      qris: null,
      tenders: fixture.tenders,
      changeIdr: fixture.changeIdr,
    };
  if (entry.demo === "ordering")
    return {
      ...base,
      state: "ordering",
      orderId: ORDER_NO_DEPOSIT,
      orderNumber: fixture.orderNumber,
      ...billTotals,
      qris: null,
      tenders: [],
      changeIdr: null,
    };
  if (entry.demo === "awaiting_va_fee" || entry.demo === "awaiting_ewallet") {
    const expiresAt = new Date(nowMs + QRIS_LIFETIME_MS).toISOString();
    // Demo fee: Duitku VA flat Rp4.000 grossed up on the bill (mock only).
    const guestFeeIdr = 4_000;
    return {
      ...base,
      state: "awaiting_payment",
      orderId: ORDER_NO_DEPOSIT,
      orderNumber: fixture.orderNumber,
      ...billTotals,
      qris: null,
      onlineCode:
        entry.demo === "awaiting_va_fee"
          ? {
              amountIdr: fixture.totalIdr,
              instructions: {
                method: "va",
                channelCode: "BC",
                channelName: "BCA Virtual Account",
                virtualAccountNumber: "8808123456789012",
              },
              expiresAt,
              guestFeeIdr,
              chargedIdr: fixture.totalIdr + guestFeeIdr,
            }
          : {
              amountIdr: fixture.totalIdr,
              instructions: {
                method: "ewallet",
                channelCode: "OV",
                channelName: "OVO",
                paymentUrl: "https://sandbox.duitku.com/demo/pay/display",
              },
              expiresAt,
            },
      tenders: [],
      changeIdr: null,
    };
  }
  const expired = entry.demo === "awaiting_expired" && !entry.expiredServed;
  return {
    ...base,
    state: "awaiting_payment",
    orderId:
      entry.demo === "awaiting_deposit" ? ORDER_WITH_DEPOSIT : ORDER_NO_DEPOSIT,
    orderNumber: fixture.orderNumber,
    ...billTotals,
    qris:
      entry.demo === "awaiting_loading"
        ? null
        : qrisAt(
            nowMs,
            expired,
            entry.demo === "awaiting_duitku" ? "duitku" : "doit",
          ),
    tenders: [],
    changeIdr: null,
  };
}

registerMock(getCustomerDisplayState, ({ scenario }) => {
  const nowMs = Date.now();
  if (scenario === "empty") {
    // The idle screen: no bill open on the paired terminal.
    return { data: buildState({ ...store.get(), demo: "idle" }, nowMs) };
  }
  const entry = store.get();
  const state = buildState(entry, nowMs);
  if (entry.demo === "awaiting_expired" && !entry.expiredServed)
    // The next read (the screen refetches at expiry) gets a live code.
    store.set({
      ...entry,
      demo: "awaiting_payment",
      expiredServed: true,
      version: entry.version + 1,
    });
  return { data: state };
});
