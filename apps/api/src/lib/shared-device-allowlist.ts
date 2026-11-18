// Shared tablet API allowlist (legend-iq0jz, founder Q29, 18 Nov). A request
// of a session marked with a shared device (session.shared_device_ids, a mark
// never lapses, legend 1027) that reaches a router opted in with
// requireAuthAllowSharedDevice may only use what POS/kasir (incl. reservasi),
// floor and KDS use (Tanya AI at KDS is closed until legend-f7ybx). Everything else is closed by default: a
// route nobody listed here stays closed (403 SHARED_DEVICE_SCREEN_CLOSED).
// Routers that did not opt in are refused earlier by requireAuth
// (ACTING_STAFF_NOT_ALLOWED). Pure and synchronous; the mark question lives in
// middleware/shared-device-allowlist.ts. /api/auth has its own guard
// (middleware/shared-device-auth.ts) and is not listed here, except the idle
// keep-alive, which is a requireAuthAllowSharedDevice route.
//
// Patterns are fully anchored and match whole segments. Each carries the router
// it comes from, so a route change has one place to follow.

type Group = "pos" | "floor" | "kds" | "reservation" | "shell";
type Rule = {
  group: Group;
  methods: readonly string[] | "*";
  pattern: RegExp;
};

const ID = "[^/]+";
const OUTLET = `/api/outlets/${ID}`;
const rule = (
  group: Group,
  methods: readonly string[] | "*",
  pattern: string,
): Rule => ({ group, methods, pattern: new RegExp(`^${pattern}$`) });

// Checked before RULES: a route here stays closed even when a wildcard below
// opens it. Refund on a shared tablet is a founder decision, closed by default
// (sub-1094 round 3).
const DENY: readonly Rule[] = [
  // pos-order.routes.ts corrections/refund (inside the pos wildcard)
  rule("pos", ["POST"], `${OUTLET}/pos/orders/${ID}/corrections/refund`),
  // corrections/void of a paid order hands captured cash back out (founder Q63:
  // a cash void is a refund), so it is closed the same way.
  rule("pos", ["POST"], `${OUTLET}/pos/orders/${ID}/corrections/void`),
  // apology-voucher.routes.ts issue: settleIssueWithVoucher issues the voucher
  // and resolves the order issue, the same money shortcut as the closed resolve
  // routes. Closed for every body shape (with or without orderIssueId); the
  // look-up GET below stays open.
  rule("pos", ["POST"], "/api/apology-vouchers"),
  // order-recovery-charge.routes.ts waive/expire: a guest can pick the dearer
  // swap through customer-choice, then waive/expire drops the extra charge and
  // the item goes out free. Closed on a shared tablet; collect-at-pos stays open
  // below (it takes the money, never gives it away).
  rule("pos", ["POST"], `/api/order-issue-charges/${ID}/(?:waive|expire)`),
];

