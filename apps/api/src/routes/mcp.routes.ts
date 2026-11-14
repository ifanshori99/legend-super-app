// MCP server transport and OAuth endpoints (WS-12 part M, bead legend-xkbt;
// PRD v1.7 §3 Fitur 39, MCP-01..05). Mounted at the API root, outside `/api`:
//   POST /mcp                                     Streamable HTTP, stateless
//   GET  /.well-known/oauth-authorization-server  RFC 8414
//   GET  /.well-known/oauth-protected-resource    RFC 9728
//   GET  /oauth/authorize, POST /oauth/token, POST /oauth/register
// `/mcp` authenticates with the bearer token alone (the token names the
// tenant). The `/oauth/*` and metadata paths get the same tenant resolver as
// `/api` (domain, or the development fallback) mounted in app.ts.
import type { IncomingMessage } from "node:http";
import express, { Router, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AiError, MCP_SCOPES, mcpScopeSchema } from "@starter/shared/ai";
import { env } from "../config/env.ts";
import { logger } from "../lib/logger.ts";
import { HttpError } from "../lib/http-error.ts";
import { BODY_LIMIT_BYTES, jsonBody } from "../middleware/body.ts";
import { findTenantContext } from "../middleware/tenant.ts";
import { db } from "../db/index.ts";
import { isAiPlatformLocked } from "../services/ai-platform-lock.ts";
import { loadMcpSettings } from "../services/mcp-common.ts";
import {
  exchangeAuthorizationCode,
  OAuthError,
  oauthErrorRedirect,
  registerDynamicClient,
  validateAuthorizationRequest,
} from "../services/mcp-oauth.service.ts";
import {
  authenticateMcpToken,
  createMcpServer,
  enforceMcpRateLimit,
  McpUnauthorizedError,
} from "../services/mcp-server.service.ts";

const baseUrl = (req: Request) => `${req.protocol}://${req.get("host")}`;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

function oauthJsonError(res: Response, error: OAuthError) {
  res.setHeader("Cache-Control", "no-store");
  res.status(error.status).json({
    error: error.error,
    error_description: error.description,
  });
}

// ---- /mcp -------------------------------------------------------------------

const mcpRouter = Router();

