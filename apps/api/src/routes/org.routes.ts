// Tenant organisation routes (PRD v1.7 §3 F4; TEN-02/03/06). The tenant comes
// from the server-minted context (domain/token), never from the request. Every
// handler runs after requireAuth, the origin check, requireTenantContext and an
// org.* permission; the service then enforces the caller's outlet scope.
//
// Outlet scope: role assignments are not stored yet (RBAC bead legend-4f9), so
// these routes hand the service a tenant-wide scope. The services already take
// any ScopedTenantContext and filter/deny by outlet, which is what the TEN-03
// test exercises; legend-4f9 only has to swap the scope source here.

import { Router, type Request } from "express";
import {
  addDomainInputSchema,
  createBrandInputSchema,
  createLegalEntityInputSchema,
  createOutletInputSchema,
  legalEntityIdSchema,
  setOutletStatusInputSchema,
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
import { establishScopedTenantContext } from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { requireAuth, requirePermission } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
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
} from "../services/org.service";
import { listSupportAccess } from "../services/platform-support.service";

export const orgRouter = Router();

orgRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

/** Server-minted tenant context -> the scope services enforce (TEN-03). */
function scoped(req: Request): ScopedTenantContext {
  return establishScopedTenantContext(getTenantContext(req), {
    kind: "tenant",
  });
}

// One org permission for reads and writes; the Legend RBAC catalog splits
// reads (org.*.view) when role_assignments land (legend-4f9).
const manage = requirePermission({ org: ["structure-manage"] });

orgRouter.get("/modules", manage, async (req, res) => {
  res.json({ data: await getFeatureFlags(scoped(req)) });
});

// ------------------------------------------------------------------- brands

orgRouter.get("/brands", manage, async (req, res) => {
  res.json(await listBrands(scoped(req)));
});

orgRouter.post("/brands", manage, jsonBody, async (req, res) => {
  const input = createBrandInputSchema.parse(req.body);
  const brand = await createBrand(scoped(req), input);
  res.status(201).location(`/api/org/brands/${brand.id}`).json({
    data: brand,
  });
});

orgRouter.patch("/brands/:brandId", manage, jsonBody, async (req, res) => {
  const brandId = brandIdSchema.parse(req.params.brandId);
  const input = updateBrandInputSchema.parse(req.body);
  res.json({ data: await updateBrand(scoped(req), brandId, input) });
});

// ------------------------------------------------------------------ outlets

orgRouter.get("/outlets", manage, async (req, res) => {
  const query = cursorPageQuerySchema
    .extend({ brandId: brandIdSchema.optional() })
    .parse(req.query);
  res.json(await listOutlets(scoped(req), query));
});

orgRouter.post("/outlets", manage, jsonBody, async (req, res) => {
  const input = createOutletInputSchema.parse(req.body);
  const outlet = await createOutlet(scoped(req), input);
  res.status(201).location(`/api/org/outlets/${outlet.id}`).json({
    data: outlet,
  });
});

orgRouter.patch("/outlets/:outletId", manage, jsonBody, async (req, res) => {
  const outletId = outletIdSchema.parse(req.params.outletId);
  const input = updateOutletInputSchema.parse(req.body);
  res.json({ data: await updateOutlet(scoped(req), outletId, input) });
});

orgRouter.post(
  "/outlets/:outletId/status",
  manage,
  jsonBody,
  async (req, res) => {
    const outletId = outletIdSchema.parse(req.params.outletId);
    const input = setOutletStatusInputSchema.parse(req.body);
    res.json({ data: await setOutletStatus(scoped(req), outletId, input) });
  },
);

// ------------------------------------------------------------ legal entities

orgRouter.get("/legal-entities", manage, async (req, res) => {
  res.json(await listLegalEntities(scoped(req)));
});

orgRouter.post("/legal-entities", manage, jsonBody, async (req, res) => {
  const input = createLegalEntityInputSchema.parse(req.body);
  const legalEntity = await createLegalEntity(scoped(req), input);
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
      data: await updateLegalEntity(scoped(req), legalEntityId, input),
    });
  },
);

// ------------------------------------------------------------------ domains

orgRouter.get("/domains", manage, async (req, res) => {
  res.json(await listDomains(scoped(req)));
});

orgRouter.post("/domains", manage, jsonBody, async (req, res) => {
  const input = addDomainInputSchema.parse(req.body);
  const domain = await addDomain(scoped(req), input);
  res.status(201).location(`/api/org/domains/${domain.id}`).json({
    data: domain,
  });
});

orgRouter.delete("/domains/:domainId", manage, async (req, res) => {
  const domainId = tenantDomainIdSchema.parse(req.params.domainId);
  await removeDomain(scoped(req), domainId);
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
  res.json(await listSupportAccess(scoped(req), query));
});
