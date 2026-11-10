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
import { getAuth, requireAuth } from "../middleware/auth";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getRequestAccessData,
  loadRequestAccess,
} from "../middleware/permissions";
import { supportSessionOf } from "../middleware/support-session";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { listMyOutlets } from "../services/me-outlets.service";

export const meRouter = Router();

meRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

meRouter.get("/access", async (req, res) => {
  const snapshot = await loadRequestAccess(req);
  // Station reach (legend-fsb7): the stations the caller may work on for at
  // least one permission they hold, from the same assignments the API
  // enforces with `stationReachOf`. A station-scoped account sees only its own
  // station(s); a wider scope sees every station it reaches. A KDS client uses
  // this so it never polls a board the API would deny.
  const stations = [
    ...new Set(
      snapshot.permissions.flatMap((permission) =>
        snapshot.stationsFor(permission),
      ),
    ),
  ].sort();
  // Support session (TEN-04): an impersonated session shows its grant's mode
  // and expiry (cached from the requireAuth guard). A normal session costs no
  // extra query.
  const support = await supportSessionOf(req);
  // Assigned outlets (legend-ebt9f): filtered from the session user's stored
  // assignments, never from request input.
  const outlets = await listMyOutlets({
    tenant: getTenantContext(req),
    userId: getAuth(req).user.id,
    data: getRequestAccessData(req),
    now: new Date(),
  });
  res.json({
    data: myAccessViewSchema.parse({
      permissions: snapshot.permissions,
      mfaRequired: snapshot.mfaRequired,
      mfaVerified: snapshot.mfaVerified,
      stations,
      outlets,
      supportSession: support
        ? { accessMode: support.accessMode, expiresAt: support.expiresAt }
        : null,
    }),
  });
});
