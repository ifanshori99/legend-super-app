import { Router, type RequestHandler } from "express";
import { AccessError } from "@starter/shared/access";
import {
  pollChatgptDeviceConnection,
  startChatgptDeviceConnection,
} from "@starter/shared/ai";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireBackOfficeSurface } from "../middleware/identity-surface.ts";
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

const ownerOnly: RequestHandler = (req, _res, next) => {
  // Support impersonation never represents the owner's personal consent.
  if (getAuth(req).session.impersonatedBy)
    throw new AccessError("PERMISSION_DENIED");
  if (
    !getAccessSnapshot(req).allowsVia("owner", "ai.governance.manage", {
      type: "tenant",
    })
  )
    throw new AccessError("PERMISSION_DENIED");
  next();
};
export const aiChatgptRouter = Router();
const gate = [
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireBackOfficeSurface(),
  requireTenantPermission("ai.governance.manage"),
  ownerOnly,
];
aiChatgptRouter.get("/chatgpt", ...gate, async (req, res) => {
  res.json({
    data: await getChatgptConnectionView(getScopedTenantContext(req)),
  });
});
aiChatgptRouter.post("/chatgpt/device", ...gate, jsonBody, async (req, res) => {
  const input = startChatgptDeviceConnection.body.parse(req.body);
  res.json({
    data: await startChatgptConnection(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    ),
  });
});
aiChatgptRouter.post(
  "/chatgpt/device/poll",
  ...gate,
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
aiChatgptRouter.delete("/chatgpt", ...gate, async (req, res) => {
  res.json({
    data: await removeChatgptConnection(
      getScopedTenantContext(req),
      getAuth(req).user.id,
    ),
  });
});
