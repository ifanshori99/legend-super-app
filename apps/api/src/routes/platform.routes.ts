// Panel Platform routes (PRD v1.7 §3 F4, flow R; TEN-06). Super Admin only:
// every handler runs after requirePlatformAuth (requireAuth plus the
// impersonation denial audit), the origin check and the revocable
// platform_admins registry (legend-4f9 removed the bootstrap global `admin`
// role's platform/org grants). The target tenant of /tenants/:tenantId is a
// path parameter chosen by a Super Admin, never the caller's tenant context
// (platform/endpoints.ts).
//
// Support access is additionally MFA-gated and restricted to the
// platform_admins registry inside the service (TEN-04). So is appointing or
// replacing a tenant Owner (legend-ktc4d, founder decision Q44).

import { Router } from "express";
import {
  assignTenantOwnerInputSchema,
  createTenantInputSchema,
  listTenantsQuerySchema,
  setTenantPackageInputSchema,
  setTenantStatusInputSchema,
  platformEndpoints,
  restoreOutletInputSchema,
  restoreTenantInputSchema,
  replaceTenantOwnerInputSchema,
  requestSupportAccessInputSchema,
  requestSupportWriteAccessInputSchema,
  supportAccessGrantIdSchema,
  tenantOwnerAssignmentIdSchema,
} from "@starter/shared/platform";
import { outletIdSchema, tenantIdSchema, z } from "@starter/shared/core";
import { verifiedMfaAt } from "../lib/mfa";
import { getAuth } from "../middleware/auth";
import { requireSessionMfa } from "../middleware/identity";
import {
  requirePlatformAdmin,
  requirePlatformAuth,
} from "../middleware/platform-admin";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  createTenant,
  getOutletRestoreWindow,
  getTenantOrThrow,
  getTenantRestoreWindow,
  listPackages,
  listTenants,
  restoreOutlet,
  restoreTenant,
  setTenantPackage,
  setTenantStatus,
} from "../services/platform-org.service";
import {
  endSupportAccess,
  listPlatformSupportAccess,
  requestSupportAccess,
  requestSupportWriteAccess,
} from "../services/platform-support.service.ts";
import {
  assignTenantOwner,
  replaceTenantOwner,
} from "../services/platform-tenant-owner.service.ts";

export const platformRouter = Router();

// AUTH-05/§3 F4: the Super Admin panel is MFA-only, so every platform call
// needs a second factor verified in this session, with the 30-minute
// management idle policy (legend-qfvu mounts legend-6xf's gate). The registry
// check runs first: a non-admin learns nothing about the MFA requirement.
platformRouter.use(
  requirePlatformAuth,
  requireTrustedOrigin,
  requirePlatformAdmin,
  requireSessionMfa(),
);

const tenantParams = z.strictObject({ tenantId: tenantIdSchema });
const outletParams = z.strictObject({
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
});
const grantParams = z.strictObject({ grantId: supportAccessGrantIdSchema });
const ownerAssignmentParams = z.strictObject({
  tenantId: tenantIdSchema,
  assignmentId: tenantOwnerAssignmentIdSchema,
});

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
  res.json({
    data: await setTenantStatus(tenantId, input, getAuth(req).user.id),
  });
});

// Q40 (legend-umzos): restore within 30 days; the generic status endpoint
// still refuses to leave archived/closed.
platformRouter.post(
  "/tenants/:tenantId/restore",
  jsonBody,
  async (req, res) => {
    const { tenantId } = tenantParams.parse(req.params);
    const input = restoreTenantInputSchema.parse(req.body);
    res.json({
      data: await restoreTenant(tenantId, input, getAuth(req).user.id),
    });
  },
);

platformRouter.get("/tenants/:tenantId/restore-window", async (req, res) => {
  const { tenantId } = tenantParams.parse(req.params);
  res.json({ data: await getTenantRestoreWindow(tenantId) });
});

platformRouter.post(
  "/tenants/:tenantId/outlets/:outletId/restore",
  jsonBody,
  async (req, res) => {
    const { tenantId, outletId } = outletParams.parse(req.params);
    const input = restoreOutletInputSchema.parse(req.body);
    res.json({
      data: await restoreOutlet(
        tenantId,
        outletId,
        input,
        getAuth(req).user.id,
      ),
    });
  },
);

