import { Router, type Request, type RequestHandler } from "express";
import { AccessError } from "@starter/shared/access";
import {
  pollChatgptDeviceConnection,
  startChatgptDeviceConnection,
} from "@starter/shared/ai";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireBackOfficeSurface } from "../middleware/identity-surface.ts";
import { requireAiPlatformEnabled } from "../middleware/module.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getAccessSnapshot,
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  getChatgptConnectionView,
  startChatgptConnection,
  pollChatgptConnection,
  removeChatgptConnection,
} from "../services/ai-chatgpt.service.ts";

const viewerCanManage = (req: Request): boolean =>
  !getAuth(req).session.impersonatedBy &&
  getAccessSnapshot(req).allowsVia("owner", "ai.governance.manage", {
    type: "tenant",
  });
const ownerOnly: RequestHandler = (req, _res, next) => {
  // Read-only governance access never represents the owner's personal consent.
  if (!viewerCanManage(req)) throw new AccessError("PERMISSION_DENIED");
  next();
};
export const aiChatgptRouter = Router();
const gate = [
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireBackOfficeSurface(),
  requireTenantPermission("ai.governance.manage"),
];
aiChatgptRouter.get("/chatgpt", ...gate, async (req, res) => {
  res.json({
    data: await getChatgptConnectionView(
      getScopedTenantContext(req),
      viewerCanManage(req),
    ),
  });
});
aiChatgptRouter.post(
  "/chatgpt/device",
  ...gate,
  ownerOnly,
  requireAiPlatformEnabled(),
  jsonBody,
  async (req, res) => {
    const input = startChatgptDeviceConnection.body.parse(req.body);
    res.json({
      data: await startChatgptConnection(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        input,
      ),
    });
  },
);
aiChatgptRouter.post(
  "/chatgpt/device/poll",
  ...gate,
  ownerOnly,
  requireAiPlatformEnabled(),
  jsonBody,
  async (req, res) => {
    const input = pollChatgptDeviceConnection.body.parse(req.body);
    res.json({
      data: await pollChatgptConnection(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        input.attemptId,
      ),
    });
  },
);
aiChatgptRouter.delete("/chatgpt", ...gate, ownerOnly, async (req, res) => {
  res.json({
    data: await removeChatgptConnection(
      getScopedTenantContext(req),
      getAuth(req).user.id,
    ),
  });
});