mcpRouter.post("/", async (req, res, next) => {
  try {
    let principal;
    try {
      principal = await authenticateMcpToken(req.get("authorization"));
    } catch (error) {
      const unauthorized =
        error instanceof McpUnauthorizedError ||
        (error instanceof AiError && error.status === 401);
      if (unauthorized)
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`,
        );
      throw error;
    }
    try {
      enforceMcpRateLimit(principal.tokenId, principal.rateLimitPerMinute);
    } catch (error) {
      res.setHeader("Retry-After", "60");
      throw error;
    }
    res.setHeader("Cache-Control", "no-store");
    jsonBody(req, res, async (parseError?: unknown) => {
      try {
        if (parseError) throw parseError;
        const server = createMcpServer(principal);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(
          req as unknown as IncomingMessage,
          res,
          req.body,
        );
      } catch (error) {
        next(error);
      }
    });
  } catch (error) {
    next(error);
  }
});

// Stateless server: no standalone SSE stream and no session to delete.
const methodNotAllowed = (_req: Request, res: Response) => {
  res.setHeader("Allow", "POST");
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};
mcpRouter.get("/", methodNotAllowed);
mcpRouter.delete("/", methodNotAllowed);

export { mcpRouter };

// ---- OAuth + discovery ------------------------------------------------------

const mcpOAuthRouter = Router();

mcpOAuthRouter.get(
  "/.well-known/oauth-authorization-server",
  async (req, res) => {
    const base = baseUrl(req);
    const tenant = findTenantContext(req);
    const settings = tenant ? await loadMcpSettings(tenant.tenantId) : null;
    res.setHeader("Cache-Control", "no-store");
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      ...(settings?.mcpEnabled && settings.dynamicClientRegistrationEnabled
        ? { registration_endpoint: `${base}/oauth/register` }
        : {}),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...MCP_SCOPES],
    });
  },
);

mcpOAuthRouter.get("/.well-known/oauth-protected-resource", (req, res) => {
  const base = baseUrl(req);
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: [...MCP_SCOPES],
  });
});

/**
 * GET /oauth/authorize validates the request and sends the browser to the
 * consent screen. It never issues a code: only the user's explicit approval
 * (`POST /api/ai/mcp/authorize`, cookie session + trusted origin) does.
 */
mcpOAuthRouter.get("/oauth/authorize", async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const q = req.query;
    const tenant = findTenantContext(req);
    if (tenant) {
      try {
        await validateAuthorizationRequest(tenant.tenantId, {
          responseType: str(q.response_type),
          clientId: str(q.client_id),
          redirectUri: str(q.redirect_uri),
          scope: str(q.scope),
          state: str(q.state),
          codeChallenge: str(q.code_challenge),
          codeChallengeMethod: str(q.code_challenge_method),
        });
      } catch (error) {
        if (error instanceof OAuthError && error.redirectUri)
          return void res.redirect(
            302,
            oauthErrorRedirect(error, str(q.state)),
          );
        throw error;
      }
    }
    const consent = new URL("/mcp/consent", env.WEB_URL);
    for (const [key, value] of Object.entries(q))
      if (typeof value === "string") consent.searchParams.set(key, value);
    res.redirect(302, consent.toString());
  } catch (error) {
    if (error instanceof OAuthError) return oauthJsonError(res, error);
    next(error);
  }
});

mcpOAuthRouter.post(
  "/oauth/token",
  express.urlencoded({ extended: false, limit: BODY_LIMIT_BYTES }),
  async (req, res, next) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const issued = await exchangeAuthorizationCode({
        grantType: str(b.grant_type),
        code: str(b.code),
        redirectUri: str(b.redirect_uri),
        clientId: str(b.client_id),
        codeVerifier: str(b.code_verifier),
      });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
      res.json(issued);
    } catch (error) {
      if (error instanceof OAuthError) return oauthJsonError(res, error);
      next(error);
    }
  },
);

// Unauthenticated writes get two in-memory budgets per process: one per client
// IP and one global cap. Behind a reverse proxy every caller shares the proxy's
// IP unless TRUST_PROXY is set (app.ts `trust proxy`), so the per-IP limit then
// acts as a second global limit; the global cap bounds abuse either way.
const registrations = new Map<string, number[]>();
const REGISTER_PER_HOUR = 10;
const REGISTER_GLOBAL_PER_HOUR = 60;
let globalRegistrations: number[] = [];

mcpOAuthRouter.post("/oauth/register", jsonBody, async (req, res, next) => {
  try {
    const tenant = findTenantContext(req);
    if (!tenant)
      throw new HttpError(404, "TENANT_NOT_FOUND", "No tenant is available.");
    // Platform lock: refuse before the rate budgets are spent or the body is
    // read. The service re-checks under a row lock before it inserts.
    if (await isAiPlatformLocked(db, tenant.tenantId))
      throw new OAuthError("access_denied", "AI_PLATFORM_DISABLED", 403);
    const now = Date.now();
    const key = req.ip ?? "unknown";
    for (const [ip, times] of registrations) {
      const live = times.filter((t) => now - t < 3_600_000);
      if (live.length === 0) registrations.delete(ip);
      else if (live.length !== times.length) registrations.set(ip, live);
    }
    globalRegistrations = globalRegistrations.filter(
      (t) => now - t < 3_600_000,
    );
    if (globalRegistrations.length >= REGISTER_GLOBAL_PER_HOUR) {
      logger.warn(
        { limit: REGISTER_GLOBAL_PER_HOUR },
        "mcp dynamic registration: global hourly cap reached",
      );
      throw new OAuthError("access_denied", "Too many registrations.", 429);
    }
    const recent = registrations.get(key) ?? [];
    if (recent.length >= REGISTER_PER_HOUR)
      throw new OAuthError("access_denied", "Too many registrations.", 429);
    registrations.set(key, [...recent, now]);
    globalRegistrations.push(now);

    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = str(b.client_name)?.trim().slice(0, 100);
    const redirectUris = Array.isArray(b.redirect_uris)
      ? b.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];
    if (!name || redirectUris.length === 0 || redirectUris.length > 10)
      throw new OAuthError(
        "invalid_client_metadata",
        "client_name and 1 to 10 redirect_uris are required.",
      );
    const method = b.token_endpoint_auth_method;
    if (method !== undefined && method !== "none")
      throw new OAuthError(
        "invalid_client_metadata",
        "Only public clients (token_endpoint_auth_method=none) are supported.",
      );
    const scopes = (str(b.scope) ?? "")
      .split(/\s+/)
      .filter((s) => s.length > 0);
    const parsed = scopes.map((s) => mcpScopeSchema.safeParse(s));
    if (scopes.length === 0 || parsed.some((p) => !p.success))
      throw new OAuthError(
        "invalid_client_metadata",
        "scope must list valid MCP scopes.",
      );
    const client = await registerDynamicClient(tenant.tenantId, {
      clientName: name,
      redirectUris,
      scopes: [...new Set(scopes)] as never,
    });
    res.status(201).json({
      client_id: client.clientId,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      scope: client.allowedScopes.join(" "),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    });
  } catch (error) {
    if (error instanceof OAuthError) return oauthJsonError(res, error);
    next(error);
  }
});

export { mcpOAuthRouter };
