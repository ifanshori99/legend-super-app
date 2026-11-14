// AI insights routes (WS-12 wave 3, part R; beads legend-hkd4, legend-lely).
// Paths and bodies come from the contract (`@starter/shared/ai` insights.ts);
// the router is mounted at `/api/ai`, so each path drops that prefix. Gates sit
// on each route (never router-wide): this router shares the mount point with
// the chat, governance, action-request and MCP routers. Permission and outlet
// reach are decided by the services (403 on a denied outlet); the routes only
// parse and delegate.
import { Router, type RequestHandler } from "express";
import {
  acknowledgeAiAnomalyAlert as acknowledgeAnomalyEndpoint,
  draftAiPromoCopy as draftPromoCopyEndpoint,
  getAiRosterInputs as rosterInputsEndpoint,
  listAiAnomalyAlerts as listAnomaliesEndpoint,
  listAiDailySummaries as listDailySummariesEndpoint,
  listAiForecasts as listForecastsEndpoint,
  listAiPurchaseSuggestions as listPurchaseSuggestionsEndpoint,
  suggestAiExpenseAccount as suggestExpenseAccountEndpoint,
} from "@starter/shared/ai";
import { requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import {
  getAccessSnapshot,
  loadRequestAccess,
} from "../middleware/permissions.ts";
import { requireAiPlatformEnabled } from "../middleware/module.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  acknowledgeAnomalyAlert,
  listAnomalyAlerts,
} from "../services/ai-anomaly.service.ts";
import { listDailySummaries } from "../services/ai-daily-summary.service.ts";
import {
  draftPromoCopy,
  suggestExpenseAccount,
} from "../services/ai-drafts.service.ts";
import { listForecasts } from "../services/ai-forecast.service.ts";
import { listPurchaseSuggestions } from "../services/ai-purchase-suggestion.service.ts";
import { getRosterInputs } from "../services/ai-roster-inputs.service.ts";

// The services read the snapshot, so load it up front; the services (not a
// route gate) decide permission and outlet reach.
const loadAccess: RequestHandler = async (req, res, next) => {
  await loadRequestAccess(req);
  res.setHeader("Cache-Control", "private, no-store");
  next();
};

export function createAiInsightsRouter(): Router {
  const router = Router();
  const common = [
    requireAuth,
    requireTrustedOrigin,
    requireTenantContext,
    loadAccess,
  ];

  router.get("/forecasts", ...common, async (req, res) => {
    const query = listForecastsEndpoint.query.parse(req.query);
    res.json({ data: await listForecasts(getAccessSnapshot(req), query) });
  });

  router.get("/purchase-suggestions", ...common, async (req, res) => {
    const query = listPurchaseSuggestionsEndpoint.query.parse(req.query);
    res.json({
      data: await listPurchaseSuggestions(getAccessSnapshot(req), query),
    });
  });

  router.get("/roster-inputs", ...common, async (req, res) => {
    const query = rosterInputsEndpoint.query.parse(req.query);
    res.json({ data: await getRosterInputs(getAccessSnapshot(req), query) });
  });

  router.get("/anomalies", ...common, async (req, res) => {
    const query = listAnomaliesEndpoint.query.parse(req.query);
    res.json({ data: await listAnomalyAlerts(getAccessSnapshot(req), query) });
  });

  router.post(
    "/anomalies/:id/acknowledge",
    ...common,
    jsonBody,
    async (req, res) => {
      const params = acknowledgeAnomalyEndpoint.params.parse(req.params);
      res.json({
        data: await acknowledgeAnomalyAlert(getAccessSnapshot(req), params.id),
      });
    },
  );

  router.get("/daily-summaries", ...common, async (req, res) => {
    const query = listDailySummariesEndpoint.query.parse(req.query);
    res.json({
      data: await listDailySummaries(getAccessSnapshot(req), query),
    });
  });

  router.post(
    "/drafts/promo-copy",
    ...common,
    requireAiPlatformEnabled(),
    jsonBody,
    async (req, res) => {
      const body = draftPromoCopyEndpoint.body.parse(req.body);
      res.json({ data: await draftPromoCopy(getAccessSnapshot(req), body) });
    },
  );

  router.post(
    "/drafts/expense-account",
    ...common,
    requireAiPlatformEnabled(),
    jsonBody,
    async (req, res) => {
      const body = suggestExpenseAccountEndpoint.body.parse(req.body);
      res.json({
        data: await suggestExpenseAccount(getAccessSnapshot(req), body),
      });
    },
  );

  return router;
}

export const aiInsightsRouter = createAiInsightsRouter();
