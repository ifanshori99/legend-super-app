// Self-service access view (bead legend-t4y7; PRD v1.7 §3.7, AUTH-05).
//
// The web area guards (`apps/web/src/lib/areas/load-access.ts`) used to fail
// every work area closed because a Better Auth session carries no Legend
// permissions. This endpoint returns the caller's effective permissions in the
// tenant the domain or token resolved (TEN-02), plus `users.mfa_required` and
// whether the session passed a second factor. Presentation and guard data
// only: every API request is authorized again by the permission middleware.

import { Router, type Request, type Response } from "express";
import {
  myAccessViewSchema,
  setActiveOutletInputSchema,
} from "@starter/shared/access";
import {
  getAuth,
  requireAuth,
  requireAuthAllowSharedDevice,
} from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import { isRequestOnSharedDevice } from "../middleware/shared-device-allowlist";
import {
  getRequestAccessData,
  loadRequestAccess,
} from "../middleware/permissions";
import { supportSessionOf } from "../middleware/support-session";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { canChangeAnyEmployeeManager } from "../services/hris-employee-manager.service";
import {
  activeOutletOf,
  setActiveOutlet,
} from "../services/me-active-outlet.service";
import { listMyOutlets } from "../services/me-outlets.service";
import { MENU_ITEM_PERMISSION } from "../services/menu-internals";

export const meRouter = Router();

// Per route: only the shell read (GET /access) is open to a shared POS device;
// every write stays on the strict guard (shared device refused).
meRouter.get(
  "/access",
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  accessRead,
);

async function accessRead(req: Request, res: Response) {
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
  // "Ubah atasan" hint (HR or a brand/tenant GM). Presentation only: PATCH
  // /employees/:id/manager decides again. Under a read-only support session the
  // API refuses writes, so the button is hidden too.
  const canChangeEmployeeManager =
    support?.accessMode === "read_only"
      ? false
      : await canChangeAnyEmployeeManager(
          getTenantContext(req),
          getAuth(req).user.id,
        );
  // Station rename/retype/delete hint (legend-huz8): PATCH name/type and
  // DELETE /menu/stations/:id need `menu.item.manage` on the station's outlet
  // (legend-cot3), so a grant held only at station scope never qualifies. True
  // when the permission holds at tenant scope or at some assigned outlet
  // (a brand grant reaches its outlets). Presentation only: the API decides
  // again. A read-only support session is refused writes, so false there.
  const canManageStationConfig =
    support?.accessMode === "read_only"
      ? false
      : snapshot.allows(MENU_ITEM_PERMISSION, { type: "tenant" }) ||
        outlets.some((outlet) =>
          snapshot.allows(MENU_ITEM_PERMISSION, {
            type: "outlet",
            id: outlet.id,
          }),
        );
  res.json({
    data: myAccessViewSchema.parse({
      permissions: snapshot.permissions,
      mfaRequired: snapshot.mfaRequired,
      mfaVerified: snapshot.mfaVerified,
      stations,
      outlets,
      // Pinned outlet (legend-6vgv), re-checked against the assigned list.
      activeOutletId: await activeOutletOf({
        tenant: getTenantContext(req),
        sessionId: getAuth(req).session.id,
        assignedIds: outlets.map((outlet) => outlet.id),
      }),
      supportSession: support
        ? { accessMode: support.accessMode, expiresAt: support.expiresAt }
        : null,
      canChangeEmployeeManager,
      canManageStationConfig,
      // Presentation only (legend-iq0jz): the API closes the screens itself.
      sharedDevice: isRequestOnSharedDevice(req),
    }),
  });
}

// Pin the outlet the outlet-less floor routes work on (legend-6vgv). The id is
// schema-checked, then must be one of the caller's own assigned outlets;
// another tenant's outlet and an unknown id answer the same 404.
meRouter.put(
  "/active-outlet",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  jsonBody,
  setActiveOutletRoute,
);

async function setActiveOutletRoute(req: Request, res: Response) {
  const input = setActiveOutletInputSchema.parse(req.body);
  await loadRequestAccess(req);
  const activeOutletId = await setActiveOutlet({
    tenant: getTenantContext(req),
    userId: getAuth(req).user.id,
    sessionId: getAuth(req).session.id,
    data: getRequestAccessData(req),
    outletId: input.outletId,
    now: new Date(),
  });
  res.json({ data: { activeOutletId } });
}
