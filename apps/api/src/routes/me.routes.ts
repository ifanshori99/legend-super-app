// Self-service access view (bead legend-t4y7; PRD v1.7 §3.7, AUTH-05).
//
// The web area guards (`apps/web/src/lib/areas/load-access.ts`) used to fail
// every work area closed because a Better Auth session carries no Legend
// permissions. This endpoint returns the caller's effective permissions in the
// tenant the domain or token resolved (TEN-02), plus `users.mfa_required` and
// whether the session passed a second factor. Presentation and guard data
// only: every API request is authorized again by the permission middleware.

import { Router } from "express";
import { myAccessViewSchema } from "@starter/shared/access";
import { requireAuth } from "../middleware/auth";
import { requireTrustedOrigin } from "../middleware/origin";
import { loadRequestAccess } from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";

export const meRouter = Router();

meRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

meRouter.get("/access", async (req, res) => {
  const snapshot = await loadRequestAccess(req);
  res.json({
    data: myAccessViewSchema.parse({
      permissions: snapshot.permissions,
      mfaRequired: snapshot.mfaRequired,
      mfaVerified: snapshot.mfaVerified,
    }),
  });
});
