// Tenant organisation routes (PRD v1.7 §3 F4; TEN-02/03/06). The tenant comes
// from the server-minted context (domain/token), never from the request. Every
// handler runs after requireAuth, the origin check, requireTenantContext and
// `org.structure.manage` from stored role assignments (legend-4f9); the service
// then enforces the caller's outlet scope.

import { Router, type RequestHandler } from "express";
import { AccessError } from "@starter/shared/access";
import {
  addDomainInputSchema,
  createBrandInputSchema,
  createLegalEntityInputSchema,
  createOutletInputSchema,
  decideSupportAccessRequestInputSchema,
  legalEntityIdSchema,
  setOutletStatusInputSchema,
  supportAccessGrantIdSchema,
  supportAccessRequestIdSchema,
  tenantDomainIdSchema,
  updateBrandInputSchema,
  updateLegalEntityInputSchema,
  updateOutletInputSchema,
} from "@starter/shared/platform";
import {
  brandIdSchema,
  cursorPageQuerySchema,
  outletIdSchema,
  z,
} from "@starter/shared/core";
import { getAuth, requireAuth } from "../middleware/auth";
import { requireBackOfficeSurface } from "../middleware/identity-surface";
import {
  getAccessSnapshot,
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import { requireTenantContext } from "../middleware/tenant";
import {
  addDomain,
  createBrand,
  createLegalEntity,
  createOutlet,
  getFeatureFlags,
  listBrands,
  listDomains,
  listLegalEntities,
  listOutlets,
  removeDomain,
  setOutletStatus,
  updateBrand,
  updateLegalEntity,
  updateOutlet,
  verifyDomain,
} from "../services/org.service";
import { HttpError } from "../lib/http-error";
import {
  approveSupportAccessRequest,
  endTenantSupportAccess,
  listSupportAccess,
  listSupportAccessRequests,
  rejectSupportAccessRequest,
} from "../services/platform-support.service";

export const orgRouter = Router();

// AUTH-05: a tenant member whose active role requires MFA cannot use the back
// office until this session verified a second factor (legend-qfvu).
orgRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireBackOfficeSurface(),
);

// TEN-03: role assignments determine both permission and service scope.
const manage = requireTenantPermission("org.structure.manage");

orgRouter.get("/modules", manage, async (req, res) => {
  res.json({ data: await getFeatureFlags(getScopedTenantContext(req)) });
});

// ------------------------------------------------------------------- brands

orgRouter.get("/brands", manage, async (req, res) => {
  res.json(await listBrands(getScopedTenantContext(req)));
});

orgRouter.post("/brands", manage, jsonBody, async (req, res) => {
  const input = createBrandInputSchema.parse(req.body);
  const brand = await createBrand(getScopedTenantContext(req), input);
  res.status(201).location(`/api/org/brands/${brand.id}`).json({
    data: brand,
  });
});

orgRouter.patch("/brands/:brandId", manage, jsonBody, async (req, res) => {
  const brandId = brandIdSchema.parse(req.params.brandId);
  const input = updateBrandInputSchema.parse(req.body);
  res.json({
    data: await updateBrand(getScopedTenantContext(req), brandId, input),
  });
});

// ------------------------------------------------------------------ outlets

orgRouter.get("/outlets", manage, async (req, res) => {
  const query = cursorPageQuerySchema
    .extend({ brandId: brandIdSchema.optional() })
    .parse(req.query);
  res.json(await listOutlets(getScopedTenantContext(req), query));
});

orgRouter.post("/outlets", manage, jsonBody, async (req, res) => {
  const input = createOutletInputSchema.parse(req.body);
  const outlet = await createOutlet(
    getScopedTenantContext(req),
    input,
    getAuth(req).user.id,
  );
  res.status(201).location(`/api/org/outlets/${outlet.id}`).json({
    data: outlet,
  });
});

orgRouter.patch("/outlets/:outletId", manage, jsonBody, async (req, res) => {
  const outletId = outletIdSchema.parse(req.params.outletId);
  const input = updateOutletInputSchema.parse(req.body);
  res.json({
    data: await updateOutlet(
      getScopedTenantContext(req),
      outletId,
      input,
      getAuth(req).user.id,
    ),
  });
});

orgRouter.post(
  "/outlets/:outletId/status",
  manage,
  jsonBody,
  async (req, res) => {
    const outletId = outletIdSchema.parse(req.params.outletId);
    const input = setOutletStatusInputSchema.parse(req.body);
    res.json({
      data: await setOutletStatus(getScopedTenantContext(req), outletId, input),
    });
  },
);

// ------------------------------------------------------------ legal entities

orgRouter.get("/legal-entities", manage, async (req, res) => {
  res.json(await listLegalEntities(getScopedTenantContext(req)));
});

orgRouter.post("/legal-entities", manage, jsonBody, async (req, res) => {
  const input = createLegalEntityInputSchema.parse(req.body);
  const legalEntity = await createLegalEntity(
    getScopedTenantContext(req),
    input,
  );
  res
    .status(201)
    .location(`/api/org/legal-entities/${legalEntity.id}`)
    .json({ data: legalEntity });
});

orgRouter.patch(
  "/legal-entities/:legalEntityId",
  manage,
  jsonBody,
  async (req, res) => {
    const legalEntityId = legalEntityIdSchema.parse(req.params.legalEntityId);
    const input = updateLegalEntityInputSchema.parse(req.body);
    res.json({
      data: await updateLegalEntity(
        getScopedTenantContext(req),
        legalEntityId,
        input,
      ),
    });
  },
);

