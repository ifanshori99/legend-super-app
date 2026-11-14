// MCP client and token admin routes (WS-12 part M, bead legend-xkbt). Paths and
// bodies come from the contract (`@starter/shared/ai` endpoints); mounted at
// `/api/ai`. Gates sit on each route: this router shares the mount point with
// the other AI routers. Own-token routes need only a signed-in tenant user.
import { Router } from "express";
import { z } from "zod";
import {
  AiError,
  approveMcpClient as approveEndpoint,
  listMcpClients as listClientsEndpoint,
  listMcpTokens as listTokensEndpoint,
  previewMcpAuthorize as previewEndpoint,
  registerMcpClient as registerEndpoint,
  revokeMcpClient as revokeClientEndpoint,
  revokeMcpToken as revokeTokenEndpoint,
} from "@starter/shared/ai";
import { requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getAccessSnapshot,
  loadRequestAccess,
  requireTenantPermission,
} from "../middleware/permissions.ts";
import {
  issueAuthorizationCode,
  OAuthError,
  oauthErrorRedirect,
  previewAuthorizationRequest,
} from "../services/mcp-oauth.service.ts";
import { requireAiPlatformEnabled } from "../middleware/module.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  approveMcpClient,
  listMcpClients,
  listMcpTokens,
  registerMcpClient,
  revokeMcpClient,
  revokeMcpToken,
} from "../services/mcp-admin.service.ts";

/**
 * Consent confirmation (MCP-05). The consent screen posts the OAuth request
 * it received plus `approve: true`; the user's own session decides who the
 * code is for.
 */
const mcpAuthorizeBodySchema = z.strictObject({
  response_type: z.string().min(1).max(20),
  client_id: z.string().min(1).max(100),
  redirect_uri: z.string().min(1).max(2000),
  scope: z.string().max(1000).optional(),
  state: z.string().max(2000).optional(),
  code_challenge: z.string().min(1).max(200),
  code_challenge_method: z.string().min(1).max(20),
  approve: z.literal(true),
});

export function createAiMcpAdminRouter(): Router {
  const router = Router();
  const common = [requireAuth, requireTrustedOrigin, requireTenantContext];
  const manage = requireTenantPermission("mcp.client.manage");
  const own: import("express").RequestHandler = async (req, res, next) => {
    await loadRequestAccess(req);
    res.setHeader("Cache-Control", "private, no-store");
    next();
  };

  router.get("/mcp-clients", ...common, manage, async (req, res) => {
    const query = listClientsEndpoint.query.parse(req.query);
    res.json(await listMcpClients(getAccessSnapshot(req), query));
  });

  router.post(
    "/mcp-clients",
    ...common,
    jsonBody,
    manage,
    requireAiPlatformEnabled(),
    async (req, res) => {
      const body = registerEndpoint.body.parse(req.body);
      res.status(201).json({
        data: await registerMcpClient(getAccessSnapshot(req), body),
      });
    },
  );

  router.post(
    "/mcp-clients/:mcpClientId/approve",
    ...common,
    jsonBody,
    manage,
    requireAiPlatformEnabled(),
    async (req, res) => {
      const { mcpClientId } = approveEndpoint.params.parse(req.params);
      const body = approveEndpoint.body.parse(req.body);
      res.json({
        data: await approveMcpClient(getAccessSnapshot(req), mcpClientId, body),
      });
    },
  );

  router.post(
    "/mcp-clients/:mcpClientId/revoke",
    ...common,
    jsonBody,
    manage,
    async (req, res) => {
      const { mcpClientId } = revokeClientEndpoint.params.parse(req.params);
      const body = revokeClientEndpoint.body.parse(req.body);
      res.json({
        data: await revokeMcpClient(getAccessSnapshot(req), mcpClientId, body),
      });
    },
  );

  // Preview is not a redirect: a locked tenant answers plain 403
  // AI_PLATFORM_DISABLED (the consent screen shows it).
  router.get(
    "/mcp/authorize/preview",
    ...common,
    own,
    requireAiPlatformEnabled(),
    async (req, res) => {
      const q = previewEndpoint.query.parse(req.query);
      try {
        res.json({
          data: await previewAuthorizationRequest(getAccessSnapshot(req), {
            responseType: q.response_type ?? "code",
            clientId: q.client_id,
            redirectUri: q.redirect_uri,
            scope: q.scope,
            state: q.state,
            codeChallenge: q.code_challenge,
            codeChallengeMethod: q.code_challenge_method,
          }),
        });
      } catch (error) {
        if (!(error instanceof OAuthError)) throw error;
        if (error.description === "AI_PLATFORM_DISABLED")
          throw new AiError("AI_PLATFORM_DISABLED");
        res.status(error.status).json({
          error: { code: error.error, message: error.description },
        });
      }
    },
  );

  // Locked tenant answers 403 AI_PLATFORM_DISABLED, never a code or a redirect.
  router.post(
    "/mcp/authorize",
    ...common,
    jsonBody,
    own,
    requireAiPlatformEnabled(),
    async (req, res) => {
      const body = mcpAuthorizeBodySchema.parse(req.body);
      const params = {
        responseType: body.response_type,
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        scope: body.scope,
        state: body.state,
        codeChallenge: body.code_challenge,
        codeChallengeMethod: body.code_challenge_method,
      };
      try {
        const redirectTo = await issueAuthorizationCode(
          getAccessSnapshot(req),
          params,
        );
        res.json({ redirectTo });
      } catch (error) {
        if (!(error instanceof OAuthError)) throw error;
        // Lock won the race after the gate: plain 403, not the redirect below.
        if (error.description === "AI_PLATFORM_DISABLED")
          throw new AiError("AI_PLATFORM_DISABLED");
        // A refusal the client may see goes back to its registered redirect_uri.
        if (error.redirectUri)
          return void res.json({
            redirectTo: oauthErrorRedirect(error, body.state),
          });
        res.status(error.status).json({
          error: { code: error.error, message: error.description },
        });
      }
    },
  );

  router.get("/mcp-tokens", ...common, own, async (req, res) => {
    const query = listTokensEndpoint.query.parse(req.query);
    res.json(await listMcpTokens(getAccessSnapshot(req), query));
  });

  router.post(
    "/mcp-tokens/:mcpTokenId/revoke",
    ...common,
    jsonBody,
    own,
    async (req, res) => {
      const { mcpTokenId } = revokeTokenEndpoint.params.parse(req.params);
      const body = revokeTokenEndpoint.body.parse(req.body);
      res.json({
        data: await revokeMcpToken(getAccessSnapshot(req), mcpTokenId, body),
      });
    },
  );

  return router;
}

export const aiMcpAdminRouter = createAiMcpAdminRouter();
