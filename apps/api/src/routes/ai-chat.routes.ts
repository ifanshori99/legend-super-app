// Tanya AI chat routes (PRD v1.7 §3 Fitur 38; bead legend-xq8y). Contract:
// `@starter/shared/ai` endpoints.ts (listAiTools, askAi, conversations).
// Mounted at `/api/ai`; each handler path is the contract path without that
// prefix. Every route needs `ai.ask`. `requireMenuPermission` mints the
// caller's tenant-wide or outlet-union RLS context (a cashier with outlet
// scope can still chat); the services re-check tool permissions per call.

import { Router } from "express";
import {
  aiToolSummarySchema,
  askAi as askAiEndpoint,
  createAiConversation as createAiConversationEndpoint,
  deleteAiConversation as deleteAiConversationEndpoint,
  getAiConversation as getAiConversationEndpoint,
  listAiConversations as listAiConversationsEndpoint,
} from "@starter/shared/ai";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireAiPlatformEnabled } from "../middleware/module.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getAccessSnapshot,
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import { askAi } from "../services/ai-orchestrator.service.ts";
import { listCallableTools } from "../services/ai-tool-invoke.service.ts";
import {
  createConversation,
  deleteConversation,
  getConversationDetail,
  listConversations,
} from "../services/ai-conversation.service.ts";

export function createAiChatRouter(): Router {
  const router = Router();
  const gate = [
    requireAuth,
    requireTrustedOrigin,
    requireTenantContext,
    requireMenuPermission("ai.ask"),
  ];

  router.get("/tools", ...gate, async (req, res) => {
    const tools = await listCallableTools({
      access: getAccessSnapshot(req),
      channel: "tanya_ai",
      mcpClientId: null,
      now: new Date(),
    });
    res.json({
      data: tools.map((tool) =>
        aiToolSummarySchema.parse({
          code: tool.code,
          name: tool.name,
          kind: tool.kind,
          titleId: tool.titleId,
          description: tool.description,
          scope: tool.scope,
          mcpAnnotations: tool.mcpAnnotations,
        }),
      ),
    });
  });

  router.post(
    "/ask",
    ...gate,
    requireAiPlatformEnabled(),
    jsonBody,
    async (req, res) => {
      const body = askAiEndpoint.body.parse(req.body);
      res.json({
        data: await askAi(
          getAccessSnapshot(req),
          getScopedTenantContext(req),
          body,
          undefined,
          getAuth(req).session.id,
        ),
      });
    },
  );

  router.get("/conversations", ...gate, async (req, res) => {
    const query = listAiConversationsEndpoint.query.parse(req.query);
    res.json(
      await listConversations(
        getAccessSnapshot(req),
        getScopedTenantContext(req),
        query,
      ),
    );
  });

  router.post(
    "/conversations",
    ...gate,
    requireAiPlatformEnabled(),
    jsonBody,
    async (req, res) => {
      const body = createAiConversationEndpoint.body.parse(req.body);
      res.status(201).json({
        data: await createConversation(
          getAccessSnapshot(req),
          getScopedTenantContext(req),
          body,
        ),
      });
    },
  );

  router.get("/conversations/:conversationId", ...gate, async (req, res) => {
    const { conversationId } = getAiConversationEndpoint.params.parse(
      req.params,
    );
    res.json({
      data: await getConversationDetail(
        getAccessSnapshot(req),
        getScopedTenantContext(req),
        conversationId,
      ),
    });
  });

  router.delete("/conversations/:conversationId", ...gate, async (req, res) => {
    const { conversationId } = deleteAiConversationEndpoint.params.parse(
      req.params,
    );
    await deleteConversation(
      getAccessSnapshot(req),
      getScopedTenantContext(req),
      conversationId,
    );
    res.status(204).end();
  });

  return router;
}

export const aiChatRouter = createAiChatRouter();
