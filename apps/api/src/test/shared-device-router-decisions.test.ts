// legend-3z0ds (brief 1012): every router file must carry an explicit shared-device
// decision, so a new router cannot silently skip the guard. Static contract, no DB.
// Written from the card brief, not from the implementation.
//
// How to choose for a NEW apps/api/src/routes/<name>.routes.ts, then add it to DECISIONS:
//  - "pos"        used by a cashier on a shared POS device: `requireAuthAllowSharedDevice`,
//                 then `resolveActingStaff` and `requireActingStaffOnSharedDevice`
//                 right after origin + tenant context and before permission guards.
//  - "shell"      identity reader, PIN token issuer or emergency route that must work on a
//                 shared device without a cashier token: `requireAuthAllowSharedDevice`
//                 only.
//  - "backoffice" owner or manager screens: plain `requireAuth` (default-deny on a
//                 session used on a shared device). Must never use
//                 `requireAuthAllowSharedDevice`.
//  - "public"     no login session at all (webhooks, device-token edge, QR guest, health):
//                 no `requireAuth` and no `requireAuthAllowSharedDevice`.
//
// Assumptions:
//  - `emergency` is "public": emergency.routes.ts opens a receiver session from a device
//    token + PIN and never uses the login session (it has no `requireAuth`). Only
//    `emergency-cloud` (acknowledge/resolve are manager actions, not cashier ones) is
//    "backoffice" (round 2 decision of legend-3z0ds).
//  - `notification` and `me` are "shell" at file level although most of their routes stay
//    strict; only per-route opt-ins are lenient. In `notification` the opt-in removePush
//    is further limited: on a shared-device session it deletes only the subscription of
//    that session or that device (legend 1024). The per-occurrence rules below apply to
//    "pos" files only.
//  - platform-* files that use `requirePlatformAuth` are "backoffice"; platform-brand,
//    platform-text-overrides and platform-tls carry no auth middleware of their own and
//    are "public" (decided by "no requireAuth literal").
//  - Comments are stripped before the source checks, so a comment cannot satisfy or
//    break a rule.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Decision = "pos" | "shell" | "backoffice" | "public";

