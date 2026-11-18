import type { IncomingMessage } from "node:http";
import express, { type Request } from "express";
import cors from "cors";
import helmet from "helmet";
import type { MessagingProvider } from "@starter/shared/adapters";
import { pinoHttp } from "pino-http";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { env, trustProxySetting } from "./config/env";
import { db, pool } from "./db";
import { auth, CLIENT_IP_HEADER } from "./lib/auth";
import {
  logger as defaultLogger,
  serializeError,
  type Logger,
} from "./lib/logger";
import { HttpError } from "./lib/http-error";
import { requestContext } from "./lib/request-context";
import { developmentPublicSiteCredential } from "./lib/development-public-site";
import { limitAuthBody } from "./middleware/body";
import { guardImpersonatedAuthRoutes } from "./middleware/support-session";
import { guardSharedDeviceAuthRoutes } from "./middleware/shared-device-auth";
import {
  loginChallengeRateLimit,
  type LoginChallengeRateLimitOptions,
} from "./middleware/login-challenge-rate-limit";
import {
  PUBLIC_RATE_LIMIT_PATHS,
  guestSessionRateLimit,
  publicRateLimit,
  type PublicRateLimitOptions,
} from "./middleware/public-rate-limit";
import { ssrVisitorIp } from "./middleware/ssr-visitor-ip";
import { tenantContext } from "./middleware/tenant";
import { errorHandler, notFound } from "./middleware/error-handler";
import { identityAuthRouter } from "./routes/identity.routes";
import { apiRouter } from "./routes";
import { createStorageApiRouter } from "./routes/storage-api.routes";
import { setPayoutEvidenceStorage } from "./services/payroll-payout-evidence";
import { setScannerHealth } from "./routes/health.routes";
import { createPosCatalogRouter } from "./routes/pos-order.routes.ts";
import { createMenuMediaUrls } from "./services/menu-media.service.ts";
import {
  consoleLikeLog,
  createStorageRuntimeFromEnv,
  type StorageRuntime,
} from "./services/core-storage-runtime";
import { mcpOAuthRouter, mcpRouter } from "./routes/mcp.routes";
import { auditEventsRouter } from "./routes/audit-events.routes";
import { createMetricsRouter } from "./routes/metrics.routes";
import { createDashboardsRouter } from "./routes/dashboards.routes";
import { createReportsRouter } from "./routes/reports.routes";
import { setAuditWriter } from "./services/audit-writer";
import { coreAuditWriter } from "./services/core-audit-writer";
import { orderPromoPort } from "./services/order-promo";
import { withPromoFreshness } from "./edge/promo-gate.ts";
import { depositCreditForSession } from "./services/reservation-lifecycle";
import {
  setQrOrderDepositCreditLookup,
  setQrOrderPromoPort,
} from "./services/qr-order-ports";
import { qrOrderSettlementLookup } from "./services/qr-order.service";
import { setTableSessionSettlementLookup } from "./services/table-session.service";
import { loginChallengeRouter as identityLoginChallengeRouter } from "./routes/identity-auth.routes";
import { setWhatsAppWebhookSecrets } from "./lib/whatsapp-webhook-secrets";
import { deliveryWebhookRouter } from "./routes/delivery-webhook.routes";
import { createWhatsAppWebhookRouter } from "./routes/identity-wa-webhook.routes";
import { createPaymentWebhookRouter } from "./routes/payment-webhook.routes";
import { createEdgeBootstrapRateLimit } from "./routes/edge-bootstrap.routes";
import { resolveHostname } from "./services/org-resolve.service";
import { deviceTenantCredential } from "./services/platform-tenant.service";
import { edgeRouteGuard } from "./edge/mode.ts";
import {
  setPosEdcTenderPort,
  setPosOrderPromoPort,
  setPosPointsTenderPort,
  setPosReceiptPort,
  setPosShiftLookup,
} from "./services/pos-order-ports.ts";
import { edcTenderSettlement } from "./services/pos-edc-tender.ts";
import { posPointsTenderSettlement } from "./services/pos-points.service.ts";
import {
  createPosReceiptPort,
  receiptGapsForDevice,
  receiptGapsForOutletFast,
} from "./services/pos-receipt.service.ts";
import {
  setPosOutletReceiptGapsPort,
  setPosReceiptGapsPort,
} from "./services/pos-shift-ports.ts";
import { findOpenShiftId } from "./services/pos-shift.service.ts";
import { setInventoryRecipeSource } from "./services/inventory-ops.shared.ts";
import { recipeBomSource } from "./services/recipe-bom.service.ts";
import { installKdsServingEstimate } from "./services/kds-estimate.service.ts";

