// Daily-operations HTTP surface (PRD v1.7 §3 F41/F45, §6 L; WS-14; bead
// legend-btha): checklist templates and runs (OPS-01), food-safety temperature
// logs (OPS-02) and prep labels/lists (OPS-03).
//
// Paths, params, bodies and queries come from the WS-14 contract
// (`@starter/shared/operations` `defineEndpoint` objects), so the API and the
// web client cannot drift; each handler only parses, calls the service and
// picks the status. Mounted at `/api/operations`.
//
// The tenant comes from the server-minted context, never the request (TEN-02).
// `requireMenuPermission` proves the caller reaches the permission in tenant or
// outlet scope; each service re-checks it on the concrete outlet record inside
// the tenant transaction (TEN-03), and RLS hides other outlets. Contract
// failures surface with their documented status (`OperationsError` is mapped by
// the single error handler: 422 CHECKLIST_ITEM_INCOMPLETE, 409
// CHECKLIST_TRANSITION_INVALID, 422 TEMPERATURE_CORRECTIVE_ACTION_REQUIRED).
//
// Middleware is applied PER ROUTE, never with `router.use`: the equipment,
// maintenance and handover surface (legend-i57s) is mounted on the same
// `/api/operations` prefix, and an unmatched path must fall through to it.
import { Router, type Request, type RequestHandler } from "express";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  createChecklistRun as createChecklistRunEndpoint,
  createChecklistTemplate as createChecklistTemplateEndpoint,
  createPrepLabel as createPrepLabelEndpoint,
  createPrepList as createPrepListEndpoint,
  createTemperatureLog as createTemperatureLogEndpoint,
  getChecklistRun as getChecklistRunEndpoint,
  getChecklistTemplate as getChecklistTemplateEndpoint,
  getPrepList as getPrepListEndpoint,
  listChecklistRuns as listChecklistRunsEndpoint,
  listChecklistTemplates as listChecklistTemplatesEndpoint,
  listPrepItemSettings as listPrepItemSettingsEndpoint,
  listPrepLabels as listPrepLabelsEndpoint,
  listPrepLists as listPrepListsEndpoint,
  listTemperatureLogs as listTemperatureLogsEndpoint,
  postChecklistRunTransition as postChecklistRunTransitionEndpoint,
  postPrepListTransition as postPrepListTransitionEndpoint,
  printPrepLabel as printPrepLabelEndpoint,
  putPrepItemSetting as putPrepItemSettingEndpoint,
  recordChecklistItemResult as recordChecklistItemResultEndpoint,
  updateChecklistTemplate as updateChecklistTemplateEndpoint,
} from "@starter/shared/operations";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as checklists from "../services/operations-checklist.service.ts";
import * as foodSafety from "../services/operations-food-safety.service.ts";

const CHECKLIST = requireMenuPermission("ops.checklist.complete");
const FOOD_SAFETY = requireMenuPermission("ops.food_safety.log");
const PREP = requireMenuPermission("ops.prep.manage");

/** Auth, CSRF and tenant guards every route repeats (see the header note). */
const guards: RequestHandler[] = [
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
];

const contextOf = (req: Request): ScopedTenantContext =>
  getScopedTenantContext(req);
const actorOf = (req: Request): string => getAuth(req).user.id;

export const operationsRouter = Router();

// ------------------------------------------------------------- checklists

operationsRouter.get(
  "/checklist-templates",
  ...guards,
  CHECKLIST,
  async (req, res) => {
    const query = listChecklistTemplatesEndpoint.query.parse(req.query);
    res.json(await checklists.listChecklistTemplates(contextOf(req), query));
  },
);

operationsRouter.get(
  "/checklist-templates/:templateId",
  ...guards,
  CHECKLIST,
  async (req, res) => {
    const { templateId } = getChecklistTemplateEndpoint.params.parse(
      req.params,
    );
    res.json({
      data: await checklists.getChecklistTemplate(contextOf(req), templateId),
    });
  },
);

operationsRouter.post(
  "/checklist-templates",
  ...guards,
  CHECKLIST,
  jsonBody,
  async (req, res) => {
    const input = createChecklistTemplateEndpoint.body.parse(req.body);
    const template = await checklists.createChecklistTemplate(
      contextOf(req),
      actorOf(req),
      input,
    );
    res.status(201).json({ data: template });
  },
);

operationsRouter.patch(
  "/checklist-templates/:templateId",
  ...guards,
  CHECKLIST,
  jsonBody,
  async (req, res) => {
    const { templateId } = updateChecklistTemplateEndpoint.params.parse(
      req.params,
    );
    const input = updateChecklistTemplateEndpoint.body.parse(req.body);
    res.json({
      data: await checklists.updateChecklistTemplate(
        contextOf(req),
        actorOf(req),
        templateId,
        input,
      ),
    });
  },
);

operationsRouter.get(
  "/checklist-runs",
  ...guards,
  CHECKLIST,
  async (req, res) => {
    const query = listChecklistRunsEndpoint.query.parse(req.query);
    res.json(await checklists.listChecklistRuns(contextOf(req), query));
  },
);

operationsRouter.get(
  "/checklist-runs/:runId",
  ...guards,
  CHECKLIST,
  async (req, res) => {
    const { runId } = getChecklistRunEndpoint.params.parse(req.params);
    res.json({
      data: await checklists.getChecklistRun(contextOf(req), runId),
    });
  },
);