// ------------------------------------------------------------------ domains

orgRouter.get("/domains", manage, async (req, res) => {
  res.json(await listDomains(getScopedTenantContext(req)));
});

orgRouter.post("/domains", manage, jsonBody, async (req, res) => {
  const input = addDomainInputSchema.parse(req.body);
  const domain = await addDomain(
    getScopedTenantContext(req),
    input,
    getAuth(req).user.id,
  );
  res.status(201).location(`/api/org/domains/${domain.id}`).json({
    data: domain,
  });
});

orgRouter.post("/domains/:domainId/verify", manage, async (req, res) => {
  const domainId = tenantDomainIdSchema.parse(req.params.domainId);
  res.json({
    data: await verifyDomain(
      getScopedTenantContext(req),
      domainId,
      getAuth(req).user.id,
    ),
  });
});

orgRouter.delete("/domains/:domainId", manage, async (req, res) => {
  const domainId = tenantDomainIdSchema.parse(req.params.domainId);
  await removeDomain(
    getScopedTenantContext(req),
    domainId,
    getAuth(req).user.id,
  );
  res.status(204).end();
});

// ---------------------------------------------------------- support access
// "Setiap sesi ... terlihat oleh admin tenant" (TEN-04): the tenant admin lists
// the Super Admin sessions that touched their tenant.
orgRouter.get("/support-access", manage, async (req, res) => {
  const query = z
    .strictObject({
      cursor: cursorPageQuerySchema.shape.cursor,
      limit: cursorPageQuerySchema.shape.limit,
    })
    .parse(req.query);
  res.json(await listSupportAccess(getScopedTenantContext(req), query));
});

// legend-c9kbk (TEN-04, Q37): a Super Admin's read_write request waits for the
// tenant owner. Only holders of `org.support_access.approve` (owner template)
// list and decide; deciding also needs a second factor verified in this
// session and is never allowed from an impersonated (support) session. The
// service re-checks the active owner-template assignment and self-approval.
const approveSupportAccess = requireTenantPermission(
  "org.support_access.approve",
);

const requireOwnerDecision: RequestHandler = (req, _res, next) => {
  const impersonatedBy = (
    getAuth(req).session as { impersonatedBy?: string | null }
  ).impersonatedBy;
  if (impersonatedBy)
    throw new HttpError(
      403,
      "IMPERSONATION_NOT_ALLOWED",
      "A support session cannot decide a support access request.",
    );
  if (!getAccessSnapshot(req).mfaVerified)
    throw new AccessError("MFA_REQUIRED");
  next();
};

const supportAccessRequestParams = z.strictObject({
  requestId: supportAccessRequestIdSchema,
});

orgRouter.post(
  "/support-access/:grantId/end",
  approveSupportAccess,
  requireOwnerDecision,
  async (req, res) => {
    const { grantId } = z
      .strictObject({ grantId: supportAccessGrantIdSchema })
      .parse(req.params);
    res.json({
      data: await endTenantSupportAccess(
        getScopedTenantContext(req),
        { userId: getAuth(req).user.id },
        grantId,
      ),
    });
  },
);

orgRouter.get(
  "/support-access/requests",
  approveSupportAccess,
  requireOwnerDecision,
  async (req, res) => {
    const query = z
      .strictObject({
        cursor: cursorPageQuerySchema.shape.cursor,
        limit: cursorPageQuerySchema.shape.limit,
      })
      .parse(req.query);
    res.json(
      await listSupportAccessRequests(
        getScopedTenantContext(req),
        { userId: getAuth(req).user.id },
        query,
      ),
    );
  },
);

orgRouter.post(
  "/support-access/requests/:requestId/approve",
  approveSupportAccess,
  requireOwnerDecision,
  jsonBody,
  async (req, res) => {
    const { requestId } = supportAccessRequestParams.parse(req.params);
    decideSupportAccessRequestInputSchema.parse(req.body);
    res.json({
      data: await approveSupportAccessRequest(
        getScopedTenantContext(req),
        { userId: getAuth(req).user.id },
        requestId,
      ),
    });
  },
);

orgRouter.post(
  "/support-access/requests/:requestId/reject",
  approveSupportAccess,
  requireOwnerDecision,
  jsonBody,
  async (req, res) => {
    const { requestId } = supportAccessRequestParams.parse(req.params);
    decideSupportAccessRequestInputSchema.parse(req.body);
    res.json({
      data: await rejectSupportAccessRequest(
        getScopedTenantContext(req),
        { userId: getAuth(req).user.id },
        requestId,
      ),
    });
  },
);

// legend-8en8 (TEN-04): the tenant owner pulls a Super Admin's access back at
// once, with the same guards as deciding a request (owner permission, a second
// factor verified in this session, never from a support session). A grant of
// another tenant answers 404.
orgRouter.post(
  "/support-access/:grantId/revoke",
  approveSupportAccess,
  requireOwnerDecision,
  jsonBody,
  async (req, res) => {
    const { grantId } = z
      .strictObject({ grantId: supportAccessGrantIdSchema })
      .parse(req.params);
    decideSupportAccessRequestInputSchema.parse(req.body);
    res.json({
      data: await endTenantSupportAccess(
        getScopedTenantContext(req),
        { userId: getAuth(req).user.id },
        grantId,
      ),
    });
  },
);