// Sensitive tenant writes (RBAC, approval matrix) append their audit row on
// the caller's transaction (PRD §3.7, §6 B audit_logs; bead legend-wt33).
// Tests may swap the writer; without one the port fails closed with a 503.
setAuditWriter(coreAuditWriter);
// WS-03 QR order wiring (legend-e2x/souz): promo engine port + ORD-10 settlement.
setQrOrderPromoPort(withPromoFreshness(orderPromoPort));
setQrOrderDepositCreditLookup(depositCreditForSession);
// WS-04 order pacing (legend-gyc, KDS-05): queue-aware serving estimate.
installKdsServingEstimate();
setTableSessionSettlementLookup(qrOrderSettlementLookup);
// WS-04 POS order wiring (legend-kk7): the same promo engine port as QR. The
// reservation deposit credit is shared through the QR port above. Receipt
// numbering (legend-93a) is wired below; cashier shift (legend-6c0) and EDC
// (legend-dahk) are wired below too. Points tenders keep their fail-closed
// default (pos-order-ports.ts) until that bead lands.
setPosOrderPromoPort(withPromoFreshness(orderPromoPort));
setPosReceiptPort(createPosReceiptPort());
// POS-06 (legend-ain0): the real gap lookup, so Tutup Hari refuses with
// RECEIPT_SEQUENCE_GAP and the shift report lists the missing numbers. Before
// this the port kept its "no gaps" default and the contract never fired.
setPosReceiptGapsPort(receiptGapsForDevice);
// legend-6b0ld: Tutup Hari also checks every run of the outlet (retired runs,
// cloud sequence), not only devices with activity that business date.
setPosOutletReceiptGapsPort((tx, context, { outletId }) =>
  receiptGapsForOutletFast(tx, context, outletId),
);
// WS-04 cashier shift (legend-6c0): orders attach to the cashier's open shift.
setPosShiftLookup(findOpenShiftId);
// WS-04 EDC tender (legend-dahk): settles only against an approved ledger sale
// of the EDC agent.
setPosEdcTenderPort(edcTenderSettlement);
// 936 (legend-hpgyw): points tender debits the member ledger in the order transaction.
setPosPointsTenderPort(posPointsTenderSettlement);
// INV-02 (legend-db6): production orders and menu waste read recipes from the BOM engine.
setInventoryRecipeSource(recipeBomSource);

/** Customer display routes (legend-yhia9 D-08): mismatch answers carry no hint. */
const CUSTOMER_DISPLAY_PATH =
  /^\/api\/outlets\/[^/]+\/pos\/customer-display(?:\/|$)/i;
const SENSITIVE_QUERY = /token|code|secret|password|signature|key/i;
// A search value with a run of 6+ digits (spaces, "+" and "-" ignored) is
// likely a phone number, e.g. GET /api/customers?q=081234567890: personal data.
const PHONE_LIKE_VALUE = /\d{6,}/;
// ISO dates/timestamps (from=2026-11-10) are filters, not numbers: keep them in the log.
const ISO_DATE_VALUE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.+Z-]*)?$/;
const PUBLIC_PO_TOKEN_PATH = /^(\/api\/public\/purchase-orders\/)[^/]+/i;
const ABSOLUTE_FORM_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;
// A platform account search term can be a person's name or email, including
// requests refused before authorization. Keep its paging metadata, never q.
const PLATFORM_ACCOUNT_SEARCH_PATH =
  /^\/api\/platform\/tenants\/[^/]+\/accounts\/?$/i;