const DECISIONS: Record<string, Decision> = {
  access: "backoffice",
  accounting: "backoffice",
  "accounting-ap-fa": "backoffice",
  "accounting-bank-accounts": "backoffice",
  "accounting-bank-lines": "backoffice",
  "accounting-bank-recon-cases": "backoffice",
  "accounting-bank-statements": "backoffice",
  "accounting-cash-bank-entries": "backoffice",
  "accounting-cash-deposits": "backoffice",
  "accounting-finance-exceptions": "backoffice",
  "accounting-finance-policy": "backoffice",
  "accounting-journal": "backoffice",
  "accounting-legal-entities": "backoffice",
  "accounting-petty-cash": "backoffice",
  "ai-actions": "backoffice",
  "ai-chat": "backoffice",
  "ai-chatgpt": "backoffice",
  "ai-governance": "backoffice",
  "ai-guidelines": "backoffice",
  "ai-insights": "backoffice",
  "ai-mcp-admin": "backoffice",
  "ai-provider": "backoffice",
  "apology-voucher": "pos",
  "audit-events": "backoffice",
  "core-storage": "backoffice",
  "crm-promo": "backoffice",
  "customer-display": "pos",
  "customer-review": "backoffice",
  customers: "backoffice",
  dashboards: "backoffice",
  "delivery-channels": "backoffice",
  "delivery-orders": "pos",
  "delivery-reconciliation": "backoffice",
  "delivery-webhook": "public",
  device: "backoffice",
  "device-pin": "pos",
  edge: "backoffice",
  "edge-bootstrap": "public",
  "edge-catalog-sync": "public",
  "edge-device": "backoffice",
  "edge-device-sync": "public",
  "edge-node-status": "backoffice",
  "edge-nodes": "backoffice",
  "edge-people-snapshot": "public",
  "edge-print": "backoffice",
  "edge-reconciliation": "backoffice",
  "edge-selfie-receive": "public",
  "edge-sync-conflicts": "backoffice",
  "edge-wifi": "backoffice",
  emergency: "public",
  "emergency-cloud": "backoffice",
  "emergency-press": "public",
  expo: "pos",
  facility: "backoffice",
  "facility-breakfast": "backoffice",
  "facility-customer": "backoffice",
  "facility-entitlement": "backoffice",
  "facility-incidents": "backoffice",
  "facility-pos-ticket": "pos",
  feedback: "backoffice",
  floor: "pos",
  health: "public",
  hris: "backoffice",
  "hris-announcement": "backoffice",
  "hris-attendance": "backoffice",
  "hris-attendance-admin": "backoffice",
  "hris-attendance-correction": "backoffice",
  "hris-checklist": "backoffice",
  "hris-kpi": "backoffice",
  "hris-leave": "backoffice",
  "hris-offboarding": "backoffice",
  "hris-payslip": "backoffice",
  "hris-scheduling": "backoffice",
  "hris-sop": "backoffice",
  "hris-training": "backoffice",
  "hris-work-certificate": "backoffice",
  identity: "backoffice",
  "identity-auth": "public",
  "identity-push-devices": "shell",
  "identity-wa-unlink": "backoffice",
  "identity-wa-webhook": "public",
  inventory: "backoffice",
  "inventory-count": "backoffice",
  "inventory-hpp": "backoffice",
  "inventory-ops": "backoffice",
  "inventory-receiving": "backoffice",
  "inventory-setup": "backoffice",
  kds: "pos",
  "loyalty-program": "backoffice",
  "loyalty-rewards": "backoffice",
  "loyalty-tiers": "backoffice",
  mcp: "public",
  me: "shell",
  member: "backoffice",
  "member-feedback": "backoffice",
  "member-rewards": "backoffice",
  menu: "pos",
  "menu-import": "backoffice",
  "menu-recommendation": "backoffice",
  metrics: "backoffice",
  notification: "shell",
  "open-bill": "pos",
  operations: "backoffice",
  "operations-equipment": "backoffice",
  "ops-outbox": "backoffice",
  "order-issues": "pos",
  "order-recovery": "pos",
  "order-recovery-charge": "pos",
  org: "backoffice",
  "org-config": "backoffice",
  "org-themes": "backoffice",
  "password-reset": "public",
  payment: "backoffice",
  "payment-admin": "backoffice",
  "payment-recurring": "backoffice",
  "payment-webhook": "public",
  "payroll-components": "backoffice",
  "payroll-export": "backoffice",
  "payroll-loan-policy": "backoffice",
  "payroll-loans": "backoffice",
  "payroll-payout": "backoffice",
  "payroll-payout-correction": "backoffice",
  "payroll-payout-dispute": "backoffice",
  "payroll-payout-evidence": "backoffice",
  "payroll-payout-overpaid": "backoffice",
  "payroll-payout-proof-closure": "backoffice",
  "payroll-payout-recon-clearance": "backoffice",
  "payroll-payout-recon-hold": "backoffice",
  "payroll-payout-return": "backoffice",
  "payroll-payout-return-withdraw": "backoffice",
  "payroll-policy": "backoffice",
  "payroll-pph21-policy": "backoffice",
  "payroll-rapel": "backoffice",
  "payroll-reimbursements": "backoffice",
  "payroll-runs": "backoffice",
  "payroll-service-charge": "backoffice",
  "payroll-statutory": "backoffice",
  "petty-purchase": "backoffice",
  pickup: "pos",
  platform: "backoffice",
  "platform-approval": "backoffice",
  "platform-brand": "public",
  "platform-config": "backoffice",
  "platform-integrations": "backoffice",
  "platform-kirimdev-senders": "backoffice",
  "platform-payment-gateways": "backoffice",
  "platform-tenant-directory": "backoffice",
  "platform-tenant-resources": "backoffice",
  "platform-text-overrides": "public",
  "platform-tls": "public",
  "pos-acting-staff": "shell",
  "pos-order": "pos",
  "pos-order-customer": "pos",
  "pos-parked-order": "pos",
  "pos-points": "pos",
  "pos-receipt": "pos",
  "pos-receipt-writeoff": "backoffice",
  "pos-shift": "pos",
  printer: "backoffice",
  "profit-share-distribution": "backoffice",
  "profit-share-recipient-reconcile": "backoffice",
  "profit-share-registry": "backoffice",
  "public-site": "public",
  "purchase-return": "backoffice",
  "purchasing-invoice": "backoffice",
  "purchasing-order": "backoffice",
  "purchasing-receipt-journalize": "backoffice",
  "purchasing-send": "backoffice",
  "purchasing-supplier": "backoffice",
  qr: "public",
  "qr-order": "public",
  recipe: "backoffice",
  reports: "backoffice",
  reservation: "backoffice",
  "reservation-policy": "backoffice",
  "reservation-public": "backoffice",
  "sales-targets": "backoffice",
  segments: "backoffice",
  "service-request": "pos",
  "serving-time": "pos",
  "shareholder-documents": "backoffice",
  "staff-pin-sync": "public",
  "storage-api": "backoffice",
  "table-links": "pos",
  "table-sessions": "pos",
  tax: "backoffice",
  "text-consent": "backoffice",
  "website-admin": "backoffice",
  wifi: "backoffice",
  "wifi-guest": "backoffice",
};

