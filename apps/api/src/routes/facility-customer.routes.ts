// Guest-facing facility reads (PRD v1.7 §25; beads legend-zjfi, legend-humf;
// FAC-11). Paths, params and queries come from the WS-09 contract
// (`@starter/shared/facility` customer endpoints). Mount at `/api/facility`
// BEFORE `facilityRouter`, whose router-level `requireAuth` would otherwise
// answer 401 to the public paths.
//
// - `/catalog` and `/entry/:token` are public (no session): tenant from the
//   host (TEN-02), prices and hours only, no staff configuration. The paths are
//   in PUBLIC_RATE_LIMIT_PATHS (middleware/public-rate-limit.ts).
// - Authenticated customer reads (`/entitlements/current`) are not served here
//   yet: the entitlement ledger table belongs to legend-fjk5.
import { Router, type Request } from "express";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  getFacilityCatalog as getFacilityCatalogEndpoint,
  resolveFacilityEntry as resolveFacilityEntryEndpoint,
} from "@starter/shared/facility";
import {
  getTenantContext,
  requireTenantContext,
} from "../middleware/tenant.ts";
import * as customer from "../services/facility-customer.service.ts";

export const facilityCustomerRouter = Router();

const publicContext = (req: Request) =>
  establishScopedTenantContext(getTenantContext(req), { kind: "tenant" });

facilityCustomerRouter.get(
  "/catalog",
  requireTenantContext,
  async (req, res) => {
    const query = getFacilityCatalogEndpoint.query.parse(req.query);
    res.json({
      data: await customer.getFacilityCatalog(publicContext(req), query),
    });
  },
);

facilityCustomerRouter.get(
  "/entry/:token",
  requireTenantContext,
  async (req, res) => {
    const { token } = resolveFacilityEntryEndpoint.params.parse(req.params);
    res.json({
      data: await customer.resolveFacilityEntry(publicContext(req), token),
    });
  },
);
