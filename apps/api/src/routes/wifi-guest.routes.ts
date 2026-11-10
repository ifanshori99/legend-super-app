// Guest Wi-Fi routes of a signed-in member (PRD v1.7 §3 F25; FAC-12, FAC-13;
// bead legend-kmd3). Mount at `/api/wifi` BEFORE `wifiConfigRouter`: the two
// share the prefix, and this router only answers its own paths, so the staff
// `PUT /api/wifi/policies/:policyId` falls through to the config router.
//
// Chain per route: tenant from the host (TEN-02) -> requireAuth ->
// requireTrustedOrigin -> requireMember (the profile comes from the session,
// never from the request) -> jsonBody on POST with a body. Bodies, params and
// queries are parsed strictly with the contract schemas; the refresh body is
// an empty strict object, so a client-supplied spend is refused (legend-8vd3).
import { Router } from "express";
import {
  endWifiSession as endWifiSessionEndpoint,
  getWifiPolicyForZone as getWifiPolicyForZoneEndpoint,
  refreshWifiQuota as refreshWifiQuotaEndpoint,
  startWifiSession as startWifiSessionEndpoint,
} from "@starter/shared/facility";
import { requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { getMemberScope, requireMember } from "../middleware/member.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as sessions from "../services/wifi-session.service.ts";

export const wifiGuestRouter = Router();

const base = [
  requireTenantContext,
  requireAuth,
  requireTrustedOrigin,
  requireMember(),
];

/** The quota meter's policy of a zone. */
wifiGuestRouter.get("/policy", ...base, async (req, res) => {
  const query = getWifiPolicyForZoneEndpoint.query.parse(req.query);
  res.json({
    data: await sessions.getWifiPolicyForZone(
      getMemberScope(req),
      query.zoneId,
    ),
  });
});

wifiGuestRouter.post("/sessions", ...base, jsonBody, async (req, res) => {
  const input = startWifiSessionEndpoint.body.parse(req.body);
  res.json({
    data: await sessions.startWifiSession(getMemberScope(req), input),
  });
});

wifiGuestRouter.get("/sessions/current", ...base, async (req, res) => {
  res.json({ data: await sessions.getCurrentWifiSession(getMemberScope(req)) });
});

wifiGuestRouter.post(
  "/sessions/current/refresh",
  ...base,
  jsonBody,
  async (req, res) => {
    refreshWifiQuotaEndpoint.body.parse(req.body);
    res.json({ data: await sessions.refreshWifiQuota(getMemberScope(req)) });
  },
);

wifiGuestRouter.post("/sessions/:sessionId/end", ...base, async (req, res) => {
  const { sessionId } = endWifiSessionEndpoint.params.parse(req.params);
  res.json({
    data: await sessions.endWifiSession(getMemberScope(req), sessionId),
  });
});
