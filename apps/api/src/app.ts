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
import { tenantContext } from "./middleware/tenant";
import { errorHandler, notFound } from "./middleware/error-handler";
import { apiRouter } from "./routes";
import { loginChallengeRouter as identityLoginChallengeRouter } from "./routes/identity-auth.routes";
import { createWhatsAppWebhookRouter } from "./routes/identity-wa-webhook.routes";
import { resolveHostname } from "./services/org-resolve.service";
import { deviceTenantCredential } from "./services/platform-tenant.service";

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
}: {
  logger?: Logger;
  /** Test seam; production reads KIRIM_WEBHOOK_SECRET. */
  whatsappWebhookSecrets?: readonly string[];
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
      methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
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

  // WhatsApp reverse-OTP sign-in (WS-01, AUTH-01/04) is public, so it has no
  // session to resolve a tenant from, and it must run before Better Auth's
  // catch-all because the identity contract puts it under /api/auth/*.
  //
  // Tenant resolution: the production mount is the domain resolver of
  // legend-1je (not merged yet). Until it lands, the same development-only
  // fallback the rest of the API uses mints the seeded tenant for this path;
  // in production the guard below disables it and the route answers
  // TENANT_NOT_FOUND instead of guessing a tenant (TEN-02).
  const developmentTenant = developmentTenantContext({
    enabled:
      env.DEPLOYMENT_MODE === "development" &&
      env.NODE_ENV !== "production" &&
      env.DATA_CLASSIFICATION === "synthetic",
    // Public path: there is no session to gate on, so gate on nothing.
    hasSession: async () => true,
    lookup: async () => {
      const result = await pool.query<{ id: string }>(
        "SELECT id FROM tenants ORDER BY created_at, id LIMIT 1",
      );
      const row = result.rows[0];
      return row ? { tenantId: row.id, brandId: null } : null;
    },
  });
  app.use("/api/auth/login-challenges", developmentTenant);
  app.use("/api/auth/login-challenges", identityLoginChallengeRouter);

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

  // Tenant resolution (TEN-02). In every deployment a registered, verified
  // domain of an active tenant or a signed device token names the tenant; the
  // client never does. Only development with synthetic data keeps a fallback:
  // the seeded tenant, and only for a signed-in caller (the e2e/login flow).
  app.use(
    "/api",
    tenantContext({
      required: false,
      resolveDomain: async (hostname) => {
        const resolution = await resolveHostname(hostname);
        return resolution.ok
          ? { tenantId: resolution.tenantId, brandId: resolution.brandId }
          : null;
      },
      verifyCredential: deviceTenantCredential,
      fallback: developmentSyntheticTenant
        ? async (req) => {
            const session = await auth.api.getSession({
              headers: fromNodeHeaders(req.headers),
              query: { disableCookieCache: true },
            });
            if (!session) return null;
            // Development only: the first seeded tenant (the synthetic Cafe
            // Legend seed). Never derived from request input, and no tenant
            // name is hard-coded here (TEN-07); brands are read later inside
            // the tenant transaction once the context exists.
            const result = await pool.query<{ id: string }>(
              "SELECT id FROM tenants WHERE status = 'active' ORDER BY created_at, id LIMIT 1",
            );
            const row = result.rows[0];
            return row
              ? { tenantId: row.id, brandId: null, source: "session" as const }
              : null;
          }
        : undefined,
    }),
  );
  app.use("/api", apiRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