const ROUTES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "routes",
);
const SUFFIX = ".routes.ts";

const routeFiles = readdirSync(ROUTES_DIR)
  .filter((name) => name.endsWith(SUFFIX))
  .map((name) => name.slice(0, -SUFFIX.length))
  .sort();

/** Source without block comments and whole-line comments. */
function codeOf(name: string): string {
  return readFileSync(join(ROUTES_DIR, `${name}${SUFFIX}`), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Source without imports, so only real uses are counted. */
function codeNoImports(name: string): string {
  return codeOf(name).replace(/^import[\s\S]*?from\s+["'][^"']+["'];?/gm, "");
}

function occurrences(code: string, pattern: RegExp): number[] {
  return [...code.matchAll(pattern)].map((match) => match.index ?? 0);
}

/**
 * Text from `start` to the end of the enclosing call or array: the middleware
 * chain the occurrence belongs to (brackets are counted, so a handler body that
 * follows the chain stays inside the window, which is harmless for these checks).
 */
function enclosingGroup(code: string, start: number): string {
  let depth = 0;
  for (let i = start; i < code.length; i += 1) {
    const char = code[i];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth < 0) return code.slice(start, i + 1);
    }
  }
  return code.slice(start);
}

// The cashier-token guard. `requireCookTokenOnSharedDevice` is the KDS wrapper that
// calls requireActingStaffOnSharedDevice except for the station heartbeat.
const TOKEN_GUARD =
  /\b(?:requireActingStaffOnSharedDevice|requireCookTokenOnSharedDevice)\b/;

/** Opt-ins of a "pos" file that deliberately skip the cashier-token guard. */
const NO_TOKEN_GUARD: Record<string, { count: number; reason: string }> = {
  "pos-order": {
    count: 1,
    reason:
      "createPosCatalogRouter GET: a read of the catalog needs no cashier token (a second window of the device has none).",
  },
};

/** Opt-ins whose `.use` chain has no cashier guards: they sit on each route instead. */
const ROUTE_LEVEL_GUARDS: Record<string, { count: number; reason: string }> = {
  floor: {
    count: 1,
    reason:
      "outletFloorRouter shares the /outlets prefix with other routers: a router-level cashier guard would also run for requests that fall through, so resolveActingStaff and requireActingStaffOnSharedDevice are mounted on the route.",
  },
};

