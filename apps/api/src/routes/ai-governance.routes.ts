// AI governance and usage routes (WS-12 part G, bead legend-zfi4). Paths and
// bodies come from the contract (`@starter/shared/ai` endpoints); the router
// is mounted at `/api/ai`, so each path drops that prefix. Gates sit on each
// route (never router-wide): this router shares the mount point with the chat,
// action-request and MCP routers.
import { Router, type RequestHandler } from "express";
import { AccessError } from "@starter/shared/access";
import {
  getAiTenantUsage as tenantUsageEndpoint,
  listAiToolCalls as toolCallsEndpoint,
  updateAiGovernanceSettings as updateGovernanceEndpoint,
} from "@starter/shared/ai";
import { requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import {
  getAccessSnapshot,
  loadRequestAccess,
  requireTenantPermission,
} from "../middleware/permissions.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { requireAiPlatformEnabled } from "../middleware/module.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  getGovernanceSettings,
  getTenantUsage,
  getUsageSummary,
  listGovernanceTools,
  listToolCalls,
  updateGovernanceSettings,
} from "../services/ai-governance.service.ts";

const requireAskPermission: RequestHandler = async (req, res, next) => {
  const snapshot = await loadRequestAccess(req);
  if (!snapshot.permissions.includes("ai.ask"))
    throw new AccessError(
      "PERMISSION_DENIED",
      "Your account cannot use Tanya AI in this tenant.",
    );
  res.setHeader("Cache-Control", "private, no-store");
  next();
};

export function createAiGovernanceRouter(): Router {
  const router = Router();
  const common = [requireAuth, requireTrustedOrigin, requireTenantContext];

  router.get(
    "/governance",
    ...common,
    requireTenantPermission("ai.governance.manage"),
    async (req, res) => {
      res.json({ data: await getGovernanceSettings(getAccessSnapshot(req)) });
    },
  );

  router.patch(
    "/governance",
    ...common,
    jsonBody,
    requireTenantPermission("ai.governance.manage"),
    requireAiPlatformEnabled(),
    async (req, res) => {
      const body = updateGovernanceEndpoint.body.parse(req.body);
      res.json({
        data: await updateGovernanceSettings(getAccessSnapshot(req), body),
      });
    },
  );

  router.get(
    "/governance/tools",
    ...common,
    requireTenantPermission("ai.governance.manage"),
    async (req, res) => {
      res.json({ data: await listGovernanceTools(getAccessSnapshot(req)) });
    },
  );

  router.get(
    "/governance/usage",
    ...common,
    requireTenantPermission("ai.governance.manage"),
    async (req, res) => {
      const query = tenantUsageEndpoint.query.parse(req.query);
      res.json({ data: await getTenantUsage(getAccessSnapshot(req), query) });
    },
  );

  router.get(
    "/tool-calls",
    ...common,
    requireTenantPermission("ai.governance.manage"),
    async (req, res) => {
      const query = toolCallsEndpoint.query.parse(req.query);
      res.json(await listToolCalls(getAccessSnapshot(req), query));
    },
  );

  // ai.ask may be held at outlet scope, so this gate is not tenant-wide: the
  // summary only reads tenant settings and the caller's own counters.
  router.get("/usage", ...common, requireAskPermission, async (req, res) => {
    res.json({ data: await getUsageSummary(getAccessSnapshot(req)) });
  });

  return router;
}

export const aiGovernanceRouter = createAiGovernanceRouter();
