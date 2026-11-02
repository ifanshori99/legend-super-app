// Panel Platform routes (PRD v1.7 §3 F4, flow R; TEN-06). Super Admin only:
// every handler runs after requireAuth, the origin check and the revocable
// platform_admins registry (legend-4f9 removed the bootstrap global `admin`
// role's platform/org grants). The target tenant of /tenants/:tenantId is a
// path parameter chosen by a Super Admin, never the caller's tenant context
// (platform/endpoints.ts).
//
// Support access is additionally MFA-gated and restricted to the
// platform_admins registry inside the service (TEN-04).

import { Router } from "express";
import {
  createTenantInputSchema,
  listTenantsQuerySchema,
  setTenantPackageInputSchema,
  setTenantStatusInputSchema,
  requestSupportAccessInputSchema,
  supportAccessGrantIdSchema,
} from "@starter/shared/platform";
import { tenantIdSchema, z } from "@starter/shared/core";
import { verifiedMfaAt } from "../lib/mfa";
import { getAuth, requireAuth } from "../middleware/auth";
import { requireSessionMfa } from "../middleware/identity";
import { requirePlatformAdmin } from "../middleware/platform-admin";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  createTenant,
  getTenantOrThrow,
  listPackages,
  listTenants,
  setTenantPackage,
  setTenantStatus,
} from "../services/platform-org.service";
import {
  endSupportAccess,
  requestSupportAccess,
} from "../services/platform-support.service";

export const platformRouter = Router();

// AUTH-05/§3 F4: the Super Admin panel is MFA-only, so every platform call
// needs a second factor verified in this session, with the 30-minute
// management idle policy (legend-qfvu mounts legend-6xf's gate). The registry
// check runs first: a non-admin learns nothing about the MFA requirement.
platformRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requirePlatformAdmin,
  requireSessionMfa(),
);

const tenantParams = z.strictObject({ tenantId: tenantIdSchema });
const grantParams = z.strictObject({ grantId: supportAccessGrantIdSchema });

platformRouter.get("/packages", async (_req, res) => {
  res.json(await listPackages());
});

platformRouter.get("/tenants", async (req, res) => {
  const query = listTenantsQuerySchema.parse(req.query);
  res.json(await listTenants(query));
});

platformRouter.post("/tenants", jsonBody, async (req, res) => {
  const input = createTenantInputSchema.parse(req.body);
  const tenant = await createTenant(input, getAuth(req).user.id);
  res.status(201).location(`/api/platform/tenants/${tenant.id}`).json({
    data: tenant,
  });
});

platformRouter.get("/tenants/:tenantId", async (req, res) => {
  const { tenantId } = tenantParams.parse(req.params);
  res.json({ data: await getTenantOrThrow(tenantId) });
});

platformRouter.post("/tenants/:tenantId/status", jsonBody, async (req, res) => {
  const { tenantId } = tenantParams.parse(req.params);
  const input = setTenantStatusInputSchema.parse(req.body);
  res.json({ data: await setTenantStatus(tenantId, input) });
});

platformRouter.put("/tenants/:tenantId/package", jsonBody, async (req, res) => {
  const { tenantId } = tenantParams.parse(req.params);
  const input = setTenantPackageInputSchema.parse(req.body);
  res.json({ data: await setTenantPackage(tenantId, input) });
});

platformRouter.post(
  "/tenants/:tenantId/support-access",
  jsonBody,
  async (req, res) => {
    const { tenantId } = tenantParams.parse(req.params);
    const input = requestSupportAccessInputSchema.parse(req.body);
    const grant = await requestSupportAccess({
      tenantId,
      actorUserId: getAuth(req).user.id,
      request: input,
      // Fail closed until the identity bead stores MFA factors (lib/mfa.ts).
      mfaVerifiedAt: await verifiedMfaAt(req),
    });
    res.status(201).location(`/api/platform/support-access/${grant.id}`).json({
      data: grant,
    });
  },
);

platformRouter.post("/support-access/:grantId/end", async (req, res) => {
  const { grantId } = grantParams.parse(req.params);
  // support_access_grants is tenant-owned (RLS), so ending a session needs
  // its tenant; the platform contract has no body here, so the tenant
  // travels as a validated query parameter. The grant id alone is never
  // trusted to pick a tenant.
  const tenantId = tenantIdSchema.parse(req.query.tenantId);
  const grant = await endSupportAccess({
    tenantId,
    grantId,
    actorUserId: getAuth(req).user.id,
  });
  res.json({ data: grant });
});
