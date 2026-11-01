// Mock mode handlers for the QR order journey (VITE_API_MOCK=true). All logic
// lives in mock-engine.ts; this file only binds it to the contract endpoints.
// Cookie `legend-mock-guest=1` makes the point claim ask the guest to sign in.
// The engine snapshots itself into sessionStorage after every call, so a reload
// (or a second tab opened at the table) keeps the joined session and its cart.
import type { AnyEndpoint } from "@starter/shared/api";
import { registerMock, type MockHandler } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import {
  addCartLine,
  chooseOrderIssueResolution,
  claimSessionPoints,
  createGuestPayment,
  createServiceRequest,
  createSessionSplits,
  getGuestPayment,
  getMenuSuggestions,
  getOrderEtas,
  getPointClaim,
  getQrMenu,
  getReviewEligibility,
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
import {
  createEngine,
  type MockEngine,
  type QrEngineSnapshot,
} from "./mock-engine.ts";

const STORAGE_KEY = "legend-qr-mock-engine:v1";

/** sessionStorage in the browser only; the SSR server keeps a plain seed. */
function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

const engine = createMockStore(() => createEngine());
let restored = false;

/** The engine, hydrated from the last snapshot once per page load. */
function store(): MockEngine {
  const instance = engine.get();
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
  data: engine
    .get()
    .removeLine(params.sessionId, params.lineId, query.expectedCartVersion),
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
handle(createGuestPayment, ({ params, body }) => ({
  data: store().startPayment(params.sessionId, body),
}));
handle(getGuestPayment, ({ params }) => ({
  data: store().getPayment(params.sessionId, params.paymentId),
}));
handle(getPointClaim, ({ params }) => ({
  data: store().pointClaim(params.sessionId, isGuest()),
}));
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