platformRouter.get(
  "/tenants/:tenantId/outlets/:outletId/restore-window",
  async (req, res) => {
    const { tenantId, outletId } = outletParams.parse(req.params);
    res.json({ data: await getOutletRestoreWindow(tenantId, outletId) });
  },
);

platformRouter.put("/tenants/:tenantId/package", jsonBody, async (req, res) => {
  const { tenantId } = tenantParams.parse(req.params);
  const input = setTenantPackageInputSchema.parse(req.body);
  res.json({
    data: await setTenantPackage(tenantId, input, getAuth(req).user.id),
  });
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
      // TEN-04: the TOTP code in this request is re-verified (lib/mfa.ts);
      // no factor or a wrong/replayed code → null → refused and audited.
      mfaVerifiedAt: await verifiedMfaAt(req),
    });
    res.status(201).location(`/api/platform/support-access/${grant.id}`).json({
      data: grant,
    });
  },
);

// legend-c9kbk: read_write is a request the tenant owner must approve; the
// grant only exists after approval. Same TOTP re-verification as above.
platformRouter.post(
  "/tenants/:tenantId/support-access-requests",
  jsonBody,
  async (req, res) => {
    const { tenantId } = tenantParams.parse(req.params);
    const input = requestSupportWriteAccessInputSchema.parse(req.body);
    const request = await requestSupportWriteAccess({
      tenantId,
      actorUserId: getAuth(req).user.id,
      request: input,
      mfaVerifiedAt: await verifiedMfaAt(req),
    });
    res.status(201).json({ data: request });
  },
);

// TEN-04: every support session across tenants (optionally one tenant),
// newest first. Grants stay tenant-owned (RLS); the service reads each
// tenant in its own transaction.
platformRouter.get("/support-access", async (req, res) => {
  const query = platformEndpoints.listSupportAccess.query.parse(req.query);
  res.json(await listPlatformSupportAccess(query));
});

platformRouter.post("/support-access/:grantId/end", async (req, res) => {
  const { grantId } = grantParams.parse(req.params);
  // The contract carries only the grant id; the service locates its tenant
  // under RLS. A validated ?tenantId= narrows the lookup (never widens it:
  // a grant outside that tenant is a 404). Ending is idempotent.
  const { tenantId } = z
    .strictObject({ tenantId: tenantIdSchema.optional() })
    .parse(req.query);
  const grant = await endSupportAccess({
    tenantId,
    grantId,
    actorUserId: getAuth(req).user.id,
  });
  res.json({ data: grant });
});

// legend-ktc4d: a Super Admin appoints (or replaces) a tenant Owner. The
// service refuses impersonated sessions, re-checks the registry and needs the
// TOTP code in this request (TEN-04 freshness); every refusal is audited.
platformRouter.post("/tenants/:tenantId/owners", jsonBody, async (req, res) => {
  const { tenantId } = tenantParams.parse(req.params);
  const input = assignTenantOwnerInputSchema.parse(req.body);
  const auth = getAuth(req);
  const data = await assignTenantOwner({
    tenantId,
    actorUserId: auth.user.id,
    impersonatedBy: auth.session.impersonatedBy ?? null,
    mfaVerifiedAt: await verifiedMfaAt(req),
    input,
  });
  res.status(201).json({ data });
});

platformRouter.post(
  "/tenants/:tenantId/owners/:assignmentId/replace",
  jsonBody,
  async (req, res) => {
    const { tenantId, assignmentId } = ownerAssignmentParams.parse(req.params);
    const input = replaceTenantOwnerInputSchema.parse(req.body);
    const auth = getAuth(req);
    const data = await replaceTenantOwner({
      tenantId,
      actorUserId: auth.user.id,
      impersonatedBy: auth.session.impersonatedBy ?? null,
      mfaVerifiedAt: await verifiedMfaAt(req),
      input,
      replacedAssignmentId: assignmentId,
    });
    res.status(201).json({ data });
  },
);
