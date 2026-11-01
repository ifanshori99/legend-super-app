// Mock mode handlers for the QR order journey (VITE_API_MOCK=true). All logic
// lives in mock-engine.ts; this file only binds it to the contract endpoints.
// Cookie `legend-mock-guest=1` makes the point claim ask the guest to sign in.
import { registerMock } from "@/lib/mock/registry";
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
import { createEngine } from "./mock-engine.ts";

const engine = createMockStore(() => createEngine());

function isGuest(): boolean {
  return (
    typeof document !== "undefined" &&
    /(?:^|;\s*)legend-mock-guest=1/.test(document.cookie)
  );
}

registerMock(getQrMenu, ({ params, scenario }) => {
  const menu = engine.get().menuFor(params.qrToken);
  if (scenario === "empty")
    return { data: { ...menu, items: [], categories: [] } };
  return { data: menu };
});

registerMock(openOrJoinTableSession, ({ body }) => ({
  data: engine.get().scan(body),
}));
registerMock(getTableSession, ({ params, scenario }) => ({
  data: engine.get().view(params.sessionId, scenario),
}));
registerMock(addCartLine, ({ params, body }) => ({
  data: engine.get().addLine(params.sessionId, body),
}));
registerMock(updateCartLine, ({ params, body }) => ({
  data: engine.get().updateLine(params.sessionId, params.lineId, body),
}));
registerMock(removeCartLine, ({ params, query }) => ({
  data: engine
    .get()
    .removeLine(params.sessionId, params.lineId, query.expectedCartVersion),
}));
registerMock(quoteTableSession, ({ params, body }) => ({
  data: engine.get().quote(params.sessionId, body),
}));
registerMock(placeQrOrder, ({ params, body }) => ({
  data: engine.get().place(params.sessionId, body),
}));
registerMock(getSessionBill, ({ params }) => ({
  data: engine.get().bill(params.sessionId),
}));
registerMock(createSessionSplits, ({ params, body }) => ({
  data: engine.get().createSplits(params.sessionId, body as never),
}));
registerMock(createServiceRequest, ({ params, body }) => ({
  data: engine.get().createRequest(params.sessionId, body),
}));
registerMock(getReviewEligibility, ({ params }) => ({
  data: engine.get().reviewEligibility(params.sessionId),
}));
registerMock(submitTableReview, ({ params, body }) => ({
  data: engine.get().submitReview(params.sessionId, body),
}));
registerMock(listSessionOrderIssues, ({ params, scenario }) => ({
  data: engine.get().issues(params.sessionId, scenario),
}));
registerMock(chooseOrderIssueResolution, ({ params, body }) => ({
  data: engine.get().chooseResolution(params.orderIssueId, body),
}));
registerMock(createGuestPayment, ({ params, body }) => ({
  data: engine.get().startPayment(params.sessionId, body),
}));
registerMock(getGuestPayment, ({ params }) => ({
  data: engine.get().getPayment(params.sessionId, params.paymentId),
}));
registerMock(getPointClaim, ({ params }) => ({
  data: engine.get().pointClaim(params.sessionId, isGuest()),
}));
registerMock(claimSessionPoints, ({ params }) => ({
  data: engine.get().claim(params.sessionId, isGuest()),
}));
registerMock(getMenuSuggestions, ({ params, query, scenario }) => ({
  data:
    scenario === "empty"
      ? []
      : engine.get().suggestions(params.sessionId, query.menuItemId),
}));
registerMock(getOrderEtas, ({ params }) => ({
  data: engine.get().orderEtas(params.sessionId),
}));
