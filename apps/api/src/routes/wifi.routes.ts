// Wi-Fi policy configuration route (PRD v1.7 §3 F22/F25 "Wi-Fi Berbasis
// Belanja", "Jam Ramai & Jam Sepi", §3 F39; FAC-14; bead legend-8dpm). Mount
// at `/api/wifi` next to the guest portal routes, so the contract path
// `PUT /api/wifi/policies/:policyId` resolves; unlike the guest portal it
// writes configuration and is gated by `facility.config.manage`.
//
// The tenant comes from the server-minted context (TEN-02); the service
// resolves the zone's outlet and re-checks the permission there (TEN-03).
import { Router } from "express";
import { putWifiPolicy as putWifiPolicyEndpoint } from "@starter/shared/facility";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as policies from "../services/wifi-policy.service.ts";

export const wifiConfigRouter = Router();
wifiConfigRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

const manage = requireMenuPermission("facility.config.manage");

/** Replaces the Wi-Fi policy of a zone; applies on the next request (FAC-14). */
wifiConfigRouter.put(
  "/policies/:policyId",
  manage,
  jsonBody,
  async (req, res) => {
    const { policyId } = putWifiPolicyEndpoint.params.parse(req.params);
    const input = putWifiPolicyEndpoint.body.parse(req.body);
    res.json({
      data: await policies.putWifiPolicy(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        policyId,
        input,
      ),
    });
  },
);
