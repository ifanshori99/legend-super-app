// Facility incident raise/respond (PRD v1.7 §25, FAC-08; bead legend-1cj0). The
// subscription plan list is public and lives in facility-customer.routes.ts.
// Paths, params, bodies and queries come from the WS-09 contract
// (`@starter/shared/facility` defineEndpoint objects).
// Mounted under `facilityRouter` (`facilityRouter.use(...)` after its
// requireAuth / requireTrustedOrigin / requireTenantContext), so the paths
// here are relative to /api/facility.
//
// Gate: `facility.booth.operate` through requireMenuPermission (reach to the
// permission); the services re-check it on the record's own outlet (TEN-03).
// Raising a new incident may carry an optional `Idempotency-Key` header (the
// contract body has no key field); respond is idempotent by itself.
import { Router } from "express";
import { idempotencyKeySchema } from "@starter/shared/core";
import {
  raiseFacilityIncident as raiseFacilityIncidentEndpoint,
  respondFacilityIncident as respondFacilityIncidentEndpoint,
} from "@starter/shared/facility";
import { getAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions.ts";
import { HttpError } from "../lib/http-error.ts";
import * as incidents from "../services/facility-incidents.service.ts";

const operate = requireMenuPermission("facility.booth.operate");

export const facilityIncidentsRouter = Router();

facilityIncidentsRouter.post(
  "/incidents",
  operate,
  jsonBody,
  async (req, res) => {
    const input = raiseFacilityIncidentEndpoint.body.parse(req.body);
    const header = req.header("idempotency-key");
    const key =
      header === undefined ? null : idempotencyKeySchema.safeParse(header);
    if (key && !key.success)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Idempotency-Key harus 8-100 karakter.",
      );
    const { incident, replayed } = await incidents.raiseFacilityIncident(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
      key?.success ? key.data : null,
    );
    if (replayed) {
      res.status(200).json({ data: incident });
      return;
    }
    res
      .status(201)
      .location(`/api/facility/incidents/${incident.id}`)
      .json({ data: incident });
  },
);

facilityIncidentsRouter.post(
  "/incidents/:incidentId/respond",
  operate,
  jsonBody,
  async (req, res) => {
    const { incidentId } = respondFacilityIncidentEndpoint.params.parse(
      req.params,
    );
    const input = respondFacilityIncidentEndpoint.body.parse(req.body);
    res.json({
      data: await incidents.respondFacilityIncident(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        incidentId,
        input,
      ),
    });
  },
);