// The e-receipt token in the path is a bearer credential too (bead legend-93a).
const PUBLIC_RECEIPT_PATH = /^(\/api\/public\/receipts\/)[^/?]+(\/pdf)?/i;

function isMalformedPath(path: string) {
  try {
    decodeURIComponent(path);
    return false;
  } catch {
    return true;
  }
}

// Path plus query, with values of credential-like parameters (Better Auth's
// verification tokens, OAuth codes) blanked out before they reach a log.
function safeUrl(url: string) {
  // A client may send an absolute-form request target (RFC 9112 3.2.2), so
  // drop scheme and authority first: the path regexes anchor at the path.
  const target = url.replace(ABSOLUTE_FORM_URL, "") || "/";
  const queryStart = target.indexOf("?");
  const rawPath = queryStart === -1 ? target : target.slice(0, queryStart);
  const query = queryStart === -1 ? "" : target.slice(queryStart + 1);
  // A malformed percent-encoding makes the router reject the request (400);
  // the path may carry a credential in a param, so never log any of it.
  if (isMalformedPath(rawPath)) return "[malformed-url]";
  const accountSearch = PLATFORM_ACCOUNT_SEARCH_PATH.test(
    decodeURIComponent(rawPath),
  );
  // The purchase order share token is a path segment: bearer credential.
  const path = rawPath
    .replace(PUBLIC_PO_TOKEN_PATH, "$1[redacted]")
    .replace(PUBLIC_RECEIPT_PATH, "$1[redacted]…");
  if (!query) return path;
  const params = new URLSearchParams(query);
  for (const [key, value] of [...params.entries()])
    if (
      SENSITIVE_QUERY.test(key) ||
      (accountSearch && key.toLowerCase() === "q") ||
      (!ISO_DATE_VALUE.test(value) &&
        PHONE_LIKE_VALUE.test(value.replace(/[\s+-]/g, "")))
    )
      params.set(key, "[redacted]");
  return `${path}?${params.toString()}`;
}

function originalUrl(req: IncomingMessage) {
  return (req as Partial<Request>).originalUrl ?? req.url ?? "";
}

