// Mock mode handlers for the QR order journey (VITE_API_MOCK=true). All logic
// lives in mock-engine.ts; this file only binds it to the contract endpoints.
// POST .../splits/:splitId/claim answers with the claim status in a 200 (the
// shared contract), never a 409/410.
// Cookie `legend-mock-guest=1` makes the point claim ask the guest to sign in;
// `legend-mock-va=down` turns Virtual Account off in the payment options.
// `?mock=claim-login` serves an available point claim that requires sign-in.
// The engine snapshots itself (guest state + the shared floor state) into
// sessionStorage after every call, so a reload (or a second tab opened at the
// table) keeps the joined session, its cart and the floor board's view of it.
import type { AnyEndpoint } from "@starter/shared/api";
import { registerMock, type MockHandler } from "@/lib/mock/registry";
import type { Ws03Engine } from "@/lib/mock/ws03/engine";
import { ws03Store } from "@/lib/mock/ws03/store";
import {
  addCartLine,
  chooseOrderIssueResolution,
  claimSessionPoints,
  createGuestPayment,
  createServiceRequest,
  createSessionSplits,
  getGuestPayment,
  getGuestPaymentOptions,
  getMenuSuggestions,
  getOrderEtas,
  getPointClaim,
  getQrMenu,
  getReviewEligibility,
  getSplitClaim,
  getSessionBill,
  getTableSession,
  listSessionOrderIssues,
  openOrJoinTableSession,
  placeQrOrder,
  quoteTableSession,
  removeCartLine,
  submitTableReview,
  updateCartLine,
} from "@starter/shared/qr-order";
import { pointClaimFixture } from "@starter/shared/qr-order/sample";
import {
  createEngine,
  type MockDuitkuMode,
  type MockEngine,
  type QrEngineSnapshot,
} from "./mock-engine.ts";

const STORAGE_KEY = "legend-qr-mock-engine:v2";

/** sessionStorage in the browser only; the SSR server keeps a plain seed. */
function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

// The engine and the floor board/editor share one floor store. Deriving the
// engine from the store (instead of a second createMockStore) keeps one resetter
// and makes reset order irrelevant: a reseeded floor gets a fresh engine.
let engine: MockEngine | null = null;
let engineFloor: Ws03Engine | null = null;
let restored = false;

/** The engine for the current floor, hydrated once per page load. */
function store(): MockEngine {
  const floor = ws03Store.get();
  if (!engine || engineFloor !== floor) {
    engine = createEngine(Date.now, floor);
    engineFloor = floor;
  }
  const instance = engine;
  if (restored) return instance;
  restored = true;
  const storage = browserStorage();
  if (!storage) return instance;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw) instance.restore(JSON.parse(raw) as QrEngineSnapshot);
  } catch {
    // A stale or tampered snapshot must never break the mock: start clean.
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      // Storage blocked: nothing to clean.
    }
  }
  return instance;
}

function persist() {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(store().snapshot()));
  } catch {
    // Quota or private mode: the mock keeps working without reload memory.
  }
}

/** Registers a handler and snapshots the engine after each call (browser only). */
function handle<E extends AnyEndpoint>(endpoint: E, handler: MockHandler<E>) {
  registerMock(endpoint, async (context) => {
    const result = await handler(context);
    persist();
    return result;
  });
}

function isGuest(): boolean {
  return (
    typeof document !== "undefined" &&
    /(?:^|;\s*)legend-mock-guest=1/.test(document.cookie)
  );
}

/** Cookie `legend-mock-va=down`: the gateway reports VA as unavailable. */
function vaDown(): boolean {
  return (
    typeof document !== "undefined" &&
    /(?:^|;\s*)legend-mock-va=down/.test(document.cookie)
  );
}