/** "pos" files that keep a plain requireAuth, with the reason. */
const PLAIN_REQUIRE_AUTH: Record<string, { count: number; reason: string }> = {
  "order-recovery-charge": {
    count: 2,
    reason:
      "approve and reject of a manual refund (985): second-pair-of-eyes decisions of pos.refund.approve holders; a shared-device session is refused (money rule: when in doubt, limit the payment). Staff close and cash collection stay opt-in.",
  },
  menu: {
    count: 1,
    reason:
      "only /availability is used by the KDS; every other menu route is back office and uses plain requireAuth.",
  },
  "device-pin": {
    count: 1,
    reason:
      "only posOverrideRouter is POS; staffPinRouter (PIN set by a manager) is back office.",
  },
};

/**
 * "backoffice" files with exactly this many per-route opt-ins to shared devices
 * (legend-hlmbk, brief 1018 part B): the idle keep-alive POST
 * /api/auth/sessions/current/activity must work on a shared device. Every other
 * route of the file keeps the default-deny requireAuth.
 * Assumption: the opt-in is a single `requireAuthAllowSharedDevice` use inside
 * identity.routes.ts (not a new router file). If the engineer moves the route to
 * its own file, that file is a "shell" decision and this entry is removed.
 */
const BACKOFFICE_SHARED_OPT_INS: Record<
  string,
  { count: number; reason: string }
> = {
  identity: {
    count: 1,
    reason:
      "POST /sessions/current/activity: idle keep-alive of a shared-device session (legend-hlmbk).",
  },
  reservation: {
    count: 1,
    reason:
      "legend-i0ipj, legend-jvaqa, legend-5f6is: every staff reservation route (list, get, tables, seat, cancel, deposit-link, deposit-remainder, no-show, credit-apply) goes through the one sharedStaff chain (cashier PIN, actor = cashier); no staff route keeps the default-deny requireAuth.",
  },
};

const HOW =
  'Add it to DECISIONS in shared-device-router-decisions.test.ts: "pos" (cashier on a shared device), "shell" (identity/PIN/emergency reader), "backoffice" (owner screens, default requireAuth) or "public" (no login session). See the header of that file.';

const namesOf = (decision: Decision) =>
  Object.entries(DECISIONS)
    .filter(([, value]) => value === decision)
    .map(([name]) => name)
    .sort();