export function createApp({
  logger = defaultLogger,
  whatsappWebhookSecrets,
  publicRateLimit: publicRateLimitOptions,
  loginChallengeRateLimit: loginChallengeRateLimitOptions,
  edgeMode = env.EDGE_MODE,
  storageRuntime = createStorageRuntimeFromEnv(
    process.env,
    db,
    consoleLikeLog(defaultLogger),
  ),
  messagingProvider = null,
}: {
  logger?: Logger;
  /** Test seam; production reads EDGE_MODE (legend-2pi route split). */
  edgeMode?: boolean;
  /** Test seam; production reads KIRIM_WEBHOOK_SECRET. */
  whatsappWebhookSecrets?: readonly string[];
  /** Test seam; production reads PUBLIC_RATE_LIMIT_* (see config/env.ts). */
  publicRateLimit?: Partial<PublicRateLimitOptions>;
  /** Test seam; production uses the LOGIN_* defaults (legend-fc0f2). */
  loginChallengeRateLimit?: Partial<LoginChallengeRateLimitOptions>;
  /** Test seam; production reads STORAGE_* (null: uploads answer 503, legend-dzh9q). */
  storageRuntime?: StorageRuntime | null;
  /** WhatsApp sender for the payslip PIN reset code (legend-qih2m). No production provider is wired yet: null answers 503. */
  messagingProvider?: MessagingProvider | null;
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  setWhatsAppWebhookSecrets(app, whatsappWebhookSecrets);
  // Resolve, return and confirm check that a payment proof is really stored.
  setPayoutEvidenceStorage(app, storageRuntime?.storage);
  // GET /api/health reports whether the malware scanner answers (legend-w9hwh).
  setScannerHealth(app, storageRuntime?.scanner);
  app.set("trust proxy", trustProxySetting());

  // The synthetic tenant fallback exists only where a synthetic dataset does:
  // development, non-production runtime, synthetic data classification.
  const developmentSyntheticTenant =
    env.DEPLOYMENT_MODE === "development" &&
    env.NODE_ENV !== "production" &&
    env.DATA_CLASSIFICATION === "synthetic";

  app.use(
    helmet({
      // The web app is a different origin on the same site.
      crossOriginResourcePolicy: { policy: "same-site" },
    }),
  );

  // Request ID + AsyncLocalStorage first, so every later log line (including
  // the access log below and anything a service writes) carries reqId.
  app.use(requestContext);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      // The logger's mixin already adds reqId/userId; keep the request object small.
      serializers: {
        // pino-http replaces the logger's err serializer on req.log/res.log
        // and the access log: keep database row values out there too.
        err: serializeError,
        req: (req) => ({
          method: req.method,
          url: safeUrl(req.originalUrl ?? req.url),
          remoteAddress: req.remoteAddress,
        }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        // Liveness probes would flood the log at info. Routers rewrite
        // req.url, so match on the original path.
        if (originalUrl(req).startsWith("/api/health")) return "debug";
        return "info";
      },
      customSuccessMessage: (req, res, responseTime) =>
        `${req.method} ${safeUrl(originalUrl(req))} ${res.statusCode} ${Math.round(responseTime)}ms`,
      customErrorMessage: (req, res) =>
        `${req.method} ${safeUrl(originalUrl(req))} ${res.statusCode}`,
    }),
  );

  // The browser calls the API from WEB_URL (plus TRUSTED_ORIGINS) with
  // cookies. Other origins get no CORS headers, so browsers block them.
  app.use(
    cors({
      origin: env.trustedOrigins,
      credentials: true,
      // PUT carries payment-admin configuration writes (routing, EDC cashier
      // defaults); their retry identity travels in Idempotency-Key, never a
      // cookie or query string, so the browser preflight has to allow it.
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Accept",
        "Content-Type",
        "Authorization",
        "Idempotency-Key",
        "X-Reservation-Link-Token",
        "X-Request-Id",
        // Active cashier token of a shared POS device (middleware/acting-staff).
        "X-Acting-Staff",
        // The outlet screen sends no cookie: the registered device and the
        // one-time staff PIN proof travel in headers (legend-u7g9w).
        "X-Device-Token",
        "X-Pin-Proof",
      ],
      exposedHeaders: [
        "X-Request-Id",
        "Location",
        "Content-Disposition",
        "X-Content-Checksum-Sha256",
      ],
      maxAge: 600,
    }),
  );

  // Better Auth sees only headers, not the socket. Hand it the client IP
  // Express resolved (honoring TRUST_PROXY) in a header we always overwrite,
  // so its per-IP rate limits work and cannot be spoofed by the client.
  app.use((req, _res, next) => {
    req.headers[CLIENT_IP_HEADER] = req.ip ?? req.socket.remoteAddress ?? "";
    next();
  });

  // Visitor IP the SSR web server forwards (legend-moe5): trusted only with
  // the shared secret (SSR_SHARED_SECRET), and both headers are dropped here for
  // every route, so no client-supplied value reaches the limiters or handlers.
  app.use(ssrVisitorIp());

  // EDGE_MODE route split (legend-2pi, edge/mode.ts): deny by default. On an
  // edge node only the operational API prefixes are served; on the cloud the
  // edge-only /api/edge prefix answers 404. Before Better Auth's catch-all and
  // every /api router so no handler runs for a refused path.
  app.use(edgeRouteGuard({ edgeMode }));

  // Tenant resolution shared by the public login path below and /api (TEN-02):
  // a registered, verified domain of an active tenant or a signed device
  // token. Never a client-supplied id.
  const resolveDomain = async (hostname: string) => {
    const resolution = await resolveHostname(hostname);
    return resolution.ok
      ? { tenantId: resolution.tenantId, brandId: resolution.brandId }
      : null;
  };
  const firstSyntheticTenant = async () => {
    // Development only: the first seeded tenant (the synthetic Cafe Legend
    // seed). Never derived from request input, and no tenant name is
    // hard-coded here (TEN-07).
    const result = await pool.query<{ id: string }>(
      "SELECT id FROM tenants WHERE status = 'active' ORDER BY created_at, id LIMIT 1",
    );
    const row = result.rows[0];
    return row
      ? { tenantId: row.id, brandId: null, source: "session" as const }
      : null;
  };

  // legend-fc0f2: the endpoints are public and write to the database, so they
  // get their own per-IP and per-browser limiter. It runs before the
  // impersonation guard (which looks the session up when a cookie is present)
  // and the tenant resolver, so a flood is answered 429 without a DB query.
  app.use(
    "/api/auth/login-challenges",
    loginChallengeRateLimit(loginChallengeRateLimitOptions),
  );
  // An impersonated (support) session may only call the allowlisted
  // /api/auth paths. The guard covers the login-challenge router,
  // identityAuthRouter and Better Auth below, and reads headers only (never
  // the body).
  app.use("/api/auth", guardImpersonatedAuthRoutes);
  // legend-wa9n7: a session used on a shared (cashier) device may only read
  // the session and sign in/out under /api/auth; account management stays on
  // a personal device. Same coverage and header-only reading as the guard
  // above.
  app.use("/api/auth", guardSharedDeviceAuthRoutes);

  // WhatsApp reverse-OTP sign-in (WS-01, AUTH-01/04) is public, so it has no
  // session. It must run before Better Auth's catch-all because the identity
  // contract puts it under
  // /api/auth/*. The tenant is the domain's (or device token's); an
  // unresolved host answers TENANT_NOT_FOUND instead of guessing (TEN-02).
  app.use(
    "/api/auth/login-challenges",
    tenantContext({
      required: false,
      resolveDomain,
      verifyCredential: deviceTenantCredential,
    }),
  );
  app.use("/api/auth/login-challenges", identityLoginChallengeRouter);

  // Legend identity routes (MFA factors, device sessions) share the /api/auth
  // prefix with Better Auth. They are mounted here, before Better Auth's
  // catch-all, so it does not swallow them; every other path falls through
  // unchanged because each route authenticates on its own.
  app.use("/api/auth", identityAuthRouter);

  // Better Auth owns /api/auth/*: sign-up, sign-in, session, sign-out, admin.
  // It reads the raw body itself, so no JSON parser may run before it, and
  // limitAuthBody caps that body's size first.
  app.all("/api/auth/*splat", limitAuthBody, toNodeHandler(auth));

  // Provider webhooks are server-to-server: no session, no Origin, no tenant
  // middleware. The tenant comes from the receiving number after the signature
  // verifies (AUTH-02). Mounted before /api so nothing parses the body first.
  app.use(
    "/api/webhooks/whatsapp",
    createWhatsAppWebhookRouter({ secrets: whatsappWebhookSecrets }),
  );
  // Delivery platform webhooks (GoFood, GrabFood, ShopeeFood; legend-5bn3):
  // same server-to-server rules, signature per platform.
  app.use("/api/webhooks/delivery", deliveryWebhookRouter);
  // Payment provider webhooks: tenant in the URL, signature per tenant secret.
  app.use("/api/webhooks/payments", createPaymentWebhookRouter());

  // Edge bootstrap limiter (legend-uznb, Codex 119): before tenant resolution
  // so a flood from one IP is refused before the tenant-domain query. Keys
  // need no tenant (client IP, credential digest, edge node id parsed from the
  // bearer). The router skips its own copy for a request counted here.
  app.use("/api/edge-sync/bootstrap", createEdgeBootstrapRateLimit());

  // Tenant resolution (TEN-02). In every deployment a registered, verified
  // domain of an active tenant or a signed device token names the tenant; the
  // client never does. Only development with synthetic data keeps a fallback:
  // the seeded tenant for a signed-in caller (the e2e/login flow), or an
  // explicitly configured domain for loopback public website reads.
  app.use(
    "/api",
    tenantContext({
      required: false,
      resolveDomain,
      verifyCredential: deviceTenantCredential,
      // Customer display routes (legend-yhia9 D-08): a device credential of
      // another tenant gets the same 401 as a forged token, no hint.
      onMismatch: (req) =>
        CUSTOMER_DISPLAY_PATH.test(req.originalUrl.split("?")[0] ?? "")
          ? new HttpError(
              401,
              "UNAUTHORIZED",
              "Token perangkat ini tidak berlaku lagi. Daftarkan ulang perangkat.",
            )
          : undefined,
      // Development fallback only for a signed-in caller (the e2e/login flow);
      // brands are read later inside the tenant transaction.
      fallback: developmentSyntheticTenant
        ? async (req) => {
            const publicSiteTenant = await developmentPublicSiteCredential(
              req,
              {
                enabled: env.NODE_ENV === "development",
                hostname: env.DEV_PUBLIC_SITE_HOST,
                resolveDomain,
              },
            );
            if (publicSiteTenant) return publicSiteTenant;
            const session = await auth.api.getSession({
              headers: fromNodeHeaders(req.headers),
              query: { disableCookieCache: true },
            });
            return session ? firstSyntheticTenant() : null;
          }
        : undefined,
    }),
  );
  // MCP server (WS-12, legend-xkbt). `/mcp` is authenticated by its bearer
  // token alone (the token names the tenant, MCP-01). The OAuth endpoints and
  // discovery documents live outside `/api` (RFC 8414/9728) and resolve the
  // tenant like `/api` does: registered domain, or in development with
  // synthetic data the first seeded tenant (no session needed: discovery and
  // dynamic registration are anonymous).
  app.use("/mcp", mcpRouter);
  app.use(
    [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/oauth",
    ],
    tenantContext({
      required: false,
      resolveDomain,
      verifyCredential: deviceTenantCredential,
      fallback: developmentSyntheticTenant ? firstSyntheticTenant : undefined,
    }),
  );
  app.use(mcpOAuthRouter);
  // The public, session-free reads (guest QR scan and menu, brand website and
  // its menu, SSR brand context, customer payment links) have no session to
  // bound them, so one in-memory limiter caps them per client IP and per
  // resolved tenant, answering 429 RATE_LIMITED with Retry-After. Mounted
  // after the tenant resolver (the tenant bucket needs it) and only on those
  // prefixes: health, Better Auth, provider webhooks and the TLS ask keep their
  // own budgets, and a limiter window can never fail a probe (legend-wd4b).
  app.use(PUBLIC_RATE_LIMIT_PATHS, publicRateLimit(publicRateLimitOptions));
  // Guest table-session routes (cart, quote, bill, payments, polls): the same
  // per-IP/tenant limiter, sized for a venue NAT plus a per-session bucket.
  // The staff confirm/close routes on this prefix are skipped inside.
  app.use("/api/table-sessions", guestSessionRateLimit(publicRateLimitOptions));
  // Audit log viewer (legend-zbzr): GET /api/audit/events.
  app.use("/api/audit", auditEventsRouter);
  // Metric query runtime (legend-cdta): GET /api/metrics/query.
  app.use("/api/metrics", createMetricsRouter());
  // Report catalog, run and builder preview (legend-5wzoc): /api/reports.
  app.use("/api/reports", createReportsRouter());
  // Dashboard layout, tile values (batch) and queue rows (legend-flb8f).
  app.use("/api/dashboards", createDashboardsRouter());
  // Object storage consumers (core-storage router, attendance selfie URLs).
  app.use(
    "/api",
    createStorageApiRouter({
      runtime: storageRuntime,
      database: db,
      messaging: messagingProvider,
    }),
  );
  app.use(
    "/api/outlets/:outletId/pos/catalog",
    createPosCatalogRouter(
      createMenuMediaUrls(storageRuntime?.storage ?? null),
    ),
  );
  app.use("/api", apiRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