/** Cookie `legend-mock-duitku=<mode>`: see MockDuitkuMode (C2b). */
function duitkuMode(): MockDuitkuMode {
  if (typeof document === "undefined") return "normal";
  const match = /(?:^|;\s*)legend-mock-duitku=([a-z-]+)/.exec(document.cookie);
  const mode = match?.[1];
  return mode === "partial" ||
    mode === "open-fail" ||
    mode === "pending" ||
    mode === "failed" ||
    mode === "expired"
    ? mode
    : "normal";
}

handle(getQrMenu, ({ params, scenario }) => {
  const menu = store().menuFor(params.qrToken);
  if (scenario === "empty")
    return { data: { ...menu, items: [], categories: [] } };
  return { data: menu };
});

handle(openOrJoinTableSession, ({ body }) => ({
  data: store().scan(body),
}));
handle(getTableSession, ({ params, scenario }) => ({
  data: store().view(params.sessionId, scenario),
}));
handle(addCartLine, ({ params, body }) => ({
  data: store().addLine(params.sessionId, body),
}));
handle(updateCartLine, ({ params, body }) => ({
  data: store().updateLine(params.sessionId, params.lineId, body),
}));
handle(removeCartLine, ({ params, query }) => ({
  data: store().removeLine(
    params.sessionId,
    params.lineId,
    query.expectedCartVersion,
  ),
}));
handle(quoteTableSession, ({ params, body }) => ({
  data: store().quote(params.sessionId, body),
}));
handle(placeQrOrder, ({ params, body }) => ({
  data: store().place(params.sessionId, body),
}));
handle(getSessionBill, ({ params }) => ({
  data: store().bill(params.sessionId),
}));
handle(createSessionSplits, ({ params, body }) => ({
  data: store().createSplits(params.sessionId, body as never),
}));
handle(createServiceRequest, ({ params, body }) => ({
  data: store().createRequest(params.sessionId, body),
}));
handle(getReviewEligibility, ({ params }) => ({
  data: store().reviewEligibility(params.sessionId),
}));
handle(submitTableReview, ({ params, body }) => ({
  data: store().submitReview(params.sessionId, body),
}));
handle(listSessionOrderIssues, ({ params, scenario }) => ({
  data: store().issues(params.sessionId, scenario),
}));
handle(chooseOrderIssueResolution, ({ params, body }) => ({
  data: store().chooseResolution(params.orderIssueId, body),
}));
handle(getGuestPaymentOptions, ({ params, scenario }) => ({
  data: store().paymentOptions(params.sessionId, {
    vaDown: vaDown(),
    emptyBanks: scenario === "empty",
    duitku: duitkuMode(),
  }),
}));
handle(createGuestPayment, ({ params, body }) => ({
  data: store().startPayment(params.sessionId, body, { duitku: duitkuMode() }),
}));
handle(getGuestPayment, ({ params }) => ({
  data: store().getPayment(params.sessionId, params.paymentId, {
    duitku: duitkuMode(),
  }),
}));
handle(getSplitClaim, ({ params, body }) => ({
  data: store().splitClaim(params.sessionId, params.splitId, body),
}));
handle(getPointClaim, ({ params, scenario }) => {
  // `?mock=claim-login` (legend-46vt): the claim is open but needs an account,
  // whatever the table has paid so far (P1 ships split and unpaid).
  if (scenario === "claim-login")
    return {
      data: {
        ...store().pointClaim(params.sessionId, true),
        status: "available" as const,
        paidIdr: pointClaimFixture.paidIdr,
        points: pointClaimFixture.points,
        claimableUntil: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        requiresLogin: true,
      },
    };
  return { data: store().pointClaim(params.sessionId, isGuest()) };
});
handle(claimSessionPoints, ({ params }) => ({
  data: store().claim(params.sessionId, isGuest()),
}));
handle(getMenuSuggestions, ({ params, query, scenario }) => ({
  data:
    scenario === "empty"
      ? []
      : store().suggestions(params.sessionId, query.menuItemId),
}));
handle(getOrderEtas, ({ params }) => ({
  data: store().orderEtas(params.sessionId),
}));
