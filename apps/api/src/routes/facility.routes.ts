// Facility schema, slot availability, queue, unit and configuration routes
// (PRD v1.7 §3 F22/F25; beads legend-nm4f + legend-8dpm; FAC-02, FAC-06).
// Paths, params, bodies and queries come from the WS-09 contract
// (`@starter/shared/facility` defineEndpoint objects), so the API and the web
// client cannot drift. Mount at `/api/facility`.
//
// The tenant comes from the server-minted context, never the request
// (TEN-02). The facility, area and unit records are outlet-owned and the
// request names no outlet, so the gate is `requireMenuPermission` (reach to
// the permission in tenant scope or the union of outlets) and every service
// re-checks the permission on the concrete record's outlet inside the tenant
// transaction (TEN-03); RLS hides other outlets.
//
// The staff reads (unit board, availability, incident log) are gated by
// `facility.booth.operate`; the config index and every config write by
// `facility.config.manage` (the tenant admin holds the latter, not the
// former). Ticket booking/credentials (legend-bzih), entitlements
// (legend-fjk5) and cleaning tasks are other beads' routes.
import { Router, type Request } from "express";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  createFacility as createFacilityEndpoint,
  createFacilityAddon as createFacilityAddonEndpoint,
  createFacilityArea as createFacilityAreaEndpoint,
  createFacilityProduct as createFacilityProductEndpoint,
  createFacilityUnit as createFacilityUnitEndpoint,
  createSubscriptionPlanEndpoint,
  getCurrentFacilityQueueEntry as getCurrentFacilityQueueEntryEndpoint,
  getFacilityAvailability as getFacilityAvailabilityEndpoint,
  getFacilityConfig as getFacilityConfigEndpoint,
  getFacilityUnitBoard as getFacilityUnitBoardEndpoint,
  joinFacilityQueue as joinFacilityQueueEndpoint,
  leaveFacilityQueue as leaveFacilityQueueEndpoint,
  listFacilities as listFacilitiesEndpoint,
  listFacilityIncidents as listFacilityIncidentsEndpoint,
  putEntitlementRule as putEntitlementRuleEndpoint,
  updateFacility as updateFacilityEndpoint,
  updateFacilityAddon as updateFacilityAddonEndpoint,
  updateFacilityArea as updateFacilityAreaEndpoint,
  updateFacilityProduct as updateFacilityProductEndpoint,
  updateFacilityUnit as updateFacilityUnitEndpoint,
  updateFacilityUnitConfig as updateFacilityUnitConfigEndpoint,
  updateSubscriptionPlan as updateSubscriptionPlanEndpoint,
} from "@starter/shared/facility";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { facilityIncidentsRouter } from "./facility-incidents.routes.ts";
import { wfcAdminRouter } from "./wfc-admin.routes.ts";
import * as config from "../services/facility-config.service.ts";
import * as incidents from "../services/facility-incidents.service.ts";
import * as products from "../services/facility-products.service.ts";
import * as queue from "../services/facility-queue.service.ts";
import * as slots from "../services/facility-slots.service.ts";
import * as units from "../services/facility-units.service.ts";
import { findProfileByUser } from "../services/member-profile.service.ts";

/**
 * Port: the customer profile of the signed-in guest (WS-08 profile bead). The
 * queue routes act for "the caller", so they need it. The default looks up the
 * caller's own profile by (tenant, session user) and only an `active` one
 * counts; no profile or any other status is null, so the route answers 403.
 */
export type FacilityCustomerResolver = (
  req: Request,
  context: ScopedTenantContext,
) => Promise<string | null>;

const defaultCustomerResolver: FacilityCustomerResolver = async (
  req,
  context,
) => {
  const profile = await withTenant(db, context, (tx) =>
    findProfileByUser(tx, context.tenant.tenantId, getAuth(req).user.id),
  );
  return profile?.membershipStatus === "active" ? profile.id : null;
};

let resolveCustomer: FacilityCustomerResolver = defaultCustomerResolver;

/** Tests inject a double; null restores the default profile lookup. */
export function setFacilityCustomerResolver(
  resolver: FacilityCustomerResolver | null,
): void {
  resolveCustomer = resolver ?? defaultCustomerResolver;
}

async function customerOf(
  req: Request,
  context: ScopedTenantContext,
): Promise<string> {
  const id = await resolveCustomer(req, context);
  if (!id)
    throw new HttpError(
      403,
      "CUSTOMER_PROFILE_REQUIRED",
      "Akun ini belum memiliki profil pelanggan.",
    );
  return id;
}