const RULES: readonly Rule[] = [
  // ---- pos -----------------------------------------------------------------
  // customer-display, pos-order, pos-parked-order, pos-receipt,
  // pos-receipt-writeoff, pos-shift routers (all mounted at /outlets/:id/pos).
  rule("pos", "*", `${OUTLET}/pos(?:/${ID})*`),
  // pos-order-customer.routes.ts
  rule("pos", ["PUT"], `/api/pos/orders/${ID}/customer`),
  // pos-acting-staff.routes.ts and device-pin.routes.ts (staffPinRouter: verify
  // only; PUT /staff-pins/:outletId/:userId is back office and stays closed).
  rule(
    "pos",
    ["POST"],
    "/api/staff-pins/(?:verify|pos-session|pos-session/end)",
  ),
  // device-pin.routes.ts posOverrideRouter
  rule(
    "pos",
    "*",
    `/api/pos-overrides(?:/${ID}|/approvals/${ID}|/approvals/${ID}/cancel)?`,
  ),
  // order-recovery.routes.ts (item issue, issue resolve/options/choice)
  rule("pos", ["POST"], `/api/order-items/${ID}/issues`),
  rule(
    "pos",
    "*",
    `/api/order-issues/${ID}/(?:resolve|options|customer-choice)`,
  ),
  // order-recovery-charge.routes.ts: collect-at-pos carries the cashier PIN
  // guard (requireActingStaffOnSharedDevice, actorOf; legend-i0ipj, legend-13vhb).
  // refund, waive and expire stay closed on a shared tablet (DENY above;
  // refund is a founder decision, sub-1094 round 2).
  rule("pos", ["POST"], `/api/order-issue-charges/${ID}/collect-at-pos`),
  // order-issues.routes.ts (remake / comp log)
  rule("pos", ["POST"], `${OUTLET}/orders/${ID}/issues`),
  rule("pos", ["GET"], `${OUTLET}/order-issues`),
  // apology-voucher.routes.ts (look up only; issue is in DENY)
  rule("pos", ["GET"], `/api/apology-vouchers/${ID}`),

  // ---- floor ---------------------------------------------------------------
  // floor.routes.ts floorRouter (GET /api/floor; zone/table/layout writes are
  // the floor editor and stay closed), outletFloorRouter, tablesRouter
  rule("floor", ["GET"], "/api/floor"),
  rule("floor", ["GET"], `${OUTLET}/floor`),
  rule("floor", ["POST"], `/api/tables/${ID}/(?:qr|status)`),
  // table-links.routes.ts
  rule("floor", ["POST"], "/api/table-links"),
  rule("floor", ["POST"], `/api/table-links/${ID}/unlink`),
  // table-sessions.routes.ts, qr-order.routes.ts, open-bill.routes.ts,
  // service-request.routes.ts (staff session actions; the guest routes there
  // skip requireAuth anyway)
  rule("floor", "*", `/api/table-sessions(?:/${ID})*`),
  // open-bill.routes.ts approvers and policy reads (PUT policy stays closed)
  rule("floor", ["GET"], `${OUTLET}/open-bill/approvers`),
  rule("floor", ["GET"], `${OUTLET}/open-bill-policy`),
  // service-request.routes.ts (captain calls; zone-waiter setup stays closed)
  rule("floor", ["GET"], `${OUTLET}/service-requests`),
  rule(
    "floor",
    ["POST"],
    `/api/service-requests/${ID}/(?:acknowledge|resolve)`,
  ),

  // ---- kds -----------------------------------------------------------------
  // kds.routes.ts. The station configuration writes (PUT /stations,
  // menu-loads, channel-pauses, capacity-rules PUT) are kitchen setup and stay
  // closed.
  rule(
    "kds",
    ["GET"],
    `${OUTLET}/kitchen/(?:stations|station-summary|station-labels|pacing|scanner-status|tickets/${ID}|stations/${ID}/(?:tickets|feed|board|capacity-rules))`,
  ),
  rule(
    "kds",
    ["POST"],
    `${OUTLET}/kitchen/(?:stations/${ID}/heartbeat|tickets/${ID}/(?:start|bump|recall|void)|ticket-items/${ID}/status)`,
  ),
  rule("kds", ["PATCH"], `${OUTLET}/kitchen/tickets/${ID}/priority`),
  // expo.routes.ts, pickup.routes.ts, serving-time.routes.ts
  rule("kds", ["GET"], `${OUTLET}/(?:expo|expo/runners|pickup-display)`),
  rule("kds", ["GET"], `${OUTLET}/serving-time-estimate`),
  rule("kds", ["POST"], `${OUTLET}/expo/${ID}/(?:runner|delivered)`),
  rule("kds", ["POST"], `${OUTLET}/pickup-calls/${ID}/(?:call|picked-up)`),
  // menu.routes.ts availability: the KDS "86" action lists the outlet's
  // records, then sets one sold out. PATCH (edit) stays closed.
  rule("kds", ["GET"], "/api/menu/availability"),
  rule("kds", ["POST"], `/api/menu/availability/${ID}/status`),

  // ---- reservation ---------------------------------------------------------
  // reservation.routes.ts (staff reads; the PIN guarded mutations), read only
  // reservation-policy.routes.ts. The public booking routes skip requireAuth.
  // Cancel stays open on a shared tablet (founder Q29) because the deposit
  // refund it triggers goes only to the original payer, as a pending request
  // that another person approves. The cashier never handles cash, and the
  // request body cannot name a different payee or amount.
  rule("reservation", ["GET"], `${OUTLET}/reservations`),
  rule("reservation", ["GET"], `${OUTLET}/reservations/${ID}`),
  rule(
    "reservation",
    "*",
    `${OUTLET}/reservations/${ID}/(?:tables|seat|cancel|deposit-link|no-show|deposit-remainder)`,
  ),
  rule("reservation", ["POST"], `${OUTLET}/reservation-customer-credit/apply`),

  // ---- shell (GET only unless noted) ---------------------------------------
  // me.routes.ts, called by the area layout and root loader.
  rule("shell", ["GET"], "/api/me/access"),
  // identity.routes.ts idle keep-alive of the caller's own session (legend-hlmbk).
  rule("shell", ["POST"], "/api/auth/sessions/current/activity"),
  // identity-push-devices.routes.ts (own list; revoke stays back office) and
  // notification.routes.ts removePush / getPushKey (a tablet removes only its
  // own subscription, legend 1024).
  rule("shell", ["GET"], "/api/identity/push-devices"),
  rule("shell", ["GET"], "/api/notifications/push-key"),
  rule("shell", ["DELETE"], `/api/notifications/push-subscriptions/${ID}`),
];

// Encoded dot/slash/backslash and dot segments are refused outright (matched
// before decoding, so a client cannot smuggle one past the patterns).
const FORBIDDEN = /\.\.|%2e|%2f|%5c|\/\/|\\/i;

/** Lower case, query dropped, one trailing slash dropped. Null: refuse. */
function normalize(rawPath: string): string | null {
  const bare = rawPath.split(/[?#]/, 1)[0] ?? "";
  if (FORBIDDEN.test(bare)) return null;
  const lower = bare.toLowerCase();
  return lower.length > 1 && lower.endsWith("/") ? lower.slice(0, -1) : lower;
}

/**
 * True when a shared tablet may call `method` on `path` (`req.originalUrl`,
 * query allowed). Default false.
 */
export function isSharedDeviceApiAllowed(
  method: string,
  path: string,
): boolean {
  if (matches(DENY, method, path)) return false;
  return matches(RULES, method, path);
}

function matches(rules: readonly Rule[], method: string, path: string) {
  const normalized = normalize(path);
  if (normalized === null) return false;
  const verb = method.toUpperCase();
  return rules.some(
    (r) =>
      (r.methods === "*" || r.methods.includes(verb)) &&
      r.pattern.test(normalized),
  );
}