describe("1012 shared-device decision per router file", () => {
  it("every routes/*.routes.ts has a decision, and no decision is stale", () => {
    const decided = Object.keys(DECISIONS).sort();
    const undecided = routeFiles.filter((name) => !decided.includes(name));
    const stale = decided.filter((name) => !routeFiles.includes(name));
    expect(
      undecided,
      `Router file(s) without a shared-device decision: ${undecided.join(", ")}. ${HOW}`,
    ).toEqual([]);
    expect(
      stale,
      `DECISIONS key(s) without a router file: ${stale.join(", ")}. Remove them.`,
    ).toEqual([]);
  });

  it.each(namesOf("pos"))(
    "pos router %s: every shared-device opt-in is followed by the cashier guards",
    (name) => {
      const code = codeNoImports(name);
      const starts = occurrences(code, /\brequireAuthAllowSharedDevice\b/g);
      expect(
        starts.length,
        `${name} must use requireAuthAllowSharedDevice`,
      ).toBeGreaterThan(0);
      let withoutTokenGuard = 0;
      let routeLevel = 0;
      for (const start of starts) {
        const window = enclosingGroup(code, start);
        const where = `${name} near: ${window.slice(0, 120).replace(/\s+/g, " ")}`;
        const resolve = window.search(/\bresolveActingStaff\b/);
        if (resolve === -1 && (ROUTE_LEVEL_GUARDS[name]?.count ?? 0) > 0) {
          routeLevel += 1;
          continue;
        }
        expect(
          resolve,
          `${where} -- requireAuthAllowSharedDevice must be followed by resolveActingStaff`,
        ).toBeGreaterThan(0);
        const permission = window.search(/\brequire\w*Permission\b/);
        expect(
          permission === -1 || permission > resolve,
          `${where} -- resolveActingStaff must run before any permission guard`,
        ).toBe(true);
        const guard = window.search(TOKEN_GUARD);
        if (guard === -1) {
          withoutTokenGuard += 1;
          continue;
        }
        expect(
          guard,
          `${where} -- the cashier-token guard must come after resolveActingStaff`,
        ).toBeGreaterThan(resolve);
      }
      expect(
        routeLevel,
        `${name}: opt-ins whose chain has no resolveActingStaff. Allowed only as listed (with reason) in ROUTE_LEVEL_GUARDS.`,
      ).toBe(ROUTE_LEVEL_GUARDS[name]?.count ?? 0);
      if (routeLevel > 0) {
        // The guards then sit on the individual routes: there must be at least one
        // resolveActingStaff and one token guard per opt-in in the file.
        expect(
          occurrences(code, /\bresolveActingStaff\b/g).length,
          `${name}: route-level opt-in without a matching resolveActingStaff`,
        ).toBeGreaterThanOrEqual(starts.length);
        expect(
          occurrences(code, new RegExp(TOKEN_GUARD.source, "g")).length,
          `${name}: route-level opt-in without a matching cashier-token guard`,
        ).toBeGreaterThanOrEqual(starts.length);
      }
      expect(
        withoutTokenGuard,
        `${name}: opt-ins without requireActingStaffOnSharedDevice. Allowed only as listed (with reason) in NO_TOKEN_GUARD; add the guard or list the exception.`,
      ).toBe(NO_TOKEN_GUARD[name]?.count ?? 0);
    },
  );

  it("customer-display: the one cashier chain carries the token guard and every cashier route spreads it (legend-dgtz0)", () => {
    const code = codeNoImports("customer-display");
    const start = code.search(/\brequireAuthAllowSharedDevice\b/);
    const chain = enclosingGroup(code, start);
    expect(chain).toMatch(/\bresolveActingStaff\b/);
    expect(chain).toMatch(TOKEN_GUARD);
    // preview GET (staff branch), pair, selection, delete: no chain without the guard.
    expect(occurrences(code, /\.\.\.staff\b/g)).toHaveLength(4);
    expect(code).not.toMatch(/\bstaffCommand\b/);
  });

  it.each(namesOf("pos"))(
    "pos router %s keeps no plain requireAuth except the listed exceptions",
    (name) => {
      const plain = occurrences(codeNoImports(name), /\brequireAuth\b/g).length;
      expect(
        plain,
        `${name}: plain requireAuth found ${plain} time(s). A pos router uses requireAuthAllowSharedDevice everywhere; allowed exceptions (with reason) are in PLAIN_REQUIRE_AUTH.`,
      ).toBe(PLAIN_REQUIRE_AUTH[name]?.count ?? 0);
    },
  );

  it.each(namesOf("shell"))("shell router %s allows shared devices", (name) => {
    expect(
      codeOf(name),
      `${name} must use requireAuthAllowSharedDevice`,
    ).toContain("requireAuthAllowSharedDevice");
  });

  it.each(namesOf("backoffice"))(
    "backoffice router %s never opts in to shared devices",
    (name) => {
      const uses = occurrences(
        codeNoImports(name),
        /\brequireAuthAllowSharedDevice\b/g,
      ).length;
      expect(
        uses,
        `${name} is back office: it must keep the default-deny requireAuth (allowed opt-ins, with reason, are in BACKOFFICE_SHARED_OPT_INS)`,
      ).toBe(BACKOFFICE_SHARED_OPT_INS[name]?.count ?? 0);
    },
  );

  it("identity: only the keep-alive route opts in to shared devices (legend-hlmbk)", () => {
    const code = codeNoImports("identity");
    const starts = occurrences(code, /\brequireAuthAllowSharedDevice\b/g);
    expect(starts).toHaveLength(1);
    // The opt-in sits on the sessions/current/activity route, not on a router-wide use.
    const window = code.slice(
      Math.max(0, (starts[0] ?? 0) - 400),
      (starts[0] ?? 0) + 400,
    );
    expect(window).toMatch(/sessions\/current\/activity/);
  });

  it("reservation: the one sharedStaff chain carries the cashier guards (legend-i0ipj)", () => {
    const code = codeNoImports("reservation");
    const start = code.search(/\brequireAuthAllowSharedDevice\b/);
    const chain = enclosingGroup(code, start);
    expect(chain).toMatch(/\bresolveActingStaff\b/);
    expect(chain).toMatch(/\brequireActingStaffOnSharedDevice\b/);
  });

  it("notification: removePush resolves the caller so a shared-device session removes only its own subscription (legend 1024)", () => {
    const code = codeNoImports("notification");
    expect(code).toMatch(/"removePush"\s*&&\s*ports\.resolveCaller/);
    expect(code).toMatch(/sharedDevice\?: boolean/);
  });

  it.each(namesOf("public"))(
    "public router %s has no login-session guard",
    (name) => {
      const code = codeOf(name);
      expect(
        code,
        `${name} is public: it must not use requireAuthAllowSharedDevice`,
      ).not.toContain("requireAuthAllowSharedDevice");
      expect(
        /\brequireAuth\b/.test(code),
        `${name} is public but uses requireAuth: decide again (${HOW})`,
      ).toBe(false);
    },
  );
});