const operate = requireMenuPermission("facility.booth.operate");
const manage = requireMenuPermission("facility.config.manage");

export const facilityRouter = Router();
facilityRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);
// Incident raise/respond + plan list (bead legend-1cj0).
facilityRouter.use(facilityIncidentsRouter);
// Paid WFC admin: seats, quota, product, settings (brief 1270 W1/W1b).
facilityRouter.use("/wfc", wfcAdminRouter);

// ------------------------------------------------------------ availability

facilityRouter.get("/availability", operate, async (req, res) => {
  const query = getFacilityAvailabilityEndpoint.query.parse(req.query);
  res.json({
    data: await slots.getFacilityAvailability(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  });
});

// ------------------------------------------------------------------ queue

facilityRouter.post("/queue", operate, jsonBody, async (req, res) => {
  const input = joinFacilityQueueEndpoint.body.parse(req.body);
  const context = getScopedTenantContext(req);
  const entry = await queue.joinFacilityQueue(
    context,
    getAuth(req).user.id,
    await customerOf(req, context),
    input,
  );
  res.status(201).json({ data: entry });
});

// Fixed path before /queue/:entryId.
facilityRouter.get("/queue/current", operate, async (req, res) => {
  const query = getCurrentFacilityQueueEntryEndpoint.query.parse(req.query);
  const context = getScopedTenantContext(req);
  res.json({
    data: await queue.getCurrentFacilityQueueEntry(
      context,
      getAuth(req).user.id,
      await customerOf(req, context),
      query,
    ),
  });
});

facilityRouter.delete("/queue/:entryId", operate, async (req, res) => {
  const { entryId } = leaveFacilityQueueEndpoint.params.parse(req.params);
  const context = getScopedTenantContext(req);
  await queue.leaveFacilityQueue(
    context,
    getAuth(req).user.id,
    await customerOf(req, context),
    entryId,
  );
  res.status(204).end();
});

// ------------------------------------------------------------- unit board

facilityRouter.get("/units", operate, async (req, res) => {
  const query = getFacilityUnitBoardEndpoint.query.parse(req.query);
  res.json({
    data: await units.getFacilityUnitBoard(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  });
});

facilityRouter.patch("/units/:unitId", operate, jsonBody, async (req, res) => {
  const { unitId } = updateFacilityUnitEndpoint.params.parse(req.params);
  const input = updateFacilityUnitEndpoint.body.parse(req.body);
  res.json({
    data: await units.updateFacilityUnit(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      unitId,
      input,
    ),
  });
});

// ----------------------------------------------------------- configuration

facilityRouter.get("/config", manage, async (req, res) => {
  const query = getFacilityConfigEndpoint.query.parse(req.query);
  res.json({
    data: await config.getFacilityConfig(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  });
});

facilityRouter.post("/facilities", manage, jsonBody, async (req, res) => {
  const input = createFacilityEndpoint.body.parse(req.body);
  const facility = await config.createFacility(
    getScopedTenantContext(req),
    getAuth(req).user.id,
    input,
  );
  res
    .status(201)
    .location(`/api/facility/facilities/${facility.id}`)
    .json({ data: facility });
});

facilityRouter.put(
  "/facilities/:facilityId",
  manage,
  jsonBody,
  async (req, res) => {
    const { facilityId } = updateFacilityEndpoint.params.parse(req.params);
    const input = updateFacilityEndpoint.body.parse(req.body);
    res.json({
      data: await config.updateFacility(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        facilityId,
        input,
      ),
    });
  },
);

facilityRouter.post("/areas", manage, jsonBody, async (req, res) => {
  const input = createFacilityAreaEndpoint.body.parse(req.body);
  const area = await config.createFacilityArea(
    getScopedTenantContext(req),
    getAuth(req).user.id,
    input,
  );
  res
    .status(201)
    .location(`/api/facility/areas/${area.id}`)
    .json({ data: area });
});

facilityRouter.patch("/areas/:areaId", manage, jsonBody, async (req, res) => {
  const { areaId } = updateFacilityAreaEndpoint.params.parse(req.params);
  const input = updateFacilityAreaEndpoint.body.parse(req.body);
  res.json({
    data: await config.updateFacilityArea(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      areaId,
      input,
    ),
  });
});

// Fixed sub-path of the unit; the operational PATCH /units/:unitId stays above.
facilityRouter.patch(
  "/units/:unitId/config",
  manage,
  jsonBody,
  async (req, res) => {
    const { unitId } = updateFacilityUnitConfigEndpoint.params.parse(
      req.params,
    );
    const input = updateFacilityUnitConfigEndpoint.body.parse(req.body);
    res.json({
      data: await config.updateFacilityUnitConfig(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        unitId,
        input,
      ),
    });
  },
);

facilityRouter.post("/units", manage, jsonBody, async (req, res) => {
  const input = createFacilityUnitEndpoint.body.parse(req.body);
  const unit = await config.createFacilityUnit(
    getScopedTenantContext(req),
    getAuth(req).user.id,
    input,
  );
  res
    .status(201)
    .location(`/api/facility/units/${unit.id}`)
    .json({ data: unit });
});

// ------------------------------------------------- incident log (staff read)

facilityRouter.get("/incidents", operate, async (req, res) => {
  const query = listFacilityIncidentsEndpoint.query.parse(req.query);
  res.json(
    await incidents.listFacilityIncidents(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  );
});

// ------------------------------------------------------ config: facility list

// The config index read: gated by config.manage because the tenant admin holds
// it without `facility.booth.operate` (bead legend-er32).
facilityRouter.get("/facilities", manage, async (req, res) => {
  const query = listFacilitiesEndpoint.query.parse(req.query);
  res.json(
    await config.listFacilities(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  );
});

// ------------------------------------------------------------ config: products

facilityRouter.post("/products", manage, jsonBody, async (req, res) => {
  const input = createFacilityProductEndpoint.body.parse(req.body);
  const product = await products.createFacilityProduct(
    getScopedTenantContext(req),
    getAuth(req).user.id,
    input,
  );
  res
    .status(201)
    .location(`/api/facility/products/${product.id}`)
    .json({ data: product });
});

facilityRouter.patch(
  "/products/:productId",
  manage,
  jsonBody,
  async (req, res) => {
    const { productId } = updateFacilityProductEndpoint.params.parse(
      req.params,
    );
    const input = updateFacilityProductEndpoint.body.parse(req.body);
    res.json({
      data: await products.updateFacilityProduct(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        productId,
        input,
      ),
    });
  },
);

// -------------------------------------------------------------- config: add-ons

facilityRouter.post("/addons", manage, jsonBody, async (req, res) => {
  const input = createFacilityAddonEndpoint.body.parse(req.body);
  const addon = await products.createFacilityAddon(
    getScopedTenantContext(req),
    getAuth(req).user.id,
    input,
  );
  res
    .status(201)
    .location(`/api/facility/addons/${addon.id}`)
    .json({ data: addon });
});

facilityRouter.patch("/addons/:addonId", manage, jsonBody, async (req, res) => {
  const { addonId } = updateFacilityAddonEndpoint.params.parse(req.params);
  const input = updateFacilityAddonEndpoint.body.parse(req.body);
  res.json({
    data: await products.updateFacilityAddon(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      addonId,
      input,
    ),
  });
});

// ------------------------------------------------- config: entitlement rules

facilityRouter.put(
  "/entitlement-rules/:ruleId",
  manage,
  jsonBody,
  async (req, res) => {
    const { ruleId } = putEntitlementRuleEndpoint.params.parse(req.params);
    const input = putEntitlementRuleEndpoint.body.parse(req.body);
    res.json({
      data: await products.putEntitlementRule(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        ruleId,
        input,
      ),
    });
  },
);

// ------------------------------------------------ config: subscription plans

facilityRouter.post(
  "/subscription-plans",
  manage,
  jsonBody,
  async (req, res) => {
    const input = createSubscriptionPlanEndpoint.body.parse(req.body);
    const plan = await products.createSubscriptionPlan(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    );
    res
      .status(201)
      .location(`/api/facility/subscription-plans/${plan.id}`)
      .json({ data: plan });
  },
);

facilityRouter.patch(
  "/subscription-plans/:planId",
  manage,
  jsonBody,
  async (req, res) => {
    const { planId } = updateSubscriptionPlanEndpoint.params.parse(req.params);
    const input = updateSubscriptionPlanEndpoint.body.parse(req.body);
    res.json({
      data: await products.updateSubscriptionPlan(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        planId,
        input,
      ),
    });
  },
);