operationsRouter.post(
  "/checklist-runs",
  ...guards,
  CHECKLIST,
  jsonBody,
  async (req, res) => {
    const input = createChecklistRunEndpoint.body.parse(req.body);
    const run = await checklists.createChecklistRun(
      contextOf(req),
      actorOf(req),
      input,
    );
    res.status(201).json({ data: run });
  },
);

operationsRouter.post(
  "/checklist-runs/:runId/items/:itemId/result",
  ...guards,
  CHECKLIST,
  jsonBody,
  async (req, res) => {
    const { runId, itemId } = recordChecklistItemResultEndpoint.params.parse(
      req.params,
    );
    const input = recordChecklistItemResultEndpoint.body.parse(req.body);
    res.json({
      data: await checklists.recordChecklistItemResult(
        contextOf(req),
        actorOf(req),
        runId,
        itemId,
        input,
      ),
    });
  },
);

operationsRouter.post(
  "/checklist-runs/:runId/transition",
  ...guards,
  CHECKLIST,
  jsonBody,
  async (req, res) => {
    const { runId } = postChecklistRunTransitionEndpoint.params.parse(
      req.params,
    );
    const input = postChecklistRunTransitionEndpoint.body.parse(req.body);
    res.json({
      data: await checklists.transitionChecklistRun(
        contextOf(req),
        actorOf(req),
        runId,
        input,
      ),
    });
  },
);

// ----------------------------------------------------------- food safety

operationsRouter.get(
  "/temperature-logs",
  ...guards,
  FOOD_SAFETY,
  async (req, res) => {
    const query = listTemperatureLogsEndpoint.query.parse(req.query);
    res.json(await foodSafety.listTemperatureLogs(contextOf(req), query));
  },
);

operationsRouter.post(
  "/temperature-logs",
  ...guards,
  FOOD_SAFETY,
  jsonBody,
  async (req, res) => {
    const input = createTemperatureLogEndpoint.body.parse(req.body);
    const log = await foodSafety.createTemperatureLog(
      contextOf(req),
      actorOf(req),
      input,
    );
    res.status(201).json({ data: log });
  },
);

// ------------------------------------------------------------------ prep

operationsRouter.get(
  "/prep-item-settings",
  ...guards,
  PREP,
  async (req, res) => {
    const query = listPrepItemSettingsEndpoint.query.parse(req.query);
    res.json(await foodSafety.listPrepItemSettings(contextOf(req), query));
  },
);

operationsRouter.put(
  "/prep-item-settings/:inventoryItemId",
  ...guards,
  PREP,
  jsonBody,
  async (req, res) => {
    const { inventoryItemId } = putPrepItemSettingEndpoint.params.parse(
      req.params,
    );
    const input = putPrepItemSettingEndpoint.body.parse(req.body);
    res.json({
      data: await foodSafety.upsertPrepItemSetting(
        contextOf(req),
        actorOf(req),
        inventoryItemId,
        input,
      ),
    });
  },
);

operationsRouter.get("/prep-labels", ...guards, PREP, async (req, res) => {
  const query = listPrepLabelsEndpoint.query.parse(req.query);
  res.json(await foodSafety.listPrepLabels(contextOf(req), query));
});

operationsRouter.post(
  "/prep-labels",
  ...guards,
  PREP,
  jsonBody,
  async (req, res) => {
    const input = createPrepLabelEndpoint.body.parse(req.body);
    const label = await foodSafety.createPrepLabel(
      contextOf(req),
      actorOf(req),
      input,
    );
    res.status(201).json({ data: label });
  },
);

operationsRouter.post(
  "/prep-labels/:labelId/print",
  ...guards,
  PREP,
  jsonBody,
  async (req, res) => {
    const { labelId } = printPrepLabelEndpoint.params.parse(req.params);
    const input = printPrepLabelEndpoint.body.parse(req.body);
    res.json({
      data: await foodSafety.printPrepLabel(
        contextOf(req),
        actorOf(req),
        labelId,
        input,
      ),
    });
  },
);

operationsRouter.get("/prep-lists", ...guards, PREP, async (req, res) => {
  const query = listPrepListsEndpoint.query.parse(req.query);
  res.json(await foodSafety.listPrepLists(contextOf(req), query));
});

operationsRouter.get(
  "/prep-lists/:prepListId",
  ...guards,
  PREP,
  async (req, res) => {
    const { prepListId } = getPrepListEndpoint.params.parse(req.params);
    res.json({
      data: await foodSafety.getPrepList(contextOf(req), prepListId),
    });
  },
);

operationsRouter.post(
  "/prep-lists",
  ...guards,
  PREP,
  jsonBody,
  async (req, res) => {
    const input = createPrepListEndpoint.body.parse(req.body);
    const prepList = await foodSafety.createPrepList(
      contextOf(req),
      actorOf(req),
      input,
    );
    res.status(201).json({ data: prepList });
  },
);

operationsRouter.post(
  "/prep-lists/:prepListId/transition",
  ...guards,
  PREP,
  jsonBody,
  async (req, res) => {
    const { prepListId } = postPrepListTransitionEndpoint.params.parse(
      req.params,
    );
    const input = postPrepListTransitionEndpoint.body.parse(req.body);
    res.json({
      data: await foodSafety.transitionPrepList(
        contextOf(req),
        actorOf(req),
        prepListId,
        input,
      ),
    });
  },
);