describe("1012 login-session reads are allow-listed", () => {
  const SRC_DIR = join(ROUTES_DIR, "..");
  // Every non-test file under apps/api/src that reads the login session straight from
  // Better Auth (`auth.api.getSession(` or `getSession(`) and so bypasses
  // requireAuth and its shared-device default-deny. A new reader must be reviewed
  // and added here with a reason.
  const GET_SESSION_ALLOWLIST: Record<string, string> = {
    "app.ts":
      "dev-only public-site credential resolver; optional session lookup, not a guard.",
    "middleware/auth.ts":
      "the guard itself (requireAuth / requireAuthAllowSharedDevice).",
    "middleware/shared-device-auth.ts":
      "legend-wa9n7: /api/auth/* guard; reads the session only to refuse a shared-device session, never authorises.",
    "middleware/shared-device-allowlist.ts":
      "legend-iq0jz: WebSocket upgrade refusal on a marked session (no requireAuth runs on an upgrade); reads only to refuse, never authorises.",
    "middleware/session-origin.ts":
      "reads only to refuse a session of the other side, never authorises.",
    "middleware/support-session.ts":
      "blocks impersonated sessions on auth routes; reads, never authorises.",
    "routes/identity-auth.routes.ts":
      "WhatsApp login challenge: tells signed-in from signed-out browsers; sessionless route.",
    "routes/qr-order.routes.ts":
      "optional member attach for a QR guest order; never required.",
    "services/kds-realtime-auth.ts":
      "KDS websocket upgrade authenticates by session cookie plus device/cashier rules of its own.",
  };

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory())
        return entry.name === "test" || entry.name === "node_modules"
          ? []
          : sourceFiles(path);
      return entry.name.endsWith(".ts") ? [path] : [];
    });
  }

  const strip = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("only allow-listed files read the session with getSession", () => {
    const found = sourceFiles(SRC_DIR)
      .filter((path) =>
        /\bauth\.api\.getSession\s*\(|\bgetSession\s*\(/.test(
          strip(readFileSync(path, "utf8")),
        ),
      )
      .map((path) =>
        path
          .slice(SRC_DIR.length + 1)
          .split("\\")
          .join("/"),
      )
      .sort();
    const unlisted = found.filter((file) => !(file in GET_SESSION_ALLOWLIST));
    const stale = Object.keys(GET_SESSION_ALLOWLIST).filter(
      (file) => !found.includes(file),
    );
    expect(
      unlisted,
      `New direct session read(s): ${unlisted.join(", ")}. A route that reads the session itself skips requireAuth and the shared-device default-deny. Use requireAuth (or requireAuthAllowSharedDevice with the cashier guards), or add the file to GET_SESSION_ALLOWLIST in shared-device-router-decisions.test.ts with the reason.`,
    ).toEqual([]);
    expect(
      stale,
      `GET_SESSION_ALLOWLIST entries that no longer read the session: ${stale.join(", ")}. Remove them.`,
    ).toEqual([]);
  });
});
