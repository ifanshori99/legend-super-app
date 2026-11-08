import type { IncomingMessage } from "node:http";
import express, { type Request } from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { env, trustProxySetting } from "./config/env";
import { pool } from "./db";
import { auth, CLIENT_IP_HEADER } from "./lib/auth";
import { logger as defaultLogger, type Logger } from "./lib/logger";
import { requestContext } from "./lib/request-context";
import { limitAuthBody } from "./middleware/body";
import {
  PUBLIC_RATE_LIMIT_PATHS,
  publicRateLimit,
  type PublicRateLimitOptions,
} from "./middleware/public-rate-limit";
import { tenantContext } from "./middleware/tenant";
import { errorHandler, notFound } from "./middleware/error-handler";
import { identityAuthRouter } from "./routes/identity.routes";
import { apiRouter } from "./routes";
import { setAuditWriter } from "./services/audit-writer";
import { coreAuditWriter } from "./services/core-audit-writer";
import { orderPromoPort } from "./services/order-promo";
import { depositCreditForSession } from "./services/reservation-lifecycle";
import {
  setQrOrderDepositCreditLookup,
  setQrOrderPromoPort,
} from "./services/qr-order-ports";
import { qrOrderSettlementLookup } from "./services/qr-order.service";
import { setTableSessionSettlementLookup } from "./services/table-session.service";
import { loginChallengeRouter as identityLoginChallengeRouter } from "./routes/identity-auth.routes";
import { createWhatsAppWebhookRouter } from "./routes/identity-wa-webhook.routes";
import { createPaymentWebhookRouter } from "./routes/payment-webhook.routes";
import { resolveHostname } from "./services/org-resolve.service";
import { deviceTenantCredential } from "./services/platform-tenant.service";
import { edgeRouteGuard } from "./edge/mode.ts";
import { setPosOrderPromoPort } from "./services/pos-order-ports.ts";

// Sensitive tenant writes (RBAC, approval matrix) append their audit row on
// the caller's transaction (PRD §3.7, §6 B audit_logs; bead legend-wt33).
// Tests may swap the writer; without one the port fails closed with a 503.
setAuditWriter(coreAuditWriter);
// WS-03 QR order wiring (legend-e2x/souz): promo engine port + ORD-10 settlement.
setQrOrderPromoPort(orderPromoPort);
setQrOrderDepositCreditLookup(depositCreditForSession);
setTableSessionSettlementLookup(qrOrderSettlementLookup);
// WS-04 POS order wiring (legend-kk7): the same promo engine port as QR. The
// reservation deposit credit is shared through the QR port above. Receipt
// numbering (legend-93a), cashier shift (legend-6c0), EDC (legend-m0k) and
// points tenders keep their fail-closed defaults (pos-order-ports.ts) until
// those beads land.
setPosOrderPromoPort(orderPromoPort);

const SENSITIVE_QUERY = /token|code|secret|password|signature|key/i;

// Path plus query, with values of credential-like parameters (Better Auth's
// verification tokens, OAuth codes) blanked out before they reach a log.
function safeUrl(url: string) {
  const [path, query] = url.split("?", 2);
  if (!query) return path;
  const params = new URLSearchParams(query);
  for (const key of params.keys())
    if (SENSITIVE_QUERY.test(key)) params.set(key, "[redacted]");
  return `${path}?${params.toString()}`;
}

function originalUrl(req: IncomingMessage) {
  return (req as Partial<Request>).originalUrl ?? req.url ?? "";
}

export function createApp({
  logger = defaultLogger,
  whatsappWebhookSecrets,
  publicRateLimit: publicRateLimitOptions,
  edgeMode = env.EDGE_MODE,
}: {
  logger?: Logger;
  /** Test seam; production reads EDGE_MODE (legend-2pi route split). */
  edgeMode?: boolean;
  /** Test seam; production reads KIRIM_WEBHOOK_SECRET. */
  whatsappWebhookSecrets?: readonly string[];
  /** Test seam; production reads PUBLIC_RATE_LIMIT_* (see config/env.ts). */
  publicRateLimit?: Partial<PublicRateLimitOptions>;
} = {}) {
  const app = express();
  app.disable("x-powered-by");
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
        "X-Request-Id",
      ],
      exposedHeaders: ["X-Request-Id", "Location"],
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
  // Payment provider webhooks: tenant in the URL, signature per tenant secret.
  app.use("/api/webhooks/payments", createPaymentWebhookRouter());

  // Tenant resolution (TEN-02). In every deployment a registered, verified
  // domain of an active tenant or a signed device token names the tenant; the
  // client never does. Only development with synthetic data keeps a fallback:
  // the seeded tenant, and only for a signed-in caller (the e2e/login flow).
  app.use(
    "/api",
    tenantContext({
      required: false,
      resolveDomain,
      verifyCredential: deviceTenantCredential,
      // Development fallback only for a signed-in caller (the e2e/login flow);
      // brands are read later inside the tenant transaction.
      fallback: developmentSyntheticTenant
        ? async (req) => {
            const session = await auth.api.getSession({
              headers: fromNodeHeaders(req.headers),
              query: { disableCookieCache: true },
            });
            return session ? firstSyntheticTenant() : null;
          }
        : undefined,
    }),
  );
  // The public, session-free reads (guest QR scan and menu, brand website and
  // its menu, SSR brand context, customer payment links) have no session to
  // bound them, so one in-memory limiter caps them per client IP and per
  // resolved tenant, answering 429 RATE_LIMITED with Retry-After. Mounted
  // after the tenant resolver (the tenant bucket needs it) and only on those
  // prefixes: health, Better Auth, provider webhooks and the TLS ask keep their
  // own budgets, and a limiter window can never fail a probe (legend-wd4b).
  app.use(PUBLIC_RATE_LIMIT_PATHS, publicRateLimit(publicRateLimitOptions));
  app.use("/api", apiRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
